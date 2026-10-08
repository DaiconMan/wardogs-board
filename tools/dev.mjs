// `npm run dev` — ローカル開発サーバ。**2プロセス立てる。**
//
// なぜ1本で済まないのか: **Pages プロジェクトの中に Durable Object を定義できない**
// （"You cannot create and deploy a Durable Object within a Pages project."）。
// リアルタイム（在室一覧・Phase R1 の共有カーソル）の実体は別の Worker
// （workers/room の class PlanRoom）にあり、Pages 側は wrangler.toml の
// `script_name = "wardogs-room"` でそれを借りる（D-047 の決定3）。
//
// 覚えるコマンドを増やさないために、この1本で両方立てて両方まとめて落とす。
//   room  … wrangler dev       127.0.0.1:8787（公開ルートなし。どのパスも 404）
//   pages … wrangler pages dev 127.0.0.1:8788  ← ブラウザで開くのはこちら
//
// 起動ログに `env.ROOM (PlanRoom, defined in wardogs-room) ... [connected]` が
// 出れば繋がっている。`[not connected]` のときは room 側の起動に失敗しているので、
// /api/sessions/:id/ws が 503 を返す（＝在室一覧だけが出ない。他は全部動く）。
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

const ROOM_PORT = 8787;
const ROOM_INSPECTOR_PORT = 9787;
const PAGES_PORT = 8788;
const PAGES_INSPECTOR_PORT = 9788;

// wrangler は起動中の Worker をこの表に登録し、`script_name` をここから解決する。
// 既定（~/.config/.wrangler/registry）は機械ごとに1つしかないので、
// テスト（.wrangler/registry-vitest-plan / registry-e2e）と混ざらないように分ける。
const REGISTRY = join(ROOT, ".wrangler", "registry-dev");

// inspector（devtools）のポートは `--port` を変えても既定 9229 のままで衝突するので、
// 2本とも明示する。`--persist-to` も分ける（同じ sqlite を2プロセスで開かない）。
const PROCS = [
  {
    name: "room",
    args: [
      "dev",
      `--config=${join(ROOT, "workers", "room", "wrangler.toml")}`,
      `--port=${ROOM_PORT}`,
      `--inspector-port=${ROOM_INSPECTOR_PORT}`,
      "--persist-to=.wrangler/dev-room-state",
      "--ip=127.0.0.1",
    ],
    readyUrl: `http://127.0.0.1:${ROOM_PORT}/`,
  },
  {
    name: "pages",
    args: [
      "pages",
      "dev",
      "public",
      `--port=${PAGES_PORT}`,
      `--inspector-port=${PAGES_INSPECTOR_PORT}`,
      "--persist-to=.wrangler/dev-pages-state",
      "--ip=127.0.0.1",
    ],
  },
];

const children = [];
let shuttingDown = false;

function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* 既に終了している */
    }
  }
  // workerd が SIGTERM で落ちないことがあるので、少し待って SIGKILL。
  setTimeout(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* noop */
      }
    }
    process.exit(code);
  }, 1500);
}

function start(proc) {
  const child = spawn(process.execPath, [WRANGLER, ...proc.args], {
    cwd: ROOT,
    // 新しいプロセスグループを作る → workerd までまとめて落とせる。
    detached: true,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_REGISTRY_PATH: REGISTRY },
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${proc.name} が終了しました (code=${code} signal=${signal})。両方止めます。`);
    stopAll(code ?? 1);
  });
  return child;
}

/** room が応答するまで待つ。公開ルートが無いので 404 が返れば起動済み。 */
async function waitFor(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (shuttingDown) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await res.arrayBuffer();
      return true;
    } catch {
      /* まだ起動していない */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopAll(0));
}

mkdirSync(REGISTRY, { recursive: true });

// **room を先に立てる。** Pages 側は起動時にレジストリを見るので、
// 逆順にすると最初だけ `[not connected]` で始まる（しばらくすると繋がるが、
// その間に開いたタブでは在室一覧が出ずに紛らわしい）。
for (const proc of PROCS) {
  start(proc);
  if (proc.readyUrl && !(await waitFor(proc.readyUrl))) {
    console.error(`[dev] ${proc.name} が起動しませんでした（${proc.readyUrl}）。`);
    stopAll(1);
    break;
  }
}

if (!shuttingDown) {
  console.log(`\n[dev] 開くのは http://127.0.0.1:${PAGES_PORT}/plan です（room は ${ROOM_PORT}）。`);
}
