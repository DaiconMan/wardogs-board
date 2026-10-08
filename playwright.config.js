// Playwright（UIテスト）の設定。
//
// テスト対象は「ローカルの `wrangler pages dev`」で、本番（wardogs-board.pages.dev）は叩かない。
// サーバの起動と停止は e2e/global-setup.js が行う（vitest 側と同じ detached spawn +
// プロセスグループ kill + ポート解放ポーリング）。
//
// 直列実行にしている理由: D1（SQLite）の persist ディレクトリを 1 インスタンスで共有しており、
// 同時書き込みでロック競合（D1_ERROR → 500）が起きるため。またレート制限（IPごと10分5件）も
// テスト間で共有されるので、並列化すると 429 で不安定になる。
import { defineConfig, devices } from "@playwright/test";

import { PLAN_PORT } from "./e2e/config.js";

const BASE_URL = `http://127.0.0.1:${PLAN_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.js",
  // 目視確認用のスクリーンショット撮影は、合否を持たないので既定の実行から外す。
  // 撮るときは `npm run shots`（playwright test e2e/shots.spec.js）。
  testIgnore: "**/shots.spec.js",

  globalSetup: "./e2e/global-setup.js",

  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  // wrangler pages dev の初回リクエスト（Functions のビルド）とマップ画像の読み込みに
  // 時間がかかる
  timeout: 60_000,
  expect: { timeout: 15_000 },

  // CI では playwright-report/ を artifact に上げるので、ローカルでも同じ形で出す
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
