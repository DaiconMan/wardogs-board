// エリア塗り（session_areas）の統合テスト。設計書 §3-A-1。
//
// 1km セルの集合を「1ジェスチャ = 1行」の追記型で持つ。描画側が id の昇順に
// op（add / sub）を適用して現在の集合を得る。ink_strokes と同じ作法なので、
// 取り消しは「最後の行を DELETE」だけで済む。
//
// 検証の方針はインク・配置と揃える。範囲外のセルは黙って縁に丸めず 400 で返す。
// バッチに1件でも不正があれば1行も INSERT しない。
import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs, execD1, mapOf } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

async function newSession(cookie, title = "エリアの作戦", map_id = "bakurani") {
  const r = await fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ map_id, title }),
  });
  expect(r.status).toBe(201);
  return (await r.json()).session;
}

const postAreas = (cookie, sessionId, areas) =>
  fetch(url(`/api/sessions/${sessionId}/areas`), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ areas }),
  });

const deleteArea = (cookie, sessionId, areaId) =>
  fetch(url(`/api/sessions/${sessionId}/areas?id=${areaId}`), {
    method: "DELETE",
    headers: { cookie, origin: ORIGIN },
  });

const getSession = (cookie, id) =>
  fetch(url(`/api/sessions/${id}`), { headers: { cookie } });

async function areasOf(cookie, sessionId) {
  const r = await getSession(cookie, sessionId);
  expect(r.status).toBe(200);
  return (await r.json()).areas;
}

/** execD1 は wrangler の案内バナーの後ろに JSON 配列を吐く。先頭の "[" から拾う。 */
function query(sql) {
  const out = execD1(sql);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

const rowsOf = (sessionId) =>
  query(`SELECT * FROM session_areas WHERE session_id = '${sessionId}' ORDER BY id`);

let uuidSeq = 0;
const uuid = (tag) => `area-${tag}-${(uuidSeq += 1)}`;

// 手で塗れるのはこの5種だけ。**ゲームが決めるもの（コントロールエリアの円・
// ホットゾーン）は含まない。** あちらは map_zone_presets / session_zone が持つ。
const KINDS = ["own", "enemy", "neutral", "key", "risk"];

/** 名前がゲームの用語とぶつかっていたので廃止した種類。新規は受け付けない。 */
const RETIRED_KINDS = ["control", "hot"];

describe("POST /api/sessions/{id}/areas", () => {
  it("塗ると 201 で ids が返り、GET /api/sessions/{id} の areas に出る", async () => {
    const { cookie } = await loginAs("8101", "areaowner");
    const session = await newSession(cookie);

    const r = await postAreas(cookie, session.id, [
      { client_uuid: uuid("basic"), kind: "enemy", op: "add", cell_m: 1000, rects: [[3, 7, 5, 9]] },
    ]);
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.saved).toBe(1);
    expect(body.ids.length).toBe(1);

    const areas = await areasOf(cookie, session.id);
    expect(areas.length).toBe(1);
    expect(areas[0]).toEqual({
      id: body.ids[0],
      kind: "enemy",
      op: "add",
      cell_m: 1000,
      rects: [[3, 7, 5, 9]],
      created_by: "8101",
    });
  });

  it("areas は id の昇順で返る（描画側が op をこの順に適用する）", async () => {
    const { cookie } = await loginAs("8102", "areaorder");
    const session = await newSession(cookie);

    const first = await postAreas(cookie, session.id, [
      { client_uuid: uuid("ord-a"), kind: "own", rects: [[0, 0, 3, 3]] },
    ]);
    expect(first.status).toBe(201);
    const second = await postAreas(cookie, session.id, [
      { client_uuid: uuid("ord-b"), kind: "own", op: "sub", rects: [[1, 1, 2, 2]] },
    ]);
    expect(second.status).toBe(201);

    const areas = await areasOf(cookie, session.id);
    expect(areas.map((a) => a.id)).toEqual([...areas.map((a) => a.id)].sort((x, y) => x - y));
    expect(areas.map((a) => a.op)).toEqual(["add", "sub"]);
  });

  it("5種類すべての kind が通る", async () => {
    const { cookie } = await loginAs("8103", "areakinds");
    const session = await newSession(cookie);

    const r = await postAreas(
      cookie,
      session.id,
      KINDS.map((kind, i) => ({ client_uuid: uuid(`kind-${kind}`), kind, rects: [[i, 0, i, 0]] }))
    );
    expect(r.status).toBe(201);

    const areas = await areasOf(cookie, session.id);
    expect(areas.map((a) => a.kind)).toEqual(KINDS);
  });

  it("知らない kind と、廃止した kind は 400", async () => {
    const { cookie } = await loginAs("8104", "areabadkind");
    const session = await newSession(cookie);

    for (const kind of [...RETIRED_KINDS, "active_zone", "drill", "OWN", "", null, 1]) {
      const r = await postAreas(cookie, session.id, [
        { client_uuid: uuid("badkind"), kind, rects: [[0, 0, 0, 0]] },
      ]);
      expect(r.status, `kind=${JSON.stringify(kind)}`).toBe(400);
    }
    expect((await areasOf(cookie, session.id)).length).toBe(0);
  });

  it("op の既定は add", async () => {
    const { cookie } = await loginAs("8105", "areaopdefault");
    const session = await newSession(cookie);

    const r = await postAreas(cookie, session.id, [
      { client_uuid: uuid("op-default"), kind: "risk", rects: [[1, 1, 1, 1]] },
    ]);
    expect(r.status).toBe(201);
    expect((await areasOf(cookie, session.id))[0].op).toBe("add");
  });

  it("add / sub 以外の op は 400", async () => {
    const { cookie } = await loginAs("8106", "areabadop");
    const session = await newSession(cookie);

    for (const op of ["ADD", "remove", "", null, 0, []]) {
      const r = await postAreas(cookie, session.id, [
        { client_uuid: uuid("badop"), kind: "own", op, rects: [[0, 0, 0, 0]] },
      ]);
      expect(r.status, `op=${JSON.stringify(op)}`).toBe(400);
    }
    expect((await areasOf(cookie, session.id)).length).toBe(0);
  });

  it("cell_m の既定は 1000（ゲーム内の 1km グリッド）", async () => {
    const { cookie } = await loginAs("8107", "areacelldefault");
    const session = await newSession(cookie);

    const r = await postAreas(cookie, session.id, [
      { client_uuid: uuid("cell-default"), kind: "own", rects: [[15, 15, 15, 15]] },
    ]);
    expect(r.status).toBe(201);
    expect((await areasOf(cookie, session.id))[0].cell_m).toBe(1000);
  });

  // 列数はマップの一辺を cell_m で割った**整数部分**（端の余りはセルにしない）。
  // マップの一辺は 16,320m なので 1000 なら 16 列、250 なら 65 列になる。
  it("cell_m は 250 / 500 / 1000 が通り、端の列まで塗れる", async () => {
    const { cookie } = await loginAs("8108", "areacellok");
    const session = await newSession(cookie);
    const map = await mapOf(cookie);

    for (const cell_m of [250, 500, 1000]) {
      const cols = Math.floor(map.width_m / cell_m);
      const r = await postAreas(cookie, session.id, [
        { client_uuid: uuid(`cell-${cell_m}`), kind: "own", cell_m, rects: [[cols - 1, 0, cols - 1, 0]] },
      ]);
      expect(r.status, `cell_m=${cell_m}`).toBe(201);

      // その1つ外は範囲外（丸めずに 400）。
      const over = await postAreas(cookie, session.id, [
        { client_uuid: uuid(`cellover-${cell_m}`), kind: "own", cell_m, rects: [[cols, 0, cols, 0]] },
      ]);
      expect(over.status, `cell_m=${cell_m} の cols 番目`).toBe(400);
    }
    expect((await areasOf(cookie, session.id)).map((a) => a.cell_m)).toEqual([250, 500, 1000]);
  });

  it("許可されていない cell_m は 400", async () => {
    const { cookie } = await loginAs("8109", "areacellbad");
    const session = await newSession(cookie);

    for (const cell_m of [100, 200, 800, 2000, 1000.5, "1000", null, 0, -1000]) {
      const r = await postAreas(cookie, session.id, [
        { client_uuid: uuid("cellbad"), kind: "own", cell_m, rects: [[0, 0, 0, 0]] },
      ]);
      expect(r.status, `cell_m=${JSON.stringify(cell_m)}`).toBe(400);
    }
    expect((await areasOf(cookie, session.id)).length).toBe(0);
  });

  // マップの一辺は cell_m で割り切れるとは限らない（実物がそうで、
  // Bakurani 16,320m / Zestafona 16,384m。調査 §3.5）。端の余りはセルにせず、
  // **丸ごと入るセルの数**を列・行にする。1500m のマップで実際に確かめる。
  it("一辺を割り切れない cell_m でも、丸ごと入るセルまでは塗れる", async () => {
    const { cookie } = await loginAs("8110", "areacelldiv");
    execD1(
      `INSERT OR IGNORE INTO maps (id, name, width_m, height_m, verified, created_at)
       VALUES ('testodd', '割り切れないマップ', 1500, 1500, 0, 1000)`
    );
    const session = await newSession(cookie, "1500mの作戦", "testodd");

    // 1500 / 1000 = 1 セル（残り 500m は塗れない帯）。
    const one = await postAreas(cookie, session.id, [
      { client_uuid: uuid("div-1000"), kind: "own", rects: [[0, 0, 0, 0]] },
    ]);
    expect(one.status, "cell_m=1000 の 1 セル目").toBe(201);
    const two = await postAreas(cookie, session.id, [
      { client_uuid: uuid("div-1000-over"), kind: "own", rects: [[1, 0, 1, 0]] },
    ]);
    expect(two.status, "cell_m=1000 の 2 セル目は余りの帯").toBe(400);

    // 1500 / 250 = 6。
    const fine = await postAreas(cookie, session.id, [
      { client_uuid: uuid("div-250"), kind: "own", cell_m: 250, rects: [[0, 0, 5, 5]] },
    ]);
    expect(fine.status, "cell_m=250 は 6×6").toBe(201);

    // 1500 / 500 = 3。cols = rows = 3。
    const ok = await postAreas(cookie, session.id, [
      { client_uuid: uuid("div-500"), kind: "own", cell_m: 500, rects: [[0, 0, 2, 2]] },
    ]);
    expect(ok.status, "cell_m=500 は 3×3").toBe(201);

    // cols=3 なので列3は範囲外。
    const over = await postAreas(cookie, session.id, [
      { client_uuid: uuid("div-500-over"), kind: "own", cell_m: 500, rects: [[0, 0, 3, 2]] },
    ]);
    expect(over.status).toBe(400);

    expect((await areasOf(cookie, session.id)).map((a) => a.cell_m))
      .toEqual([1000, 250, 500]);
  });

  // セルより小さいマップでは1セルも作れない。0 除算や cols=0 で
  // 「何を送っても範囲外」になる前に、理由の分かるエラーで落とす。
  it("マップがセルより小さければ 400（理由が分かる文で返す）", async () => {
    const { cookie } = await loginAs("8111", "areacelltiny");
    execD1(
      `INSERT OR IGNORE INTO maps (id, name, width_m, height_m, verified, created_at)
       VALUES ('testtiny', '小さすぎるマップ', 400, 400, 0, 1000)`
    );
    const session = await newSession(cookie, "小さい作戦", "testtiny");

    const r = await postAreas(cookie, session.id, [
      { client_uuid: uuid("tiny"), kind: "own", rects: [[0, 0, 0, 0]] },
    ]);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("マップより大きい");
  });
});

describe("rects の検証", () => {
  it("範囲外のセルは 400。丸めて保存しない", async () => {
    const { cookie } = await loginAs("8111", "areaoutside");
    const session = await newSession(cookie);

    const outside = [
      [[0, 0, 16, 0]],   // 列が cols を超える
      [[0, 0, 0, 16]],   // 行が rows を超える
      [[-1, 0, 2, 2]],   // 負の列
      [[0, -1, 2, 2]],   // 負の行
      [[16, 16, 20, 20]],
    ];
    for (const rects of outside) {
      const r = await postAreas(cookie, session.id, [
        { client_uuid: uuid("outside"), kind: "own", rects },
      ]);
      expect(r.status, JSON.stringify(rects)).toBe(400);
    }

    // 丸められて 15 などで保存されていないことを、DB の行数と GET の両方で確かめる。
    expect(rowsOf(session.id).length, "1行も入っていない").toBe(0);
    expect((await areasOf(cookie, session.id)).length).toBe(0);
  });

  it("端ぴったり（0 と cols-1）は通る", async () => {
    const { cookie } = await loginAs("8112", "areaedge");
    const session = await newSession(cookie);

    const r = await postAreas(cookie, session.id, [
      { client_uuid: uuid("edge"), kind: "own", rects: [[0, 0, 15, 15]] },
    ]);
    expect(r.status).toBe(201);
    expect((await areasOf(cookie, session.id))[0].rects).toEqual([[0, 0, 15, 15]]);
  });

  it("c1 < c0 / r1 < r0 の逆転は 400（正規化しない）", async () => {
    const { cookie } = await loginAs("8113", "areareversed");
    const session = await newSession(cookie);

    for (const rects of [[[5, 0, 3, 0]], [[0, 5, 0, 3]], [[9, 9, 1, 1]]]) {
      const r = await postAreas(cookie, session.id, [
        { client_uuid: uuid("rev"), kind: "own", rects },
      ]);
      expect(r.status, JSON.stringify(rects)).toBe(400);
    }
    expect(rowsOf(session.id).length).toBe(0);
  });

  it("整数でない・長さが4でない・配列でない rects は 400", async () => {
    const { cookie } = await loginAs("8114", "areabadrects");
    const session = await newSession(cookie);

    const bad = [
      undefined,
      null,
      [],                      // 空配列
      "[[0,0,1,1]]",           // 文字列
      [[0, 0, 1]],             // 長さ3
      [[0, 0, 1, 1, 1]],       // 長さ5
      [[0, 0, 1.5, 1]],        // 小数
      [["0", 0, 1, 1]],        // 文字列の座標
      [[0, 0, null, 1]],       // null（JSON の NaN / Infinity はこう届く）
      [0, 0, 1, 1],            // 平坦な配列
      { 0: [0, 0, 1, 1] },     // オブジェクト
    ];
    for (const rects of bad) {
      const r = await postAreas(cookie, session.id, [
        { client_uuid: uuid("badrects"), kind: "own", rects },
      ]);
      expect(r.status, JSON.stringify(rects)).toBe(400);
    }
    expect(rowsOf(session.id).length).toBe(0);
  });

  it("rects は 64 要素まで。65 要素は 400", async () => {
    const { cookie } = await loginAs("8115", "arearectcount");
    const session = await newSession(cookie);

    const cell = (i) => [i % 16, Math.floor(i / 16), i % 16, Math.floor(i / 16)];
    const ok = await postAreas(cookie, session.id, [
      { client_uuid: uuid("rect64"), kind: "own", rects: Array.from({ length: 64 }, (_, i) => cell(i)) },
    ]);
    expect(ok.status, "64 要素は通る").toBe(201);

    const over = await postAreas(cookie, session.id, [
      { client_uuid: uuid("rect65"), kind: "own", rects: Array.from({ length: 65 }, (_, i) => cell(i)) },
    ]);
    expect(over.status, "65 要素は 400").toBe(400);

    expect(rowsOf(session.id).length).toBe(1);
  });

  it("1行の総セル数が cols*rows を超えたら 400", async () => {
    const { cookie } = await loginAs("8116", "areacellcount");
    const session = await newSession(cookie);

    // マップ全体（16x16 = 256 セル）はちょうど上限なので通る。
    const whole = await postAreas(cookie, session.id, [
      { client_uuid: uuid("whole"), kind: "own", rects: [[0, 0, 15, 15]] },
    ]);
    expect(whole.status, "256 セルは通る").toBe(201);

    // 全体を 2 回重ねると 512 セル。矩形自体はすべて範囲内。
    const over = await postAreas(cookie, session.id, [
      { client_uuid: uuid("over"), kind: "own", rects: [[0, 0, 15, 15], [0, 0, 15, 15]] },
    ]);
    expect(over.status, "512 セルは 400").toBe(400);

    expect(rowsOf(session.id).length).toBe(1);
  });
});

describe("client_uuid と冪等", () => {
  it("client_uuid が無い・空・重複は 400", async () => {
    const { cookie } = await loginAs("8117", "areauuid");
    const session = await newSession(cookie);

    for (const client_uuid of [undefined, "", null, 1, {}]) {
      const r = await postAreas(cookie, session.id, [
        { client_uuid, kind: "own", rects: [[0, 0, 0, 0]] },
      ]);
      expect(r.status, JSON.stringify(client_uuid)).toBe(400);
    }

    const dup = uuid("dup");
    const r = await postAreas(cookie, session.id, [
      { client_uuid: dup, kind: "own", rects: [[0, 0, 0, 0]] },
      { client_uuid: dup, kind: "enemy", rects: [[1, 1, 1, 1]] },
    ]);
    expect(r.status, "バッチ内の重複").toBe(400);
    expect(rowsOf(session.id).length).toBe(0);
  });

  it("同じセッションへの再送は冪等（行が増えず同じ id が返る）", async () => {
    const { cookie } = await loginAs("8118", "areaidem");
    const session = await newSession(cookie);
    const one = uuid("idem");

    const first = await postAreas(cookie, session.id, [
      { client_uuid: one, kind: "key", rects: [[6, 6, 7, 7]] },
    ]);
    expect(first.status).toBe(201);
    const firstIds = (await first.json()).ids;

    const again = await postAreas(cookie, session.id, [
      { client_uuid: one, kind: "key", rects: [[6, 6, 7, 7]] },
    ]);
    expect(again.status).toBe(201);
    expect((await again.json()).ids, "同じ id を返す").toEqual(firstIds);

    expect(rowsOf(session.id).length, "行は増えない").toBe(1);
  });

  it("他のセッションで使用済みの client_uuid は 409", async () => {
    const { cookie } = await loginAs("8119", "areacross");
    const a = await newSession(cookie, "エリアA");
    const b = await newSession(cookie, "エリアB");
    const one = uuid("cross");

    expect((await postAreas(cookie, a.id, [
      { client_uuid: one, kind: "own", rects: [[0, 0, 1, 1]] },
    ])).status).toBe(201);

    const r = await postAreas(cookie, b.id, [
      { client_uuid: one, kind: "own", rects: [[0, 0, 1, 1]] },
    ]);
    expect(r.status).toBe(409);
    expect(rowsOf(b.id).length).toBe(0);
  });
});

describe("バッチ", () => {
  it("1件でも不正なら1行も入らない", async () => {
    const { cookie } = await loginAs("8120", "areaatomic");
    const session = await newSession(cookie);

    const r = await postAreas(cookie, session.id, [
      { client_uuid: uuid("atomic-1"), kind: "own", rects: [[0, 0, 1, 1]] },
      { client_uuid: uuid("atomic-2"), kind: "enemy", rects: [[2, 2, 3, 3]] },
      { client_uuid: uuid("atomic-3"), kind: "own", rects: [[0, 0, 99, 1]] }, // 範囲外
    ]);
    expect(r.status).toBe(400);
    expect(rowsOf(session.id).length, "手前の2件も入っていない").toBe(0);
    expect((await areasOf(cookie, session.id)).length).toBe(0);
  });

  it("areas が配列でない・空は 400、201件は 400", async () => {
    const { cookie } = await loginAs("8121", "areabatch");
    const session = await newSession(cookie);

    for (const areas of [undefined, null, [], "x", {}]) {
      const r = await postAreas(cookie, session.id, areas);
      expect(r.status, JSON.stringify(areas)).toBe(400);
    }

    const many = (n) =>
      Array.from({ length: n }, (_, i) => ({
        client_uuid: uuid(`batch-${n}-${i}`),
        kind: "own",
        rects: [[i % 16, Math.floor(i / 16) % 16, i % 16, Math.floor(i / 16) % 16]],
      }));
    const over = await postAreas(cookie, session.id, many(201));
    expect(over.status, "201件は 400").toBe(400);
    expect(rowsOf(session.id).length).toBe(0);
  });
});

describe("権限", () => {
  it("未ログインでは 401、Origin が無ければ 403", async () => {
    const { cookie } = await loginAs("8122", "areaauth");
    const session = await newSession(cookie);

    const anon = await fetch(url(`/api/sessions/${session.id}/areas`), {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ areas: [{ client_uuid: uuid("anon"), kind: "own", rects: [[0, 0, 0, 0]] }] }),
    });
    expect(anon.status).toBe(401);

    const noOrigin = await fetch(url(`/api/sessions/${session.id}/areas`), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ areas: [{ client_uuid: uuid("noorigin"), kind: "own", rects: [[0, 0, 0, 0]] }] }),
    });
    expect(noOrigin.status).toBe(403);

    expect(rowsOf(session.id).length).toBe(0);
  });

  it("存在しないセッションへの POST は 404", async () => {
    const { cookie } = await loginAs("8123", "areanosession");
    const r = await postAreas(cookie, "AAAAAAAAAAAAAAAAAAAAAA", [
      { client_uuid: uuid("nosession"), kind: "own", rects: [[0, 0, 0, 0]] },
    ]);
    expect(r.status).toBe(404);
  });

  it("他の人が塗ったエリアは消せない（403）。admin は消せる", async () => {
    const owner = await loginAs("8124", "areadelowner");
    const session = await newSession(owner.cookie);
    const posted = await postAreas(owner.cookie, session.id, [
      { client_uuid: uuid("del"), kind: "enemy", rects: [[4, 4, 5, 5]] },
    ]);
    expect(posted.status).toBe(201);
    const areaId = (await posted.json()).ids[0];

    const other = await loginAs("8125", "areadelother");
    const denied = await deleteArea(other.cookie, session.id, areaId);
    expect(denied.status).toBe(403);
    expect(rowsOf(session.id).length).toBe(1);

    execD1("UPDATE users SET role = 'admin' WHERE discord_id = '8125'");
    const byAdmin = await deleteArea(other.cookie, session.id, areaId);
    expect(byAdmin.status).toBe(200);
    expect(rowsOf(session.id).length).toBe(0);
  });

  it("塗った本人は消せる（取り消しは最後の行を消すだけで済む）", async () => {
    const { cookie } = await loginAs("8126", "areadelself");
    const session = await newSession(cookie);
    const posted = await postAreas(cookie, session.id, [
      { client_uuid: uuid("self-1"), kind: "own", rects: [[0, 0, 1, 1]] },
      { client_uuid: uuid("self-2"), kind: "own", rects: [[2, 2, 3, 3]] },
    ]);
    expect(posted.status).toBe(201);
    const ids = (await posted.json()).ids;

    const r = await deleteArea(cookie, session.id, ids[ids.length - 1]);
    expect(r.status).toBe(200);

    const areas = await areasOf(cookie, session.id);
    expect(areas.map((a) => a.id)).toEqual([ids[0]]);
  });

  it("DELETE の id が不正・別セッション・存在しないときは 400 / 404", async () => {
    const { cookie } = await loginAs("8127", "areadelbad");
    const a = await newSession(cookie, "削除元");
    const b = await newSession(cookie, "別のセッション");
    const posted = await postAreas(cookie, a.id, [
      { client_uuid: uuid("delbad"), kind: "own", rects: [[0, 0, 0, 0]] },
    ]);
    expect(posted.status).toBe(201);
    const areaId = (await posted.json()).ids[0];

    const noId = await fetch(url(`/api/sessions/${a.id}/areas`), {
      method: "DELETE",
      headers: { cookie, origin: ORIGIN },
    });
    expect(noId.status).toBe(400);

    expect((await deleteArea(cookie, b.id, areaId)).status, "別セッション指定").toBe(404);
    expect((await deleteArea(cookie, a.id, 999999)).status).toBe(404);
    expect(rowsOf(a.id).length).toBe(1);
  });
});

describe("セッションとの連動", () => {
  it("塗ると sessions.updated_at が進む", async () => {
    const { cookie } = await loginAs("8128", "areatouch");
    const session = await newSession(cookie);
    execD1(`UPDATE sessions SET updated_at = 1000 WHERE id = '${session.id}'`);

    const r = await postAreas(cookie, session.id, [
      { client_uuid: uuid("touch"), kind: "risk", rects: [[8, 8, 9, 9]] },
    ]);
    expect(r.status).toBe(201);

    const body = await (await getSession(cookie, session.id)).json();
    expect(body.session.updated_at).toBeGreaterThan(1000);
  });

  it("セッションを削除すると session_areas も消える", async () => {
    const { cookie } = await loginAs("8129", "areasessiondel");
    const session = await newSession(cookie);
    expect((await postAreas(cookie, session.id, [
      { client_uuid: uuid("sessdel"), kind: "own", rects: [[0, 0, 2, 2]] },
    ])).status).toBe(201);
    expect(rowsOf(session.id).length).toBe(1);

    const del = await fetch(url(`/api/sessions/${session.id}`), {
      method: "DELETE",
      headers: { cookie, origin: ORIGIN },
    });
    expect(del.status).toBe(200);
    expect(rowsOf(session.id).length, "孤児の行が残らない").toBe(0);
  });
});

describe("壊れた行への耐性", () => {
  it("rects がパースできない行があっても GET は 200 で残りを返す", async () => {
    const { cookie } = await loginAs("8130", "areabroken");
    const session = await newSession(cookie);
    const posted = await postAreas(cookie, session.id, [
      { client_uuid: uuid("ok"), kind: "own", rects: [[1, 1, 2, 2]] },
    ]);
    expect(posted.status).toBe(201);
    const goodId = (await posted.json()).ids[0];

    // JSON にならない行・配列でない行・空配列の行を直接差し込む。
    execD1(
      `INSERT INTO session_areas (session_id, kind, op, cell_m, rects, created_by, created_at, client_uuid)
       VALUES
         ('${session.id}', 'enemy', 'add', 1000, '{oops',        '8130', 1000, 'broken-json'),
         ('${session.id}', 'enemy', 'add', 1000, '"notanarray"', '8130', 1000, 'broken-type'),
         ('${session.id}', 'enemy', 'add', 1000, '[]',           '8130', 1000, 'broken-empty')`
    );
    expect(rowsOf(session.id).length, "DB には4行ある").toBe(4);

    const r = await getSession(cookie, session.id);
    expect(r.status, "地図は落ちない").toBe(200);
    const areas = (await r.json()).areas;
    expect(areas.map((a) => a.id), "壊れた3行は読み飛ばす").toEqual([goodId]);
  });
});

// 本番には、種類の名前を貼り替える前に塗った行が残っている（動作確認用の4行）。
// **行は消さない。読むときだけ新しい種類に読み替える。**
//   control（手描きのコントロールエリア）→ key   … 「争奪する大事な所」という
//     意図はそのまま「最重要」で読める
//   hot    （手描きのホットゾーン）      → risk  … もともと予測として塗ったもの
// こうしておくと **migration を流さなくても盤面に出る**し、流しても結果が変わらない。
// 新しく塗るほうは 400 で断るので、廃止した名前が増えることはない。
describe("廃止した種類の既存行", () => {
  it("control は key、hot は risk として読める（行は消さない）", async () => {
    const { cookie } = await loginAs("8131", "arealegacy");
    const session = await newSession(cookie);

    execD1(
      `INSERT INTO session_areas (session_id, kind, op, cell_m, rects, created_by, created_at, client_uuid)
       VALUES
         ('${session.id}', 'control', 'add', 1000, '[[1,1,2,2]]', '8131', 1000, 'legacy-control'),
         ('${session.id}', 'hot',     'add', 1000, '[[3,3,4,4]]', '8131', 1001, 'legacy-hot')`
    );

    const areas = await areasOf(cookie, session.id);
    expect(areas.map((a) => a.kind), "新しい種類として返る").toEqual(["key", "risk"]);
    expect(areas[0].rects, "形は変えない").toEqual([[1, 1, 2, 2]]);
    expect(rowsOf(session.id).map((r) => r.kind), "DB の値は書き換えない")
      .toEqual(["control", "hot"]);
  });

  it("読み替えた行も id で消せる（取り消しの仕組みがそのまま効く）", async () => {
    const { cookie } = await loginAs("8132", "arealegacydel");
    const session = await newSession(cookie);

    execD1(
      `INSERT INTO session_areas (session_id, kind, op, cell_m, rects, created_by, created_at, client_uuid)
       VALUES ('${session.id}', 'control', 'add', 1000, '[[1,1,2,2]]', '8132', 1000, 'legacy-del')`
    );
    const id = rowsOf(session.id)[0].id;

    const del = await deleteArea(cookie, session.id, id);
    expect(del.status).toBe(200);
    expect(rowsOf(session.id).length).toBe(0);
  });
});
