// /plan のページ間の導線。
//
// オーナー報告の不具合: 盤面（?id= あり）から作戦の一覧（?id= 無し）へ戻る
// 手段がページ上に無く、URL を手で削るしかなかった。
//
// ここでは「今どこにいるか」「どこへ戻れるか」がページから分かることと、
// 戻ったあとに同じ作戦をもう一度開けることを、ブラウザ操作だけで通す。
import { test, expect } from "@playwright/test";

import {
  boardPoint, coverViewBox, createPlan, fitViewBox, loginViaApi, planUrl, waitForGrid,
} from "./plan-helpers.js";

/** ヘッダの「作戦の一覧」へ戻るリンク。 */
const backLink = (page) => page.getByRole("link", { name: "作戦の一覧" });

test.describe("ページ間の導線", () => {
  test("盤面から作戦の一覧へ戻れて、そこからまた同じ作戦を開ける", async ({ page, context }) => {
    await loginViaApi(context, "9301", "nav1");
    const title = "導線テスト作戦";
    const planId = await createPlan(context, title);

    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#title")).toHaveText(title);

    // 1. 盤面から一覧へ戻れる。
    await expect(backLink(page)).toBeVisible();
    await backLink(page).click();
    await expect(page).toHaveURL(planUrl("/plan"));
    await waitForGrid(page);

    // 2. 戻った先に、いま見ていた作戦が並んでいる。
    const row = page.locator("#sessions li", { hasText: title });
    await expect(row).toHaveCount(1);

    // 3. そこからまた開ける。
    await row.getByRole("link", { name: "開く" }).click();
    await expect(page).toHaveURL(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#title")).toHaveText(title);
  });

  test("一覧の画面では現在地が題名に出て、戻るリンクは出ない", async ({ page, context }) => {
    await loginViaApi(context, "9302", "nav2");
    await page.goto(planUrl("/plan"));
    await waitForGrid(page);

    // ここが出発点なので「戻る」は出さない（押せない導線を置かない）。
    // 「セレクタが空振りしているだけ」を通さないよう、要素の存在も見る。
    await expect(page.locator("#to-list")).toHaveCount(1);
    await expect(backLink(page)).toBeHidden();
    await expect(page.locator("#title")).toHaveText("作戦プランナー");
  });

  test("盤面が読み込めなくても一覧へ戻れる", async ({ page, context }) => {
    await loginViaApi(context, "9303", "nav3");
    const planId = await createPlan(context, "読み込み失敗");

    await page.route("**/api/sessions/**", (r) => r.abort());
    await page.goto(planUrl(`/plan?id=${planId}`));

    await expect(page.locator("#status")).toContainText("接続できません");
    // 行き止まりにしない。読み込みに失敗したときこそ戻る手段が要る。
    await expect(backLink(page)).toBeVisible();
    await backLink(page).click();
    await expect(page).toHaveURL(planUrl("/plan"));
  });

  test("一覧の画面には盤面の道具を出さない（状態表示だけ残す）", async ({ page, context }) => {
    await loginViaApi(context, "9304", "nav4");
    await page.goto(planUrl("/plan"));
    await waitForGrid(page);

    // 押せない道具を 15 個並べない。
    await expect(page.locator("#rail")).toHaveCount(1);
    await expect(page.locator("#rail")).toBeHidden();
    // 状態表示（#status）はどの画面でも同じ場所に出る。
    await expect(page.locator("#tools")).toBeVisible();
    // 枠を押して題名を空にすると、同じ #status に理由が出る。
    await page.locator("#sessions button.s-new").first().click();
    await page.locator("#create-title").fill("");
    await page.getByRole("button", { name: "作戦を作る" }).click();
    await expect(page.locator("#status")).toContainText("題名を入力してください");
  });

  test("ログイン前も道具は出さない（ログインボタンだけ）", async ({ page }) => {
    await page.goto(planUrl("/plan"));
    await expect(page.getByRole("button", { name: /Discord でログイン/ })).toBeVisible();
    await expect(page.locator("#rail")).toHaveCount(1);
    await expect(page.locator("#rail")).toBeHidden();
  });
});

test.describe("道具の並び", () => {
  test("道具は役割ごとのまとまりに分かれている", async ({ page, context }) => {
    await loginViaApi(context, "9310", "rail1");
    const planId = await createPlan(context, "rail");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    // 「道具」「置く」「取り消し」「見る」の4つ。平らに並べない。
    // **「取り消し」が独立したまとまりなのは、戻す・やり直すの2つが隣同士で
    // なければ見つけられないため。** 「置く」の中へ挟むと、建造物と円とマスが
    // 棚の2箇所に分かれる（同じ種類のものを2箇所に置かない）。
    await expect(page.locator("#rail > .cluster")).toHaveCount(4);
    // 移動・ペン・消す・地名・選択は排他の1組（ポインタが何をするかの5択）。
    const modes = page.locator("#tool-modes button");
    await expect(modes).toHaveCount(5);
  });

  test("背景の切り替えはメニューにまとめ、今の設定をボタンに出す", async ({ page, context }) => {
    await loginViaApi(context, "9311", "rail2");
    const planId = await createPlan(context, "rail-basemap");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    const menu = page.locator("#view-menu");
    const summary = menu.locator("> summary");
    // 閉じているあいだも今の設定が読める。
    await expect(summary).toContainText("モノクロ");
    await expect(page.getByRole("button", { name: "カラー" })).toBeHidden();

    await summary.click();
    await page.getByRole("button", { name: "カラー" }).click();
    await expect(summary).toContainText("カラー");
    await expect(page.locator("#basemap-layer")).toHaveAttribute("filter", "none");

    // Esc で閉じる（開きっぱなしで盤面を隠さない）。
    await summary.click();
    await expect(page.getByRole("button", { name: "カラー" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "カラー" })).toBeHidden();
  });
});

// 狭い画面ではパレットが盤面の上半分を覆う。広い画面（左に寄る）とは
// 前提が違うので、そこだけ挙動を変えている。
test.describe("狭い画面", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("項目を選ぶとパレットは畳まれ、そのまま盤面の真ん中に置ける", async ({ page, context }) => {
    await loginViaApi(context, "9320", "narrow1");
    const planId = await createPlan(context, "狭い画面");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#title")).toHaveText("狭い画面");

    await page.getByRole("button", { name: "建造物" }).click();
    const palette = page.locator("#palette");
    await expect(palette).toBeVisible();

    const group = palette.locator('.pal-group[data-kind="emplacement"]');
    if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
    await palette.locator('.pal-item[data-item-id="mortar_l81"]').click();

    // 選んだ先に置きたい場所が隠れていては意味がないので、畳む。
    await expect(palette).toBeHidden();
    // 畳んでも「何を選んでいるか」は状態表示に残る。
    await expect(page.locator("#status")).toContainText("L81 迫撃砲 を選びました");

    const p = await boardPoint(page, 7500, 7500);
    await page.mouse.click(p.x, p.y);
    await expect(page.locator("#placements .pm")).toHaveCount(1);
  });

  // 実機（iPhone）で、オーナーはドリル位置のマーカーに辿り着けなかった。
  // 棚が横スクロールで、「建造物」が画面の端で半分切れて「造物」としか
  // 見えていなかったため。**開く手段が視覚的に発見できない**状態だった。
  test("物を置く手段に、横スクロールなしで到達できる", async ({ page, context }) => {
    await loginViaApi(context, "9323", "narrow3");
    const planId = await createPlan(context, "狭い入口");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    const rail = page.locator("#rail");
    expect(await rail.evaluate((el) => el.scrollLeft)).toBe(0);

    // 送っていない状態で「建造物」が丸ごと見えている
    // （端で半分切れていると、そこに何かがあることに気づけない）。
    const btn = page.locator("#toggle-palette");
    const box = await btn.boundingBox();
    const railBox = await rail.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(railBox.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(railBox.x + railBox.width + 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);

    // そのまま押せて、パレットが開く。
    await btn.click();
    await expect(page.locator("#palette")).toBeVisible();
  });

  test("棚にはまだ続きがあることが見て分かる", async ({ page, context }) => {
    await loginViaApi(context, "9324", "narrow4");
    const planId = await createPlan(context, "棚の続き");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    // 右へ送れる状態なら、その目印を出す（半分切れたボタンを目印にしない）。
    const rail = page.locator("#rail");
    expect(await rail.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(true);
    await expect(rail).toHaveAttribute("data-overflow", "right");

    // 送ったら、左にも続きがあることを出す（送り戻せると分かる）。
    // スクロールスナップが効くので、端ちょうどで止まるとは限らない。
    await rail.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(() => rail.getAttribute("data-overflow")).toMatch(/^(left|both)$/);
  });

  test("道具の棚は1段に収まり、盤面が画面の6割以上を保つ", async ({ page, context }) => {
    await loginViaApi(context, "9321", "narrow2");
    const planId = await createPlan(context, "狭い棚");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#title")).toHaveText("狭い棚");

    // 棚が段を増やすと、そのぶん盤面が痩せる。1段（＝横スクロール）に保つ。
    const railHeight = await page.locator("#rail").evaluate((el) => el.getBoundingClientRect().height);
    expect(railHeight).toBeLessThan(60);

    const viewport = page.viewportSize();
    const box = await page.locator("#board").boundingBox();
    expect(box.height / viewport.height).toBeGreaterThan(0.6);

    // 端まで届かない道具も、押せる（横に送れる）こと。
    await page.getByRole("button", { name: "全体表示" }).click();
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await fitViewBox(page));
  });
});

test.describe("広い画面", () => {
  test("項目を選んでもパレットは開いたまま（左に寄っていて盤面を隠さない）", async ({ page, context }) => {
    await loginViaApi(context, "9322", "wide1");
    const planId = await createPlan(context, "広い画面");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#title")).toHaveText("広い画面");

    // 広い画面なので既定で開いている。ただし開閉が決まるのはカタログが届いてから
    // なので、中身が入るのを待ってから見る（待たずに押すと状態を読み違える）。
    const palette = page.locator("#palette");
    await expect(palette.locator(".pal-item").first()).toBeAttached();
    await expect(palette).toBeVisible();
    const group = palette.locator('.pal-group[data-kind="emplacement"]');
    if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
    await palette.locator('.pal-item[data-item-id="mortar_l81"]').click();

    await expect(palette).toBeVisible();
  });
});
