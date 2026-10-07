// 作戦ごとの公開設定の UI。
//
// 仕様: docs/superpowers/specs/2026-10-02-plan-visibility.md
// サーバ側の判定（5経路の総当たり）は tests/plan-visibility.test.js。
// ここで通すのは**画面から操作できること**と、**別アカウントの一覧に出ること**。
//
// このファイルが使う Discord ID は 9901〜9930。**他のファイルと重ねない。**
// e2e は1つの D1 を共有していて作戦は消えないので、同じ ID を使い回すと
// 件数の前提を置いたテストが単独実行では通って全体実行で落ちる。
//
// **件数の絶対値を見ない。** 「公開されている作戦」の節には、このファイルの
// 他のテストが公開した作戦も混ざる（作戦は消えない）。行は必ず題名で絞る。
import { test, expect } from "@playwright/test";

import {
  chooseOption, chosenValue, createPlan, loginViaApi, openVisibilityMenu, planUrl,
  waitForGrid,
} from "./plan-helpers.js";

/** 公開設定の札の文字（public/js/plan/visibility.js の VISIBILITY_CHOICES と同じ）。 */
const PRIVATE = "自分とURLを知っている人だけ";
const READ_ONLY = "一覧に出す（見るだけ）";
const OPEN_EDIT = "一覧に出す（書き込みも許す）";

const publicRows = (page) => page.locator("#public-sessions li");
const publicRow = (page, title) => publicRows(page).filter({ hasText: title });

/** 盤面を開いて、題名が入るまで待つ（プランの取得が終わった合図）。 */
async function openPlan(page, id, title) {
  await page.goto(planUrl(`/plan?id=${id}`));
  await expect(page.locator("#title")).toHaveText(title);
}

/** 公開設定を選び直す（メニューを開いて札を押す）。 */
async function setVisibility(page, label) {
  await openVisibilityMenu(page);
  await chooseOption(page, "visibility-choice", { label });
}

test.describe("公開設定の切り替え", () => {
  test("作成者は3つを選べ、リロードしても保たれる", async ({ page, context }) => {
    await loginViaApi(context, "9901", "こうかいする人");
    const id = await createPlan(context, "公開設定を切り替える作戦");
    await openPlan(page, id, "公開設定を切り替える作戦");

    // 既定は「公開していない」。畳んだボタンにその値が出ている。
    await expect(page.locator("#visibility")).toBeVisible();
    await expect(page.locator("#visibility-current")).toHaveText("なし");

    await setVisibility(page, READ_ONLY);
    await expect(page.locator("#visibility-current")).toHaveText("見るだけ");
    // 選んだあと何が起きるかが欄の中に出る（札の文字だけでは一覧がどこか分からない）。
    await expect(page.locator("#visibility-note")).toContainText("読むだけ");

    // **リロードしても保たれる。** ここが「DB に入った」ことの画面からの確認。
    await openPlan(page, id, "公開設定を切り替える作戦");
    expect(await chosenValueOf(page)).toBe("public");
    await expect(page.locator("#visibility-current")).toHaveText("見るだけ");

    await setVisibility(page, OPEN_EDIT);
    await expect(page.locator("#visibility-current")).toHaveText("書き込みも");
    await openPlan(page, id, "公開設定を切り替える作戦");
    expect(await chosenValueOf(page)).toBe("public_edit");

    // 非公開に戻せる（公開したら戻せない、にしない）。
    await setVisibility(page, PRIVATE);
    await openPlan(page, id, "公開設定を切り替える作戦");
    expect(await chosenValueOf(page)).toBe("private");
    await expect(page.locator("#visibility-current")).toHaveText("なし");
  });

  /** 欄がいま選んでいる値。メニューを開かないと札が押せないので先に開く。 */
  async function chosenValueOf(page) {
    await openVisibilityMenu(page);
    return chosenValue(page, "visibility-choice");
  }

  test("作成者以外には公開設定の欄を出さない", async ({ page, context }) => {
    await loginViaApi(context, "9902", "もちぬし");
    const id = await createPlan(context, "他人が開く作戦");

    await loginViaApi(context, "9903", "よそのひと");
    await openPlan(page, id, "他人が開く作戦");

    // 欄ごと出さない（押せないボタンを並べても、できることは増えない）。
    await expect(page.locator("#visibility")).toBeHidden();
    // 非公開のうちは「見るだけ」の札も出ない（書けるので理由が無い）。
    await expect(page.locator("#read-only")).toBeHidden();
  });
});

test.describe("公開した作戦が別アカウントの一覧に出る", () => {
  test("公開したら相手の一覧に出て、そこから開ける", async ({ page, context }) => {
    await loginViaApi(context, "9904", "こうかいぬし");
    const id = await createPlan(context, "みんなに見せる初動案");
    await openPlan(page, id, "みんなに見せる初動案");

    // 1. まだ非公開。相手の一覧にこの作戦は出ていない。
    //
    // ── ここは2つの理由で書き直した（2026-10-02）─────────────────
    //
    // **(a) 「節ごと無い」で見ない。** 節が出るかどうかは **e2e 全体で1件でも
    // 公開された作戦があるか**で決まる。e2e は1つの D1 を最初から最後まで
    // 共有する（`e2e/config.js`）ので、**他のファイルが作戦を1つ公開した
    // 瞬間にこの行は落ちる**——実際 plan-guest.spec.js を足して落ちた。
    // このファイルの冒頭に「件数の絶対値を見ない。行は必ず題名で絞る」と
    // 書いてあるのに、ここだけ守れていなかった。
    //
    // **(b) 描き終わる前に数えない。** `toHaveCount(0)` は**0 になった瞬間に
    // 通る**ので、一覧が描かれる前に数えると**何も確かめずに通る。**
    // それが CI だけで落ちた本当の理由で、タイミング次第で
    //   早く数える → 0 件 → 通る（ただし無意味）
    //   遅く数える → 1 件 → 落ちる
    // と揺れていた（CI の1回目は両方とも遅く、2回目は retry で早くなって
    // 「flaky」として素通りした）。**先に枠の表が出るまで待ってから数える。**
    await loginViaApi(context, "9905", "あいて");
    await page.goto(planUrl("/plan"));
    await waitForGrid(page);
    await expect(
      publicRow(page, "みんなに見せる初動案"), "非公開のうちは一覧に出さない"
    ).toHaveCount(0);

    // 2. 作成者に戻って公開する。
    await loginViaApi(context, "9904", "こうかいぬし");
    await openPlan(page, id, "みんなに見せる初動案");
    await setVisibility(page, READ_ONLY);
    await expect(page.locator("#visibility-current")).toHaveText("見るだけ");

    // 3. 相手の一覧に出る。**誰が作ったか**と**書き込めるか**が行から読める。
    await loginViaApi(context, "9905", "あいて");
    await page.goto(planUrl("/plan"));
    const row = publicRow(page, "みんなに見せる初動案");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("こうかいぬし");
    await expect(row).toContainText("見るだけ");
    // 他人のものなので削除の入口は置かない。
    await expect(row.getByRole("button", { name: "削除" })).toHaveCount(0);

    // 4. そこから開ける（これが無いと一覧に出す意味が無い）。
    await row.getByRole("link", { name: "開く" }).click();
    await expect(page).toHaveURL(planUrl(`/plan?id=${id}`));
    await expect(page.locator("#title")).toHaveText("みんなに見せる初動案");
  });

  test("書き込み可で公開すると、行に「書き込める」と出る", async ({ page, context }) => {
    await loginViaApi(context, "9906", "いっしょに書く人");
    const id = await createPlan(context, "みんなで書く作戦");
    await openPlan(page, id, "みんなで書く作戦");
    await setVisibility(page, OPEN_EDIT);
    await expect(page.locator("#visibility-current")).toHaveText("書き込みも");

    await loginViaApi(context, "9907", "書きに来た人");
    await page.goto(planUrl("/plan"));
    const row = publicRow(page, "みんなで書く作戦");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("書き込める");
  });

  test("非公開に戻すと相手の一覧から消える", async ({ page, context }) => {
    await loginViaApi(context, "9908", "やめる人");
    const id = await createPlan(context, "公開をやめる作戦");
    await openPlan(page, id, "公開をやめる作戦");
    await setVisibility(page, READ_ONLY);
    await expect(page.locator("#visibility-current")).toHaveText("見るだけ");

    await loginViaApi(context, "9909", "見ていた人");
    await page.goto(planUrl("/plan"));
    await expect(publicRow(page, "公開をやめる作戦")).toHaveCount(1);

    await loginViaApi(context, "9908", "やめる人");
    await openPlan(page, id, "公開をやめる作戦");
    await setVisibility(page, PRIVATE);
    await expect(page.locator("#visibility-current")).toHaveText("なし");

    await loginViaApi(context, "9909", "見ていた人");
    await page.goto(planUrl("/plan"));
    await expect(publicRow(page, "公開をやめる作戦")).toHaveCount(0);
  });
});

test.describe("読専で公開された作戦の見え方", () => {
  // **押せるボタンを並べて 403 で断るのでは「引いた線が消えた」ように見える。**
  // 棚ごと止めて、止まっている理由を札で出す。
  test("他の人の画面では道具が止まり、理由が札で出る", async ({ page, context }) => {
    await loginViaApi(context, "9910", "読専にする人");
    const id = await createPlan(context, "読むだけの作戦");
    await openPlan(page, id, "読むだけの作戦");
    await setVisibility(page, READ_ONLY);
    await expect(page.locator("#visibility-current")).toHaveText("見るだけ");

    await loginViaApi(context, "9911", "読むだけの人");
    await openPlan(page, id, "読むだけの作戦");

    // 1. 書き込めない理由がヘッダに出ている。
    const badge = page.locator("#read-only");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("見るだけ");
    await expect(badge).toHaveAttribute("title", /作った人だけ/);

    // 2. 道具は押せない（ペンもエリアも建造物も）。
    for (const name of ["ペン", "消しゴム", "地名を置く", "建造物", "円とマス"]) {
      await expect(page.getByRole("button", { name }), `${name} が押せてしまう`)
        .toBeDisabled();
    }

    // 3. **見ることはできる。** 地図は出ていて、**見る道具は止めない**
    //    （「読むだけ」なのだから、読むほうが効かなければ意味が無い）。
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.getByRole("button", { name: "全体表示" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "拡大" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "縮小" })).toBeEnabled();
  });

  test("作成者の画面では道具が止まらない（自分で締めても手が止まらない）", async ({
    page, context,
  }) => {
    await loginViaApi(context, "9912", "自分で締める人");
    const id = await createPlan(context, "自分で締めた作戦");
    await openPlan(page, id, "自分で締めた作戦");
    await setVisibility(page, READ_ONLY);
    await expect(page.locator("#visibility-current")).toHaveText("見るだけ");

    // 開き直しても作成者は書ける。札も出ない（公開設定の欄に値が出ている）。
    await openPlan(page, id, "自分で締めた作戦");
    await expect(page.locator("#read-only")).toBeHidden();
    await expect(page.getByRole("button", { name: "ペン" })).toBeEnabled();
  });
});

test.describe("非公開の共同編集は退行していない", () => {
  // **ここが「締めすぎ」を見張るテスト。** いまチームは非公開の作戦の URL を
  // 配って一緒に書いている。公開設定を足したせいでここが止まったら、
  // 機能が増えた以上に使い方が壊れる。
  test("URL を渡された相手は、非公開のままでも道具が全部使える", async ({ page, context }) => {
    await loginViaApi(context, "9913", "URLを配る人");
    const id = await createPlan(context, "非公開で一緒に書く作戦");

    await loginViaApi(context, "9914", "URLをもらった人");
    await openPlan(page, id, "非公開で一緒に書く作戦");

    // 札は出ない（書けるので、書けない理由を出す必要が無い）。
    await expect(page.locator("#read-only")).toBeHidden();
    for (const name of ["ペン", "消しゴム", "地名を置く", "建造物", "円とマス"]) {
      await expect(page.getByRole("button", { name }), `${name} が押せない`).toBeEnabled();
    }
    // 実際に道具を持てる（disabled でないことと、選べることは別）。
    const pen = page.getByRole("button", { name: "ペン" });
    await pen.click();
    await expect(pen).toHaveAttribute("aria-pressed", "true");
  });

  test("書き込み可で公開した作戦でも、他の人の道具は止まらない", async ({ page, context }) => {
    await loginViaApi(context, "9915", "書き込み可にする人");
    const id = await createPlan(context, "書き込み可の作戦");
    await openPlan(page, id, "書き込み可の作戦");
    await setVisibility(page, OPEN_EDIT);
    await expect(page.locator("#visibility-current")).toHaveText("書き込みも");

    await loginViaApi(context, "9916", "書きに来た人2");
    await openPlan(page, id, "書き込み可の作戦");
    await expect(page.locator("#read-only")).toBeHidden();
    const pen = page.getByRole("button", { name: "ペン" });
    await expect(pen).toBeEnabled();
    await pen.click();
    await expect(pen).toHaveAttribute("aria-pressed", "true");
  });
});
