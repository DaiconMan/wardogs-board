// 同じ作戦を開いている人の一覧（在室）。
//
// **これは上乗せ。前提にしない。** WebSocket が繋がらなくても、盤面の読み書きは
// 全部 HTTP で動き続ける（調査 §5.3）。したがってこのモジュールは
//   * 例外を外に出さない（app.js は await しない）
//   * 失敗したらヘッダの小さな文字が変わるだけで、他は何も止めない
// という形にしてある。
//
// **課金事故を避けるための決まり（調査 §2.4 / D-047）:**
//   * 開いたら1回 {"t":"who"} を送る。サーバから来るのを待たない
//     （ローカル開発では DO → クライアントの初回送信がトンネルに溜まり、
//      こちらが何か送るまで流れてこないのを実測した。本番でも同じ形に揃える）
//   * ハートビートは "p" の1文字。サーバは setWebSocketAutoResponse で返すので
//     Durable Object は起きない
//   * 再接続は jitter 付きバックオフ＋上限10回。無限リトライにしない
//     （枠を使い切った日に一晩リクエストを投げ続けないため）
//   * 無操作が10分続いたら自分から切る。操作が来たら開き直す
//     （タブの放置で実行時間枠を食わないため）

import { fillAvatar, memberAvatarUrl } from "./avatar.js";
import { GUEST_QUERY } from "./guest.js";

// 再接続の待ち時間（ms）。段ごとに ±30% の jitter を乗せる。
// 20人が同時に落ちたときに同じ瞬間へ揃わないようにするのが目的（調査 §5.5）。
const BACKOFF_STEPS = [500, 1000, 2000, 4000, 8000, 16_000, 30_000];
export const MAX_RETRIES = 10;
export const IDLE_MS = 10 * 60 * 1000;

/**
 * 1つの作戦に同時に入れる人数。**workers/room/src/presence.js の
 * `MAX_MEMBERS` と同じ値でなければならない。**
 *
 * 断るのはサーバ（DO）で、ここは**断られた理由を画面に書くため**に持っている。
 * DO は別の Worker にあってブラウザへは配信されないので import できない。
 * 一致は `tests/plan-cursor-budget.test.js` が見張る。
 */
export const MAX_MEMBERS = 50;

/**
 * 満員で断られたときの文言。
 *
 * **数を文の中に直接書かない。** 書くと上限を変えたときに片方だけ残り、
 * 「満員です（20人まで）」と出ているのに19人しか居ない状態になる。
 */
export const FULL_NOTE = `満員です（${MAX_MEMBERS}人まで）`;

/**
 * 在室一覧で、ゲスト（ログイン無しで見ている人）の名前に添える印。
 *
 * **短い語1つ。** 粒は幅が限られていて、長い語を入れると名前のほうが潰れる
 * （D-070 で実測した「幅が変わる名前と幅が固定の札を競わせない」）。
 * 理由は `title` のほうに書く。
 */
export const GUEST_MEMBER_MARK = "見るだけ";
export const GUEST_MEMBER_NOTE = "ログインしていないので、この人は書き込めません";

const PING_MS = 25_000;
const IDLE_CHECK_MS = 30_000;

/** `attempt`（1始まり）番目の待ち時間。`rnd` は 0〜1（テストから注入する）。 */
export function backoffDelay(attempt, rnd = Math.random()) {
  const base = BACKOFF_STEPS[Math.min(attempt, BACKOFF_STEPS.length) - 1];
  return Math.round(base * (0.7 + 0.6 * rnd));
}

/**
 * 表示の並び。名前 → ID の順で安定に並べる。
 *
 * サーバは `state.getWebSockets()` の順で送ってくるが、**その順に意味は無い**
 * （ローカルで「2人目が先」を実測）。並べ替えずに出すと、誰かが入るたびに
 * 既にいる人の行が入れ替わって読めなくなる。
 */
export function sortMembers(members) {
  return [...(Array.isArray(members) ? members : [])].sort(
    (a, b) => String(a.name).localeCompare(String(b.name), "ja") || String(a.id).localeCompare(String(b.id))
  );
}

/**
 * 在室一覧の中から**自分の色**を引いて、CSS の変数名（`cursor-1`〜`8`）にする。
 *
 * **ペンの色とカーソルの色を揃えるためにある**（D-047 の未決事項、D-048 の残件）。
 * 盤面を開いた直後は app.js が Discord ID のハッシュだけで仮に決めるが、
 * サーバは**部屋の中で色がぶつからないようにずらす**ことがある
 * （presence.js の `pickColor`）。ずれたままだと、
 *   他人の画面: その人のカーソルは緑
 *   自分の画面: 自分が引く線は青
 * となり、**インクには名前が無いので「どの線が誰のか」が分からなくなる。**
 *
 * 見つからなければ null（＝仮の色のまま。無理に変えない）。
 */
export function myColorName(members, meId) {
  const me = (Array.isArray(members) ? members : [])
    .find((m) => m && String(m.id) === String(meId));
  if (!me || !Number.isInteger(me.color)) return null;
  return `cursor-${((me.color % 8) + 8) % 8 + 1}`;
}

/**
 * 在室一覧に必ず添える一文。
 *
 * **見られていることを、見る前に知れる状態にする**（調査 §5.7 の「対称性」）。
 * 一覧に自分の名前が出ているだけでは「自分の名前が相手の画面にも出ている」とは
 * 読み取れないので、明示する。
 *
 * 後半の「記録は残りません」は D-034 との線引き。あちらは訪問履歴に
 * 「この記録はあなたにだけ見えます」と書いている。**役割がちょうど逆**で、
 *   訪問履歴 … 記録として残る。読めるのは本人だけ
 *   在室     … 相手にも見える。記録としては残らない（DO のメモリだけ）
 * 2文が食い違って見えないよう、どちらも「残るか」と「誰に見えるか」の
 * 2点を1文で言う形に揃えてある。**片方を書き換えるときは両方読むこと。**
 *
 * **「アイコン」は、出るものを全部挙げるために足した。** Discord のアイコンを
 * 名前の横に出すようにしたので、「名前も見えます」だけだと実態より狭い。
 * D-048 で決めたのは「見られていることを、**見る前に**知れる状態にする」で、
 * 出すものを増やしたらこの文も一緒に増やす——**食い違わせないこと。**
 */
export const PRIVACY_NOTE = "あなたの名前とアイコンも相手に見えます（記録は残りません）";

/**
 * 名前の見え方の注記を**もう読んだか**。
 *
 * 初めての人には必ず出した状態で見せ、2回目からは `i` の裏に畳む。
 * 覚えられない（プライベートモード等）ときは「まだ読んでいない」扱いにする
 * ——同意に関わる文なので、迷ったら**出すほう**に倒す。
 */
const PRIVACY_KEY = "wardogs.plan.privacy";
export function privacySeen(store = globalThis.localStorage) {
  try { return store?.getItem(PRIVACY_KEY) === "1"; } catch { return false; }
}
export function markPrivacySeen(store = globalThis.localStorage) {
  try { store?.setItem(PRIVACY_KEY, "1"); } catch { /* 覚えないだけ */ }
}

/** 無操作で切るべきか。時計と可視状態を引数で受けてテストできるようにしてある。 */
export function shouldIdleDisconnect(lastActivityMs, nowMs, idleMs = IDLE_MS) {
  return nowMs - lastActivityMs >= idleMs;
}

/**
 * `/api/sessions/:id/ws` の絶対URL。http→ws / https→wss。
 *
 * `guestId` はログイン無しで見る人の身元（`anon:…`）。**ここだけクエリで渡す。**
 * ブラウザの `new WebSocket()` はヘッダを足せないので、HTTP のように
 * `x-wb-guest` を付けられない（`guest.js` の `GUEST_QUERY`）。
 * ログイン済みなら渡さない（Cookie が本体で、クエリは無視される）。
 */
export function wsUrl(sessionId, { guestId = null, location = globalThis.location } = {}) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${scheme}//${location.host}/api/sessions/${encodeURIComponent(sessionId)}/ws`;
  if (!guestId) return base;
  return `${base}?${GUEST_QUERY}=${encodeURIComponent(guestId)}`;
}

/**
 * 在室一覧を作る。戻り値の `stop()` はページを離れるときに呼ぶ。
 *
 * el … 描画先（ヘッダの #presence）
 * meId … 自分の Discord ID。サーバは「あなたは誰か」を送ってこない
 *        （受信者ごとに別の文字列を作らないため。調査 §5.8）
 * onCursors … 全員ぶんのカーソル `{ 接続の鍵: [x, y, 所有者の Discord ID] }` が来たとき
 *             （自分のタブのぶんを外す鍵は `state.myKey`。描くのは board/cursor.js）
 * onChanged … 誰かが保存したとき（中身は来ない。受け取った側が GET し直す）
 * onMembers … 在室が届いたとき（自分の色を引くのに使う。`myColorName`）
 * guestId … ログイン無しで見ているときの自分の身元（`anon:…`）。
 *           ログイン済みなら渡さない（`wsUrl` のコメント）
 *
 * **このモジュールは運び屋のまま。** カーソルを描くのは board/cursor.js、
 * 取り直すのは board/reload.js で、ここは通を出し入れするだけにしてある。
 */
export function createPresence({
  sessionId, meId, el, onNote, onCursors, onChanged, onMembers, guestId = null,
}) {
  const state = {
    ws: null,
    attempt: 0,
    members: [],
    // **自分の接続の鍵**（サーバが接続1回につき1通だけ渡す `{"t":"you"}`）。
    // カーソルの表から自分のタブのぶんを外すのに要る（cursors.js の `othersOnly`）。
    // 繋ぎ直すと別の鍵になるので、切れたら必ず null に戻す。
    myKey: null,
    note: "",
    stopped: false,
    lastActivity: Date.now(),
    timers: { retry: null, ping: null, idle: null },
    idleClosed: false,
    // 名前の見え方の注記を出しているか。null は「まだ決めていない」。
    privacyOpen: null,
  };

  const setNote = (note) => {
    state.note = note;
    if (onNote) onNote(note);
    render();
  };

  function render() {
    if (!el) return;
    el.textContent = "";
    const row = document.createElement("span");
    row.className = "pres-row";
    el.appendChild(row);

    for (const m of sortMembers(state.members)) {
      const chip = document.createElement("span");
      chip.className = "pres-chip";
      if (String(m.id) === String(meId)) chip.dataset.me = "1";
      const dot = document.createElement("span");
      dot.className = "pres-dot";
      // 色は 0〜7 で来る。plan.html の --cursor-1〜8 に合わせて +1 する。
      const n = Number.isInteger(m.color) ? ((m.color % 8) + 8) % 8 : 0;
      dot.style.background = `var(--cursor-${n + 1})`;
      // **Discord のアイコンは色の丸の「中身」。丸を置き換えない。**
      // 色は「ペン＝カーソル＝在室の粒＝引いた線」を結ぶ識別子（D-047 / D-068）で、
      // アイコンに差し替えるとその結びつきが切れる。
      //
      // 出せないときは何もしない ＝ 今までどおりの色の丸。出せないのは
      // ゲスト（`anon:` の人）、Discord の既定アイコンの人、そして
      // **画像の読み込みに失敗したとき**（`fillAvatar` が `<img>` ごと消す）。
      fillAvatar(dot, memberAvatarUrl(m));
      chip.appendChild(dot);
      const name = document.createElement("span");
      name.className = "pres-name";
      name.textContent = m.name || "名前なし";
      // 粒は幅が限られるので、長い名前は CSS が省略記号で切る。
      // **中身は全文のまま**にして（読み上げと検索のため）、
      // マウスの人には title で全文を返す。
      name.title = m.name || "名前なし";
      chip.appendChild(name);
      // **ゲスト（ログイン無しで見ている人）だと分かる印。**
      // 無いと「返事をしない人」に見えて、VC で呼びかけ続けることになる。
      // 書けない人だと分かれば、その人に作業を頼まずに済む。
      if (m.guest) {
        chip.dataset.guest = "1";
        const mark = document.createElement("span");
        mark.className = "pres-guest";
        mark.textContent = GUEST_MEMBER_MARK;
        mark.title = GUEST_MEMBER_NOTE;
        chip.appendChild(mark);
      }
      if (String(m.id) === String(meId)) {
        const self = document.createElement("span");
        self.className = "pres-self";
        self.textContent = "（あなた）";
        chip.appendChild(self);
      }
      row.appendChild(chip);
    }
    if (state.note) {
      const note = document.createElement("span");
      note.className = "pres-note";
      note.textContent = state.note;
      row.appendChild(note);
    }

    // **「自分の名前も相手に見える」ことの注記。**
    // **誰かに見えている状態のときだけ添える。** 切断中や離席中は誰にも見えて
    // いないので、出すと嘘になる（D-048）。
    //
    // そのうえで**常駐はさせない**（同業はどこも画面に散文を置いていない。
    // 調査 2026-10-01 §3-3）。ただし同意に関わる文なので**消しもしない**。
    //   * 初めて開いた人には、開いた時点で出した状態で見せる
    //   * 一度読んだら畳み、以後は `i` ボタンの裏に置く（押せばいつでも読める）
    // どちらの状態かは localStorage（wardogs.plan.privacy）が覚える。
    if (state.members.length > 0) {
      // 出すか畳むかは**このページを開いた時点で1回だけ**決める。
      // render() は在室が変わるたびに走るので、ここで毎回 localStorage を
      // 読み直すと、初回の人でも2回目の描画で畳まれてしまう。
      if (state.privacyOpen === null) {
        state.privacyOpen = !privacySeen();
        // 出した状態で見せたのなら、それが「読んだ」こと。次からは畳む。
        if (state.privacyOpen) markPrivacySeen();
      }
      const open = state.privacyOpen;
      const info = document.createElement("button");
      info.type = "button";
      info.className = "pres-info quiet";
      info.textContent = "i";
      info.setAttribute("aria-expanded", String(open));
      info.setAttribute("aria-controls", "pres-priv");
      info.setAttribute("aria-label", "名前の見え方について");
      info.title = PRIVACY_NOTE;
      row.appendChild(info);

      const priv = document.createElement("span");
      priv.className = "pres-priv";
      priv.id = "pres-priv";
      priv.textContent = PRIVACY_NOTE;
      priv.hidden = !open;
      el.appendChild(priv);

      info.addEventListener("click", () => {
        state.privacyOpen = !state.privacyOpen;
        priv.hidden = !state.privacyOpen;
        info.setAttribute("aria-expanded", String(state.privacyOpen));
      });
    }
    el.hidden = state.members.length === 0 && !state.note;
  }

  function clearTimer(key) {
    if (state.timers[key] === null) return;
    clearTimeout(state.timers[key]);
    clearInterval(state.timers[key]);
    state.timers[key] = null;
  }

  function dropSocket() {
    clearTimer("ping");
    // 鍵は接続ごと。繋ぎ直せば別の鍵になるので、持ち越さない
    // （持ち越すと、繋ぎ直したあと自分のカーソルが自分の画面に出る）。
    state.myKey = null;
    if (!state.ws) return;
    const ws = state.ws;
    state.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* 既に閉じている */
    }
  }

  function scheduleRetry() {
    if (state.stopped || state.idleClosed) return;
    state.attempt += 1;
    if (state.attempt > MAX_RETRIES) {
      state.members = [];
      setNote("オフライン（再読み込みで繋ぎ直します）");
      return;
    }
    const wait = backoffDelay(state.attempt);
    state.members = [];
    setNote("接続が切れました。繋ぎ直しています");
    clearTimer("retry");
    state.timers.retry = setTimeout(open, wait);
  }

  function open() {
    if (state.stopped) return;
    clearTimer("retry");
    dropSocket();
    let ws;
    try {
      ws = new WebSocket(wsUrl(sessionId, { guestId }));
    } catch {
      // WebSocket そのものが使えない環境（塞がれている / 古い）。黙って諦める。
      state.members = [];
      setNote("");
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      state.attempt = 0;
      state.idleClosed = false;
      setNote("");
      // 自分の状態は自分で取りに行く（上のコメント参照）。
      try {
        ws.send(JSON.stringify({ t: "who" }));
      } catch {
        /* 直後に閉じた */
      }
      clearTimer("ping");
      state.timers.ping = setInterval(() => {
        try {
          ws.send("p");
        } catch {
          /* 閉じている */
        }
      }, PING_MS);
    };

    ws.onmessage = (evt) => {
      if (typeof evt.data !== "string") return;
      if (evt.data === "o") return; // ハートビートの自動応答
      let msg = null;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      // **自分の接続の鍵。** `{"t":"who"}` を送った返事に1通だけ付いてくる。
      // 在室より先に来ることも後に来ることもあるので、順序に依存しない。
      if (msg?.t === "you" && typeof msg.k === "string") {
        state.myKey = msg.k;
        return;
      }
      if (msg?.t === "who" && Array.isArray(msg.members)) {
        state.members = msg.members;
        try {
          onMembers?.(msg.members);
        } catch {
          /* 受け手の都合。在室の表示は続ける */
        }
        setNote("");
        return;
      }
      // カーソルは**在室より頻繁に来る**（最大 10Hz）ので、描画以外のことを
      // ここでしない（setNote を呼ぶと在室一覧を 10Hz で組み直すことになる）。
      //
      // **受け手が投げてもここで止める。** このモジュールは運び屋で、
      // 盤面の描画や取り直しの失敗を自分の問題にしない（上乗せは上乗せのまま）。
      try {
        if (msg?.t === "curs" && msg.c && typeof msg.c === "object") {
          onCursors?.(msg.c);
          return;
        }
        if (msg?.t === "chg") onChanged?.();
      } catch {
        /* 1通ぶん落ちただけ。次の通で追いつく */
      }
    };

    ws.onerror = () => {
      // onclose が続けて来るので、ここでは何もしない（二重に再接続を仕込まない）。
    };

    ws.onclose = (evt) => {
      if (state.ws !== ws) return; // 自分で差し替えた後の後片付け
      state.ws = null;
      state.myKey = null;
      clearTimer("ping");
      if (state.stopped) return;
      if (state.idleClosed) {
        state.members = [];
        setNote("離席中（操作すると繋ぎ直します）");
        return;
      }
      // 1013 = Try Again Later。満員なので繋ぎ直しても同じ。
      if (evt?.code === 1013) {
        state.members = [];
        setNote(FULL_NOTE);
        return;
      }
      // 1008 = Policy Violation。サーバが「送りすぎ」で切った（毎秒30通超え）。
      // **繋ぎ直さない。** 送りすぎているのはこちらなので、開き直せば同じことを
      // 繰り返して枠を溶かす（レート制限を入れた意味が無くなる）。
      // 正常なクライアントは 10Hz なのでここには来ない。来たならこちらの不具合で、
      // 黙って繋ぎ直すよりユーザーに見えるほうがよい。
      if (evt?.code === 1008) {
        state.members = [];
        setNote("通信が多すぎたため切断されました（再読み込みで繋ぎ直します）");
        return;
      }
      scheduleRetry();
    };
  }

  function noteActivity() {
    state.lastActivity = Date.now();
    if (!state.idleClosed) return;
    state.idleClosed = false;
    state.attempt = 0;
    open();
  }

  const activityEvents = ["pointerdown", "pointermove", "keydown", "wheel", "focus"];
  const onActivity = () => noteActivity();
  const onVisibility = () => {
    if (!document.hidden) noteActivity();
  };

  function start() {
    for (const type of activityEvents) {
      addEventListener(type, onActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
    state.timers.idle = setInterval(() => {
      if (state.stopped || state.idleClosed) return;
      if (!shouldIdleDisconnect(state.lastActivity, Date.now())) return;
      // 無操作で自分から切る。これが「タブ放置で枠を食う」唯一の防ぎ方。
      state.idleClosed = true;
      dropSocket();
      state.members = [];
      setNote("離席中（操作すると繋ぎ直します）");
    }, IDLE_CHECK_MS);
    open();
  }

  function stop() {
    state.stopped = true;
    for (const type of activityEvents) removeEventListener(type, onActivity);
    document.removeEventListener("visibilitychange", onVisibility);
    clearTimer("retry");
    clearTimer("idle");
    dropSocket();
  }

  /**
   * 1通送る。**繋がっていなければ黙って捨てる。**
   *
   * リアルタイムは上乗せなので、送れないことは失敗ではない（調査 §5.3）。
   * ここで投げると、WebSocket が死んでいる環境で盤面の操作まで止まる。
   */
  function send(text) {
    const ws = state.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * ポインタの位置を送る。`point` は `[x, y]`（**マップのメートル座標・整数**）。
   * `null` は「盤面から出た＝自分のカーソルを消してほしい」。
   *
   * **画面 px ではなくメートルなのは**、各自のズームとパンが違うため。
   * px を送っても相手の画面の別の場所を指す。
   *
   * `carry` は運んでいるもの（`["p"|"c", id, 物のx, 物のy]`）。**この通に相乗りさせる
   * のが Phase R2a の設計の肝**で、運んでいる最中に別の通を作らない
   * （作るとドラッグ中だけ通数が倍になり、課金の試算が崩れる）。
   * 運んでいなければ項目そのものを出さない（`{"t":"cur","x":…,"y":…}` のまま）。
   *
   * `ink` は引いている最中の線（`[色, 太さ, 連番, 前回の続きの点…]`。Phase R2b）。
   * **`carry` と同じ階層に項目を1つ足しただけ**で、ここも新しい通を作らない。
   * 太るのは引いている間だけ（位置だけの通は 33 バイトのまま）。**課金は通の数で
   * 決まり、バイト数では決まらない**ので、受信の上限を 256 → 1024 に上げてある
   * （workers/room/src/cursors.js の `MAX_MESSAGE_LEN`）。
   *
   * 間引き（100ms スロットル・同値の抑制・点の間引き）は board/cursor.js が持つ。
   * ここは「繋がっていれば送る」だけ。
   */
  function sendCursor(point, carry = null, ink = null) {
    if (!point) return send('{"t":"cur"}');
    const msg = { t: "cur", x: point[0], y: point[1] };
    if (carry) msg.d = carry;
    if (ink) msg.k = ink;
    return send(JSON.stringify(msg));
  }

  /** 保存した。**中身は送らない**（DO は盤面の形を知らない）。 */
  function sendChanged() {
    return send('{"t":"chg"}');
  }

  return { start, stop, sendCursor, sendChanged, state };
}
