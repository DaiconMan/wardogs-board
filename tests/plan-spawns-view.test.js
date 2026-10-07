// 陣営スポーン（spawns.js）のうち、DOM を触らない計算だけの単体テスト。
// 描画そのものは e2e/plan-towers.spec.js が実物で見る。
import { describe, it, expect } from "vitest";
import { centroid, factionLabel, parsePolygon } from "../public/js/plan/spawns.js";

describe("陣営", () => {
  it("3陣営に表示名がある", () => {
    expect(factionLabel("lonestar")).toBe("ローンスター");
    expect(factionLabel("manticore")).toBe("マンティコア");
    expect(factionLabel("valkyra")).toBe("ヴァルキラ");
  });

  it("未知の陣営でも黙って消さない（生の値を出す）", () => {
    expect(factionLabel("unknown")).toBe("unknown");
    expect(factionLabel(null)).toBe("不明");
  });
});

describe("parsePolygon", () => {
  // 保存は JSON 文字列。壊れた行が1つあっても盤面ごと落とさないために、
  // 例外ではなく null を返して「その1件を描かない」に倒す。
  it("JSON 文字列でも配列でも受ける", () => {
    const want = [{ x_m: 1, y_m: 2 }, { x_m: 3, y_m: 4 }, { x_m: 5, y_m: 6 }];
    expect(parsePolygon("[[1,2],[3,4],[5,6]]")).toEqual(want);
    expect(parsePolygon([[1, 2], [3, 4], [5, 6]])).toEqual(want);
  });

  it("壊れていれば null", () => {
    expect(parsePolygon("こわれてる")).toBe(null);
    expect(parsePolygon("[[1,2],[3,4]]"), "3点未満は面にならない").toBe(null);
    expect(parsePolygon("[[1,2],[3,4],[5]]")).toBe(null);
    expect(parsePolygon('[[1,2],[3,4],["5",6]]')).toBe(null);
    expect(parsePolygon("[[1,2],[3,4],[null,6]]")).toBe(null);
    expect(parsePolygon(null)).toBe(null);
  });
});

describe("centroid", () => {
  it("頂点の平均を返す（陣営名を置く位置）", () => {
    // Bakurani の Lonestar と同じ形（一辺およそ 480m の回転した正方形）。
    const square = [
      { x: 8275.5, y: 3513.2 }, { x: 8737.7, y: 3636.7 },
      { x: 8862.2, y: 3173.6 }, { x: 8399.1, y: 3050.0 },
    ];
    const c = centroid(square);
    expect(c.x).toBeCloseTo(8568.6, 1);
    expect(c.y).toBeCloseTo(3343.4, 1);
  });

  it("空なら null", () => {
    expect(centroid([])).toBe(null);
    expect(centroid(null)).toBe(null);
  });
});
