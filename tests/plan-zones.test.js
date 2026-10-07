// コントロールエリアのプリセット（ゲームが決めた円）の入り口。
//
// プリセットは**マップ静的**（全作戦に効く）で、**admin だけ**が触れる。
// 選ぶほうは作戦ごとなので、権限は作戦の編集と同じ（ログインしていれば誰でも）。
//
// 中心座標は**オーナーがゲーム画面の数字をそのまま打つ**。単位はゲーム内座標
// （1単位 = 100m）で受け取り、メートルに直すのはサーバの仕事にする
// （画面の `75.07` を `7507` と書き換えさせない。打ち間違いの元）。
//
// **プリセットはマップ静的**で、このファイル全体で1つの表を共有する。だから
// 識別子は毎回変える（同じ識別子は 409 になる ＝ それ自体が仕様）。
// 「一覧が丸ごとこれだけ」と言えるのは、まだ POST をしていない最初の describe だけ。
// それ以降は「入れたものが入っている」「入れていないものは混ざらない」で見る。
//
// `execD1` は撒かない（D-035）。1回ごとに wrangler のプロセスが立ち、稼働中の
// サーバへの接続も1本増える。**このファイルでは beforeAll の権限設定と、
// 最後の孤児レコードの確認の2回だけ。**
//
// 出典: docs/research/2026-09-29-zones-drills-data.md §2.1・§3.1・§5.6 案4。
import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs, execD1, mapOf } from "./plan-helpers.js";

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

/** マップごとの既定の半径（調査 §3.1）。Ozeti だけ 550m。 */
const DEFAULT_RADIUS_M = { bakurani: 500, ozeti: 550, zestafona: 500 };

/** 全テストで使い回す2人。admin への昇格は1回だけ（execD1 を撒かない）。 */
let adminCookie;
let memberCookie;

/**
 * schema.sql が seed として入れているプリセット（マップごとの id の配列）。
 *
 * **ここを定数で書かない。** schema.sql のプリセットは、オーナーが試合の
 * スクリーンショットを撮るたびに増えていく。件数や id をテストに書き写すと、
 * seed を足すたびにここを直すことになる。
 *
 * まだ誰も POST していない beforeAll の時点なら、表の中身がそのまま
 * 「seed の全部」になる。それを読んで期待値にする。
 */
let seededIds;

beforeAll(async () => {
  await startServers();
  adminCookie = (await loginAs("8300", "zone-admin")).cookie;
  memberCookie = (await loginAs("8301", "zone-member")).cookie;
  // 「最初のユーザーが admin」に頼らない（ファイル単位の実行順に依存させない）。
  // seed の読み出しも同じ1回に相乗りさせる（execD1 を撒かない。D-035）。
  // wrangler は文ごとに1要素の JSON 配列を返すので、SELECT は最後の要素。
  const out = execD1(
    "UPDATE users SET role = 'admin' WHERE discord_id = '8300';" +
      "UPDATE users SET role = 'member' WHERE discord_id = '8301';" +
      "SELECT id, map_id FROM map_zone_presets ORDER BY map_id, sort_order, id;"
  );
  const statements = JSON.parse(out.slice(out.indexOf("[")));
  seededIds = Object.fromEntries(Object.keys(DEFAULT_RADIUS_M).map((m) => [m, []]));
  for (const row of statements[statements.length - 1].results) {
    seededIds[row.map_id].push(row.id);
  }
  return stopServers;
}, 120_000);

/** 毎回ちがう識別子。同じ識別子が 409 になること自体は別のテストで見る。 */
let keySeq = 0;
const nextKey = (prefix = "K") => `${prefix}${(keySeq += 1)}`;

const presetPath = (mapId) => `/api/maps/${mapId}/zone-presets`;

const postPreset = (cookie, mapId, body) =>
  fetch(url(presetPath(mapId)), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const patchPreset = (cookie, mapId, presetId, body) =>
  fetch(url(`${presetPath(mapId)}?preset_id=${encodeURIComponent(presetId)}`), {
    method: "PATCH",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const deletePreset = (cookie, mapId, presetId) =>
  fetch(url(`${presetPath(mapId)}?preset_id=${encodeURIComponent(presetId)}`), {
    method: "DELETE",
    headers: { cookie, origin: ORIGIN },
  });

const listPresets = (cookie, mapId) =>
  fetch(url(presetPath(mapId)), { headers: { cookie } });

/** 作って中身を取り出す（ほとんどのテストがここから始まる）。 */
async function makePreset(mapId, body = {}) {
  const r = await postPreset(adminCookie, mapId, { key: nextKey(), ...CENTRE, ...body });
  const json = await r.json();
  if (r.status !== 201) throw new Error(`プリセットを作れなかった: ${r.status} ${JSON.stringify(json)}`);
  return json.preset;
}

async function newPlan(cookie, mapId, title = "ゾーン") {
  const r = await fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ map_id: mapId, title }),
  });
  return (await r.json()).session.id;
}

const openPlan = async (cookie, planId) =>
  (await fetch(url(`/api/sessions/${planId}`), { headers: { cookie } })).json();

const putZone = (cookie, planId, body) =>
  fetch(url(`/api/sessions/${planId}/zone`), {
    method: "PUT",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// 中心の座標は「ゲーム画面に出ている数字」。この値そのものに意味は無く、
// テストの中で置く場所として使うだけ（実データは入れない。調査 §5.3）。
const CENTRE = { x: 80.0, y: 70.0 };

describe("GET /api/maps/{id}/zone-presets", () => {
  // このファイルの最初のテスト。**まだ1件も POST していない**（beforeAll の
  // startServers が persist を作り直して schema.sql を流している）ので、
  // ここで見えるプリセットは schema.sql の seed で全部になる。
  //
  // 以前ここは「どのマップも空」と書いていたが、schema.sql が本番と同じ
  // プリセットを持つようになった（Zestafona の Default）ので前提が変わった。
  // **件数は数えない**（seed はこれから増える）。seed を読んで期待値にし、
  //   * seed が無いマップ → []
  //   * seed があるマップ → その行だけ（他マップのものが混ざらない）
  // の両方を、同じ1本で通す。
  it("既定の半径がマップごとに返り、見えるのは schema.sql の seed だけ", async () => {
    for (const [mapId, radius] of Object.entries(DEFAULT_RADIUS_M)) {
      const r = await listPresets(memberCookie, mapId);
      expect(r.status, mapId).toBe(200);
      const body = await r.json();
      expect(body.presets.map((p) => p.id), mapId).toEqual(seededIds[mapId]);
      expect(body.default_radius_m, `${mapId} の既定半径`).toBe(radius);
    }

    // 上のループが「空のマップ」と「中身のあるマップ」の両方を通ったことを、
    // テスト自身に確かめさせる。全マップに seed が付いた日／seed が全部
    // 消えた日に、片側しか見ていないことに気づかず通り抜けるのを防ぐ。
    const emptyMaps = Object.values(seededIds).filter((ids) => ids.length === 0).length;
    expect(emptyMaps, "seed が無いマップが1つも無い").toBeGreaterThan(0);
    expect(emptyMaps, "seed があるマップが1つも無い")
      .toBeLessThan(Object.keys(seededIds).length);
  });

  it("未ログインでは 401", async () => {
    expect((await fetch(url(presetPath("bakurani")))).status).toBe(401);
  });

  it("知らないマップは 404", async () => {
    expect((await listPresets(memberCookie, "nowhere")).status).toBe(404);
  });

  // ここまで POST を1件もしていないので、bakurani は seed ＋ この2件で全部になる
  // （**プリセットはマップ静的**で、このファイル全体で1つの表を共有する）。
  //
  // 期待値の頭に seed を足しているのは、bakurani にも seed が付いた日に
  // 黙って落ちないようにするため。**ただし、そのときは識別子もぶつかる**
  // （下の "Default" は seed と同じ名前なので 409 になる）。bakurani の seed を
  // 足す人は、ここの識別子も別の語に変えること。
  it("そのマップのものだけを、入れた順に返す", async () => {
    const a = await makePreset("bakurani", { key: "Default" });
    const b = await makePreset("bakurani", { key: "Farmland" });
    await makePreset("ozeti", { key: "Church" });

    const { presets } = await (await listPresets(memberCookie, "bakurani")).json();
    expect(presets.map((p) => p.id)).toEqual([...seededIds.bakurani, a.id, b.id]);
  });
});

describe("POST /api/maps/{id}/zone-presets（admin だけ）", () => {
  it("admin 以外は 403。行も増えない", async () => {
    const countOf = async () =>
      (await (await listPresets(memberCookie, "bakurani")).json()).presets.length;
    const before = await countOf();
    const r = await postPreset(memberCookie, "bakurani", { key: nextKey(), ...CENTRE });
    expect(r.status).toBe(403);
    expect(await countOf(), "403 なのに行が増えている").toBe(before);
  });

  it("未ログインでは 401", async () => {
    const r = await fetch(url(presetPath("bakurani")), {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ key: nextKey(), ...CENTRE }),
    });
    expect(r.status).toBe(401);
  });

  it("Origin が無ければ 403", async () => {
    const r = await fetch(url(presetPath("bakurani")), {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ key: nextKey(), ...CENTRE }),
    });
    expect(r.status).toBe(403);
  });

  it("知らないマップは 404", async () => {
    expect((await postPreset(adminCookie, "nowhere", { key: nextKey(), ...CENTRE })).status)
      .toBe(404);
  });

  it("ゲーム内座標で受け取り、メートルに直して保存する（1単位 = 100m）", async () => {
    const preset = await makePreset("bakurani", { x: 75.07, y: 98.71 });
    expect(preset.x_m).toBeCloseTo(7507, 3);
    expect(preset.y_m).toBeCloseTo(9871, 3);
    // 画面に出す用にゲーム内座標も返す（クライアントで割り直させない）。
    expect(preset.x).toBeCloseTo(75.07, 6);
    expect(preset.y).toBeCloseTo(98.71, 6);
  });

  it("半径を省略すると、そのマップの既定値が入る", async () => {
    for (const [mapId, radius] of Object.entries(DEFAULT_RADIUS_M)) {
      const preset = await makePreset(mapId);
      expect(preset.radius_m, `${mapId} の既定半径`).toBe(radius);
    }
  });

  it("半径は変えられる（既定を押し付けない）", async () => {
    expect((await makePreset("bakurani", { radius_m: 620 })).radius_m).toBe(620);
  });

  it("誰がどう入れた値かが必ず残る（出典の無い数値を入れない）", async () => {
    const preset = await makePreset("bakurani");
    expect(typeof preset.source).toBe("string");
    // 既定の出典は「オーナーが実機の画面で読んだ」と分かる文言にする。
    expect(preset.source).toContain("実機");
    expect(preset.source).toContain("8300");
    expect(preset.created_by).toBe("8300");
    // ゲーム画面の数字を読んで入れたので、未検証の印は付かない。
    expect(preset.verified).toBe(1);
    expect(preset.measured_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("出典は明示もできる", async () => {
    const preset = await makePreset("bakurani", { source: "2026-09-29 の試合で読んだ" });
    expect(preset.source).toBe("2026-09-29 の試合で読んだ");
  });

  it("実機で読んでいない値は verified 0 で入れられる", async () => {
    const preset = await makePreset("bakurani", { source: "別の作戦から写した", verified: 0 });
    expect(preset.verified).toBe(0);
  });

  it("ゲーム内のタグ名と重みも入れられる", async () => {
    const preset = await makePreset("bakurani", {
      name: "既定", tag: "ZoneAlternator.Bakurani.Default.Circle", weight: 2,
    });
    expect(preset.tag).toBe("ZoneAlternator.Bakurani.Default.Circle");
    expect(preset.weight).toBe(2);
    expect(preset.name).toBe("既定");
  });

  it("名前を省略すると識別子がそのまま表示名になる", async () => {
    const key = nextKey("Farmland");
    const preset = await makePreset("bakurani", { key });
    expect(preset.name).toBe(key);
  });

  it("同じ識別子は2つ作れない（409）", async () => {
    const key = nextKey("Church");
    expect((await postPreset(adminCookie, "ozeti", { key, ...CENTRE })).status).toBe(201);
    expect((await postPreset(adminCookie, "ozeti", { key, ...CENTRE })).status).toBe(409);
  });

  it("別のマップなら同じ識別子でよい", async () => {
    const key = nextKey("River");
    expect((await postPreset(adminCookie, "bakurani", { key, ...CENTRE })).status).toBe(201);
    expect((await postPreset(adminCookie, "zestafona", { key, ...CENTRE })).status).toBe(201);
  });
});

describe("座標の検証（範囲外は丸めない）", () => {
  it("マップの外は 400", async () => {
    const map = await mapOf(adminCookie, "bakurani");
    const maxX = map.width_m / 100;   // ゲーム内座標の上限（bakurani は 163.2）
    const maxY = map.height_m / 100;
    const cases = [
      ["x が負", { x: -0.01, y: 70 }],
      ["y が負", { x: 80, y: -0.01 }],
      ["x が広すぎ", { x: maxX + 0.01, y: 70 }],
      ["y が広すぎ", { x: 80, y: maxY + 0.01 }],
    ];
    for (const [why, at] of cases) {
      const r = await postPreset(adminCookie, "bakurani", { key: nextKey(), ...at });
      expect(r.status, why).toBe(400);
    }
    // 端ちょうどは通る（範囲の内側）。
    expect((await postPreset(adminCookie, "bakurani", { key: nextKey(), x: 0, y: maxY })).status)
      .toBe(201);
  });

  it("数値でないもの・欠けているものは 400", async () => {
    for (const bad of [{ x: "80", y: 70 }, { x: 80, y: null }, { x: 80 }, {}]) {
      const r = await postPreset(adminCookie, "bakurani", { key: nextKey(), ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("半径が 0 や負、大きすぎるものは 400", async () => {
    for (const radius_m of [0, -100, 50000, "500"]) {
      const r = await postPreset(adminCookie, "bakurani", { key: nextKey(), ...CENTRE, radius_m });
      expect(r.status, String(radius_m)).toBe(400);
    }
  });

  it("識別子が空・長すぎ・記号混じりは 400", async () => {
    for (const key of ["", "   ", "a".repeat(33), "Default/Circle", 5, null]) {
      const r = await postPreset(adminCookie, "bakurani", { key, ...CENTRE });
      expect(r.status, JSON.stringify(key)).toBe(400);
    }
  });

  it("重みが負や文字列なら 400。0 は通す", async () => {
    for (const weight of [-1, "2"]) {
      const r = await postPreset(adminCookie, "bakurani", { key: nextKey(), ...CENTRE, weight });
      expect(r.status, String(weight)).toBe(400);
    }
    // 0 は「定義はあるが選ばれない」という意味のある値なので通す（調査 §2.1）。
    expect((await makePreset("bakurani", { weight: 0 })).weight).toBe(0);
  });
});

describe("PATCH / DELETE（admin だけ）", () => {
  it("admin は中心・半径・名前を直せる", async () => {
    const preset = await makePreset("bakurani");
    const r = await patchPreset(adminCookie, "bakurani", preset.id, {
      x: 81.5, y: 71.25, radius_m: 550, name: "既定（直した）",
    });
    expect(r.status).toBe(200);
    const after = (await r.json()).preset;
    expect(after.x_m).toBeCloseTo(8150, 3);
    expect(after.y_m).toBeCloseTo(7125, 3);
    expect(after.radius_m).toBe(550);
    expect(after.name).toBe("既定（直した）");
  });

  it("書いたキーだけが変わる（省略した値は据え置き）", async () => {
    const preset = await makePreset("bakurani", { radius_m: 480, weight: 2 });
    const after = (await (await patchPreset(adminCookie, "bakurani", preset.id, { x: 81 })).json()).preset;
    expect(after.x_m).toBeCloseTo(8100, 3);
    expect(after.y_m).toBeCloseTo(preset.y_m, 3);
    expect(after.radius_m).toBe(480);
    expect(after.weight).toBe(2);
  });

  it("PATCH でも範囲外は 400（値は変わらない）", async () => {
    const preset = await makePreset("bakurani");
    expect((await patchPreset(adminCookie, "bakurani", preset.id, { x: -1 })).status).toBe(400);
    const { presets } = await (await listPresets(memberCookie, "bakurani")).json();
    expect(presets.find((p) => p.id === preset.id).x_m).toBeCloseTo(preset.x_m, 3);
  });

  it("admin 以外は PATCH も DELETE も 403", async () => {
    const preset = await makePreset("bakurani");
    expect((await patchPreset(memberCookie, "bakurani", preset.id, { x: 81 })).status).toBe(403);
    expect((await deletePreset(memberCookie, "bakurani", preset.id)).status).toBe(403);
    const { presets } = await (await listPresets(memberCookie, "bakurani")).json();
    expect(presets.some((p) => p.id === preset.id), "消えてしまっている").toBe(true);
  });

  it("admin は消せる", async () => {
    const preset = await makePreset("ozeti");
    expect((await deletePreset(adminCookie, "ozeti", preset.id)).status).toBe(200);
    const { presets } = await (await listPresets(memberCookie, "ozeti")).json();
    expect(presets.some((p) => p.id === preset.id)).toBe(false);
  });

  it("無いプリセットは 404", async () => {
    expect((await deletePreset(adminCookie, "bakurani", "bakurani-nope")).status).toBe(404);
    expect((await patchPreset(adminCookie, "bakurani", "bakurani-nope", { x: 80 })).status).toBe(404);
  });

  it("別のマップの id を渡しても触れない（404）", async () => {
    const preset = await makePreset("zestafona");
    expect((await patchPreset(adminCookie, "bakurani", preset.id, { x: 80 })).status).toBe(404);
    expect((await deletePreset(adminCookie, "bakurani", preset.id)).status).toBe(404);
  });
});

describe("作戦でプリセットを選ぶ", () => {
  it("作戦を開いた1往復で、そのマップのプリセットが降りてくる", async () => {
    const mine = [await makePreset("bakurani"), await makePreset("bakurani")];
    const other = await makePreset("ozeti");

    const planId = await newPlan(adminCookie, "bakurani");
    const body = await openPlan(adminCookie, planId);
    const keys = body.zone_presets.map((p) => p.key);
    // 入れた2件が、入れた順で隣り合って入っている（並びは毎回同じ）。
    const at = keys.indexOf(mine[0].key);
    expect(at, "入れたプリセットが降りてきていない").toBeGreaterThanOrEqual(0);
    expect(keys.slice(at, at + 2)).toEqual([mine[0].key, mine[1].key]);
    // 他のマップのものは混ざらない。
    expect(keys).not.toContain(other.key);
    expect(body.zone_preset_id, "最初は選ばれていない").toBe(null);
    expect(body.zone_default_radius_m).toBe(500);
  });

  it("選ぶと保存され、開き直しても残る", async () => {
    const preset = await makePreset("zestafona");
    const planId = await newPlan(adminCookie, "zestafona");

    const r = await putZone(adminCookie, planId, { preset_id: preset.id });
    expect(r.status).toBe(200);
    expect((await r.json()).preset_id).toBe(preset.id);

    expect((await openPlan(adminCookie, planId)).zone_preset_id).toBe(preset.id);
  });

  it("選び直せる。null で選択を外せる", async () => {
    const a = await makePreset("bakurani");
    const b = await makePreset("bakurani");
    const planId = await newPlan(adminCookie, "bakurani");

    await putZone(adminCookie, planId, { preset_id: a.id });
    await putZone(adminCookie, planId, { preset_id: b.id });
    expect((await openPlan(adminCookie, planId)).zone_preset_id).toBe(b.id);

    expect((await putZone(adminCookie, planId, { preset_id: null })).status).toBe(200);
    expect((await openPlan(adminCookie, planId)).zone_preset_id).toBe(null);
  });

  it("admin でなくても作戦では選べる（権限は作戦の編集と同じ）", async () => {
    const preset = await makePreset("bakurani");
    const planId = await newPlan(adminCookie, "bakurani");

    expect((await putZone(memberCookie, planId, { preset_id: preset.id })).status).toBe(200);
    expect((await openPlan(memberCookie, planId)).zone_preset_id).toBe(preset.id);
  });

  it("別のマップのプリセットは選べない（400）", async () => {
    const preset = await makePreset("ozeti");
    const planId = await newPlan(adminCookie, "bakurani");
    expect((await putZone(adminCookie, planId, { preset_id: preset.id })).status).toBe(400);
  });

  it("無いプリセットは 404、無い作戦も 404", async () => {
    const planId = await newPlan(adminCookie, "bakurani");
    expect((await putZone(adminCookie, planId, { preset_id: "bakurani-nope" })).status).toBe(404);
    expect((await putZone(adminCookie, "NOSUCHPLAN", { preset_id: null })).status).toBe(404);
  });

  it("preset_id を書かなければ 400（省略と null を区別する）", async () => {
    const planId = await newPlan(adminCookie, "bakurani");
    expect((await putZone(adminCookie, planId, {})).status).toBe(400);
  });

  it("Origin が無ければ 403、未ログインは 401", async () => {
    const planId = await newPlan(adminCookie, "bakurani");
    expect((await fetch(url(`/api/sessions/${planId}/zone`), {
      method: "PUT",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ preset_id: null }),
    })).status).toBe(403);
    expect((await fetch(url(`/api/sessions/${planId}/zone`), {
      method: "PUT",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ preset_id: null }),
    })).status).toBe(401);
  });

  // 二重管理を作らないための決め。プリセットを消したら、それを選んでいた
  // 作戦は「選んでいない」に戻る。消えた id を指したままにしない。
  it("プリセットを消すと、選んでいた作戦の選択も外れる", async () => {
    const preset = await makePreset("zestafona");
    const planId = await newPlan(adminCookie, "zestafona");
    await putZone(adminCookie, planId, { preset_id: preset.id });
    expect((await openPlan(adminCookie, planId)).zone_preset_id).toBe(preset.id);

    await deletePreset(adminCookie, "zestafona", preset.id);
    expect((await openPlan(adminCookie, planId)).zone_preset_id).toBe(null);
  });

  // 作戦を消したときに選択だけが孤児として残らないこと（[id].js の CHILD_TABLES）。
  it("作戦を消すと選択の行も消える", async () => {
    const preset = await makePreset("bakurani");
    const planId = await newPlan(adminCookie, "bakurani");
    await putZone(adminCookie, planId, { preset_id: preset.id });

    await fetch(url(`/api/sessions/${planId}`), {
      method: "DELETE", headers: { cookie: adminCookie, origin: ORIGIN },
    });
    const out = execD1(
      `SELECT COUNT(*) AS n FROM session_zone WHERE session_id = '${planId}'`
    );
    expect(out).toMatch(/\b0\b/);
  });
});
