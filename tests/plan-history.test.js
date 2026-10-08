// 操作の台帳（戻す・やり直す）の積み方。**DOM もサーバも要らない所だけ**を見る。
//
// ここで押さえたいのは3つ。
//   1. 新しい操作をしたら、やり直しの山は捨てる（分岐した履歴を持たない）
//   2. やり直しで積み直すときは、やり直しの山を捨てない（連続してやり直せる）
//   3. 戻すときに取る写しは**値の複製**で、元のオブジェクトを後で触っても変わらない
//      （やり直しは消えたものを作り直すので、参照を持っていても意味が無い）

import { describe, expect, it, vi } from "vitest";

import {
  canRedo, canUndo, dropDone, newHistory, onHistoryChange, pushUndone, record, recordReplay,
  restoreDone, snapshotOf, takeRedo, takeUndo,
} from "../public/js/plan/history.js";

describe("台帳の2つの山", () => {
  it("できたての台帳では、戻すこともやり直すこともできない", () => {
    const h = newHistory();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it("積んだら戻せる。戻したら空に戻る", () => {
    const h = newHistory();
    const entry = { placement: { item_id: "fob" } };
    record(h, entry);
    expect(canUndo(h)).toBe(true);
    expect(takeUndo(h)).toBe(entry);
    expect(canUndo(h)).toBe(false);
    expect(takeUndo(h)).toBeUndefined();
  });

  it("戻せなかったときは、取り出した項目をそのまま戻せる", () => {
    const h = newHistory();
    const entry = { area: { kind: "own" } };
    record(h, entry);
    const taken = takeUndo(h);
    restoreDone(h, taken);
    expect(canUndo(h)).toBe(true);
    expect(takeUndo(h)).toBe(entry);
  });

  it("やり直しの山は、積んだ順の逆から出てくる", () => {
    const h = newHistory();
    pushUndone(h, { kind: "callout", name: "A" });
    pushUndone(h, { kind: "callout", name: "B" });
    expect(canRedo(h)).toBe(true);
    expect(takeRedo(h).name).toBe("B");
    expect(takeRedo(h).name).toBe("A");
    expect(canRedo(h)).toBe(false);
    expect(takeRedo(h)).toBeUndefined();
  });

  // 受け入れ条件4。戻したあとに新しい操作をしたら、やり直しは押せなくなる。
  it("新しい操作を積むと、やり直しの山を捨てる", () => {
    const h = newHistory();
    pushUndone(h, { kind: "ink" });
    pushUndone(h, { kind: "ink" });
    record(h, { placement: {} });
    expect(canRedo(h)).toBe(false);
  });

  // 受け入れ条件2の土台。やり直しで積み直すときに山を捨てると、
  // 2件続けてやり直せなくなる。
  it("やり直しで積み直しても、やり直しの山は残る", () => {
    const h = newHistory();
    pushUndone(h, { kind: "ink" });
    pushUndone(h, { kind: "ink" });
    const left = takeRedo(h);
    expect(left).toBeDefined();
    recordReplay(h, { placement: {} });
    expect(canRedo(h)).toBe(true);
    expect(canUndo(h)).toBe(true);
  });

  it("画面から消えたものの項目を台帳から外す", () => {
    const h = newHistory();
    const gone = { placement: { uid: 1 } };
    record(h, gone);
    record(h, { placement: { uid: 2 } });
    expect(dropDone(h, (e) => e.placement?.uid === 1)).toBe(1);
    expect(h.done.map((e) => e.placement.uid)).toEqual([2]);
  });

  it("台帳に無いものを外そうとしても落ちない", () => {
    const h = newHistory();
    expect(dropDone(h, () => false)).toBe(0);
  });

  it("山が動いたら知らせる（ボタンの押せる・押せないを合わせるため）", () => {
    const h = newHistory();
    const seen = vi.fn();
    onHistoryChange(seen);
    try {
      record(h, { placement: {} });
      takeUndo(h);
      pushUndone(h, { kind: "placement" });
      takeRedo(h);
      restoreDone(h, { placement: {} });
      recordReplay(h, { placement: {} });
      expect(seen).toHaveBeenCalledTimes(6);
    } finally {
      onHistoryChange(null);
    }
  });
});

describe("戻すときに取る写し（やり直すのに必要な中身）", () => {
  it("配置は項目・座標・注記・優先度を持つ", () => {
    const p = { item_id: "fob", x_m: 100, y_m: 200, label: "ここ守ろう", rank: 3 };
    expect(snapshotOf({ placement: p })).toEqual({
      kind: "placement", item_id: "fob", x_m: 100, y_m: 200, label: "ここ守ろう", rank: 3,
    });
  });

  it("配置の注記と優先度は、無いときは null で揃える", () => {
    const p = { item_id: "hz", x_m: 1, y_m: 2 };
    expect(snapshotOf({ placement: p })).toEqual({
      kind: "placement", item_id: "hz", x_m: 1, y_m: 2, label: null, rank: null,
    });
  });

  it("地名は呼び名と座標を持つ", () => {
    expect(snapshotOf({ callout: { name: "あの丘", x_m: 10, y_m: 20 } })).toEqual({
      kind: "callout", name: "あの丘", x_m: 10, y_m: 20,
    });
  });

  it("エリアは種類・足し引き・マスの寸法・矩形を持つ", () => {
    const row = { kind: "own", op: "add", cell_m: 1000, rects: [[1, 2, 3, 4]] };
    expect(snapshotOf({ area: row })).toEqual({
      kind: "area", areaKind: "own", op: "add", cell_m: 1000, rects: [[1, 2, 3, 4]],
    });
  });

  it("線は色・太さ・点の列を持つ", () => {
    const ink = { color: "cursor-3", width: 2, points: [{ x_m: 1, y_m: 2 }, { x_m: 3, y_m: 4 }] };
    expect(snapshotOf({ ink })).toEqual({
      kind: "ink", color: "cursor-3", width: 2,
      points: [{ x_m: 1, y_m: 2 }, { x_m: 3, y_m: 4 }],
    });
  });

  // ここが肝。戻す ＝ 元のオブジェクトは画面から消えるので、参照を持っていても
  // やり直せない。値を複製しておく。
  it("写しは値の複製で、元を書き換えても変わらない", () => {
    const p = { item_id: "fob", x_m: 1, y_m: 2, label: "前", rank: 1 };
    const snap = snapshotOf({ placement: p });
    p.x_m = 999;
    p.label = "後";
    expect(snap.x_m).toBe(1);
    expect(snap.label).toBe("前");

    const row = { kind: "own", op: "add", cell_m: 1000, rects: [[1, 2, 3, 4]] };
    const areaSnap = snapshotOf({ area: row });
    row.rects[0][0] = 99;
    row.rects.push([5, 6, 7, 8]);
    expect(areaSnap.rects).toEqual([[1, 2, 3, 4]]);

    const ink = { color: "cursor-1", width: 3, points: [{ x_m: 1, y_m: 2 }] };
    const inkSnap = snapshotOf({ ink });
    ink.points[0].x_m = 99;
    expect(inkSnap.points).toEqual([{ x_m: 1, y_m: 2 }]);
  });

  it("やり直せない項目（中身を持たない線）は写しを作らない", () => {
    expect(snapshotOf({ path: {}, saving: Promise.resolve(1) })).toBe(null);
    expect(snapshotOf(undefined)).toBe(null);
  });
});
