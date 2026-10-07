// GET /api/sessions/{id}/ws — WebSocket の入口（Pages Function 側）の統合テスト。
//
// **ここが認証の唯一の場所。** DO 側（workers/room）は Cookie を検証しない。
// Pages Function が検証して、検証済みのユーザーをヘッダで渡す。
// したがって「誰でも 101 になってしまう穴」はここでしか塞げない。
//
// このサーバには ROOM バインディングを渡していない（`wrangler pages dev` に
// `--do` を付けていない）。**それは手抜きではなく、確かめたい性質そのもの**:
// リアルタイムは上乗せなので、DO が無い環境でも既存の API が全部動き、
// /ws だけが 503 を返して終わること。実際の WebSocket の中身（在室一覧）は
// e2e/plan-presence.spec.js が2プロセス構成で見る。
import { describe, it, expect, beforeAll } from "vitest";
import { request as httpRequest } from "node:http";

import { startServers, stopServers, baseUrl, loginAs, execD1 } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

/**
 * WebSocket のハンドシェイクを1往復だけ投げる。
 *
 * `fetch` は使えない。undici は `Upgrade` ヘッダを
 * 「invalid upgrade header」で拒否する（実測）ので、node:http を直に使う。
 * 101 まで来たら status だけ見て切る（フレームは読まない）。
 */
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
    req.setTimeout(10_000, () => {
      req.destroy(new Error("ハンドシェイクがタイムアウトした"));
    });
    req.end();
  });
}

async function newSession(cookie, title = "WSテスト作戦") {
  const r = await fetch(url("/api/sessions"), {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ map_id: "bakurani", title }),
  });
  expect(r.status).toBe(201);
  return (await r.json()).session;
}

describe("GET /api/sessions/{id}/ws", () => {
  it("Upgrade ヘッダが無ければ 400（ブラウザで直接開いたとき）", async () => {
    const { cookie } = await loginAs("7001", "ws-plain");
    const session = await newSession(cookie);
    const r = await handshake(`/api/sessions/${session.id}/ws`, { cookie, upgrade: null });
    expect(r.status).toBe(400);
  });

  it("ログインしていなければ 401", async () => {
    const { cookie } = await loginAs("7002", "ws-owner");
    const session = await newSession(cookie);
    const r = await handshake(`/api/sessions/${session.id}/ws`);
    expect(r.status).toBe(401);
  });

  it("Origin が一致しなければ 403", async () => {
    const { cookie } = await loginAs("7003", "ws-origin");
    const session = await newSession(cookie);
    const r = await handshake(`/api/sessions/${session.id}/ws`, {
      cookie,
      origin: "https://evil.example",
    });
    expect(r.status).toBe(403);
  });

  it("Origin が無ければ 403（同一オリジンの確認手段が無い）", async () => {
    const { cookie } = await loginAs("7004", "ws-no-origin");
    const session = await newSession(cookie);
    const r = await handshake(`/api/sessions/${session.id}/ws`, { cookie, origin: null });
    expect(r.status).toBe(403);
  });

  it("利用停止されたユーザーは 403", async () => {
    const { cookie } = await loginAs("7005", "ws-inactive");
    const session = await newSession(cookie);
    execD1("UPDATE users SET active = 0 WHERE discord_id = '7005'");
    const r = await handshake(`/api/sessions/${session.id}/ws`, { cookie });
    expect(r.status).toBe(403);
  });

  it("存在しない作戦は 404", async () => {
    const { cookie } = await loginAs("7006", "ws-404");
    const r = await handshake("/api/sessions/no-such-plan/ws", { cookie });
    expect(r.status).toBe(404);
  });

  it("ROOM バインディングが無い環境では 503（リアルタイムだけが止まる）", async () => {
    const { cookie } = await loginAs("7007", "ws-no-room");
    const session = await newSession(cookie);
    const r = await handshake(`/api/sessions/${session.id}/ws`, { cookie });
    expect(r.status).toBe(503);
  });

  it("/ws が 503 でも、同じ作戦の既存 API は全部動く", async () => {
    const { cookie } = await loginAs("7008", "ws-degraded");
    const session = await newSession(cookie);

    expect((await handshake(`/api/sessions/${session.id}/ws`, { cookie })).status).toBe(503);

    // 本文は使わないが読み捨てる。読まないと keep-alive の接続が本文を抱えたまま
    // 残り、サーバを止めるときに UND_ERR_SOCKET が飛ぶ（実測）。以下の2件も同じ。
    const get = await fetch(url(`/api/sessions/${session.id}`), { headers: { cookie } });
    expect(get.status).toBe(200);
    await get.text();

    const ink = await fetch(url(`/api/sessions/${session.id}/ink`), {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        strokes: [
          { client_uuid: "ws-degraded-ink", color: "cursor-1", width: 3, points: [0, 0, 100, 100] },
        ],
      }),
    });
    expect(ink.status).toBe(201);
    await ink.text();

    const area = await fetch(url(`/api/sessions/${session.id}/areas`), {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        areas: [{ client_uuid: "ws-degraded-1", kind: "key", rects: [[0, 0, 1, 1]] }],
      }),
    });
    expect(area.status).toBe(201);
    await area.text();
  });
});
