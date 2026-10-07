// placements.js のうち DOM を触らない部分（種別の並び・コスト/射程の文言・
// 作図用記号の対応表）の単体テスト。
//
// 「試合の要素」（kind=objective）はゲーム内の測定値を持たない作図用の記号なので、
// コストも射程も「不明」と書くのではなく、そもそも行を出さない（設計書 §3-A-2）。
// 形とグリフの対応も、カタログの列ではなくここ1箇所で決める。
import { describe, it, expect } from "vitest";
import {
  KINDS,
  LABEL_MAX_LEN,
  NOTE_FULL_VIEW_M,
  NOTE_ITEM_IDS,
  NOTE_SHORT_LEN,
  OBJECTIVE_GLYPH,
  RANK_CHOICES,
  costText,
  isObjective,
  isWideGlyph,
  noteText,
  objectiveGlyph,
  rangeText,
  wantsNote,
} from "../public/js/plan/placements.js";

const objectiveItem = (id) => ({
  id,
  kind: "objective",
  name_ja: "ドリル位置",
  cost_supplies: null,
  range_min_m: null,
  range_max_m: null,
  verified: 1,
});

describe("KINDS", () => {
  it("カタログの4種別をすべて持つ", () => {
    expect(KINDS.map((k) => k.kind).sort()).toEqual(
      ["emplacement", "objective", "structure", "vehicle"]
    );
  });

  it("先頭は「試合の要素」（パレットは先頭グループだけ開くため）", () => {
    expect(KINDS[0]).toEqual({ kind: "objective", label: "試合の要素" });
  });
});

describe("isObjective", () => {
  it("kind で判定する", () => {
    expect(isObjective(objectiveItem("mk_drill"))).toBe(true);
    expect(isObjective({ kind: "structure" })).toBe(false);
    expect(isObjective(null)).toBe(false);
  });
});

describe("costText / rangeText", () => {
  it("試合の要素は何も返さない（「コスト不明」「射程不明」が並ぶと意味が無い）", () => {
    for (const id of Object.keys(OBJECTIVE_GLYPH)) {
      expect(costText(objectiveItem(id)), `${id} のコスト`).toBe("");
      expect(rangeText(objectiveItem(id)), `${id} の射程`).toBe("");
    }
  });

  it("ゲームデータ由来の項目の文言は変えない", () => {
    expect(costText({ kind: "structure", cost_supplies: 30 })).toBe("物資 30");
    expect(costText({ kind: "vehicle", cost_supplies: null })).toBe("コスト不明");
    expect(rangeText({ kind: "structure", range_max_m: null })).toBe("射程不明");
    expect(rangeText({ kind: "emplacement", range_min_m: 80, range_max_m: 684 }))
      .toBe("射程 80–684m");
    expect(rangeText({ kind: "vehicle", range_max_m: 2600 })).toBe("射程 2600m");
  });
});

describe("OBJECTIVE_GLYPH", () => {
  it("schema.sql の9件と1対1で対応する", () => {
    expect(Object.keys(OBJECTIVE_GLYPH).sort()).toEqual([
      "mk_attack", "mk_danger", "mk_defend", "mk_drill",
      "mk_enemy_fob", "mk_hotzone", "mk_hq", "mk_note", "mk_spawn",
    ]);
  });

  it("ドリル位置と HQ のグリフは D と H", () => {
    expect(objectiveGlyph("mk_drill").glyph).toBe("D");
    expect(objectiveGlyph("mk_hq").glyph).toBe("H");
  });

  it("色は既存トークンの名前だけを使う（新しい色を足さない）", () => {
    const allowed = new Set(["blue", "green", "hot", "red", "muted"]);
    for (const [id, g] of Object.entries(OBJECTIVE_GLYPH)) {
      expect(allowed.has(g.color), `${id} の色 ${g.color}`).toBe(true);
      expect(typeof g.glyph, `${id} のグリフ`).toBe("string");
      expect(g.glyph.length, `${id} のグリフ`).toBeGreaterThan(0);
    }
  });

  it("知らない item_id には null を返す", () => {
    expect(objectiveGlyph("bunker")).toBe(null);
    expect(objectiveGlyph(undefined)).toBe(null);
  });
});

describe("isWideGlyph", () => {
  // 全角はそのまま置くとピンの頭（直径 12.5px ほど）からはみ出すので、
  // 描く側が幅を詰める。その判定。
  it("全角だけ true", () => {
    expect(isWideGlyph("守")).toBe(true);
    expect(isWideGlyph("攻")).toBe(true);
    expect(isWideGlyph("＊")).toBe(true);
    expect(isWideGlyph("D")).toBe(false);
    expect(isWideGlyph("!")).toBe(false);
  });

  it("空や未定義でも落ちない", () => {
    expect(isWideGlyph("")).toBe(false);
    expect(isWideGlyph(undefined)).toBe(false);
    expect(isWideGlyph(null)).toBe(false);
  });
});

// 注記（placements.label）を地図の上に出すときの文字。
// 「ここ守ろう」は選んでいなくても見えていないと意味が無いので常時出すが、
// 全部を全文で出すと 16km 四方が文字で埋まる。視野の広さで切り替える。
describe("noteText", () => {
  it("寄っているとき（視野が閾値以下）は全文を出す", () => {
    expect(noteText("北の橋を先に落とす", NOTE_FULL_VIEW_M)).toBe("北の橋を先に落とす");
    expect(noteText("北の橋を先に落とす", 1200)).toBe("北の橋を先に落とす");
  });

  it("視野が広いときは先頭6文字＋「…」にする", () => {
    expect(noteText("北の橋を先に落とす", NOTE_FULL_VIEW_M + 1)).toBe("北の橋を先に…");
    expect(noteText("北の橋を先に落とす", 16000)).toBe("北の橋を先に…");
  });

  it("短い注記は視野が広くても省略しない（「…」だけ増えるのは邪魔）", () => {
    expect(noteText("ここ守ろう", 16000)).toBe("ここ守ろう");
    expect(noteText("123456", 16000)).toBe("123456");
    expect(noteText("1234567", 16000)).toBe("123456…");
  });

  it("注記が無ければ空文字（項目名を出すのは呼ぶ側の判断）", () => {
    expect(noteText(null, 16000)).toBe("");
    expect(noteText(undefined, 1000)).toBe("");
    expect(noteText("   ", 1000)).toBe("");
  });

  it("サロゲートペアを1文字として数える（サーバの文字数と同じ数え方）", () => {
    // 8文字（コードポイント）。UTF-16 の length は 16 になる。
    const s = "🚩🚩🚩🚩🚩🚩🚩🚩";
    expect(noteText(s, 16000)).toBe("🚩🚩🚩🚩🚩🚩…");
  });

  it("先頭6文字という取り決めが定数と一致している", () => {
    expect(NOTE_SHORT_LEN).toBe(6);
    expect(NOTE_FULL_VIEW_M).toBe(4000);
  });
});

// 「置く → 書く」を1動作にする対象。位置に紐づく判断を書くために置く記号。
describe("NOTE_ITEM_IDS / wantsNote", () => {
  it("メモ系の4件だけ true", () => {
    expect([...NOTE_ITEM_IDS].sort()).toEqual(
      ["mk_attack", "mk_danger", "mk_defend", "mk_note"]
    );
    for (const id of NOTE_ITEM_IDS) expect(wantsNote(id), id).toBe(true);
    for (const id of ["mk_drill", "mk_hq", "mk_spawn", "mk_enemy_fob", "bunker", undefined]) {
      expect(wantsNote(id), String(id)).toBe(false);
    }
  });

  it("すべて作図用の記号として定義済み（知らない item_id を指していない）", () => {
    for (const id of NOTE_ITEM_IDS) expect(objectiveGlyph(id), id).not.toBe(null);
  });
});

describe("RANK_CHOICES / LABEL_MAX_LEN", () => {
  it("優先度は 1〜9（マーカーの中に1桁で描くため）", () => {
    expect(RANK_CHOICES).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("注記の上限はサーバ（placements.js の LABEL_MAX）と同じ48文字", () => {
    expect(LABEL_MAX_LEN).toBe(48);
  });
});
