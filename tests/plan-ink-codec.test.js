import { describe, it, expect } from "vitest";
import {
  simplify, encodePoints, decodePoints, validateEncoded, QUANTUM, MAX_POINTS,
} from "../functions/_lib/ink.js";

const map = { width_m: 2000, height_m: 1000 };

describe("simplify（RDP）", () => {
  it("直線上の中間点を落とす", () => {
    const pts = [
      { x_m: 0, y_m: 0 }, { x_m: 1, y_m: 0 }, { x_m: 2, y_m: 0 }, { x_m: 3, y_m: 0 },
    ];
    expect(simplify(pts)).toEqual([{ x_m: 0, y_m: 0 }, { x_m: 3, y_m: 0 }]);
  });

  it("端点を必ず保持する", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x_m: i, y_m: Math.sin(i) * 5 }));
    const out = simplify(pts);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    expect(out.length).toBeLessThan(pts.length);
  });

  it("2点以下はそのまま返す", () => {
    const pts = [{ x_m: 1, y_m: 2 }];
    expect(simplify(pts)).toEqual(pts);
  });

  it("閾値を超える膨らみは残す", () => {
    const pts = [{ x_m: 0, y_m: 0 }, { x_m: 5, y_m: 10 }, { x_m: 10, y_m: 0 }];
    expect(simplify(pts).length).toBe(3);
  });
});

describe("encodePoints / decodePoints", () => {
  it("往復して 0.1m 以内で元に戻る", () => {
    const pts = [
      { x_m: 0, y_m: 0 }, { x_m: 12.34, y_m: 56.78 }, { x_m: 999.95, y_m: 1.01 },
    ];
    const back = decodePoints(encodePoints(pts));
    expect(back.length).toBe(pts.length);
    pts.forEach((p, i) => {
      expect(Math.abs(back[i].x_m - p.x_m)).toBeLessThanOrEqual(QUANTUM / 2 + 1e-9);
      expect(Math.abs(back[i].y_m - p.y_m)).toBeLessThanOrEqual(QUANTUM / 2 + 1e-9);
    });
  });

  it("差分符号化されている（2点目以降は絶対値より小さい）", () => {
    const enc = encodePoints([{ x_m: 500, y_m: 500 }, { x_m: 500.5, y_m: 500.5 }]);
    expect(enc.slice(0, 2)).toEqual([5000, 5000]);
    expect(enc.slice(2)).toEqual([5, 5]);
  });

  it("空配列は空配列", () => {
    expect(encodePoints([])).toEqual([]);
    expect(decodePoints([])).toEqual([]);
  });
});

describe("validateEncoded", () => {
  // Review Focus 3: JSON から来る値は型が保証されない
  it("数値でない要素を弾く", () => {
    for (const bad of [[NaN, 0, 1, 1], [0, Infinity, 1, 1], ["1", 2, 1, 1], [null, 0, 1, 1]]) {
      expect(validateEncoded(bad, map), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("整数でない要素を弾く", () => {
    expect(validateEncoded([1.5, 0, 1, 1], map)).not.toBeNull();
  });

  it("要素数が偶数でなければ弾く", () => {
    expect(validateEncoded([1, 2, 3], map)).not.toBeNull();
  });

  it("2点未満を弾く", () => {
    expect(validateEncoded([10, 10], map)).not.toBeNull();
  });

  it("マップ範囲外を弾く", () => {
    expect(validateEncoded(encodePoints([
      { x_m: 0, y_m: 0 }, { x_m: 2500, y_m: 10 },
    ]), map)).not.toBeNull();
    expect(validateEncoded(encodePoints([
      { x_m: 0, y_m: 0 }, { x_m: 10, y_m: -5 },
    ]), map)).not.toBeNull();
  });

  it("点数が上限を超えたら弾く", () => {
    const enc = new Array((MAX_POINTS + 1) * 2).fill(1);
    expect(validateEncoded(enc, map)).not.toBeNull();
  });

  it("正しいものは null", () => {
    const enc = encodePoints([{ x_m: 10, y_m: 10 }, { x_m: 20, y_m: 20 }]);
    expect(validateEncoded(enc, map)).toBeNull();
  });
});
