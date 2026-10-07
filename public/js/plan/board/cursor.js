// 共有カーソルの配線。送る側（自分のポインタ）と、描く側（他の人のカーソル）。
//
// EN: Shared-cursor wiring: the sending side (your own pointer) and the drawing side
//     (other people's cursors). Shapes and pure decisions live in ../cursors.js, which
//     vitest watches; this file only touches the DOM and the WebSocket. It is purely
//     additive -- with no connection it just does not send.
//
// 形と純粋な判断は ../cursors.js（vitest が見ている）。ここは DOM と WebSocket に
// 触るだけにしてある。
//
// **これは上乗せ。** `sendCursor` が無い（WebSocket が繋がっていない）ときは
// 送らないだけで、盤面の操作は何も変わらない。

import {
  CURSOR_TTL_MS, carryIn, createCursor, cursorSendMs, cursorSettleMs, inkChunk, inkIn,
  nextInkSerial, othersOnly, penColorIndex, roundPoint, sameCarry, samePoint, setCursorMember,
  setCursorTransform, settler, staleIds, throttle,
} from "../cursors.js";
import { board, cursorLayer } from "../dom.js";
import { state } from "../state.js";
import { holdCarry, retainCarries } from "./carry.js";
import { clearLive, dropLive } from "./live.js";
import { holdInk, retainInks } from "./liveink.js";
import { markerScale, pointerToMeters } from "./view.js";

// 送り先。presence.js の sendCursor。繋がっていない間は null。
let sink = null;
// 最後に送った整数の地点。同じ値を 10Hz で送らないための控え。
let lastSent = null;
// いま部屋に何人居るか（在室一覧の「人」の数）。**送信頻度をこれで決める。**
// 在室が1通も届いていない間は 0 ＝ 表の先頭（10Hz）。
let peers = 0;

// 画面に出ている他のタブのカーソル。**接続の鍵** -> <g>
// （人ではなく接続。同じ人が2枚開いていればここに2本入る）
const nodes = new Map();
// 接続の鍵 -> 最後に位置が来た時刻（ms）。3秒更新が無ければ消す。
const seen = new Map();
let sweepTimer = null;

// いま自分が引いている線。`null` ＝ 引いていない（＝ `k` を添えない）。
// `points` は**まだ送っていない点**（送るたびに空にする。下の `takeInk`）。
let ink = null;
// 線ごとの連番。1〜999 を回る（`nextInkSerial`）。**同じ線のあいだ変えない。**
let inkSerial = 0;

/**
 * 実際に送る1本。間引きは throttle が持つ。
 *
 * **運んでいるものと引いている線は「いま送る瞬間」に読む**（引数で持ち回らない）。
 * 間引きや末尾の1通は時間が経ってから走るので、引数に焼き付けると
 * **離したあとの通に「まだ運んでいる」「まだ引いている」が乗る。**
 * ここで読めば、走った時点の状態がそのまま乗る。
 */
const push = (point) => {
  if (!sink) return;
  sink(point, point ? state.carry : null, point ? takeInk() : null);
};

/**
 * いま送る `cur` に添える `k` を組む。**呼ぶたびに、積んでいた点を消費する。**
 *
 * **枠に入らないぶんは捨てる**（`inkChunk` が間引く）。次の通へ引き伸ばすと、
 * 速く引いている間ずっと「送り切れない点」が積み上がって通が太り続け、
 * いずれ DO の上限（1024）を超える。**超えた通は黙って捨てられる**ので、
 * 画面には「線が途中で止まる」としか出ない。
 * **確定した線は保存の経路から来る**ので、途中の見た目が粗くても最終形は狂わない。
 *
 * 点が0個（`[色, 太さ, 連番]`）でも添える。**「引いているが新しい点は無い」**の
 * 合図で、離してから保存が片付くまでのあいだ、相手の画面の線を消させないために要る。
 */
function takeInk() {
  if (!ink) return null;
  const { k } = inkChunk(ink);
  ink.points.length = 0;
  return k;
}

// **先頭即時 + 末尾保証のスロットル。** 間隔は在室の人数で決まる
// （`cursorSendMs`。〜10人 100ms / 〜25人 167ms / 〜50人 250ms）。
//
// **数ではなく関数を渡す。** 作った時点の間隔を焼き付けると、人が増えても
// 10Hz のまま送り続けて課金の枠（人数 × 頻度 ≤ 200通/秒）を外れる。
// 20人 × 10Hz と 50人 × 4Hz は同じ 200通/秒 ＝ 30分で1日枠の18%
// （tests/plan-cursor-budget.test.js が1人から上限まで全部見ている）。
const pushThrottled = throttle(push, () => cursorSendMs(peers));

// **止まったあとの1通。** サーバはタイマーを持たないので、最後の1通が
// 配信の窓に入らないと最終位置が配られない（../cursors.js の CURSOR_SETTLE_MS）。
//
// **運んでいる間・引いている間は出さない。** どちらのジェスチャも必ず
// 「もう運んでいない」「もう引いていない」の1通で終わる（`sendCarry(null)` と
// `endInk()` がこの settler を張り直す）ので、**その1通が末尾の役目を兼ねる。**
// こうすると、ジェスチャの末尾はどの操作でも1通に揃う:
//
//   ただ振る … 10Hz の流れ ＋ 止まったあとの1通
//   運ぶ     … 10Hz の流れ ＋ 運ぶのをやめた1通
//   引く     … 10Hz の流れ ＋ 引くのをやめた1通
//
// **この1行が効くのは、保存が 250ms より長くかかったときだけ。** 離してから
// 保存が片付くまで `d` / `k` を付けたままにしてあるので（board/pointer.js の
// `endDrag` と board/tools.js の `finishStroke`）、保存が遅いと「付きの末尾」と
// 「消す末尾」の2通になる。ローカルは保存が 250ms 以内に終わるため、この1行を
// 外しても 13通のまま（実測。本番は往復が長いので、無いと 14通になりうる）。
//
// 運んでいる・引いている最中の最終位置そのものは落ちても困らない——確定した
// 座標と線は D1 から来るし、`d` / `k` を消す1通が最新のカーソル位置も一緒に運ぶ。
const pushSettled = settler((point) => {
  if (state.carry || ink) return;
  push(point);
}, () => cursorSettleMs(peers));

function sendPoint(point) {
  // **「消して」を連打しない。** 盤面の外（棚のボタンの上など）を横切る間、
  // pointermove は 60Hz で飛んでくる。そのたびに送ると
  //   * 受信は到達した時点で課金される（毎秒60通＝枠の無駄）
  //   * **DO のレート制限（毎秒30通）に自分で引っかかって切断される**
  // 既に消してあるなら何もしない。
  if (point === null && lastSent === null) return;
  lastSent = point;
  if (point === null) {
    // 盤面から出た・隠れた。**間引きの途中の1回を捨ててから**即座に送る
    // （捨てないと、消したあとに古い位置が1回届いてカーソルが生き返る）。
    pushThrottled.cancel();
    pushSettled.cancel();
    push(null);
    return;
  }
  pushThrottled(point);
  pushSettled(point);
}

export function setCursorSink(fn) {
  sink = fn;
}

/**
 * 在室の人数が変わった（`{"t":"who"}` が届いた）。
 *
 * **ここが「50人まで入れても課金の総量が変わらない」の全部。**
 * 送信頻度（`cursorSendMs`）を人数で下げて、人数 × 頻度 ≤ 200通/秒 を保つ。
 * サーバには何も足していない（配信は課金対象外なので、段を決められるのは
 * 在室一覧で人数を知っているクライアントだけ）。
 *
 * **同時に、見た目の補間の長さも合わせる。** カーソルの滑らかさは CSS の
 * `transition` に任せてある（JS で補間すると 50人 × 60fps の rAF になる）。
 * 100ms 固定のままで送信が 250ms 間隔になると、**遷移が先に終わって
 * 残り 150ms はカーソルが止まる**——つまりカクつく。送信間隔と同じ長さにすれば、
 * 次の位置が届くころにちょうど補間が終わる。
 *
 * 受け手も送り手も**同じ在室数・同じ式**で計算するので、値は自然に一致する
 * （部屋の中で誰かだけ違う段にいることが無い）。
 */
export function setCursorPeers(count) {
  const n = Number.isFinite(count) ? count : 0;
  if (n === peers) return;
  peers = n;
  // 運ばれている物（`[data-carry]`）も同じ通に乗って来るので、同じ長さを使う。
  document.documentElement.style.setProperty("--cursor-tween", `${cursorSendMs(peers)}ms`);
}

/**
 * いま自分が運んでいるものを差し替える（`null` で「もう運んでいない」）。
 * 呼ぶのは board/pointer.js のドラッグ1箇所だけ。
 *
 * **ここで新しい通を作らない。** ドラッグ中はカーソルが 10Hz で飛んでいて、
 * その通に `state.carry` が自動で乗る（上の `push`）ので、**値を置くだけで届く。**
 *
 * 置くだけで足りないのは「離した・やめた」の瞬間だけ。カーソルが止まっていると
 * 次の通が無く、**物が動かされた位置に残る。** そこで**止まったあとの1通**
 * （`pushSettled`。R1 から既にある、1ジェスチャに1通のもの）を張り直す。
 * 運んでいる間その1通は出さないので（上の `pushSettled`）、**ジェスチャの末尾は
 * どちらの操作でも1通**になる（実測: ただ振る 13通 / 運びながら 13通）。
 */
export function sendCarry(carry) {
  if (sameCarry(carry, state.carry)) return;
  state.carry = carry;
  if (lastSent) pushSettled(lastSent);
}

/**
 * 線を引き始めた。呼ぶのは board/tools.js の `beginStroke` 1箇所だけ。
 *
 * **ここでも新しい通を作らない**（`sendCarry` と同じ）。引いている間はカーソルが
 * 10Hz で飛んでいて、その通に積んだ点が自動で乗る（上の `push` と `takeInk`）。
 *
 * **連番を1つ進める。** 離してすぐ次を引くと、「引き終わった」の1通が出る前に
 * 次の `k` が飛ぶので、連番が無いと**受け手が2本目を1本目のパスに繋げる**
 * （盤面を斜めに横切る線が1本生える）。
 *
 * `colorName` は `state.color`（"cursor-1"〜"cursor-8"）。通には番号だけ載せる
 * ——文字列をそのまま送ると1通に12バイト足すことになり、そのぶん1通に入る
 * 点が減る（＝速く引いたときに間引きが早く効き始める）。
 */
export function beginInk(colorName, width) {
  inkSerial = nextInkSerial(inkSerial);
  ink = { color: penColorIndex(colorName), width, serial: inkSerial, points: [] };
}

/**
 * 線が1点ぶん伸びた。`point` はマップのメートル座標（`{ x_m, y_m }`）。
 *
 * **送り先が無ければ積まない。** WebSocket が繋がらない環境では誰も受け取らず、
 * 積んだ点は一度も出ていかない（長い線のあいだ無駄に伸び続けるだけになる）。
 */
export function extendInk(point) {
  if (!ink || !sink) return;
  ink.points.push(point);
}

/**
 * 線を引くのをやめた（引き終わった・中断した）。
 *
 * **呼ぶのは保存が片付いたあと**（board/tools.js の `finishStroke` の `finally`）。
 * 離した瞬間に `k` を落とすと、受け手は「引き終わった」と読むが、`chg` はまだ
 * 届いていないので**取り直しが来ると分からず、その場で線を消す**
 * ——確定した線が届くまでの数百ミリ秒「一瞬消える」が見える（D-069 と同じ罠）。
 * 保存が済んでから落とせば、`chg` が先に届いているので預けてもらえる。
 *
 * 中断（2本目の指・保存が断られた）はその場で呼ぶ。取り直しは来ないので、
 * 受け手は即座に消す——これが正しい（失敗した線が相手の画面に残らない）。
 *
 * 置くだけで足りないのは「やめた」の瞬間だけ。ポインタが止まっていると次の通が
 * 無く、**引かれていない線が相手の画面に残る。** そこで**止まったあとの1通**
 * （R1 から既にある、1ジェスチャに1通のもの）を張り直す。
 */
export function endInk() {
  if (!ink) return;
  ink = null;
  if (lastSent) pushSettled(lastSent);
}

/**
 * 自分のポインタを送る配線。
 *
 * **`document.hidden` の間は送らない**（調査 §5.5）。タブを裏に回した人のぶんで
 * 枠を食わないため。盤面から出たときも1回だけ「消して」を送る。
 */
export function wireCursorSend() {
  if (!board) return;

  board.addEventListener("pointermove", (evt) => {
    if (!state.coords || document.hidden) return;
    const point = roundPoint(pointerToMeters(evt));
    // **同じ整数なら送らない。** 静止しているときに 10Hz で同じ値を送らない
    // （枠の節約。調査 §2.4 の「VC で話している時間のほうが長い」ぶん）。
    if (samePoint(point, lastSent)) return;
    sendPoint(point);
  }, { passive: true });

  // **盤面を離れた判定は `board` の pointerleave だけでは足りない。**
  // `#board` はビューポート全面（実測で 0,0,1280,720）で、ヘッダもフッタも
  // 板もその**上に浮いている**。棚のボタンへ指を移しても盤面からは
  // 「出て」いないので、pointerleave が来ないことがある（実測: マウスを
  // ヘッダへ動かしても消えず、3秒 TTL の掃除を2周待って 6.3 秒かかった）。
  //
  // なので document で拾い、**盤面の外の要素の上に来たら消す。** 盤面の上に
  // いるときは board 側の handler が既に送っているので、ここは素通りする。
  document.addEventListener("pointermove", (evt) => {
    if (evt.target instanceof Node && board.contains(evt.target)) return;
    sendPoint(null);
  }, { passive: true, capture: true });

  // 窓の外・別のアプリへ出た。
  document.addEventListener("pointerleave", () => sendPoint(null), { passive: true });
  board.addEventListener("pointercancel", () => sendPoint(null), { passive: true });

  // 裏に回ったら消す。戻ってきたときは次の pointermove が出し直す。
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) sendPoint(null);
  });

  // ページを離れるとき。残すと相手の画面に3秒ぶん居座る。
  addEventListener("pagehide", () => sendPoint(null));
}

/** もう描かない。ページを離れるとき。 */
export function stopCursors() {
  pushThrottled.cancel();
  pushSettled.cancel();
  sink = null;
  peers = 0;
  state.carry = null;
  ink = null;
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  sweepTimer = null;
  clearCursors();
  clearLive();
}

/**
 * カーソル1本を消す。**その人が見せていた一時的なものも、ここで全部片付く。**
 * （運んでいた物の位置／引いている最中の線。`board/live.js` の `dropLive`）
 *
 * 入口は2つあって、どちらも「もう居ない」:
 *   * 配られた表にその鍵が無かった（盤面から出た・切れた）
 *   * 3秒 TTL（`armSweep`。**タブが落ちて close が届かなかったとき**）
 *
 * **2つ目を取りこぼさないために、わざと同じ関数にしてある。**
 * 別経路にすると、落ちた相手の物が動かされた位置のまま残り、
 * **実際には動いていない盤面を全員が見ながら作戦を立てる**ことになる
 * （仕様の受け入れ条件4。カーソルが残るより害が大きい）。
 * 線も同じで、**引いている途中で落ちた人の線が残り続ける。**
 */
function removeCursor(id) {
  nodes.get(id)?.remove();
  nodes.delete(id);
  seen.delete(id);
  dropLive(id);
}

function clearCursors() {
  for (const id of [...nodes.keys()]) removeCursor(id);
}

/**
 * 更新が途絶えたカーソルを掃除する。
 *
 * **タイマーは「画面にカーソルが出ている間だけ」張る。** 誰も居ない部屋で
 * 動き続ける時計を作らない、という作法は DO 側と同じ。
 * ここはブラウザなので課金には関係しない（DO 側は関係する。
 * あちらはタイマーそのものを1本も作らない。workers/room/src/cursors.js）。
 */
function armSweep() {
  if (sweepTimer !== null || nodes.size === 0) return;
  // **TTL そのものの間隔で見に行かない。** 掃除の直後に更新が途絶えると
  // 「次の掃除では TTL に 1ms 足りない」→ もう1周、で**最大 2×TTL** かかる
  // （実測で 6.3 秒）。3分の1の刻みで見れば、遅れは TTL + 1秒に収まる。
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    for (const id of staleIds(seen, Date.now())) removeCursor(id);
    armSweep();
  }, Math.round(CURSOR_TTL_MS / 3));
}

/**
 * サーバから来たスナップショットを画面に当てる。
 *
 * `cursors` は `{ 接続の鍵: [x, y, 所有者の Discord ID] }` で、**全接続ぶん**
 * （自分のタブも入っている）。名前と色は**人**のものなので、所有者の Discord ID で
 * 在室一覧（`members`）を引く。まだ在室が届いていない人は色 0 の「名前なし」で
 * 出す（位置が分かることのほうが大事なので、名前が揃うまで消さない）。
 *
 * 運んでいる人の値には4つ目（`[種別, id, 物のx, 物のy]`）、引いている人の値には
 * 5つ目（`[色, 太さ, 連番, 点…]`）が付いている。
 * **カーソルと同じ通・同じ表に乗せてある**ので、消えるときも一緒に消える
 * （board/carry.js / board/liveink.js。これが「運んでいる最中・引いている最中に
 * 落ちた人のものが残らない」の土台）。
 *
 * `myKey` は自分の接続の鍵（presence.js の `state.myKey`）。
 * **届く前は1本も描かない。** 鍵を知らないまま描くと、自分のカーソルが
 * 自分の画面に出て OS のポインタと二重になる。鍵は接続直後の `{"t":"who"}` の
 * 返事に付いてくるので、待つのは最初の1〜2通ぶん（誰かが動かし続けていれば
 * 100ms 後の次の通で追いつく）。
 */
export function showCursors(cursors, members = [], myKey = null) {
  if (!cursorLayer || !state.coords || !myKey) return;
  const now = Date.now();
  const roster = new Map(members.map((m) => [String(m.id), m]));
  // この1通で「運んでいる」「引いている」と分かった接続。
  // 入っていない鍵のぶんは片付ける。
  const carrying = new Set();
  const drawing = new Set();

  for (const [key, point] of othersOnly(cursors, myKey)) {
    const owner = String(point[2] ?? "");
    const member = roster.get(owner) ?? { id: owner, name: "", color: 0 };
    seen.set(key, now);
    // **運んでいる最中のものを、絵だけ動かす**（board/carry.js）。
    // カーソルと同じ通・同じ表に乗っているので、消えるときも一緒に消える。
    const d = carryIn(point);
    if (d && holdCarry(key, d, member.color)) carrying.add(key);
    // **引いている最中の線を、絵だけ出す**（board/liveink.js）。同じ通・同じ表。
    // 色は `k` が運んできた番号（引いた人のペンの色そのもの）を使う。
    const k = inkIn(point);
    if (k && holdInk(key, k)) drawing.add(key);
    let node = nodes.get(key);
    if (!node) {
      node = createCursor(member);
      cursorLayer.appendChild(node);
      nodes.set(key, node);
    } else {
      setCursorMember(node, member);
    }
    setCursorTransform(
      node,
      state.coords.toSvg({ x_m: point[0], y_m: point[1] }),
      markerScale()
    );
  }

  // 運ぶのをやめた人のぶんを戻す（カーソルは出たままで `d` だけ消えた状態。
  // ドラッグの中断・マップの外で離した・保存が片付いた、のどれか）。
  retainCarries(carrying);
  // 引くのをやめた人のぶんを片付ける（`k` だけ消えた状態。引き終わって保存が
  // 片付いた・中断した、のどちらか）。取り直しが来るなら着地まで預ける。
  retainInks(drawing);

  // **スナップショットは全接続ぶん**なので、入っていない鍵はその場で消す
  // （盤面から出た人・切れた人。3秒 TTL を待たずに消える）。
  for (const key of [...nodes.keys()]) {
    if (!Object.hasOwn(cursors ?? {}, key)) removeCursor(key);
  }
  armSweep();
}

/**
 * ズーム・リサイズのあと、カーソルの見た目の大きさを一定に戻す。
 *
 * **マーカー・地名・塔・円と同じ経路に相乗りする**（`view.js` の `applyView`）。
 * ズーム時の更新経路を新設しない。位置そのものはマップ座標に置いてあるので、
 * パンとズームには自動で追従する。
 */
export function updateCursorScale() {
  if (nodes.size === 0 || !state.coords) return;
  const scale = markerScale();
  for (const node of nodes.values()) {
    // transform から translate を読み直さずに済むよう、scale だけ差し替える。
    const t = node.getAttribute("transform") ?? "";
    const at = t.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
    if (!at) continue;
    setCursorTransform(node, { x: Number(at[1]), y: Number(at[2]) }, scale);
  }
}
