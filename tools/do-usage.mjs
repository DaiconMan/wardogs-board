// Durable Objects（wardogs-room）の使用量を**本番から**読む。
//
// **何のためにあるか。** Phase R1 の受け入れ条件3
// 「両方のタブで2分間マウスを止めて、duration が伸びないことを実測する」は
// e2e では測れない（Playwright で2分待てないし、ローカルには課金の概念が無い）。
// **本番の実測でしか判定できない唯一の条件**なので、見る手順を道具にしてある。
//
// 使い方:
//   set -a; source ~/.config/wardogs-board/env; set +a
//   node tools/do-usage.mjs                 # 直近2時間を1分刻みで
//   node tools/do-usage.mjs --hours 24      # 直近24時間
//   node tools/do-usage.mjs --minutes 20    # 直近20分（静止の実測はこれ）
//
// **受け入れ条件3の見かた**
//
//   1. ブラウザ2枚で同じ作戦を開き、少しマウスを動かす
//   2. **2分間、両方のタブに一切触らない**（別のウィンドウを前に出してよい）
//   3. `node tools/do-usage.mjs --minutes 10` を実行する
//   4. **静止していた分に行が出なければ合格。**
//      行が出ても activeTime が 0 に近ければ合格（接続の維持だけなら伸びない）
//
//   伸びていたら、ハイバネーションが効いていない。真っ先に疑うのは
//   「DO にタイマーが戻っていないか」（workers/room/src/cursors.js のヘッダ）。
//   tests/room-cursors.test.js がソースを見張っているが、本番で確かめるのはここ。
//
// **数字の読み方**
//   activeTime … オブジェクトが起きていた時間（マイクロ秒）。**課金はこれ**
//   GB-s       … activeTime(秒) × 0.125（128MB ÷ 1GB）。1日の無料枠は 13,000
//   requests   … **実際の呼び出し回数。請求される数ではない**（下記）
//
// ── `requests` に 20:1 を当てないこと ───────────────────────────
//
// **ここは「請求される数」を 20倍に見せていた。** 直した（2026-10-04）。
//
// Durable Objects の料金には「受信 WebSocket メッセージ20通 = 1リクエスト」の
// 割引があるが、Cloudflare のドキュメントにこう書いてある:
//
//   > a 20:1 ratio is applied to incoming WebSocket messages **for compute
//   > requests billing-only** ... The 20:1 ratio applies only for billing
//   > calculations, **not for metrics and analytics, which reflect actual usage**
//
// つまり **GraphQL の `requests` は生の通数**で、20:1 は掛かっていない。
// 実測で確かめた（2026-10-04 の負荷試験）: 本番に 7,438 通 ＋ 121 接続を流したとき、
// この指標は **7,653**（＝通数 ＋ 接続数のほぼ1:1）。分ごとにも 1:1 で合った。
// 請求のほうは 7,438÷20 ＋ 121 ≒ **493**（枠の 0.5%）で、**約20倍の差**。
//
// 直す前はこの 7,653 を枠 100,000 で割って「7.65%」と出していた。
// **負荷試験の消費を20倍に見せる**ので、「50人は無理」の誤った根拠になりうる。
// いまは生の数と、請求の見積もりの**幅**を並べて出す（この指標だけでは
// 通数と HTTP の内訳が分からないので、1点では出せない）。
//
// 値は表示しない（トークンは環境変数から読むだけ）。

// **自分の値を入れる**（環境変数 `DO_NAMESPACE_ID` でも渡せる）。
// Durable Object 名前空間の ID（32桁の16進）で、Cloudflare アカウントごとに違う。
// 公開リポジトリには入っていない。
//
// **wrangler には名前空間を一覧するサブコマンドが無い**（4.142.0 で確認）。
// REST API で引く。名前は `<Worker 名>_<クラス名>` ＝ `wardogs-room_PlanRoom`。
//
//   npx wrangler deploy --config workers/room/wrangler.toml   # 先に出しておく
//   curl -s -H "authorization: Bearer $CLOUDFLARE_API_TOKEN" \
//     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/durable_objects/namespaces"
//
// ダッシュボードからなら Workers & Pages → Durable Objects の一覧。
const NAMESPACE_ID = process.env.DO_NAMESPACE_ID || "PUT-YOUR-OWN-NAMESPACE-ID-HERE";
const FREE_GB_S_PER_DAY = 13_000;
const FREE_REQUESTS_PER_DAY = 100_000;

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[i + 1];
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error("CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要ります。");
  console.error("  set -a; source ~/.config/wardogs-board/env; set +a");
  process.exit(1);
}

const minutes = Number(args.minutes ?? (args.hours ? Number(args.hours) * 60 : 120));
const to = new Date();
const from = new Date(to.getTime() - minutes * 60_000);
const iso = (d) => `${d.toISOString().slice(0, 17)}00Z`;

const QUERY = `
query($acc:String!,$ns:String!,$from:Time!,$to:Time!){
  viewer{accounts(filter:{accountTag:$acc}){
    durableObjectsPeriodicGroups(
      limit:10000, orderBy:[datetimeMinute_ASC],
      filter:{datetimeMinute_geq:$from, datetimeMinute_leq:$to, namespaceId:$ns}
    ){ dimensions{datetimeMinute} sum{activeTime cpuTime} }
    durableObjectsInvocationsAdaptiveGroups(
      limit:10000, orderBy:[datetimeMinute_ASC],
      filter:{datetimeMinute_geq:$from, datetimeMinute_leq:$to, namespaceId:$ns}
    ){ dimensions{datetimeMinute} sum{requests} }
  }}
}`;

const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    query: QUERY,
    variables: { acc: account, ns: NAMESPACE_ID, from: iso(from), to: iso(to) },
  }),
});
const body = await res.json();
if (body.errors) {
  console.error("GraphQL が断りました:", JSON.stringify(body.errors));
  console.error("トークンに Account Analytics Read が要ります。");
  process.exit(1);
}

const acc = body.data.viewer.accounts[0];
const active = new Map(
  acc.durableObjectsPeriodicGroups.map((r) => [r.dimensions.datetimeMinute, r.sum])
);
const reqs = new Map(
  acc.durableObjectsInvocationsAdaptiveGroups.map(
    (r) => [r.dimensions.datetimeMinute, r.sum.requests]
  )
);

const keys = [...new Set([...active.keys(), ...reqs.keys()])].sort();
if (keys.length === 0) {
  console.log(`${iso(from)} 〜 ${iso(to)}: **1行も無い**（この間 DO は一度も起きていない）`);
  process.exit(0);
}

let totalActive = 0;
let totalReq = 0;
console.log(`${iso(from)} 〜 ${iso(to)}  （wardogs-room / PlanRoom）\n`);
console.log("時刻(UTC)          activeTime      GB-s      requests");
for (const k of keys) {
  const a = active.get(k)?.activeTime ?? 0;
  const r = reqs.get(k) ?? 0;
  totalActive += a;
  totalReq += r;
  const gbs = (a / 1e6) * 0.125;
  console.log(
    `${k.slice(0, 16).replace("T", " ")}  ${String(a).padStart(10)}µs  ${gbs.toFixed(4).padStart(8)}  ${String(r).padStart(8)}`
  );
}

const gbs = (totalActive / 1e6) * 0.125;
console.log("\n── 合計 ────────────────────────────────");
console.log(`activeTime : ${(totalActive / 1e6).toFixed(2)} 秒`);
console.log(`GB-s       : ${gbs.toFixed(3)}  （1日の無料枠 ${FREE_GB_S_PER_DAY} の ${((gbs / FREE_GB_S_PER_DAY) * 100).toFixed(3)}%）`);
console.log(`呼び出し   : ${totalReq}  **生の回数。請求される数ではない**`);
// 請求は受信 WebSocket メッセージだけ 20:1 になる（ヘッダの引用）。この指標から
// 通数と HTTP の内訳は分からないので、**幅で出す**。
//   下限 … 全部が受信メッセージだった場合（÷20）
//   上限 … 1通も WebSocket が無かった場合（そのまま）
const billedLow = Math.ceil(totalReq / 20);
const pct = (n) => `${((n / FREE_REQUESTS_PER_DAY) * 100).toFixed(3)}%`;
console.log(
  `請求の見積り: ${billedLow} 〜 ${totalReq} リクエスト`
  + `（1日の無料枠 ${FREE_REQUESTS_PER_DAY} の ${pct(billedLow)} 〜 ${pct(totalReq)}）`
);
console.log("  下限 = 全部が受信 WebSocket メッセージ（20:1）／上限 = 全部が HTTP");
console.log("\n**行が出ていない分 = その1分は DO が一度も起きていない。**");
console.log("静止していた2分に行が無ければ、受け入れ条件3は合格。");
