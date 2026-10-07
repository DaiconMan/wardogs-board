import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs, mapOf } from "./plan-helpers.js";
import { encodePoints, MAX_POINTS } from "../functions/_lib/ink.js";

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
    body: JSON.stringify({ map_id: "bakurani", title: "インク" }),
  });
  return (await r.json()).session.id;
}

function postInk(cookie, planId, strokes) {
  return fetch(url(`/api/sessions/${planId}/ink`), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ strokes }),
  });
}

const line = (uuid) => ({
  client_uuid: uuid,
  color: "cursor-1",
  width: 2,
  points: encodePoints([{ x_m: 10, y_m: 10 }, { x_m: 50, y_m: 80 }]),
});

describe("POST ink", () => {
  it("未ログインは 401、Origin 違いは 403", async () => {
    const { cookie } = await loginAs("4001", "i1");
    const id = await newPlan(cookie);
    expect((await postInk("", id, [line("u0")])).status).toBe(401);
    const r = await fetch(url(`/api/sessions/${id}/ink`), {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ strokes: [line("u0b")] }),
    });
    expect(r.status).toBe(403);
  });

  it("保存できて、GET で取り出せる", async () => {
    const { cookie } = await loginAs("4002", "i2");
    const id = await newPlan(cookie);
    const r = await postInk(cookie, id, [line("u1"), line("u2")]);
    expect(r.status).toBe(201);
    expect((await r.json()).saved).toBe(2);

    const got = await (await fetch(url(`/api/sessions/${id}`), { headers: { cookie } })).json();
    expect(got.strokes.length).toBe(2);
    expect(got.strokes[0].points[0].x_m).toBeCloseTo(10, 5);
    expect(got.strokes[0].points[1].y_m).toBeCloseTo(80, 5);
  });

  it("同じ client_uuid を2回送っても二重登録されない", async () => {
    const { cookie } = await loginAs("4003", "i3");
    const id = await newPlan(cookie);
    await postInk(cookie, id, [line("dup-1")]);
    await postInk(cookie, id, [line("dup-1")]);
    const got = await (await fetch(url(`/api/sessions/${id}`), { headers: { cookie } })).json();
    expect(got.strokes.length).toBe(1);
  });

  it("2点未満・範囲外・NaN混入・点数超過は 400", async () => {
    const { cookie } = await loginAs("4004", "i4");
    const id = await newPlan(cookie);
    // マップの一辺はマップごとに違うので、幅そのものを引いてから 1m 外に出す。
    const map = await mapOf(cookie);
    const bad = [
      { ...line("b1"), points: [100, 100] },
      // マップの外（1m だけ外に出した点も弾かれること）
      {
        ...line("b2"),
        points: encodePoints([{ x_m: 0, y_m: 0 }, { x_m: map.width_m + 1, y_m: 0 }]),
      },
      { ...line("b3"), points: [NaN, 0, 1, 1] },
      { ...line("b4"), points: new Array((MAX_POINTS + 1) * 2).fill(1) },
    ];
    for (const s of bad) {
      expect((await postInk(cookie, id, [s])).status, s.client_uuid).toBe(400);
    }
  });

  it("width が 1/2/3 以外は 400", async () => {
    const { cookie } = await loginAs("4005", "i5");
    const id = await newPlan(cookie);
    expect((await postInk(cookie, id, [{ ...line("w"), width: 9 }])).status).toBe(400);
  });

  it("存在しないプランは 404", async () => {
    const { cookie } = await loginAs("4006", "i6");
    expect((await postInk(cookie, "AAAAAAAAAAAAAAAAAAAAAA", [line("nf")])).status).toBe(404);
  });

  it("同一バッチ内に同じ client_uuid が2件あると 400", async () => {
    const { cookie } = await loginAs("4011", "i11");
    const id = await newPlan(cookie);
    const r = await postInk(cookie, id, [line("same-batch"), line("same-batch")]);
    expect(r.status).toBe(400);
    const got = await (await fetch(url(`/api/sessions/${id}`), { headers: { cookie } })).json();
    expect(got.strokes.length).toBe(0);
  });

  it("別プランで使った client_uuid を別のプランに送ると保存されない", async () => {
    const { cookie } = await loginAs("4012", "i12");
    const idA = await newPlan(cookie);
    const idB = await newPlan(cookie);
    const uuid = "cross-plan-1";
    const r1 = await postInk(cookie, idA, [line(uuid)]);
    expect(r1.status).toBe(201);

    const r2 = await postInk(cookie, idB, [line(uuid)]);
    expect(r2.status).not.toBe(201);

    const gotA = await (await fetch(url(`/api/sessions/${idA}`), { headers: { cookie } })).json();
    const gotB = await (await fetch(url(`/api/sessions/${idB}`), { headers: { cookie } })).json();
    expect(gotA.strokes.length).toBe(1);
    expect(gotB.strokes.length).toBe(0);
  });

  it("バッチ途中の1本が別プランの client_uuid だと、1本も保存されない", async () => {
    const { cookie } = await loginAs("4013", "i13");
    const idA = await newPlan(cookie);
    const idB = await newPlan(cookie);
    const uuidX = "mid-batch-cross-plan";
    const r1 = await postInk(cookie, idA, [line(uuidX)]);
    expect(r1.status).toBe(201);

    const r2 = await postInk(cookie, idB, [line("uuid-p"), line(uuidX), line("uuid-q")]);
    expect(r2.status).toBe(409);

    const gotB = await (await fetch(url(`/api/sessions/${idB}`), { headers: { cookie } })).json();
    expect(gotB.strokes.length).toBe(0);
  });
});

describe("DELETE ink", () => {
  it("自分のストロークは消せる", async () => {
    const { cookie } = await loginAs("4007", "i7");
    const id = await newPlan(cookie);
    const ids = (await (await postInk(cookie, id, [line("d1")])).json()).ids;
    const r = await fetch(url(`/api/sessions/${id}/ink?id=${ids[0]}`), {
      method: "DELETE", headers: { cookie, origin: ORIGIN },
    });
    expect(r.status).toBe(200);
    const got = await (await fetch(url(`/api/sessions/${id}`), { headers: { cookie } })).json();
    expect(got.strokes.length).toBe(0);
  });

  it("他人のストロークは member だと 403", async () => {
    const owner = await loginAs("4008", "i8");
    const id = await newPlan(owner.cookie);
    const ids = (await (await postInk(owner.cookie, id, [line("d2")])).json()).ids;
    const other = await loginAs("4009", "i9");
    const r = await fetch(url(`/api/sessions/${id}/ink?id=${ids[0]}`), {
      method: "DELETE", headers: { cookie: other.cookie, origin: ORIGIN },
    });
    expect(r.status).toBe(403);
  });

  it("存在しない id は 404", async () => {
    const { cookie } = await loginAs("4010", "i10");
    const id = await newPlan(cookie);
    const r = await fetch(url(`/api/sessions/${id}/ink?id=999999`), {
      method: "DELETE", headers: { cookie, origin: ORIGIN },
    });
    expect(r.status).toBe(404);
  });
});
