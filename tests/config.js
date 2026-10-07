// テスト用サーバ構成の一元定義。globalSetup とテスト本体の両方が読む。
//
// 実測にもとづく設計（フェーズ2の実験結果）:
//   * `cf-connecting-ip` はクライアントから指定でき、Worker 側までそのまま届く。
//     → テストごとにユニークな IP を送ることでレート制限（10分5件）の干渉を消す。
//   * `wrangler pages dev` は `--port` を変えても inspector が 9229 固定で衝突する。
//     → インスタンスごとに `--inspector-port` も分ける。
//   * 複数インスタンスが同じ D1 の persist ディレクトリを共有すると、同時書き込みで
//     `D1_ERROR: ... internal error`（SQLite のロック競合）になり 500 が返る。
//     → インスタンスごとに `--persist-to` を分けて完全に隔離する。

// 本番用（~/.config/wardogs-board/env）とは無関係のダミー値。
export const ADMIN_TOKEN = "test-admin-token-1f4c9a";

// Cloudflare が公開しているテスト用シークレット（公開値なのでコミットして良い）
export const TURNSTILE_SECRET_PASS = "1x0000000000000000000000000000000AA";
export const TURNSTILE_SECRET_FAIL = "2x0000000000000000000000000000000AA";

// 前後の空白・空要素・大文字小文字の扱いも同時に検証できる値にしてある。
export const BLOCKED_WORDS_VALUE = "禁止語, BadWord ,,  spam  ";

export const SERVERS = {
  // 素の状態: TURNSTILE_SECRET なし / BLOCKED_WORDS なし
  base: {
    port: 8811,
    inspectorPort: 9311,
    vars: { ADMIN_TOKEN, IP_SALT: "wardogs-test-base" },
  },
  // Turnstile 常に成功
  turnstilePass: {
    port: 8812,
    inspectorPort: 9312,
    vars: { ADMIN_TOKEN, IP_SALT: "wardogs-test-tpass", TURNSTILE_SECRET: TURNSTILE_SECRET_PASS },
  },
  // Turnstile 常に失敗
  turnstileFail: {
    port: 8813,
    inspectorPort: 9313,
    vars: { ADMIN_TOKEN, IP_SALT: "wardogs-test-tfail", TURNSTILE_SECRET: TURNSTILE_SECRET_FAIL },
  },
  // BLOCKED_WORDS あり
  blocked: {
    port: 8814,
    inspectorPort: 9314,
    vars: { ADMIN_TOKEN, IP_SALT: "wardogs-test-blocked", BLOCKED_WORDS: BLOCKED_WORDS_VALUE },
  },
};

export const baseUrl = (name) => `http://127.0.0.1:${SERVERS[name].port}`;
