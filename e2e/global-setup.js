// Playwright globalSetup: テスト用の `wrangler pages dev` を起動し、終了時に確実に止める。
//
// tests/global-setup.js（vitest 用）と同じ実測メモが当てはまる:
//   * `--port` を変えても inspector は 9229 固定で衝突するため `--inspector-port` も分ける。
//   * 同じ D1 persist ディレクトリを共有すると SQLite のロック競合で `D1_ERROR` → 500 になるため
//     `--persist-to` を分ける。
//   * 親プロセスを kill しても workerd が生き残るため、`detached: true` でプロセスグループを作り、
//     終了時は `kill(-pid)` でグループごと落として、ポートが解放されるまで待つ。
//
// 起動するのは 2 つ（**Durable Object のために2プロセスになった**）。
//   room … workers/room（class PlanRoom）。`wrangler dev` で立てる。
//          Pages プロジェクトの中に Durable Object を定義できないので別 Worker。
//   plan … /plan のテスト用。Turnstile を使わないので public/ をそのまま配信し、
//          代わりに Discord ログイン（mock）用のバインディングを渡す。
//          wrangler.toml の ROOM バインディング（script_name = "wardogs-room"）が
//          上の room を指す。**room を先に起動する。**
// `/` の作戦ノートは配信を止めた（public/_redirects で /plan にリダイレクト）ため、
// ノート専用の e2e サーバ（旧 main / port 8821）は廃止した。
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  E2E_REGISTRY,
  PLAN_BINDINGS,
  PLAN_INSPECTOR_PORT,
  PLAN_PERSIST,
  PLAN_PORT,
  ROOM_INSPECTOR_PORT,
  ROOM_PERSIST,
  ROOM_PORT,
} from "./config.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_PUBLIC = join(ROOT, "public");

const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const LOG_DIR = join(ROOT, ".wrangler", "e2e-logs");

const READY_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 30_000;

/**
 * 起動するインスタンスの定義。**並び順が起動順。**
 *
 * `kind`
 *   "worker" … `wrangler dev -c <config>`。Durable Object を持つ Worker 用。
 *   "pages"  … `wrangler pages dev <dir>`。
 * `isReady` を与えたインスタンスでは、Pages の静的フォールバック（未知パスに
 * index.html を 200 で返す）を「起動済み」と誤認しないよう JSON の形も見る。
 * `expectStatus` は「この status が返ったら起動済み」。room は公開ルートを
 * 持たない設計なので、`/` が 404 を返すことが正常な起動の合図になる。
 */
const SERVERS = [
  {
    name: "room",
    kind: "worker",
    config: join(ROOT, "workers", "room", "wrangler.toml"),
    port: ROOM_PORT,
    inspectorPort: ROOM_INSPECTOR_PORT,
    persistTo: join(ROOT, ROOM_PERSIST),
    logPath: join(LOG_DIR, "worker-dev-room.log"),
    readyPath: "/",
    expectStatus: 404,
  },
  {
    name: "plan",
    kind: "pages",
    port: PLAN_PORT,
    inspectorPort: PLAN_INSPECTOR_PORT,
    persistTo: join(ROOT, PLAN_PERSIST),
    logPath: join(LOG_DIR, "pages-dev-plan.log"),
    bindings: PLAN_BINDINGS,
    publicDir: () => SOURCE_PUBLIC,
    readyPath: "/api/me",
    isReady: (body) => typeof body?.authenticated === "boolean",
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 127.0.0.1:port に TCP 接続できたら true。 */
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function assertPortsFree() {
  const busy = [];
  for (const cfg of SERVERS) {
    if (await portInUse(cfg.port)) busy.push(`--port ${cfg.port}`);
    if (await portInUse(cfg.inspectorPort)) busy.push(`--inspector-port ${cfg.inspectorPort}`);
  }
  if (busy.length) {
    throw new Error(
      `UIテスト用ポートが既に使われています: ${busy.join(", ")}\n` +
        `前回の wrangler / workerd が残っている可能性があります。` +
        `\`pkill -f "wrangler pages dev"; pkill workerd\` で片付けてから再実行してください。`
    );
  }
}

/** persist ディレクトリを作り直して schema.sql を流す（サーバ起動「前」に実行する）。 */
function resetDatabase(cfg) {
  rmSync(cfg.persistTo, { recursive: true, force: true });
  mkdirSync(cfg.persistTo, { recursive: true });
  const r = spawnSync(
    process.execPath,
    [WRANGLER, "d1", "execute", "wardogs-blue", "--local", `--persist-to=${cfg.persistTo}`, "--file=schema.sql", "--yes"],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 }
  );
  if (r.status !== 0) {
    throw new Error(`schema.sql の適用に失敗しました (exit ${r.status})\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  }
}

/** D1 を持たないインスタンス（room）用。前回の残りを消すだけ。 */
function resetPersist(cfg) {
  rmSync(cfg.persistTo, { recursive: true, force: true });
  mkdirSync(cfg.persistTo, { recursive: true });
}

function tailLog(cfg, lines = 40) {
  if (!existsSync(cfg.logPath)) return "(ログなし)";
  return readFileSync(cfg.logPath, "utf8").split("\n").slice(-lines).join("\n");
}

function startServer(cfg, publicDir) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFd = openSync(cfg.logPath, "w");

  const args =
    cfg.kind === "worker"
      ? [WRANGLER, "dev", `--config=${cfg.config}`]
      : [
          WRANGLER,
          "pages",
          "dev",
          // wrangler.toml の pages_build_output_dir を上書きするため、ROOT からの相対パスで渡す。
          relative(ROOT, publicDir),
        ];
  args.push(
    `--port=${cfg.port}`,
    `--inspector-port=${cfg.inspectorPort}`,
    `--persist-to=${cfg.persistTo}`,
    "--ip=127.0.0.1"
  );
  for (const [k, v] of Object.entries(cfg.bindings ?? {})) args.push("--binding", `${k}=${v}`);

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true, // 新しいプロセスグループ → workerd までまとめて kill できる
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      // 2本が互いを見つけるための表。既定（機械ごとに1つ）を使うと
      // `npm run dev` や vitest の wrangler と混ざる（e2e/config.js のコメント参照）。
      WRANGLER_REGISTRY_PATH: join(ROOT, E2E_REGISTRY),
    },
  });
  child.unref();

  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  return { cfg, child, getExit: () => exited };
}

async function waitForReady(server) {
  const { cfg } = server;
  const url = `http://127.0.0.1:${cfg.port}${cfg.readyPath}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr = "";
  while (Date.now() < deadline) {
    const exit = server.getExit();
    if (exit) {
      throw new Error(
        `wrangler(${cfg.name}) が起動前に終了しました (code=${exit.code} signal=${exit.signal})\n` +
          `--- ${cfg.logPath} ---\n${tailLog(cfg)}`
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      // room は公開ルートを持たない（＝どのパスも 404）ので、404 が起動の合図。
      const good = cfg.expectStatus === undefined ? res.ok : res.status === cfg.expectStatus;
      if (good) {
        if (!cfg.isReady) {
          await res.arrayBuffer();
          return;
        }
        const body = await res.json().catch(() => null);
        if (cfg.isReady(body)) return;
        lastErr = "静的フォールバックが返っている（Functions 未準備）";
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastErr = String(e?.message ?? e);
    }
    await sleep(250);
  }
  throw new Error(
    `${url} が ${READY_TIMEOUT_MS}ms 以内に応答しませんでした (最後のエラー: ${lastErr})\n` +
      `--- ${cfg.logPath} ---\n${tailLog(cfg)}`
  );
}

/** プロセスグループごと止め、ポートが解放されるまで待つ。 */
async function stopServer(server) {
  const { cfg } = server;
  const killGroup = (signal) => {
    try {
      process.kill(-server.child.pid, signal);
    } catch {
      /* 既に終了済み */
    }
  };

  killGroup("SIGTERM");

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  let killed = false;
  while (Date.now() < deadline) {
    const portsFree = !(await portInUse(cfg.port)) && !(await portInUse(cfg.inspectorPort));
    if (portsFree && server.getExit()) return;
    if (!killed && Date.now() > deadline - STOP_TIMEOUT_MS / 2) {
      killGroup("SIGKILL"); // SIGTERM で落ちない workerd の保険
      killed = true;
    }
    await sleep(200);
  }
  killGroup("SIGKILL");
  if (await portInUse(cfg.port)) {
    console.warn(`ポート ${cfg.port} が解放されませんでした`);
  }
}

async function stopAll(servers) {
  // 1 つが止まらなくても残りを必ず止める。
  // **起動の逆順**（plan → room）。先に room を落とすと、plan 側が
  // 失った DO を探し直すログでエラーを撒く。
  for (const server of [...servers].reverse()) {
    try {
      await stopServer(server);
    } catch (e) {
      console.warn(`${server.cfg.name} の停止に失敗しました: ${e?.message ?? e}`);
    }
  }
}

// globalSetup が関数を返すと、Playwright は全テスト終了後にそれを teardown として呼ぶ。
export default async function setup() {
  await assertPortsFree();

  mkdirSync(join(ROOT, E2E_REGISTRY), { recursive: true });

  const started = [];
  try {
    for (const cfg of SERVERS) {
      const publicDir = cfg.publicDir?.() ?? null;
      // room は D1 を持たない（PlanRoom は状態を一切持たない）。
      if (cfg.kind === "pages") resetDatabase(cfg);
      else resetPersist(cfg);
      const server = startServer(cfg, publicDir);
      started.push(server);
      await waitForReady(server);
    }
  } catch (e) {
    await stopAll(started);
    throw e;
  }

  return async () => {
    await stopAll(started);
  };
}
