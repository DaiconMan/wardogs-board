// 訪問履歴（開いたことがある他人の作戦）の UI。
//
// 共有URLで他人の作戦を開いても、URL を無くすと二度と辿り着けなかった。
// サーバは GET /api/sessions で `visited` を返すようになっている（D-034）。
// ここでは「画面から辿れること」をブラウザ操作だけで通す。
//
// プライバシー方針（D-034）: 訪問記録は本人だけが読む。
// 作成者側から「誰が見たか」を引く画面は存在しないので、ここでも検証しない。
//
// このファイルが使う Discord ID は 9710〜9716。**他のファイルと重ねない。**
// e2e は1つの D1 を共有していて作戦は消えないので、同じ ID を使い回すと
// 「自分の作戦が1件」のような件数の前提が、単独実行では通って全体実行で落ちる
// （実測: 9411 が plan-gutter.spec.js と衝突して 2件になった）。
import { test, expect } from "@playwright/test";

import { createPlan, loginViaApi, planUrl } from "./plan-helpers.js";

/** 訪問履歴の区画と、その中の行。 */
const visitedSection = (page) => page.locator("#visited-list");
const visitedRows = (page) => page.locator("#visited li");
/** 自分の作戦の区画（従来からあるほう）。 */
const mineRows = (page) => page.locator("#sessions li");

test.describe("訪問履歴", () => {
  test("他人の作戦を開くと一覧に残り、作成者の名前が出て、そこから開き直せる", async ({
    page,
    context,
  }) => {
    // 1. 他人（作成者）として2つ作る。
    await loginViaApi(context, "9710", "ともだち");
    const theirsA = await createPlan(context, "他人の北ルート");
    const theirsB = await createPlan(context, "他人の南橋");

    // 2. 自分としてログインし直し、自分の作戦を1つ作る。
    await loginViaApi(context, "9711", "じぶん");
    await createPlan(context, "自分の初動案");

    // 3. 共有URLで他人の作戦を開く（ここで訪問が記録される）。
    for (const [id, title] of [[theirsA, "他人の北ルート"], [theirsB, "他人の南橋"]]) {
      await page.goto(planUrl(`/plan?id=${id}`));
      await expect(page.locator("#title")).toHaveText(title);
    }

    // 4. 一覧へ戻ると、自分の作戦とは別のまとまりとして出ている。
    await page.goto(planUrl("/plan"));
    await expect(mineRows(page)).toHaveCount(1);
    await expect(visitedSection(page)).toBeVisible();
    await expect(visitedRows(page)).toHaveCount(2);

    // 5. 誰の作戦かが行から読める。時刻は「更新」ではなく「開いた」を指す。
    const rowA = visitedRows(page).filter({ hasText: "他人の北ルート" });
    await expect(rowA).toHaveCount(1);
    await expect(rowA).toContainText("ともだち");
    await expect(rowA).toContainText("開いた");

    // 6. 自分の作戦は履歴側に混ざらない（両方に出ると数え間違える）。
    await expect(visitedRows(page).filter({ hasText: "自分の初動案" })).toHaveCount(0);
    await expect(mineRows(page).filter({ hasText: "他人の" })).toHaveCount(0);

    // 7. 他人のものは消せない。削除の入口を出さない。
    await expect(rowA.getByRole("button", { name: "削除" })).toHaveCount(0);
    // 自分の作戦のほうには今までどおり削除がある（区別が効いていることの裏取り）。
    await expect(mineRows(page).getByRole("button", { name: "削除" })).toHaveCount(1);

    // 8. 履歴からもう一度開ける（これが無いと機能の意味が無い）。
    await rowA.getByRole("link", { name: "開く" }).click();
    await expect(page).toHaveURL(planUrl(`/plan?id=${theirsA}`));
    await expect(page.locator("#title")).toHaveText("他人の北ルート");

    // 9. 共有URLのコピーは自分の作戦と同じ作法で置く。
    await page.goto(planUrl("/plan"));
    await visitedRows(page)
      .filter({ hasText: "他人の北ルート" })
      .getByRole("button", { name: "共有URLをコピー" })
      .click();
    await expect(page.locator("#status")).not.toHaveText("");
  });

  test("一度も他人の作戦を開いていなければ、区画ごと出さない", async ({ page, context }) => {
    await loginViaApi(context, "9712", "ひとり");
    await createPlan(context, "ひとりの作戦");

    await page.goto(planUrl("/plan"));
    await expect(mineRows(page)).toHaveCount(1);
    // 空の見出しだけが残ると邪魔になる。見出しごと出さない。
    await expect(visitedSection(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "開いたことがある作戦" })).toHaveCount(0);
  });

  test("作戦が1つも無い人でも、他人のを開いていれば履歴だけ出る", async ({ page, context }) => {
    await loginViaApi(context, "9713", "つくりぬし");
    const theirs = await createPlan(context, "見るだけの作戦");

    await loginViaApi(context, "9714", "みるだけ");
    await page.goto(planUrl(`/plan?id=${theirs}`));
    await expect(page.locator("#title")).toHaveText("見るだけの作戦");

    await page.goto(planUrl("/plan"));
    // 自分の作戦は0件。それでも**枠は並ぶ**（空の枠が作る入口になる）。
    await expect(page.locator("#sessions .s-cell[data-state=\"empty\"]").first()).toBeVisible();
    await expect(page.locator("#sessions li")).toHaveCount(0);
    // それでも履歴は出る（ここを早期 return で飛ばすと辿れなくなる）。
    await expect(visitedRows(page)).toHaveCount(1);
    await expect(visitedRows(page).first()).toContainText("つくりぬし");
  });
});

test.describe("訪問履歴（狭い画面）", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("390px でも行が画面からはみ出さず、開く・コピーが押せる", async ({ page, context }) => {
    await loginViaApi(context, "9715", "ながいなまえのひと");
    const theirs = await createPlan(context, "狭い画面で見る他人の作戦");

    await loginViaApi(context, "9716", "せまい");
    await page.goto(planUrl(`/plan?id=${theirs}`));
    await expect(page.locator("#title")).toHaveText("狭い画面で見る他人の作戦");

    await page.goto(planUrl("/plan"));
    const row = visitedRows(page).first();
    await expect(row).toBeVisible();

    // 横に溢れない（溢れるとページ全体が横スクロールになる）。
    const box = await row.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390.5);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(390);

    // 作成者の名前が省略されずに読める。
    await expect(row).toContainText("ながいなまえのひと");

    // タップ対象は 44x44 以上（design-system §4）。
    for (const target of [
      row.getByRole("link", { name: "開く" }),
      row.getByRole("button", { name: "共有URLをコピー" }),
    ]) {
      const b = await target.boundingBox();
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
    }
  });
});
