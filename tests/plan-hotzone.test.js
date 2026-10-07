// ホットゾーン（半径 85m の円）。
//
// **なぜ専用の仕組みが要るのか**（D-052）
// ホットゾーンに入ると**人数が2倍に数えられる**。半径 85m の小さい円を押さえるだけで
// 兵力が倍になるので、「どこに来たらどう動くか」「どこへ引き寄せるか」は作戦の核心。
// しかも時間で動き、ドリルリグで引き寄せられる。**試合ごとに変わる想定**なので、
// マップ静的なプリセット（map_zone_presets）では持てない。
//
// **1km マス（session_areas）では代わりにならない。** 下の面積比のテストがその根拠で、
// 1km マス1つは実際のホットゾーンの約44倍の面積になる（別物であって近似ではない）。
//
// **持ち方は placements に相乗りする。** 円の半径は 85m 固定なので、行ごとに
// 半径を持つ必要がない ＝ 点（x_m, y_m）だけで表せる。schema.sql の
// kind='objective' のブロックと同じ理屈で、新テーブルも新ルートも作らずに
// 「置く・動かす・消す・取り消す・権限・冪等」をそのまま使う。
import { describe, it, expect, beforeAll } from "vitest";

import { GRID_CELL_M } from "../public/js/plan/coords.js";
import {
  HOTZONE_ITEM_ID,
  HOTZONE_LABEL_TEXT,
  HOTZONE_LABEL_VIEW_M,
  HOTZONE_RADIUS_M,
  OBJECTIVE_GLYPH,
  hotzoneLabelVisibleAt,
  hotzoneNote,
  isHotzone,
  isWideGlyph,
  objectiveGlyph,
} from "../public/js/plan/placements.js";

import { startServers, stopServers, baseUrl, loginAs } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

async function newPlan(cookie) {
  const r = await fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ map_id: "bakurani", title: "ホットゾーン" }),
  });
  return (await r.json()).session.id;
}

const postPlacements = (cookie, planId, placements) =>
  fetch(url(`/api/sessions/${planId}/placements`), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ placements }),
  });

const patchPlacement = (cookie, planId, id, body) =>
  fetch(url(`/api/sessions/${planId}/placements?id=${id}`), {
    method: "PATCH",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const deletePlacement = (cookie, planId, id) =>
  fetch(url(`/api/sessions/${planId}/placements?id=${id}`), {
    method: "DELETE",
    headers: { cookie, origin: ORIGIN },
  });

async function getPlacements(cookie, planId) {
  const r = await fetch(url(`/api/sessions/${planId}/placements`), { headers: { cookie } });
  return (await r.json()).placements;
}

const hotzone = (uuid, over = {}) => ({
  client_uuid: uuid,
  item_id: HOTZONE_ITEM_ID,
  x_m: 8000,
  y_m: 7000,
  rotation: 0,
  ...over,
});

describe("円の寸法", () => {
  it("半径は 85m（調査値。実機スクリーンショットの実測ともほぼ一致する）", () => {
    expect(HOTZONE_RADIUS_M).toBe(85);
  });

  // **D-052 の「約11倍」は割り算が合っていない。** 挙げられている2つの面積
  // （1,000,000㎡ 対 22,700㎡）から出るのは **約44倍**。結論（マス塗りでは別物）は
  // 変わらないので、ここは実際に計算した値で固定する。
  it("1km マス1つは、この円の約44倍の面積がある（マス塗りでは代用できない根拠）", () => {
    const circle = Math.PI * HOTZONE_RADIUS_M ** 2;
    const cell = GRID_CELL_M ** 2;
    expect(Math.round(circle)).toBe(22698);
    expect(cell).toBe(1_000_000);
    // 「少し大きい」ではなく桁が違う。44倍の面を塗って同じものとして議論できない。
    expect(cell / circle).toBeGreaterThan(43);
    expect(cell / circle).toBeLessThan(45);
  });

  it("item_id で見分けられる（カタログの行と同じ識別子1つで決まる）", () => {
    expect(HOTZONE_ITEM_ID).toBe("mk_hotzone");
    expect(isHotzone({ id: HOTZONE_ITEM_ID })).toBe(true);
    expect(isHotzone({ id: "mk_drill" })).toBe(false);
    expect(isHotzone({ id: "fob" })).toBe(false);
    expect(isHotzone(null)).toBe(false);
  });
});

describe("「人数2倍」の伝え方", () => {
  it("地図に出す札は「人数」と「2」を含む（ただの円にしない）", () => {
    expect(HOTZONE_LABEL_TEXT).toContain("人数");
    expect(HOTZONE_LABEL_TEXT).toContain("2");
    // 寄ったときに円の縁へ添える札なので、長い文は入らない。
    expect([...HOTZONE_LABEL_TEXT].length).toBeLessThanOrEqual(6);
  });

  it("置いた直後の一言に、効果と半径と「未検証」が入る", () => {
    const note = hotzoneNote();
    expect(note).toContain("2倍");
    expect(note).toContain(`${HOTZONE_RADIUS_M}m`);
    expect(note).toContain("未検証");
  });

  it("札は寄ったときだけ出す（16km 四方では円が点になるので文字だけが残る）", () => {
    expect(HOTZONE_LABEL_VIEW_M).toBe(4000);
    expect(hotzoneLabelVisibleAt(HOTZONE_LABEL_VIEW_M)).toBe(true);
    expect(hotzoneLabelVisibleAt(HOTZONE_LABEL_VIEW_M - 1)).toBe(true);
    expect(hotzoneLabelVisibleAt(HOTZONE_LABEL_VIEW_M + 1)).toBe(false);
    expect(hotzoneLabelVisibleAt(16000)).toBe(false);
  });

  it("ピンの中の字は他の7種とぶつからず、幅を詰める経路に乗る", () => {
    const mark = objectiveGlyph(HOTZONE_ITEM_ID);
    expect(mark.glyph).toBe("倍");
    // 既存の黄色い記号（ドリル位置・ここから攻める）と同じ色。形はピンで共通なので、
    // 見分けるのは字のほう。
    expect(mark.color).toBe("hot");
    // 全角1文字なので、ピンの頭に収まる幅へ詰める（守・攻・＊ と同じ扱い）。
    expect(isWideGlyph(mark.glyph)).toBe(true);
    const glyphs = Object.values(OBJECTIVE_GLYPH).map((m) => m.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe("保存と取得（既存の placements API に相乗りする）", () => {
  it("カタログに kind=objective の1行として在る", async () => {
    const { cookie } = await loginAs("5080", "hz1");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    const item = items.find((i) => i.id === HOTZONE_ITEM_ID);
    expect(item, "mk_hotzone がカタログに無い").toBeTruthy();
    expect(item.kind).toBe("objective");
    // 名前そのものが効果を名乗る（パレットで選ぶ時点で何の円か分かる）。
    expect(item.name_ja).toContain("ホットゾーン");
    expect(item.name_ja).toContain("2倍");
    // 円の半径はカタログの列ではなくコード側の定数。カタログには測定値を入れない
    // （入れると「未検証」バッジの対象が2箇所に分かれる）。
    expect(item.range_max_m).toBeNull();
    expect(item.footprint_w_m).toBeNull();
    expect(item.verified).toBe(1);
  });

  it("置ける・複数置ける・GET で返る", async () => {
    const { cookie } = await loginAs("5081", "hz2");
    const planId = await newPlan(cookie);
    const r = await postPlacements(cookie, planId, [
      hotzone("hz-a", { label: "初動はここ" }),
      hotzone("hz-b", { x_m: 9000, y_m: 7500 }),
    ]);
    expect(r.status).toBe(201);

    const list = await getPlacements(cookie, planId);
    expect(list.length).toBe(2);
    expect(list.every((p) => p.item_id === HOTZONE_ITEM_ID)).toBe(true);
    expect(list[0].label).toBe("初動はここ");
    expect(list[1].x_m).toBe(9000);
  });

  it("同じ client_uuid を送り直しても増えない（冪等）", async () => {
    const { cookie } = await loginAs("5082", "hz3");
    const planId = await newPlan(cookie);
    await postPlacements(cookie, planId, [hotzone("hz-same")]);
    const again = await postPlacements(cookie, planId, [hotzone("hz-same")]);
    expect(again.status).toBe(201);
    expect((await getPlacements(cookie, planId)).length).toBe(1);
  });

  it("動かせる（PATCH で座標が変わる）", async () => {
    const { cookie } = await loginAs("5083", "hz4");
    const planId = await newPlan(cookie);
    const { ids } = await (await postPlacements(cookie, planId, [hotzone("hz-move")])).json();
    const r = await patchPlacement(cookie, planId, ids[0], { x_m: 1234, y_m: 5678 });
    expect(r.status).toBe(200);
    const [row] = await getPlacements(cookie, planId);
    expect(row.x_m).toBe(1234);
    expect(row.y_m).toBe(5678);
  });

  it("マップの外には置けない（円の縁ではなく中心で見る）", async () => {
    const { cookie } = await loginAs("5084", "hz5");
    const planId = await newPlan(cookie);
    const r = await postPlacements(cookie, planId, [hotzone("hz-out", { x_m: 20000 })]);
    expect(r.status).toBe(400);
  });

  it("消せるのは置いた本人（他の人のものは 403 で、消えずに残る）", async () => {
    const owner = await loginAs("5085", "hz6");
    const planId = await newPlan(owner.cookie);
    const { ids } = await (
      await postPlacements(owner.cookie, planId, [hotzone("hz-perm")])
    ).json();

    const other = await loginAs("5086", "hz7");
    const denied = await deletePlacement(other.cookie, planId, ids[0]);
    expect(denied.status).toBe(403);
    expect((await getPlacements(owner.cookie, planId)).length).toBe(1);

    const mine = await deletePlacement(owner.cookie, planId, ids[0]);
    expect(mine.status).toBe(200);
    expect((await getPlacements(owner.cookie, planId)).length).toBe(0);
  });

  it("他の人のものは動かせない（403）", async () => {
    const owner = await loginAs("5087", "hz8");
    const planId = await newPlan(owner.cookie);
    const { ids } = await (
      await postPlacements(owner.cookie, planId, [hotzone("hz-perm2")])
    ).json();

    const other = await loginAs("5088", "hz9");
    const r = await patchPlacement(other.cookie, planId, ids[0], { x_m: 100, y_m: 100 });
    expect(r.status).toBe(403);
    const [row] = await getPlacements(owner.cookie, planId);
    expect(row.x_m).toBe(8000);
  });
});
