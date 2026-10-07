import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs, execD1 } from "./plan-helpers.js";
import { encodePoints } from "../functions/_lib/ink.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

async function createSession(cookie, body = { map_id: "bakurani", title: "テスト作戦" }) {
  return fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteSession(cookie, id, origin = ORIGIN) {
  const headers = { cookie };
  if (origin !== null) headers.origin = origin;
  return fetch(url(`/api/sessions/${id}`), { method: "DELETE", headers });
}

/** execD1 は wrangler の案内バナーの後ろに JSON 配列を吐く。先頭の "[" から拾う。 */
function countRows(table, sessionId) {
  const out = execD1(`SELECT COUNT(*) as n FROM ${table} WHERE session_id = '${sessionId}'`);
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[0].results[0].n;
}

describe("POST /api/sessions", () => {
  it("未ログインなら 401", async () => {
    const r = await createSession("");
    expect(r.status).toBe(401);
  });

  it("Origin が違えば 403", async () => {
    const { cookie } = await loginAs("3001", "s1");
    const r = await fetch(url("/api/sessions"), {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ map_id: "bakurani", title: "x" }),
    });
    expect(r.status).toBe(403);
  });

  it("201 で 22文字の推測しにくい id が返る", async () => {
    const { cookie } = await loginAs("3002", "s2");
    const r = await createSession(cookie);
    expect(r.status).toBe(201);
    const { session } = await r.json();
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(session.title).toBe("テスト作戦");
  });

  it("2回作ると id が異なる", async () => {
    const { cookie } = await loginAs("3003", "s3");
    const a = (await (await createSession(cookie)).json()).session.id;
    const b = (await (await createSession(cookie)).json()).session.id;
    expect(a).not.toBe(b);
  });

  it("未知の map_id は 400", async () => {
    const { cookie } = await loginAs("3004", "s4");
    const r = await createSession(cookie, { map_id: "nope", title: "x" });
    expect(r.status).toBe(400);
  });

  it("title が空は 400、48文字は 201、49文字は 400", async () => {
    const { cookie } = await loginAs("3005", "s5");
    expect((await createSession(cookie, { map_id: "bakurani", title: "" })).status).toBe(400);
    expect((await createSession(cookie, { map_id: "bakurani", title: "あ".repeat(48) })).status).toBe(201);
    expect((await createSession(cookie, { map_id: "bakurani", title: "あ".repeat(49) })).status).toBe(400);
  });

  // D-046: 作戦は「マップ × パターン」の単位で作るものなので、作るときに
  // パターンまで決まっているのが自然な流れ。作ってから PUT /zone を叩き直すと、
  // 作成に成功して結びつけに失敗した中途半端な状態を作れてしまう。
  describe("preset_id（想定するパターン）", () => {
    it("preset_id を付けると、作った時点で結びつく", async () => {
      const { cookie } = await loginAs("3030", "pat1");
      const r = await createSession(cookie, {
        map_id: "zestafona", title: "パターン付き", preset_id: "zestafona-default",
      });
      expect(r.status).toBe(201);
      const { session } = await r.json();
      expect(session.zone_preset_id).toBe("zestafona-default");

      // 盤面を開いたときにも、同じパターンが選ばれている。
      const plan = await (await fetch(url(`/api/sessions/${session.id}`), { headers: { cookie } })).json();
      expect(plan.zone_preset_id).toBe("zestafona-default");
    });

    it("preset_id を省略しても作れる（パターンは任意）", async () => {
      const { cookie } = await loginAs("3031", "pat2");
      const r = await createSession(cookie, { map_id: "zestafona", title: "パターンなし" });
      expect(r.status).toBe(201);
      expect((await r.json()).session.zone_preset_id).toBe(null);
    });

    it("preset_id が null や空文字でも作れる", async () => {
      const { cookie } = await loginAs("3032", "pat3");
      for (const preset_id of [null, ""]) {
        const r = await createSession(cookie, { map_id: "zestafona", title: "空", preset_id });
        expect(r.status).toBe(201);
        expect((await r.json()).session.zone_preset_id).toBe(null);
      }
    });

    // 「存在しない」のではなく「このマップには合わない」なので 400。
    // PUT /api/sessions/{id}/zone と同じ切り分けに揃える。
    it("別のマップのパターンは 400", async () => {
      const { cookie } = await loginAs("3033", "pat4");
      const r = await createSession(cookie, {
        map_id: "bakurani", title: "違うマップ", preset_id: "zestafona-default",
      });
      expect(r.status).toBe(400);
    });

    it("存在しない preset_id は 404、文字列でなければ 400", async () => {
      const { cookie } = await loginAs("3034", "pat5");
      expect((await createSession(cookie, {
        map_id: "zestafona", title: "無い", preset_id: "nope",
      })).status).toBe(404);
      expect((await createSession(cookie, {
        map_id: "zestafona", title: "型違い", preset_id: 7,
      })).status).toBe(400);
    });

    it("弾かれたときは作戦も残らない（題名だけの作戦が増えない）", async () => {
      const { cookie } = await loginAs("3035", "pat6");
      await createSession(cookie, { map_id: "bakurani", title: "捨てる", preset_id: "zestafona-default" });
      const { sessions } = await (await fetch(url("/api/sessions"), { headers: { cookie } })).json();
      expect(sessions).toEqual([]);
    });
  });
});

describe("GET /api/sessions/{id}", () => {
  it("未ログインなら 401", async () => {
    const { cookie } = await loginAs("3006", "s6");
    const { session } = await (await createSession(cookie)).json();
    expect((await fetch(url(`/api/sessions/${session.id}`))).status).toBe(401);
  });

  it("存在しない id は 404", async () => {
    const { cookie } = await loginAs("3007", "s7");
    const r = await fetch(url("/api/sessions/AAAAAAAAAAAAAAAAAAAAAA"), { headers: { cookie } });
    expect(r.status).toBe(404);
  });

  it("作成者以外でも URL を知っていれば読める", async () => {
    const owner = await loginAs("3008", "owner");
    const { session } = await (await createSession(owner.cookie)).json();
    const other = await loginAs("3009", "other");
    const r = await fetch(url(`/api/sessions/${session.id}`), { headers: { cookie: other.cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.session.id).toBe(session.id);
    expect(body.map.id).toBe("bakurani");
    expect(body.strokes).toEqual([]);
  });
});

describe("GET /api/sessions（自分の作戦一覧）", () => {
  it("未ログインなら 401", async () => {
    const r = await fetch(url("/api/sessions"));
    expect(r.status).toBe(401);
  });

  it("自分の作戦だけ返る（他人のものが混ざらない）", async () => {
    const mine = await loginAs("3010", "listmine");
    await createSession(mine.cookie, { map_id: "bakurani", title: "自分の作戦" });
    const other = await loginAs("3011", "listother");
    await createSession(other.cookie, { map_id: "bakurani", title: "他人の作戦" });

    const r = await fetch(url("/api/sessions"), { headers: { cookie: mine.cookie } });
    expect(r.status).toBe(200);
    const { sessions } = await r.json();
    expect(sessions.length).toBe(1);
    expect(sessions[0].title).toBe("自分の作戦");
    expect(sessions[0].map_name).toBe("Bakurani");
  });

  // 一覧は「マップ × パターン」で探せないといけない（D-046）。
  // マップ名はすでに返っているので、足りないのはパターンのほう。
  // 並べ替えは画面側でやるので、並び順の材料（sort_order）まで返す。
  describe("パターンの情報", () => {
    it("パターンを選んだ作戦には key / name / 並び順が入る", async () => {
      const { cookie } = await loginAs("3040", "listpat");
      const { session } = await (await createSession(cookie, {
        map_id: "zestafona", title: "パターンあり", preset_id: "zestafona-default",
      })).json();

      const { sessions } = await (await fetch(url("/api/sessions"), { headers: { cookie } })).json();
      const found = sessions.find((s) => s.id === session.id);
      expect(found.zone_preset_id).toBe("zestafona-default");
      expect(found.zone_key).toBe("Default");
      expect(found.zone_name).toBe("Default（全タワー）");
      expect(typeof found.zone_sort).toBe("number");
    });

    // 既存の作戦はパターン未設定。**一覧から消えない**ことがここの要。
    it("パターン未設定の作戦も返る。パターンの欄は null になる", async () => {
      const { cookie } = await loginAs("3041", "listnopat");
      await createSession(cookie, { map_id: "bakurani", title: "パターン未設定" });

      const { sessions } = await (await fetch(url("/api/sessions"), { headers: { cookie } })).json();
      expect(sessions.length).toBe(1);
      expect(sessions[0].title).toBe("パターン未設定");
      expect(sessions[0].zone_preset_id).toBe(null);
      expect(sessions[0].zone_key).toBe(null);
      expect(sessions[0].zone_name).toBe(null);
      expect(sessions[0].zone_sort).toBe(null);
    });

    it("開いたことがある作戦（他人のもの）にもパターンが入る", async () => {
      const owner = await loginAs("3042", "patowner");
      const { session } = await (await createSession(owner.cookie, {
        map_id: "zestafona", title: "配られた作戦", preset_id: "zestafona-default",
      })).json();

      const guest = await loginAs("3043", "patguest");
      // 共有URLで開く＝GET /api/sessions/{id} が訪問を記録する。
      // 本文は使わないが読み捨てる。読まないと keep-alive の接続が本文を抱えたまま
      // 残り、サーバを止めるときに UND_ERR_SOCKET が飛ぶ（実測）。
      await (await fetch(url(`/api/sessions/${session.id}`), { headers: { cookie: guest.cookie } })).text();

      const { visited } = await (await fetch(url("/api/sessions"), { headers: { cookie: guest.cookie } })).json();
      const found = visited.find((v) => v.id === session.id);
      expect(found.map_name).toBe("Zestafona");
      expect(found.zone_key).toBe("Default");
      expect(found.zone_name).toBe("Default（全タワー）");
    });
  });
});

describe("DELETE /api/sessions/{id}", () => {
  it("未ログインなら 401", async () => {
    const { cookie } = await loginAs("3012", "delnoauth");
    const { session } = await (await createSession(cookie)).json();
    const r = await deleteSession("", session.id);
    expect(r.status).toBe(401);
  });

  it("Origin が違えば 403", async () => {
    const { cookie } = await loginAs("3013", "delorigin");
    const { session } = await (await createSession(cookie)).json();
    const r = await deleteSession(cookie, session.id, "https://evil.example");
    expect(r.status).toBe(403);
  });

  it("他人のものは 403", async () => {
    const owner = await loginAs("3014", "delowner");
    const { session } = await (await createSession(owner.cookie)).json();
    const other = await loginAs("3015", "delother");
    const r = await deleteSession(other.cookie, session.id);
    expect(r.status).toBe(403);
  });

  it("存在しない id は 404", async () => {
    const { cookie } = await loginAs("3016", "delmissing");
    const r = await deleteSession(cookie, "AAAAAAAAAAAAAAAAAAAAAA");
    expect(r.status).toBe(404);
  });

  it("作成者なら 200。削除すると GET は 404 になり、ink_strokes も消える", async () => {
    const { cookie } = await loginAs("3017", "delowner2");
    const { session } = await (await createSession(cookie)).json();

    await fetch(url(`/api/sessions/${session.id}/ink`), {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        strokes: [{
          client_uuid: "del-flow-1",
          color: "cursor-1",
          width: 2,
          points: encodePoints([{ x_m: 10, y_m: 10 }, { x_m: 50, y_m: 80 }]),
        }],
      }),
    });
    expect(countRows("ink_strokes", session.id)).toBe(1);

    const del = await deleteSession(cookie, session.id);
    expect(del.status).toBe(200);

    const got = await fetch(url(`/api/sessions/${session.id}`), { headers: { cookie } });
    expect(got.status).toBe(404);
    expect(countRows("ink_strokes", session.id)).toBe(0);
  });

  // 配置機能は削除の子テーブル一覧（CHILD_TABLES）が書かれた後に足されたため、
  // 一覧に placements が入っておらず、セッションを消しても配置の行が孤児として
  // 残り続けていた。UI の削除確認は「描いた線もすべて消えます」と言っているので
  // 挙動とも食い違う。
  it("削除すると placements も消える（孤児レコードを残さない）", async () => {
    const { cookie } = await loginAs("3018", "delowner3");
    const { session } = await (await createSession(cookie)).json();

    const posted = await fetch(url(`/api/sessions/${session.id}/placements`), {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        placements: [{
          client_uuid: "del-flow-placement-1",
          item_id: "fob",
          x_m: 100,
          y_m: 200,
          rotation: 0,
        }],
      }),
    });
    expect(posted.status).toBe(201);
    expect(countRows("placements", session.id)).toBe(1);

    const del = await deleteSession(cookie, session.id);
    expect(del.status).toBe(200);
    expect(countRows("placements", session.id)).toBe(0);
  });
});
