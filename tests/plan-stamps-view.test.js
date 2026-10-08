// stamps.js のうち DOM を触らない部分（まとまりの分け方・陣営の読み・四葉の輪郭・
// 注記の省略・上限の値）の単体テスト。
//
// **`stamps` 表に列を足さずに、持っている3つの値から見せ方を決める**のがこの
// モジュールの肝なので、その導出（`stampGroup` / `stampSide` / `groupStamps`）を
// ここで固定する。列を足したくなった人がここを読めば、足さずに済む道が分かる。
//
// 軍用記号は「見慣れた人に一目で伝わること」が狙いなので、
// **APP-6 から外れている所を注記が名乗っていること**も見張る。
import { describe, it, expect } from "vitest";
import {
  MAX_STAMPS_PER_PLAN,
  NOTE_FULL_VIEW_M,
  NOTE_MAX_LEN,
  NOTE_SHORT_LEN,
  STAMP_GROUPS,
  STAMP_NOTE,
  STAMP_PX,
  VECTOR_MIN_PX,
  groupStamps,
  isVector,
  isWideGlyph,
  quatrefoilPath,
  stampGroup,
  stampNoteText,
  stampSide,
  stampTitle,
} from "../public/js/plan/stamps.js";

const def = (over = {}) => ({
  id: 1, label: "四角", shape: "square", color: "muted", glyph: null,
  draw_kind: "point", builtin: 1, ...over,
});

describe("まとまりの分け方（列を足さずに決める）", () => {
  it("3つだけ。図形・向きを持つ印・軍用記号", () => {
    expect(STAMP_GROUPS.map((g) => g.group)).toEqual(["figure", "vector", "military"]);
  });

  it("draw_kind が vector なら「向きを持つ印」（glyph は見ない）", () => {
    expect(stampGroup(def({ shape: "arrow", draw_kind: "vector" }))).toBe("vector");
    expect(stampGroup(def({ shape: "line", draw_kind: "vector", glyph: "歩" }))).toBe("vector");
  });

  it("glyph が無ければ「図形」、あれば「軍用記号」", () => {
    expect(stampGroup(def({ glyph: null }))).toBe("figure");
    expect(stampGroup(def({ shape: "diamond", glyph: "装" }))).toBe("military");
  });

  it("定義が無くても落ちない（置いた行だけ先に届くことがある）", () => {
    expect(stampGroup(null)).toBe("figure");
    expect(isVector(null)).toBe(false);
    expect(stampSide(undefined)).toBe(null);
  });

  it("groupStamps は並びを保ち、空のまとまりは返さない", () => {
    const defs = [
      def({ id: 1, label: "四角" }),
      def({ id: 2, label: "丸", shape: "circle" }),
      def({ id: 3, label: "敵 装甲", shape: "diamond", glyph: "装" }),
    ];
    const got = groupStamps(defs);
    expect(got.map((g) => g.group)).toEqual(["figure", "military"]);
    expect(got[0].items.map((d) => d.label)).toEqual(["四角", "丸"]);
    expect(got[1].items.map((d) => d.label)).toEqual(["敵 装甲"]);
  });

  it("定義が空なら、まとまりも空（空の見出しを棚に並べない）", () => {
    expect(groupStamps([])).toEqual([]);
    expect(groupStamps(undefined)).toEqual([]);
  });
});

describe("陣営は外形から決める（APP-6 の作法）", () => {
  it("四角＝味方 / 菱形＝敵 / 四葉＝不明", () => {
    expect(stampSide(def({ shape: "square" }))).toBe("味方");
    expect(stampSide(def({ shape: "diamond" }))).toBe("敵");
    expect(stampSide(def({ shape: "quatrefoil" }))).toBe("不明");
  });

  it("図形の外形（丸・三角）には陣営が無い", () => {
    expect(stampSide(def({ shape: "circle" }))).toBe(null);
    expect(stampSide(def({ shape: "triangle" }))).toBe(null);
  });
});

describe("棚の注記 — APP-6 から外れている所を名乗る", () => {
  it("外形が APP-6 の枠であることを言う", () => {
    expect(STAMP_NOTE).toContain("APP-6");
    for (const word of ["四角", "菱形", "四葉"]) {
      expect(STAMP_NOTE, `${word} に触れていない`).toContain(word);
    }
  });

  it("**兵種が独自であることを言う**（ここを落とすと読み手が判断できない）", () => {
    expect(STAMP_NOTE).toContain("兵種");
    expect(STAMP_NOTE).toContain("独自");
  });

  it("向きを持つ印の使い方も言う（ドラッグしないと置けないので）", () => {
    expect(STAMP_NOTE).toContain("ドラッグ");
  });
});

describe("四葉（不明の枠）の輪郭", () => {
  it("4本の弧で閉じる（半円4つ＝葉4つ）", () => {
    const d = quatrefoilPath();
    expect((d.match(/A /g) ?? []).length, "弧が4本ではない").toBe(4);
    expect(d.trim().endsWith("Z"), "閉じていない").toBe(true);
  });

  it("出幅が他の形と同じ（半径 = STAMP_PX）", () => {
    // 一辺 2a の正方形の各辺を半径 a の半円で膨らませるので、
    // 中心からの出幅は a + a = 2a。a = STAMP_PX / 2 で揃う。
    const a = STAMP_PX / 2;
    const d = quatrefoilPath();
    expect(d.startsWith(`M ${-a} ${-a}`), d).toBe(true);
    // 弧の半径は a（a を大きくすると葉が四角くなり、小さくすると繋がらない）。
    expect(d).toContain(`A ${a} ${a} 0 0 1`);
  });

  it("大きさを渡せる（棚の見本と盤面で同じ関数を使う）", () => {
    expect(quatrefoilPath(16)).toContain("A 8 8 0 0 1");
  });
});

describe("注記の文字", () => {
  it("無ければ空文字", () => {
    expect(stampNoteText(null, 1000)).toBe("");
    expect(stampNoteText("   ", 1000)).toBe("");
  });

  it("寄っているときは全文", () => {
    expect(stampNoteText("道路経由だから取りづらい", NOTE_FULL_VIEW_M))
      .toBe("道路経由だから取りづらい");
  });

  it("広く見ているときは頭だけ（配置の注記と同じ約束）", () => {
    const got = stampNoteText("道路経由だから取りづらい", NOTE_FULL_VIEW_M + 1);
    expect(got).toBe("道路経由だか…");
    expect([...got].length, "頭 6 文字 ＋ 三点").toBe(NOTE_SHORT_LEN + 1);
  });

  it("短い注記は広く見ていても省略しない", () => {
    expect(stampNoteText("守る", NOTE_FULL_VIEW_M + 1)).toBe("守る");
  });
});

describe("指したときの文", () => {
  it("注記があれば名前と並べる。省略しない", () => {
    expect(stampTitle(def({ label: "敵 装甲" }), "ここに装甲")).toBe("敵 装甲｜ここに装甲");
  });

  it("注記が無ければ名前だけ", () => {
    expect(stampTitle(def({ label: "四角" }), null)).toBe("四角");
  });

  it("定義が届いていなくても文は出す", () => {
    expect(stampTitle(null, null)).toBe("スタンプ");
  });
});

describe("サーバと揃えておく値", () => {
  it("注記の上限はサーバの NOTE_MAX と同じ 48", () => {
    expect(NOTE_MAX_LEN).toBe(48);
  });

  it("1作戦の上限はサーバの MAX_PER_PLAN と同じ 400", () => {
    expect(MAX_STAMPS_PER_PLAN).toBe(400);
  });

  it("向きを持つスタンプの最短は px で決める（ズームの倍率によらない）", () => {
    expect(VECTOR_MIN_PX).toBeGreaterThan(0);
  });

  it("全角の判定は placements.js と同じ（絵文字を半分で切らない）", () => {
    expect(isWideGlyph("歩")).toBe(true);
    expect(isWideGlyph("D")).toBe(false);
  });
});
