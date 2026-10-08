// 「やり直す」（戻すの取りやめ）の UIテスト。
//
// オーナーの要望（原文）: 「**戻すの取りやめ**もほしいです。」
//
// ここで守りたいのは、仕様の受け入れ条件1〜6。
//   1. 置く → 戻す → やり直す → 置いたものが戻る
//   2. **そのあともう一度「戻す」が効く**（やり直した結果の id を台帳が持てている証拠）
//   3. 線・配置・エリア・地名の**4種類すべて**で 1〜2 が成立する
//   4. 戻す → 新しい操作 → やり直しが押せなくなる
//   5. 山が空のとき、やり直しのボタンが押せない
//   6. やり直しが失敗しても画面が壊れず、その項目だけ消える
//
// **2が本題。** 戻す ＝ DELETE、やり直す ＝ もう一度 POST なので新しい id が振られる。
// 台帳が古い id を持ったままだと、次の「戻す」で既に消えた行を消しに行って 404 になる。
// だから**4種類すべてで「戻す → やり直す → 戻す」を通す**。
//
// **`戻す` は空でも押せるままであること**も見る（無効にすると
// plan-whiteboard.spec.js の drawLine() が使っている「道具が使えるようになった合図」が
// 永久に来ない）。無効にするのは `やり直す` だけ。
import { test, expect } from "@playwright/test";

import {
  boardPoint, createPlan, loginViaApi, planUrl, showWholeMap, usePen,
} from "./plan-helpers.js";

const CELL_M = 1000;

async function openPlan(page, context, discordId, name) {
  await loginViaApi(context, discordId, name);
  const planId = await createPlan(context, name);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  // 道具が使えるようになるまで待つ（プランとマップの取得が終わるまで）。
  await expect(page.getByRole("button", { name: "取り消す" })).toBeEnabled();
  await showWholeMap(page);
  return planId;
}

const undoBtn = (page) => page.getByRole("button", { name: "取り消す" });
const redoBtn = (page) => page.getByRole("button", { name: "やり直す" });

/** サーバに実際に何件あるか（画面だけ戻って行が残る、の逆も防ぐ）。 */
async function serverCounts(context, planId) {
  const [plan, placements, callouts] = await Promise.all([
    context.request.get(planUrl(`/api/sessions/${planId}`)),
    context.request.get(planUrl(`/api/sessions/${planId}/placements`)),
    context.request.get(planUrl(`/api/sessions/${planId}/callouts`)),
  ]);
  const planBody = await plan.json();
  return {
    strokes: planBody.strokes.length,
    areas: planBody.areas.length,
    placements: (await placements.json()).placements.length,
    callouts: (await callouts.json()).callouts.length,
  };
}

// ── 置く（4種類ぶんの手順）────────────────────────────────────

async function drawStroke(page) {
  await usePen(page);
  const a = await boardPoint(page, 3000, 3000);
  const b = await boardPoint(page, 6000, 5000);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#ink path[data-stroke-id]")).toHaveCount(1);
}

/**
 * パレットを開く。**広い画面では開いた状態で始まる**（`paletteOpenAtStart`）ので、
 * 無条件に押すと閉じてしまう。開いていないときだけ押す。
 */
async function openPalette(page) {
  const palette = page.locator("#palette");
  if (!(await palette.isVisible())) {
    await page.getByRole("button", { name: "建造物" }).click();
  }
  await expect(palette).toBeVisible();
}

/**
 * 項目を選ぶ。**種別の折りたたみ（`.pal-group`）を開いてから**押す。
 * 56項目あるので種別ごとに畳んであり、開いているのは先頭の種別だけ。
 */
async function pickItem(page, itemId) {
  await openPalette(page);
  const item = page.locator(`#palette .pal-item[data-item-id="${itemId}"]`);
  const group = page.locator(`#palette .pal-group:has(.pal-item[data-item-id="${itemId}"])`);
  // `open` は属性だと空文字（= falsy）になるので、プロパティで見る。
  if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
  await expect(item).toBeVisible();
  if ((await item.getAttribute("aria-pressed")) !== "true") await item.click();
  await expect(item).toHaveAttribute("aria-pressed", "true");
}

async function placeOne(page) {
  await pickItem(page, "fob");
  const at = await boardPoint(page, 8000, 8000);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator("#placements .pm")).toHaveCount(1);
}

async function placeCallout(page) {
  await page.getByRole("button", { name: "地名を置く" }).click();
  const at = await boardPoint(page, 4000, 9000);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator("#callouts .co")).toHaveCount(1);
}

async function paintArea(page) {
  await page.getByRole("button", { name: "円とマス", exact: true }).click();
  await page.locator('#zone-kinds button[data-kind="enemy"]').click();
  const a = await boardPoint(page, 3.5 * CELL_M, 7.5 * CELL_M);
  const b = await boardPoint(page, 5.5 * CELL_M, 8.5 * CELL_M);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#areas .area[data-kind="enemy"]'))
    .toHaveAttribute("data-cells", "6");
}

// ── 受け入れ条件5 ─────────────────────────────────────────────

test.describe("やり直しのボタンの押せる・押せない", () => {
  test("開いた直後は押せない（押せるのに何も起きないボタンを置かない）", async ({ page, context }) => {
    await openPlan(page, context, "10102", "やり直し未使用");
    await expect(redoBtn(page)).toBeDisabled();
    // **「戻す」は空でも押せるまま。** 無効にすると、道具が使えるように
    // なったことを `toBeEnabled()` で待っている既存のテストが動かなくなる。
    await expect(undoBtn(page)).toBeEnabled();
    await undoBtn(page).click();
    await expect(page.locator("#status")).toContainText("取り消せる操作がありません");
  });

  test("戻すと押せるようになり、やり直すと押せなくなる", async ({ page, context }) => {
    await openPlan(page, context, "10103", "やり直しの出入り");
    await drawStroke(page);
    await expect(redoBtn(page)).toBeDisabled();

    await undoBtn(page).click();
    await expect(redoBtn(page)).toBeEnabled();

    await redoBtn(page).click();
    await expect(page.locator("#status")).toContainText("やり直しました");
    await expect(redoBtn(page)).toBeDisabled();
  });

  // 受け入れ条件4。分岐した履歴を持たない（普通の作法）。
  test("戻したあとに新しい操作をすると、やり直しが押せなくなる", async ({ page, context }) => {
    await openPlan(page, context, "10104", "やり直しを捨てる");
    await drawStroke(page);
    await undoBtn(page).click();
    await expect(redoBtn(page)).toBeEnabled();

    // 新しい操作（別の線を引く）。
    await drawStroke(page);
    await expect(redoBtn(page)).toBeDisabled();
  });
});

// ── 受け入れ条件1・2・3 ────────────────────────────────────────
//
// **4種類すべてで同じ3手を踏む**: 置く → 戻す → やり直す → もう一度戻す。
// 最後の「もう一度戻す」が、やり直した結果の id を台帳が持てていることの証拠。

test.describe("戻す → やり直す → もう一度戻す（4種類すべて）", () => {
  test("線", async ({ page, context }) => {
    const planId = await openPlan(page, context, "10105", "やり直し・線");
    const ink = page.locator("#ink path[data-stroke-id]");

    await drawStroke(page);
    const firstId = await ink.first().getAttribute("data-stroke-id");

    await undoBtn(page).click();
    await expect(ink).toHaveCount(0);
    expect((await serverCounts(context, planId)).strokes).toBe(0);

    await redoBtn(page).click();
    await expect(ink).toHaveCount(1);
    expect((await serverCounts(context, planId)).strokes).toBe(1);
    // **id は変わっている**（DELETE → POST なので新しい行）。
    const secondId = await ink.first().getAttribute("data-stroke-id");
    expect(secondId).not.toBe(firstId);

    // 受け入れ条件2。台帳が新しい id を持てていなければ、ここで 404 になる。
    await undoBtn(page).click();
    await expect(page.locator("#status")).toContainText("取り消しました");
    await expect(ink).toHaveCount(0);
    expect((await serverCounts(context, planId)).strokes).toBe(0);
  });

  test("配置", async ({ page, context }) => {
    const planId = await openPlan(page, context, "10106", "やり直し・配置");
    const pm = page.locator("#placements .pm");

    await placeOne(page);
    const firstId = await pm.first().getAttribute("data-placement-id");

    await undoBtn(page).click();
    await expect(pm).toHaveCount(0);
    expect((await serverCounts(context, planId)).placements).toBe(0);

    await redoBtn(page).click();
    await expect(pm).toHaveCount(1);
    expect((await serverCounts(context, planId)).placements).toBe(1);
    expect(await pm.first().getAttribute("data-placement-id")).not.toBe(firstId);

    await undoBtn(page).click();
    await expect(page.locator("#status")).toContainText("取り消しました");
    await expect(pm).toHaveCount(0);
    expect((await serverCounts(context, planId)).placements).toBe(0);
  });

  test("地名", async ({ page, context }) => {
    const planId = await openPlan(page, context, "10107", "やり直し・地名");
    const co = page.locator("#callouts .co");

    await placeCallout(page);
    const name = await co.first().locator(".co-name").textContent();
    const firstId = await co.first().getAttribute("data-callout-id");

    await undoBtn(page).click();
    await expect(co).toHaveCount(0);
    expect((await serverCounts(context, planId)).callouts).toBe(0);

    await redoBtn(page).click();
    await expect(co).toHaveCount(1);
    // **呼び名も戻る**（座標だけ戻して名前が「地名」に化けると、やり直しとして使えない）。
    await expect(co.first().locator(".co-name")).toHaveText(name);
    expect((await serverCounts(context, planId)).callouts).toBe(1);
    expect(await co.first().getAttribute("data-callout-id")).not.toBe(firstId);

    await undoBtn(page).click();
    await expect(page.locator("#status")).toContainText("取り消しました");
    await expect(co).toHaveCount(0);
    expect((await serverCounts(context, planId)).callouts).toBe(0);
  });

  test("エリア", async ({ page, context }) => {
    const planId = await openPlan(page, context, "10108", "やり直し・エリア");
    const enemy = page.locator('#areas .area[data-kind="enemy"]');

    await paintArea(page);

    await undoBtn(page).click();
    await expect(enemy).toHaveAttribute("data-cells", "0");
    expect((await serverCounts(context, planId)).areas).toBe(0);

    await redoBtn(page).click();
    await expect(enemy).toHaveAttribute("data-cells", "6");
    expect((await serverCounts(context, planId)).areas).toBe(1);

    await undoBtn(page).click();
    await expect(page.locator("#status")).toContainText("取り消しました");
    await expect(enemy).toHaveAttribute("data-cells", "0");
    expect((await serverCounts(context, planId)).areas).toBe(0);
  });

  // エリアは追記型の op ログなので、向き（add / sub）を写しに入れ忘れると
  // 「消した」をやり直したときに「塗った」になる。
  test("エリアを消したのをやり直すと、消えたままになる（塗り直さない）", async ({ page, context }) => {
    await openPlan(page, context, "10109", "やり直し・エリアの消し");
    const enemy = page.locator('#areas .area[data-kind="enemy"]');

    await paintArea(page);
    // 消しゴムに切り替えて同じ範囲を消す（1ジェスチャ = 1行）。
    await page.getByRole("button", { name: "消しゴム" }).click();
    const a = await boardPoint(page, 3.5 * CELL_M, 7.5 * CELL_M);
    const b = await boardPoint(page, 5.5 * CELL_M, 8.5 * CELL_M);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await expect(enemy).toHaveAttribute("data-cells", "0");

    // 消したのを戻す ＝ 塗りが帰ってくる。
    await undoBtn(page).click();
    await expect(enemy).toHaveAttribute("data-cells", "6");

    // やり直す ＝ もう一度消える。**ここで 6 に戻ると op が反転している。**
    await redoBtn(page).click();
    await expect(enemy).toHaveAttribute("data-cells", "0");
  });
});

// ── 受け入れ条件2の続き（続けて2回やり直す）───────────────────────
//
// 台帳に積み直すときにやり直しの山を捨てていると、2件目がやり直せない。

test("2件戻して2件やり直せる（積み直しで山を捨てていない）", async ({ page, context }) => {
  const planId = await openPlan(page, context, "10110", "やり直し2連");
  const pm = page.locator("#placements .pm");

  await placeOne(page);
  // 2件目は別の場所へ。パレットの選択は残っているのでそのまま押せる。
  const second = await boardPoint(page, 10000, 6000);
  await page.mouse.click(second.x, second.y);
  await expect(pm).toHaveCount(2);

  await undoBtn(page).click();
  await expect(pm).toHaveCount(1);
  await undoBtn(page).click();
  await expect(pm).toHaveCount(0);

  await redoBtn(page).click();
  await expect(pm).toHaveCount(1);
  // **ここが肝。** 1件目のやり直しで山を捨てていると、もう押せない。
  await expect(redoBtn(page)).toBeEnabled();
  await redoBtn(page).click();
  await expect(pm).toHaveCount(2);
  await expect(redoBtn(page)).toBeDisabled();

  expect((await serverCounts(context, planId)).placements).toBe(2);
});

test("注記と優先度を付けた配置をやり直すと、両方が戻る", async ({ page, context }) => {
  await openPlan(page, context, "10111", "やり直し・注記と優先度");
  const pm = page.locator("#placements .pm");

  await placeOne(page);
  await page.locator("#placement-label").fill("ここ守ろう");
  await page.locator("#placement-label-save").click();
  await expect(page.locator("#status")).toContainText("注記を保存しました");
  await page.locator('#placement-rank [role="radio"][data-value="3"]').click();
  await expect(page.locator("#status")).toContainText("優先度を 3 にしました");

  await undoBtn(page).click();
  await expect(pm).toHaveCount(0);

  await redoBtn(page).click();
  await expect(pm).toHaveCount(1);
  // 注記はマーカーの札に出る。優先度はマーカーの中の数字。
  await expect(pm.first().locator(".pm-label")).toContainText("ここ守ろう");
  await expect(pm.first().locator(".pm-rank-badge .pm-rank")).toHaveText("3");
});

// ── 受け入れ条件6 ─────────────────────────────────────────────

test("やり直しが通らなかったとき、画面が壊れずその項目だけ消える", async ({ page, context }) => {
  await openPlan(page, context, "10112", "やり直しの失敗");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));

  await placeOne(page);
  await undoBtn(page).click();
  await expect(page.locator("#placements .pm")).toHaveCount(0);

  // 作り直しの POST だけを落とす（他の人が作戦ごと消した、権限が無くなった等の代わり）。
  await page.route("**/placements", (r) => {
    if (r.request().method() === "POST") return r.fulfill({ status: 403, body: "{}" });
    return r.continue();
  });

  await redoBtn(page).click();
  await expect(page.locator("#status")).toContainText("やり直せませんでした");
  // **その項目は山から落ちている**（押しても何も起きないボタンを残さない）。
  await expect(redoBtn(page)).toBeDisabled();
  // 盤面は生きている（道具も押せるまま）。
  await expect(page.locator("#board")).toBeVisible();
  await expect(undoBtn(page)).toBeEnabled();
  expect(errors).toEqual([]);
});

// ── キーボード ────────────────────────────────────────────────

test("Ctrl+Z で戻し、Ctrl+Shift+Z と Ctrl+Y でやり直す", async ({ page, context }) => {
  await openPlan(page, context, "10113", "やり直しのキー");
  const pm = page.locator("#placements .pm");

  await placeOne(page);
  // パレットの項目を押したあとはボタンにフォーカスが残る。盤面へ戻す
  // （欄やボタンの上では取り消しのキーを横取りしない作りにしてある）。
  await page.evaluate(() => document.activeElement?.blur?.());

  await page.keyboard.press("Control+z");
  await expect(pm).toHaveCount(0);

  await page.keyboard.press("Control+Shift+z");
  await expect(pm).toHaveCount(1);

  await page.keyboard.press("Control+z");
  await expect(pm).toHaveCount(0);

  // Windows の作法も受ける（どちらかしか効かないと「効かない環境」が生まれる）。
  await page.keyboard.press("Control+y");
  await expect(pm).toHaveCount(1);
});
