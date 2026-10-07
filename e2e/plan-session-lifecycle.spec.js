// 「API は実装もテストもされているのに、UI から到達する手段が無い」という
// 型のミスを検出するためのテスト。作戦の一覧・削除・ログアウトを、
// API を直接叩かず、ブラウザの操作だけで最初から最後まで通す。
//
// ログインの Cookie 注入だけは例外（Discord の認可画面は自動化できない）。
// それ以外は page.goto / page.locator(...).click() / page.mouse.* のみを使う。
import { test, expect } from "@playwright/test";

import {
  boardPoint, createViaGrid, loginViaApi, openAccountMenu, planUrl, showWholeMap, usePen,
} from "./plan-helpers.js";

/** マップ上の (x_m, y_m) を通る線を1本引く。plan-whiteboard.spec.js の同名関数と同じ。 */
async function drawLine(page, points) {
  // 開いた直後は地図が画面を埋めている（マップの外周は画面の外）。
  // マップ座標で位置を指すので、まず全体が見える状態にする。
  await showWholeMap(page);
  // 開いた直後の既定は「移動」。線を引く前にペンを選ぶ。
  await usePen(page);
  const screen = [];
  for (const [x, y] of points) screen.push(await boardPoint(page, x, y));
  await page.mouse.move(screen[0].x, screen[0].y);
  await page.mouse.down();
  for (const p of screen.slice(1)) await page.mouse.move(p.x, p.y, { steps: 10 });
  await page.mouse.up();
}

test("作成 → 一覧に出る → 共有URLコピー → 削除で消える → ログアウトで戻る", async ({
  page,
  context,
}) => {
  await loginViaApi(context, "9201", "lifecycle");
  const title = "通しテスト作戦";

  // 1. ?id= 無しの /plan は「マップ × パターン」の枠の表。空の枠から作る。
  await page.goto(planUrl("/plan"));
  await createViaGrid(page, title);

  await expect(page).toHaveURL(/\/plan\?id=[\w-]{22}$/);
  await expect(page.locator("#board")).toBeVisible();
  // #tool-pen はページの静的マークアップの時点では disabled 属性を持たないため
  // 「押せる」判定は main() が setEditable(false) を呼ぶ前に一瞬だけ真になり得る。
  // 見出しに題名が入るのは getPlan() が成功した後（setEditable(true) の直前）
  // なので、これを「本当に描き込める状態になった」合図として待つ。
  await expect(page.locator("#title")).toHaveText(title);

  // 2. 盤面に線を1本引いて保存されるのを待つ。
  await drawLine(page, [
    [400, 400],
    [900, 700],
    [1300, 500],
  ]);
  await expect(page.locator("#ink path")).toHaveCount(1);
  await expect(page.locator("#status")).toContainText("保存しました");

  // 3. ?id= 無しに戻ると、いま作った作戦が一覧に出ている。
  await page.goto(planUrl("/plan"));
  const row = page.locator("#sessions li", { hasText: title });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("link", { name: "開く" })).toBeVisible();

  // 3.5 一覧の行から共有URLをコピーできる（クリップボードの中身は環境依存
  // なので検証しない。ボタンが押せて #status が変化することまで見る）。
  await row.getByRole("button", { name: "共有URLをコピー" }).click();
  await expect(page.locator("#status")).not.toHaveText("");

  // 4. 削除は確認を1回受け入れてから。描いた線ごと消える操作なので。
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "削除" }).click();

  await expect(page.locator("#sessions li", { hasText: title })).toHaveCount(0);
  // 消しても**枠は残る**（空いた枠がそのまま作り直す入口になる）。
  // 「作戦が0件」で画面が空になる形にはしない。
  await expect(page.locator("#sessions .s-cell[data-state=\"empty\"]").first()).toBeVisible();

  // 5. ログアウトすると、ログイン画面に戻る（#board が無い）。
  //    自分についての操作は「自分」のメニューに畳んである。
  await openAccountMenu(page);
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(
    page.getByRole("button", { name: /Discord でログイン/ })
  ).toBeVisible();
  await expect(page.locator("#board")).toHaveCount(0);
});
