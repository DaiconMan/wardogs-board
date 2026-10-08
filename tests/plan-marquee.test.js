// 範囲選択の枠の計算。**DOM を使わない所だけ**を見る。
//
// 枠に入るかどうかは「点が矩形の中にあるか」で決める（配置も地名も1点で表す）。
// 形で判定しない理由: マーカーも地名の点も**画面基準の大きさ**なので、
// 当たり判定を形に合わせるとズームで選べるものが変わる。

import { describe, expect, it } from "vitest";

import {
  boxContains, mineOf, normalizeBox, pickInBox, selectionText,
} from "../public/js/plan/marquee.js";

describe("枠の正規化", () => {
  it("どちらの角から引いても同じ矩形になる", () => {
    const a = { x_m: 300, y_m: 400 };
    const b = { x_m: 100, y_m: 200 };
    expect(normalizeBox(a, b)).toEqual({ x0: 100, y0: 200, x1: 300, y1: 400 });
    expect(normalizeBox(b, a)).toEqual({ x0: 100, y0: 200, x1: 300, y1: 400 });
  });

  it("1点に潰れた枠も矩形として扱う（幅0）", () => {
    const p = { x_m: 5, y_m: 6 };
    expect(normalizeBox(p, p)).toEqual({ x0: 5, y0: 6, x1: 5, y1: 6 });
  });
});

describe("枠に入るかの判定", () => {
  const box = { x0: 100, y0: 100, x1: 200, y1: 200 };

  it("中にあるものは入る", () => {
    expect(boxContains(box, { x_m: 150, y_m: 150 })).toBe(true);
  });

  // 縁ちょうどは「中」に数える。コントロールエリアの円（zones.js）と同じ約束で、
  // 片方だけ違うと「同じ所を囲ったのに結果が違う」が起きる。
  it("縁ちょうどは中に数える", () => {
    expect(boxContains(box, { x_m: 100, y_m: 100 })).toBe(true);
    expect(boxContains(box, { x_m: 200, y_m: 200 })).toBe(true);
    expect(boxContains(box, { x_m: 100, y_m: 200 })).toBe(true);
  });

  it("外にあるものは入らない", () => {
    expect(boxContains(box, { x_m: 99.9, y_m: 150 })).toBe(false);
    expect(boxContains(box, { x_m: 150, y_m: 200.1 })).toBe(false);
  });
});

describe("枠の中のものを拾う", () => {
  const items = [
    { uid: 1, x_m: 10, y_m: 10 },
    { uid: 2, x_m: 150, y_m: 150 },
    { uid: 3, x_m: 200, y_m: 100 },
    { uid: 4, x_m: 900, y_m: 900 },
  ];

  it("枠の中のものだけを、並び順のまま返す", () => {
    const got = pickInBox(items, { x0: 100, y0: 100, x1: 200, y1: 200 });
    expect(got.map((i) => i.uid)).toEqual([2, 3]);
  });

  it("1件も入らなければ空", () => {
    expect(pickInBox(items, { x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual([]);
  });

  it("入れ物が空でも落ちない", () => {
    expect(pickInBox([], { x0: 0, y0: 0, x1: 10, y1: 10 })).toEqual([]);
  });
});

describe("自分のものだけを分ける", () => {
  // 他人のものはサーバが 403 を返す（admin は例外）。**UI を「押せるのに
  // 403 になる」形にしない**ので、操作する前に分けておく。
  const items = [
    { uid: 1, created_by: "me" },
    { uid: 2, created_by: "you" },
    { uid: 3, created_by: "me" },
  ];
  const canEdit = (o) => o.created_by === "me";

  it("自分のものだけを抜き出す", () => {
    expect(mineOf(items, canEdit).map((i) => i.uid)).toEqual([1, 3]);
  });

  it("全部が他人のものなら空", () => {
    expect(mineOf(items, () => false)).toEqual([]);
  });
});

describe("件数の文言", () => {
  // 他人のものが混ざっているときは**件数を分けて見せる**。
  it("他人のものが混ざっていたら、内訳を出す", () => {
    expect(selectionText(7, 4)).toBe("7件を選択（うち自分のもの 4件）");
  });

  it("全部が自分のものなら、内訳を出さない（同じ数を2回言わない）", () => {
    expect(selectionText(4, 4)).toBe("4件を選択");
  });

  it("1件も自分のものが無いときも内訳を出す（操作できないことが伝わる）", () => {
    expect(selectionText(3, 0)).toBe("3件を選択（うち自分のもの 0件）");
  });

  it("0件なら何も言わない", () => {
    expect(selectionText(0, 0)).toBe("");
  });
});
