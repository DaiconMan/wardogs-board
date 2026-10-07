// Phase R0 の出口条件1・2を実測するための負荷スクリプト。
//
//   1. 20接続を30分維持して、Durable Objects の requests / duration を実測する
//   2. **全員が黙っている間、実行時間（GB-s）が伸びない**ことを確かめる
//      （＝ハイバネーションが効いている証拠）
//
// 人を集める必要は無い。ここから20本の WebSocket を張るだけ。
// **カーソルは送らない**（Phase R0 はカーソルを1本も描かない）。送るのは
// 25秒ごとのハートビート "p" だけで、これは setWebSocketAutoResponse が返すので
// Durable Object は起きない。**それでも duration が伸びるなら設計が間違っている。**
//
// **引数と Cookie の取り方、何を見れば判定できるかは README の
//   「リアルタイム（在室一覧）→ 使用量を実測する」にまとめてある。**
//
// 使い方（ローカル）:
//   node tools/ws-load.mjs --base http://127.0.0.1:8788 --plan <作戦ID> \
//        --cookie "wb_session=..." --clients 20 --minutes 30
//
// 使い方（本番。Cookie は自分のブラウザの devtools から取る。値はログに出さない）:
//   node tools/ws-load.mjs --base https://wardogs.daiconman.jp --plan <作戦ID> \
//        --cookie "$WB_COOKIE" --clients 20 --minutes 30
//
// 引数:
//   --base      サイトの URL（ローカルは http://127.0.0.1:8788）
//   --plan      作戦ID（/plan?id=... の id。どの部屋を測るか）
//   --cookie    セッション Cookie 1本（wb_session=...）。全接続で使い回す
//   --cookies   1行1Cookie のファイル。20人ぶんの在室を測るときはこちら
//   --clients   接続本数（既定 20）
//   --minutes   維持する分数（既定 30）
//   --ping-ms   ハートビートの間隔（既定 25000）
//
// **同じ Cookie を20本で使い回すと、在室は1人として数えられる**（人単位で数えるため）。
// それでも「接続20本 × 30分」の課金は同じ形で発生するので、枠の測定には足りる。
// 20人ぶんの在室を測りたいときは `--cookies file`（1行1Cookie）を使う。
//
// 判定（Cloudflare ダッシュボード → Workers & Pages → wardogs-room → Metrics）:
//   Requests      接続20件 ＋ 受信メッセージ÷20 程度。桁が違うなら見積もりが外れている
//   Duration      **全員が黙っている間は伸びないこと。** 伸びたらハイバネーションが効いていない
//   Rows written  0 に近いこと（serializeAttachment が行書き込みになるかは未確認）
import { readFileSync } from "node:fs";

import { connect } from "./ws-min.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? "1" : argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = args.base || "http://127.0.0.1:8788";
const plan = args.plan;
const clients = Number(args.clients || 20);
const minutes = Number(args.minutes || 30);
const pingMs = Number(args["ping-ms"] || 25_000);

if (!plan) {
  console.error("--plan <作戦ID> が必要です");
  process.exit(2);
}

const cookies = args.cookies
  ? readFileSync(args.cookies, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
  : [args.cookie].filter(Boolean);

if (cookies.length === 0) {
  console.error("--cookie か --cookies が必要です");
  process.exit(2);
}

const origin = new URL(base).origin;
const wsBase = base.replace(/^http/, "ws");
const url = `${wsBase}/api/sessions/${encodeURIComponent(plan)}/ws`;

const stats = { opened: 0, failed: 0, messages: 0, closed: 0, sentPings: 0, pongs: 0 };
const conns = [];

const stamp = () => new Date().toISOString().slice(11, 19);

for (let i = 0; i < clients; i += 1) {
  const cookie = cookies[i % cookies.length];
  try {
    const conn = await connect(url, { headers: { cookie, origin } });
    if (conn.status !== 101) {
      stats.failed += 1;
      console.error(`[${stamp()}] #${i} ハンドシェイク失敗 status=${conn.status} ${conn.body?.slice(0, 120) ?? ""}`);
      continue;
    }
    stats.opened += 1;
    conn.onMessage((text) => {
      if (text === "o") stats.pongs += 1;
      else stats.messages += 1;
    });
    // 開いたら1回だけ在室を取りに行く（クライアント本体と同じ作法）。
    conn.send(JSON.stringify({ t: "who" }));
    conns.push(conn);
  } catch (e) {
    stats.failed += 1;
    console.error(`[${stamp()}] #${i} 接続エラー: ${e.message}`);
  }
  // 20本を同じ瞬間に投げない（1,000 req/s のソフト上限と jitter の趣旨に合わせる）。
  await new Promise((r) => setTimeout(r, 50));
}

console.log(
  `[${stamp()}] 接続 ${stats.opened} 本（失敗 ${stats.failed}）。` +
    `${minutes} 分維持します。ハートビートは ${pingMs / 1000} 秒ごと。`
);
console.log(
  `[${stamp()}] この間 Cloudflare のダッシュボード（Workers & Pages → wardogs-room →`
  + ` Metrics）で requests と duration (GB-s) を見る。`
);

const ping = setInterval(() => {
  for (const conn of conns) {
    if (conn.closed) continue;
    conn.send("p");
    stats.sentPings += 1;
  }
}, pingMs);

const report = setInterval(() => {
  const alive = conns.filter((c) => !c.closed).length;
  console.log(
    `[${stamp()}] 生存 ${alive}/${stats.opened} / 受信(who) ${stats.messages}` +
      ` / pong ${stats.pongs} / 送信ping ${stats.sentPings}`
  );
}, 60_000);

await new Promise((r) => setTimeout(r, minutes * 60_000));

clearInterval(ping);
clearInterval(report);
for (const conn of conns) conn.close();

const alive = conns.filter((c) => !c.closed).length;
console.log(
  `[${stamp()}] 終了。開いた ${stats.opened} / 最後まで生きていた ${alive}` +
    ` / 受信(who) ${stats.messages} / pong ${stats.pongs} / 送信ping ${stats.sentPings}`
);
console.log(
  "課金の見積もり（調査 §2.4）: 接続の確立 = リクエスト1件、受信メッセージは 20:1、送信は無課金。"
);
console.log(
  `  このセッションの理論値: 確立 ${stats.opened} 件` +
    ` + 受信 ${(stats.opened + stats.sentPings)} 通 ÷ 20 ≒ ` +
    `${Math.ceil((stats.opened + stats.sentPings) / 20)} 件 = 合計約 ` +
    `${stats.opened + Math.ceil((stats.opened + stats.sentPings) / 20)} リクエスト`
);
console.log(
  "  duration の理論値: **0 に近い**（ハイバネーション中は課金されない）。"
    + " ダッシュボードで GB-s が伸びていたら設計が間違っている。"
);
process.exit(0);
