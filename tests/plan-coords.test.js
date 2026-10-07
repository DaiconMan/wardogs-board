// メートル ↔ SVG ↔ ゲーム内座標の変換と、セルの呼び方。
//
// **ゲーム内の座標は左下が 0,0 で、x は右・y は上に増える**
// （オーナーがゲーム内で確認、2026-09-29）。保存する y_m も同じ向き
// （maps.y_axis_down = 0）で、上下を反転するのは SVG に描くときだけ。
// 反転が2回かかると元に戻ってしまうので、両方向をここで押さえる。
import { describe, it, expect } from "vitest";
import { makeCoords, cellName, GAME_UNIT_M } from "../public/js/plan/coords.js";

const down = { width_m: 2000, height_m: 1000, y_axis_down: 1 };
const up = { width_m: 2000, height_m: 1000, y_axis_down: 0 };

/** 本物の Zestafona（schema.sql と同じ値）。実測との照合に使う。 */
const zestafona = { width_m: 16384, height_m: 16384, y_axis_down: 0 };

describe("makeCoords", () => {
  it("y 軸が下向きならメートルがそのまま SVG 座標になる", () => {
    const c = makeCoords(down);
    expect(c.toSvg({ x_m: 100, y_m: 250 })).toEqual({ x: 100, y: 250 });
  });

  it("y 軸が上向き（ゲームと同じ向き）なら y を反転して描く", () => {
    const c = makeCoords(up);
    expect(c.toSvg({ x_m: 100, y_m: 250 })).toEqual({ x: 100, y: 750 });
  });

  it("往復しても元に戻る（両方の向きで）", () => {
    for (const map of [down, up]) {
      const c = makeCoords(map);
      const src = { x_m: 123.5, y_m: 456.25 };
      const back = c.toMeters(c.toSvg(src));
      expect(back.x_m).toBeCloseTo(src.x_m, 6);
      expect(back.y_m).toBeCloseTo(src.y_m, 6);
    }
  });

  it("viewBox はマップ全体", () => {
    expect(makeCoords(down).viewBoxAll()).toBe("0 0 2000 1000");
  });
});

// ここが合っていれば、オーナーがゲーム画面で読んだ数字をそのまま打ち込める。
// 逆に言うと、ここがずれていると盤面の座標表示（#readout）が嘘になる。
describe("ゲーム内の座標表示（実測との照合）", () => {
  it("1単位 = 100m", () => {
    expect(GAME_UNIT_M).toBe(100);
  });

  it("Zestafona の Tower 3 が、ゲーム内の表示 x70.01 y100.31 と一致する", () => {
    // schema.sql に入れている値（MIT データ）。
    const tower = { x_m: 7017.3, y_m: 10017.2 };
    const g = makeCoords(zestafona).toGame(tower);
    // カーソルで読んだ値なので、数十メートル（0.25単位）の誤差は許す。
    expect(g.x).toBeCloseTo(70.01, 0);
    expect(Math.abs(g.x - 70.01)).toBeLessThan(0.25);
    expect(Math.abs(g.y - 100.31)).toBeLessThan(0.25);
  });

  it("ゲームの y は上に増える（保存した値をそのまま出す。ここで反転しない）", () => {
    // 実測: カーソルが縦軸の上のほう（14〜15）にあるとき y142.89 と出ていた。
    const g = makeCoords(zestafona).toGame({ x_m: 1895, y_m: 14289 });
    expect(g).toEqual({ x: 18.95, y: 142.89 });
    // 上下を取り違えると (16384 - 14289) / 100 = 20.95 になる。
    expect(g.y).not.toBeCloseTo(20.95, 2);
  });

  it("描画（SVG）では上下が逆になる。ゲーム表示とは別の経路", () => {
    const c = makeCoords(zestafona);
    // 北（ゲームの y が大きい）ほど、SVG では上（y が小さい）。
    expect(c.toSvg({ x_m: 1895, y_m: 14289 }).y).toBeCloseTo(16384 - 14289, 6);
    expect(c.toGame(c.toMeters({ x: 1895, y: 16384 - 14289 })).y).toBeCloseTo(142.89, 6);
  });
});

describe("セルの呼び方", () => {
  // ゲームのマップ画面の縦軸は**下が 1・上が 16**（オーナー確認、2026-09-29）。
  // ここが逆だと、Discord で「D8」と言った場所と画面の「D8」が食い違う。
  it("行番号は下から数える", () => {
    expect(cellName(0, 0, 16), "画面のいちばん上").toBe("A16");
    expect(cellName(0, 15, 16), "画面のいちばん下").toBe("A1");
    expect(cellName(3, 8, 16)).toBe("D8");
  });

  it("cellOf も下から数えた名前を返す", () => {
    const c = makeCoords(zestafona);
    // ゲームの y が小さい = マップの南端 = 行 1。
    expect(c.cellOf({ x_m: 500, y_m: 500 })).toBe("A1");
    // ゲームの y が大きい = 北端 = 行 16。
    expect(c.cellOf({ x_m: 500, y_m: 15500 })).toBe("A16");
  });

  it("マップの外は null（丸めない）", () => {
    const c = makeCoords(zestafona);
    expect(c.cellOf({ x_m: -1, y_m: 500 })).toBe(null);
    expect(c.cellOf({ x_m: 500, y_m: 20000 })).toBe(null);
  });

  // 一辺はちょうどの km ではない（Zestafona は 16,384m）。丸ごと入るセルだけを
  // 数えるので 16 列 × 16 行で、端の 384m はどのセルにも属さない。
  it("列・行の数は「丸ごと入るセル」の数", () => {
    const c = makeCoords(zestafona);
    expect(c.cols).toBe(16);
    expect(c.rows).toBe(16);
    expect(c.cellOf({ x_m: 16200, y_m: 500 }), "端の余りはセルの外").toBe(null);
  });
});
