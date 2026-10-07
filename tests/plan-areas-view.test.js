// エリア塗り（areas.js）のうち、DOM を触らない計算だけの単体テスト。
//
// サーバは「1ジェスチャ = 1行」の追記型で持っている（設計書 §3-A-1）。
// 画面に出すには、行を id の昇順に走査して op（add / sub）を適用し、
// 種類ごとのセル集合を得る必要がある。その計算と、集合から
//   * 塗りの path（セルを全部まとめた1本）
//   * 外周だけの path（隣に仲間がいない辺だけ）
//   * 種類名を置く位置（重心にいちばん近いセルの中心）
//   * 「自陣 12マス ／ 敵陣 8マス」の集計
// を作るところまでをここで見る。256セル × 5種なので毎回フル再計算でよい。
import { describe, it, expect } from "vitest";
import {
  AREA_KINDS, AREA_NAME_VIEW_M, PATTERN_PX,
  areaLabel, buildAreaSets, cellAtSvg, cellIndex, countText,
  edgePathData, fillPathData, hasCell, labelAnchor, normalizeRect, rectText,
} from "../public/js/plan/areas.js";

/** バクラニと同じ 16×16 の 1km グリッド。 */
const GRID = { cols: 16, rows: 16, cellM: 1000 };
/** 数えやすい小さい盤。 */
const SMALL = { cols: 4, rows: 4, cellM: 1000 };

const row = (id, kind, op, rects, cell_m = 1000) => ({ id, kind, op, cell_m, rects });

/** 集合を「列,行」の読みやすい並びにする（添字の計算をテスト側で二度書かない）。 */
const cellsOf = (set, grid) =>
  [...set].sort((a, b) => a - b).map((i) => [i % grid.cols, Math.floor(i / grid.cols)]);

describe("種類", () => {
  // **ゲームの用語と衝突する名前は持たない。**「コントロールエリア」も
  // 「ホットゾーン」もゲームが決めて画面に出すもの（円）で、手では描かない。
  // ここにあるのは全部「チームが手で塗る見立て」である。
  it("5つに確定していて、表示名が引ける", () => {
    expect(AREA_KINDS.map((k) => k.kind)).toEqual(["own", "enemy", "neutral", "key", "risk"]);
    expect(areaLabel("enemy")).toBe("敵陣");
    expect(areaLabel("key")).toBe("最重要");
    expect(areaLabel("risk")).toBe("危険予測");
    // 未知の種類でも黙って空にしない（生の値を出す）。
    expect(areaLabel("unknown")).toBe("unknown");
  });

  it("ゲームが決める語（コントロールエリア・ホットゾーン）を表示名に持たない", () => {
    const labels = AREA_KINDS.map((k) => k.label).join(" ");
    expect(labels).not.toContain("コントロール");
    expect(labels).not.toContain("ホットゾーン");
    // 廃止した種類は表示名も引けない（生の値がそのまま出る）。
    expect(areaLabel("control")).toBe("control");
    expect(areaLabel("hot")).toBe("hot");
  });

  it("パターンの大きさと、種類名を出す視野の広さを持っている", () => {
    expect(PATTERN_PX).toBe(8);
    expect(AREA_NAME_VIEW_M).toBe(2000);
  });
});

describe("buildAreaSets", () => {
  it("種類ごとに集合を作り、矩形の中のセルを全部入れる", () => {
    const sets = buildAreaSets([row(1, "enemy", "add", [[3, 7, 5, 9]])], GRID);
    // 3×3 = 9マス
    expect(sets.get("enemy").size).toBe(9);
    expect(hasCell(sets, "enemy", 3, 7, GRID)).toBe(true);
    expect(hasCell(sets, "enemy", 5, 9, GRID)).toBe(true);
    expect(hasCell(sets, "enemy", 6, 9, GRID)).toBe(false);
    // 他の種類は空のまま（キーは5つとも作る）。
    expect([...sets.keys()]).toEqual(["own", "enemy", "neutral", "key", "risk"]);
    expect(sets.get("own").size).toBe(0);
  });

  it("id の昇順に add / sub を適用する（順番が結果を変える）", () => {
    const add = row(1, "own", "add", [[0, 0, 2, 0]]);
    const sub = row(2, "own", "sub", [[1, 0, 1, 0]]);
    expect(cellsOf(buildAreaSets([add, sub], SMALL).get("own"), SMALL))
      .toEqual([[0, 0], [2, 0]]);
    // 逆順に渡しても id で並べ替えるので結果は同じ。
    expect(cellsOf(buildAreaSets([sub, add], SMALL).get("own"), SMALL))
      .toEqual([[0, 0], [2, 0]]);
    // 引いてから足せば残る（id の順が逆なら結果も逆）。
    const addLater = row(3, "own", "add", [[1, 0, 1, 0]]);
    expect(buildAreaSets([add, sub, addLater], SMALL).get("own").size).toBe(3);
  });

  it("まだ id の無い行（自分が今塗ったぶん）は、サーバの行より後に適用する", () => {
    const fromServer = row(9, "risk", "add", [[0, 0, 1, 1]]);
    const mine = { id: null, kind: "risk", op: "sub", cell_m: 1000, rects: [[0, 0, 0, 0]] };
    const sets = buildAreaSets([mine, fromServer], SMALL);
    expect(cellsOf(sets.get("risk"), SMALL)).toEqual([[1, 0], [0, 1], [1, 1]]);
  });

  it("1行に複数の矩形が入っていても全部足す", () => {
    const sets = buildAreaSets([row(1, "key", "add", [[0, 0, 0, 0], [3, 3, 3, 3]])], SMALL);
    expect(cellsOf(sets.get("key"), SMALL)).toEqual([[0, 0], [3, 3]]);
  });

  it("種類が別なら同じセルを重ねて持てる（自陣と敵陣は互いを消さない）", () => {
    const sets = buildAreaSets([
      row(1, "own", "add", [[1, 1, 1, 1]]),
      row(2, "enemy", "add", [[1, 1, 1, 1]]),
    ], SMALL);
    expect(hasCell(sets, "own", 1, 1, SMALL)).toBe(true);
    expect(hasCell(sets, "enemy", 1, 1, SMALL)).toBe(true);
  });

  it("未知の種類・壊れた矩形・刻みの違う行は、地図を落とさずに読み飛ばす", () => {
    const sets = buildAreaSets([
      row(1, "zzz", "add", [[0, 0, 1, 1]]),          // 未知の種類
      row(2, "own", "add", "not-an-array"),          // rects が配列でない
      row(3, "own", "add", [[0, 0]]),                // 長さが足りない
      row(4, "own", "add", [[0, 0, 0, 0]], 250),     // 1km グリッドに載らない刻み
      row(5, "own", "add", [[2, 2, 2, 2]]),          // これだけ有効
    ], SMALL);
    expect(cellsOf(sets.get("own"), SMALL)).toEqual([[2, 2]]);
  });

  it("盤の外へはみ出した矩形は、入っているぶんだけ塗る", () => {
    // サーバは範囲外を 400 で弾くので、ここに来るのは想定外の行。落とさない。
    const sets = buildAreaSets([row(1, "own", "add", [[2, 2, 99, 99]])], SMALL);
    expect(cellsOf(sets.get("own"), SMALL))
      .toEqual([[2, 2], [3, 2], [2, 3], [3, 3]]);
  });
});

describe("fillPathData", () => {
  it("セルごとに1つの閉じた部分パスを作る", () => {
    const sets = buildAreaSets([row(1, "own", "add", [[0, 0, 1, 0]])], SMALL);
    const d = fillPathData(sets.get("own"), SMALL);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).toContain("M 0 0 h 1000 v 1000 h -1000 Z");
    expect(d).toContain("M 1000 0 h 1000 v 1000 h -1000 Z");
  });

  it("空の集合では空文字（属性に置いても何も描かない）", () => {
    expect(fillPathData(new Set(), SMALL)).toBe("");
  });
});

describe("edgePathData", () => {
  it("外周だけを引く（仲間どうしが接する辺は引かない）", () => {
    const sets = buildAreaSets([row(1, "enemy", "add", [[0, 0, 1, 0]])], SMALL);
    const d = edgePathData(sets.get("enemy"), SMALL);
    // 2セルなら辺は 8 本あるが、接している 1 本ぶん（2辺）は出ないので 6 本。
    expect(d.match(/M/g)).toHaveLength(6);
    // 接している縦の辺（x=1000）は出ない。
    expect(d).not.toContain("M 1000 0 L 1000 1000");
    // 外側の縦の辺は両方出る。
    expect(d).toContain("M 0 0 L 0 1000");
    expect(d).toContain("M 2000 0 L 2000 1000");
  });

  it("3×3 の塊なら外周の 12 辺だけになる", () => {
    const sets = buildAreaSets([row(1, "risk", "add", [[0, 0, 2, 2]])], GRID);
    expect(edgePathData(sets.get("risk"), GRID).match(/M/g)).toHaveLength(12);
  });

  it("空の集合では空文字", () => {
    expect(edgePathData(new Set(), SMALL)).toBe("");
  });
});

describe("labelAnchor", () => {
  it("重心にいちばん近いセルの中心を返す", () => {
    const sets = buildAreaSets([row(1, "own", "add", [[0, 0, 2, 2]])], GRID);
    expect(labelAnchor(sets.get("own"), GRID)).toEqual({ x: 1500, y: 1500 });
  });

  it("飛び地があっても、集合の中のセルの上に置く（何も無い所に文字を置かない）", () => {
    const sets = buildAreaSets([row(1, "own", "add", [[0, 0, 0, 0], [3, 3, 3, 3]])], SMALL);
    const at = labelAnchor(sets.get("own"), SMALL);
    expect([{ x: 500, y: 500 }, { x: 3500, y: 3500 }]).toContainEqual(at);
  });

  it("空の集合では null（置き場所が無い）", () => {
    expect(labelAnchor(new Set(), SMALL)).toBe(null);
  });
});

describe("集計", () => {
  it("塗ってある種類だけを「自陣 12マス ／ 敵陣 8マス」の形で出す", () => {
    const sets = buildAreaSets([
      row(1, "own", "add", [[0, 0, 3, 2]]),     // 4×3 = 12
      row(2, "enemy", "add", [[0, 0, 3, 1]]),   // 4×2 = 8
    ], SMALL);
    expect(countText(sets)).toBe("自陣 12マス ／ 敵陣 8マス");
  });

  it("1つも塗っていなければ、その旨を出す（空文字で黙らない）", () => {
    expect(countText(buildAreaSets([], SMALL))).toBe("まだ塗っていません");
  });
});

describe("座標とセルの行き来", () => {
  it("SVG 座標（上が row 0）からセルを引く", () => {
    expect(cellAtSvg({ x: 0, y: 0 }, GRID)).toEqual({ col: 0, row: 0 });
    expect(cellAtSvg({ x: 7500, y: 7500 }, GRID)).toEqual({ col: 7, row: 7 });
    // 右端・下端はぴったりでも最後のセルに入れる（縁を押しても外扱いにしない）。
    expect(cellAtSvg({ x: 16000, y: 16000 }, GRID)).toEqual({ col: 15, row: 15 });
    // 盤の外は null（丸めない）。
    expect(cellAtSvg({ x: -1, y: 100 }, GRID)).toBe(null);
    expect(cellAtSvg({ x: 100, y: 16001 }, GRID)).toBe(null);
  });

  it("押した所と離した所から、向きによらない矩形を作る", () => {
    expect(normalizeRect({ col: 5, row: 9 }, { col: 3, row: 7 })).toEqual([3, 7, 5, 9]);
    expect(normalizeRect({ col: 3, row: 7 }, { col: 5, row: 9 })).toEqual([3, 7, 5, 9]);
    expect(normalizeRect({ col: 2, row: 2 }, { col: 2, row: 2 })).toEqual([2, 2, 2, 2]);
  });

  it("ドラッグ中に出す「3×2 = 6マス」の文字", () => {
    expect(rectText([3, 7, 5, 8])).toBe("3×2 = 6マス");
    expect(rectText([2, 2, 2, 2])).toBe("1×1 = 1マス");
  });

  it("セル番号は行優先（描画と集合で同じ数え方をする）", () => {
    expect(cellIndex(0, 0, GRID)).toBe(0);
    expect(cellIndex(15, 0, GRID)).toBe(15);
    expect(cellIndex(0, 1, GRID)).toBe(16);
  });
});
