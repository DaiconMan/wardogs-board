// 1km セルの見出し（ガター）の計算。DOM を触らない部分だけを見る。
//
// セル名を地図の上に 256個ばらまくのをやめ、盤面の縁に列（A〜P）と
// 行（1〜16）の見出しを出す（海図・方眼図と同じ形）。ここで計算するのは
//   * 見出しを何セルおきに出すか（狭い画面で重なるなら間引く）
//   * 帯（ガター）をどこに置くか（地図の縁に沿わせ、画面から出たら縁で止める）
//   * 寄ったときだけ出す「セルの真ん中の名前」（最大4個）
// の3つ。
import { describe, it, expect } from "vitest";
import {
  CELL_NAME_VIEW_M, GUTTER_MIN_PITCH_X_PX, GUTTER_MIN_PITCH_Y_PX,
  centerCells, gutterLayout, gutterStep, gutterTicks,
} from "../public/js/plan/gutter.js";

describe("gutterStep", () => {
  it("間隔が足りていれば全部出す", () => {
    expect(gutterStep(24, 20)).toBe(1);
    expect(gutterStep(20, 20)).toBe(1);
  });

  it("足りなければ 2つおき・4つおきと間引く", () => {
    expect(gutterStep(12, 20)).toBe(2);
    expect(gutterStep(4, 20)).toBe(8);
  });

  it("盤面が測れない（0 や NaN）ときは 1 を返して壊れない", () => {
    expect(gutterStep(0, 20)).toBe(1);
    expect(gutterStep(Number.NaN, 20)).toBe(1);
  });
});

describe("gutterTicks", () => {
  // 16セル × 1000m が 384px に収まっている状態（1セル 24px ＝ 390px の実機相当）。
  const base = { count: 16, cellM: 1000, scale: 24 / 1000, offset: 0, lo: 0, hi: 384 };

  it("セルの真ん中に、列の数だけ見出しを置く", () => {
    const ticks = gutterTicks({ ...base, minPitch: GUTTER_MIN_PITCH_X_PX });
    expect(ticks).toHaveLength(16);
    expect(ticks[0]).toEqual({ index: 0, pos: 12 });
    expect(ticks[15]).toEqual({ index: 15, pos: 372 });
  });

  it("隣り合う見出しが最小間隔より近いなら間引く", () => {
    // 画面 128px（1セル 8px）。20px の最小間隔には 4つおきでないと届かない。
    const ticks = gutterTicks({ ...base, scale: 8 / 1000, hi: 128, minPitch: GUTTER_MIN_PITCH_X_PX });
    expect(ticks.map((t) => t.index)).toEqual([0, 4, 8, 12]);
  });

  it("出してよい範囲の外（画面の外）は出さない", () => {
    const ticks = gutterTicks({ ...base, lo: 100, hi: 200, minPitch: GUTTER_MIN_PITCH_X_PX });
    expect(ticks.map((t) => t.index)).toEqual([4, 5, 6, 7]);
  });

  it("パンして原点がずれても、見出しはセルと一緒に動く", () => {
    const a = gutterTicks({ ...base, minPitch: GUTTER_MIN_PITCH_X_PX });
    const b = gutterTicks({ ...base, offset: -40, hi: 256, minPitch: GUTTER_MIN_PITCH_X_PX });
    const byIndex = new Map(b.map((t) => [t.index, t.pos]));
    for (const t of a) {
      if (!byIndex.has(t.index)) continue;
      expect(byIndex.get(t.index)).toBeCloseTo(t.pos - 40, 6);
    }
    // 左に送ったぶん、先頭の見出しは範囲から外れる。
    expect(byIndex.has(0)).toBe(false);
  });
});

describe("gutterLayout", () => {
  const bandH = 16;
  const bandW = 18;

  it("地図の縁のすぐ外側に帯を置く（全体表示）", () => {
    const layout = gutterLayout(
      { x0: 100, x1: 500, y0: 200, y1: 600 },
      { x0: 0, x1: 600, y0: 0, y1: 800 },
      bandH, bandW
    );
    expect(layout.cols).toMatchObject({ left: 100, right: 500, top: 200 - bandH, height: bandH });
    expect(layout.rows).toMatchObject({ top: 200, bottom: 600, left: 100 - bandW, width: bandW });
  });

  it("地図の縁が画面の外へ出たら、盤面の縁で止める（寄ってパンした状態）", () => {
    const layout = gutterLayout(
      { x0: -900, x1: 1500, y0: -800, y1: 1600 },
      { x0: 0, x1: 600, y0: 0, y1: 800 },
      bandH, bandW
    );
    expect(layout.cols.top).toBe(0);
    expect(layout.cols.left).toBe(0);
    expect(layout.cols.right).toBe(600);
    expect(layout.rows.left).toBe(0);
    expect(layout.rows.bottom).toBe(800);
  });

  it("両方が盤面の縁で止まっても、帯どうしは重ならない（角は列の帯のもの）", () => {
    const layout = gutterLayout(
      { x0: -900, x1: 1500, y0: -800, y1: 1600 },
      { x0: 0, x1: 600, y0: 0, y1: 800 },
      bandH, bandW
    );
    expect(layout.rows.top).toBe(layout.cols.top + bandH);
  });

  it("行の帯が列の帯と横にかぶらない位置なら、行は下げない", () => {
    // 地図の左端（400px）が画面の中にあるので、行の帯は地図のすぐ左に入り、
    // 列の帯（地図の幅ぶん = 400px から右）とは横に並ぶだけで重ならない。
    const layout = gutterLayout(
      { x0: 400, x1: 1500, y0: -800, y1: 1600 },
      { x0: 0, x1: 600, y0: 0, y1: 800 },
      bandH, bandW
    );
    expect(layout.rows.left).toBe(400 - bandW);
    expect(layout.rows.left + bandW).toBeLessThanOrEqual(layout.cols.left);
    // 下げる必要が無いので、行の帯は盤面の上端から始まる。
    expect(layout.rows.top).toBe(0);
  });
});

describe("centerCells", () => {
  const cols = 16;
  const rows = 16;

  it("引いて見ているあいだは1つも出さない（256個で地図が埋まるのを避ける）", () => {
    expect(centerCells({ x: 0, y: 0, w: 16000, h: 16000 }, cols, rows)).toEqual([]);
    expect(centerCells({ x: 0, y: 0, w: CELL_NAME_VIEW_M, h: CELL_NAME_VIEW_M }, cols, rows)).toEqual([]);
  });

  // 名前の行番号は**下から**数える（ゲームのマップ画面の縦軸が下 1・上 16）。
  // 引数の `row` は SVG の行（上が 0）なので、上から2番目の行は 15 になる。
  it("寄ったら、真ん中が見えているセルの名前だけを出す", () => {
    // 1セルぶんだけ見ている（真ん中が入るのは上から2行目 = B15 の1つ）。
    const one = centerCells({ x: 1200, y: 1200, w: 1000, h: 1000 }, cols, rows);
    expect(one.map((c) => c.name)).toEqual(["B15"]);
    expect(one[0]).toMatchObject({ x: 1500, y: 1500 });

    // 4セルにまたがると 2×2 の4つ。真ん中が外れたセルは出さない。
    const four = centerCells({ x: 1000, y: 1000, w: 1800, h: 1800 }, cols, rows);
    expect(four.map((c) => c.name)).toEqual(["B15", "B14", "C15", "C14"]);
  });

  it("どんな見え方でも4個を超えない", () => {
    for (let x = 0; x < 2000; x += 37) {
      for (let w = 300; w < CELL_NAME_VIEW_M; w += 53) {
        const got = centerCells({ x, y: x, w, h: w }, cols, rows);
        expect(got.length).toBeLessThanOrEqual(4);
      }
    }
  });

  it("マップの外（負の座標・端の外側）のセルは出さない", () => {
    // 盤面の左上の角のセル。行番号は下から数えるので A16。
    const got = centerCells({ x: -900, y: -900, w: 1900, h: 1900 }, cols, rows);
    expect(got.map((c) => c.name)).toEqual(["A16"]);
  });

  // 南北を取り違えると、Discord での呼び名と画面が食い違う。
  it("画面のいちばん下の行が 1 になる", () => {
    const bottom = centerCells(
      { x: 0, y: (rows - 1) * 1000, w: 1000, h: 1000 }, cols, rows
    );
    expect(bottom.map((c) => c.name)).toEqual(["A1"]);
  });
});

describe("最小間隔", () => {
  it("390px の画面で 16列が重ならない値になっている", () => {
    // 390px 幅の盤面にマップの 16000m が収まると、1セルは 24.4px。
    expect(390 / 16).toBeGreaterThan(GUTTER_MIN_PITCH_X_PX);
    expect(390 / 16).toBeGreaterThan(GUTTER_MIN_PITCH_Y_PX);
  });
});
