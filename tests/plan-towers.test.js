// ドリルタワー（マップ固定の設備）が、作戦を開いた1往復で降りてくること。
//
// タワーはプレイヤーが置くものではない。位置は毎試合同じで、マップに最初から
// ある構造物なので、`placements`（チームが置いた物）とは別の経路で返す。
// 「作戦を開いたら最初から見えている」必要があるため、盤面の取得
// （GET /api/sessions/{id}）に相乗りさせる。別の GET を足すと、
// 初回描画が2往復になって「開いた直後だけ無い」瞬間ができる。
//
// FOB に建てる「ドリルリグ」（catalog_items.drill_rig）とは別物
// （docs/research/2026-09-29-zones-drills-data.md §4.4）。
import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

/** マップごとの本数（調査 §4.1）。数はマップの性質なので、ここに並べて持つ。 */
const TOWER_COUNT = { bakurani: 5, ozeti: 4, zestafona: 3 };

async function newPlan(cookie, mapId, title = "タワー") {
  const r = await fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ map_id: mapId, title }),
  });
  return (await r.json()).session.id;
}

const openPlan = async (cookie, planId) =>
  (await fetch(url(`/api/sessions/${planId}`), { headers: { cookie } })).json();

describe("GET /api/sessions/{id} の towers", () => {
  it("作戦を開いた1往復でドリルタワーが降りてくる（マップごとの本数）", async () => {
    const { cookie } = await loginAs("7601", "tw1");
    for (const [mapId, count] of Object.entries(TOWER_COUNT)) {
      const planId = await newPlan(cookie, mapId);
      const body = await openPlan(cookie, planId);
      expect(body.towers, `${mapId} に towers が無い`).toBeInstanceOf(Array);
      expect(body.towers.length, `${mapId} の本数`).toBe(count);
    }
  });

  it("そのマップのタワーだけを返す（他マップのものが混ざらない）", async () => {
    const { cookie } = await loginAs("7602", "tw2");
    const planId = await newPlan(cookie, "zestafona");
    const { towers } = await openPlan(cookie, planId);
    expect(towers.length).toBe(3);
    // 座標は Zestafona のもの。Bakurani（x 7,700〜8,400）とは重ならない帯にいる。
    for (const t of towers) {
      expect(t.x_m, `${t.name} の x_m`).toBeGreaterThan(6000);
      expect(t.x_m, `${t.name} の x_m`).toBeLessThan(7500);
    }
  });

  // ゲーム内でカーソルを合わせて読んだ値（オーナー、2026-09-29）。
  // API を通しても向きが変わらないことをここで押さえる。
  it("Zestafona の Tower 3 が、ゲーム内で読んだ座標のまま降りてくる", async () => {
    const { cookie } = await loginAs("7606", "tw6");
    const planId = await newPlan(cookie, "zestafona");
    const { towers, map } = await openPlan(cookie, planId);
    const t3 = towers.find((t) => t.name === "Tower 3");
    expect(t3, "Tower 3 が無い").toBeTruthy();
    // ゲームの表示は x70.01 y100.31（= 7,001m / 10,031m）。
    expect(Math.abs(t3.x_m - 7001), "x のずれ").toBeLessThan(25);
    expect(Math.abs(t3.y_m - 10031), "y のずれ").toBeLessThan(25);
    // 上下を取り違えていない（反転すると 6,353m 付近になる）。
    expect(t3.y_m).toBeGreaterThan(map.height_m / 2);
  });

  it("1本ぶんに名前と座標が揃っている", async () => {
    const { cookie } = await loginAs("7603", "tw3");
    const planId = await newPlan(cookie, "bakurani");
    const { towers } = await openPlan(cookie, planId);
    for (const t of towers) {
      expect(typeof t.id, "id").toBe("string");
      expect(typeof t.name, "name").toBe("string");
      expect(t.name.length, "name が空").toBeGreaterThan(0);
      expect(Number.isFinite(t.x_m), `${t.name} の x_m`).toBe(true);
      expect(Number.isFinite(t.y_m), `${t.name} の y_m`).toBe(true);
    }
    const names = towers.map((t) => t.name);
    expect(new Set(names).size, "名前が重複している").toBe(towers.length);
    // 並びは毎回同じ（開き直すたびに順番が変わると、目で追えない）。
    const again = await openPlan(cookie, planId);
    expect(again.towers.map((t) => t.name)).toEqual(names);
  });

  it("タワーは placements ではない（置いた物として数えない）", async () => {
    const { cookie } = await loginAs("7604", "tw4");
    const planId = await newPlan(cookie, "bakurani");
    const { towers } = await openPlan(cookie, planId);
    expect(towers.length).toBe(5);

    const r = await fetch(url(`/api/sessions/${planId}/placements`), { headers: { cookie } });
    expect((await r.json()).placements.length, "何も置いていないのに配置がある").toBe(0);
  });

  it("陣営スポーンも同じ1往復で降りてくる（3陣営ぶんの多角形）", async () => {
    const { cookie } = await loginAs("7607", "tw7");
    const planId = await newPlan(cookie, "bakurani");
    const { spawns } = await openPlan(cookie, planId);
    expect(spawns.map((s) => s.faction)).toEqual(["lonestar", "manticore", "valkyra"]);
    for (const s of spawns) {
      const points = JSON.parse(s.polygon);
      expect(points.length, `${s.faction} の頂点数`).toBe(4);
      expect(s.name, `${s.faction} の表示名`).toBeTruthy();
    }
  });

  it("未ログインでは返らない（盤面ごと 401）", async () => {
    const { cookie } = await loginAs("7605", "tw5");
    const planId = await newPlan(cookie, "bakurani");
    const r = await fetch(url(`/api/sessions/${planId}`));
    expect(r.status).toBe(401);
  });
});
