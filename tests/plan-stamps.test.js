// 作戦ごとのスタンプ（plan_stamps）と、スタンプの定義（stamps）の API。
//
// 仕様: docs/superpowers/specs/2026-10-08-stamps.md（第1段 ＝ 組み込みの一式）
//
// スタンプは「どんなスタンプがあるか」（全体で共通）と「この作戦のどこに置いたか」の
// 2つを1本の GET で返す。**権限・冪等・検証は placements / callouts と同じ作法**に
// 揃えてあるので、このファイルもあちらと同じ順で並べてある。
//
// **受け入れ条件8（同じ client_uuid で2回 POST しても1つしか増えない）は
// 行数を数えて確かめる。** 「201 が2回返る」だけでは増えていないことの証明にならない。
import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs, execD1, mapOf } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

/** 組み込みのスタンプの id（schema.sql の種まきと対で持つ）。 */
const SQUARE = 1;        // 図形・四角（point / glyph なし）
const ARROW_OWN = 4;     // 矢印（味方）（vector）
const ENEMY_ARMOUR = 15; // 軍用記号・敵 装甲（point / diamond / 装）

async function newPlan(cookie, title = "スタンプ") {
  const r = await fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ map_id: "bakurani", title }),
  });
  expect(r.status, "作戦を作れなかった").toBe(201);
  return (await r.json()).session.id;
}

let uuidSeq = 0;
const uuid = () => `st-${(uuidSeq += 1)}-${Date.now()}`;

function countRows(sessionId) {
  const out = execD1(
    `SELECT COUNT(*) as n FROM plan_stamps WHERE session_id = '${sessionId}'`
  );
  return JSON.parse(out.slice(out.indexOf("[")))[0].results[0].n;
}

const one = (over = {}) => ({
  client_uuid: uuid(), stamp_id: SQUARE, x_m: 1000, y_m: 2000, ...over,
});

const post = (cookie, planId, stamps, origin = ORIGIN) =>
  fetch(url(`/api/sessions/${planId}/stamps`), {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ stamps }),
  });

const patch = (cookie, planId, id, body, origin = ORIGIN) =>
  fetch(url(`/api/sessions/${planId}/stamps?id=${id}`), {
    method: "PATCH",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const del = (cookie, planId, id, origin = ORIGIN) =>
  fetch(url(`/api/sessions/${planId}/stamps?id=${id}`), {
    method: "DELETE",
    headers: { cookie, origin },
  });

const list = async (cookie, planId) => {
  const r = await fetch(url(`/api/sessions/${planId}/stamps`), { headers: { cookie } });
  return { status: r.status, body: await r.json() };
};

/** 1件置いて id を返す。 */
async function place(cookie, planId, over = {}) {
  const r = await post(cookie, planId, [one(over)]);
  expect(r.status, "置けなかった").toBe(201);
  return (await r.json()).ids[0];
}

describe("組み込みのスタンプ（stamps の種まき）", () => {
  it("25件あり、図形3・向きを持つ印2種（4行）・軍用記号18件に分かれる", async () => {
    const { cookie } = await loginAs("8201", "st1");
    const planId = await newPlan(cookie);
    const { body } = await list(cookie, planId);
    const defs = body.defs;
    expect(defs.length).toBe(25);
    expect(defs.every((d) => d.builtin === 1), "全部 builtin=1").toBe(true);
    expect(defs.every((d) => d.created_by === null), "builtin の created_by は NULL").toBe(true);

    const figures = defs.filter((d) => d.draw_kind === "point" && d.glyph === null);
    const vectors = defs.filter((d) => d.draw_kind === "vector");
    const military = defs.filter((d) => d.draw_kind === "point" && d.glyph !== null);
    expect(figures.map((d) => d.shape)).toEqual(["square", "circle", "triangle"]);
    expect([...new Set(vectors.map((d) => d.shape))]).toEqual(["arrow", "line"]);
    expect(military.length).toBe(18);
  });

  it("軍用記号の外形は APP-6 の枠3つ（四角・菱形・四葉）× 兵種6", async () => {
    const { cookie } = await loginAs("8202", "st2");
    const planId = await newPlan(cookie);
    const { body } = await list(cookie, planId);
    const military = body.defs.filter((d) => d.draw_kind === "point" && d.glyph !== null);

    const byShape = new Map();
    for (const d of military) {
      if (!byShape.has(d.shape)) byShape.set(d.shape, []);
      byShape.get(d.shape).push(d.glyph);
    }
    expect([...byShape.keys()]).toEqual(["square", "diamond", "quatrefoil"]);
    for (const [shape, glyphs] of byShape) {
      expect(glyphs, `${shape} の兵種`).toEqual(["歩", "装", "砲", "偵", "工", "補"]);
    }
    // 陣営は色でも分ける（形だけに頼らない）。新しいトークンは足していない。
    expect(military.filter((d) => d.shape === "square")
      .every((d) => d.color === "blue")).toBe(true);
    expect(military.filter((d) => d.shape === "diamond")
      .every((d) => d.color === "red")).toBe(true);
    expect(military.filter((d) => d.shape === "quatrefoil")
      .every((d) => d.color === "hot")).toBe(true);
  });

  it("向きを持つ印は味方と敵の両方がある（凸型の敵／味方を示すもの）", async () => {
    const { cookie } = await loginAs("8203", "st3");
    const planId = await newPlan(cookie);
    const { body } = await list(cookie, planId);
    const vectors = body.defs.filter((d) => d.draw_kind === "vector");
    expect(vectors.map((d) => `${d.shape}:${d.color}`))
      .toEqual(["arrow:blue", "arrow:red", "line:blue", "line:red"]);
  });

  it("schema.sql を2回流しても増えない（冪等）", () => {
    // beforeAll で1回流してある。もう1度流して件数が変わらないことを見る。
    const before = execD1("SELECT COUNT(*) as n FROM stamps");
    const n0 = JSON.parse(before.slice(before.indexOf("[")))[0].results[0].n;
    execD1(
      `INSERT OR IGNORE INTO stamps (id, label, shape, color, glyph, draw_kind, builtin, created_by, created_at)
         VALUES (1, '四角', 'square', 'muted', NULL, 'point', 1, NULL, 1791417600)`
    );
    const after = execD1("SELECT COUNT(*) as n FROM stamps");
    const n1 = JSON.parse(after.slice(after.indexOf("[")))[0].results[0].n;
    expect(n1).toBe(n0);
  });
});

describe("GET /api/sessions/:id/stamps", () => {
  it("未ログインは 401", async () => {
    const { cookie } = await loginAs("8211", "st11");
    const planId = await newPlan(cookie);
    const r = await fetch(url(`/api/sessions/${planId}/stamps`));
    expect(r.status).toBe(401);
  });

  it("存在しない作戦は 404", async () => {
    const { cookie } = await loginAs("8212", "st12");
    const { status } = await list(cookie, "NOPE00000000000000");
    expect(status).toBe(404);
  });

  it("最初は置いたものが空で、定義だけが返る", async () => {
    const { cookie } = await loginAs("8213", "st13");
    const planId = await newPlan(cookie);
    const { status, body } = await list(cookie, planId);
    expect(status).toBe(200);
    expect(body.stamps).toEqual([]);
    expect(body.defs.length).toBe(25);
  });

  it("他の人が置いたものも読める（共有URLで開いた人に敵の配置が見える）", async () => {
    const owner = await loginAs("8214", "st14");
    const other = await loginAs("8215", "st15");
    const planId = await newPlan(owner.cookie);
    await place(owner.cookie, planId, { stamp_id: ENEMY_ARMOUR, note: "ここに装甲" });

    const { status, body } = await list(other.cookie, planId);
    expect(status).toBe(200);
    expect(body.stamps.length).toBe(1);
    expect(body.stamps[0].stamp_id).toBe(ENEMY_ARMOUR);
    expect(body.stamps[0].note).toBe("ここに装甲");
  });
});

describe("POST /api/sessions/:id/stamps", () => {
  it("点のスタンプを置ける", async () => {
    const { cookie } = await loginAs("8221", "st21");
    const planId = await newPlan(cookie);
    const r = await post(cookie, planId, [one({ stamp_id: SQUARE })]);
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.saved).toBe(1);
    expect(body.ids.length).toBe(1);
    expect(countRows(planId)).toBe(1);
  });

  it("向きを持つスタンプは始点と終点の両方が保存される", async () => {
    const { cookie } = await loginAs("8222", "st22");
    const planId = await newPlan(cookie);
    await place(cookie, planId, {
      stamp_id: ARROW_OWN, x_m: 1000, y_m: 1000, x2_m: 3000, y2_m: 4000,
    });
    const { body } = await list(cookie, planId);
    expect(body.stamps[0].x_m).toBe(1000);
    expect(body.stamps[0].y_m).toBe(1000);
    expect(body.stamps[0].x2_m).toBe(3000);
    expect(body.stamps[0].y2_m).toBe(4000);
  });

  it("向きを持つスタンプに終点が無いと 400", async () => {
    const { cookie } = await loginAs("8223", "st23");
    const planId = await newPlan(cookie);
    const r = await post(cookie, planId, [one({ stamp_id: ARROW_OWN })]);
    expect(r.status).toBe(400);
    expect(countRows(planId)).toBe(0);
  });

  it("点のスタンプに終点を付けると 400（どちらを信じるか決められない形を作らない）", async () => {
    const { cookie } = await loginAs("8224", "st24");
    const planId = await newPlan(cookie);
    const r = await post(cookie, planId, [one({ x2_m: 2000, y2_m: 2000 })]);
    expect(r.status).toBe(400);
    expect(countRows(planId)).toBe(0);
  });

  it("存在しない stamp_id は 400", async () => {
    const { cookie } = await loginAs("8225", "st25");
    const planId = await newPlan(cookie);
    const r = await post(cookie, planId, [one({ stamp_id: 99999 })]);
    expect(r.status).toBe(400);
    expect(countRows(planId)).toBe(0);
  });

  it("client_uuid が無いと 400", async () => {
    const { cookie } = await loginAs("8226", "st26");
    const planId = await newPlan(cookie);
    const r = await post(cookie, planId, [{ stamp_id: SQUARE, x_m: 1, y_m: 1 }]);
    expect(r.status).toBe(400);
  });

  it("**同じ client_uuid で2回 POST しても1件しか増えない**（条件8）", async () => {
    const { cookie } = await loginAs("8227", "st27");
    const planId = await newPlan(cookie);
    const row = one();

    const first = await post(cookie, planId, [row]);
    expect(first.status).toBe(201);
    const firstId = (await first.json()).ids[0];
    expect(countRows(planId), "1回目のあとの行数").toBe(1);

    const second = await post(cookie, planId, [row]);
    expect(second.status).toBe(201);
    const secondId = (await second.json()).ids[0];
    expect(countRows(planId), "2回目のあとの行数").toBe(1);
    // **同じ行を指している**（新しい行が増えて id だけ返る形ではない）。
    expect(secondId).toBe(firstId);
    const { body } = await list(cookie, planId);
    expect(body.stamps.length).toBe(1);
  });

  it("同じ本文の中で client_uuid が重複すると 400（1件も入らない）", async () => {
    const { cookie } = await loginAs("8228", "st28");
    const planId = await newPlan(cookie);
    const row = one();
    const r = await post(cookie, planId, [row, { ...row }]);
    expect(r.status).toBe(400);
    expect(countRows(planId)).toBe(0);
  });

  it("別の作戦で使った client_uuid は 409", async () => {
    const { cookie } = await loginAs("8229", "st29");
    const a = await newPlan(cookie, "A");
    const b = await newPlan(cookie, "B");
    const row = one();
    expect((await post(cookie, a, [row])).status).toBe(201);
    expect((await post(cookie, b, [row])).status).toBe(409);
    expect(countRows(b)).toBe(0);
  });

  it("マップの外は 400（縁へ丸めない）", async () => {
    const { cookie } = await loginAs("8230", "st30");
    const planId = await newPlan(cookie);
    const map = await mapOf(cookie);
    const r = await post(cookie, planId, [one({ x_m: map.width_m + 1, y_m: 100 })]);
    expect(r.status).toBe(400);
    expect(countRows(planId)).toBe(0);
  });

  it("注記に BLOCKED_WORDS が含まれると 400", async () => {
    const { cookie } = await loginAs("8231", "st31");
    const planId = await newPlan(cookie);
    const r = await post(cookie, planId, [one({ note: "これは禁止語です" })]);
    expect(r.status).toBe(400);
    expect(countRows(planId)).toBe(0);
  });

  it("Origin が違うと 403", async () => {
    const { cookie } = await loginAs("8232", "st32");
    const planId = await newPlan(cookie);
    const r = await post(cookie, planId, [one()], "https://evil.example");
    expect(r.status).toBe(403);
  });
});

describe("PATCH /api/sessions/:id/stamps", () => {
  it("自分のスタンプは動かせる", async () => {
    const { cookie } = await loginAs("8241", "st41");
    const planId = await newPlan(cookie);
    const id = await place(cookie, planId);
    const r = await patch(cookie, planId, id, { x_m: 5000, y_m: 6000 });
    expect(r.status).toBe(200);
    const { body } = await list(cookie, planId);
    expect(body.stamps[0].x_m).toBe(5000);
    expect(body.stamps[0].y_m).toBe(6000);
  });

  it("向きを持つスタンプは始点と終点を一緒に動かす", async () => {
    const { cookie } = await loginAs("8242", "st42");
    const planId = await newPlan(cookie);
    const id = await place(cookie, planId, {
      stamp_id: ARROW_OWN, x_m: 1000, y_m: 1000, x2_m: 2000, y2_m: 2000,
    });
    const r = await patch(cookie, planId, id, {
      x_m: 3000, y_m: 3000, x2_m: 4000, y2_m: 4000,
    });
    expect(r.status).toBe(200);
    const { body } = await list(cookie, planId);
    expect([body.stamps[0].x_m, body.stamps[0].x2_m]).toEqual([3000, 4000]);
  });

  it("向きを持つスタンプの始点だけを動かすのは 400", async () => {
    const { cookie } = await loginAs("8243", "st43");
    const planId = await newPlan(cookie);
    const id = await place(cookie, planId, {
      stamp_id: ARROW_OWN, x_m: 1000, y_m: 1000, x2_m: 2000, y2_m: 2000,
    });
    const r = await patch(cookie, planId, id, { x_m: 3000, y_m: 3000 });
    expect(r.status).toBe(400);
    const { body } = await list(cookie, planId);
    expect(body.stamps[0].x_m, "座標は変わっていない").toBe(1000);
  });

  it("点のスタンプに終点を付けようとすると 400", async () => {
    const { cookie } = await loginAs("8244", "st44");
    const planId = await newPlan(cookie);
    const id = await place(cookie, planId);
    expect((await patch(cookie, planId, id, { x2_m: 1, y2_m: 1 })).status).toBe(400);
  });

  it("注記を書ける・null で消せる", async () => {
    const { cookie } = await loginAs("8245", "st45");
    const planId = await newPlan(cookie);
    const id = await place(cookie, planId);
    expect((await patch(cookie, planId, id, { note: "ここ守ろう" })).status).toBe(200);
    expect((await list(cookie, planId)).body.stamps[0].note).toBe("ここ守ろう");
    expect((await patch(cookie, planId, id, { note: null })).status).toBe(200);
    expect((await list(cookie, planId)).body.stamps[0].note).toBe(null);
  });

  it("他の人のスタンプは 403（条件3）", async () => {
    const owner = await loginAs("8246", "st46");
    const other = await loginAs("8247", "st47");
    const planId = await newPlan(owner.cookie);
    const id = await place(owner.cookie, planId);
    const r = await patch(other.cookie, planId, id, { x_m: 100, y_m: 100 });
    expect(r.status).toBe(403);
    expect((await list(owner.cookie, planId)).body.stamps[0].x_m).toBe(1000);
  });

  it("更新する値が無いと 400", async () => {
    const { cookie } = await loginAs("8248", "st48");
    const planId = await newPlan(cookie);
    const id = await place(cookie, planId);
    expect((await patch(cookie, planId, id, {})).status).toBe(400);
  });

  it("別の作戦の id は 404", async () => {
    const { cookie } = await loginAs("8249", "st49");
    const a = await newPlan(cookie, "A");
    const b = await newPlan(cookie, "B");
    const id = await place(cookie, a);
    expect((await patch(cookie, b, id, { x_m: 1, y_m: 1 })).status).toBe(404);
  });
});

describe("DELETE /api/sessions/:id/stamps", () => {
  it("自分のスタンプは消せる", async () => {
    const { cookie } = await loginAs("8251", "st51");
    const planId = await newPlan(cookie);
    const id = await place(cookie, planId);
    expect((await del(cookie, planId, id)).status).toBe(200);
    expect(countRows(planId)).toBe(0);
  });

  it("他の人のスタンプは 403（条件3）", async () => {
    const owner = await loginAs("8252", "st52");
    const other = await loginAs("8253", "st53");
    const planId = await newPlan(owner.cookie);
    const id = await place(owner.cookie, planId);
    expect((await del(other.cookie, planId, id)).status).toBe(403);
    expect(countRows(planId)).toBe(1);
  });

  it("admin は他の人のスタンプも消せる", async () => {
    const owner = await loginAs("8254", "st54");
    const admin = await loginAs("8255", "st55");
    execD1("UPDATE users SET role = 'admin' WHERE discord_id = '8255'");
    const planId = await newPlan(owner.cookie);
    const id = await place(owner.cookie, planId);
    expect((await del(admin.cookie, planId, id)).status).toBe(200);
    expect(countRows(planId)).toBe(0);
  });

  it("もう無い id は 404", async () => {
    const { cookie } = await loginAs("8256", "st56");
    const planId = await newPlan(cookie);
    const id = await place(cookie, planId);
    expect((await del(cookie, planId, id)).status).toBe(200);
    expect((await del(cookie, planId, id)).status).toBe(404);
  });
});
