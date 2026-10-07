// 「いまやっている最中」を相手の画面に見せているものの、**寿命だけ**をまとめる。
//
// いま乗っているのは2つ:
//   運んでいる最中の物 … board/carry.js（Phase R2a。D-069）
//   引いている最中の線 … board/liveink.js（Phase R2b）
//
// **後始末の経路を2本にしない。** これがこのファイルの存在理由。
// どちらも「接続の鍵に紐づく一時的な見せ物で、D1 には何も書かず、
// カーソルが消えるのと同じ瞬間に消える」ものなので、**表も片付けの道も1本**にする。
// 種類ごとに別の表と別の片付けを持つと、
//   * カーソルの3秒 TTL で片方だけ消し忘れる
//   * 描いている途中で落ちた人の線が残り続ける
// が必ず起きる（カーソルが残るより害が大きい。実際には動いていない盤面・
// 引かれていない線を全員が見ながら作戦を立てることになる）。
//
// **消す入口は3つ。すべてここを通る。**
//   `dropLive`   … その接続がもう居ない／やめた（board/cursor.js の `removeCursor`）
//   `settleLive` … 取り直しが着地した（board/reload.js）
//   `clearLive`  … ページを離れる（board/cursor.js の `stopCursors`）
//
// **「取り直しの着地まで預ける」が D-069 の肝。** 引き終わった・置き終わった瞬間に
// 一時的な見せ物を消すと、確定した値が再取得で届くまでの数百ミリ秒（実測 400ms 前後）
// **何も無い状態**が見える。運んでいる物なら「元の位置へ跳ね返ってから新しい位置へ飛ぶ」、
// 引いている線なら「一瞬消えてから本物が出る」。どちらも「動いていない」より悪い。
// 取り直しが来ないとき（中断・断られた・切断）は、その場で片付ける。

// 乗っている層。`dropLive` などはここを一巡する。
const layers = new Set();

// 「これから取り直しが来るか」。app.js が changes.pending() を繋ぐ。
// 繋がっていなければ常に false ＝ その場で片付ける（繋ぎ忘れても残骸は残らない側に倒す）。
let reloadComing = () => false;

/** `changes.pending()` を繋ぐ。**層ごとではなく1回だけ。** */
export function setLiveReloadPending(fn) {
  reloadComing = typeof fn === "function" ? fn : () => false;
}

/**
 * 1つの層を作る。
 *
 * @param release 片付ける（絵を元に戻す／線を消す）。**取り直しが来るなら着地まで待つ**
 * @param detach  表から外した瞬間にやること（運んでいる印を外す等）。**必ず即座に走る**
 * @param subject 預かりの表のキー。同じ対象を2回預からないためのもの
 *                （運んでいる物は「物」そのもの。既定は見せ物自身）
 */
export function createLiveLayer({ release, detach = () => {}, subject = (item) => item }) {
  // 接続の鍵 -> その接続が見せているもの。**鍵は人ではなく接続**（D-068。
  // 同じ人が2枚開いていれば手は2つある）。
  const held = new Map();
  // 片付けを取り直しの着地まで預けてあるもの（subject -> 見せ物）。
  const waiting = new Map();

  const layer = {
    get: (key) => held.get(key) ?? null,
    keys: () => [...held.keys()],

    /** 見せ始める／更新する。預かりから外す（片付けかけていたものを続けた）。 */
    set(key, item) {
      held.set(key, item);
      waiting.delete(subject(item));
    },

    /** 預かりを打ち切る（手元の操作が勝ったとき等）。 */
    unwait(subj) {
      waiting.delete(subj);
    },

    /** 表から外すだけ。**片付けはしない**（手元で引き継ぐとき）。 */
    detach(key) {
      const item = held.get(key);
      if (item === undefined) return null;
      held.delete(key);
      detach(item);
      return item;
    },

    /** その接続のぶんをやめる。取り直しが来るなら片付けを着地まで預ける。 */
    drop(key) {
      const item = layer.detach(key);
      if (item === null) return;
      if (reloadComing()) {
        waiting.set(subject(item), item);
        return;
      }
      release(item);
    },

    /** 預かっていたぶんを片付ける（取り直しが着地した）。 */
    settle() {
      for (const item of waiting.values()) release(item);
      waiting.clear();
    },

    /** `keys` に入っていない接続のぶんをやめる（配られた表から項目が消えた人）。 */
    retain(keys) {
      for (const key of layer.keys()) {
        if (!keys.has(key)) layer.drop(key);
      }
    },

    /** 全部やめる（ページを離れるとき）。**預かりも残さない。** */
    clear() {
      for (const key of layer.keys()) {
        const item = layer.detach(key);
        if (item !== null) release(item);
      }
      layer.settle();
    },
  };

  layers.add(layer);
  return layer;
}

/**
 * その接続が「もう居ない／やめた」。**カーソルを消すのと同じ処理から呼ぶ。**
 *
 * 入口は2つあって、どちらも「もう居ない」:
 *   * 配られた表にその鍵が無かった（盤面から出た・切れた）
 *   * カーソルの3秒 TTL（**タブが落ちて close が届かなかったとき**）
 *
 * **わざと1つの関数にしてある。** 別経路にすると2つ目を取りこぼす。
 */
export function dropLive(key) {
  for (const layer of layers) layer.drop(key);
}

/** 取り直しが着地した。預かっていたぶんを片付ける（**失敗しても呼ぶ**）。 */
export function settleLive() {
  for (const layer of layers) layer.settle();
}

/** ページを離れる。 */
export function clearLive() {
  for (const layer of layers) layer.clear();
}
