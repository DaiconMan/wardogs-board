// 他の人が運んでいる最中のものを、**絵だけ**動かす（Phase R2a）。
//
// オーナーの要望「ピンとかものを運んでいる様子も同期してほしいです」。
// R1 までは置き終わってからしか相手に出ず（保存 → `chg` → 再取得）、VC で
// 「これ、ここに動かすわ」と言っている数秒が相手の画面では**何も起きていない時間**に
// なって、落とした瞬間に瞬間移動していた。
//
// **守っている決まりが3つある。**
//
//   1. **D1 には受け取った座標を書かない。** 置くのは `obj.carry` という
//      一時の項目だけで、保存された座標（`obj.x_m`）は触らない。確定値は従来どおり
//      「運んだ本人が保存 → `chg` → 全員が GET」で来る。**D1 が唯一の真実**を崩すと、
//      2人が同じ物を触ったときにどちらが正しいか決められなくなる
//   2. **手元の操作が勝つ。** 自分が掴んでいる物・自分が保存を待っている物は、
//      相手の通で動かさない。手元の操作が奪われるのが一番不快
//   3. **やめられたら戻す。** 中断・盤面から出た・**タブが落ちた**の3つすべて。
//      3つ目を忘れると、落ちた相手の物が動かされた位置のまま残り、
//      **実際には動いていない盤面を全員が見ながら作戦を立てる**ことになる
//      （カーソルが残るより害が大きい）。落ちたときの入口はカーソルの3秒 TTL で、
//      `board/cursor.js` の `removeCursor` が**カーソルを消すのと同じ処理**で
//      `board/live.js` の `dropLive` を呼ぶ
//
// キーは**接続の鍵**（人ではない。D-068）。同じ人が2枚開いていれば手は2つある。
//
// **寿命の管理そのものは `board/live.js` に預けてある。** 「一時的な見せ物で、
// D1 には何も書かず、カーソルが消えるのと同じ瞬間に消える」ものは
// 引いている最中の線（`board/liveink.js`）も同じなので、**表と片付けの道を
// 1本に揃えた。** ここに残っているのは「運んでいる物に固有のこと」
// （どの物か・縁取り・描き直し・手元が勝つ判断）だけ。

import { cursorColor } from "../cursors.js";
import { state } from "../state.js";
import { redrawCallout } from "./callout.js";
import { createLiveLayer } from "./live.js";
import { redrawPlacement } from "./place.js";

/**
 * 接続の鍵 -> `{ kind, obj }`。
 *
 * 預かり（取り直しの着地まで戻すのを待つぶん）の単位は**物そのもの**にする。
 * 同じ物を別の接続が運び直したときに、2回戻さないため。
 */
const layer = createLiveLayer({
  release: ({ kind, obj }) => release(kind, obj),
  detach: ({ kind, obj }) => outline(kind, obj, null),
  subject: ({ obj }) => obj,
});

const findObj = (kind, id) => {
  if (kind === "p") return state.placements.find((p) => p.id === id) ?? null;
  if (kind === "c") return state.callouts.find((c) => c.id === id) ?? null;
  // 知らない種別（将来の線・エリア）。**黙って無視する。**
  // DO は1文字の形しか見ていないので、新しい種別が先に流れてくることがある。
  return null;
};

const redraw = (kind, obj) => {
  if (kind === "p") redrawPlacement(obj);
  else if (kind === "c") redrawCallout(obj);
};

/** まだ盤面にあるか（運んでいる途中に消された物の絵を描き直さない）。 */
const onBoard = (kind, obj) =>
  kind === "p" ? state.placements.includes(obj) : state.callouts.includes(obj);

/**
 * 運んでいる人の色で縁取る（`null` で外す）。
 *
 * **名前は出さない。** 運んでいる人のカーソルがすぐ隣にあるので、色だけで
 * 「それ動かしてるの俺」が伝わる（仕様の「開けたままにしておくこと」）。
 */
function outline(kind, obj, color) {
  const node = kind === "p" ? obj.marker : obj.node;
  if (!node) return;
  if (color === null) {
    delete node.dataset.carry;
    node.style.removeProperty("--carry");
    return;
  }
  node.dataset.carry = "1";
  node.style.setProperty("--carry", cursorColor(color));
}

/** 自分が運んでいる（保存を待っている）ものか。手元の操作を奪われないため。 */
const isMine = (kind, id) => {
  const mine = state.carry;
  return !!mine && mine[0] === kind && mine[1] === id;
};

/**
 * 運ばれている物を、絵だけその位置へ動かす。動かせたら true。
 *
 * false を返すのは「相手の指示に従わない／従えない」とき（知らない物、
 * 自分が掴んでいる物、自分が保存を待っている物）。呼び出し側は true のものだけを
 * `retainCarries` に渡すので、false の鍵は持ち主として記録されない。
 */
export function holdCarry(key, d, color) {
  const [kind, id, x, y] = d;
  const obj = findObj(kind, id);
  if (!obj) return false;
  // **手元の操作が勝つ**（画面上だけ。確定はどちらにせよ保存した順）。
  if (state.drag?.p === obj || isMine(kind, id)) return false;
  // 同じ人が別の物に持ち替えた（離してすぐ掴んだ）。前の物を先に戻す。
  const prev = layer.get(key);
  if (prev && prev.obj !== obj) layer.drop(key);
  obj.carry = { x_m: x, y_m: y };
  // `set` が預かりからも外す（戻しかけていた物をもう一度運び始めた）。
  layer.set(key, { kind, obj });
  outline(kind, obj, color);
  redraw(kind, obj);
  return true;
}

/**
 * 自分が掴んだ。**手元の操作が勝つ**ので、相手の指示で動かしていた分は捨てる。
 *
 * 捨てないと、`redrawPlacement` が `p.carry ?? p` を見るので
 * **掴んだ物が自分のポインタから離れて相手の位置に吸い付く。**
 *
 * 次の `curs` が届けば `holdCarry` が「自分が掴んでいる物」として断るため、
 * 放っておいても 100ms ほどで直る。**それに頼らないのは、`p.carry` を読むのが
 * 手元のドラッグ（同期）で、消すのが通の到着（非同期）だから。**
 * 「掴んでいる間その物の `carry` は null」を手元だけで言い切れる形にしておく。
 *
 * **ここで保存済みの座標へ描き直す。** 掴んだだけで動かさずに離すこともあり
 * （押す＝選ぶ）、そのときは誰も描き直さないので、`carry` を消しただけだと
 * **絵が運ばれていた位置に取り残される。** 動かす場合はこの直後に
 * ポインタの位置へ描き直されるので、1回ぶんの重複は捨てて構わない。
 */
export function takeCarry(obj) {
  // 外すだけ（`detach`）。戻すのはこの下で、保存済みの座標へ1回だけやる。
  for (const key of layer.keys()) {
    if (layer.get(key)?.obj === obj) layer.detach(key);
  }
  // 戻すのを取り直しまで預けてあったぶんも、ここで打ち切る。
  layer.unwait(obj);
  if (!obj.carry) return;
  // どちらの列にいるかで種別が決まる（`held` から消したあとでも分かる）。
  release(state.placements.includes(obj) ? "p" : "c", obj);
}

/** 絵を保存済みの座標へ戻す。 */
function release(kind, obj) {
  obj.carry = null;
  // **消された物の絵を描き直さない**（射程リングを作り直して盤面へ戻してしまう）。
  if (onBoard(kind, obj)) redraw(kind, obj);
}

/**
 * `keys` に入っていない接続のぶんを戻す（配られた表に `d` が無くなった人）。
 *
 * **絵を戻すのを、取り直しが来るなら着地まで預ける**のは `live.js` の仕事。
 * 離した瞬間に保存済みの座標へ戻すと、保存された値が届くまでの数百ミリ秒だけ
 * **元の位置へ跳ね返ってから新しい位置へ飛ぶ**のが見える（`chg` → 300ms
 * デバウンス → GET で実測 400ms 前後）。跳ね返りは「動いていない」より悪い。
 *
 * 中断・切断・3秒 TTL（取り直しが来ない側）は `dropLive` から同じ道を通る。
 * **カーソルを消す処理がそのままここを呼ぶ**ので、取りこぼす経路が無い。
 */
export function retainCarries(keys) {
  layer.retain(keys);
}
