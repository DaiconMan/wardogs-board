// 見えている範囲（viewBox）の計算。
//
// **ここが「地図が画面の何%を占めるか」を決めている。**
//
// 以前は viewBox の縦横比を「常にマップの縦横比」に保っていた。マップは正方形
// なので、16:9 の画面では preserveAspectRatio（xMidYMid meet）が左右に
// レターボックスを作り、1920x1080 では地図が中央の 950px ほどにしかならず、
// 左右 480px ずつが完全な余白だった（オーナー報告: 「他サイトはやりたいことが
// スムーズにできて操作しやすいのに、うちのサイトは…操作性いまいち」）。
//
// 直し方は**縦横比の持ち主を変える**こと。viewBox の縦横比を**盤面（画面）の
// 縦横比**に合わせると、レターボックスが構造的に消える。そのうえで
//
//   * 開いた直後 … coverView（マップが画面を埋める）
//   * 「全体表示」… containView（マップ全体が収まる。いちばん引いた状態）
//
// の2つを別の関数として持つ。
import { describe, it, expect } from "vitest";

import {
  MIN_VIEW_M, clampView, containView, coverView, zoomView,
} from "../public/js/plan/viewport.js";

/** Bakurani と同じ正方形のマップ。 */
const SQUARE = { width_m: 16000, height_m: 16000 };

/** 画面の縦横比（幅 ÷ 高さ）。 */
const WIDE = 1920 / 1080;      // 1.777…
const TALL = 390 / 844;        // 0.462…

describe("containView（全体表示）", () => {
  it("横長の画面では、マップ全体が縦いっぱいに収まる", () => {
    const v = containView(SQUARE, WIDE);
    expect(v.h).toBeCloseTo(16000, 6);
    expect(v.w).toBeCloseTo(16000 * WIDE, 6);
    // マップは横方向の真ん中に来る。
    expect(v.x).toBeCloseTo((16000 - v.w) / 2, 6);
    expect(v.y).toBeCloseTo(0, 6);
  });

  it("縦長の画面では、マップ全体が横いっぱいに収まる", () => {
    const v = containView(SQUARE, TALL);
    expect(v.w).toBeCloseTo(16000, 6);
    expect(v.h).toBeCloseTo(16000 / TALL, 6);
    expect(v.y).toBeCloseTo((16000 - v.h) / 2, 6);
  });

  it("画面が正方形なら、マップそのものになる", () => {
    expect(containView(SQUARE, 1)).toEqual({ x: 0, y: 0, w: 16000, h: 16000 });
  });

  it("縦横比はいつも画面のそれと同じ（＝レターボックスが出ない）", () => {
    for (const ratio of [WIDE, TALL, 1, 2.5, 0.3]) {
      const v = containView(SQUARE, ratio);
      expect(v.w / v.h).toBeCloseTo(ratio, 9);
    }
  });
});

describe("coverView（開いた直後）", () => {
  it("横長の画面では、マップが横いっぱいに広がる（上下は切れる）", () => {
    const v = coverView(SQUARE, WIDE);
    expect(v.w).toBeCloseTo(16000, 6);
    expect(v.h).toBeCloseTo(16000 / WIDE, 6);
    expect(v.x).toBeCloseTo(0, 6);
    // 切れるぶんは上下で等しい（真ん中が見える）。
    expect(v.y).toBeCloseTo((16000 - v.h) / 2, 6);
  });

  it("縦長の画面では、マップが縦いっぱいに広がる（左右が切れる）", () => {
    const v = coverView(SQUARE, TALL);
    expect(v.h).toBeCloseTo(16000, 6);
    expect(v.w).toBeCloseTo(16000 * TALL, 6);
    expect(v.x).toBeCloseTo((16000 - v.w) / 2, 6);
  });

  it("**見えている範囲がすべて地図の中**（＝地図が画面を 100% 埋める）", () => {
    for (const ratio of [WIDE, TALL, 1, 2.5, 0.3]) {
      const v = coverView(SQUARE, ratio);
      expect(v.x).toBeGreaterThanOrEqual(-1e-9);
      expect(v.y).toBeGreaterThanOrEqual(-1e-9);
      expect(v.x + v.w).toBeLessThanOrEqual(16000 + 1e-9);
      expect(v.y + v.h).toBeLessThanOrEqual(16000 + 1e-9);
      expect(v.w / v.h).toBeCloseTo(ratio, 9);
    }
  });

  it("contain より必ず寄っている（＝開いた直後のほうが地図が大きい）", () => {
    for (const ratio of [WIDE, TALL, 2.5, 0.3]) {
      expect(coverView(SQUARE, ratio).w).toBeLessThan(containView(SQUARE, ratio).w);
    }
  });
});

describe("clampView", () => {
  it("縦横比を画面に合わせ直す（渡した h は無視される）", () => {
    const v = clampView({ x: 0, y: 0, w: 4000, h: 9999 }, SQUARE, WIDE);
    expect(v.w).toBeCloseTo(4000, 6);
    expect(v.h).toBeCloseTo(4000 / WIDE, 6);
  });

  it("いちばん引けるのは contain まで（それ以上は引けない）", () => {
    const v = clampView({ x: 0, y: 0, w: 1e9, h: 1e9 }, SQUARE, WIDE);
    expect(v.w).toBeCloseTo(containView(SQUARE, WIDE).w, 6);
    expect(v.x).toBeCloseTo(containView(SQUARE, WIDE).x, 6);
  });

  it("いちばん寄れるのは MIN_VIEW_M まで", () => {
    expect(clampView({ x: 0, y: 0, w: 1, h: 1 }, SQUARE, WIDE).w).toBe(MIN_VIEW_M);
  });

  it("マップより広く見ている軸は中央に寄せる", () => {
    const v = clampView({ x: -9999, y: 0, w: containView(SQUARE, WIDE).w, h: 1 }, SQUARE, WIDE);
    expect(v.x).toBeCloseTo((16000 - v.w) / 2, 6);
  });

  it("寄っている軸は、見えている幅の 1/4 までのはみ出しを許す", () => {
    const v = clampView({ x: -1e6, y: -1e6, w: 4000, h: 1 }, SQUARE, WIDE);
    expect(v.x).toBeCloseTo(-4000 * 0.25, 6);
    expect(v.y).toBeCloseTo(-(4000 / WIDE) * 0.25, 6);
  });

  it("ratio を省いたらマップの縦横比を使う（既存の呼び方を壊さない）", () => {
    const v = clampView({ x: 0, y: 0, w: 8000, h: 0 }, SQUARE);
    expect(v.h).toBeCloseTo(8000, 6);
  });
});

describe("zoomView", () => {
  it("掴んだ地点が画面の同じ割合の位置に残る", () => {
    const view = coverView(SQUARE, WIDE);
    const anchor = { x: 6000, y: 7000 };
    const fraction = { x: 0.25, y: 0.75 };
    const next = zoomView(view, SQUARE, { anchor, fraction, factor: 0.5, ratio: WIDE });
    expect(next.x + next.w * fraction.x).toBeCloseTo(anchor.x, 3);
    expect(next.y + next.h * fraction.y).toBeCloseTo(anchor.y, 3);
  });

  it("引き切っても contain を超えない", () => {
    const view = coverView(SQUARE, WIDE);
    const next = zoomView(view, SQUARE, {
      anchor: { x: 8000, y: 8000 }, fraction: { x: 0.5, y: 0.5 }, factor: 100, ratio: WIDE,
    });
    expect(next.w).toBeCloseTo(containView(SQUARE, WIDE).w, 6);
  });
});
