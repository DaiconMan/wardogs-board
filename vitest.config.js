import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    // globalSetup は無い。かつては議論欄（/api/comments）のために設定の違う
    // `wrangler pages dev` を4つ（8811-8814）立てていたが、議論欄を畳んだときに
    // まとめて消した。いまサーバを要るテストは tests/plan-helpers.js の
    // `startServers()` を各ファイルの beforeAll で呼び、自分で立てて自分で止める。
    // wrangler pages dev の起動に数秒〜十数秒かかるので余裕を持たせる
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    // 同一サーバに複数ファイルが同時アクセスすると挙動が読みにくいので直列化する
    fileParallelism: false,
  },
});
