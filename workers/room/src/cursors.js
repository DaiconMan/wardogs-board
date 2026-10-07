// 共有カーソル（Phase R1）の純粋なロジック。
//
// EN: Pure logic for shared cursors. Same shape as presence.js -- functions whose
//     answer depends on their arguments alone -- for the same reason: vitest can check
//     them without workerd. About half of what lives here is a billing safety valve.
//
// **presence.js と同じ形にしてある**（引数だけで答えが決まる関数の集まり）。
// 理由も同じで、workerd を立てずに vitest で確かめられるようにするため
// （tests/room-cursors.test.js）。
//
// **ここに置いたものの半分は課金の安全弁。** 10Hz のカーソルは R1 で唯一
// 枠を意味のある量で消費するもので（調査 §2.4: 20人 × 10Hz × 30分 = 1日枠の18%）、
// その見積もりが崩れる経路は2つしかない。
//
//   1. **誰も動かしていない間もタイマーが回る** → そもそもタイマーを作らない
//      （下の「ティッカー」。`tests/room-cursors.test.js` がソースを見張っている）
//   2. **暴走したクライアントが送り続ける**     → `rateHit`
//
// どちらも e2e では確かめられない（静止2分を Playwright で待てない／
// 暴走クライアントを作るのが本末転倒）ので、**単体で試験できる形に切ってある。**
// 本番で静止中の課金を見る手順は `tools/do-usage.mjs` のヘッダ。

/**
 * ブロードキャストの最短間隔（ms）。
 *
 * **クライアントの一番速い送信間隔（100ms）より少し短い。** 同じ 100ms にすると、
 * 到着のゆらぎで「99ms だったので配らない」が頻発し、1人で動かしているときに
 * 200ms の抜けができてカーソルが飛ぶ。80ms なら 10Hz の送信は必ず通り、
 * 50人が同時に動いても配信は最大 12.5Hz に収まる。
 *
 * **人数が増えるとクライアント側の送信間隔は広がる**（在室50人で 250ms。
 * `public/js/plan/cursors.js` の `CURSOR_RATE_TIERS`）。ここはその一番速い側に
 * 合わせてあればよいので、上限の人数を変えても触らない。
 *
 * **これは CPU の話であって課金の話ではない。** 送信は課金対象外で、
 * 課金されるのは受信（20:1）＝クライアントの送信頻度のほう（調査 §2.4）。
 *
 * **本番で上限まで流して確かめてある**（2026-10-04。`tools/ws-fanout.mjs`）:
 * 50接続 × 4Hz ＝ 毎秒196通を30秒流して、受け手に届いたのは **12.00 回/秒**
 * （この 80ms の上限 12.5Hz のほぼ上限）。30秒のあいだ1秒も欠けていない。
 *
 * **`npm run dev` で同じことをすると 0.6 回/秒まで落ちて20秒以上黙る。**
 * あれはローカルの2プロセス構成（`wrangler pages dev` ↔ `wrangler dev` を
 * プロキシで繋いだ経路）だけの現象で、**ここの間引きが壊れているのではない。**
 * 数字と切り分けは `public/js/plan/cursors.js` の
 * `CURSOR_BUDGET_MEASURED_PER_SEC` にまとめてある。
 */
export const BROADCAST_GAP_MS = 80;

/** 1本の socket が直近1秒に受けてよい通数。正常なクライアントは 10Hz なので3倍の余裕。 */
export const RATE_MAX = 30;
export const RATE_WINDOW_MS = 1000;

/**
 * 座標として受け付ける絶対値の上限（メートル）。
 *
 * **DO はマップの大きさを知らない**（知ると盤面の形を知ることになり、
 * スキーマを変えるたびに DO も直す羽目になる）。実在するマップの最大は
 * 16,384m なので、桁が明らかに違う値だけを弾く緩い網にしてある。
 */
export const MAX_COORD = 100_000;

/**
 * 1通として受け付ける文字列の長さ（バイト）。**R0 の 256 から上げた。**
 *
 * **課金は「通の数」で決まり、バイト数では決まらない**（受信20通が1リクエスト。
 * 調査 §2.4）。**1通を太らせても請求は1円も変わらない。** 引いている最中の線
 * （`k`）は点が入るので 256 では足りず、ここを上げた。
 *
 * **それでも無制限にはしない。** 壊れたクライアントが巨大な通を投げ続けるのを
 * 止める壁として残す（`JSON.parse` に無制限の文字列を渡さない）。
 * **1通に収まらないほど速く引かれたときは、クライアントが点を間引く**
 * （`public/js/plan/cursors.js` の `inkChunk`。確定した線は保存の経路から来るので、
 * 途中の見た目が少し粗くても最終形は狂わない）。
 */
export const MAX_MESSAGE_LEN = 1024;

/**
 * 1通に載せてよい点の数。**DO の仕事を有限に保つための網。**
 *
 * 長さの上限（1024）だけでも 200組ほどで止まるが、数を切っておけば
 * `parseInk` のループの上限が読んで分かる。
 */
export const MAX_INK_POINTS = 256;

/**
 * 点として受け付ける絶対値の上限。**`MAX_COORD` の10倍。**
 *
 * 点は 0.1m 単位の整数（`public/js/plan/ink.js` の `QUANTUM`）なので、
 * メートルの網をそのまま当てると桁が1つ足りない。
 * **DO はこの 10 が何なのかを知らなくてよい**（緩い網であることが要点で、
 * 正しい範囲はマップを知っている Pages 側が保存時に見ている）。
 */
export const MAX_INK_COORD = MAX_COORD * 10;

/** 頭の3つ（色・太さ・連番）として受け付ける上限。意味は見ず、小さな正の整数かだけ見る。 */
const INK_HEAD_MAX = 1000;

/** 「誰かが変えた」の1通。**中身を載せない**（DO は盤面の形を知らない）。 */
export const CHANGED = '{"t":"chg"}';

/**
 * 接続ごとの鍵。**カーソルの身元は「人」ではなく「接続」。**
 *
 * **これが「同じ人が2枚開くと1本も出ない」の直し方**（2026-10-02 のオーナー報告
 * 「ピンは移動したら即時反映されるのですが、マウスカーソルは出ないですね」）。
 * 表を Discord ID でキーにしていた頃は、2枚開いている人のカーソルが1本しか
 * 存在せず、**それを両方のタブが「自分のもの」として消していた**。
 * `chg` は送信者のソケットだけ除いて配るので別タブには届く——これが
 * 「ピンは出るがカーソルだけ出ない」という形になって現れる。
 *
 * **2枚開いている人は実際にポインタを2つ持っている。** 消すべきなのは自分の
 * タブのぶんであって、同じ人の別タブのぶんではない。
 *
 * 在室（`rosterOf`）は「人」で数えたままにする（D-047。上限 20 は人の数）。
 * 数え方を接続に変えると、2枚開いた人が席を2つ占める。
 *
 * 長さ8の16進。20接続での衝突は 4.3e9 分の数——無視してよい。
 * 接続時に1回だけ作るので、10Hz の経路には乗らない。
 */
export function connKey() {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * 「あなたの接続の鍵はこれ」。**接続1回につき1通だけ。**
 *
 * クライアントは配られたカーソルの表から自分のぶんを外す必要があり、
 * そのためには自分の鍵を知らなければならない。
 *
 * **「配信のたびに受信者ごとの文字列を作らない」は崩していない**（調査 §5.8）。
 * 避けたいのは 10Hz × 20人の経路で stringify が人数ぶん走ることで、
 * 接続1回につき1通はその経路に乗らない。送信は課金対象外（受信が 20:1）なので、
 * 枠の試算（調査 §2.4 の 18%）も動かない。
 *
 * 鍵は `connKey()` が作る16進だけなので、そのまま埋めて JSON になる。
 */
export function buildYou(key) {
  return `{"t":"you","k":"${key}"}`;
}

/**
 * `{"t":"cur", ...}` から座標を取り出す。
 *
 * 戻り値:
 *   `[x, y]` … そこを指している
 *   `null`   … 座標が無い／読めない ＝ **カーソルを消す**
 *
 * 仕様の `{"t":"cur"}`（盤面から出た）と、壊れた値を同じ「消す」に倒している。
 * 壊れた値を無視して古い位置を残すと、幽霊カーソルが相手の画面に居座るため。
 *
 * **0 を「座標なし」と取り違えないこと。** 素朴に `if (!msg.x)` と書くと
 * 盤面の左上隅（x=0 / y=0）でだけカーソルが消える。
 */
export function parseCursor(msg) {
  if (!msg || typeof msg !== "object") return null;
  const x = msg.x;
  const y = msg.y;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) return null;
  return [Math.round(x), Math.round(y)];
}

/**
 * 運んでいるものの種別。**1文字の英小文字という形だけを見る。**
 *
 * **DO は "p" が配置で "c" が地名だと知らない。** 知ると盤面の形を知ることになり、
 * 種類を増やすたびに DO を直す羽目になる（`chg` に中身を載せない理由と同じ）。
 * 形だけ見ているので、線やエリアを後から足すときにここは触らない。
 */
const CARRY_KIND = /^[a-z]$/;

/**
 * `{"t":"cur", ..., "d":[種別, id, x, y]}` の `d` を取り出す。
 *
 * **これが「運んでいる最中」の全部。** 新しい種類の通は作らない
 * （ドラッグ中は既に `cur` が 10Hz で飛んでいるので、そこに相乗りさせる。
 * 別の通にすると、ドラッグ中だけ通数が倍になって課金の試算が崩れる）。
 *
 * 戻り値:
 *   `[種別, id, x, y]` … これを運んでいる
 *   `null`             … 何も運んでいない／読めない
 *
 * **`<x> <y>` は運んでいる物の座標であって、カーソルの座標ではない。**
 * 掴んだ位置のずれがあるので、カーソル位置で代用すると物が指先に吸い付いて見える。
 *
 * 壊れた値を `null` に倒すのは `parseCursor` と同じ作法。ただしこちらを落としても
 * **カーソルそのものは通す**（`cursorEntry`）。位置が分かることのほうが大事。
 */
export function parseCarry(msg) {
  const d = msg?.d;
  if (!Array.isArray(d) || d.length !== 4) return null;
  const [kind, id, x, y] = d;
  if (typeof kind !== "string" || !CARRY_KIND.test(kind)) return null;
  // `isSafeInteger` は NaN / Infinity / 小数をまとめて落とす。
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) return null;
  return [kind, id, Math.round(x), Math.round(y)];
}

/**
 * `{"t":"cur", ..., "k":[色, 太さ, 連番, 点…]}` の `k` を取り出す。
 *
 * **これが「引いている最中の線」の全部。** `d`（運んでいる物）と同じ階層に
 * 項目を1つ足しただけで、**新しい種類の通は作っていない**（引いている間は
 * すでに `cur` が 10Hz で飛んでいる。仕様 2026-10-02-live-ink.md）。
 *
 * **DO は中身が何なのかを知らない。** 色が8色だとも、点が 0.1m 単位の差分だとも
 * 知らない（知ると盤面の形を知ることになる。`chg` に中身を載せないのと同じ理由）。
 * 見るのは形だけ:
 *   * 頭が3つ（小さな正の整数）
 *   * そのあとは整数の**組**（奇数個で終わっていたら壊れている）
 *   * 点の数と桁に緩い網（`MAX_INK_POINTS` / `MAX_INK_COORD`）
 *
 * 点が0個（`[色, 太さ, 連番]`）も通す。**「引いているが新しい点は無い」**の合図で、
 * 離してから保存が片付くまでのあいだ、相手の画面の線を消させないために要る。
 *
 * 壊れた値を `null` に倒すのは `parseCarry` と同じ作法。こちらを落としても
 * **カーソルそのものは通す**（`cursorEntry`）。
 */
export function parseInk(msg) {
  const k = msg?.k;
  if (!Array.isArray(k) || k.length < 3 || k.length % 2 !== 1) return null;
  if (k.length > 3 + MAX_INK_POINTS * 2) return null;
  for (let i = 0; i < 3; i += 1) {
    const v = k[i];
    if (!Number.isSafeInteger(v) || v <= 0 || v > INK_HEAD_MAX) return null;
  }
  for (let i = 3; i < k.length; i += 1) {
    const v = k[i];
    if (!Number.isSafeInteger(v) || Math.abs(v) > MAX_INK_COORD) return null;
  }
  // 素のまま返す（作り直さない。配るときは JSON にそのまま入る値だけが入っている）。
  return k;
}

/**
 * カーソルの表に入れる1行。`[x, y, 所有者の Discord ID]` か、
 * 運んでいるなら `[x, y, 所有者の Discord ID, [種別, id, x, y]]`、
 * 引いている最中なら5つ目に `[色, 太さ, 連番, 点…]`。
 *
 * **表の形を「伸ばす」だけで、別の表を作らない。** 別に持つと、切断や TTL で
 * カーソルを消すときに**もう一方を消し忘れる**経路ができる。
 * 運んでいる最中に相手のタブが落ちて物が動かされた位置のまま残ると、
 * **実際には動いていない盤面を全員が見ながら作戦を立てる**ことになり、
 * カーソルが残るより害が大きい（仕様の受け入れ条件4）。
 * 1行にまとめてあれば、`cursorSnapshot` の「生きている接続だけ」で両方同時に消える。
 *
 * `allowInk` が false なら `k` を見ずに落とす。**書き込めない人（ゲスト。D-072）を
 * 止める門で、判断はここ1箇所に置く。** 呼び出し側で `msg.k` を削る形にすると
 * 「書けるか」の判定が2箇所になり、片方だけ直し忘れる経路ができる。
 *
 * **カーソルと運んでいるものは通す。** ゲストに許してあるのは「見ることと、
 * どこを見ているかを伝えること」なので、そこは取り上げない。
 * 落とすのは `k` だけ——これが無いと、ログイン無しで誰でも**他人の盤面に
 * 線を描ける**（保存されないので、消す手段が相手のリロードしか無い形で効く）。
 */
export function cursorEntry(msg, ownerId, allowInk = true) {
  const point = parseCursor(msg);
  if (!point) return null;
  const carry = parseCarry(msg);
  const ink = allowInk ? parseInk(msg) : null;
  // **何も添えていなければ R1 と同じ3つ組のまま。** 位置だけを送っている
  // ふつうの通（圧倒的多数）の形を、機能を足すたびに太らせない。
  if (ink) return [point[0], point[1], ownerId, carry, ink];
  if (carry) return [point[0], point[1], ownerId, carry];
  return [point[0], point[1], ownerId];
}

/**
 * カーソルの表を、**今つながっている接続だけ**に絞った素のオブジェクトにする。
 *
 * キーは**接続の鍵**（`connKey`）で、値は `cursorEntry` が作る
 * `[x, y, 所有者の Discord ID]`（運んでいれば4つ目に `[種別, id, x, y]`）。
 * **名前と色は「人」のもの**なので、クライアントは所有者の ID で在室一覧を引く。
 * 名前と色をここに載せないのは、10Hz の通に1人あたり数十バイトを足すことになり、
 * かつ在室一覧（`who`）と二重の真実になるため。
 *
 * **これが幽霊カーソルの自己修復。** `webSocketClose` を取りこぼしても、
 * 生きている attachment に居ない鍵は配らないので画面には出ない。
 * 表の掃除は「やったほうが良いこと」であって「やらないと壊れること」ではない、
 * という状態に保つのが狙い（ハイバネーション越しに close が来ないことがある）。
 */
export function cursorSnapshot(cursors, liveKeys) {
  const out = {};
  for (const [key, point] of cursors) {
    if (!liveKeys.has(key)) continue;
    out[key] = point;
  }
  return out;
}

/**
 * 全員に配る1本の文字列。
 *
 * **送信者を含む全員に同じ文字列を1回だけ作って送る**（R0 の `buildWho` と同じ理由。
 * 受信者ごとに作ると 20人で 20回 stringify して CPU 10ms/呼び出しに当たる。調査 §5.8）。
 * 自分の分も入っているが、クライアントは**自分の接続の鍵**を知っている
 * （`buildYou` が接続時に1通だけ渡す）ので描画時に外す。
 */
export function buildCursors(cursors, liveKeys) {
  return JSON.stringify({ t: "curs", c: cursorSnapshot(cursors, liveKeys) });
}

// ── ティッカー（タイマーを1本も使わない）──────────────────────
//
// **`setInterval` / `storage.setAlarm()` / `setTimeout` のどれも使わない。**
//
// 禁止の理由は2つあって、**片方は課金、もう片方は壊れるから。**
//
//   課金 … `setInterval` と `setAlarm` はオブジェクトを起こし続ける。
//          調査 §2.4 の「タブ1枚で1日枠の83%」がこれ。実例では
//          Hibernation API を使っていたのに heartbeat / alarm のせいで
//          1ユーザー・約2時間で 13,000 GB-s を使い切っている。
//          100ms ごとのアラームは**1回ごとに課金リクエスト**でもある。
//
//   壊れる … **`setTimeout` は当てにならない。** ハイバネーション対応の
//          WebSocket しか持たない Durable Object は、メッセージの合間に
//          「処理中の要求が無い」状態になってメモリから落とされうる。
//          落ちた時点で保留中のタイマーは消える。ローカルの workerd で実測:
//          仕様書の擬似コードどおりに `setTimeout(tick, 100)` を張ると、
//          **4〜6回だけ発火してから永久に沈黙した**（「タイマーを張った」印が
//          立ったままになるので、以後カーソルが1本も流れなくなる）。
//          ループ全体を `state.waitUntil()` に預けても同じところで止まった。
//          静かなときは動いて、人数が増えると止まる、という最悪の形で出る。
//
// **代わりに、配信を受信で駆動する。** 誰かが動かしている間はメッセージが
// 絶え間なく届くので、タイマーが無くても 10Hz の配信になる。誰も動かさなく
// なればメッセージが止まり、**何も待っていない状態へ自然に戻る**
// （タイマーが残らないどころか、そもそも1本も作らない）。
//
// 代償は「最後の1通が窓に入らずに落ちると、最終位置が配られない」こと。
// これはクライアント側で埋める（cursors.js の `CURSOR_SETTLE_MS`。
// 動きが止まってから最終位置をもう一度だけ送る）。

/**
 * いま配ってよいか。**引き金は2つあって、どちらか一方で開く。**
 *
 * `force` … カーソルを消すとき。遅れると、盤面から出た人のカーソルが
 *           相手の画面に居座る。消すのはジェスチャの終わりに1回だけなので、
 *           窓を無視しても頻度は上がらない。
 *
 * `seen`  … 前回配ってから動いた人の集合。**同じ人から2回目が来たら「ひと回り」**
 *           とみなして配る。
 *
 * `now`   … 前回から `gap` 経っていれば配る。
 *
 * **なぜ時刻だけでは駄目か（実測）。** Worker の `Date.now()` は
 * **直前の I/O の時刻に貼り付いていて、I/O をするまで進まない。**
 * 配信を時刻だけで絞ると、
 *   配らない → I/O が無い → 時計が進まない → ずっと「まだ早い」
 * という自己強化のループに落ちる。ローカルで 18人×10Hz を流したとき、
 * **DO は毎秒 106〜149 通を受けているのに配信は毎秒1回**まで落ちた
 * （受け手の画面ではカーソルが 3秒 TTL で全部消えた）。
 *
 * `seen` のほうは時計に依存しないので、時計が止まっても「ひと回りで1回」の
 * ペースを保つ。人数 N が増えると自動的に N 通に1回になり、**1人あたりの
 * 送信頻度（10Hz）がそのまま配信頻度になる。** 人数で配信が増えない。
 *
 * 2つ合わせた結果:
 *   人が少ない（時計が健全）… 時刻の窓が先に開いて最大 12.5Hz
 *   人が多い（時計が止まる）… ひと回りで開いて約 10Hz
 */
export function dueToSend({ lastAt, now, senderId, seen, force = false, gap = BROADCAST_GAP_MS }) {
  if (force) return true;
  if (seen && senderId !== null && seen.has(senderId)) return true;
  return now - lastAt >= gap;
}

/**
 * 受信のレート。`times` は昇順のタイムスタンプ配列（この関数が返したものを渡す）。
 *
 * **無視しても枠は減る。** 受信は到達した時点で課金される（調査 §2.4）ので、
 * 暴走したクライアントを止める方法は **close することだけ**。
 * `over` が true になったら呼び出し側が `close(1008, ...)` する。
 *
 * 固定窓ではなく実際の時刻の列で数えているのは、固定窓だと境目をまたいで
 * 2倍（1秒に60通）通ってしまうため。配列は `RATE_MAX + 1` で頭打ちになる。
 */
export function rateHit(times, now, max = RATE_MAX, windowMs = RATE_WINDOW_MS) {
  const kept = [];
  for (const t of times) {
    if (now - t < windowMs) kept.push(t);
  }
  kept.push(now);
  // 超えた時点で呼び出し側が閉じるので、ここから先は伸びない。
  // それでも（close が間に合わなかったときのために）上限を切っておく。
  if (kept.length > max + 1) kept.splice(0, kept.length - (max + 1));
  return { times: kept, over: kept.length > max };
}
