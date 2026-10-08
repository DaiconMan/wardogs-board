// Playwright（UIテスト）用のサーバ構成。global-setup とテスト本体の両方が読む。
//
// vitest 側（tests/plan-helpers.js）と「絶対に」重ならない値にしてある。実測した
// 2 つの制約があるため:
//   * `wrangler pages dev` の inspector は `--port` を変えても 9229 固定で衝突するため、
//     インスタンスごとに `--inspector-port` を分ける必要がある。
//   * 複数インスタンスが同じ D1 persist ディレクトリを共有すると SQLite のロック競合で
//     `D1_ERROR` → 500 になるため、`--persist-to` も分ける必要がある。
// vitest(/plan): port 8831      / inspector 9331      / .wrangler/plan-state
// e2e(/plan)  : port 8832      / inspector 9332      / .wrangler/e2e-plan-state
// e2e(room)   : port 8833      / inspector 9333      / .wrangler/e2e-room-state
// → `npm test` と `npm run test:ui` を同時に走らせても干渉しない。
//
// `/` の作戦ノートは配信を止めた（public/_redirects で /plan にリダイレクト）ため、
// ノート専用の e2e サーバ（旧 port 8821 / inspector 9321 / .wrangler/e2e-state）は
// 廃止した。議論欄の API を畳んだときに、vitest 側の 8811-8814 の4本も消えた。
// 残るのは /plan（ホワイトボード）と room（Durable Object）の2本。

// /plan 用のインスタンス。認証は Discord ログインなので public/ をそのまま配信する。
// Discord 関連のバインディングが要るのもこちらだけ。
export const PLAN_PORT = 8832;
export const PLAN_INSPECTOR_PORT = 9332;
export const PLAN_PERSIST = ".wrangler/e2e-plan-state";

// ═══ 2プロセス目: wardogs-room（Durable Object）════════════════════
//
// **Pages プロジェクトの中に Durable Object は定義できない**ので、実体は
// 別の Worker（workers/room）にある。ローカルでは `wrangler dev` で立て、
// Pages 側は wrangler.toml の `script_name = "wardogs-room"` から、
// wrangler のレジストリ経由でこれを見つける（起動ログに `[connected]` が出る）。
//
// **レジストリを分ける。** 既定は `~/.config/.wrangler/registry` で機械ごとに1つ
// しかないため、`npm run dev` と `npm test` と e2e が同じ表を覗き合う。
// 実測: 既定のままだと ROOM が無いはずの vitest サーバ（8831）に
// wardogs-room が繋がり、503 を期待したテストが 101 になる。
// e2e はここを共有する2本（plan と room）だけが見える箱にする。
export const ROOM_PORT = 8833;
export const ROOM_INSPECTOR_PORT = 9333;
export const ROOM_PERSIST = ".wrangler/e2e-room-state";
export const E2E_REGISTRY = ".wrangler/registry-e2e";

// `--binding KEY=VALUE` で渡す値（本番とは無関係のダミー）。
// DISCORD_API_BASE=mock は ALLOW_DEBUG=1 と両方揃って初めて有効になる。
export const PLAN_BINDINGS = {
  SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
  DISCORD_CLIENT_ID: "e2e-client-id",
  DISCORD_CLIENT_SECRET: "e2e-client-secret",
  DISCORD_API_BASE: "mock",
  ALLOW_DEBUG: "1",
  // 配置の注記が弾かれたときに、理由が画面に出ることを確かめるために要る
  // （`functions/_lib/validate.js` の `blockedBy`）。
  // vitest 側（tests/plan-helpers.js）と同じ語にしてある。
  BLOCKED_WORDS: "禁止語",
};

// ═══ テスト用 Discord ID の採番表 ═══════════════════════════════════
//
// **新しい spec を足す人は、ここを見て空いている帯を取ること。**
//
// e2e は1つの D1（PLAN_PERSIST）を最初から最後まで共有する。作戦は消えない
// ので、同じ ID を2つのファイルが使うと、**後から走ったほうのユーザーに
// 見覚えのない作戦が生えている**状態になる。
// 「自分の作戦がN件」のような件数の前提を置いたテストが、単独実行では通って
// 全体実行だけで落ちる（実測: 9411 が plan-gutter と plan-visits で衝突し、
// `#sessions li` が 1件のはずが 2件になった）。
//
// | 帯          | ファイル                        |
// |-------------|---------------------------------|
// | 9001–9106   | plan-whiteboard.spec.js         |
// | 9200–9310   | plan-placements.spec.js         |
// | 9201        | plan-session-lifecycle.spec.js  |
// | 9301–9324   | plan-navigation.spec.js         |
// | 9400–9411   | plan-gutter.spec.js             |
// | 9501–9509   | plan-towers.spec.js             |
// | 9600–9620, 9730 | plan-areas.spec.js          |
// | 9600–9642   | plan-callouts.spec.js           |
// | 9601–9618   | plan-zones.spec.js              |
// | 9710–9716   | plan-visits.spec.js             |
// | 9720–9739   | plan-presence.spec.js           |
// | 9750–9760   | plan-patterns.spec.js           |
// | 9761–9769   | plan-layout.spec.js             |
// | 9770–9781   | plan-identity.spec.js           |
// | 9782–9791   | plan-hotzones.spec.js           |
// | 9792–9799   | plan-choice.spec.js             |
// | 9801        | plan-execd1.spec.js             |
// | 9802–9837, 9859–9891 | plan-cursors.spec.js   |
// | 9892–9900   | plan-carry.spec.js              |
// | 9901–9930   | plan-visibility.spec.js         |
// | 9931–9960   | plan-guest.spec.js              |
// | 9961–9980   | plan-avatar.spec.js             |
// | 9981–9999   | plan-liveink.spec.js            |
// | 10001–10100 | plan-cursors.spec.js（在室50人の2本だけ。下記） |
// | 10102–10120 | plan-redo.spec.js               |
// | 10121–10140 | plan-marquee.spec.js            |
// | 10141–10161 | plan-stamps.spec.js             |
// | 93/96/97/98/99 の x40 x41 x50 x51 | shots.spec.js（`npm run shots` 専用） |
//
// **既にある重なり**（2026-09-30 時点。今は落ちていないが、件数を見る
// テストを足すと落ちる）:
//   * 9201        plan-placements ↔ plan-session-lifecycle
//   * 9301–9310   plan-placements ↔ plan-navigation
//   * 9600–9620   plan-areas ↔ plan-callouts ↔ plan-zones
//
// **次に取るなら 5桁（10141 以降）。4桁は 9999 まで埋まった。**
// shots.spec.js は 98xx / 99xx の一部（9840 / 9841 / 9850 / 9851）を使うので、
// そこだけは避ける。
//
// **5桁の帯（10001–）は「人数で埋める」テスト専用。** 在室の上限が 50 に
// 上がったので（オーナー判断）、満員の試験だけで約100個の ID を使う。
// 4桁の中に100個の連続した空きが無く、また取ると 9931 以降の見通しが
// 悪くなるので、桁を変えて隔離した。1つのテストが帯ごと使う形なので、
// 中の採番表は書かない（plan-cursors.spec.js の該当テストに書いてある）。
//   10001–10048  「50接続を張った状態でも…」の頭数
//   10051–10101  「51人目は満員で断られる」の席と、あぶれる1人
//
// **plan-liveink.spec.js の50接続は、席を「ゲスト」で埋めるので番号を要らない**
// （`joinRoomAsGuest`。ログインの往復が1回も無いぶん速く、採番表も汚さない）。
// 席の数を見るのではなく「50接続下で成立するか」を見る試験なら、こちらが楽。
// ════════════════════════════════════════════════════════════════
