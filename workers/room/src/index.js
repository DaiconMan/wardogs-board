// wardogs-room — Durable Object を1つだけ持つ Worker。
//
// EN: wardogs-room -- a Worker that holds exactly one Durable Object class. It is
//     separate from the Pages project because a Durable Object cannot be defined
//     inside Pages. PlanRoom relays presence and cursors and keeps no state of its
//     own.
//
// **なぜ Pages と別の Worker なのか。**
// Pages プロジェクトの中に Durable Object を定義できない
// （"You cannot create and deploy a Durable Object within a Pages project."）。
// 代替の「Pages → Workers Static Assets 移行」は `wrangler pages functions build` という
// ビルド工程が入るため却下した（D-047 の決定3）。
//
// **この Worker に公開ルートを付けないこと。**
// Cookie を検証しているのは Pages Function（functions/api/sessions/[id]/ws.js）だけ。
// ここに workers.dev やルートが付くと、x-wb-user を自分で書いた誰かが部屋に入れる。
// wrangler.toml で `workers_dev = false`、ルート未設定にしてある。
//
// **DO が持つ状態は「今つながっている人」と「カーソルの表」だけ。**
// チャットを作らないと決めた（D-047 の決定2）ので、storage も SQLite も使わない。
// 在室は WebSocket の attachment に載る。ハイバネーションから起き直しても
// `state.getWebSockets()` を読み直すだけで復元する。
//
// **R1 でカーソルの表だけメモリの Map にした**（R0 の「状態を一切持たない」を
// 限定的に緩めた）。`serializeAttachment` に入れないのは、あれが書くたびに
// ハイバネーション用の直列化を走らせるからで、**10Hz で書くものを置く場所ではない**。
// メモリなので消えてよい。消えるのは誰も動かしていないとき（＝中身が古いとき）で、
// 次の `cur` で作り直る。
import {
  CHANGED, MAX_MESSAGE_LEN, buildCursors, buildYou, connKey, cursorEntry, dueToSend, rateHit,
} from "./cursors.js";
import { MAX_MEMBERS, buildWho, decodeUser, guestToEvict, pickColor } from "./presence.js";

// 1013 = Try Again Later。クライアントは「満員です（20人まで）」を出して
// 繋ぎ直しをやめる（同じ理由で失敗し続けるので、リトライしても枠を食うだけ）。
function closeFull(ws) {
  try {
    ws.close(1013, "満員です");
  } catch {
    // 既に閉じている。2回目の close は投げる。
  }
}

export class PlanRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // 接続の鍵 -> [x, y, 所有者の Discord ID]（運んでいる最中は4つ目に
    // `[種別, id, x, y]`、引いている最中は5つ目に `[色, 太さ, 連番, 点…]` が付く。
    // cursors.js の `cursorEntry`）。
    // **メモリだけ。** 上のヘッダに理由。
    //
    // **「人」ではなく「接続」でキーを持つ。** 同じ人が2枚開いていれば
    // ポインタは2つあり、消すべきなのは自分のタブのぶんだけ（cursors.js の
    // `connKey` に、人でキーを持っていたときに何が起きたかを書いてある）。
    this.cursors = new Map();
    // ws -> 直近1秒の受信時刻。暴走クライアントを閉じるためだけに持つ。
    // WeakMap なので socket が消えれば一緒に消える。
    this.rates = new WeakMap();
    // ws -> attachment。受信1通ごとの構造化複製を避けるための控え（attachmentOf）。
    this.attachmentCache = new WeakMap();
    // 最後にカーソルを配った時刻と、それ以降に動いた人。
    // **タイマーの代わりがこの2つ**（cursors.js の `dueToSend`）。
    this.lastCursorsAt = 0;
    this.movedSince = new Set();

    // ハートビートの自動応答。**ハイバネーションを解かず wall-clock も消費しない**
    // （調査 §2.4）。クライアントが "p" を送ると workerd が "o" を返す。
    // これを使わずに自前で onmessage → send で返すと、ping1回ごとに DO が起きる。
    //
    // コンストラクタはハイバネーションから起きるたびに走るので、ここで毎回張り直して良い。
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("p", "o"));
  }

  /**
   * 1本の attachment。壊れていたら null。
   *
   * **読んだ結果を覚える。** `deserializeAttachment()` は構造化複製なので安くない。
   * R0 までは在室が変わったときにしか呼ばなかったが、R1 では**受信1通ごと**に
   * 呼ぶ（送り主が誰かを知るため）。20人 × 10Hz = 200通/秒 の経路に
   * 構造化複製を置くと、そこが律速になる。
   *
   * 覚えてよいのは、**attachment が接続時に1回書かれたあと二度と変わらない**から
   * （`{ u, n, c }` も満員の印も `fetch()` の中だけで書く）。ハイバネーションから
   * 起き直すと WeakMap ごと消えるが、そのときは読み直すだけ。
   */
  attachmentOf(ws) {
    const cached = this.attachmentCache.get(ws);
    if (cached !== undefined) return cached;
    let value = null;
    try {
      value = ws.deserializeAttachment();
    } catch {
      value = null;
    }
    this.attachmentCache.set(ws, value);
    return value;
  }

  /**
   * attachment を書く。**書くのはここだけ**（接続時の1回だけ）。
   * 控え（`attachmentCache`）を同時に更新するので、読みと書きが食い違わない。
   */
  setAttachment(ws, value) {
    ws.serializeAttachment(value);
    this.attachmentCache.set(ws, value);
  }

  /**
   * つながっている WebSocket の attachment を返す。
   *
   * `u`（Discord ID）を持たないものは飛ばす。満員で閉じかけの socket には
   * わざと `u` を入れていないので、在室にも配信対象にも入らない。
   */
  attachments(exclude) {
    const out = [];
    for (const ws of this.state.getWebSockets()) {
      if (exclude && ws === exclude) continue;
      const a = this.attachmentOf(ws);
      if (a && typeof a.u === "string") out.push(a);
    }
    return out;
  }

  /**
   * 在室を全員に配る。
   *
   * **文字列を1回だけ作って同じものを send する。** 受信ごと・人数ごとに
   * JSON.stringify を回すと O(N^2) になり、無料プランの CPU 10ms/呼び出しに
   * 当たりうる（調査 §5.8）。そのために `who` に「あなたは誰か」を入れていない
   * （クライアントは /api/me で自分の Discord ID を知っているので、
   * members から自分を引ける）。
   *
   * 送信は課金対象外なので、まとめること自体はコストではない。
   */
  broadcast(exclude) {
    this.sendAll(buildWho(this.attachments(exclude)), exclude);
  }

  /**
   * **出来上がった文字列1本**を配る。作るのは呼び出し側（1回だけ作らせるため）。
   *
   * 送信は課金対象外なので、配る相手が増えること自体はコストではない。
   * 高くつくのは文字列を人数ぶん作ることのほう（調査 §5.8）。
   */
  sendAll(message, exclude) {
    for (const ws of this.state.getWebSockets()) {
      if (exclude && ws === exclude) continue;
      try {
        ws.send(message);
      } catch {
        // 既に閉じている socket に送ると投げる。1本の失敗で残り全員を止めない。
      }
    }
  }

  /** 今つながっている接続の鍵。配信をここで絞ると幽霊カーソルが残らない。 */
  liveKeys(exclude) {
    return new Set(this.attachments(exclude).map((a) => a.k));
  }

  /**
   * カーソルを配る。**配信をタイマーではなく受信で駆動する。**
   *
   * 誰かが動かしている間はメッセージが絶え間なく届くので、タイマーが無くても
   * 10Hz の配信になる。誰も動かさなくなればメッセージが止まり、
   * **このオブジェクトは何も待っていない状態へ自然に戻る。**
   * 「全員が黙って地図を見ている間は課金がゼロ」が、ここでは
   * 「止める処理」ではなく「そもそも何も仕掛けない」で成り立つ。
   *
   * なぜ仕様書の `setTimeout(tick, 100)` を採らなかったかは cursors.js のヘッダに
   * 実測つきで書いてある（要約: ハイバネーション対応の DO ではタイマーが消える）。
   */
  sendCursors(senderKey = null, force = false) {
    const now = Date.now();
    const due = dueToSend({
      lastAt: this.lastCursorsAt, now, senderId: senderKey, seen: this.movedSince, force,
    });
    if (!due) {
      // まだ配らない。**この接続は「ひと回り」に数える**（次に同じ接続から来たら配る）。
      if (senderKey !== null) this.movedSince.add(senderKey);
      return;
    }
    this.lastCursorsAt = now;
    // 配ったので次のひと回りは空から。ここで送り主を入れないのは、
    // いま配った中に既にこの接続の位置が入っているから（入れると次の1通で
    // すぐ開いてしまい、人数ぶんの間引きが効かなくなる）。
    this.movedSince.clear();
    this.sendAll(buildCursors(this.cursors, this.liveKeys()));
  }

  async fetch(request) {
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("WebSocket 専用です", { status: 403 });
    }

    // Pages Function が検証して詰めた値。**ここでは検証しない（できない）。**
    // 形が違えば 403。これは「Pages を経由していない」ことの表れなので、
    // 中身の権限を判断しようとせず入口で落とす。
    const user = decodeUser(request.headers.get("x-wb-user"));
    if (!user) return new Response("認証情報がありません", { status: 403 });

    // 満員でログイン済みの人が来たら、ゲストを1人押し出して席を空ける。
    // **押し出すのはログイン済みが来たときだけ。** ゲスト同士で押し合うと、
    // 2人目のゲストが1人目を蹴るだけの椅子取りになる。
    //
    // **押し出した人を以降の数え方から外す。** `close()` を呼んでも
    // `getWebSockets()` にはしばらく残るので、外さないと**席を空けた直後に
    // 自分が満員で断られる**（空けた意味が無くなる）。
    const evicted = user.guest ? null : this.makeRoomFor(user);

    const others = this.attachments().filter((a) => a.u !== evicted);
    const distinct = new Set(others.map((a) => a.u));

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // **`state.acceptWebSocket()` だけを使う。`server.accept()` は禁止。**
    // accept() はつながっている間ずっと実行時間が課金され、タブ1枚の放置で
    // 1日枠の 83% を食う（調査 §2.4）。
    this.state.acceptWebSocket(server);

    // 満員。同じ人の2タブ目は数えない（上限は「人」の数）。
    //
    // **ここで close() を呼んではいけない。** 101 を返す前に閉じると、
    // ローカル開発（Pages と room が別プロセス）ではクライアントに close フレームが
    // 一切届かず、相手は「繋がったのに何も来ない」状態で固まる（実測）。
    // 代わりに「満員の印」を attachment に付けて返し、**最初の1通が来た時点で閉じる。**
    // クライアントは開いた直後に必ず {"t":"who"} を送るので、実質すぐ閉じる。
    // 印の付いた socket は `u` を持たないので、在室にも配信対象にも入らない。
    if (!distinct.has(user.id) && distinct.size >= MAX_MEMBERS) {
      this.setAttachment(server, { full: true });
      return new Response(null, { status: 101, webSocket: client });
    }

    // attachment が唯一の記憶。16,384 バイト上限に対して数十バイト。
    //
    // **`k`（接続の鍵）もここで1回だけ作る。** カーソルの表はこれでキーを持つ。
    // `serializeAttachment` は書くたびにハイバネーション用の直列化を走らせるが、
    // ここは接続時の1回きりなので 10Hz の経路には乗らない。
    //
    // **`g` はゲストの印**（在室一覧に「見るだけ」を出し、満員のときに
    // 押し出す相手を選ぶのに要る）。ゲストのときだけ付けるので、
    // ログイン済みの attachment は今までと同じ形のまま。
    const attachment = {
      u: user.id, n: user.name, c: pickColor(user.id, others), k: connKey(),
    };
    if (user.guest) attachment.g = 1;
    // **`a` はアイコンの hash**（32文字）。名前と色と同じ場所に置くので、
    // 配るのも同じ `who` 1本で済む。**`curs`（10Hz）には足さない。**
    // ゲストと、Discord の既定アイコンの人には付かない（`decodeUser` が
    // 形を見て落としている）。
    if (user.avatar) attachment.a = user.avatar;
    this.setAttachment(server, attachment);

    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 満員なら、ゲスト1人を押し出して席を1つ空ける。
   *
   * **ログイン済みの人を優先するための仕掛け。** ゲストは誰でも何個でも身元を
   * 作れるので、これが無いと URL が漏れた作戦の部屋を塞いでチームを入れなくできる
   * （仕様の受け入れ条件7）。
   *
   * 押し出された側には**既存の 1013 の経路**で「満員です」が出る
   * （`closeFull`。クライアントは `presence.js` の `FULL_NOTE` を出して
   * 繋ぎ直しをやめる）。新しい番号も新しい通も作らない。
   *
   * **席は人の数で数えるので、その人の接続を全部閉じる**（2枚開いていたゲストの
   * 片方だけ閉じても席は空かない）。閉じたぶんのカーソルも落とす——残すと
   * 居ない人のカーソルが相手の画面に残る。
   *
   * 既に入っている人（タブ2枚目）なら席は要らないので何もしない。
   * **タイマーは1本も使わない**（D-067。`close` はその場で効く）。
   *
   * 戻り値は押し出した人の id（押し出さなかったら `null`）。
   * **呼び出し側はこれを以降の数え方から外すこと**（`close()` 直後の
   * `getWebSockets()` にはまだ残っている）。
   */
  makeRoomFor(user) {
    const here = this.attachments();
    const distinct = new Set(here.map((a) => a.u));
    if (distinct.has(user.id) || distinct.size < MAX_MEMBERS) return null;

    const evict = guestToEvict(here);
    if (!evict) return null; // 全員ログイン済み。押し出さない（この人は満員で断られる）

    for (const ws of this.state.getWebSockets()) {
      if (this.attachmentOf(ws)?.u !== evict) continue;
      this.dropCursor(ws);
      closeFull(ws);
    }
    return evict;
  }

  /**
   * 受ける通は3種類だけ。`who`（在室の取り直し）・`cur`（カーソル）・`chg`（保存した）。
   *
   * ハートビートは `setWebSocketAutoResponse` が処理するのでここに来ない。
   *
   * **タイマーは1本も張らない**（`setInterval` / `setAlarm` / `setTimeout` のどれも）。
   * カーソルの配信はここから直に呼ぶ `sendCursors()` が間隔を見て決める。
   * 理由は cursors.js のヘッダに実測つきで書いてある。
   *
   * メッセージ長の上限は `MAX_MESSAGE_LEN`（1024）。**R0 の 256 から上げた**
   * ——引いている最中の線（`k`）には点が入るので 256 では足りない。
   * **課金は通の数で決まり、バイト数では決まらない**ので、1通を太らせても請求は
   * 変わらない（cursors.js の `MAX_MESSAGE_LEN` に理由）。位置だけの
   * `{"t":"cur","x":-16384,"y":-16384}` は 33 バイトのままで、太るのは引いている間だけ。
   */
  webSocketMessage(ws, message) {
    // 満員で閉じかけの socket。close が届いていなかった場合の取りこぼしを拾う。
    const attachment = this.attachmentOf(ws);
    if (attachment?.full) {
      closeFull(ws);
      return;
    }

    // **受信は到達した時点で課金される**（調査 §2.4「受信メッセージは 20:1」）。
    // 無視しても枠は減るので、暴走したクライアントは閉じるしかない。
    // これを入れないと、壊れたタブ1枚が1日枠を数分で溶かす。
    //
    // Worker の `Date.now()` は I/O をするまで進まない（cursors.js の `dueToSend`）。
    // 止まっている間に届いた通は同じ時刻として数えるので、**この判定は厳しめに倒れる**。
    // 厳しめで困らないのは、まともなクライアントの通と通のあいだには必ず
    // 配信（＝ I/O ＝ 時計が進む）が挟まるから。1秒に30通を同じ時刻で積めるのは、
    // 配信を待たずに撃ち続けている相手だけで、それがまさに閉じたい相手。
    const rate = rateHit(this.rates.get(ws) ?? [], Date.now());
    this.rates.set(ws, rate.times);
    if (rate.over) {
      try {
        ws.close(1008, "送信が多すぎます");
      } catch {
        // 既に閉じている。
      }
      return;
    }

    if (typeof message !== "string" || message.length > MAX_MESSAGE_LEN) return;
    let msg = null;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    // 身元の無い socket（満員の印が付いていない壊れた attachment）は中継しない。
    const id = typeof attachment?.u === "string" ? attachment.u : null;
    const key = typeof attachment?.k === "string" ? attachment.k : null;

    if (msg?.t === "who") {
      try {
        ws.send(buildWho(this.attachments()));
        // **自分の接続の鍵を1通だけ返す。** クライアントは配られたカーソルの
        // 表から自分のぶんを外すのにこれが要る（`buildYou` に、配信を
        // 受信者ごとに作らない方針と矛盾しない理由を書いてある）。
        // `who` はクライアントが開いた直後に1回だけ送るので、ここは接続1回に1通。
        if (key) ws.send(buildYou(key));
      } catch {
        // 閉じかけの socket。無視する。
      }
      return;
    }

    if (!id || !key) return;

    if (msg?.t === "cur") {
      // 座標なし ＝ 盤面から出た。表から消して、**窓を待たずに**配る
      // （遅れるとその人のカーソルが相手の画面に居座る）。
      //
      // **所有者の Discord ID を値に添える。** 名前と色は「人」のものなので、
      // クライアントは在室一覧（`who`）をこれで引く。
      //
      // 運んでいるものが添えてあれば4つ目、引いている最中の線は5つ目に入る
      // （`cursorEntry`）。**新しい種類の通は作っていない。**
      // この `cur` は R1 から1通も増えていない（増えるのは1通の長さだけ）。
      //
      // **ゲスト（`g`）からの「引いている最中の線」は中継しない**（D-072）。
      // ゲストは線を保存できないので、引いている最中も存在しえない。
      // まともなクライアントは送ってこないが、`k` は生の文字列で自分で組めるので
      // ここで落とす。**落とすのは `cursorEntry` の中**（「書けるか」の判定を
      // 2箇所に置かない）。カーソルと運んでいるものは今までどおり通す。
      const entry = cursorEntry(msg, id, attachment?.g !== 1);
      if (entry) this.cursors.set(key, entry);
      else this.cursors.delete(key);
      this.sendCursors(key, !entry);
      return;
    }

    // **送信者には返さない**（自分の保存で自分が再取得するのは無駄）。
    // 中身は載っていない。受け取った側は既存の GET /api/sessions/:id を叩くので、
    // D1 が唯一の真実のままになる。
    if (msg?.t === "chg") this.sendAll(CHANGED, ws);
  }

  /**
   * 切れた人の後始末。
   *
   * カーソルを**その場で1回配り直す**（タイマーは張らない。送信は課金されない）。
   * 配り直さなくてもクライアント側の3秒 TTL が消すが、1秒以内に消えるほうが
   * 「もう居ない人のカーソルが残っている」に見えない。
   *
   * 表は接続単位なので、同じ人が2枚開いていて片方だけ閉じたときに
   * **消えるのは閉じたほうだけ**（人単位だった頃は両方消えていた）。
   */
  dropCursor(ws) {
    const key = this.attachmentOf(ws)?.k;
    if (typeof key !== "string" || !this.cursors.delete(key)) return;
    this.sendAll(buildCursors(this.cursors, this.liveKeys(ws)), ws);
  }

  webSocketClose(ws) {
    // 閉じた本人は getWebSockets() にまだ残ることがあるので明示的に除く。
    this.dropCursor(ws);
    this.broadcast(ws);
  }

  webSocketError(ws) {
    this.dropCursor(ws);
    this.broadcast(ws);
  }
}

// この Worker の HTTP の入口。**ここから DO には入れない。**
// 公開ルートは付けない設定だが、万一付いたときの二重防御として常に 404 を返す。
// Pages 側は `env.ROOM.get(id).fetch()` でバインディング経由で DO に入るので、
// この handler を通らない。
export default {
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};
