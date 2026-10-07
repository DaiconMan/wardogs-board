// 在室一覧（同じ作戦を開いている人）の UIテスト。
//
// **Phase R0 の出口条件3を見張っているのがこのファイル。**
//   * 接続者一覧が2人ぶん出る（2つのコンテキストで同じ作戦を開く）
//   * **WebSocket が使えなくても既存の全機能が動く**（リアルタイムは上乗せ）
//
// カーソルは Phase R1。ここでは1本も描かない。
//
// テスト用 Discord ID の帯: 9720–9729（e2e/config.js の採番表を参照）
import { expect, test } from "@playwright/test";

import {
  createPlan, joinRoom, loginHeadless, loginViaApi, mapSizeM, planUrl, usePen,
} from "./plan-helpers.js";

const chips = (page) => page.locator("#presence .pres-chip");
const names = (page) => page.locator("#presence .pres-name");

/** 盤面が描き終わるまで待つ（背景画像に実寸が入ったら描画済み）。 */
async function openPlan(page, planId) {
  await page.goto(planUrl(`/plan?id=${planId}`));
  await mapSizeM(page);
}

test("同じ作戦を開いている人が一覧に出る（自分1人）", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9720", "ひとりめ");
  const planId = await createPlan(ctx, "在室テスト1");
  const page = await ctx.newPage();
  await openPlan(page, planId);

  await expect(chips(page)).toHaveCount(1);
  await expect(names(page)).toHaveText(["ひとりめ"]);
  // 自分の行は「（あなた）」で二重に符号化してある（色だけに頼らない）。
  await expect(page.locator("#presence .pres-chip[data-me] .pres-self")).toHaveText("（あなた）");
  // 色の点が付いている（--cursor-1〜8 のどれか）。
  await expect(page.locator("#presence .pres-dot")).toHaveAttribute(
    "style",
    /var\(--cursor-[1-8]\)/
  );

  await ctx.close();
});

// **見られていることを、見る前に知れる状態にする**（調査 §5.7）。
// 一覧に自分が出ているだけでは「自分の名前が相手にも出ている」とは読めない。
// D-034 の「この記録はあなたにだけ見えます」（訪問履歴）と**役割が逆**の一文で、
// 「相手にも見える」と「記録には残らない」の両方を言う。
test("自分の名前が相手にも見えることが書いてある", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9727", "注記");
  const planId = await createPlan(ctx, "在室テスト6");
  const page = await ctx.newPage();
  await openPlan(page, planId);

  const note = page.locator("#presence .pres-priv");
  await expect(note).toBeVisible();
  await expect(note).toHaveText("あなたの名前とアイコンも相手に見えます（記録は残りません）");

  // 訪問履歴の一文（本人だけが読む）と混ざらないこと。逆のことを言う2文が
  // 同じ画面に並ぶと、どちらが在室の話か分からなくなる。
  await expect(page.locator("#presence")).not.toContainText("あなたにだけ");

  await ctx.close();
});

test("繋がっていないときは注記も出さない（誰にも見えていないので）", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9728", "注記なし");
  const planId = await createPlan(ctx, "在室テスト7");
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.WebSocket = function BlockedWebSocket() {
      throw new Error("WebSocket は使えません（テスト）");
    };
  });
  await openPlan(page, planId);

  await expect(page.locator("#presence")).toBeHidden();
  await expect(page.locator("#presence .pres-priv")).toHaveCount(0);

  await ctx.close();
});

test("2人が同じ作戦を開くと両方の画面に2人出る", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  await loginViaApi(a, "9721", "あおき");
  await loginViaApi(b, "9722", "さとう");
  const planId = await createPlan(a, "在室テスト2");

  const pageA = await a.newPage();
  await openPlan(pageA, planId);
  await expect(chips(pageA)).toHaveCount(1);

  const pageB = await b.newPage();
  await openPlan(pageB, planId);

  // 名前で安定に並ぶので、どちらの画面でも同じ順で出る。
  await expect(names(pageB)).toHaveText(["あおき", "さとう"]);
  await expect(names(pageA)).toHaveText(["あおき", "さとう"]);

  // 自分の行はそれぞれ自分。
  await expect(pageA.locator("#presence .pres-chip[data-me] .pres-name")).toHaveText("あおき");
  await expect(pageB.locator("#presence .pres-chip[data-me] .pres-name")).toHaveText("さとう");

  // 2人の色が違う（同じ色になると「誰が指しているか」が成立しない）。
  const styles = await pageA.locator("#presence .pres-dot").evaluateAll(
    (els) => els.map((el) => el.getAttribute("style"))
  );
  expect(new Set(styles).size).toBe(2);

  // 片方が閉じたら、もう片方の一覧から消える。
  await b.close();
  await expect(names(pageA)).toHaveText(["あおき"]);

  await a.close();
});

test("別の作戦は別の部屋（他の作戦を開いている人は見えない）", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  await loginViaApi(a, "9723", "べつまえ");
  await loginViaApi(b, "9724", "べつあと");
  const planA = await createPlan(a, "在室テスト3-A");
  const planB = await createPlan(b, "在室テスト3-B");

  const pageA = await a.newPage();
  await openPlan(pageA, planA);
  const pageB = await b.newPage();
  await openPlan(pageB, planB);

  await expect(names(pageB)).toHaveText(["べつあと"]);
  await expect(names(pageA)).toHaveText(["べつまえ"]);

  await a.close();
  await b.close();
});

test("同じ人がタブを2枚開いても1人として数える", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9725", "にまい");
  const planId = await createPlan(ctx, "在室テスト4");

  const page1 = await ctx.newPage();
  await openPlan(page1, planId);
  await expect(chips(page1)).toHaveCount(1);

  const page2 = await ctx.newPage();
  await openPlan(page2, planId);
  await expect(names(page2)).toHaveText(["にまい"]);
  await expect(names(page1)).toHaveText(["にまい"]);

  await ctx.close();
});

// **人数が増えてもヘッダの段数を増やさない。** header は flex-wrap:wrap なので、
// 在室の粒を素直に並べると人数に応じて段が増え、盤面（主役）が押し出される
// （実測: 1280px で8人のときヘッダ 61px → 145px）。`flex-basis:0` + 横スクロールで
// 段を増やさない形にしてあり、これが崩れても画面は動くので機械で押さえる。
//
// **他の7人はブラウザを開かない。** 見るのはホストのヘッダだけで、7人は
// 「部屋に居る」だけでよい。以前は7個の `browser.newContext()` で
// `/plan?id=` を丸ごと読み込んでいて、このテスト1本で **13.9 秒**かかっていた
// （計測の内訳は plan-helpers.js の `loginHeadless` のコメント）。
// 全体実行では 60 秒のタイムアウトに当たって落ちたことがある。
// WebSocket を1本張るだけなら同じ在室8人が桁違いに安く作れる。
test("在室が増えてもヘッダの高さが変わらない（盤面を押し出さない）", async ({ browser }) => {
  const host = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await loginViaApi(host, "9731", "ホスト");
  const planId = await createPlan(host, "Bakurani / Default 用");
  const page = await host.newPage();
  await openPlan(page, planId);
  await expect(chips(page)).toHaveCount(1);

  const headerH = () =>
    page.evaluate(() => Math.round(document.querySelector("header").getBoundingClientRect().height));
  const before = await headerH();

  const others = [];
  for (let i = 1; i < 8; i += 1) {
    const cookie = await loginHeadless(String(9731 + i), `メンバー${i}`);
    others.push(await joinRoom(cookie, planId));
  }
  await expect(chips(page)).toHaveCount(8);

  expect(await headerH()).toBe(before);
  // 注記は横スクロールしても左端に残る（sticky）。人数が多いときこそ要る。
  const note = page.locator("#presence .pres-priv");
  await expect(note).toBeVisible();
  await expect(note).toBeInViewport();

  for (const conn of others) conn.close();
  await host.close();
});

test("390px でも在室の名前と注記が読める", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await loginViaApi(ctx, "9739", "せまい");
  const planId = await createPlan(ctx, "せまい画面の作戦");
  const page = await ctx.newPage();
  await openPlan(page, planId);

  await expect(names(page)).toHaveText(["せまい"]);
  await expect(page.locator("#presence .pres-priv")).toBeInViewport();
  // 潰れて読めない幅になっていないこと（実測でここが 28px になって気づいた）。
  const w = await page
    .locator("#presence")
    .evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(w).toBeGreaterThan(200);

  await ctx.close();
});

test("WebSocket が使えなくても盤面の全機能が動く", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9726", "ますく");
  const planId = await createPlan(ctx, "在室テスト5");

  const page = await ctx.newPage();
  // **WebSocket そのものを壊す。** ブラウザや回線が塞いでいる状態を再現する。
  // page.route では WebSocket を止められないので、コンストラクタを置き換える。
  await page.addInitScript(() => {
    // eslint-disable-next-line no-global-assign
    window.WebSocket = function BlockedWebSocket() {
      throw new Error("WebSocket は使えません（テスト）");
    };
  });

  await openPlan(page, planId);

  // 在室一覧は出ない。**ここから下が全部動くことが本題。**
  await expect(page.locator("#presence")).toBeHidden();

  // 盤面が描けている
  const { w, h } = await mapSizeM(page);
  expect(w).toBeGreaterThan(0);
  expect(h).toBeGreaterThan(0);
  await expect(page.locator("#board")).toBeVisible();

  // 線が引ける（初期の道具は「移動」なので、ペンを選んでから）
  await usePen(page);
  const box = await page.locator("#board").boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#ink path")).toHaveCount(1);

  // 引いた線が保存されている（リロードしても残る）
  await page.reload();
  await mapSizeM(page);
  await expect(page.locator("#ink path")).toHaveCount(1);

  // 共有URLとログアウトの導線も出ている（「自分」のメニューの中）
  await page.locator("#account > summary").click();
  await expect(page.locator("#share")).toBeVisible();
  await expect(page.locator("#logout")).toBeVisible();

  await ctx.close();
});
