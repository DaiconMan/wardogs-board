// ドリルタワー（towers.js）のうち、DOM を触らない判断だけの単体テスト。
// 描画そのもの（形・色・当たり判定）は e2e/plan-towers.spec.js が実物で見る。
import { describe, it, expect } from "vitest";
import {
  TOWER_MARK_PX, TOWER_NAME_VIEW_M, towerNamesVisibleAt, towerTitle,
} from "../public/js/plan/towers.js";

describe("名前を出す寄り具合", () => {
  it("セル名・エリア名と同じ 2000m を境にする", () => {
    // 「どこまで寄れば何が出るか」を覚え直さずに済むよう、閾値を揃える。
    expect(TOWER_NAME_VIEW_M).toBe(2000);
  });

  it("寄っているときだけ名前を出す", () => {
    expect(towerNamesVisibleAt(1000)).toBe(true);
    expect(towerNamesVisibleAt(TOWER_NAME_VIEW_M)).toBe(true);
    expect(towerNamesVisibleAt(TOWER_NAME_VIEW_M + 1)).toBe(false);
    // 全体表示（16km 四方）では出さない。5本が 600m 四方に固まっているので、
    // 引いた状態で名前を出すと必ず重なる。
    expect(towerNamesVisibleAt(16320)).toBe(false);
  });

  it("盤面がまだ測れないときは出さない側に倒す", () => {
    expect(towerNamesVisibleAt(0)).toBe(false);
    expect(towerNamesVisibleAt(-1)).toBe(false);
    expect(towerNamesVisibleAt(NaN)).toBe(false);
    expect(towerNamesVisibleAt(undefined)).toBe(false);
  });
});

describe("読み上げ・吹き出しの文", () => {
  it("マップ固定の設備であることを名前に添える", () => {
    // ゲーム内では FOB に建てる「ドリルリグ」も Drill と呼ばれるので、
    // 名前だけだと区別が付かない（調査 §4.4）。
    expect(towerTitle("TOWER 1")).toBe("TOWER 1（ドリルタワー・マップ固定）");
  });
});

describe("大きさ", () => {
  it("印は画面固定の大きさで持つ（実寸は持たない）", () => {
    expect(TOWER_MARK_PX).toBeGreaterThan(0);
  });
});
