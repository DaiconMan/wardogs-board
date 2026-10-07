// /plan のエントリ。ログインを確かめて、一覧か盤面かを決めて、組み立てる。
//
// 画面ごとの中身は pages/ に、盤面の部品は board/ にある。
// **ここは何からも import されない。**だから main() は全部の読み込みの後に走る。
//
// EN: Entry point for /plan. Checks the login, decides between the plan list and the
//     board, and wires everything together. Per-screen code lives in pages/, board
//     parts in board/. Nothing imports this file, so main() runs after every module
//     has loaded.

import { getMe, getPlan, logout, onChanged } from "./api.js";
import { refreshAreas } from "./board/area.js";
import { drawBasemap } from "./board/basemap.js";
import { loadCallouts } from "./board/callout.js";
import {
  setCursorPeers, setCursorSink, showCursors, stopCursors, wireCursorSend,
} from "./board/cursor.js";
import { renderSpawns, renderTowers } from "./board/fixtures.js";
import { drawBounds, drawGrid } from "./board/grid.js";
import { setLiveReloadPending } from "./board/live.js";
import { loadPlacements } from "./board/place.js";
import { wireBoard, wireKeys } from "./board/pointer.js";
import { boardBusy, reloadBoard } from "./board/reload.js";
import { wireTools } from "./board/tools.js";
import { applyView, boardRatio } from "./board/view.js";
import { canWriteHere, wireVisibility } from "./board/visibility.js";
import { initZonePreset } from "./board/zone.js";
import { createChanges } from "./changes.js";
import {
  say, sayOffline, setEditable, setViewOnly, showBackToList, updateRailOverflow, watchChrome,
} from "./chrome.js";
import { makeCoords } from "./coords.js";
import { accountMenu, inkLayer, railEl, statusEl } from "./dom.js";
import { showGuestGate, showLoginOnly } from "./pages/gate.js";
import { showCreateForm } from "./pages/list.js";
import { GUEST_VIEW_ONLY, GUEST_WHO } from "./visibility.js";
import { createPresence, myColorName } from "./presence.js";
import { clearChildren, renderStroke } from "./render.js";
import { state } from "./state.js";
import { coverView } from "./viewport.js";

/**
 * 自分の色の**仮決め**。Discord ID から決める。
 *
 * **式は workers/room/src/presence.js の colorSeed() と同一**
 * （tests/room-presence.test.js がこの一致を見張っている）。
 * ただしサーバは部屋の中で色がぶつからないようずらすことがあるので、
 * 在室が届いたら `applyMyColor()` が本物に差し替える。
 * WebSocket が繋がらない環境ではこの仮の色のまま使う。
 */
function pickColor(discordId) {
  let h = 0;
  for (const ch of String(discordId)) h = (h * 31 + ch.charCodeAt(0)) % 8;
  return `cursor-${h + 1}`;
}

function setMyColor(name) {
  state.color = name;
  document.documentElement.style.setProperty("--me", `var(--${name})`);
}

/**
 * サーバが割り当てた色を自分のペンにも反映する（D-048 の残件）。
 *
 * **一度だけ。** 色が変わるのは繋がった直後（まだ何も引いていない）なので、
 * そこで揃えれば「さっき引いた線」と「これから引く線」の色は食い違わない。
 * 繋ぎ直しのたびに変えると、**同じ人の線が2色になり、インクには名前が無いので
 * 判別不能になる**（D-047 の未決事項そのもの）。
 */
let colorSynced = false;
function applyMyColor(members) {
  if (colorSynced) return;
  const name = myColorName(members, state.me?.user?.id);
  if (!name) return;
  colorSynced = true;
  if (name !== state.color) setMyColor(name);
}

async function main() {
  wireTools();
  wireBoard();
  wireKeys();
  railEl?.addEventListener("scroll", updateRailOverflow, { passive: true });
  // 浮いている枠の実寸を CSS へ渡す（パネル・縮尺・座標の逃がし先）。
  watchChrome();
  setEditable(false);

  // 「ログインしていない」と「そもそも繋がらない」を混ぜない。
  // 混ぜるとAPIが全部落ちているときにログインゲートが出て、押しても
  // 何も起きない画面になる（仕様はマップを残して編集だけ止める、が正）。
  // api.js は HTTP エラーにだけ err.status を付けるので、
  // status が付いていなければ通信そのものの失敗と判断できる。
  try {
    state.me = await getMe();
  } catch (e) {
    if (e.status === undefined) { sayOffline(); return; }
    state.me = { authenticated: false };
  }
  // **ログイン無しでも見られる。**「見るだけ」なら身元は localStorage の乱数で足りる
  // （仕様 2026-10-02-guest-viewers.md）。サーバが `/api/me` で生成名まで返すので、
  // ここから下は「名前がある人」として同じ道を通れる。
  //
  // ゲストでもない（＝身元が作れなかった）ときだけログインの画面にする。
  const guest = state.me.user?.guest === true;
  if (!state.me.authenticated && !guest) { showLoginOnly(); return; }

  // 「誰でログインしているか」は畳んだメニューの中。枠に常駐させない。
  //
  // **ただし畳んだボタンには名前を全文入れる。**
  // 以前はここで `[...name][0]` と頭1文字だけを入れていた。幅も
  // text-overflow も関係なく、**中身がそもそも1文字だった**ので、画面には
  // `D ▾` としか出ず「右上のDって何ですか」になった（オーナー指摘 2026-10-01）。
  // 見た目の省略は CSS（#account-name の max-width + ellipsis）に任せる。
  // こうすると短い名前は丸ごと出て、長い名前だけが頭から必要なだけ出る。
  // 名前が無い（Discord 側で空）ときの代わりは1箇所で決める。
  // 3つの出し先で別々に埋めると、片方だけ「undefined」が出る。
  const name = state.me.user.name || "自分";
  // ゲストには「いまどういう状態か」と「どうすれば書けるか」を1文で。
  // 「ログイン中」と同じ場所に出すので、2つの状態が同じ型で読める。
  document.getElementById("who").textContent = guest ? GUEST_WHO : `${name} でログイン中`;
  const accountName = document.getElementById("account-name");
  if (accountName) accountName.textContent = name;
  // 省略されたときの取り返し先（マウス）と、読み上げの名前。
  // aria-label は要素の中身を上書きするので、ここに名前を入れないと
  // 読み上げから名前が消える。
  const accountSummary = accountMenu?.querySelector("summary");
  if (accountSummary) {
    accountSummary.title = name;
    accountSummary.setAttribute("aria-label", `自分の設定（${name}）`);
  }
  if (accountMenu) accountMenu.hidden = false;
  setMyColor(pickColor(state.me.user.id));
  // ログイン済みには抜ける導線、ゲストには入る導線。**どちらも同じ引き出しの中。**
  if (guest) wireLoginLink();
  else wireLogout();

  const planId = new URLSearchParams(location.search).get("id");
  // ?id= が無いとき。ログイン済みは枠の表、ゲストは**公開されている作戦**と
  // ログインの案内（ゲストには「自分の作戦」も「開いたことがある作戦」も無い）。
  if (!planId) {
    if (guest) await showGuestGate();
    else await showCreateForm();
    return;
  }

  // 戻る導線はプランの取得より「前」に出す。読み込みに失敗したときこそ、
  // 一覧へ戻る手段が要る（失敗した画面を行き止まりにしない）。
  showBackToList();

  try {
    state.plan = await getPlan(planId);
  } catch {
    sayOffline();
    return;
  }

  const { session, map, strokes, towers, spawns } = state.plan;
  document.getElementById("title").textContent = session.title;
  document.getElementById("map-name").textContent = map.name;
  document.getElementById("unverified").hidden = map.verified === 1;

  state.coords = makeCoords(map);
  drawGrid(map);
  drawBounds(map);
  drawBasemap(map);
  // **開いた直後はマップが画面を埋める（coverView）。**
  // 余白を1pxも出さないのが、この道具でいちばん大事な第一印象。
  // 全体を見たくなったら「全体表示」が1押しで届く。
  state.view = coverView(map, boardRatio());
  // タワーは最初の applyView() より前に作る。作戦を開いた最初の描画から
  // 見えていないと「手で置くもの」と誤解される（マップが持っている設備なので、
  // 最初からそこにある）。大きさを画面基準に直すのに state.view が要るので、
  // fitView の後に呼ぶ。
  renderTowers(towers);
  renderSpawns(spawns);
  // コントロールエリアの円はタワーの後。中のタワーを強調するので、
  // タワーの <g> が先に出来ていないと印を付けられない。
  initZonePreset(state.plan);
  applyView();

  clearChildren(inkLayer);
  for (const stroke of strokes) inkLayer.appendChild(renderStroke(stroke, state.coords));

  // エリアは盤面の取得に相乗りしている（別の fetch を増やさない）。
  // 自分がこれから塗る行と同じ列に積むので、配列は複製して持つ。
  state.areas = Array.isArray(state.plan.areas) ? [...state.plan.areas] : [];
  refreshAreas();

  wireShare();
  // 公開設定の欄（作成者だけ）と「見るだけ」の札（書き込めない人）。
  // **setEditable より前に呼ぶ。** 棚を止める前に、止まる理由を画面に出しておく。
  wireVisibility();
  // **読専で公開された作戦では、書く道具だけ止める。**
  // サーバは 403 を返すが、押せるボタンを並べておいて断るのは
  // 「引いた線が消えた」ように見える（線はそもそも保存されていない）。
  // 見る道具（拡大縮小・背景）は残す（`setViewOnly` の注記）。
  // 判定は `_lib/visibility.js` とまったく同じ関数（canWrite）。
  if (canWriteHere()) setEditable(true);
  else setViewOnly();
  updateRailOverflow();

  // 在室一覧（同じ作戦を今開いている人）。**await しない。**
  // WebSocket は「あとから生えてくる装飾」で、繋がらなくても以降の処理と
  // 盤面の読み書きは全部 HTTP で動く（調査 §5.3）。ここで待つと、
  // Durable Objects の枠を使い切った日にサイトが開かなくなる。
  //
  // **ゲストもここを通る**（見ることとカーソルがゲストにできること全部）。
  // 身元はクエリで渡す（`presence.js` の `wsUrl`）。
  startPresence(session.id, guest ? state.me.user.id : null);

  // カタログと配置はマップより後。ここが失敗しても線は引けるので、
  // #status に理由を残したまま（say("") で消さずに）終わる。
  //
  // 成功しても、取得を待っている間にユーザーの操作で何か言っていたら消さない。
  // 読み込みは非同期なので、読み終わった瞬間に無条件で空にすると
  // 「マップの外です」のような案内が本人の読む前に消える。
  const before = statusEl.textContent;
  const placementsOk = await loadPlacements();
  const calloutsOk = await loadCallouts();
  if (placementsOk && calloutsOk && statusEl.textContent === before) say("");

  // **道具が全部止まっている理由を、止まっている画面に書く。**
  // ヘッダの「見るだけ」の札だけでは、それが公開設定のせいなのか
  // ログインしていないせいなのか読めない（直し方が違う）。
  // 読み込みが済んだ**あと**に出す。前に出すと上の say("") が消してしまう。
  if (guest) say(GUEST_VIEW_ONLY);
}

/**
 * リアルタイム（在室一覧・共有カーソル・変更通知）を開始する。**何があっても投げない。**
 *
 * **ここは await しない。** WebSocket は「あとから生えてくる装飾」で、
 * 繋がらなくても盤面の読み書きは全部 HTTP で動く（調査 §5.3）。
 * ここで例外が漏れると「盤面が開かない」に化ける
 * （`/api/sessions/:id/ws` が 503 を返す環境が実在する）。
 *
 * 3つのうち失敗して困るものは1つも無い:
 *   在室一覧  … ヘッダの #presence が出ないだけ
 *   カーソル  … 送らない・描かないだけ
 *   変更通知  … 今までどおり、リロードで追いつく
 */
function startPresence(sessionId, guestId = null) {
  const el = document.getElementById("presence");
  if (!el || typeof WebSocket !== "function") return;
  try {
    // 誰かが保存したら取り直す。300ms デバウンス＋操作中は保留（changes.js）。
    const changes = createChanges({ reload: reloadBoard, busy: boardBusy });
    // **他の人が「やっている最中」として見せているものを、いつ片付けるか。**
    // 取り直しが来ると分かっている間は片付けを着地まで預ける（離した瞬間に
    // 片付けると、保存された値が届くまでの数百ミリ秒だけ「元の位置へ跳ね返る」
    // 「線が一瞬消える」が見える。board/live.js）。**層ごとではなく1回だけ。**
    setLiveReloadPending(() => changes.pending());

    const presence = createPresence({
      sessionId,
      meId: state.me?.user?.id,
      guestId,
      el,
      // 名前と色は在室一覧から引く（カーソルの通には鍵・座標・所有者しか入っていない）。
      // `myKey` は自分の**接続**の鍵。これで外すので、同じ人が2枚開いていても
      // 相手のタブのカーソルは消えない（D-047 / 2026-10-02 のオーナー報告）。
      onCursors: (cursors) => showCursors(cursors, presence.state.members, presence.state.myKey),
      onChanged: () => changes.notify(),
      onMembers: (members) => {
        // サーバが割り当てた色をペンにも反映する（カーソルと線の色を揃える）。
        applyMyColor(members);
        // **人数が増えたらカーソルの送信頻度を下げる。** 上限は 50人だが、
        // 人数 × 頻度 ≤ 200通/秒 を保つので DO の枠の消費は 20人のときと同じ
        // （board/cursor.js の `setCursorPeers`）。見た目の補間の長さも
        // ここから決まる。
        setCursorPeers(members.length);
      },
    });
    presence.start();

    // 自分のポインタを送る口を繋ぐ。**繋がるまでは何も送らない**
    // （sink が null の間、board/cursor.js は黙って捨てる）。
    // 第2引数は運んでいるもの（`["p"|"c", id, x, y]`）、第3引数は引いている最中の
    // 線（`[色, 太さ, 連番, 点…]`）。**どちらもカーソルの通に相乗りする**ので、
    // 運んでいる最中も引いている最中も通数は増えない（board/cursor.js の `push`）。
    setCursorSink((point, carry, ink) => presence.sendCursor(point, carry, ink));
    wireCursorSend();

    // **自分の保存を他の人へ知らせる。** api.js の call() 1箇所にだけ付くので、
    // これから足す機能も自動的に通知される。
    onChanged(() => presence.sendChanged());

    // タブを閉じる・別ページへ移るときに確実に切る。残すと DO が起きたままになる。
    addEventListener("pagehide", () => {
      presence.stop();
      changes.stop();
      stopCursors();
    });
  } catch {
    el.hidden = true;
  }
}

/**
 * ゲストに「ログインすれば書ける」導線を出す。
 *
 * **ログアウトと同じ引き出しの中**（`#account`）。入る口と出る口が
 * 同じ場所にあれば、どちらの状態でも探す先が1つで済む。
 * 盤面でも一覧でも出す（どちらの画面からでも書く側に移れる）。
 */
function wireLoginLink() {
  const btn = document.getElementById("to-login");
  if (!btn) return;
  btn.hidden = false;
  // ログイン前の画面の `#login` と同じやり方（押したら飛ぶ）。
  btn.addEventListener("click", () => { location.href = "/api/auth/discord/start"; });
}

// ログアウト。30日 Cookie なので、共用PCで押せる手段が無いと抜けられない。
// ログイン済みなら常に出す（作成フォームでも盤面でも）。
function wireLogout() {
  const btn = document.getElementById("logout");
  if (!btn) return;
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await logout();
    } catch (e) {
      say(`ログアウトできませんでした。${e.message}`, true);
      btn.disabled = false;
      return;
    }
    location.reload();
  });
}

// 共有URLをコピーするボタン。プランが読み込めた（?id= が有効だった）ときだけ出す。
// clipboard API は非HTTPSや古いブラウザで例外を投げるので、その場合は
// URLを #status にそのまま出すフォールバックにする。
function wireShare() {
  const btn = document.getElementById("share");
  if (!btn) return;
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      say("コピーしました。");
    } catch {
      say(location.href);
    }
  });
}

main();
