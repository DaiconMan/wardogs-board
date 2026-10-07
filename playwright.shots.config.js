// 目視確認用スクリーンショットの設定（`npm run shots`）。
//
// 既定の設定（playwright.config.js）は e2e/shots.spec.js を testIgnore で外している。
// 合否を持たないものを CI で走らせても、落ちない代わりに何も守らないため。
// ここでは同じサーバ（globalSetup）を使いつつ、対象をその1本だけに絞る。
import base from "./playwright.config.js";

export default {
  ...base,
  testIgnore: undefined,
  testMatch: "**/shots.spec.js",
  // 撮影は落ちたら撮り直せばよい。再試行で時間を伸ばさない。
  retries: 0,
  reporter: [["list"]],
};
