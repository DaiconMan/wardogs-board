import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    globalSetup: ["tests/global-setup.js"],
    // wrangler pages dev の起動に数秒〜十数秒かかるので余裕を持たせる
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    // 同一サーバに複数ファイルが同時アクセスすると挙動が読みにくいので直列化する
    fileParallelism: false,
  },
});
