// 縮尺バー（スケールバー）の目盛りの決め方。DOM を触らない計算だけを見る。
//
// GoogleMap と同じ挙動にする: バーの長さは決め打ちにせず、「上限の長さに収まる
// 範囲で、いちばん大きいきりのいい距離」を選んでバーの側を伸縮させる。
// 倍率（×2.5 のような値）は出さない。作戦の議論で使うのは距離であって倍率ではない。
import { describe, it, expect } from "vitest";
import {
  SCALE_MAX_PX, SCALE_STEPS_M, scaleBar, scaleLabel,
} from "../public/js/plan/viewport.js";

describe("SCALE_STEPS_M", () => {
  it("1-2-5 の刻みで、きりのいい数字だけを持つ", () => {
    expect(SCALE_STEPS_M).toEqual([
      1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000,
    ]);
  });

  it("昇順で重複が無い", () => {
    const sorted = [...SCALE_STEPS_M].sort((a, b) => a - b);
    expect(SCALE_STEPS_M).toEqual(sorted);
    expect(new Set(SCALE_STEPS_M).size).toBe(SCALE_STEPS_M.length);
  });
});

describe("scaleLabel", () => {
  it("1000m 未満は m、1000m 以上は km で書く", () => {
    expect(scaleLabel(100)).toBe("100 m");
    expect(scaleLabel(500)).toBe("500 m");
    expect(scaleLabel(1000)).toBe("1 km");
    expect(scaleLabel(2000)).toBe("2 km");
    expect(scaleLabel(10000)).toBe("10 km");
  });
});

describe("scaleBar", () => {
  it("上限の長さに収まる範囲で、いちばん大きいきりのいい距離を選ぶ", () => {
    // 1px = 10m、上限 120px → 1200m まで入る。1000m（1km）が最大のきりのいい値。
    const bar = scaleBar(10, 120);
    expect(bar.meters).toBe(1000);
    expect(bar.label).toBe("1 km");
    expect(bar.px).toBeCloseTo(100, 6);
  });

  it("バーの長さは必ず上限以下になる", () => {
    for (const mpp of [0.05, 0.1, 0.5, 1, 2.5, 8.4, 20, 100]) {
      const bar = scaleBar(mpp, SCALE_MAX_PX);
      expect(bar.px, `mpp=${mpp}`).toBeLessThanOrEqual(SCALE_MAX_PX);
      expect(bar.px, `mpp=${mpp}`).toBeGreaterThan(0);
    }
  });

  it("寄るほど短い距離に切り替わる（全体表示 → 最大ズーム）", () => {
    // 幅 1900px の盤面。全体表示は 16000m、いちばん寄ると MIN_VIEW_M = 200m。
    const fit = scaleBar(16000 / 1900, 120);
    const near = scaleBar(200 / 1900, 120);
    expect(fit.meters).toBe(1000);
    expect(near.meters).toBe(10);
    expect(near.meters).toBeLessThan(fit.meters);
  });

  it("選んだ距離とバーの長さが常に一致する（px = 距離 / mpp）", () => {
    for (const mpp of [0.104, 1, 3, 8.42]) {
      const bar = scaleBar(mpp, 120);
      expect(bar.px).toBeCloseTo(bar.meters / mpp, 6);
      expect(SCALE_STEPS_M).toContain(bar.meters);
    }
  });

  it("いちばん小さい刻みにも届かないほど寄っても、壊れずに最小の刻みを返す", () => {
    const bar = scaleBar(0.0001, 1);
    expect(bar.meters).toBe(SCALE_STEPS_M[0]);
    expect(Number.isFinite(bar.px)).toBe(true);
  });

  it("盤面がまだ測れない（mpp が 0 や負）ときは null を返す", () => {
    expect(scaleBar(0, 120)).toBeNull();
    expect(scaleBar(-1, 120)).toBeNull();
    expect(scaleBar(Number.NaN, 120)).toBeNull();
  });
});
