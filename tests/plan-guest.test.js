// ログイン無しで見る（ゲスト）の統合テスト。
//
// 仕様: docs/superpowers/specs/2026-10-02-guest-viewers.md
//
// ── このファイルが落とせない2点 ───────────────────────────────────
//
// **1. 書き込みが全ルートで弾かれること。**
//    placements / ink / areas / callouts / zone を**総当たり**で確かめる
//    （メソッドまで数えると10本以上ある）。D-070 で `canWrite` の門を1関数に
//    まとめたので、ゲストはその**手前**で落ちる＝読み取りのルートだけを
//    `requireViewer` に替えるのが正。1本間違えると身元の無い書き込みが通る。
//
// **2. `users` にも `session_visits` にもゲストの行が1件も増えないこと。**
//    ゲストは Durable Object の部屋の中にだけ存在する。**これが設計の一番の価値**で、
//    「ゲストの訪問履歴があると便利」で崩すと意味が無くなる。
//
// この2つが「ゲストを入れても安全」の根拠。**どちらも落とさないこと。**
import { describe, it, expect, beforeAll } from "vitest";
import { request as httpRequest } from "node:http";

import { GUEST_HEADER, newGuestId, guestName } from "../functions/_lib/guest.js";
import { startServers, stopServers, baseUrl, loginAs, execD1 } from "./plan-helpers.js";

/** zone の PUT を試すのに要る bakurani のパターン（plan-visibility.test.js と同じ下ごしらえ）。 */
const PRESET_ID = "guest-bakurani-default";

beforeAll(async () => {
  await startServers();
  execD1(
    `INSERT OR IGNORE INTO map_zone_presets
       (id, map_id, key, name, x_m, y_m, radius_m, source,
        verified, sort_order, created_at, updated_at)
     VALUES ('${PRESET_ID}', 'bakurani', 'GuestTest', 'ゲストのテスト用',
             8000.0, 8000.0, 500.0, 'tests/plan-guest.test.js の下ごしらえ',
             0, 11, 1000, 1000)`
  );
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

/** ゲストのヘッダだけを持つリクエスト（Cookie は付けない）。 */
const asGuest = (id, extra = {}) => ({ [GUEST_HEADER]: id, ...extra });
const guestJson = (id) => asGuest(id, { origin: ORIGIN, "content-type": "application/json" });

async function statusOf(pending) {
  const res = await pending;
  await res.text();
  return res.status;
}

async function newSession(cookie, title = "ゲストのテスト") {
  const r = await fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ map_id: "bakurani", title }),
  });
  expect(r.status, "作戦を作れなかった").toBe(201);
  return (await r.json()).session;
}

const setVisibility = async (cookie, id, visibility) => {
  const status = await statusOf(fetch(url(`/api/sessions/${id}`), {
    method: "PATCH",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ visibility }),
  }));
  expect(status, `${visibility} に切り替えられなかった`).toBe(200);
};

/** `execD1` は文ごとの JSON 配列を文字列で返す。1件の数だけ取り出す。 */
function scalar(sql) {
  const out = execD1(sql);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results[0].n;
}

/** 行数を数える。**ゲストが1件も増やしていないこと**を見るのに使う。 */
const countOf = (table) => Number(scalar(`SELECT COUNT(*) AS n FROM ${table}`));

let uuidSeq = 0;
const uuid = () => `guest-${Date.now().toString(36)}-${(uuidSeq += 1)}`;

// ── 書き込む経路。**5種類すべて、メソッドまで総当たり。**──────────────
//
// `plan-visibility.test.js` の表と同じ形にしてある（あちらは公開設定、
// こちらは身元）。**片方だけに経路を足せる形にしないこと。**
const WRITE_ROUTES = [
  {
    label: "placements POST",
    call: (headers, id) => fetch(url(`/api/sessions/${id}/placements`), {
      method: "POST", headers,
      body: JSON.stringify({
        placements: [{ client_uuid: uuid(), item_id: "fob", x_m: 1000, y_m: 1000 }],
      }),
    }),
  },
  {
    label: "placements PATCH",
    call: (headers, id, rows) => fetch(url(`/api/sessions/${id}/placements?id=${rows.placements}`), {
      method: "PATCH", headers, body: JSON.stringify({ x_m: 1200, y_m: 1200 }),
    }),
  },
  {
    label: "placements DELETE",
    call: (headers, id, rows) => fetch(url(`/api/sessions/${id}/placements?id=${rows.placements}`), {
      method: "DELETE", headers,
    }),
  },
  {
    label: "ink POST",
    call: (headers, id) => fetch(url(`/api/sessions/${id}/ink`), {
      method: "POST", headers,
      body: JSON.stringify({
        strokes: [{ client_uuid: uuid(), color: "cursor-1", width: 2, points: [100, 100, 200, 200] }],
      }),
    }),
  },
  {
    label: "ink DELETE",
    call: (headers, id, rows) => fetch(url(`/api/sessions/${id}/ink?id=${rows.ink}`), {
      method: "DELETE", headers,
    }),
  },
  {
    label: "areas POST",
    call: (headers, id) => fetch(url(`/api/sessions/${id}/areas`), {
      method: "POST", headers,
      body: JSON.stringify({ areas: [{ client_uuid: uuid(), kind: "own", rects: [[1, 1, 2, 2]] }] }),
    }),
  },
  {
    label: "areas DELETE",
    call: (headers, id, rows) => fetch(url(`/api/sessions/${id}/areas?id=${rows.areas}`), {
      method: "DELETE", headers,
    }),
  },
  {
    label: "callouts POST",
    call: (headers, id) => fetch(url(`/api/sessions/${id}/callouts`), {
      method: "POST", headers,
      body: JSON.stringify({ callouts: [{ client_uuid: uuid(), name: "あの丘", x_m: 2000, y_m: 2000 }] }),
    }),
  },
  {
    label: "callouts PATCH",
    call: (headers, id, rows) => fetch(url(`/api/sessions/${id}/callouts?id=${rows.callouts}`), {
      method: "PATCH", headers, body: JSON.stringify({ name: "あの丘（改）" }),
    }),
  },
  {
    label: "callouts DELETE",
    call: (headers, id, rows) => fetch(url(`/api/sessions/${id}/callouts?id=${rows.callouts}`), {
      method: "DELETE", headers,
    }),
  },
  {
    label: "zone PUT",
    call: (headers, id) => fetch(url(`/api/sessions/${id}/zone`), {
      method: "PUT", headers, body: JSON.stringify({ preset_id: PRESET_ID }),
    }),
  },
  // 作戦そのものを触る2本。**`canWrite` の門を通らない経路**なので、
  // 表に入れておかないと「ゲストが他人の作戦を消せる」が静かに残る。
  {
    label: "session PATCH（公開設定）",
    call: (headers, id) => fetch(url(`/api/sessions/${id}`), {
      method: "PATCH", headers, body: JSON.stringify({ visibility: "public_edit" }),
    }),
  },
  {
    label: "session DELETE",
    call: (headers, id) => fetch(url(`/api/sessions/${id}`), { method: "DELETE", headers }),
  },
  {
    label: "sessions POST（作戦を作る）",
    call: (headers) => fetch(url("/api/sessions"), {
      method: "POST", headers,
      body: JSON.stringify({ map_id: "bakurani", title: "ゲストが作った作戦" }),
    }),
  },
  // マップのプリセット（admin だけが書ける）。ゲストが admin になれないこと。
  {
    label: "zone-presets POST",
    call: (headers) => fetch(url("/api/maps/bakurani/zone-presets"), {
      method: "POST", headers,
      body: JSON.stringify({ key: "GuestZone", name: "ゲストの円", x: 80, y: 80 }),
    }),
  },
];

/** 下ごしらえ: ログイン済みの人が1件ずつ行を作っておく（PATCH / DELETE の的）。 */
async function seedRows(cookie, sessionId) {
  const rows = {};
  const make = async (path, body) => {
    const r = await fetch(url(`/api/sessions/${sessionId}/${path}`), {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const got = await r.json();
    expect(r.status, `${path} の下ごしらえが ${r.status}: ${JSON.stringify(got)}`).toBe(201);
    return got.ids[0];
  };
  rows.placements = await make("placements", {
    placements: [{ client_uuid: uuid(), item_id: "fob", x_m: 3000, y_m: 3000 }],
  });
  rows.ink = await make("ink", {
    strokes: [{ client_uuid: uuid(), color: "cursor-1", width: 2, points: [10, 10, 20, 20] }],
  });
  rows.areas = await make("areas", {
    areas: [{ client_uuid: uuid(), kind: "own", rects: [[3, 3, 4, 4]] }],
  });
  rows.callouts = await make("callouts", {
    callouts: [{ client_uuid: uuid(), name: "見張りの丘", x_m: 4000, y_m: 4000 }],
  });
  return rows;
}

describe("条件1: URL を知っている作戦を、ログイン無しで開ける", () => {
  it("非公開（private）の作戦も開ける。中身も読める", async () => {
    const owner = await loginAs("7200", "guestowner1");
    const session = await newSession(owner.cookie, "ゲストが見る非公開の作戦");
    await seedRows(owner.cookie, session.id);
    const guest = newGuestId();

    const r = await fetch(url(`/api/sessions/${session.id}`), { headers: asGuest(guest) });
    expect(r.status, "非公開の作戦をゲストが開けない").toBe(200);
    const body = await r.json();
    expect(body.session.visibility).toBe("private");
    expect(body.map.name, "マップが付いてくる").toBeTruthy();
    expect(body.strokes.length, "インクが読める").toBeGreaterThan(0);
    expect(body.areas.length, "エリアが読める").toBeGreaterThan(0);
    expect(Array.isArray(body.towers), "タワーが読める").toBe(true);
    expect(Array.isArray(body.zone_presets), "ゾーンのプリセットが読める").toBe(true);
  });

  it("placements / callouts / catalog / maps / zone-presets も読める", async () => {
    const owner = await loginAs("7201", "guestowner2");
    const session = await newSession(owner.cookie, "ゲストが読む枝葉");
    await seedRows(owner.cookie, session.id);
    const guest = newGuestId();

    const paths = [
      `/api/sessions/${session.id}/placements`,
      `/api/sessions/${session.id}/callouts`,
      "/api/catalog",
      "/api/maps",
      "/api/maps/bakurani/zone-presets",
    ];
    const failed = [];
    for (const p of paths) {
      const status = await statusOf(fetch(url(p), { headers: asGuest(guest) }));
      if (status !== 200) failed.push(`${p} が ${status}`);
    }
    expect(failed, "ゲストが読めないルートがある").toEqual([]);
  });

  it("存在しない作戦は 404（身元が無いことを理由に 401 で隠さない）", async () => {
    const guest = newGuestId();
    expect(
      await statusOf(fetch(url("/api/sessions/AAAAAAAAAAAAAAAAAAAAAA"), { headers: asGuest(guest) }))
    ).toBe(404);
  });
});

describe("条件4: 書き込みが全部弾かれる（総当たり）", () => {
  it("5経路すべて・全メソッドで 401（成功した経路が1つも無い）", async () => {
    const owner = await loginAs("7210", "guestwriteowner");
    const session = await newSession(owner.cookie, "ゲストが書けない作戦");
    const rows = await seedRows(owner.cookie, session.id);
    const guest = newGuestId();

    const passed = [];
    for (const route of WRITE_ROUTES) {
      const status = await statusOf(route.call(guestJson(guest), session.id, rows));
      // 401（ログインが必要）であること。**403 でも 404 でもなく 401。**
      // 直し方が「ログインする」なので、そう読める番号を返す。
      if (status !== 401) passed.push(`${route.label} が ${status}`);
    }
    expect(passed, "ゲストの書き込みが 401 で止まらなかった経路がある").toEqual([]);
  });

  // **public_edit は「ログインしている人なら誰でも書ける」。ゲストは入らない。**
  // ここを取り違えると、公開して共同編集にした作戦が誰でも書ける板になる。
  it("public_edit の作戦でも書けない", async () => {
    const owner = await loginAs("7211", "guesteditowner");
    const session = await newSession(owner.cookie, "書き込みを許した作戦");
    const rows = await seedRows(owner.cookie, session.id);
    await setVisibility(owner.cookie, session.id, "public_edit");
    const guest = newGuestId();

    const passed = [];
    for (const route of WRITE_ROUTES) {
      const status = await statusOf(route.call(guestJson(guest), session.id, rows));
      if (status !== 401) passed.push(`${route.label} が ${status}`);
    }
    expect(passed, "public_edit でゲストが書けてしまった経路がある").toEqual([]);
  });

  it("書けなかったあと、行が1件も増えていない", async () => {
    const owner = await loginAs("7212", "guestnorowowner");
    const session = await newSession(owner.cookie, "行が増えない作戦");
    const rows = await seedRows(owner.cookie, session.id);
    const guest = newGuestId();

    const before = {
      placements: countOf("placements"),
      ink_strokes: countOf("ink_strokes"),
      session_areas: countOf("session_areas"),
      session_callouts: countOf("session_callouts"),
      sessions: countOf("sessions"),
    };
    for (const route of WRITE_ROUTES) {
      await statusOf(route.call(guestJson(guest), session.id, rows));
    }
    for (const [table, n] of Object.entries(before)) {
      expect(countOf(table), `${table} の行数が変わった`).toBe(n);
    }
  });
});

describe("条件5: users にも session_visits にもゲストの行が増えない", () => {
  it("作戦を何度も開いても、どちらの表も1行も増えない", async () => {
    const owner = await loginAs("7220", "guestvisitowner");
    const session = await newSession(owner.cookie, "ゲストが何度も開く作戦");
    const guest = newGuestId();

    const usersBefore = countOf("users");
    const visitsBefore = countOf("session_visits");

    // 読めるルートを一通り、しかも何度も叩く。
    for (let i = 0; i < 5; i += 1) {
      await statusOf(fetch(url(`/api/sessions/${session.id}`), { headers: asGuest(guest) }));
      await statusOf(fetch(url(`/api/sessions/${session.id}/placements`), { headers: asGuest(guest) }));
      await statusOf(fetch(url(`/api/sessions/${session.id}/callouts`), { headers: asGuest(guest) }));
      await statusOf(fetch(url("/api/sessions"), { headers: asGuest(guest) }));
      await statusOf(fetch(url("/api/me"), { headers: asGuest(guest) }));
    }

    expect(countOf("users"), "users にゲストの行が増えた").toBe(usersBefore);
    expect(countOf("session_visits"), "session_visits にゲストの行が増えた").toBe(visitsBefore);
    // 念のため、その身元の行が本当に無いことも名指しで見る。
    expect(
      Number(scalar(`SELECT COUNT(*) AS n FROM users WHERE discord_id = '${guest}'`))
    ).toBe(0);
    expect(
      Number(scalar(`SELECT COUNT(*) AS n FROM session_visits WHERE user_id = '${guest}'`))
    ).toBe(0);
  });

  it("ログイン済みの訪問記録は今までどおり残る（条件8の退行見張り）", async () => {
    const owner = await loginAs("7221", "guestvisitown2");
    const session = await newSession(owner.cookie, "ログイン済みが開く作戦");
    const other = await loginAs("7222", "guestvisitother");

    await statusOf(fetch(url(`/api/sessions/${session.id}`), { headers: { cookie: other.cookie } }));
    expect(
      Number(scalar(
        `SELECT COUNT(*) AS n FROM session_visits
          WHERE user_id = '7222' AND session_id = '${session.id}'`
      )),
      "ログイン済みの訪問記録が消えた"
    ).toBe(1);
  });
});

describe("条件6: anon: の接頭辞が無い身元を受け付けない", () => {
  it("Discord ID をそのまま送っても 401（なりすましの入口を塞ぐ）", async () => {
    const owner = await loginAs("7230", "guestspoofowner");
    const session = await newSession(owner.cookie, "なりすましを試す作戦");

    const bad = [
      "7230",                          // 作成者の Discord ID そのもの
      "1234567890123456789",
      "anon7230",
      "anon:",
      "anon:short",
      `anon:${"a".repeat(23)}`,
      `anon:${"a".repeat(21)}+`,
      `ANON:${"a".repeat(22)}`,
      "admin",
      "",
    ];
    const accepted = [];
    for (const value of bad) {
      const status = await statusOf(
        fetch(url(`/api/sessions/${session.id}`), { headers: { [GUEST_HEADER]: value } })
      );
      if (status !== 401) accepted.push(`${JSON.stringify(value)} が ${status}`);
    }
    expect(accepted, "接頭辞の無い身元を受け入れてしまった").toEqual([]);
  });

  it("ヘッダも Cookie も無ければ 401（今までどおり）", async () => {
    const owner = await loginAs("7231", "guestnoneowner");
    const session = await newSession(owner.cookie, "身元が無い作戦");
    expect(await statusOf(fetch(url(`/api/sessions/${session.id}`))), "作戦").toBe(401);
    expect(await statusOf(fetch(url("/api/sessions"))), "一覧").toBe(401);
    expect(await statusOf(fetch(url("/api/catalog"))), "カタログ").toBe(401);
    expect(await statusOf(fetch(url("/api/maps"))), "マップ").toBe(401);
  });

  // **ログインが先。** ゲストのヘッダを添えても、Cookie があればその人として扱う。
  it("Cookie があればゲストのヘッダは無視される", async () => {
    const owner = await loginAs("7232", "guestboth");
    const session = await newSession(owner.cookie, "両方送る作戦");
    const r = await fetch(url("/api/me"), {
      headers: { cookie: owner.cookie, [GUEST_HEADER]: newGuestId() },
    });
    const body = await r.json();
    expect(body.authenticated, "Cookie を持つ人がゲストに落ちた").toBe(true);
    expect(body.user.id).toBe("7232");
    expect(body.user.guest, "ログイン済みに guest の旗が付いた").toBeFalsy();
    // 書き込みも今までどおり通る（条件8）。
    expect(
      await statusOf(fetch(url(`/api/sessions/${session.id}/ink`), {
        method: "POST",
        headers: { cookie: owner.cookie, origin: ORIGIN, "content-type": "application/json",
                   [GUEST_HEADER]: newGuestId() },
        body: JSON.stringify({
          strokes: [{ client_uuid: uuid(), color: "cursor-1", width: 2, points: [1, 1, 2, 2] }],
        }),
      }))
    ).toBe(201);
  });

  // 利用を止められた人が Cookie を持ったままゲストに降りられると、
  // 「止めた」が「見るだけにした」に静かに変わる。**403 のまま返す。**
  it("利用停止された人は、ゲストのヘッダを添えても 403", async () => {
    const owner = await loginAs("7233", "guestinactive");
    const session = await newSession(owner.cookie, "停止された人の作戦");
    execD1("UPDATE users SET active = 0 WHERE discord_id = '7233'");
    expect(
      await statusOf(fetch(url(`/api/sessions/${session.id}`), {
        headers: { cookie: owner.cookie, [GUEST_HEADER]: newGuestId() },
      }))
    ).toBe(403);
  });
});

describe("GET /api/me — ゲストの名前はサーバが決める", () => {
  it("authenticated: false のまま、生成名を返す", async () => {
    const guest = newGuestId();
    const r = await fetch(url("/api/me"), { headers: asGuest(guest) });
    expect(r.status).toBe(200);
    const body = await r.json();
    // **`authenticated` の意味は変えない**（＝ログインしているか）。
    expect(body.authenticated).toBe(false);
    expect(body.user.id).toBe(guest);
    expect(body.user.guest).toBe(true);
    // 名前の式は1箇所（`public/js/plan/guest.js`）。**画面に書き写さないための約束。**
    expect(body.user.name).toBe(guestName(guest));
    expect(body.user.name.length).toBeGreaterThan(1);
  });

  it("同じ身元なら毎回同じ名前（条件3）", async () => {
    const guest = newGuestId();
    const names = new Set();
    for (let i = 0; i < 5; i += 1) {
      const body = await (await fetch(url("/api/me"), { headers: asGuest(guest) })).json();
      names.add(body.user.name);
    }
    expect([...names]).toEqual([guestName(guest)]);
  });

  it("身元が無ければ従来どおり（user を付けない）", async () => {
    const body = await (await fetch(url("/api/me"))).json();
    expect(body).toEqual({ authenticated: false });
  });

  it("形の違う身元には名前を付けない", async () => {
    const body = await (await fetch(url("/api/me"), { headers: { [GUEST_HEADER]: "7230" } })).json();
    expect(body).toEqual({ authenticated: false });
  });
});

describe("GET /api/sessions — ゲストには公開された作戦だけ", () => {
  it("public / public_edit は返す。private は返さない", async () => {
    const owner = await loginAs("7240", "guestlistowner");
    const open = await newSession(owner.cookie, "ゲストに見える公開の作戦");
    const openEdit = await newSession(owner.cookie, "ゲストに見える共同編集の作戦");
    const secret = await newSession(owner.cookie, "ゲストに見えない非公開の作戦");
    await setVisibility(owner.cookie, open.id, "public");
    await setVisibility(owner.cookie, openEdit.id, "public_edit");

    const body = await (await fetch(url("/api/sessions"), { headers: asGuest(newGuestId()) })).json();
    const ids = (body.public ?? []).map((s) => s.id);
    expect(ids, "public が出ない").toContain(open.id);
    expect(ids, "public_edit が出ない").toContain(openEdit.id);
    expect(ids, "非公開が漏れた").not.toContain(secret.id);
    // 画面が行を描くのに要る列が揃っている。
    const row = body.public.find((s) => s.id === open.id);
    expect(row.map_name).toBeTruthy();
    expect(row.created_by_name).toBe("guestlistowner");
    expect(row.visibility).toBe("public");
  });

  // **保存された身元が無いので、返すものが無い。**
  it("「自分の」と「開いたことがある」は空で返す", async () => {
    const owner = await loginAs("7241", "guestlistmine");
    const session = await newSession(owner.cookie, "他人の作戦");
    await setVisibility(owner.cookie, session.id, "public");
    const guest = newGuestId();
    // 一度開いても履歴にならない（条件5）。
    await statusOf(fetch(url(`/api/sessions/${session.id}`), { headers: asGuest(guest) }));

    const body = await (await fetch(url("/api/sessions"), { headers: asGuest(guest) })).json();
    expect(body.sessions, "ゲストに「自分の作戦」は無い").toEqual([]);
    expect(body.visited, "ゲストに訪問履歴は無い").toEqual([]);
    expect(body.public.length).toBeGreaterThan(0);
  });

  it("ログイン済みの一覧は3つ揃ったまま（条件8）", async () => {
    const owner = await loginAs("7242", "guestlistlogged");
    const mine = await newSession(owner.cookie, "自分の作戦（退行見張り）");
    const body = await (await fetch(url("/api/sessions"), {
      headers: { cookie: owner.cookie, [GUEST_HEADER]: newGuestId() },
    })).json();
    expect(body.sessions.map((s) => s.id)).toContain(mine.id);
    expect(Array.isArray(body.visited)).toBe(true);
    expect(Array.isArray(body.public)).toBe(true);
  });
});

describe("GET /api/sessions/{id}/ws — クエリで身元を渡す", () => {
  // ブラウザの `new WebSocket()` はヘッダを足せないので、ws だけはクエリで受ける。
  // このサーバには ROOM を繋いでいないので、**認証を通ったことは 503 で分かる**
  // （401 なら身元が通っていない。503 なら通って DO が無いところまで来ている）。
  it("正しい身元なら認証を通る（ROOM が無いので 503）", async () => {
    const owner = await loginAs("7250", "guestwsowner");
    const session = await newSession(owner.cookie, "ゲストが入る部屋");
    const guest = newGuestId();
    const r = await handshake(`/api/sessions/${session.id}/ws?guest=${encodeURIComponent(guest)}`);
    expect(r.status, "ゲストが部屋の入口で弾かれた").toBe(503);
  });

  it("身元が無ければ 401。形が違えば 401", async () => {
    const owner = await loginAs("7251", "guestwsbad");
    const session = await newSession(owner.cookie, "弾かれる部屋");
    expect((await handshake(`/api/sessions/${session.id}/ws`)).status, "身元なし").toBe(401);
    expect(
      (await handshake(`/api/sessions/${session.id}/ws?guest=7251`)).status,
      "接頭辞なし"
    ).toBe(401);
    expect(
      (await handshake(`/api/sessions/${session.id}/ws?guest=anon:short`)).status,
      "短すぎる"
    ).toBe(401);
  });

  it("Origin が無ければゲストでも 403（部屋に入るのは読み取りではない）", async () => {
    const owner = await loginAs("7252", "guestwsorigin");
    const session = await newSession(owner.cookie, "Origin を見る部屋");
    const guest = newGuestId();
    expect(
      (await handshake(`/api/sessions/${session.id}/ws?guest=${encodeURIComponent(guest)}`, {
        origin: null,
      })).status
    ).toBe(403);
  });

  it("存在しない作戦は 404", async () => {
    const guest = newGuestId();
    expect(
      (await handshake(`/api/sessions/no-such-plan/ws?guest=${encodeURIComponent(guest)}`)).status
    ).toBe(404);
  });
});

// WebSocket のハンドシェイクを1往復だけ投げる（tests/plan-ws.test.js と同じ理由で
// `fetch` は使えない。undici が Upgrade ヘッダを拒否する）。
function handshake(path, { cookie, origin = ORIGIN, upgrade = "websocket" } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    if (upgrade) headers.upgrade = upgrade;
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;

    const req = httpRequest(
      { host: "127.0.0.1", port: Number(new URL(ORIGIN).port), path, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, body: "" });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("ハンドシェイクがタイムアウトした")));
    req.end();
  });
}
