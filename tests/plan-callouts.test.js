// プランごとの地名（session_callouts）の API。
//
// 地名は「あの丘」「工場」「北の橋」のようなチームの共通語彙だが、実体は
// **プランごと**に持つ（試合ごとに注目する場所が変わるため、同じマップでも
// 作戦によって呼び名を変えたい・要らない地名を消したい）。
// したがって権限・冪等・検証は placements とまったく同じ作法に揃える。
import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs, execD1, mapOf } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

async function newPlan(cookie, title = "地名") {
  const r = await fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ map_id: "bakurani", title }),
  });
  return (await r.json()).session.id;
}

let uuidSeq = 0;
const uuid = () => `co-${(uuidSeq += 1)}-${Date.now()}`;

/** execD1 は wrangler の案内バナーの後ろに JSON 配列を吐く。先頭の "[" から拾う。 */
function countRows(table, sessionId) {
  const out = execD1(`SELECT COUNT(*) as n FROM ${table} WHERE session_id = '${sessionId}'`);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results[0].n;
}

const one = (over = {}) => ({
  client_uuid: uuid(), name: "あの丘", x_m: 1000, y_m: 2000, ...over,
});

const post = (cookie, planId, callouts, origin = ORIGIN) =>
  fetch(url(`/api/sessions/${planId}/callouts`), {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ callouts }),
  });

const patch = (cookie, planId, id, body, origin = ORIGIN) =>
  fetch(url(`/api/sessions/${planId}/callouts?id=${id}`), {
    method: "PATCH",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const del = (cookie, planId, id, origin = ORIGIN) =>
  fetch(url(`/api/sessions/${planId}/callouts?id=${id}`), {
    method: "DELETE",
    headers: { cookie, origin },
  });

const list = async (cookie, planId) => {
  const r = await fetch(url(`/api/sessions/${planId}/callouts`), { headers: { cookie } });
  return { status: r.status, body: await r.json() };
};

describe("GET /api/sessions/:id/callouts", () => {
  it("未ログインは 401", async () => {
    const { cookie } = await loginAs("7101", "co1");
    const planId = await newPlan(cookie);
    const r = await fetch(url(`/api/sessions/${planId}/callouts`));
    expect(r.status).toBe(401);
  });

  it("存在しないプランは 404", async () => {
    const { cookie } = await loginAs("7102", "co2");
    const { status } = await list(cookie, "NOPE00000000000000");
    expect(status).toBe(404);
  });

  it("最初は空の配列を返す", async () => {
    const { cookie } = await loginAs("7103", "co3");
    const planId = await newPlan(cookie);
    const { status, body } = await list(cookie, planId);
    expect(status).toBe(200);
    expect(body.callouts).toEqual([]);
  });

  it("他の人のプランの地名も読める（共有URLで開いた人が呼び名を読めないと意味が無い）", async () => {
    const owner = (await loginAs("7104", "co4")).cookie;
    const other = (await loginAs("7105", "co5")).cookie;
    const planId = await newPlan(owner);
    await post(owner, planId, [one({ name: "工場" })]);

    const { status, body } = await list(other, planId);
    expect(status).toBe(200);
    expect(body.callouts.map((c) => c.name)).toEqual(["工場"]);
  });
});

describe("POST /api/sessions/:id/callouts", () => {
  it("Origin 違いは 403、未ログインは 401", async () => {
    const { cookie } = await loginAs("7110", "cp0");
    const planId = await newPlan(cookie);
    expect((await post("", planId, [one()])).status).toBe(401);
    expect((await post(cookie, planId, [one()], "https://evil.example")).status).toBe(403);
  });

  it("保存できて、GET で座標つきで取り出せる", async () => {
    const { cookie } = await loginAs("7111", "cp1");
    const planId = await newPlan(cookie);
    const r = await post(cookie, planId, [one({ name: "北の橋", x_m: 1234.5, y_m: 6789.25 })]);
    expect(r.status).toBe(201);
    const saved = await r.json();
    expect(saved.saved).toBe(1);
    expect(saved.ids.length).toBe(1);

    const { body } = await list(cookie, planId);
    expect(body.callouts.length).toBe(1);
    const c = body.callouts[0];
    expect(c.name).toBe("北の橋");
    expect(c.x_m).toBeCloseTo(1234.5, 5);
    expect(c.y_m).toBeCloseTo(6789.25, 5);
    expect(c.created_by).toBe("7111");
    expect(c.id).toBe(saved.ids[0]);
    // 編集を許すので updated_at を持つ。作った直後は created_at と同じ。
    expect(c.updated_at).toBe(c.created_at);
  });

  it("同じ client_uuid を送り直しても増えない（冪等）", async () => {
    const { cookie } = await loginAs("7112", "cp2");
    const planId = await newPlan(cookie);
    const row = one({ name: "沢" });
    expect((await post(cookie, planId, [row])).status).toBe(201);
    expect((await post(cookie, planId, [row])).status).toBe(201);
    const { body } = await list(cookie, planId);
    expect(body.callouts.length).toBe(1);
  });

  it("同じ本文の中に同じ client_uuid が2つあると 400", async () => {
    const { cookie } = await loginAs("7113", "cp3");
    const planId = await newPlan(cookie);
    const u = uuid();
    const r = await post(cookie, planId, [one({ client_uuid: u }), one({ client_uuid: u })]);
    expect(r.status).toBe(400);
    expect((await list(cookie, planId)).body.callouts.length).toBe(0);
  });

  it("別のプランで使った client_uuid は 409", async () => {
    const { cookie } = await loginAs("7114", "cp4");
    const a = await newPlan(cookie, "A");
    const b = await newPlan(cookie, "B");
    const row = one();
    expect((await post(cookie, a, [row])).status).toBe(201);
    expect((await post(cookie, b, [row])).status).toBe(409);
  });

  it("名前は24文字まで。25文字は 400", async () => {
    const { cookie } = await loginAs("7115", "cp5");
    const planId = await newPlan(cookie);
    expect((await post(cookie, planId, [one({ name: "あ".repeat(24) })])).status).toBe(201);
    const r = await post(cookie, planId, [one({ name: "あ".repeat(25) })]);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("24");
  });

  it("空・空白だけの名前は 400（NOT NULL の器に無名の点を置かせない）", async () => {
    const { cookie } = await loginAs("7116", "cp6");
    const planId = await newPlan(cookie);
    for (const name of ["", "   ", "　", null, 123]) {
      const r = await post(cookie, planId, [one({ name })]);
      expect(r.status, `name=${JSON.stringify(name)}`).toBe(400);
    }
  });

  it("前後の空白は落として保存する", async () => {
    const { cookie } = await loginAs("7117", "cp7");
    const planId = await newPlan(cookie);
    await post(cookie, planId, [one({ name: "  高台  " })]);
    expect((await list(cookie, planId)).body.callouts[0].name).toBe("高台");
  });

  it("BLOCKED_WORDS を含む名前は 400", async () => {
    const { cookie } = await loginAs("7118", "cp8");
    const planId = await newPlan(cookie);
    const r = await post(cookie, planId, [one({ name: "禁止語の丘" })]);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("使えない語");
  });

  it("マップの範囲外は 400。丸めて縁に貼り付けない", async () => {
    const { cookie } = await loginAs("7119", "cp9");
    const planId = await newPlan(cookie);
    // 縁の外は「マップの一辺 + 0.5m」で作る（16000 のような固定値を書かない）。
    const map = await mapOf(cookie);
    for (const at of [
      { x_m: -1, y_m: 0 }, { x_m: 0, y_m: -1 },
      { x_m: map.width_m + 0.5, y_m: 0 }, { x_m: 0, y_m: map.height_m + 0.5 },
      { x_m: "100", y_m: 0 }, { x_m: null, y_m: 0 },
    ]) {
      const r = await post(cookie, planId, [one(at)]);
      expect(r.status, JSON.stringify(at)).toBe(400);
    }
    expect((await list(cookie, planId)).body.callouts.length).toBe(0);
  });

  it("空の配列と配列でない本文は 400", async () => {
    const { cookie } = await loginAs("7120", "cq0");
    const planId = await newPlan(cookie);
    expect((await post(cookie, planId, [])).status).toBe(400);
    expect((await post(cookie, planId, { name: "丘" })).status).toBe(400);
  });

  it("存在しないプランへは 404", async () => {
    const { cookie } = await loginAs("7121", "cq1");
    expect((await post(cookie, "NOPE00000000000000", [one()])).status).toBe(404);
  });

  it("1プランあたりの上限を超えると 400。上限までは入る", async () => {
    const { cookie } = await loginAs("7122", "cq2");
    const planId = await newPlan(cookie);

    // 行の生成は SQL 1文に寄せる（200行を文面に展開しないため）。
    // 上限ちょうど（MAX_PER_PLAN）まで直接入れてから、API で1件足して弾かれることを見る。
    execD1(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
       INSERT INTO session_callouts
         (session_id, name, x_m, y_m, created_by, created_at, updated_at, client_uuid)
       SELECT '${planId}', 'C' || i, i, i, '7122', 1000, 1000, 'seed-${planId}-' || i FROM n`
    );
    const { body } = await list(cookie, planId);
    expect(body.callouts.length).toBe(200);

    const r = await post(cookie, planId, [one()]);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("200");

    // 1件消せばまた置ける（上限は「これ以上増やせない」だけで、詰まりではない）。
    expect((await del(cookie, planId, body.callouts[0].id)).status).toBe(200);
    expect((await post(cookie, planId, [one()])).status).toBe(201);
  }, 60_000);

  it("一度に送れる件数にも上限がある", async () => {
    const { cookie } = await loginAs("7123", "cq3");
    const planId = await newPlan(cookie);
    const many = Array.from({ length: 51 }, (_, i) => one({ name: `丘${i}` }));
    const r = await post(cookie, planId, many);
    expect(r.status).toBe(400);
    expect((await list(cookie, planId)).body.callouts.length).toBe(0);
  });
});

describe("PATCH /api/sessions/:id/callouts", () => {
  async function seed(discordId, username) {
    const { cookie } = await loginAs(discordId, username);
    const planId = await newPlan(cookie);
    const r = await post(cookie, planId, [one({ name: "元の名" })]);
    const id = (await r.json()).ids[0];
    return { cookie, planId, id };
  }

  it("名前を変えられる", async () => {
    const { cookie, planId, id } = await seed("7130", "cr0");
    const r = await patch(cookie, planId, id, { name: "新しい名" });
    expect(r.status).toBe(200);
    expect((await r.json()).name).toBe("新しい名");
    expect((await list(cookie, planId)).body.callouts[0].name).toBe("新しい名");
  });

  it("座標を変えられる。片方だけは 400", async () => {
    const { cookie, planId, id } = await seed("7131", "cr1");
    expect((await patch(cookie, planId, id, { x_m: 500, y_m: 600 })).status).toBe(200);
    const c = (await list(cookie, planId)).body.callouts[0];
    expect(c.x_m).toBeCloseTo(500, 5);
    expect(c.y_m).toBeCloseTo(600, 5);
    expect((await patch(cookie, planId, id, { x_m: 700 })).status).toBe(400);
  });

  it("更新すると updated_at が created_at より後になる", async () => {
    const { cookie, planId, id } = await seed("7132", "cr2");
    execD1(`UPDATE session_callouts SET created_at = 1000, updated_at = 1000 WHERE id = ${id}`);
    expect((await patch(cookie, planId, id, { name: "改名" })).status).toBe(200);
    const c = (await list(cookie, planId)).body.callouts[0];
    expect(c.created_at).toBe(1000);
    expect(c.updated_at).toBeGreaterThan(1000);
  });

  it("24文字超・空・BLOCKED_WORDS は 400（POST とまったく同じ経路）", async () => {
    const { cookie, planId, id } = await seed("7133", "cr3");
    for (const name of ["あ".repeat(25), "", "   ", "禁止語", 5, null]) {
      const r = await patch(cookie, planId, id, { name });
      expect(r.status, `name=${JSON.stringify(name)}`).toBe(400);
    }
    expect((await list(cookie, planId)).body.callouts[0].name).toBe("元の名");
  });

  it("マップの範囲外へは動かせない（400）", async () => {
    const { cookie, planId, id } = await seed("7134", "cr4");
    const map = await mapOf(cookie);
    expect((await patch(cookie, planId, id, { x_m: -5, y_m: 100 })).status).toBe(400);
    expect(
      (await patch(cookie, planId, id, { x_m: 100, y_m: map.height_m + 1 })).status
    ).toBe(400);
  });

  it("更新する値が1つも無ければ 400", async () => {
    const { cookie, planId, id } = await seed("7135", "cr5");
    expect((await patch(cookie, planId, id, {})).status).toBe(400);
  });

  it("他の人の地名は編集できない（403）。admin はできる", async () => {
    const { cookie, planId, id } = await seed("7136", "cr6");
    const other = (await loginAs("7137", "cr7")).cookie;
    const r = await patch(other, planId, id, { name: "横取り" });
    expect(r.status).toBe(403);
    expect((await list(cookie, planId)).body.callouts[0].name).toBe("元の名");

    execD1("UPDATE users SET role = 'admin' WHERE discord_id = '7137'");
    expect((await patch(other, planId, id, { name: "管理者が直す" })).status).toBe(200);
  });

  it("Origin 違いは 403、未ログインは 401、無い id は 404", async () => {
    const { cookie, planId, id } = await seed("7138", "cr8");
    expect((await patch("", planId, id, { name: "x" })).status).toBe(401);
    expect((await patch(cookie, planId, id, { name: "x" }, "https://evil.example")).status).toBe(403);
    expect((await patch(cookie, planId, 99999999, { name: "x" })).status).toBe(404);
  });

  it("別のプランの id は触れない（404）", async () => {
    const { cookie, id } = await seed("7139", "cr9");
    const otherPlan = await newPlan(cookie, "別のプラン");
    expect((await patch(cookie, otherPlan, id, { name: "x" })).status).toBe(404);
  });
});

describe("DELETE /api/sessions/:id/callouts", () => {
  it("自分の地名は消せる。他の人のは 403", async () => {
    const { cookie } = await loginAs("7140", "cs0");
    const other = (await loginAs("7141", "cs1")).cookie;
    const planId = await newPlan(cookie);
    const id = (await (await post(cookie, planId, [one()])).json()).ids[0];

    expect((await del(other, planId, id)).status).toBe(403);
    expect((await list(cookie, planId)).body.callouts.length).toBe(1);
    expect((await del(cookie, planId, id)).status).toBe(200);
    expect((await list(cookie, planId)).body.callouts.length).toBe(0);
  });

  it("Origin 違いは 403、未ログインは 401、無い id は 404", async () => {
    const { cookie } = await loginAs("7142", "cs2");
    const planId = await newPlan(cookie);
    const id = (await (await post(cookie, planId, [one()])).json()).ids[0];
    expect((await del("", planId, id)).status).toBe(401);
    expect((await del(cookie, planId, id, "https://evil.example")).status).toBe(403);
    expect((await del(cookie, planId, 99999999)).status).toBe(404);
  });
});

describe("地名はプランごとに独立している", () => {
  it("別のプランには同じ地名が出ない", async () => {
    const { cookie } = await loginAs("7150", "ct0");
    const a = await newPlan(cookie, "作戦A");
    const b = await newPlan(cookie, "作戦B");
    await post(cookie, a, [one({ name: "Aの丘" })]);

    expect((await list(cookie, a)).body.callouts.map((c) => c.name)).toEqual(["Aの丘"]);
    expect((await list(cookie, b)).body.callouts).toEqual([]);
  });

  it("片方で改名しても、もう片方は変わらない", async () => {
    const { cookie } = await loginAs("7151", "ct1");
    const a = await newPlan(cookie, "作戦A");
    const b = await newPlan(cookie, "作戦B");
    const idA = (await (await post(cookie, a, [one({ name: "共通の丘" })])).json()).ids[0];
    await post(cookie, b, [one({ name: "共通の丘" })]);

    await patch(cookie, a, idA, { name: "Aだけ改名" });
    expect((await list(cookie, a)).body.callouts[0].name).toBe("Aだけ改名");
    expect((await list(cookie, b)).body.callouts[0].name).toBe("共通の丘");
  });

  it("プランを消すと、その地名も消える（孤児を残さない）", async () => {
    const { cookie } = await loginAs("7152", "ct2");
    const planId = await newPlan(cookie);
    await post(cookie, planId, [one({ name: "消える丘" })]);

    const r = await fetch(url(`/api/sessions/${planId}`), {
      method: "DELETE", headers: { cookie, origin: ORIGIN },
    });
    expect(r.status).toBe(200);

    expect(countRows("session_callouts", planId)).toBe(0);
  });
});
