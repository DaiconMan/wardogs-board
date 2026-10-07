// カタログ（建造物・ビークル）と、マップ上への配置の API。
//
// 数値がほとんど未実測なので、「値が入っていること」ではなく
// 「verified = 0 で、未実測であることが分かる形で返ること」を検証する。
import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs, execD1, mapOf } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

// マップの一辺はマップごとに違う（16,320m / 16,384m。schema.sql）。
// 範囲外の検証は、どのマップより大きいと言い切れる値を使う。
// 「縁ちょうど」は API から引いた実寸で確かめる（下の境界テスト）。
const OUT_OF_MAP_M = 20000;

async function newPlan(cookie) {
  const r = await fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ map_id: "bakurani", title: "配置" }),
  });
  return (await r.json()).session.id;
}

function postPlacements(cookie, planId, placements) {
  return fetch(url(`/api/sessions/${planId}/placements`), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ placements }),
  });
}

async function getPlacements(cookie, planId) {
  const r = await fetch(url(`/api/sessions/${planId}/placements`), { headers: { cookie } });
  return (await r.json()).placements;
}

/** 配置を動かす。id は DELETE と同じくクエリで、座標は本文で送る。 */
function patchPlacement(cookie, planId, placementId, body) {
  return fetch(url(`/api/sessions/${planId}/placements?id=${placementId}`), {
    method: "PATCH",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 1件だけ置いて、その id を返す。PATCH のテストの下ごしらえ。 */
async function placeOne(cookie, planId, uuid, over = {}) {
  const r = await postPlacements(cookie, planId, [item(uuid, over)]);
  if (r.status !== 201) throw new Error(`配置の作成に失敗した: ${r.status}`);
  return (await r.json()).ids[0];
}

/**
 * ゲームデータ由来の項目だけを取り出す。
 * kind='objective' は「ドリル位置」「ここ守ろう」のようにこちらが定義した
 * 作図用の記号で、出典も実測値も存在しない。「全項目が未検証」「全項目の
 * notes に名称は要確認」といったゲームデータ向けの規約は当てはまらない。
 */
const gameItems = (items) => items.filter((i) => i.kind !== "objective");

const item = (uuid, over = {}) => ({
  client_uuid: uuid,
  item_id: "fob",
  x_m: 100,
  y_m: 200,
  rotation: 0,
  ...over,
});

describe("GET /api/catalog", () => {
  it("未ログインは 401", async () => {
    const r = await fetch(url("/api/catalog"));
    expect(r.status).toBe(401);
  });

  it("建造物・据置火器・ビークルが全部返る", async () => {
    const { cookie } = await loginAs("5001", "c1");
    const r = await fetch(url("/api/catalog"), { headers: { cookie } });
    expect(r.status).toBe(200);
    const { items } = await r.json();

    expect(items.length).toBeGreaterThanOrEqual(48);
    const kinds = new Set(items.map((i) => i.kind));
    for (const k of ["structure", "emplacement", "vehicle"]) {
      expect(kinds, `${k} が無い`).toContain(k);
    }
    // 種別は4つだけ（想定外の kind が混ざっていないこと）。
    // objective は「試合の要素」（ドリル位置・HQ など）の作図用記号。
    expect([...kinds].sort()).toEqual(["emplacement", "objective", "structure", "vehicle"]);
  });

  it("ゲームデータ由来の項目はすべて未検証（verified = 0）で、出典が書かれている", async () => {
    const { cookie } = await loginAs("5002", "c2");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    // objective はゲームの測定値ではなくこちらが定義した作図用の記号なので、
    // 「出典」も「未検証」も当てはまらない（別の describe で検証する）。
    for (const i of gameItems(items)) {
      expect(i.verified, `${i.id} の verified`).toBe(0);
      expect(typeof i.source, `${i.id} の source`).toBe("string");
      expect(i.source.length, `${i.id} の source`).toBeGreaterThan(0);
    }
  });

  it("L81 迫撃砲が emplacement として存在する", async () => {
    const { cookie } = await loginAs("5003", "c3");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));

    expect(byId, "L81 迫撃砲が無い").toHaveProperty("mortar_l81");
    expect(byId.mortar_l81.kind).toBe("emplacement");
    expect(byId.mortar_l81.name_ja).toContain("迫撃砲");
    expect(byId.mortar_l81.name_en).toBe("L81 Mortar");
  });

  it("実在が確認できなかった項目は入っていない", async () => {
    const { cookie } = await loginAs("5004", "c4");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));

    // L52 Cannon は自走砲 SPH-2 の搭載砲塔で、建てられる設置物ではない。
    // 「置ける物」のカタログに emplacement として入れてはいけない。
    expect(byId, "L52 が設置物として残っている").not.toHaveProperty("cannon_l52");
    expect(byId, "SPH-2 が無い").toHaveProperty("sph_2");
    expect(byId.sph_2.kind).toBe("vehicle");

    // 該当する buildable が確認できなかったもの。
    // 弾薬・物資は pallet / crate（携行品）で扱われ、物資の保持は FOB 本体の機能。
    for (const id of ["ammo_crate", "supply_depot", "hmg_nest", "at_gun"]) {
      expect(byId, `${id} が残っている`).not.toHaveProperty(id);
    }
    // 燃料専用の Refuel Station は実在する
    expect(byId, "Refuel Station が無い").toHaveProperty("refuel_station");
    expect(byId.refuel_station.notes).toContain("燃料専用");
  });

  it("HESCO は Small / Large / Wall の3種がある", async () => {
    const { cookie } = await loginAs("5022", "c22");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    const ids = items.map((i) => i.id);
    for (const id of ["hesco_block_small", "hesco_block_large", "hesco_wall"]) {
      expect(ids, `${id} が無い`).toContain(id);
    }
  });

  it("コストと射程以外の数値フィールドは全項目 NULL（実測値が無い）", async () => {
    const { cookie } = await loginAs("5023", "c23");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();

    // 寸法はセル→m 換算が 1.2m / 1.5m で矛盾しており、建築時間は単一出典の
    // 「約2分」しかない。乗員はどの出典にも無い。実測してから入れる。
    // 射程は L81 Mortar と SPH-2 だけ MetaForge Artillery Tool から入れてある
    // （下の別テストで検証）。それ以外は依然として未実測。
    const numeric = ["footprint_w_m", "footprint_h_m", "height_m", "build_seconds", "crew"];
    for (const i of items) {
      for (const key of numeric) {
        expect(i[key], `${i.id}.${key} に未実測の値が入っている`).toBeNull();
      }
      if (i.id !== "mortar_l81" && i.id !== "sph_2") {
        expect(i.range_min_m, `${i.id}.range_min_m に未実測の値が入っている`).toBeNull();
        expect(i.range_max_m, `${i.id}.range_max_m に未実測の値が入っている`).toBeNull();
      }
    }
  });

  it("L81 Mortar と SPH-2 の射程が MetaForge Artillery Tool の値で入っている", async () => {
    const { cookie } = await loginAs("5027", "c27");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));

    // L81 Mortar: 最小 80m / 最大 684m（Gunner sight モード、2026-09-27 オーナー確認）
    expect(byId.mortar_l81.range_min_m).toBe(80);
    expect(byId.mortar_l81.range_max_m).toBe(684);

    // L52 Cannon は建造物ではなく自走砲 SPH-2 の搭載砲塔なので、射程は sph_2 側に持たせてある
    expect(byId.sph_2.range_min_m).toBe(600);
    expect(byId.sph_2.range_max_m).toBe(2600);

    // ゲーム内で撃って実測したわけではないので、射程が入っていても verified は 0 のまま
    expect(byId.mortar_l81.verified).toBe(0);
    expect(byId.sph_2.verified).toBe(0);
  });

  it("値が入っている項目の notes/source に、その値を「未実測」と否定する文が残っていない", async () => {
    // UI に出す以上、notes/source と実際の値が食い違ってはいけない。
    // 完全な矛盾検出はできないが、「射程の値が入っているのに、同じ文の中で
    // 射程を『未実測』扱いしている」ような機械的に拾える形だけは弾く。
    // （実例: L81 Mortar 追加時、射程を入れたのに notes の「射程・最小射程・
    // 必要人数は未実測」を消し忘れて矛盾していたバグの再発防止）
    const { cookie } = await loginAs("5029", "c29");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();

    const hasRange = (i) => i.range_min_m != null || i.range_max_m != null;
    for (const i of items.filter(hasRange)) {
      for (const field of ["notes", "source"]) {
        const sentences = String(i[field] || "").split("。");
        for (const s of sentences) {
          // 「射程以外の数値は未実測」のように明示的に射程を除外している文は矛盾ではない
          const claimsRangeUnmeasured = s.includes("射程") && s.includes("未実測") && !s.includes("射程以外");
          expect(
            claimsRangeUnmeasured,
            `${i.id}.${field} の一文が射程を「未実測」扱いしている: "${s}"`,
          ).toBe(false);
        }
      }
    }
  });

  it("コストは大きいほうを暫定採用し、判定できないものは NULL のまま", async () => {
    const { cookie } = await loginAs("5025", "c25");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));

    // 出典2つが 4/3 の比で食い違う。オーナーの判断で大きいほうを採る。
    expect(byId.mortar_l81.cost_supplies).toBe(121); // 121 / 91
    expect(byId.drill_rig.cost_supplies).toBe(1801); // 1801 / 1351 / 901
    expect(byId.hesco_wall.cost_supplies).toBe(61);  // 61 / 46
    expect(byId.gate.cost_supplies).toBe(69);        // 69 / 52

    // 比が約13倍で、どちらかが桁を誤っている2件は「大きいほう」を採らない。
    expect(byId.talon_9k_sam.cost_supplies, "801 / 60 は判定不能").toBeNull();
    expect(byId.vanguard_ciws.cost_supplies, "1201 / 90 は判定不能").toBeNull();
    // 出典に記載が無いものも埋めない
    expect(byId.hotzone_magnet.cost_supplies).toBeNull();
    // ビークルの価格は supplies ではなく現金（$）なので入れない
    for (const i of items.filter((x) => x.kind === "vehicle")) {
      expect(i.cost_supplies, `${i.id} のコスト`).toBeNull();
    }
    // 暫定採用なので verified は上げない
    for (const i of gameItems(items)) expect(i.verified, `${i.id} の verified`).toBe(0);
  });

  it("FOB の建築範囲は正方形（一辺の長さは未確認）", async () => {
    const { cookie } = await loginAs("5026", "c26");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    const fob = items.find((i) => i.id === "fob");
    expect(fob.notes).toContain("正方形");
    expect(fob.notes).toContain("一辺の長さは未確認");
    // 円かどうかはオーナーがゲーム内で確認して決着した
    expect(fob.notes).not.toContain("円か正方形か未確認");
  });

  it("ゲームデータ由来の全項目の notes に「名称は要確認」が入っている", async () => {
    const { cookie } = await loginAs("5024", "c24");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    // 英語名が2サイト一致でも、日本語名はこちらで付けた訳で、
    // 日本語ローカライズの有無自体が未確認。
    // objective はゲーム内に対応する名前が無い（こちらで付けた記号名）ので対象外。
    for (const i of gameItems(items)) {
      expect(i.notes, `${i.id} の notes`).toContain("名称は要確認");
    }
  });
});

// 試合の要素（ホットゾーン / ドリル位置 / HQ / スポーン / 敵FOB / 守る / 攻める /
// 危険 / メモ）。
// 新テーブルも新ルートも作らず、catalog_items に kind='objective' の行を足すだけで
// 既存の placements API にそのまま相乗りさせる（設計書 §3-A-2）。
describe("GET /api/catalog の「試合の要素」（kind = objective）", () => {
  const EXPECTED = {
    mk_hotzone: "ホットゾーン（人数2倍）",
    mk_drill: "ドリル位置",
    mk_hq: "HQ",
    mk_spawn: "スポーン",
    mk_enemy_fob: "敵FOB（推定）",
    mk_defend: "ここ守ろう",
    mk_attack: "ここから攻める",
    mk_danger: "危険・見られてる",
    mk_note: "メモ",
  };

  it("9件がすべて kind = objective として返る", async () => {
    const { cookie } = await loginAs("5050", "c50");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));

    for (const [id, nameJa] of Object.entries(EXPECTED)) {
      expect(byId, `${id} が無い`).toHaveProperty(id);
      expect(byId[id].kind, `${id} の kind`).toBe("objective");
      expect(byId[id].name_ja, `${id} の name_ja`).toBe(nameJa);
    }
    expect(items.filter((i) => i.kind === "objective").length).toBe(9);
  });

  it("verified は 1（出典のある測定値ではないので「未検証」バッジを出すのは誤り）", async () => {
    const { cookie } = await loginAs("5051", "c51");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    for (const i of items.filter((x) => x.kind === "objective")) {
      expect(i.verified, `${i.id} の verified`).toBe(1);
      expect(i.notes, `${i.id} の notes`).toContain("作図用の記号");
      expect(i.notes, `${i.id} の notes`).toContain("ゲーム内の数値ではありません");
    }
  });

  it("コスト・射程・寸法・建築時間・乗員はすべて NULL", async () => {
    const { cookie } = await loginAs("5052", "c52");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    const numeric = [
      "cost_supplies", "range_min_m", "range_max_m",
      "footprint_w_m", "footprint_h_m", "height_m", "build_seconds", "crew",
    ];
    for (const i of items.filter((x) => x.kind === "objective")) {
      for (const key of numeric) {
        expect(i[key], `${i.id}.${key} に値が入っている`).toBeNull();
      }
    }
  });

  it("既存のどの項目より前に並ぶ（パレットの先頭グループに出るため）", async () => {
    const { cookie } = await loginAs("5053", "c53");
    const { items } = await (await fetch(url("/api/catalog"), { headers: { cookie } })).json();
    const maxObjective = Math.max(
      ...items.filter((i) => i.kind === "objective").map((i) => i.sort_order)
    );
    const minGame = Math.min(...gameItems(items).map((i) => i.sort_order));
    expect(maxObjective).toBeLessThan(minGame);
  });

  it("置ける（既存の placements API がそのまま受け付ける）", async () => {
    const { cookie } = await loginAs("5054", "c54");
    const id = await newPlan(cookie);
    const r = await postPlacements(cookie, id, [
      item("obj-drill", { item_id: "mk_drill", label: "1本目" }),
    ]);
    expect(r.status).toBe(201);
    const list = await getPlacements(cookie, id);
    expect(list.length).toBe(1);
    expect(list[0].item_id).toBe("mk_drill");
    expect(list[0].label).toBe("1本目");
  });
});

describe("POST /api/sessions/{id}/placements", () => {
  it("未ログインは 401、Origin 違いは 403", async () => {
    const { cookie } = await loginAs("5005", "c5");
    const id = await newPlan(cookie);
    expect((await postPlacements("", id, [item("p0")])).status).toBe(401);
    const r = await fetch(url(`/api/sessions/${id}/placements`), {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ placements: [item("p0b")] }),
    });
    expect(r.status).toBe(403);
  });

  it("保存できて、ids が返り、GET で取り出せる", async () => {
    const { cookie } = await loginAs("5006", "c6");
    const id = await newPlan(cookie);
    const r = await postPlacements(cookie, id, [
      item("p1"),
      item("p2", { item_id: "mortar_l81", x_m: 500.5, y_m: 600.25, rotation: 90, label: "北の迫" }),
    ]);
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.saved).toBe(2);
    expect(body.ids.length).toBe(2);

    const list = await getPlacements(cookie, id);
    expect(list.length).toBe(2);
    expect(list.map((p) => p.id)).toEqual(body.ids);
    const mortar = list.find((p) => p.item_id === "mortar_l81");
    expect(mortar.x_m).toBeCloseTo(500.5, 5);
    expect(mortar.rotation).toBe(90);
    expect(mortar.label).toBe("北の迫");
  });

  // rank（FOB の優先度 ①〜⑨）は UI があとで使う。GET が返さないと描けない。
  it("GET は rank を返す（既定は null）", async () => {
    const { cookie } = await loginAs("5055", "c55");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "rank-get-1");

    const before = await getPlacements(cookie, id);
    expect(before[0]).toHaveProperty("rank");
    expect(before[0].rank).toBeNull();

    execD1(`UPDATE placements SET rank = 3 WHERE id = ${pid}`);
    expect((await getPlacements(cookie, id))[0].rank).toBe(3);
  });

  it("同じ client_uuid を2回送っても二重登録されない", async () => {
    const { cookie } = await loginAs("5007", "c7");
    const id = await newPlan(cookie);
    await postPlacements(cookie, id, [item("dup-p1")]);
    await postPlacements(cookie, id, [item("dup-p1")]);
    expect((await getPlacements(cookie, id)).length).toBe(1);
  });

  it("存在しないプランは 404", async () => {
    const { cookie } = await loginAs("5008", "c8");
    const r = await postPlacements(cookie, "AAAAAAAAAAAAAAAAAAAAAA", [item("nf-p")]);
    expect(r.status).toBe(404);
  });

  it("カタログに無い item_id は 400", async () => {
    const { cookie } = await loginAs("5009", "c9");
    const id = await newPlan(cookie);
    const r = await postPlacements(cookie, id, [item("bad-item", { item_id: "death_star" })]);
    expect(r.status).toBe(400);
    expect((await getPlacements(cookie, id)).length).toBe(0);
  });

  it("マップの範囲外の座標は 400", async () => {
    const { cookie } = await loginAs("5010", "c10");
    const id = await newPlan(cookie);
    const bad = [
      item("oob1", { x_m: OUT_OF_MAP_M }),
      item("oob2", { y_m: OUT_OF_MAP_M }),
      item("oob3", { x_m: -1 }),
      item("oob4", { y_m: -0.5 }),
    ];
    for (const p of bad) {
      expect((await postPlacements(cookie, id, [p])).status, p.client_uuid).toBe(400);
    }
    expect((await getPlacements(cookie, id)).length).toBe(0);
  });

  it("rotation は 359 まで通り、360 は 400（境界）", async () => {
    const { cookie } = await loginAs("5011", "c11");
    const id = await newPlan(cookie);
    expect((await postPlacements(cookie, id, [item("rot360", { rotation: 360 })])).status).toBe(400);
    expect((await postPlacements(cookie, id, [item("rotneg", { rotation: -1 })])).status).toBe(400);
    expect((await postPlacements(cookie, id, [item("rot359", { rotation: 359 })])).status).toBe(201);
    expect((await getPlacements(cookie, id)).length).toBe(1);
  });

  it("NaN・Infinity・文字列の座標は 400", async () => {
    const { cookie } = await loginAs("5012", "c12");
    const id = await newPlan(cookie);
    // JSON に NaN / Infinity は書けず null になって届く。どちらの経路でも弾く。
    const bad = [
      item("nan1", { x_m: NaN }),
      item("inf1", { y_m: Infinity }),
      item("str1", { x_m: "100" }),
      item("null1", { y_m: null }),
      item("miss1", { x_m: undefined }),
      item("rotnan", { rotation: NaN }),
    ];
    for (const p of bad) {
      expect((await postPlacements(cookie, id, [p])).status, p.client_uuid).toBe(400);
    }
    expect((await getPlacements(cookie, id)).length).toBe(0);
  });

  it("ラベルは48文字まで通り、49文字は 400（境界）", async () => {
    const { cookie } = await loginAs("5013", "c13");
    const id = await newPlan(cookie);
    expect((await postPlacements(cookie, id, [item("lab48", { label: "あ".repeat(48) })])).status).toBe(201);
    expect((await postPlacements(cookie, id, [item("lab49", { label: "あ".repeat(49) })])).status).toBe(400);
    expect((await getPlacements(cookie, id)).length).toBe(1);
  });

  it("同一バッチ内に同じ client_uuid が2件あると 400、1件も保存されない", async () => {
    const { cookie } = await loginAs("5014", "c14");
    const id = await newPlan(cookie);
    const r = await postPlacements(cookie, id, [item("same-batch-p"), item("same-batch-p")]);
    expect(r.status).toBe(400);
    expect((await getPlacements(cookie, id)).length).toBe(0);
  });

  it("別プランで使った client_uuid は 409 で、1件も保存されない", async () => {
    const { cookie } = await loginAs("5015", "c15");
    const idA = await newPlan(cookie);
    const idB = await newPlan(cookie);
    const uuid = "cross-plan-p";
    expect((await postPlacements(cookie, idA, [item(uuid)])).status).toBe(201);

    // バッチの途中に混ぜても、手前の分だけ保存されてはいけない
    const r = await postPlacements(cookie, idB, [
      item("before-p"), item(uuid), item("after-p"),
    ]);
    expect(r.status).toBe(409);

    expect((await getPlacements(cookie, idA)).length).toBe(1);
    expect((await getPlacements(cookie, idB)).length).toBe(0);
  });

  it("配置が空・配列でないと 400", async () => {
    const { cookie } = await loginAs("5016", "c16");
    const id = await newPlan(cookie);
    for (const body of [{ placements: [] }, { placements: "fob" }, {}]) {
      const r = await fetch(url(`/api/sessions/${id}/placements`), {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("DELETE /api/sessions/{id}/placements", () => {
  it("自分の配置は消せる", async () => {
    const { cookie } = await loginAs("5017", "c17");
    const id = await newPlan(cookie);
    const ids = (await (await postPlacements(cookie, id, [item("d-p1")])).json()).ids;
    const r = await fetch(url(`/api/sessions/${id}/placements?id=${ids[0]}`), {
      method: "DELETE", headers: { cookie, origin: ORIGIN },
    });
    expect(r.status).toBe(200);
    expect((await getPlacements(cookie, id)).length).toBe(0);
  });

  it("他人の配置は member だと 403 で、消えない", async () => {
    const owner = await loginAs("5018", "c18");
    const id = await newPlan(owner.cookie);
    const ids = (await (await postPlacements(owner.cookie, id, [item("d-p2")])).json()).ids;
    const other = await loginAs("5019", "c19");
    const r = await fetch(url(`/api/sessions/${id}/placements?id=${ids[0]}`), {
      method: "DELETE", headers: { cookie: other.cookie, origin: ORIGIN },
    });
    expect(r.status).toBe(403);
    expect((await getPlacements(owner.cookie, id)).length).toBe(1);
  });

  it("存在しない id は 404", async () => {
    const { cookie } = await loginAs("5020", "c20");
    const id = await newPlan(cookie);
    const r = await fetch(url(`/api/sessions/${id}/placements?id=999999`), {
      method: "DELETE", headers: { cookie, origin: ORIGIN },
    });
    expect(r.status).toBe(404);
  });

  it("別プランの配置 id は消せない（404）", async () => {
    const { cookie } = await loginAs("5021", "c21");
    const idA = await newPlan(cookie);
    const idB = await newPlan(cookie);
    const ids = (await (await postPlacements(cookie, idA, [item("d-p3")])).json()).ids;
    const r = await fetch(url(`/api/sessions/${idB}/placements?id=${ids[0]}`), {
      method: "DELETE", headers: { cookie, origin: ORIGIN },
    });
    expect(r.status).toBe(404);
    expect((await getPlacements(cookie, idA)).length).toBe(1);
  });
});

// 置いたものを動かせないと、消して置き直すしかない（オーナー報告の不具合）。
// 権限は DELETE と同じ（本人と admin だけ）、座標の検証は POST と同じにする。
describe("PATCH /api/sessions/{id}/placements", () => {
  it("自分の配置は動かせて、GET に新しい座標が出る", async () => {
    const { cookie } = await loginAs("5030", "c30");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "m-p1");

    const r = await patchPlacement(cookie, id, pid, { x_m: 1234.5, y_m: 4321.25 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.id).toBe(pid);
    expect(body.x_m).toBeCloseTo(1234.5, 5);
    expect(body.y_m).toBeCloseTo(4321.25, 5);

    const list = await getPlacements(cookie, id);
    expect(list.length).toBe(1);
    expect(list[0].x_m).toBeCloseTo(1234.5, 5);
    expect(list[0].y_m).toBeCloseTo(4321.25, 5);
    // 動かしただけで別の配置に化けない
    expect(list[0].item_id).toBe("fob");
  });

  it("動かすとプランの updated_at が上がる", async () => {
    const { cookie } = await loginAs("5031", "c31");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "m-p2");
    // updated_at は秒精度なので、1秒進めてから比べる
    execD1(`UPDATE sessions SET updated_at = 1 WHERE id = '${id}'`);

    expect((await patchPlacement(cookie, id, pid, { x_m: 10, y_m: 20 })).status).toBe(200);
    const plan = await (await fetch(url(`/api/sessions/${id}`), { headers: { cookie } })).json();
    expect(plan.session.updated_at).toBeGreaterThan(1);
  });

  it("未ログインは 401、Origin 違いは 403", async () => {
    const { cookie } = await loginAs("5032", "c32");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "m-p3");

    expect((await patchPlacement("", id, pid, { x_m: 1, y_m: 2 })).status).toBe(401);
    const r = await fetch(url(`/api/sessions/${id}/placements?id=${pid}`), {
      method: "PATCH",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ x_m: 1, y_m: 2 }),
    });
    expect(r.status).toBe(403);
    // どちらも座標は変わっていない
    expect((await getPlacements(cookie, id))[0].x_m).toBeCloseTo(100, 5);
  });

  it("他人の配置は member だと 403 で、座標が変わらない", async () => {
    const owner = await loginAs("5033", "c33");
    const id = await newPlan(owner.cookie);
    const pid = await placeOne(owner.cookie, id, "m-p4");

    const other = await loginAs("5034", "c34");
    const r = await patchPlacement(other.cookie, id, pid, { x_m: 9000, y_m: 9000 });
    expect(r.status).toBe(403);
    const list = await getPlacements(owner.cookie, id);
    expect(list[0].x_m).toBeCloseTo(100, 5);
    expect(list[0].y_m).toBeCloseTo(200, 5);
  });

  it("admin は他人の配置も動かせる（DELETE と同じ権限）", async () => {
    const owner = await loginAs("5035", "c35");
    const id = await newPlan(owner.cookie);
    const pid = await placeOne(owner.cookie, id, "m-p5");

    const admin = await loginAs("5036", "c36");
    execD1("UPDATE users SET role = 'admin' WHERE discord_id = '5036'");
    expect((await patchPlacement(admin.cookie, id, pid, { x_m: 900, y_m: 800 })).status).toBe(200);
    expect((await getPlacements(owner.cookie, id))[0].x_m).toBeCloseTo(900, 5);
  });

  it("存在しない id と、別プランの配置 id は 404", async () => {
    const { cookie } = await loginAs("5037", "c37");
    const idA = await newPlan(cookie);
    const idB = await newPlan(cookie);
    const pid = await placeOne(cookie, idA, "m-p6");

    expect((await patchPlacement(cookie, idA, 999999, { x_m: 1, y_m: 2 })).status).toBe(404);
    expect((await patchPlacement(cookie, idB, pid, { x_m: 1, y_m: 2 })).status).toBe(404);
    expect((await patchPlacement(cookie, idA, "abc", { x_m: 1, y_m: 2 })).status).toBe(400);
    expect((await getPlacements(cookie, idA))[0].x_m).toBeCloseTo(100, 5);
  });

  it("存在しないプランは 404", async () => {
    const { cookie } = await loginAs("5038", "c38");
    const r = await patchPlacement(cookie, "AAAAAAAAAAAAAAAAAAAAAA", 1, { x_m: 1, y_m: 2 });
    expect(r.status).toBe(404);
  });

  it("マップの範囲外の座標は 400 で、座標が変わらない（POST と同じ厳しさ）", async () => {
    const { cookie } = await loginAs("5039", "c39");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "m-p7");

    const bad = [
      { x_m: OUT_OF_MAP_M, y_m: 100 },
      { x_m: 100, y_m: OUT_OF_MAP_M },
      { x_m: -1, y_m: 100 },
      { x_m: 100, y_m: -0.5 },
    ];
    for (const b of bad) {
      expect((await patchPlacement(cookie, id, pid, b)).status, JSON.stringify(b)).toBe(400);
    }
    const list = await getPlacements(cookie, id);
    expect(list[0].x_m).toBeCloseTo(100, 5);
    expect(list[0].y_m).toBeCloseTo(200, 5);
  });

  it("縁ちょうど（0 とマップの一辺）は通る（境界）", async () => {
    const { cookie } = await loginAs("5040", "c40");
    const id = await newPlan(cookie);
    const map = await mapOf(cookie);
    const pid = await placeOne(cookie, id, "m-p8");
    expect((await patchPlacement(cookie, id, pid, { x_m: 0, y_m: 0 })).status).toBe(200);
    expect(
      (await patchPlacement(cookie, id, pid, { x_m: map.width_m, y_m: map.height_m })).status
    ).toBe(200);
    expect((await getPlacements(cookie, id))[0].x_m).toBeCloseTo(map.width_m, 5);
    // 1m でも外は通さない（丸めて縁に貼り付けない）。
    expect(
      (await patchPlacement(cookie, id, pid, { x_m: map.width_m + 1, y_m: 0 })).status
    ).toBe(400);
  });

  it("NaN・Infinity・文字列・欠落した座標は 400", async () => {
    const { cookie } = await loginAs("5041", "c41");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "m-p9");

    const bad = [
      { x_m: NaN, y_m: 10 },
      { x_m: 10, y_m: Infinity },
      { x_m: "100", y_m: 10 },
      { x_m: 10, y_m: null },
      { x_m: 10 },
      { y_m: 10 },
      {},
    ];
    for (const b of bad) {
      expect((await patchPlacement(cookie, id, pid, b)).status, JSON.stringify(b)).toBe(400);
    }
    expect((await patchPlacement(cookie, id, pid, "{壊れたJSON")).status).toBe(400);
    expect((await getPlacements(cookie, id))[0].x_m).toBeCloseTo(100, 5);
  });
});

// 注記（label）と優先度（rank）は、座標と同じ PATCH の口で更新する。
// 「消して置き直す」を強いると client_uuid の採番と他人の配置の権限が絡んで事故る。
// 検証は POST とまったく同じ経路（normalizeLabel + BLOCKED_WORDS）を通す。
describe("PATCH /api/sessions/{id}/placements（label と rank）", () => {
  /** 1件置いて、その配置の現在の姿を返す。 */
  async function one(cookie, planId) {
    return (await getPlacements(cookie, planId))[0];
  }

  it("label だけを更新できる（座標は変わらない）", async () => {
    const { cookie } = await loginAs("5060", "c60");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "lr-p1");

    const r = await patchPlacement(cookie, id, pid, { label: "ここ守ろう" });
    expect(r.status).toBe(200);

    const p = await one(cookie, id);
    expect(p.label).toBe("ここ守ろう");
    expect(p.x_m).toBeCloseTo(100, 5);
    expect(p.y_m).toBeCloseTo(200, 5);
  });

  it("label は前後の空白を落とし、空文字は null になる（POST と同じ扱い）", async () => {
    const { cookie } = await loginAs("5061", "c61");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "lr-p2");

    expect((await patchPlacement(cookie, id, pid, { label: "  道路経由  " })).status).toBe(200);
    expect((await one(cookie, id)).label).toBe("道路経由");

    expect((await patchPlacement(cookie, id, pid, { label: "   " })).status).toBe(200);
    expect((await one(cookie, id)).label).toBeNull();

    expect((await patchPlacement(cookie, id, pid, { label: "戻す" })).status).toBe(200);
    expect((await patchPlacement(cookie, id, pid, { label: null })).status).toBe(200);
    expect((await one(cookie, id)).label).toBeNull();
  });

  it("label は48文字まで通り、49文字は 400 で変わらない（境界）", async () => {
    const { cookie } = await loginAs("5062", "c62");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "lr-p3");

    expect((await patchPlacement(cookie, id, pid, { label: "あ".repeat(48) })).status).toBe(200);
    expect((await one(cookie, id)).label).toBe("あ".repeat(48));

    expect((await patchPlacement(cookie, id, pid, { label: "あ".repeat(49) })).status).toBe(400);
    expect((await one(cookie, id)).label).toBe("あ".repeat(48));

    // 文字列でないものも弾く
    expect((await patchPlacement(cookie, id, pid, { label: 123 })).status).toBe(400);
    expect((await patchPlacement(cookie, id, pid, { label: ["x"] })).status).toBe(400);
  });

  it("BLOCKED_WORDS に引っかかる label は 400 で、書き換わらない", async () => {
    const { cookie } = await loginAs("5063", "c63");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "lr-p4");

    expect((await patchPlacement(cookie, id, pid, { label: "まともな注記" })).status).toBe(200);
    const r = await patchPlacement(cookie, id, pid, { label: "これは禁止語です" });
    expect(r.status).toBe(400);
    expect((await one(cookie, id)).label).toBe("まともな注記");
  });

  it("rank は 1〜9 と null が通る", async () => {
    const { cookie } = await loginAs("5064", "c64");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "lr-p5");

    for (const n of [1, 5, 9]) {
      expect((await patchPlacement(cookie, id, pid, { rank: n })).status, String(n)).toBe(200);
      expect((await one(cookie, id)).rank).toBe(n);
    }
    expect((await patchPlacement(cookie, id, pid, { rank: null })).status).toBe(200);
    expect((await one(cookie, id)).rank).toBeNull();
  });

  it("rank の 0・10・文字列・小数は 400 で、書き換わらない", async () => {
    const { cookie } = await loginAs("5065", "c65");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "lr-p6");
    expect((await patchPlacement(cookie, id, pid, { rank: 3 })).status).toBe(200);

    for (const bad of [0, 10, -1, "3", 3.5, true, [3], {}]) {
      const r = await patchPlacement(cookie, id, pid, { rank: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await one(cookie, id)).rank).toBe(3);
  });

  it("座標・label・rank を一度に更新できる", async () => {
    const { cookie } = await loginAs("5066", "c66");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "lr-p7");

    const r = await patchPlacement(cookie, id, pid, {
      x_m: 3000, y_m: 4000, label: "①の候補", rank: 1,
    });
    expect(r.status).toBe(200);

    const p = await one(cookie, id);
    expect(p.x_m).toBeCloseTo(3000, 5);
    expect(p.y_m).toBeCloseTo(4000, 5);
    expect(p.label).toBe("①の候補");
    expect(p.rank).toBe(1);
  });

  it("更新する値が1つも無ければ 400", async () => {
    const { cookie } = await loginAs("5067", "c67");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "lr-p8");

    const r = await patchPlacement(cookie, id, pid, {});
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("更新する値がありません");

    // 関係ないキーだけでも同じ
    expect((await patchPlacement(cookie, id, pid, { rotation: 90 })).status).toBe(400);
  });

  it("座標が片方だけなら 400（label や rank を一緒に送っても通さない）", async () => {
    const { cookie } = await loginAs("5068", "c68");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "lr-p9");

    expect((await patchPlacement(cookie, id, pid, { x_m: 500, label: "x" })).status).toBe(400);
    expect((await patchPlacement(cookie, id, pid, { y_m: 500, rank: 2 })).status).toBe(400);
    const p = await one(cookie, id);
    expect(p.x_m).toBeCloseTo(100, 5);
    expect(p.label).toBeNull();
    expect(p.rank).toBeNull();
  });

  it("他人の配置は label も rank も 403 で、書き換わらない", async () => {
    const owner = await loginAs("5069", "c69");
    const id = await newPlan(owner.cookie);
    const pid = await placeOne(owner.cookie, id, "lr-p10");
    expect((await patchPlacement(owner.cookie, id, pid, { label: "本人の注記", rank: 4 })).status)
      .toBe(200);

    const other = await loginAs("5070", "c70");
    expect((await patchPlacement(other.cookie, id, pid, { label: "横取り" })).status).toBe(403);
    expect((await patchPlacement(other.cookie, id, pid, { rank: 9 })).status).toBe(403);

    const p = await one(owner.cookie, id);
    expect(p.label).toBe("本人の注記");
    expect(p.rank).toBe(4);
  });

  it("admin は他人の配置の label と rank も更新できる", async () => {
    const owner = await loginAs("5071", "c71");
    const id = await newPlan(owner.cookie);
    const pid = await placeOne(owner.cookie, id, "lr-p11");

    const admin = await loginAs("5072", "c72");
    execD1("UPDATE users SET role = 'admin' WHERE discord_id = '5072'");
    expect((await patchPlacement(admin.cookie, id, pid, { label: "管理者の注記", rank: 2 })).status)
      .toBe(200);

    const p = await one(owner.cookie, id);
    expect(p.label).toBe("管理者の注記");
    expect(p.rank).toBe(2);
  });

  it("label / rank だけの更新でもプランの updated_at が上がる", async () => {
    const { cookie } = await loginAs("5073", "c73");
    const id = await newPlan(cookie);
    const pid = await placeOne(cookie, id, "lr-p12");

    execD1(`UPDATE sessions SET updated_at = 1 WHERE id = '${id}'`);
    expect((await patchPlacement(cookie, id, pid, { label: "メモ" })).status).toBe(200);
    const plan = await (await fetch(url(`/api/sessions/${id}`), { headers: { cookie } })).json();
    expect(plan.session.updated_at).toBeGreaterThan(1);
  });

  it("存在しない配置に label を送っても 404（権限判定より前に値を検証しない）", async () => {
    const { cookie } = await loginAs("5074", "c74");
    const id = await newPlan(cookie);
    expect((await patchPlacement(cookie, id, 999999, { label: "x" })).status).toBe(404);
  });
});
