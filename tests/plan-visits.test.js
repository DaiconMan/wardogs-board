// 訪問履歴（session_visits）の統合テスト。
//
// 共有URLで開いた「他人の作戦」に、URL を無くしたあとでも辿り着けるようにする機能。
// GET /api/sessions/{id} が成功したときに upsert し、GET /api/sessions が
// `visited` として返す。
//
// プライバシー方針: 訪問記録は本人だけが読む。作成者に「誰が見たか」を返す API は無い。
// このテストでも、作成者側から閲覧者を引く経路は一切検証しない（存在しないため）。
import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs, execD1 } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

function createSession(cookie, body = { map_id: "bakurani", title: "テスト作戦" }) {
  return fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function newSession(cookie, title = "テスト作戦") {
  const r = await createSession(cookie, { map_id: "bakurani", title });
  expect(r.status).toBe(201);
  return (await r.json()).session;
}

const getSession = (cookie, id) =>
  fetch(url(`/api/sessions/${id}`), { headers: cookie ? { cookie } : {} });

const listSessions = (cookie) => fetch(url("/api/sessions"), { headers: { cookie } });

/**
 * 応答の status だけを見る。**本文は必ず読み捨てる。**
 *
 * Node の fetch は本文を自動では流し切らないので、`.status` だけ見て捨てると
 * keep-alive の接続が本文を抱えたまま残る。このファイルは「開く」だけが目的の
 * GET を何度も投げるので、残った接続がサーバの idle タイムアウト（5,000ms）で
 * 切られ、後続の fetch が UND_ERR_SOCKET で落ちる形になる（実測）。
 */
async function statusOf(pending) {
  const res = await pending;
  await res.text();
  return res.status;
}

/** execD1 は wrangler の案内バナーの後ろに JSON 配列を吐く。先頭の "[" から拾う。 */
function query(sql) {
  const out = execD1(sql);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

const visitsOf = (sessionId) =>
  query(`SELECT * FROM session_visits WHERE session_id = '${sessionId}' ORDER BY user_id`);

describe("GET /api/sessions/{id} が訪問を記録する", () => {
  it("他人の作戦を開くと session_visits に1行できる", async () => {
    const owner = await loginAs("6001", "visitowner");
    const session = await newSession(owner.cookie, "他人の作戦");
    const other = await loginAs("6002", "visitor");

    expect(visitsOf(session.id).length).toBe(0);

    expect(await statusOf(getSession(other.cookie, session.id))).toBe(200);

    const rows = visitsOf(session.id);
    expect(rows.length).toBe(1);
    expect(rows[0].user_id).toBe("6002");
    expect(rows[0].first_seen_at).toBe(rows[0].last_seen_at);
    expect(rows[0].first_seen_at).toBeGreaterThan(0);
  });

  it("同じ作戦を2回開いても1行のまま、last_seen_at だけ進む", async () => {
    const owner = await loginAs("6003", "visitowner2");
    const session = await newSession(owner.cookie, "2回開く作戦");
    const other = await loginAs("6004", "visitor2");

    expect(await statusOf(getSession(other.cookie, session.id))).toBe(200);

    // 1回目と2回目が同じ秒に入ると差が見えないので、時刻を過去へ戻してから開き直す。
    execD1(
      `UPDATE session_visits SET first_seen_at = 1000, last_seen_at = 1000
         WHERE session_id = '${session.id}' AND user_id = '6004'`
    );

    expect(await statusOf(getSession(other.cookie, session.id))).toBe(200);

    const rows = visitsOf(session.id);
    expect(rows.length).toBe(1);
    expect(rows[0].first_seen_at, "first_seen_at は初回のまま").toBe(1000);
    expect(rows[0].last_seen_at, "last_seen_at は更新される").toBeGreaterThan(1000);
  });

  it("未ログインで開いても記録されない（401）", async () => {
    const owner = await loginAs("6005", "visitowner3");
    const session = await newSession(owner.cookie, "未ログインで開く作戦");

    expect(await statusOf(getSession("", session.id))).toBe(401);
    expect(visitsOf(session.id).length).toBe(0);
  });

  it("存在しない作戦を開いても記録されない（404）", async () => {
    const { cookie } = await loginAs("6006", "visitor404");
    const missing = "AAAAAAAAAAAAAAAAAAAAAA";
    expect(await statusOf(getSession(cookie, missing))).toBe(404);
    expect(visitsOf(missing).length).toBe(0);
  });

  // 履歴は付加機能。書き込みに失敗しても盤面が開けなくなってはいけない。
  // テーブルを一時的に退避して、記録だけが必ず失敗する状態を実際に作る。
  it("記録に失敗しても盤面の取得は 200 で成功する", async () => {
    const owner = await loginAs("6007", "visitowner4");
    const session = await newSession(owner.cookie, "記録が壊れた作戦");
    const other = await loginAs("6008", "visitor5");

    execD1("ALTER TABLE session_visits RENAME TO session_visits_backup");
    try {
      const r = await getSession(other.cookie, session.id);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.session.id).toBe(session.id);
      expect(body.map.id).toBe("bakurani");
    } finally {
      execD1("ALTER TABLE session_visits_backup RENAME TO session_visits");
    }

    // 復旧後は普通に記録される。
    expect(await statusOf(getSession(other.cookie, session.id))).toBe(200);
    expect(visitsOf(session.id).length).toBe(1);
  });
});

describe("GET /api/sessions の visited", () => {
  it("訪問した他人の作戦が visited に返る（sessions には混ざらない）", async () => {
    const owner = await loginAs("6010", "sharer");
    const session = await newSession(owner.cookie, "共有された作戦");
    const me = await loginAs("6011", "receiver");

    expect(await statusOf(getSession(me.cookie, session.id))).toBe(200);

    const r = await listSessions(me.cookie);
    expect(r.status).toBe(200);
    const body = await r.json();

    expect(body.sessions, "自分は何も作っていない").toEqual([]);
    expect(body.visited.length).toBe(1);
    const v = body.visited[0];
    expect(v.id).toBe(session.id);
    expect(v.title).toBe("共有された作戦");
    expect(v.map_id).toBe("bakurani");
    expect(v.created_by_name, "作成者の表示名").toBe("sharer");
    expect(v.last_seen_at).toBeGreaterThan(0);
  });

  // **保存は増やしていない。** `users.avatar` は Discord ログインの時点から
  // 保存していて（callback.js）、画面で1箇所も使っていなかっただけ。
  // 一覧は既にある `LEFT JOIN users` に1列足すだけで足りる。
  //
  // **返すのは hash で、画像ではない。** URL に組み立ててブラウザが
  // Discord の CDN から直接読む（こちらは画像を一度も受け取らない）。
  it("作成者のアイコンの hash を返す（画像は中継しない）", async () => {
    const face = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const owner = await loginAs("6020", "facesharer", { avatar: face });
    const session = await newSession(owner.cookie, "アイコン付きの作戦");
    const me = await loginAs("6021", "facereceiver");

    expect(await statusOf(getSession(me.cookie, session.id))).toBe(200);
    const body = await (await listSessions(me.cookie)).json();
    const v = body.visited.find((s) => s.id === session.id);
    expect(v.created_by_avatar).toBe(face);
    // hash だけ。画像そのものも URL も返さない。
    expect(JSON.stringify(v)).not.toContain("cdn.discordapp.com");
  });

  // Discord の既定アイコンの人。**鍵は返るが空**で、画面は色の丸に戻る。
  it("アイコンを持たない作成者は null（画面は色の丸に戻る）", async () => {
    const owner = await loginAs("6022", "noface");
    const session = await newSession(owner.cookie, "アイコン無しの作戦");
    const me = await loginAs("6023", "nofacereceiver");

    expect(await statusOf(getSession(me.cookie, session.id))).toBe(200);
    const body = await (await listSessions(me.cookie)).json();
    expect(body.visited.find((s) => s.id === session.id).created_by_avatar).toBe(null);
  });

  it("自分が作った作戦は visited に入らない（sessions のまま）", async () => {
    const me = await loginAs("6012", "selfvisit");
    const mine = await newSession(me.cookie, "自分の作戦");

    expect(await statusOf(getSession(me.cookie, mine.id))).toBe(200);
    // 記録自体はされる（「最後に開いた順」を将来使えるように）。
    expect(visitsOf(mine.id).length).toBe(1);

    const body = await (await listSessions(me.cookie)).json();
    expect(body.sessions.map((s) => s.id)).toContain(mine.id);
    expect(body.visited.map((s) => s.id), "自分の作戦は重複させない").not.toContain(mine.id);
  });

  it("last_seen_at の新しい順に並ぶ", async () => {
    const owner = await loginAs("6013", "orderowner");
    const a = await newSession(owner.cookie, "古いほう");
    const b = await newSession(owner.cookie, "新しいほう");
    const me = await loginAs("6014", "orderviewer");

    expect(await statusOf(getSession(me.cookie, a.id))).toBe(200);
    expect(await statusOf(getSession(me.cookie, b.id))).toBe(200);
    // 同じ秒に入ると順序が決まらないので、a を明示的に古くする。
    execD1(
      `UPDATE session_visits SET last_seen_at = 1000
         WHERE session_id = '${a.id}' AND user_id = '6014'`
    );

    const body = await (await listSessions(me.cookie)).json();
    expect(body.visited.map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it("訪問した作戦が削除されたら visited に出てこない", async () => {
    const owner = await loginAs("6015", "delowner");
    const session = await newSession(owner.cookie, "消される作戦");
    const me = await loginAs("6016", "delviewer");

    expect(await statusOf(getSession(me.cookie, session.id))).toBe(200);
    expect(await statusOf(listSessions(me.cookie))).toBe(200);

    const del = fetch(url(`/api/sessions/${session.id}`), {
      method: "DELETE",
      headers: { cookie: owner.cookie, origin: ORIGIN },
    });
    expect(await statusOf(del)).toBe(200);

    // 子テーブルとして消える。
    expect(visitsOf(session.id).length).toBe(0);

    const body = await (await listSessions(me.cookie)).json();
    expect(body.visited.map((s) => s.id)).not.toContain(session.id);
  });

  it("取りこぼした孤児の訪問記録は visited に出ない（sessions と JOIN する）", async () => {
    const me = await loginAs("6017", "orphanviewer");
    const ghost = "GHOSTGHOSTGHOSTGHOSTGH";
    execD1(
      `INSERT INTO session_visits (session_id, user_id, first_seen_at, last_seen_at)
       VALUES ('${ghost}', '6017', 1000, 2000)`
    );

    const body = await (await listSessions(me.cookie)).json();
    expect(body.visited.map((s) => s.id)).not.toContain(ghost);
  });

  // 下ごしらえは DB へ直接入れる。ここで確かめたいのは
  // 「GET /api/sessions が 50 件で切って新しい順に返すこと」であって、
  // セッション作成 API の挙動ではない。
  //
  // 行を SQL の文面に並べず、再帰 CTE で D1 側に生成させている。
  // もともとは execD1 が1回ごとに wrangler のプロセスを立てていた頃の回避策
  // （D-035）だが、SQLite の直接オープンになった今も残してある。51行を
  // 文面に展開するより短く、「1..51 を入れた」という意図がそのまま読めるため。
  const SEED_COUNT = 51; // 上限 50 をちょうど1件超える数

  it("上限は50件。溢れるのは古いほう", async () => {
    await loginAs("6018", "manyowner");
    const me = await loginAs("6019", "manyviewer");

    // last_seen_at を 1..51 にして「新しいほう50件」が何かをはっきりさせる。
    const series =
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SEED_COUNT})`;
    execD1(
      `${series}
       INSERT INTO sessions (id, map_id, title, created_by, created_at, updated_at)
       SELECT printf('MANY%018d', i), 'bakurani', '作戦' || i, '6018', 1000, 1000 FROM n`
    );
    execD1(
      `${series}
       INSERT INTO session_visits (session_id, user_id, first_seen_at, last_seen_at)
       SELECT printf('MANY%018d', i), '6019', i, i FROM n`
    );

    const body = await (await listSessions(me.cookie)).json();
    const titles = body.visited.map((s) => s.title);
    expect(titles.length, `${SEED_COUNT}件訪問しても50件で切る`).toBe(50);
    expect(titles[0], "先頭は最後に開いたもの").toBe("作戦51");
    expect(titles[49], "末尾は51件中の新しいほうから50番目").toBe("作戦2");
    expect(titles, "溢れるのは最も古い1件").not.toContain("作戦1");
  });
});
