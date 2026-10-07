// 共有カーソルの見せ方と、送信を間引く小道具。
//
// EN: Shared-cursor presentation, plus the helpers that throttle sending. This file
//     does not import dom.js, so the pure parts can be checked under vitest with no
//     browser at all. The wiring to the screen lives in board/cursor.js.
//
// **ここは dom.js を import しない**（placements.js / callouts.js と同じ作法）。
// `document` に触るのは関数の中だけなので、純粋な部分は workerd もブラウザも
// 立てずに vitest で確かめられる（tests/plan-cursors-view.test.js）。
// 画面との配線は board/cursor.js。
//
// 単位: このモジュールが受け取る座標は SVG ユーザー単位（= メートル、y だけ反転済み）。
// 変換は coords.js が持つ（ここでは呼ばない）。
//
// `ink.js` だけ import する。引いている最中の線を通に載せるのに**既にある
// 量子化と差分符号化**（サーバと共用）を使うためで、新しい符号化は作らない。
import { decodePoints, encodePoints } from "./ink.js";

import { avatarLoaded, memberAvatarUrl, whenAvatarReady } from "./avatar.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 送信の間隔（ms）。= 最大 10Hz。**在室10人までのときの値。**
 *
 * **課金はここで決まる。** 受信20通が1リクエスト（調査 §2.4）なので、
 * 枠を使うのはクライアントの送信頻度であって、サーバの配信頻度ではない。
 * DO 側の `BROADCAST_GAP_MS`（80ms）はこれより少し短くしてあり、
 * 10Hz の送信が間引かれないようにしてある。
 *
 * 人数が増えると下の `cursorSendMs` が間隔を広げる。
 */
export const CURSOR_SEND_MS = 100;

/**
 * **1秒あたりに部屋へ流し込んでよい通数の総量。**
 *
 * DO で枠を意味のある量で消費するのは**受信リクエスト 10万/日**だけで、
 * **受信20通が1リクエスト**（調査 §2.4）。配信（ファンアウト）は課金対象外。
 * つまり「部屋の全員が毎秒何通送るか」だけが課金を決める。
 *
 *   200通/秒 × 1,800秒（30分）÷ 20 = 18,000 リクエスト ＝ 1日枠の 18%
 *
 * **在室の上限を 20人から 50人へ上げても、この数を変えなければ消費は同じ。**
 * 素朴に 50人 × 10Hz にすると 500通/秒 ＝ 45% まで跳ねる。
 */
export const CURSOR_BUDGET_PER_SEC = 200;

/**
 * **上の枠のうち、本番で実際に流して確かめてある量。**
 *
 * 200通/秒 は長いあいだ**試算だけの数**だった。e2e の20接続も調査の数字も
 * 毎秒50通までで止まっていて（`e2e/plan-cursors.spec.js`）、設計上限そのものは
 * 一度も試験されていなかった。告知で「50人まで」と書く前に本番で流した。
 *
 * **実測 2026-10-04（本番。`tools/ws-fanout.mjs`）**
 *
 * | 流した量 | 受け手に届いた `curs` | 最大の空き | 往復の遅れ p50 / p95 |
 * | --- | --- | --- | --- |
 * | 50接続 × 4Hz ＝ 毎秒196通 | **12.00 回/秒**（30秒で360通） | 98ms | 22ms / 104ms |
 * | 13接続 × 4Hz ＝ 毎秒 48通 | 11.87 回/秒（30秒で356通） | 126ms | 35ms / 83ms |
 *
 * 30秒のあいだ**1秒も欠けずに毎秒12通**（`BROADCAST_GAP_MS` 80ms の上限 12.5Hz）。
 * 50本とも最後まで繋がったままで、毎秒50通のときと差が無い。**上限は出せている。**
 *
 * ── **ローカルでは止まる。それは本番の話ではない** ────────────────
 *
 * 同じ道具を `npm run dev` に向けると、**毎秒196通で配信が 0.63〜0.72 回/秒まで
 * 落ちて 20〜25秒の無音が出る**（再現する）。**これを本番の予兆と読まないこと。**
 * ローカルは `wrangler pages dev` ↔ `wrangler dev` の2プロセスをプロキシで
 * 繋いだ経路で、本番（Pages Functions → バインディング経由で DO）とは別物。
 *
 * 切り分けた結果、**効いているのは接続数ではなく DO への毎秒の受信通数**:
 *
 * | ローカル | 受信 | 受け手に届いた `curs` | 最大の空き |
 * | --- | --- | --- | --- |
 * | 50接続 × 1Hz |  49通/秒 | 11.33 回/秒 | 217ms |
 * | 13接続 × 4Hz |  48通/秒 | 10.87 回/秒 | 453ms |
 * | 13接続 × 8Hz |  96通/秒 | 11.90 回/秒 | 110ms |
 * | 13接続 ×12Hz | 144通/秒 | 12.45 回/秒 | **875ms** |
 * | 13接続 ×16Hz | 190通/秒 | **3.43 回/秒** | 21,076ms |
 * | 50接続 × 4Hz | 196通/秒 | **0.63 回/秒** | 25,622ms |
 *
 * 接続50本で毎秒49通なら平気、接続13本でも毎秒190通で崩れる。
 * **手元が律速でもない**（道具の CPU は30秒で 0.6秒、workerd は1コアの 16.5%）。
 * 崩れ方も、無音のあとに25通・64通とまとめて届く形で、**詰まって吐き出している**。
 *
 * ローカルだけ毎秒100通あたりで詰まる理由そのものは**未確認（推測）**。
 * 2プロセス間のプロキシが WebSocket をそこで律速しているのだろうと見ている。
 * **本番で測り直す以外に確かめる手は無い**ので、`npm run dev` で出た数を
 * 「50人では無理」の根拠に使わないこと。
 */
export const CURSOR_BUDGET_MEASURED_PER_SEC = 200;

/**
 * 在室の人数 → 1人あたりの送信頻度（Hz）。**人数 × 頻度 ≤ 200通/秒 を保つ表。**
 *
 * | 在室 | 送信頻度 | 合計 |
 * | --- | --- | --- |
 * | 〜10人 | 10Hz | 100通/秒 |
 * | 〜25人 |  6Hz | 150通/秒 |
 * | 〜50人 |  4Hz | 200通/秒 |
 *
 * **この表を触る人へ。** 頻度を上げると課金の試算（上の `CURSOR_BUDGET_PER_SEC`）が
 * そのまま崩れる。`tests/plan-cursor-budget.test.js` が 1人から上限まで全部の
 * 人数で不変条件を見ているので、上げると落ちる。**落ちたら枠を読み直すこと。**
 *
 * **段で決めるのは、人数が1人変わるたびに間隔が動くのを避けるため。**
 * 受け手の補間の長さも同じ式で決めるので（`board/cursor.js` が
 * `--cursor-tween` に入れる）、送り手と受け手が同じ在室数を見ている限り一致する。
 *
 * 数えるのは**在室の「人」の数**（`who` の members）で、接続の数ではない。
 * サーバの上限（`MAX_MEMBERS`）も人で数えているので、そちらと同じ単位にしてある
 * （1人が2枚開くとその人だけ倍になるが、上限の数え方と揃えるほうを採った）。
 */
export const CURSOR_RATE_TIERS = [
  { members: 10, hz: 10 },
  { members: 25, hz: 6 },
  { members: 50, hz: 4 },
];

/**
 * 在室 `members` 人のときの送信間隔（ms）。
 *
 * 表に無い人数（上限より多い）は**最後の段のまま**。「分からないので速くする」は
 * 課金の事故になるので、迷ったら遅いほうへ倒す。
 * 在室がまだ届いていない間（0 や未定義）は表の先頭＝いままでと同じ 10Hz。
 */
export function cursorSendMs(members) {
  const n = Number.isFinite(members) ? members : 0;
  const tier = CURSOR_RATE_TIERS.find((t) => n <= t.members) ?? CURSOR_RATE_TIERS.at(-1);
  return Math.round(1000 / tier.hz);
}

/**
 * 動きが止まってから、**最終位置をもう一度だけ**送るまでの時間（ms）。
 * 在室10人までのときの値で、`cursorSettleMs` が人数に応じて伸ばす。
 *
 * サーバはタイマーを持たない（配信を受信で駆動している。
 * workers/room/src/cursors.js のヘッダに理由）。そのぶん、最後の1通が
 * 配信の窓（80ms）に入らなかったときに最終位置が配られないことがある。
 * 相手の画面でカーソルが数十px 手前に止まって見えるので、**止まったあとに
 * 1通だけ送り直して確実に追いつかせる。**
 *
 * 1ジェスチャにつき1通なので、10Hz の流れに対して誤差
 * （調査 §2.4 の見積もりには影響しない）。
 */
export const CURSOR_SETTLE_MS = 250;

/**
 * 「止まったあとの1通」は**間引きの末尾の1通より後**に出なければ意味が無い。
 * そのための余白（ms）。
 *
 * 固定の 250ms のままにすると、在室50人（間隔 250ms）で2つが同じ瞬間に走り、
 * 同じ位置を2回送ることになる（1ジェスチャ1通の原則が崩れる）。
 */
const SETTLE_SLACK_MS = CURSOR_SETTLE_MS - CURSOR_SEND_MS;

/** 在室 `members` 人のときの「止まったあとの1通」までの待ち時間（ms）。 */
export const cursorSettleMs = (members) => cursorSendMs(members) + SETTLE_SLACK_MS;

/**
 * この時間だけ更新が無いカーソルは消す。
 *
 * **切断の取りこぼし対策。** DO は close で表から外して配り直すが、
 * ハイバネーションやネットワークの切れ方によっては close が届かない。
 * 受け取る側にも時限を置いて、もう居ない人のカーソルが居座らないようにする。
 */
export const CURSOR_TTL_MS = 3000;

/** 送る値。**整数**（1px が数メートルの縮尺で見ているので 1m 未満は誰にも見えない）。 */
export const roundPoint = (m) => [Math.round(m.x_m), Math.round(m.y_m)];

/** 前回と同じ地点か。同じなら送らない（静止中に 10Hz で同じ値を送らない）。 */
export const samePoint = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

/**
 * 間隔の読み方。**数でも関数でも受ける。**
 *
 * 関数を許すのは、送信間隔が在室の人数で変わる（`cursorSendMs`）ようになったため。
 * 作った時点の数を焼き付けると、人が増えても 10Hz で送り続けて枠を外れる。
 */
const gapOf = (ms) => (typeof ms === "function" ? ms() : ms);

/**
 * 先頭即時 ＋ 末尾保証のスロットル。
 *
 * **先頭を即時にする**のは、動かした瞬間に相手の画面へ出したいため
 * （100ms 待ってから出すと「反応が遅い」に見える）。
 * **末尾を保証する**のは、動かすのをやめた最後の位置を必ず配るため
 * （捨てると、相手の画面のカーソルが途中の位置で止まる）。
 *
 * 途中の値は捨てる。古い位置に意味は無い。
 *
 * `ms` は数でも「呼ぶたびに間隔を返す関数」でもよい（`gapOf`）。
 */
export function throttle(fn, ms) {
  let last = -Infinity;
  let timer = null;
  let pending = null;

  const run = (args) => {
    last = Date.now();
    pending = null;
    fn(...args);
  };

  const call = (...args) => {
    const wait = gapOf(ms) - (Date.now() - last);
    if (wait <= 0) {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      run(args);
      return;
    }
    pending = args;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending) run(pending);
    }, wait);
  };

  call.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return call;
}

/**
 * 「静かになってから1回だけ」。呼ばれるたびに待ち直し、最後の値で1回走る。
 *
 * `throttle` と役割が逆（あちらは流れを間引く、こちらは終わりを拾う）。
 * 2つ合わせて「動いている間は 10Hz、止まったら最終位置を1通」になる。
 *
 * `ms` は数でも関数でもよい（`throttle` と同じ理由）。
 */
export function settler(fn, ms) {
  let timer = null;
  const call = (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, gapOf(ms));
  };
  call.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return call;
}

/** 更新が途絶えた人の id。`seen` は id → 最後に見た時刻（ms）。 */
export function staleIds(seen, now, ttl = CURSOR_TTL_MS) {
  const out = [];
  for (const [id, at] of seen) {
    if (now - at >= ttl) out.push(id);
  }
  return out;
}

/**
 * サーバから来たカーソルの表から**自分のタブのぶんを外す**
 * （OS のポインタと二重になる）。
 *
 * サーバは送信者を含む全員に同じ文字列を配る（受信者ごとに作ると 20人で
 * 20回 stringify して CPU 10ms/呼び出しに当たる。調査 §5.8）ので、
 * 自分を外すのはクライアントの仕事。
 *
 * **外す鍵は「人」ではなく「接続」**（`meKey` は接続時にサーバが1通だけ渡す
 * `{"t":"you","k":...}` の値）。Discord ID で外していた頃は、同じ人が2枚
 * 開いているとカーソルが1本しか存在せず、**それを両方のタブが「自分のもの」
 * として消していた**（2026-10-02 のオーナー報告「ピンは出るのにカーソルは
 * 出ない」の正体）。2枚開いている人はポインタを2つ持っているので、
 * 相手のタブには出るのが正しい。
 *
 * **鍵は必ず文字列で比べる。** JSON のキーは文字列なので、呼び出し側が
 * 別の型で持っていると自分が外れずに二重に出る。
 */
export function othersOnly(cursors, meKey) {
  const me = String(meKey);
  return Object.entries(cursors ?? {}).filter(([key]) => key !== me);
}

// ── 運んでいる最中のもの（Phase R2a）──────────────────────────────
//
// **いまは置き終わってからしか相手に出ない。** 運んでいる途中を見せる。
// 新しい種類の通は作らず、ドラッグ中に既に 10Hz で飛んでいる `cur` に相乗りさせる
// （仕様 docs/superpowers/specs/2026-10-02-r2-live-drag.md）。
//
// 通の形: `{"t":"cur","x":…,"y":…,"d":["p",<id>,<物のx>,<物のy>]}`
// `d` は省略可で、付いていない ＝ 何も運んでいない。

/**
 * 盤面で掴める種類（`state.drag.kind`）→ 通に載せる1文字。
 *
 * **1文字にしてあるのは、後から線やエリアを足せるようにするため**（仕様の
 * 「やらないこと」）。ここに無い種類は送らない（勝手に1文字を作らない）。
 */
export const CARRY_KIND = { placement: "p", callout: "c" };

/**
 * いま送る `cur` に添える `d`。`state.drag` から決まる。
 *
 * `null` を返すのは「何も運んでいない」とき。**ここが null の間、飛ぶ通は
 * R1 とまったく同じ**（＝通数が増えていないことがこの関数1つで決まる）。
 *
 * 送らない場合が2つある:
 *   * **閾値を超えていない**（`moved` が false）… 押しただけ。選ぶたびに
 *     相手の画面の物が動き始めるのを避ける
 *   * **保存前（`id` が無い）** … 相手に指し示す番号がまだ無い。`uid` は
 *     手元だけの通し番号なので相手には通じない
 */
export function carryOf(drag) {
  if (!drag || drag.moved !== true) return null;
  const kind = CARRY_KIND[drag.kind];
  const id = drag.p?.id;
  if (!kind || !Number.isSafeInteger(id) || id <= 0) return null;
  return [kind, id, Math.round(drag.p.x_m), Math.round(drag.p.y_m)];
}

/**
 * 2つの `d` が同じか。同じなら送り直さない（`samePoint` と同じ役目）。
 *
 * **片方だけ null は「違う」。** 「運ぶのをやめた」を同値と見なすと、
 * 離した・中断したことが相手に届かず、**物が動かされた位置に残る。**
 */
export function sameCarry(a, b) {
  if (!a || !b) return !a && !b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * 配られたカーソル1本（`[x, y, 所有者, d?]`）から `d` を取り出す。
 *
 * DO も検査しているが（`parseCarry`）、**受け取る側でも形を見る。**
 * ここを通った値はそのまま盤面の物を動かすので、信じる前に確かめる。
 */
export function carryIn(point) {
  const d = Array.isArray(point) ? point[3] : null;
  if (!Array.isArray(d) || d.length !== 4) return null;
  const [kind, id, x, y] = d;
  if (typeof kind !== "string" || !Number.isSafeInteger(id)) return null;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [kind, id, x, y];
}

// ── 引いている最中の線（Phase R2b）────────────────────────────────
//
// **運んでいる最中（上の `carryOf`）と同じ形。** 引いている間はすでに `cur` が
// 10Hz で飛んでいるので、そこに `k` を相乗りさせる（仕様 2026-10-02-live-ink.md）。
//
// 通の形: `{"t":"cur","x":…,"y":…,"k":[色, 太さ, 連番, 前回の続きの点…]}`
// `k` は省略可で、**付いていない ＝ 何も引いていない。**
//
// **点は前回送ったところから先だけ**送る（毎回全部送ると、長い線の終わりでは
// 1通が上限を超える）。符号化は `ink.js` のものをそのまま使う——量子化 0.1m・
// 差分符号化はサーバと共用で既にあるので、**新しい符号化を作らない。**

/**
 * 1通に載せる `k` の大きさの枠（バイト）。
 *
 * **DO の上限（`MAX_MESSAGE_LEN` = 1024）から、`cur` の残りのぶんを引いた残り。**
 * 残りは、座標が桁いっぱい（±100,000）で**運びながら引いている**ときが最大で、
 * `{"t":"cur","x":…,"y":…,"d":["p",<id>,…,…],"k":[…]}` の `k` 以外が 90 バイト弱。
 * 余裕を見て 900 にしてある（`tests/plan-live-ink.test.js` が上限との関係を見張る）。
 *
 * **枠を広げるときは DO の上限も一緒に上げること。** 片方だけ動かすと、
 * クライアントは 1024 を超える通を組み、**DO はそれを黙って捨てる**
 * （画面には「線が途中で止まる」としか出ない）。
 */
export const INK_CHUNK_BUDGET = 900;

/** 連番の折り返し。小さく保つのは1通のバイト数のため（3桁で足りる）。 */
const INK_SERIAL_WRAP = 999;

/** 次の線の連番。1〜999 を回る。 */
export function nextInkSerial(prev) {
  return (Number.isSafeInteger(prev) && prev > 0 ? prev % INK_SERIAL_WRAP : 0) + 1;
}

/**
 * ペンの色の名前（`state.color` = "cursor-1"〜"cursor-8"）から番号へ。
 *
 * **通には番号だけ載せる。** 文字列をそのまま送ると1通に12バイト足すことになり、
 * そのぶん1通に入る点が減る（＝速く引いたときに間引きが早く効き始める）。
 *
 * **壊れた値でも必ず 1〜8 のどれかにする**（`cursorColor` と同じ作法）。
 * 色が決まらないことで線が出ないほうが困る。
 */
export function penColorIndex(name) {
  const m = /^cursor-([1-8])$/.exec(String(name ?? ""));
  return m ? Number(m[1]) : 1;
}

/** 歩幅 `stride` で間引く。**末尾は必ず残す**（線がペンの先に届かなくなる）。 */
function pickEvery(points, stride) {
  const out = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (points.length > 0 && out[out.length - 1] !== points[points.length - 1]) {
    out.push(points[points.length - 1]);
  }
  return out;
}

/**
 * いま送る `cur` に添える `k` を組む。
 *
 * `ink` は `{ color, width, serial, points }`。`points` は**まだ送っていない点**
 * （メートル）で、ここに渡したぶんは**すべて消費したものとして扱う。**
 *
 * **枠に入らないときは点を間引く。捨てずに次の通へ引き伸ばさない。**
 * 引き伸ばすと、速く引いている間ずっと「送り切れない点」が積み上がって
 * 通が太り続け、いずれ上限を超える。**確定した線は保存の経路から来る**ので、
 * 途中の見た目が少し粗くても最終形は狂わない（仕様の明示）。
 *
 * 戻り値の `kept` は実際に載せた点の数（間引きが効いたかを測るため）。
 */
export function inkChunk(ink, budget = INK_CHUNK_BUDGET) {
  const head = [ink.color, ink.width, ink.serial];
  const points = Array.isArray(ink.points) ? ink.points : [];
  let kept = points;
  let k = head.concat(encodePoints(kept));
  let size = JSON.stringify(k).length;
  let stride = 1;
  // 超過の割合から次の歩幅を見積もる（半分ずつ落とすと枠を大きく下回る）。
  // 見積もりが伸びないときは1つずつ強めるので、必ず有限回で止まる。
  while (size > budget && kept.length > 1) {
    const guess = Math.ceil(stride * (size / budget));
    stride = guess > stride ? guess : stride + 1;
    kept = pickEvery(points, stride);
    k = head.concat(encodePoints(kept));
    size = JSON.stringify(k).length;
  }
  return { k, kept: kept.length };
}

/**
 * 配られたカーソル1本（`[x, y, 所有者, d?, k?]`）から `k` を読む。
 *
 * DO も検査しているが（`parseInk`）、**受け取る側でも形を見る**（`carryIn` と
 * 同じ作法）。ここを通った値はそのまま盤面に線を引く。
 *
 * 色と太さは**こちらで枠に収める**（`var(--cursor-N)` と線の太さに直に入るので、
 * 範囲外だと見えない線や極太の線になる）。色は番号そのものに意味があるので
 * 枠の外なら 1 に倒し（`penColorIndex` と同じ既定）、太さは量なので端で止める。
 */
export function inkIn(point) {
  const k = Array.isArray(point) ? point[4] : null;
  if (!Array.isArray(k) || k.length < 3 || k.length % 2 !== 1) return null;
  for (const v of k) {
    if (typeof v !== "number" || !Number.isInteger(v)) return null;
  }
  const color = k[0] >= 1 && k[0] <= 8 ? k[0] : 1;
  const width = Math.min(3, Math.max(1, k[1]));
  return { color, width, serial: k[2], points: decodePoints(k.slice(3)) };
}

/**
 * 色の番号（0〜7）から CSS の値へ。
 *
 * **ペンの色と同じ番号**（D-047 の未決事項。サーバの `pickColor` が Discord ID から
 * 決定的に割り当てる）。在室一覧の粒（presence.js）と同じ式でなければ
 * 「一覧では青なのにカーソルは緑」になる。壊れた値でも必ず8色のどれかにする。
 */
export function cursorColor(n) {
  const i = Number.isInteger(n) ? ((n % 8) + 8) % 8 : 0;
  return `var(--cursor-${i + 1})`;
}

// 名前の左端。アイコンが出るぶんだけ右へずらす（出ていないときは今までどおり）。
const NAME_X = 13;
const NAME_X_WITH_AVATAR = 31;
// アイコンの輪。中心と半径（CSS px。カーソル全体と同じ逆スケールが掛かる）。
const AVATAR_CX = 21;
const AVATAR_CY = 10;
const AVATAR_R = 7;

/**
 * 1人ぶんのカーソル（矢印＋アイコン＋名前）を組み立てる。
 *
 * 形の座標は CSS px で書く。マーカー・地名・塔と同じで、board/cursor.js が
 * viewBox から逆算した倍率で `scale()` して打ち消す
 * （マップ座標で固定サイズにすると全体表示では点にもならない）。
 * **アイコンもこの `<g>` の中に置くので、ズームで大きさが変わらない**
 * （更新の経路を新設しない。D-068）。
 */
export function createCursor(member) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "cursor");
  g.dataset.cursorId = String(member.id);

  const arrow = document.createElementNS(SVG_NS, "path");
  // 左上を原点にした、ふつうのポインタの形。
  arrow.setAttribute("d", "M 0 0 L 0 14 L 3.6 10.6 L 6 16 L 8.4 15 L 6 9.8 L 11 9.8 Z");
  arrow.setAttribute("class", "cursor-arrow");
  g.appendChild(arrow);

  // 名前は常に出す。8色を超えると色相が重なる（D-047 の未決事項。R1 では
  // 塗り2種の16通りを実装しない）ので、重なっても誰かが分かる手段を残しておく。
  // **アイコンが出ても名前は消さない**（同じ理由）。
  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("class", "cursor-name");
  label.setAttribute("x", NAME_X);
  label.setAttribute("y", 15);
  label.textContent = member.name || "名前なし";
  g.appendChild(label);

  setCursorMember(g, member);
  return g;
}

/**
 * 名前・色・アイコンを当てる。
 *
 * **ここは 10Hz で呼ばれる**（board/cursor.js の `showCursors` が、配られた
 * スナップショット1通ごとに既存のカーソル全部へ当て直す）。だから
 * **アイコンは「変わったときだけ」作り直す**（`data-avatar` が控え）。
 * 毎回作り直すと、10Hz で `<image>` を捨てては作ることになる。
 */
export function setCursorMember(node, member) {
  const color = cursorColor(member.color);
  node.querySelector(".cursor-arrow")?.setAttribute("fill", color);
  const label = node.querySelector(".cursor-name");
  if (label) {
    label.setAttribute("fill", color);
    label.textContent = member.name || "名前なし";
  }
  setCursorAvatar(node, member, color);
}

/**
 * カーソルのラベルにアイコンを入れる。**出せなければ何もしない**（色の矢印と
 * 名前だけの、今までどおりの形）。
 *
 * **読めると分かってから `<image>` を置く**（`whenAvatarReady`）。SVG の
 * `<image>` は `error` が当てにできないので、404 の hash をそのまま入れると
 * 「輪の中身が空いたまま名前が右にずれた」状態で固まる。
 */
function setCursorAvatar(g, member, color) {
  const url = memberAvatarUrl(member);
  const want = url && avatarLoaded(url) ? url : "";
  // まだ読めるか分からない URL は、裏で1回試す。読めたらその場で描き直す
  // （カーソルが止まっていても出る。10Hz の次の通を当てにしない）。
  if (url && !want) whenAvatarReady(url, () => { if (g.isConnected) setCursorMember(g, member); });

  if (g.dataset.avatar === want) {
    // 中身は同じ。色だけは変わりうる（部屋の中で色がずれたとき）。
    g.querySelector(".cursor-ring")?.setAttribute("stroke", color);
    return;
  }
  g.dataset.avatar = want;
  g.querySelector(".cursor-avatar")?.remove();
  const label = g.querySelector(".cursor-name");
  if (!want) {
    label?.setAttribute("x", NAME_X);
    return;
  }

  const wrap = document.createElementNS(SVG_NS, "g");
  wrap.setAttribute("class", "cursor-avatar");

  const img = document.createElementNS(SVG_NS, "image");
  img.setAttribute("class", "cursor-avatar-img");
  img.setAttribute("x", AVATAR_CX - AVATAR_R);
  img.setAttribute("y", AVATAR_CY - AVATAR_R);
  img.setAttribute("width", AVATAR_R * 2);
  img.setAttribute("height", AVATAR_R * 2);
  // 正方形でない画像でも歪ませない（はみ出したぶんは丸で切られる）。
  img.setAttribute("preserveAspectRatio", "xMidYMid slice");
  img.setAttribute("href", want);
  wrap.appendChild(img);

  // **色の輪。** アイコンを輪で囲む形にして、ペンの色との結びつきを残す。
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("class", "cursor-ring");
  ring.setAttribute("cx", AVATAR_CX);
  ring.setAttribute("cy", AVATAR_CY);
  ring.setAttribute("r", AVATAR_R - 1);
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", color);
  wrap.appendChild(ring);

  g.appendChild(wrap);
  label?.setAttribute("x", NAME_X_WITH_AVATAR);
}

/**
 * 盤面のどこに、どの大きさで置くか。
 *
 * **マーカー・地名・塔・円と同じ作法**（`view.js` の `update*Scale` が渡す
 * `markerScale()` を逆スケールに使い、画面上の大きさを一定に保つ）。
 * ズーム時の更新経路を新設せず、既にある関数に相乗りする。
 */
export function setCursorTransform(node, at, scale) {
  node.setAttribute("transform", `translate(${at.x} ${at.y}) scale(${scale})`);
}
