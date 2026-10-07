// vitest globalSetup: 設定の異なる `wrangler pages dev` を複数起動し、終了時に確実に止める。
//
// 実測メモ:
//   * `--port` を変えても inspector は 9229 固定で衝突するため `--inspector-port` も分ける。
//   * 複数インスタンスが同じ D1 persist ディレクトリを共有すると SQLite のロック競合で
//     `D1_ERROR` → 500 になる。インスタンスごとに `--persist-to` を分ける。
//   * 親プロセスを kill しても workerd が生き残るため、`detached: true` で
//     プロセスグループを作り、終了時は `kill(-pid)` でグループごと落とす。
//   * **`WRANGLER_REGISTRY_PATH` を分ける。** wrangler は起動中の Worker を
//     `~/.config/.wrangler/registry` に登録し、`script_name` 付きの Durable Object
//     バインディングをそこから解決する。既定のままだと「`npm run dev` で
//     wardogs-room を動かしたまま `npm test` を走らせると、本来 ROOM が無いはずの
//     テストサーバに ROOM が繋がって 503 が 101 になる」（実測）。
//     ここは「DO が無い環境」を担当するので、空のレジストリに固定する。
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { rmSync, mkdirSync, openSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SERVERS } from "./config.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const LOG_DIR = join(ROOT, ".wrangler", "test-logs");
const STATE_ROOT = join(ROOT, ".wrangler", "test-state");
// 「他の Worker を見つけない」ための専用レジストリ（上のコメント参照）。
const REGISTRY = join(ROOT, ".wrangler", "registry-vitest");

const READY_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 30_000;

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

/** 使いたいポートが既に埋まっていたら、原因が分かる形で落とす。 */
async function assertPortsFree() {
  const busy = [];
  for (const [name, cfg] of Object.entries(SERVERS)) {
    if (await portInUse(cfg.port)) busy.push(`${name}: --port ${cfg.port}`);
    if (await portInUse(cfg.inspectorPort)) busy.push(`${name}: --inspector-port ${cfg.inspectorPort}`);
  }
  if (busy.length) {
    throw new Error(
      `テスト用ポートが既に使われています:\n  ${busy.join("\n  ")}\n` +
        `前回のテストの wrangler / workerd が残っている可能性があります。` +
        `\`pkill -f "wrangler pages dev"; pkill workerd\` で片付けてから再実行してください。`
    );
  }
}

/**
 * インスタンス用の persist ディレクトリを作り直して schema.sql を流す。
 * サーバ起動「前」に実行するので、稼働中の sqlite を触る競合は起きない。
 */
function resetDatabase(name) {
  const persistTo = join(STATE_ROOT, name);
  rmSync(persistTo, { recursive: true, force: true });
  mkdirSync(persistTo, { recursive: true });
  const r = spawnSync(
    process.execPath,
    [WRANGLER, "d1", "execute", "wardogs-blue", "--local", `--persist-to=${persistTo}`, "--file=schema.sql", "--yes"],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 }
  );
  if (r.status !== 0) {
    throw new Error(`[${name}] schema.sql の適用に失敗しました (exit ${r.status})\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  }
  return persistTo;
}

function startServer(name, cfg, persistTo) {
  const logPath = join(LOG_DIR, `${name}.log`);
  const logFd = openSync(logPath, "w");

  const args = [
    WRANGLER,
    "pages",
    "dev",
    "public",
    `--port=${cfg.port}`,
    `--inspector-port=${cfg.inspectorPort}`,
    `--persist-to=${persistTo}`,
    "--ip=127.0.0.1",
  ];
  // プレーンテキスト変数。空白やカンマを含む値も shell を介さないのでそのまま渡る。
  for (const [k, v] of Object.entries(cfg.vars)) args.push("--binding", `${k}=${v}`);

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true, // 新しいプロセスグループ → workerd までまとめて kill できる
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_REGISTRY_PATH: REGISTRY,
    },
  });
  child.unref();

  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  return { name, cfg, child, logPath, persistTo, getExit: () => exited };
}

async function waitForReady(server) {
  const url = `http://127.0.0.1:${server.cfg.port}/api/comments`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr = "";
  while (Date.now() < deadline) {
    const exit = server.getExit();
    if (exit) {
      throw new Error(
        `[${server.name}] wrangler が起動前に終了しました (code=${exit.code} signal=${exit.signal})\n` +
          `--- ${server.logPath} ---\n${tailLog(server.logPath)}`
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        await res.arrayBuffer();
        return;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = String(e?.message ?? e);
    }
    await sleep(250);
  }
  throw new Error(
    `[${server.name}] ${url} が ${READY_TIMEOUT_MS}ms 以内に応答しませんでした (最後のエラー: ${lastErr})\n` +
      `--- ${server.logPath} ---\n${tailLog(server.logPath)}`
  );
}

function tailLog(path, lines = 40) {
  if (!existsSync(path)) return "(ログなし)";
  return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
}

/** プロセスグループごと止め、ポートが解放されるまで待つ。 */
async function stopServer(server) {
  const { child, cfg, name } = server;
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
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
    console.warn(`[${name}] ポート ${cfg.port} が解放されませんでした`);
  }
}

export default async function setup() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(STATE_ROOT, { recursive: true });
  mkdirSync(REGISTRY, { recursive: true });

  await assertPortsFree();

  // 起動前に DB を初期化（サーバが sqlite を開く前なので安全）
  const persist = {};
  for (const name of Object.keys(SERVERS)) persist[name] = resetDatabase(name);

  const servers = Object.entries(SERVERS).map(([name, cfg]) => startServer(name, cfg, persist[name]));

  const stopAll = async () => {
    await Promise.all(servers.map(stopServer));
  };

  try {
    await Promise.all(servers.map(waitForReady));
  } catch (e) {
    await stopAll();
    throw e;
  }

  return stopAll;
}
