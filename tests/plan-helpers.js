// /plan 用のテストサーバ。vitest(8811-8814) と e2e(8832) に衝突しないポートを使う。
//
// **Durable Object は繋がない。** wrangler.toml の ROOM バインディング
// （script_name = "wardogs-room"）は、起動中の Worker を wrangler のレジストリから
// 探して解決する。既定のレジストリ（~/.config/.wrangler/registry）を使うと、
// `npm run dev` や e2e が動かしている wardogs-room を拾ってしまい、
// 「ROOM が無い環境」を前提にしたテスト（tests/plan-ws.test.js）が
// 503 のはずの所で 101 を返す（実測）。専用のレジストリに固定して隔離する。
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { SESSION_COOKIE } from "../functions/_lib/session.js";
import { execD1In } from "../testlib/d1-direct.js";

const REGISTRY = ".wrangler/registry-vitest-plan";

// 既定値はそのまま。並行して別のテストファイルを回すときだけ環境変数で逃がす。
const PORT = Number(process.env.PLAN_TEST_PORT || 8831);
const INSPECTOR = Number(process.env.PLAN_TEST_INSPECTOR || 9331);
const PERSIST = process.env.PLAN_TEST_PERSIST || ".wrangler/plan-state";

const SERVERS = {
  plan: {
    port: PORT,
    inspectorPort: INSPECTOR,
    persist: PERSIST,
    vars: {
      SESSION_SECRET: "test-session-secret-0123456789abcdef",
      DISCORD_CLIENT_ID: "test-client-id",
      DISCORD_CLIENT_SECRET: "test-client-secret",
      DISCORD_API_BASE: "mock",
      ALLOW_DEBUG: "1",
      // 作戦のタイトルと配置のラベルにも BLOCKED_WORDS が効くことを確かめるため、
      // このサーバでは有効にしておく。他のテストが使う文字列には含まれない語を選ぶ。
      BLOCKED_WORDS: "禁止語",
    },
  },
};

const procs = [];

export const baseUrl = (name) => `http://127.0.0.1:${SERVERS[name].port}`;

async function waitReady(name, timeoutMs = 90_000) {
  const started = Date.now();
  let lastError = "まだ応答なし";
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl(name)}/api/me`);
      if (r.ok) {
        const body = await r.json();
        // Pages は未知パスを index.html にフォールバックするので、
        // Functions が実際に応答していることを JSON の形で確かめる。
        if (typeof body?.authenticated === "boolean") return;
        lastError = "静的フォールバックが返っている（Functions 未準備）";
      } else {
        lastError = `HTTP ${r.status}`;
      }
    } catch (e) {
      lastError = e.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${name} が ${timeoutMs}ms 以内に起動しなかった: ${lastError}`);
}

/** schema.sql を流す。失敗したら stderr を例外に載せて原因が分かるようにする。 */
function applySchema(cfg) {
  try {
    execFileSync("npx", [
      "wrangler", "d1", "execute", "wardogs-blue",
      "--local", "--persist-to", cfg.persist, "--file=schema.sql",
    ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (e) {
    throw new Error(
      `schema.sql の適用に失敗しました (exit ${e.status})\n` +
        `--- stdout ---\n${e.stdout ?? ""}\n--- stderr ---\n${e.stderr ?? ""}`
    );
  }
}

export async function startServers() {
  try {
    for (const [name, cfg] of Object.entries(SERVERS)) {
      rmSync(cfg.persist, { recursive: true, force: true });
      mkdirSync(cfg.persist, { recursive: true });
      applySchema(cfg);

      const args = [
        "wrangler", "pages", "dev", "public",
        "--port", String(cfg.port),
        "--inspector-port", String(cfg.inspectorPort),
        "--persist-to", cfg.persist,
      ];
      for (const [k, v] of Object.entries(cfg.vars)) args.push("--binding", `${k}=${v}`);
      mkdirSync(REGISTRY, { recursive: true });
      const child = spawn("npx", args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, WRANGLER_REGISTRY_PATH: REGISTRY },
      });
      procs.push(child);
      await waitReady(name);
    }
  } catch (e) {
    // 起動済みのものを片付けてから投げ直す。残すとポートが塞がって
    // 後続のテストファイルが全部落ちる。
    await stopServers();
    throw e;
  }
}

export async function stopServers() {
  for (const child of procs) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* 既に終了 */ }
  }
  // ポートが解放されるまで待ち、残っていれば SIGKILL
  for (const cfg of Object.values(SERVERS)) {
    for (let i = 0; i < 40; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${cfg.port}/api/me`);
        await new Promise((r) => setTimeout(r, 250));
      } catch { break; }
      if (i === 20) {
        for (const child of procs) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* noop */ }
        }
      }
    }
  }
  procs.length = 0;
}

/**
 * テストサーバの D1（ローカル persist）へ直接 SQL を流す。
 *
 * 中身は `testlib/d1-direct.js`（e2e と共用。**`wrangler d1 execute` を起動しない**
 * 理由と経緯はあちらのヘッダに書いてある）。ここは vitest 側の persist を渡すだけ。
 * 挙動は tests/plan-execd1.test.js が見張る。
 */
export const execD1 = (sql) => execD1In(resolve(SERVERS.plan.persist), sql);

/**
 * マップ1行を API から取る。
 *
 * **マップの一辺はマップごとに違う**（16,320 / 16,320 / 16,384m）ので、
 * 「範囲の外」を試したいテストは 16001 のような数字を書かずにこれを使う。
 * 数字を直書きすると、寸法を直すたびに全テストを書き直すことになる。
 */
export async function mapOf(cookie, id = "bakurani") {
  const r = await fetch(`${baseUrl("plan")}/api/maps`, { headers: { cookie } });
  if (!r.ok) throw new Error(`GET /api/maps が ${r.status}`);
  const map = (await r.json()).maps.find((m) => m.id === id);
  if (!map) throw new Error(`マップ ${id} が無い`);
  return map;
}

/**
 * モックの Discord OAuth コールバックを1往復して、セッション Cookie を取り出す。
 * `DISCORD_API_BASE=mock` かつ `ALLOW_DEBUG=1` のとき、callback は `code` の
 * `mock-<id>-<username>` から profile を組み立てる。state は Cookie と query の
 * 両方に同じ値を入れて照合を通す。
 *
 * `avatar` はアイコンの hash（32桁の16進）。**`code` に混ぜず別のクエリ**で渡す
 * （`<username>` が `-` を含みうるため）。渡さなければ今までどおり NULL ＝
 * 「Discord の既定アイコンの人」になる。
 * 戻り値の `cookie` はそのまま `headers: { cookie }` に渡せる形。
 *
 * Cookie の取り出しは `getSetCookie()` の配列 + 名前の完全一致で行う。
 * `headers.get("set-cookie")` のカンマ結合文字列に正規表現をかけると、
 * Cookie 名を `__Host-wb_session` のような接頭辞つきに変えたときに
 * 接頭辞を落とした別名の Cookie を静かに組み立ててしまう。
 */
export async function loginAs(discordId, username, { avatar = null } = {}) {
  const state = `teststate-${discordId}`;
  const res = await fetch(
    `${baseUrl("plan")}/api/auth/discord/callback` +
      `?code=mock-${discordId}-${encodeURIComponent(username)}&state=${state}` +
      (avatar ? `&avatar=${encodeURIComponent(avatar)}` : ""),
    { redirect: "manual", headers: { cookie: `__Host-wb_state=${state}` } }
  );
  const found = res.headers.getSetCookie().find(
    (c) => c.slice(0, c.indexOf("=")).trim() === SESSION_COOKIE
  );
  if (!found) throw new Error(`ログインに失敗: status=${res.status}`);
  const value = found.slice(found.indexOf("=") + 1).split(";")[0];
  return { res, cookie: `${SESSION_COOKIE}=${value}` };
}
