// 設計上限（在室50人 × 4Hz = 毎秒200通）を流して、**配信が止まらないか**を測る。
//
// **なぜ ws-load.mjs と別なのか。** あちらは「黙っている20接続を30分維持して
// 課金が伸びないこと」を見る道具で、カーソルを1通も送らない。こちらは逆で、
// **上限いっぱいの通を流したときに受け手に何Hzで届くか**だけを見る。
// 測るものが違うので判定の出力も違い、1本にまとめると引数で分岐する塊になる。
//
// ── 何のために作ったか ──────────────────────────────────────────
//
// `docs/research/` の試算も e2e も **毎秒50通までしか流していない**
// （`e2e/plan-cursors.spec.js` の20接続は意図的にそこで止めてある）。
// 設計上限の 50人 × 4Hz（`CURSOR_RATE_TIERS` の最後の段）は、
// **告知で「50人まで」と書く直前まで一度も試験されていなかった。**
//
// ローカル（`wrangler pages dev` ↔ `wrangler dev` の2プロセス＋プロキシ）では
// 毎秒196通で配信が毎秒0.4回まで落ちた。**ローカルと本番では経路が違う**ので
// （本番は Pages Functions → バインディング経由で DO）、本番で測るためにこれを足した。
//
// ── 測るもの ────────────────────────────────────────────────────
//
//   1. **受け手が窓の間に受けた `curs` の数**（＝毎秒何回配信されたか）
//   2. **`curs` と `curs` のあいだの最大の空き**（止まったらここが伸びる）
//   3. 1秒ごとの受信数（じわじわ落ちるのか、ある時点で落ちるのか）
//   4. **往復の遅れ** — 送り手を1本「物差し」にして、送った x が
//      受け手に届いた `curs` に現れるまでを測る（送り手と受け手が同じ
//      プロセスなので時計が共通で、差を取るだけでよい）
//   5. 送った通数と、各接続が受けた通数
//   6. **この道具自身の CPU 時間** — 律速がサーバではなく手元だと分かるように
//
// ── ゲストで入る（D-072）──────────────────────────────────────
//
// 接続ごとに別のゲスト身元（`anon:` ＋ 128bit）を作るので、**50人として数えられる**
// （`ws-load.mjs` が Cookie を使い回して1人になるのとは違う）。
// ゲストはカーソルを送れるので、負荷の形としては足りる。
// **ゲストは何も書き込めない**ので、本番に対して流しても盤面は変わらない。
//
// ── 使い方 ──────────────────────────────────────────────────────
//
//   node tools/ws-fanout.mjs --base https://wardogs.daiconman.jp \
//        --plan <作戦ID> --clients 50 --hz 4 --seconds 30
//
//   --clients   接続本数（既定 50）。**1本は送らない「受け手」になる**
//   --hz        1接続あたりの送信回数/秒（既定 4 = 在室50人のときの段）
//   --seconds   測る秒数（既定 30）
//   --json      1行の JSON も吐く（複数回のまとめに使う）
//
// **枠の見積もり**: 受信は 20通で1リクエスト。50接続 × 4Hz × 30秒 = 6,000通 ≒
// 300 リクエスト ＋ 接続50件。1日の無料枠 100,000 の 0.35%。
// **これ以上の規模に広げないこと。** 実測は `node tools/do-usage.mjs --minutes 20`。
import { randomBytes } from "node:crypto";

import { connect } from "./ws-min.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = !argv[i + 1] || argv[i + 1].startsWith("--") ? "1" : argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = args.base || "http://127.0.0.1:8788";
const plan = args.plan;
const clients = Number(args.clients || 50);
const hz = Number(args.hz || 4);
const seconds = Number(args.seconds || 30);

if (!plan) {
  console.error("--plan <作戦ID> が必要です");
  process.exit(2);
}

/** ゲストの身元を1つ作る（`public/js/plan/guest.js` の `newGuestId` と同じ形）。 */
const newGuestId = () =>
  `anon:${randomBytes(16).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

const origin = new URL(base).origin;
const wsBase = base.replace(/^http/, "ws");
const stamp = () => new Date().toISOString().slice(11, 23);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── つなぐ ───────────────────────────────────────────────────────
//
// 50本を同じ瞬間に投げない（ws-load.mjs と同じ理由。1,000 req/s のソフト上限）。
const peers = [];
let failed = 0;
for (let i = 0; i < clients; i += 1) {
  const guest = newGuestId();
  const url = `${wsBase}/api/sessions/${encodeURIComponent(plan)}/ws?guest=${encodeURIComponent(guest)}`;
  let conn = null;
  try {
    conn = await connect(url, { headers: { origin } });
  } catch (e) {
    failed += 1;
    console.error(`[${stamp()}] #${i} 接続エラー: ${e.message}`);
    continue;
  }
  if (conn.status !== 101) {
    failed += 1;
    console.error(`[${stamp()}] #${i} 失敗 status=${conn.status} ${conn.body?.slice(0, 160) ?? ""}`);
    continue;
  }
  const peer = { i, conn, key: null, curs: 0, who: 0, other: 0, sent: 0, at: [] };
  conn.onMessage((text) => {
    // `you` は接続1回に1通。自分の接続の鍵がここで届く。
    if (text.startsWith('{"t":"you"')) {
      try {
        peer.key = JSON.parse(text).k;
      } catch {
        /* 読めなければ物差しに使わないだけ */
      }
      return;
    }
    if (text.startsWith('{"t":"curs"')) {
      peer.curs += 1;
      peer.at.push(Date.now());
      if (peer.onCurs) peer.onCurs(text);
      return;
    }
    if (text.startsWith('{"t":"who"')) peer.who += 1;
    else peer.other += 1;
  });
  conn.send(JSON.stringify({ t: "who" }));
  peers.push(peer);
  await sleep(40);
}

if (peers.length === 0) {
  console.error("1本も繋がりませんでした。");
  process.exit(1);
}

// 鍵（`you`）が全員に届くのを待つ。届かない接続は物差しに使わない。
for (let i = 0; i < 40 && peers.some((p) => !p.key); i += 1) await sleep(100);

// #0 は**送らない受け手**。これが「毎秒何回配信されたか」の物差しになる。
// #1 は送り手でもあり、**往復の遅れの物差し**（送った x が受け手に現れるまで）。
const watcher = peers[0];
const prober = peers[1];
const senders = peers.slice(1);
const senderHz = senders.length * hz;

console.log(
  `[${stamp()}] 接続 ${peers.length} 本（失敗 ${failed}）／受け手1本・送り手 ${senders.length} 本`
  + ` × ${hz}Hz = 毎秒 ${senderHz} 通を ${seconds} 秒。`
);

// ── 往復の遅れの物差し ───────────────────────────────────────────
//
// #1 が送った x を覚えておき、受け手 #0 に届いた `curs` の中の #1 の x と
// 突き合わせる。**同じプロセスなので時計が共通**で、差がそのまま遅れ。
const sentAt = new Map(); // x -> 送った時刻
const delays = [];
let probeX = 1000;
let lastSeenX = null;
if (prober?.key) {
  watcher.onCurs = (text) => {
    let c = null;
    try {
      c = JSON.parse(text).c;
    } catch {
      return;
    }
    const entry = c?.[prober.key];
    if (!Array.isArray(entry)) return;
    const x = entry[0];
    if (x === lastSeenX) return; // 同じ位置が2回配られた。新しい観測ではない
    lastSeenX = x;
    const t = sentAt.get(x);
    if (t !== undefined) delays.push(Date.now() - t);
  };
}

// ── 流す ─────────────────────────────────────────────────────────
//
// 送り手ごとにずらして始める（全員が同じ瞬間に撃つと、サーバから見た
// 毎秒の通数は同じでも山が立ち、間引きの判定が実際の使い方とずれる）。
const periodMs = Math.round(1000 / hz);
const timers = [];
const t0 = Date.now();
const cpu0 = process.cpuUsage();

for (const p of senders) {
  const offset = Math.round((periodMs * (p.i - 1)) / senders.length);
  timers.push(
    setTimeout(() => {
      const tick = () => {
        if (p.conn.closed) return;
        // 物差しの1本だけ x を動かす（他は固定でよい。DO は値を見ない）。
        if (p === prober) {
          probeX += 1;
          sentAt.set(probeX, Date.now());
          p.conn.send(JSON.stringify({ t: "cur", x: probeX, y: 4242 }));
        } else {
          p.conn.send(JSON.stringify({ t: "cur", x: 2000 + p.i, y: 3000 + p.i }));
        }
        p.sent += 1;
      };
      tick();
      timers.push(setInterval(tick, periodMs));
    }, offset)
  );
}

// 1秒ごとの進み具合（じわじわ落ちるのか、ある時点で落ちるのかを見る）。
const marks = [];
let prevCurs = watcher.curs;
const ticker = setInterval(() => {
  marks.push(watcher.curs - prevCurs);
  prevCurs = watcher.curs;
}, 1000);

const windowStart = Date.now();
const cursAtStart = watcher.curs;
await sleep(seconds * 1000);
const elapsedMs = Date.now() - windowStart;

for (const t of timers) {
  clearInterval(t);
  clearTimeout(t);
}
clearInterval(ticker);
const cpu = process.cpuUsage(cpu0);

// **閉じる前に数える。** 自分で close したあとに数えると、こちらの片付けで
// 付いた 1006 を「サーバに切られた」として読んでしまう。
const alive = peers.filter((p) => !p.conn.closed).length;
const closedCodes = {};
for (const p of peers) {
  const code = p.conn.closed?.code;
  if (code) closedCodes[code] = (closedCodes[code] ?? 0) + 1;
}

// ── 片付け（**必ず全部閉じる**）─────────────────────────────────
for (const p of peers) {
  try {
    p.conn.close();
  } catch {
    /* 既に切れている */
  }
}
await sleep(500);

// ── 数える ───────────────────────────────────────────────────────
const received = watcher.curs - cursAtStart;
const hzOut = received / (elapsedMs / 1000);

// 窓の中の受信時刻だけで隙間を測る。**ここが伸びたら止まっている。**
const inWindow = watcher.at.filter((t) => t >= windowStart);
let maxGap = 0;
let prev = windowStart;
for (const t of inWindow) {
  maxGap = Math.max(maxGap, t - prev);
  prev = t;
}
maxGap = Math.max(maxGap, windowStart + elapsedMs - prev);

const totalSent = senders.reduce((s, p) => s + p.sent, 0);
const cursCounts = peers.map((p) => p.curs).sort((a, b) => a - b);
const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
const sortedDelays = [...delays].sort((a, b) => a - b);

console.log(`\n── 結果 ───────────────────────────────────────`);
console.log(`接続            : ${peers.length} 本（失敗 ${failed}／窓の終わりまで生存 ${alive}）`);
if (Object.keys(closedCodes).length) {
  console.log(`**窓の途中で切られた**: ${JSON.stringify(closedCodes)}`);
}
console.log(`送った通数      : ${totalSent}（狙い 毎秒 ${senderHz} × ${seconds}秒 = ${senderHz * seconds}）`);
console.log(`実際の送信      : ${(totalSent / (elapsedMs / 1000)).toFixed(1)} 通/秒`);
console.log(`受け手の curs   : ${received} 通 / ${(elapsedMs / 1000).toFixed(1)} 秒 = **${hzOut.toFixed(2)} 回/秒**`);
console.log(`curs の最大の空き: ${maxGap} ms`);
console.log(`1秒ごとの受信   : ${marks.join(" ")}`);
console.log(
  `全接続の curs   : 最小 ${cursCounts[0]} / 中央 ${pct(cursCounts, 0.5)} / 最大 ${cursCounts.at(-1)}`
);
if (sortedDelays.length) {
  console.log(
    `往復の遅れ      : ${sortedDelays.length} 件  p50 ${pct(sortedDelays, 0.5)}ms`
    + ` / p95 ${pct(sortedDelays, 0.95)}ms / 最大 ${sortedDelays.at(-1)}ms`
  );
} else {
  console.log(`往復の遅れ      : **1件も観測できていない**（物差しの x が受け手に届いていない）`);
}
console.log(
  `この道具の CPU  : ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms`
  + `（窓は ${elapsedMs} ms。窓に近いなら律速は手元かもしれない）`
);
console.log(
  `枠の見積もり    : 受信 ${totalSent} 通 ÷ 20 ＋ 接続 ${peers.length} 件 ≒ `
  + `${Math.ceil(totalSent / 20) + peers.length} リクエスト`
);

if (args.json) {
  console.log(
    `JSON ${JSON.stringify({
      clients: peers.length, hz, seconds, sentPerSec: Number((totalSent / (elapsedMs / 1000)).toFixed(1)),
      cursPerSec: Number(hzOut.toFixed(2)), received, maxGap, marks,
      delayP50: pct(sortedDelays, 0.5), delayP95: pct(sortedDelays, 0.95), delayMax: sortedDelays.at(-1) ?? null,
      cpuMs: Math.round((cpu.user + cpu.system) / 1000), alive, closedCodes,
    })}`
  );
}

process.exit(0);
