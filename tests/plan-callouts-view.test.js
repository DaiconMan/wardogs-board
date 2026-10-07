// callouts.js のうち DOM を触らない部分。
//
// 地名は「地図に元からある情報」の見せ方なので、配置マーカー（置いた物）とは
// 別の規則で出す。ここで見ているのは2つ:
//   * 名前の長さの上限がサーバ（NAME_MAX_LEN）と一致していること
//   * ズームで名前を出し分ける境目（CALLOUT_NAME_VIEW_M）
import { describe, it, expect } from "vitest";
import {
  CALLOUT_NAME_VIEW_M, MAX_CALLOUTS_PER_PLAN, NAME_MAX_LEN,
  namesVisibleAt, normalizeCalloutName,
} from "../public/js/plan/callouts.js";

describe("NAME_MAX_LEN", () => {
  it("24文字（schema.sql のコメントとサーバの検証と同じ）", () => {
    expect(NAME_MAX_LEN).toBe(24);
  });
});

describe("normalizeCalloutName", () => {
  it("前後の空白を落とす", () => {
    expect(normalizeCalloutName("  高台 ")).toBe("高台");
  });

  it("空・空白だけ・文字列でないものは null（無名の点を作らせない）", () => {
    for (const v of ["", "   ", "　", null, undefined, 5, {}]) {
      expect(normalizeCalloutName(v), JSON.stringify(v)).toBeNull();
    }
  });

  it("上限を超えたら null。ちょうどは通す。数えるのはコードポイント", () => {
    expect(normalizeCalloutName("あ".repeat(NAME_MAX_LEN))).toBe("あ".repeat(NAME_MAX_LEN));
    expect(normalizeCalloutName("あ".repeat(NAME_MAX_LEN + 1))).toBeNull();
    // 絵文字（サロゲートペア）は1文字と数える。
    expect(normalizeCalloutName("🌲".repeat(NAME_MAX_LEN))).toBe("🌲".repeat(NAME_MAX_LEN));
    expect(normalizeCalloutName("🌲".repeat(NAME_MAX_LEN + 1))).toBeNull();
  });
});

describe("namesVisibleAt", () => {
  it("寄っているときだけ名前を出す。境目は 100m 補助線が出るのと同じ広さ", () => {
    expect(CALLOUT_NAME_VIEW_M).toBe(4000);
    expect(namesVisibleAt(1000)).toBe(true);
    expect(namesVisibleAt(CALLOUT_NAME_VIEW_M)).toBe(true);
    expect(namesVisibleAt(CALLOUT_NAME_VIEW_M + 1)).toBe(false);
    // 全体表示（16km 四方）では出さない。上限いっぱいの 200 件が同時に出ると
    // 地図が文字で埋まって地形が読めなくなる。
    expect(namesVisibleAt(16000)).toBe(false);
  });

  it("盤面がまだ測れないときは出さない側に倒す", () => {
    expect(namesVisibleAt(0)).toBe(false);
    expect(namesVisibleAt(null)).toBe(false);
    expect(namesVisibleAt(undefined)).toBe(false);
  });
});

describe("MAX_CALLOUTS_PER_PLAN", () => {
  it("サーバの上限と同じ 200 件", () => {
    expect(MAX_CALLOUTS_PER_PLAN).toBe(200);
  });

  it("名前を出す広さで、画面に出る数が読める範囲に収まる", () => {
    // 16km 四方に 200 件 = 0.78 件/km²。名前を出す 4km 四方（16km²）なら
    // 平均 12〜13 件。これがこの上限と境目を選んだ根拠。
    const perKm2 = MAX_CALLOUTS_PER_PLAN / (16 * 16);
    const visible = perKm2 * (CALLOUT_NAME_VIEW_M / 1000) ** 2;
    expect(visible).toBeLessThan(20);
  });
});
