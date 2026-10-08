// 作戦ごとの公開設定（sessions.visibility）の統合テスト。
//
// 仕様: docs/superpowers/specs/2026-10-02-plan-visibility.md
//
// 3つの状態と、それぞれの「一覧に出るか」「URL を知っている人が書けるか」。
//
//   private（既定） 出ない   閲覧も書き込みもできる（＝従来の挙動のまま）
//   public          出る     閲覧だけ。作成者以外は書き込めない
//   public_edit     出る     閲覧も書き込みもできる
//
// **`private` を締めないことがこのファイルの主題の半分。**
// いまチームは非公開の作戦の URL を配って共同編集している。そこを締めると
// 公開設定を足しただけで既存の使い方が壊れる。受け入れ条件3（読専に書けない）と
// 5（非公開はURL共有で従来どおり書ける）を**両方**見張る。
//
// 書き込む経路は placements / ink / areas / callouts / stamps / zone の6つあり、
// 1つでも判定を書き忘れるとそこからだけ書ける穴が残る。**総当たりで回す。**
import { describe, it, expect, beforeAll } from "vitest";

import { startServers, stopServers, baseUrl, loginAs, execD1 } from "./plan-helpers.js";

/**
 * zone の PUT を試すのに要る「bakurani のパターン」。
 *
 * schema.sql が seed しているプリセットは zestafona のぶん1件だけなので、
 * bakurani で作った作戦には結びつけられない（マップ違いは 400）。
 * ここで試したいのは公開設定の判定であってプリセットの検証ではないので、
 * 下ごしらえは DB へ直接入れる。
 */
const PRESET_ID = "vis-bakurani-default";

beforeAll(async () => {
  await startServers();
  // `source` は NOT NULL。**`INSERT OR IGNORE` は制約違反を黙って捨てる**ので、
  // 列を1つ落とすと「入れたつもりで入っていない」状態になり、zone の PUT だけが
  // 404 になる（実測でここに落ちた）。
  execD1(
    `INSERT OR IGNORE INTO map_zone_presets
       (id, map_id, key, name, x_m, y_m, radius_m, source,
        verified, sort_order, created_at, updated_at)
     VALUES ('${PRESET_ID}', 'bakurani', 'VisTest', '公開設定のテスト用',
             8000.0, 8000.0, 500.0, 'tests/plan-visibility.test.js の下ごしらえ',
             0, 10, 1000, 1000)`
  );
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

const jsonHeaders = (cookie) => ({
  cookie, origin: ORIGIN, "content-type": "application/json",
});

/** 本文を読み捨てて status だけ返す（keep-alive の接続を本文で詰まらせない）。 */
async function statusOf(pending) {
  const res = await pending;
  await res.text();
  return res.status;
}

async function newSession(cookie, title = "公開設定のテスト") {
  const r = await fetch(url("/api/sessions"), {
    method: "POST",
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ map_id: "bakurani", title }),
  });
  expect(r.status, "作戦を作れなかった").toBe(201);
  return (await r.json()).session;
}

const getSession = (cookie, id) =>
  fetch(url(`/api/sessions/${id}`), { headers: cookie ? { cookie } : {} });

const listSessions = (cookie) =>
  fetch(url("/api/sessions"), { headers: cookie ? { cookie } : {} });

const patchVisibility = (cookie, id, body) =>
  fetch(url(`/api/sessions/${id}`), {
    method: "PATCH",
    headers: jsonHeaders(cookie),
    body: JSON.stringify(body),
  });

async function setVisibility(cookie, id, visibility) {
  const status = await statusOf(patchVisibility(cookie, id, { visibility }));
  expect(status, `${visibility} に切り替えられなかった`).toBe(200);
}

let uuidSeq = 0;
const uuid = () => `vis-${Date.now().toString(36)}-${(uuidSeq += 1)}`;

// ── 書き込む経路。**6種類すべてを1つの表にする。**───────────────────
//
// 各要素は「新しく1件作る（create）」と「それを直す（patch）」と「消す（del）」を
// 持つ。patch / del は **自分が作った行**に対して呼ぶので、既存の
// 「他の人のものは動かせない」判定とは独立に公開設定だけを試せる。
//
// zone だけは1作戦に1つしか無いので PUT の置き換えのみ（create だけ）。

const ROUTES = {
  placements: {
    label: "建造物の配置（placements）",
    create: (cookie, id) =>
      fetch(url(`/api/sessions/${id}/placements`), {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({
          placements: [{ client_uuid: uuid(), item_id: "fob", x_m: 1000, y_m: 1000 }],
        }),
      }),
    patch: (cookie, id, rowId) =>
      fetch(url(`/api/sessions/${id}/placements?id=${rowId}`), {
        method: "PATCH",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ x_m: 1200, y_m: 1200 }),
      }),
    del: (cookie, id, rowId) =>
      fetch(url(`/api/sessions/${id}/placements?id=${rowId}`), {
        method: "DELETE",
        headers: jsonHeaders(cookie),
      }),
  },
  ink: {
    label: "手書きの線（ink）",
    create: (cookie, id) =>
      fetch(url(`/api/sessions/${id}/ink`), {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({
          strokes: [{
            client_uuid: uuid(), color: "cursor-1", width: 2,
            points: [100, 100, 200, 200],
          }],
        }),
      }),
    del: (cookie, id, rowId) =>
      fetch(url(`/api/sessions/${id}/ink?id=${rowId}`), {
        method: "DELETE",
        headers: jsonHeaders(cookie),
      }),
  },
  areas: {
    label: "エリア塗り（areas）",
    create: (cookie, id) =>
      fetch(url(`/api/sessions/${id}/areas`), {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({
          areas: [{ client_uuid: uuid(), kind: "own", rects: [[1, 1, 2, 2]] }],
        }),
      }),
    del: (cookie, id, rowId) =>
      fetch(url(`/api/sessions/${id}/areas?id=${rowId}`), {
        method: "DELETE",
        headers: jsonHeaders(cookie),
      }),
  },
  callouts: {
    label: "地名（callouts）",
    create: (cookie, id) =>
      fetch(url(`/api/sessions/${id}/callouts`), {
        method: "POST",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({
          callouts: [{ client_uuid: uuid(), name: "あの丘", x_m: 2000, y_m: 2000 }],
        }),
      }),
    patch: (cookie, id, rowId) =>
      fetch(url(`/api/sessions/${id}/callouts?id=${rowId}`), {
        method: "PATCH",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ name: "あの丘（改）" }),
      }),
    del: (cookie, id, rowId) =>
      fetch(url(`/api/sessions/${id}/callouts?id=${rowId}`), {
        method: "DELETE",
        headers: jsonHeaders(cookie),
      }),
  },
  stamps: {
    label: "スタンプ（stamps）",
    create: (cookie, id) =>
      fetch(url(`/api/sessions/${id}/stamps`), {
        method: "POST",
        headers: jsonHeaders(cookie),
        // stamp_id 1 は組み込みの「四角」（schema.sql の種まき）。
        body: JSON.stringify({
          stamps: [{ client_uuid: uuid(), stamp_id: 1, x_m: 2500, y_m: 2500 }],
        }),
      }),
    patch: (cookie, id, rowId) =>
      fetch(url(`/api/sessions/${id}/stamps?id=${rowId}`), {
        method: "PATCH",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ x_m: 2600, y_m: 2600 }),
      }),
    del: (cookie, id, rowId) =>
      fetch(url(`/api/sessions/${id}/stamps?id=${rowId}`), {
        method: "DELETE",
        headers: jsonHeaders(cookie),
      }),
  },
  zone: {
    label: "想定するパターン（zone）",
    create: (cookie, id) =>
      fetch(url(`/api/sessions/${id}/zone`), {
        method: "PUT",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ preset_id: PRESET_ID }),
      }),
  },
};

const ROUTE_NAMES = Object.keys(ROUTES);

/** 新しく1件作って、その行の id を返す（作れなかったら例外）。 */
async function createRow(name, cookie, sessionId) {
  const res = await ROUTES[name].create(cookie, sessionId);
  const body = await res.json().catch(() => ({}));
  expect(res.status, `${name} の作成が ${res.status}: ${JSON.stringify(body)}`)
    .toBeGreaterThanOrEqual(200);
  expect(res.status, `${name} の作成が失敗した: ${JSON.stringify(body)}`).toBeLessThan(300);
  return body.ids?.[0] ?? null;
}

describe("PATCH /api/sessions/{id} — 公開設定の切り替え", () => {
  it("作成者は3つの状態を切り替えられ、リロードしても保たれる（条件1）", async () => {
    const owner = await loginAs("7101", "visowner1");
    const session = await newSession(owner.cookie, "切り替えの作戦");

    // 既定は private。**作ったときから列が入っている**こと。
    const first = await (await getSession(owner.cookie, session.id)).json();
    expect(first.session.visibility, "既定は private").toBe("private");

    for (const v of ["public", "public_edit", "private"]) {
      const r = await patchVisibility(owner.cookie, session.id, { visibility: v });
      expect(r.status, `${v} への切り替え`).toBe(200);
      expect((await r.json()).visibility).toBe(v);

      // 取り直しても同じ（＝DB に入っている。リロードで保たれる）。
      const again = await (await getSession(owner.cookie, session.id)).json();
      expect(again.session.visibility, `${v} が保たれていない`).toBe(v);
    }
  });

  it("3つ以外の値は 400（状態は変わらない）", async () => {
    const owner = await loginAs("7102", "visowner2");
    const session = await newSession(owner.cookie, "不正な値の作戦");
    await setVisibility(owner.cookie, session.id, "public");

    for (const bad of ["", "PUBLIC", "open", "all", 1, null, true, ["public"]]) {
      expect(
        await statusOf(patchVisibility(owner.cookie, session.id, { visibility: bad })),
        `${JSON.stringify(bad)} は 400 であるべき`
      ).toBe(400);
    }
    // visibility を書いていない本文も 400（黙って何もしない成功を作らない）。
    expect(await statusOf(patchVisibility(owner.cookie, session.id, {}))).toBe(400);

    const after = await (await getSession(owner.cookie, session.id)).json();
    expect(after.session.visibility, "弾いた後も値は変わらない").toBe("public");
  });

  it("作成者以外は 403（条件7）", async () => {
    const owner = await loginAs("7103", "visowner3");
    const session = await newSession(owner.cookie, "他人が触る作戦");
    const other = await loginAs("7104", "visother3");

    expect(
      await statusOf(patchVisibility(other.cookie, session.id, { visibility: "public" }))
    ).toBe(403);

    const after = await (await getSession(owner.cookie, session.id)).json();
    expect(after.session.visibility).toBe("private");
  });

  it("admin は他人の作戦でも切り替えられる（DELETE と同じ判定に揃える）", async () => {
    const owner = await loginAs("7105", "visowner4");
    const session = await newSession(owner.cookie, "admin が触る作戦");
    const admin = await loginAs("7106", "visadmin4");
    // 権限を上げる導線は作らないので DB を直接書く（e2e / 他のテストと同じ作法）。
    execD1("UPDATE users SET role = 'admin' WHERE discord_id = '7106'");

    await setVisibility(admin.cookie, session.id, "public");
    const after = await (await getSession(owner.cookie, session.id)).json();
    expect(after.session.visibility).toBe("public");
  });

  it("未ログインは 401", async () => {
    const owner = await loginAs("7107", "visowner5");
    const session = await newSession(owner.cookie, "未ログインが触る作戦");
    expect(
      await statusOf(
        fetch(url(`/api/sessions/${session.id}`), {
          method: "PATCH",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ visibility: "public" }),
        })
      )
    ).toBe(401);
  });

  it("存在しない作戦は 404", async () => {
    const owner = await loginAs("7108", "visowner6");
    expect(
      await statusOf(patchVisibility(owner.cookie, "AAAAAAAAAAAAAAAAAAAAAA", { visibility: "public" }))
    ).toBe(404);
  });
});

describe("GET /api/sessions の public 群", () => {
  it("public にすると他の人の一覧に出る（条件2）", async () => {
    const owner = await loginAs("7110", "vislistowner");
    const session = await newSession(owner.cookie, "公開した作戦");
    const other = await loginAs("7111", "vislistother");

    const before = await (await listSessions(other.cookie)).json();
    expect((before.public ?? []).map((s) => s.id), "非公開のうちは出ない")
      .not.toContain(session.id);

    await setVisibility(owner.cookie, session.id, "public");

    const after = await (await listSessions(other.cookie)).json();
    const row = (after.public ?? []).find((s) => s.id === session.id);
    expect(row, "公開したら相手の一覧に出る").toBeTruthy();
    expect(row.title).toBe("公開した作戦");
    expect(row.map_name, "マップ名を返す").toBeTruthy();
    expect(row.visibility).toBe("public");
    expect(row.created_by_name, "作成者の表示名を返す").toBe("vislistowner");
  });

  // 公開の一覧にも作成者のアイコンを出す（仕様の受け入れ条件3）。
  // **`visited` と同じ列を同じ名前で返す。** 名前が揃っていないと
  // `pages/list.js` が節ごとに別の書き方をすることになる。
  it("作成者のアイコンの hash を返す（visited と同じ列名）", async () => {
    const face = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const owner = await loginAs("7150", "visfaceowner", { avatar: face });
    const session = await newSession(owner.cookie, "アイコン付きの公開作戦");
    await setVisibility(owner.cookie, session.id, "public");
    const other = await loginAs("7151", "visfaceother");

    const body = await (await listSessions(other.cookie)).json();
    const row = body.public.find((s) => s.id === session.id);
    expect(row.created_by_avatar).toBe(face);
    expect(row.created_by, "URL の組み立てに Discord ID が要る").toBe("7150");
  });

  // **ゲストにも同じ列が返る**（D-072）。ゲストの一覧は public の節だけで、
  // そこに出る作成者はログイン済みなのでアイコンを持ちうる。
  it("ゲストの一覧でも作成者のアイコンが返る", async () => {
    const face = "11223344556677889900aabbccddeeff";
    const owner = await loginAs("7152", "visfaceguestowner", { avatar: face });
    const session = await newSession(owner.cookie, "ゲストにも見える作戦");
    await setVisibility(owner.cookie, session.id, "public");

    const r = await fetch(url("/api/sessions"), {
      headers: { "x-wb-guest": "anon:AAAAAAAAAAAAAAAAAAAAAA" },
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.public.find((s) => s.id === session.id).created_by_avatar).toBe(face);
  });

  it("public_edit も一覧に出る", async () => {
    const owner = await loginAs("7112", "visliste");
    const session = await newSession(owner.cookie, "書き込める公開作戦");
    const other = await loginAs("7113", "vislisteother");

    await setVisibility(owner.cookie, session.id, "public_edit");

    const body = await (await listSessions(other.cookie)).json();
    const row = body.public.find((s) => s.id === session.id);
    expect(row).toBeTruthy();
    expect(row.visibility).toBe("public_edit");
  });

  it("private に戻すと一覧から消える", async () => {
    const owner = await loginAs("7114", "visback");
    const session = await newSession(owner.cookie, "戻す作戦");
    const other = await loginAs("7115", "visbackother");

    await setVisibility(owner.cookie, session.id, "public");
    expect(
      (await (await listSessions(other.cookie)).json()).public.map((s) => s.id)
    ).toContain(session.id);

    await setVisibility(owner.cookie, session.id, "private");
    expect(
      (await (await listSessions(other.cookie)).json()).public.map((s) => s.id)
    ).not.toContain(session.id);
  });

  it("自分が作ったものは public に入らない（sessions と重複させない）", async () => {
    const owner = await loginAs("7116", "visself");
    const session = await newSession(owner.cookie, "自分の公開作戦");
    await setVisibility(owner.cookie, session.id, "public");

    const body = await (await listSessions(owner.cookie)).json();
    expect(body.sessions.map((s) => s.id)).toContain(session.id);
    expect(body.public.map((s) => s.id), "自分の作戦は public に重複させない")
      .not.toContain(session.id);
    // 自分の行にも状態を返す（画面が札を出すのに要る）。
    expect(body.sessions.find((s) => s.id === session.id).visibility).toBe("public");
  });

  it("未ログインでは 401（公開しても見えない。条件6）", async () => {
    const owner = await loginAs("7117", "visanon");
    const session = await newSession(owner.cookie, "未ログインに見せない作戦");
    await setVisibility(owner.cookie, session.id, "public");

    expect(await statusOf(listSessions("")), "一覧").toBe(401);
    expect(await statusOf(getSession("", session.id)), "作戦そのもの").toBe(401);

    await setVisibility(owner.cookie, session.id, "public_edit");
    expect(await statusOf(getSession("", session.id)), "public_edit でも 401").toBe(401);
  });

  it("updated_at の新しい順に並ぶ", async () => {
    const owner = await loginAs("7118", "visorder");
    const a = await newSession(owner.cookie, "公開の古いほう");
    const b = await newSession(owner.cookie, "公開の新しいほう");
    const other = await loginAs("7119", "visorderother");

    await setVisibility(owner.cookie, a.id, "public");
    await setVisibility(owner.cookie, b.id, "public");
    execD1(`UPDATE sessions SET updated_at = 1000 WHERE id = '${a.id}'`);

    const ids = (await (await listSessions(other.cookie)).json()).public.map((s) => s.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });
});

describe("public は読専 — 書き込む経路を総当たり（条件3）", () => {
  // 下ごしらえ: 作戦を public_edit にして他人に1件ずつ作らせ、そのあと public に締める。
  // こうすると「自分が作った行を直す／消す」になるので、**既存の所有者判定ではなく
  // 公開設定だけ**が 403 の理由になる。
  async function setupPublicPlan(ownerId, otherId, label) {
    const owner = await loginAs(ownerId, `vispub${ownerId}`);
    const other = await loginAs(otherId, `visoth${otherId}`);
    const session = await newSession(owner.cookie, label);

    await setVisibility(owner.cookie, session.id, "public_edit");
    const rowIds = {};
    for (const name of ROUTE_NAMES) {
      rowIds[name] = await createRow(name, other.cookie, session.id);
    }
    await setVisibility(owner.cookie, session.id, "public");
    return { owner, other, session, rowIds };
  }

  it("作成者以外は6つの経路すべてで 403（新規・更新・削除）", async () => {
    const { other, session, rowIds } = await setupPublicPlan("7120", "7121", "読専の作戦");

    const denied = [];
    for (const name of ROUTE_NAMES) {
      const route = ROUTES[name];
      const create = await statusOf(route.create(other.cookie, session.id));
      if (create !== 403) denied.push(`${route.label} の新規が ${create}`);

      if (route.patch) {
        const patch = await statusOf(route.patch(other.cookie, session.id, rowIds[name]));
        if (patch !== 403) denied.push(`${route.label} の更新が ${patch}`);
      }
      if (route.del) {
        const del = await statusOf(route.del(other.cookie, session.id, rowIds[name]));
        if (del !== 403) denied.push(`${route.label} の削除が ${del}`);
      }
    }
    expect(denied, "403 にならなかった経路がある（そこから書ける穴）").toEqual([]);
  });

  it("読専でも読めるし、他人が置いた行は残っている", async () => {
    const { other, session, rowIds } = await setupPublicPlan("7122", "7123", "読める作戦");

    const r = await getSession(other.cookie, session.id);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.session.visibility).toBe("public");
    expect(body.strokes.length, "インクは読める").toBeGreaterThan(0);
    expect(body.areas.length, "エリアは読める").toBeGreaterThan(0);

    expect(
      await statusOf(fetch(url(`/api/sessions/${session.id}/placements`), {
        headers: { cookie: other.cookie },
      }))
    ).toBe(200);
    expect(
      await statusOf(fetch(url(`/api/sessions/${session.id}/callouts`), {
        headers: { cookie: other.cookie },
      }))
    ).toBe(200);
    expect(rowIds.placements, "placements の行は消えていない").toBeTruthy();
  });

  it("作成者自身は読専でも書ける（自分の作戦を自分で締めても手が止まらない）", async () => {
    const owner = await loginAs("7124", "visownerwrite");
    const session = await newSession(owner.cookie, "作成者が書く作戦");
    await setVisibility(owner.cookie, session.id, "public");

    for (const name of ROUTE_NAMES) {
      const res = await ROUTES[name].create(owner.cookie, session.id);
      const status = res.status;
      await res.text();
      expect(status, `${ROUTES[name].label} を作成者が書けない`).toBeLessThan(300);
    }
  });

  it("admin は読専でも書ける", async () => {
    const owner = await loginAs("7125", "visadminowner");
    const session = await newSession(owner.cookie, "admin が書く作戦");
    const admin = await loginAs("7126", "visadminw");
    execD1("UPDATE users SET role = 'admin' WHERE discord_id = '7126'");
    await setVisibility(owner.cookie, session.id, "public");

    for (const name of ROUTE_NAMES) {
      const res = await ROUTES[name].create(admin.cookie, session.id);
      const status = res.status;
      await res.text();
      expect(status, `${ROUTES[name].label} を admin が書けない`).toBeLessThan(300);
    }
  });
});

describe("public_edit は書ける（条件4）", () => {
  it("作成者以外が6つの経路すべてで書ける", async () => {
    const owner = await loginAs("7130", "visedowner");
    const other = await loginAs("7131", "visedother");
    const session = await newSession(owner.cookie, "書き込める作戦");
    await setVisibility(owner.cookie, session.id, "public_edit");

    const failed = [];
    for (const name of ROUTE_NAMES) {
      const res = await ROUTES[name].create(other.cookie, session.id);
      const status = res.status;
      const text = await res.text();
      if (status >= 300) failed.push(`${ROUTES[name].label} が ${status}: ${text}`);
    }
    expect(failed).toEqual([]);
  });
});

describe("private は従来どおり（条件5。退行していないこと）", () => {
  // **ここが「締めすぎ」を見張る唯一のテスト。**
  // 非公開の作戦の URL を配って共同編集する、という今の使い方そのもの。
  it("URL を渡された相手が閲覧も書き込みもできる", async () => {
    const owner = await loginAs("7140", "visprivowner");
    const other = await loginAs("7141", "visprivother");
    const session = await newSession(owner.cookie, "非公開の共同編集");

    const read = await getSession(other.cookie, session.id);
    expect(read.status, "URL を知っていれば読める").toBe(200);
    expect((await read.json()).session.visibility).toBe("private");

    const failed = [];
    const rowIds = {};
    for (const name of ROUTE_NAMES) {
      const res = await ROUTES[name].create(other.cookie, session.id);
      const status = res.status;
      const body = await res.json().catch(() => ({}));
      if (status >= 300) failed.push(`${ROUTES[name].label} の新規が ${status}`);
      rowIds[name] = body.ids?.[0] ?? null;
    }
    expect(failed, "非公開の共同編集を締めてはいけない").toEqual([]);

    // 自分が置いたものは直せる・消せる（従来の所有者判定のまま）。
    for (const name of ROUTE_NAMES) {
      const route = ROUTES[name];
      if (route.patch) {
        expect(
          await statusOf(route.patch(other.cookie, session.id, rowIds[name])),
          `${route.label} の更新`
        ).toBe(200);
      }
      if (route.del) {
        expect(
          await statusOf(route.del(other.cookie, session.id, rowIds[name])),
          `${route.label} の削除`
        ).toBe(200);
      }
    }
  });

  it("他の人が置いたものは動かせないまま（別の層。公開設定で緩めない）", async () => {
    const owner = await loginAs("7142", "visownlayer");
    const other = await loginAs("7143", "visothlayer");
    const session = await newSession(owner.cookie, "所有者判定の作戦");
    await setVisibility(owner.cookie, session.id, "public_edit");

    const mine = await createRow("placements", owner.cookie, session.id);
    expect(
      await statusOf(ROUTES.placements.del(other.cookie, session.id, mine)),
      "public_edit でも他人の配置は消せない"
    ).toBe(403);
  });

  // 3つ以外の値が DB に入っていたときの倒れ方。**締まるほうに倒さない。**
  // API は3つしか受けないので普段は起きないが、ここで「知らない値 → 読専」に
  // 倒すと、将来値を増やし損ねた日に既存の共同編集が全部 403 になる。
  it("3つ以外の値が入っていても private として扱う（締まるほうに倒さない）", async () => {
    const owner = await loginAs("7144", "visweird");
    const other = await loginAs("7145", "visweirdother");
    const session = await newSession(owner.cookie, "知らない値の作戦");
    execD1(`UPDATE sessions SET visibility = 'weird' WHERE id = '${session.id}'`);

    const read = await getSession(other.cookie, session.id);
    expect(read.status).toBe(200);
    expect((await read.json()).session.visibility, "知らない値は private に読み替える")
      .toBe("private");
    expect(
      await statusOf(ROUTES.placements.create(other.cookie, session.id)),
      "書けること（＝締まっていないこと）が大事"
    ).toBe(201);
    expect(
      (await (await listSessions(other.cookie)).json()).public.map((s) => s.id),
      "知らない値は一覧に出さない"
    ).not.toContain(session.id);
  });
});
