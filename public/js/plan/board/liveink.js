// 他の人が**引いている最中**の線を、絵だけ出す（Phase R2b）。
//
// オーナーの要望「線のライブ描画は未実装なんですか？実装してください」。
// R1 までは引き終わって保存されてからしか相手に出ず（保存 → `chg` → 再取得）、
// VC で線を引きながら説明している間が相手の画面では**何も起きていない数秒**に
// なっていた。
//
// **D-069（運んでいる最中）でやったことを、線でもやる。** 新しい仕組みは作らない:
//
//   1. **`cur` に相乗りして通数を1通も増やさない**（引いている間はすでに
//      カーソルが 10Hz で飛んでいる。載せるのは `board/cursor.js`）
//   2. **D1 には何も書かない。** 確定した線は従来どおり
//      「引いた本人が保存 → `chg` → 全員が GET」で来る（**D1 が唯一の真実**）
//   3. **カーソルが消えるのと同じ瞬間に消える**（`board/live.js` の `dropLive`）。
//      ここを別経路にすると、**引いている途中で落ちた人の線が残り続ける。**
//      しかも保存されていないので、見ている側には消す手段が無い
//
// キーは**接続の鍵**（人ではない。D-068）。同じ人が2枚開いていれば手は2つある。

import { liveInkLayer } from "../dom.js";
import { toSmoothPath } from "../ink.js";
import { createStrokePath } from "../render.js";
import { state } from "../state.js";
import { createLiveLayer } from "./live.js";

/**
 * 接続の鍵 -> `{ serial, color, width, points, path }`。
 *
 * **預かりの単位は「その線」そのもの**（既定の `subject`）。離してすぐ次を
 * 引かれると、1本目の片付けを取り直しの着地まで預けたまま2本目が始まるので、
 * 2本が同時に預かりに入れる形でなければならない。
 */
const layer = createLiveLayer({ release: (ink) => ink.path.remove() });

/**
 * 引いている最中の線を伸ばす。出せたら true。
 *
 * `ink` は `cursors.js` の `inkIn` が通した `{ color, width, serial, points }`。
 * `points` は**前回の続きの点だけ**（毎回全部は来ない）。
 *
 * **連番（`serial`）が変わったら、繋げずに別の線として始める。**
 * 離してすぐ次を引くと、「引き終わった」の1通が出る前に次の `k` が飛ぶので、
 * 連番を見ないと**2本目が1本目のパスに繋がる**（盤面を斜めに横切る線が1本生える）。
 *
 * **色は `k` が運んできた番号を使う**（在室一覧の色ではなく）。引いた人の
 * ペンの色そのものなので、確定した線と同じ色で出る（D-047 の
 * 「ペン＝カーソル＝在室の粒＝引いた線」）。
 */
export function holdInk(key, ink) {
  if (!liveInkLayer || !state.coords) return false;
  const prev = layer.get(key);
  if (prev && prev.serial !== ink.serial) layer.drop(key);

  let item = layer.get(key);
  if (!item) {
    const path = createStrokePath({ color: `cursor-${ink.color}`, width: ink.width });
    // **確定した線と見分けがつく状態にする**（仕様の明示）。見た目は CSS。
    path.dataset.live = "1";
    liveInkLayer.appendChild(path);
    item = { serial: ink.serial, points: [], path };
  }
  if (ink.points.length > 0) {
    item.points.push(...ink.points);
    // **確定した線と同じ描き方**（`renderStroke` と同じ `toSmoothPath`）。
    // 違う描き方にすると、確定した瞬間に線の形がわずかに変わって見える。
    item.path.setAttribute("d", toSmoothPath(item.points.map((p) => state.coords.toSvg(p))));
  }
  // `set` が預かりからも外す（片付けかけていた線を続けた）。
  layer.set(key, item);
  return true;
}

/**
 * `keys` に入っていない接続のぶんを片付ける（配られた表から `k` が消えた人）。
 *
 * **片付けを、取り直しが来るなら着地まで預ける**のは `live.js` の仕事。
 * 引き終わった瞬間に消すと、確定した線が再取得で届くまでの数百ミリ秒
 * （`chg` → 300ms デバウンス → GET で実測 400ms 前後）**一瞬消えてから
 * 本物が出る**のが見える。「動いていない」より悪い（D-069）。
 *
 * 取り直しが来ないとき（中断・保存が断られた・切断）はその場で消す。
 * 中断と切断は `dropLive` から同じ道を通る——**カーソルを消す処理が
 * そのままここを呼ぶ**ので、取りこぼす経路が無い。
 */
export function retainInks(keys) {
  layer.retain(keys);
}
