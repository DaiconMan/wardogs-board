// 「いまやっている最中」を見せているものの**寿命**（board/live.js）。
//
// ここが壊れると、画面には**残骸**として出る:
//   * 描いている途中で落ちた人の線が残り続ける
//   * 運んでいる最中に切れた人の物が、動かされた位置のまま残る
// どちらも「実際にはそうなっていない盤面」を全員が見ながら作戦を立てることになる
// （カーソルが1本残るより害が大きい。D-069）。
//
// **消す入口が1本であること**がこのモジュールの存在理由なので、
// 入口（`dropLive` / `settleLive` / `clearLive`）が**乗っている層を全部**
// 一巡することも、ここで押さえる。
//
// **DOM を触らない**ので vitest から素で import できる（board/* で唯一）。
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLive, createLiveLayer, dropLive, setLiveReloadPending, settleLive,
} from "../public/js/plan/board/live.js";

/** 片付けと「表から外した瞬間」を記録する層。 */
function spyLayer(options = {}) {
  const released = [];
  const detached = [];
  const layer = createLiveLayer({
    release: (item) => released.push(item),
    detach: (item) => detached.push(item),
    ...options,
  });
  return { layer, released, detached };
}

beforeEach(() => {
  // **既定は「その場で片付ける」。** 繋ぎ忘れても残骸が残らない側に倒してある。
  setLiveReloadPending(null);
});

describe("createLiveLayer", () => {
  it("見せ始めたものを鍵で引ける", () => {
    const { layer } = spyLayer();
    const item = { id: 1 };
    layer.set("k1", item);
    expect(layer.get("k1")).toBe(item);
    expect(layer.keys()).toEqual(["k1"]);
    layer.clear();
  });

  it("知らない鍵は null", () => {
    const { layer } = spyLayer();
    expect(layer.get("nope")).toBe(null);
    layer.clear();
  });

  // **表から外すのと片付けるのは別**。手元の操作が引き継ぐときは外すだけ。
  it("detach は外すだけで片付けない", () => {
    const { layer, released, detached } = spyLayer();
    const item = { id: 1 };
    layer.set("k1", item);
    expect(layer.detach("k1")).toBe(item);
    expect(detached).toEqual([item]);
    expect(released).toEqual([]);
    expect(layer.get("k1")).toBe(null);
    layer.clear();
  });

  it("detach は2回目に null を返す（空振りで hook を呼ばない）", () => {
    const { layer, detached } = spyLayer();
    layer.set("k1", { id: 1 });
    layer.detach("k1");
    expect(layer.detach("k1")).toBe(null);
    expect(detached).toHaveLength(1);
    layer.clear();
  });

  // ── 片付け（取り直しが来ないとき）─────────────────────────
  it("取り直しが来ないなら、その場で片付ける", () => {
    const { layer, released, detached } = spyLayer();
    const item = { id: 1 };
    layer.set("k1", item);
    layer.drop("k1");
    expect(detached).toEqual([item]);
    expect(released).toEqual([item]);
    layer.clear();
  });

  // **ここが D-069 の肝。** 引き終わった・置き終わった瞬間に片付けると、
  // 確定した値が再取得で届くまでの数百ミリ秒「何も無い」状態が見える。
  it("取り直しが来るなら、着地まで片付けを預ける", () => {
    const { layer, released, detached } = spyLayer();
    setLiveReloadPending(() => true);
    const item = { id: 1 };
    layer.set("k1", item);
    layer.drop("k1");
    // 外すのは**必ず即座に**（運んでいる印・引いている印はその場で外れる）。
    expect(detached).toEqual([item]);
    // 片付けはまだ。
    expect(released).toEqual([]);
    settleLive();
    expect(released).toEqual([item]);
    layer.clear();
  });

  it("預かりは着地で1回だけ片付く（2回呼んでも二重に走らない）", () => {
    const { layer, released } = spyLayer();
    setLiveReloadPending(() => true);
    layer.set("k1", { id: 1 });
    layer.drop("k1");
    settleLive();
    settleLive();
    expect(released).toHaveLength(1);
    layer.clear();
  });

  // 預けている間にもう一度始めた（離してすぐ同じものを続けた）。
  it("預かっているものをもう一度見せ始めたら、片付けを取り下げる", () => {
    const { layer, released } = spyLayer();
    setLiveReloadPending(() => true);
    const item = { id: 1 };
    layer.set("k1", item);
    layer.drop("k1");
    layer.set("k1", item);
    settleLive();
    expect(released).toEqual([]);
    layer.clear();
  });

  it("unwait で預かりを打ち切れる（手元の操作が勝ったとき）", () => {
    const { layer, released } = spyLayer();
    setLiveReloadPending(() => true);
    const item = { id: 1 };
    layer.set("k1", item);
    layer.drop("k1");
    layer.unwait(item);
    settleLive();
    expect(released).toEqual([]);
    layer.clear();
  });

  // 預かりの鍵は「対象」。運んでいる物は**物**そのもので数える
  // （同じ物を別の接続が運び直したときに、2回片付けない）。
  it("subject を渡すと、その単位で預かる", () => {
    const obj = { name: "物" };
    const { layer, released } = spyLayer({ subject: (item) => item.obj });
    setLiveReloadPending(() => true);
    layer.set("k1", { obj, kind: "p" });
    layer.drop("k1");
    // 別の接続が同じ物を運び始めた → 片付けを取り下げる。
    layer.set("k2", { obj, kind: "p" });
    settleLive();
    expect(released).toEqual([]);
    layer.clear();
  });

  // ── 配られた表から消えた人 ───────────────────────────────
  it("retain に入っていない鍵のぶんをやめる", () => {
    const { layer, released } = spyLayer();
    const a = { id: "a" };
    const b = { id: "b" };
    layer.set("k1", a);
    layer.set("k2", b);
    layer.retain(new Set(["k1"]));
    expect(released).toEqual([b]);
    expect(layer.keys()).toEqual(["k1"]);
    layer.clear();
  });

  it("retain が空なら全部やめる", () => {
    const { layer, released } = spyLayer();
    layer.set("k1", { id: 1 });
    layer.set("k2", { id: 2 });
    layer.retain(new Set());
    expect(released).toHaveLength(2);
    expect(layer.keys()).toEqual([]);
  });

  // ── ページを離れる ─────────────────────────────────────
  // **預かりも残さない。** 残すと、次に開いたときの層へ持ち越す経路ができる。
  it("clear は預かっているぶんも片付ける", () => {
    const { layer, released } = spyLayer();
    setLiveReloadPending(() => true);
    const held = { id: "held" };
    const waiting = { id: "waiting" };
    layer.set("k1", waiting);
    layer.drop("k1");
    layer.set("k2", held);
    layer.clear();
    expect(released.map((i) => i.id).sort()).toEqual(["held", "waiting"]);
    expect(layer.keys()).toEqual([]);
  });
});

// **入口は3つだけで、どれも乗っている層を全部一巡する。**
// 層ごとに片付けを呼ぶ形にすると、層を1つ足した人が黙って取りこぼす。
describe("消す入口が層をまたぐ", () => {
  it("dropLive は全部の層のその鍵をやめる", () => {
    const one = spyLayer();
    const two = spyLayer();
    one.layer.set("k1", { id: 1 });
    two.layer.set("k1", { id: 2 });
    dropLive("k1");
    expect(one.released).toHaveLength(1);
    expect(two.released).toHaveLength(1);
    one.layer.clear();
    two.layer.clear();
  });

  it("settleLive は全部の層の預かりを片付ける", () => {
    setLiveReloadPending(() => true);
    const one = spyLayer();
    const two = spyLayer();
    one.layer.set("k1", { id: 1 });
    two.layer.set("k1", { id: 2 });
    dropLive("k1");
    expect(one.released).toEqual([]);
    expect(two.released).toEqual([]);
    settleLive();
    expect(one.released).toHaveLength(1);
    expect(two.released).toHaveLength(1);
    one.layer.clear();
    two.layer.clear();
  });

  it("clearLive は全部の層を空にする", () => {
    const one = spyLayer();
    const two = spyLayer();
    one.layer.set("k1", { id: 1 });
    two.layer.set("k2", { id: 2 });
    clearLive();
    expect(one.layer.keys()).toEqual([]);
    expect(two.layer.keys()).toEqual([]);
    expect(one.released).toHaveLength(1);
    expect(two.released).toHaveLength(1);
  });
});

describe("setLiveReloadPending", () => {
  it("繋がなければ常に「その場で片付ける」", () => {
    const { layer, released } = spyLayer();
    setLiveReloadPending(undefined);
    layer.set("k1", { id: 1 });
    layer.drop("k1");
    expect(released).toHaveLength(1);
    layer.clear();
  });

  // **毎回読む。** 作った時点の値を焼き付けると、取り直しの有無が
  // 層を作った瞬間で固定されてしまう。
  it("片付けのたびに読み直す", () => {
    const pending = vi.fn(() => false);
    setLiveReloadPending(pending);
    const { layer, released } = spyLayer();
    layer.set("k1", { id: 1 });
    layer.drop("k1");
    expect(released).toHaveLength(1);
    pending.mockReturnValue(true);
    layer.set("k2", { id: 2 });
    layer.drop("k2");
    expect(released).toHaveLength(1);
    expect(pending).toHaveBeenCalledTimes(2);
    layer.clear();
  });
});
