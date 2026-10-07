// 作戦一覧の並べ方。DOM を触らない計算だけ。
//
// D-046 の「作戦は試合ごとの記録ではなく、マップ × パターンごとの準備」から来ている。
// 総数が 3マップ × 3〜4パターン ＝ 9〜12 件で頭打ちになるので、絞り込みではなく
// **並べ方**で探せるようにする。試合が始まってから「今日は Default」で開くときに、
// 同じ作戦がいつも同じ場所にいることが速さになるので、順序は更新時刻ではなく
// マップ名とパターンで決める（更新順だと毎回位置が変わる）。
import { describe, it, expect } from "vitest";

import { buildPatternGrid, groupSessionsByMap, patternName } from "../public/js/plan/sessions.js";

/** 一覧の1行。サーバ（GET /api/sessions）が返す形に合わせた最小の形。 */
const row = (over = {}) => ({
  id: "x",
  map_id: "bakurani",
  map_name: "Bakurani",
  title: "作戦",
  updated_at: 1000,
  zone_preset_id: null,
  zone_key: null,
  zone_name: null,
  zone_sort: null,
  ...over,
});

/** パターン付きの行。サーバは name と sort_order を一緒に返す。 */
const withPattern = (key, sort, over = {}) =>
  row({ zone_preset_id: `p-${key}`, zone_key: key, zone_name: key, zone_sort: sort, ...over });

describe("patternName", () => {
  it("パターンが設定されていれば表示名を返す", () => {
    expect(patternName(withPattern("Default", 10))).toBe("Default");
  });

  it("表示名が空なら key で代用する", () => {
    expect(patternName(row({ zone_preset_id: "p1", zone_key: "Farmland", zone_name: "" })))
      .toBe("Farmland");
  });

  it("未設定なら null", () => {
    expect(patternName(row())).toBe(null);
  });

  // プリセットを消す API は session_zone も消すので普段は起きないが、
  // 消し損ねた行があっても「名前の無いパターン」を画面に出さない。
  it("プリセットが消えていて名前が取れないなら未設定として扱う", () => {
    expect(patternName(row({ zone_preset_id: "gone" }))).toBe(null);
  });
});

describe("groupSessionsByMap", () => {
  it("0件なら空の配列", () => {
    expect(groupSessionsByMap([])).toEqual([]);
  });

  it("マップごとにまとめ、マップ名の順に並べる", () => {
    const groups = groupSessionsByMap([
      row({ id: "z", map_id: "zestafona", map_name: "Zestafona" }),
      row({ id: "b", map_id: "bakurani", map_name: "Bakurani" }),
      row({ id: "o", map_id: "ozeti", map_name: "Ozeti" }),
      row({ id: "b2", map_id: "bakurani", map_name: "Bakurani" }),
    ]);
    expect(groups.map((g) => g.map_id)).toEqual(["bakurani", "ozeti", "zestafona"]);
    expect(groups[0].map_name).toBe("Bakurani");
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["b", "b2"]);
  });

  it("同じマップの中はパターンの並び順（sort_order）で並ぶ", () => {
    const groups = groupSessionsByMap([
      withPattern("Lumberyard", 30, { id: "l" }),
      withPattern("Default", 10, { id: "d" }),
      withPattern("Farmland", 20, { id: "f" }),
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["d", "f", "l"]);
  });

  it("並び順が同じパターンは名前順、それも同じなら更新の新しい順", () => {
    const groups = groupSessionsByMap([
      withPattern("Default", 100, { id: "d-old", updated_at: 10 }),
      withPattern("Default", 100, { id: "d-new", updated_at: 99 }),
      withPattern("Apple", 100, { id: "a" }),
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a", "d-new", "d-old"]);
  });

  // 既存の作戦はパターン未設定。**隠さない。**
  // 同じマップの末尾に置いて、更新の新しい順にする。
  it("パターン未設定の作戦は同じマップの末尾に出る（消えない）", () => {
    const groups = groupSessionsByMap([
      row({ id: "none-old", updated_at: 10 }),
      withPattern("Default", 10, { id: "d" }),
      row({ id: "none-new", updated_at: 99 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["d", "none-new", "none-old"]);
  });

  it("パターンが1件も無いマップでも、そのマップの区画は出る", () => {
    const groups = groupSessionsByMap([row({ id: "a" }), row({ id: "b", updated_at: 2000 })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("元の配列を書き換えない", () => {
    const list = [row({ id: "b", updated_at: 1 }), row({ id: "a", updated_at: 2 })];
    groupSessionsByMap(list);
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
  });
});

// ── 「9つの枠」の組み立て ──────────────────────────────────────
//
// オーナー指摘（2026-10-01、作戦1件の実画面を見て）: 「これでいいとおもってます？」
//
// 問題は主従が逆だったこと。左に大きく作成フォーム、右に小さく一覧で、
// **まだ作っていないマップ × パターンの枠が画面に存在しなかった。**
// 9つのうち何が埋まっていて何が空いているかが読めない。
//
// D-046 の目的3 では、作戦は 9〜12 個作ったら終わりで、あとは何度も開くもの。
// だから一覧は**枠の表**にする。埋まっている枠は「開く」、空の枠は「作る」。
//
// **件数を固定値で持たない。** プリセットは今後も増減するので、
// サーバから返ってきた行数だけ枠を描く。ここはその組み立てだけを見る。
describe("buildPatternGrid", () => {
  /** `/api/maps` が返す形（必要な列だけ）。 */
  const map = (id, name, presets = []) => ({ id, name, presets });
  const preset = (id, name, sort) => ({ id, map_id: "bakurani", key: name, name, sort_order: sort });

  const BAKURANI = map("bakurani", "Bakurani", [
    preset("b-default", "Default", 10),
    preset("b-farm", "Farmland", 20),
    preset("b-lumber", "Lumberyard", 30),
  ]);

  it("マップが0件なら空（まだ何も読めていない画面を作らない）", () => {
    expect(buildPatternGrid([], []).groups).toEqual([]);
  });

  it("作戦が1件も無くても、プリセットの数だけ枠が並ぶ", () => {
    const { groups, ready, total } = buildPatternGrid([BAKURANI], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].cells.map((c) => c.preset_id)).toEqual(["b-default", "b-farm", "b-lumber"]);
    expect(groups[0].cells.every((c) => c.sessions.length === 0)).toBe(true);
    expect({ ready, total }).toEqual({ ready: 0, total: 3 });
  });

  it("枠はプリセットの sort_order の順（名前順にしない）", () => {
    const shuffled = map("bakurani", "Bakurani", [
      preset("b-lumber", "Lumberyard", 30),
      preset("b-default", "Default", 10),
      preset("b-farm", "Farmland", 20),
    ]);
    const { groups } = buildPatternGrid([shuffled], []);
    expect(groups[0].cells.map((c) => c.pattern_name))
      .toEqual(["Default", "Farmland", "Lumberyard"]);
  });

  it("マップの区画はマップ名の順（試合中に同じ場所にいることが速さになる）", () => {
    const { groups } = buildPatternGrid(
      [map("zestafona", "Zestafona"), map("ozeti", "Ozeti"), map("bakurani", "Bakurani")],
      []
    );
    expect(groups.map((g) => g.map_id)).toEqual(["bakurani", "ozeti", "zestafona"]);
  });

  it("作戦が枠に入り、埋まった枠の数を数える", () => {
    const { groups, ready, total } = buildPatternGrid([BAKURANI], [
      row({ id: "s1", zone_preset_id: "b-default" }),
      row({ id: "s2", zone_preset_id: "b-lumber" }),
    ]);
    const cells = groups[0].cells;
    expect(cells[0].sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(cells[1].sessions).toEqual([]);
    expect(cells[2].sessions.map((s) => s.id)).toEqual(["s2"]);
    expect({ ready, total }).toEqual({ ready: 2, total: 3 });
    expect(groups[0].ready).toBe(2);
  });

  // **1枠1作戦を前提にしない。** 同じパターンに複数の案を置きたいことがある
  // （「初動」と「巻き返し」など）。枠を潰さず、枠の中に行を積む。
  it("同じ枠に複数あっても枠は増えない。中は更新の新しい順", () => {
    const { groups, ready, total } = buildPatternGrid([BAKURANI], [
      row({ id: "old", zone_preset_id: "b-default", updated_at: 10 }),
      row({ id: "new", zone_preset_id: "b-default", updated_at: 99 }),
    ]);
    expect(groups[0].cells).toHaveLength(3);
    expect(groups[0].cells[0].sessions.map((s) => s.id)).toEqual(["new", "old"]);
    expect({ ready, total }).toEqual({ ready: 1, total: 3 });
  });

  // 既存の4件はパターン未設定。**隠さない。**枠の表には入らないので別区画に出す。
  it("パターン未設定の作戦はそのマップの別区画に出る（枠の数には数えない）", () => {
    const { groups, ready, total } = buildPatternGrid([BAKURANI], [
      row({ id: "none", updated_at: 50 }),
      row({ id: "none2", updated_at: 80 }),
    ]);
    expect(groups[0].extra.map((s) => s.id)).toEqual(["none2", "none"]);
    expect({ ready, total }).toEqual({ ready: 0, total: 3 });
  });

  // プリセットを消す API は session_zone も消すので普段は起きないが、
  // 行き場を失った作戦を一覧から落とさない。
  it("消えたプリセットを指している作戦も別区画に出る（消えない）", () => {
    const { groups } = buildPatternGrid([BAKURANI], [
      row({ id: "orphan", zone_preset_id: "gone", zone_name: "Gone" }),
    ]);
    expect(groups[0].cells.every((c) => c.sessions.length === 0)).toBe(true);
    expect(groups[0].extra.map((s) => s.id)).toEqual(["orphan"]);
  });

  // プリセットが1件も無いマップは枠が作れない。**作る導線を失わせない**ために、
  // そのマップは「枠0」のまま区画だけ出し、画面側が別の入口を出せるようにする。
  it("プリセットが無いマップは枠0の区画として出る", () => {
    const { groups, total } = buildPatternGrid([map("ozeti", "Ozeti")], [
      row({ id: "o", map_id: "ozeti", map_name: "Ozeti" }),
    ]);
    expect(groups[0].cells).toEqual([]);
    expect(groups[0].extra.map((s) => s.id)).toEqual(["o"]);
    expect(total).toBe(0);
  });

  it("元の配列を書き換えない", () => {
    const list = [row({ id: "b", updated_at: 1 }), row({ id: "a", updated_at: 2 })];
    buildPatternGrid([BAKURANI], list);
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
  });
});
