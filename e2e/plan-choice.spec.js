// 1択の欄（`choice.js`）が、どの画面でも**読めて・キーボードで操作できる**こと。
//
// ── なぜこのファイルがあるか ─────────────────────────────────
// オーナーの実機（Windows Chrome, 1439x862）で、`<select>` を開いたときの
// 選択肢が**薄いグレー地に薄いグレー文字**になり、選択中の1件以外が読めなかった
// （2026-10-01 報告）。`:root` の `color-scheme:dark` は効いていなかった。
//
// **原因は「ポップアップを描いているのがこちらではない」こと。**
// `<select>` の選択肢の一覧は DOM に存在せず、色も CSS で決まらない。
// だから `npm run shots`（Linux のヘッドレス Chrome）にも写らず、
// **壊れていることを機械でも目でも確かめられなかった。**
//
// `<select>` をやめて 1択の欄に置き換えた。選択肢は**ただの `<button>`** なので:
//   * 色が CSS で決まる ＝ **どの OS でも同じ**（これが実機で読める根拠）
//   * DOM にある ＝ **ここでコントラスト比を実測できる**
//
// ここで押さえるのは3つ。
//   1. `/plan` のどの画面にも `<select>` が1つも残っていない（再発の門番）
//   2. **選択肢の文字が全部読める**（選ばれていない札も 4.5:1 以上）
//   3. キーボードだけで選べる（`<select>` から操作性を落としていない）
//
// Discord ID の帯: 9792–9799（e2e/config.js の採番表）。
import { test, expect } from "@playwright/test";

import {
  createPlan, execD1, loginViaApi, planUrl, textContrast, waitForGrid,
} from "./plan-helpers.js";

/** WCAG AA の本文の下限。選択肢は本文サイズなのでここを使う。 */
const AA = 4.5;

/**
 * Zestafona に3つのパターンを入れる（本番と同じ構成）。
 *
 * 2行は SQL 1文にまとめる（`execD1` は速くなったので回数の制約は無いが、
 * 「このマップのパターン一式」は1文のほうが読んで分かる）。
 * Zestafona を使うのは `schema.sql` が `zestafona-default` を1件入れており、
 * 「複数の札が並ぶ」状態をこのファイルだけで確実に作れるため。
 */
function seedZestafonaPatterns() {
  execD1(
    `INSERT OR IGNORE INTO map_zone_presets
       (id, map_id, key, name, x_m, y_m, radius_m, source, verified, sort_order, created_at, updated_at)
     VALUES
       ('e2e-zest-two', 'zestafona', 'Two', '2本型', 7000, 7000, 500, 'e2e の作り物', 0, 20,
        strftime('%s','now'), strftime('%s','now')),
       ('e2e-zest-three', 'zestafona', 'Three', '3本型', 9000, 9000, 500, 'e2e の作り物', 0, 30,
        strftime('%s','now'), strftime('%s','now'))`
  );
}

/** 1択の欄の札（選択肢）。 */
const options = (page, id) => page.locator(`#${id} [role="radio"]`);

/** いま選ばれている札の値。 */
const chosen = (page, id) =>
  page.locator(`#${id} [role="radio"][aria-checked="true"]`).getAttribute("data-value");

/**
 * **その欄の札が全部読めること。**
 *
 * 選ばれている札（塗りつぶし）と選ばれていない札（板の面）で配色が違うので、
 * 1枚ずつ測る。`<select>` のときに読めなかったのは
 * **「選ばれていない選択肢」だった**ので、ここを1枚も飛ばさない。
 */
async function expectEveryOptionReadable(page, id) {
  const list = options(page, id);
  const n = await list.count();
  expect(n, `${id} に札が無い`).toBeGreaterThan(0);
  for (let i = 0; i < n; i += 1) {
    const opt = list.nth(i);
    const text = (await opt.textContent())?.trim();
    const ratio = await textContrast(opt);
    expect(ratio, `#${id} の「${text}」が読めない（${ratio.toFixed(1)}:1）`)
      .toBeGreaterThanOrEqual(AA);
  }
}

/** 盤面を開いて「円とマス」の引き出しを出す（1択の欄はこの中にある）。 */
async function openZoneDrawer(page, context, uid, name, mapId = "zestafona") {
  seedZestafonaPatterns();
  await loginViaApi(context, uid, name);
  const planId = await createPlan(context, name, mapId);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#title")).toHaveText(name);
  await page.getByRole("button", { name: "円とマス", exact: true }).click();
  await expect(page.locator("#zonepanel")).toBeVisible();
  return planId;
}

test.describe("選択肢をブラウザに描かせない", () => {
  test("作戦の一覧に <select> が1つも無い", async ({ page, context }) => {
    await loginViaApi(context, "9792", "ch-list");
    await page.goto(planUrl("/plan"));
    await waitForGrid(page);

    // **ここが再発の門番。** `<select>` を1つ足した時点で落ちる。
    expect(await page.locator("select").count(), "<select> が残っている").toBe(0);
    // 枠を押して開く作成フォームにも無い（題名の欄だけ）。
    await page.locator("#sessions button.s-new").first().click();
    await expect(page.locator("#create-title")).toBeVisible();
    expect(await page.locator("select").count(), "<select> が残っている").toBe(0);
  });

  test("盤面にも <select> が1つも無い（引き出しを開いた状態で）", async ({ page, context }) => {
    await openZoneDrawer(page, context, "9793", "盤面のselect");
    await expect(options(page, "zone-preset-select").first()).toBeVisible();

    expect(await page.locator("select").count(), "<select> が残っている").toBe(0);
  });
});

test.describe("選択肢が全部読める", () => {
  test("盤面の「想定するパターン」は、選んでいない札も読める", async ({ page, context }) => {
    await openZoneDrawer(page, context, "9795", "札が読める");
    // 複数の札が並ぶ状態で測る（1件だけでは「選んでいない札」が出ない）。
    await expect(options(page, "zone-preset-select").nth(2)).toBeVisible();

    await expectEveryOptionReadable(page, "zone-preset-select");
  });

  test("管理者の「直す対象」も読める", async ({ page, context }) => {
    await loginViaApi(context, "9794", "ch-admin");
    execD1(`UPDATE users SET role = 'admin' WHERE discord_id = '9794'`);
    seedZestafonaPatterns();
    const planId = await createPlan(context, "直す対象", "zestafona");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await page.getByRole("button", { name: "円とマス", exact: true }).click();
    const admin = page.locator("#zone-admin");
    await expect(admin).toBeVisible();
    if (!(await admin.evaluate((el) => el.open))) await admin.locator("> summary").click();
    await expect(options(page, "zp-target").nth(1)).toBeVisible();

    await expectEveryOptionReadable(page, "zp-target");
  });

  test("配置の優先度（なし / 1〜9）も読める", async ({ page, context }) => {
    await loginViaApi(context, "9796", "ch-rank");
    const planId = await createPlan(context, "優先度が読める");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#title")).toHaveText("優先度が読める");

    // 配置を1件作って詳細を開く（優先度の欄は詳細パネルの中にある）。
    const status = await page.evaluate(async (id) => {
      const r = await fetch(`/api/sessions/${id}/placements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          placements: [{ client_uuid: "ch-rank-0001", item_id: "fob", x_m: 5000, y_m: 5000, rotation: 0 }],
        }),
      });
      return r.status;
    }, planId);
    expect(status, "配置を作れなかった").toBe(201);
    await page.reload();
    await page.locator("#placements .pm").first().click();
    await expect(page.locator("#placement-detail")).toBeVisible();
    await expect(options(page, "placement-rank").first()).toBeVisible();

    await expectEveryOptionReadable(page, "placement-rank");
  });
});

test.describe("キーボードだけで選べる", () => {
  test("Tab の止まり先は1つ、矢印で移ると移った先が選ばれる", async ({ page, context }) => {
    await openZoneDrawer(page, context, "9797", "キー操作");
    const opts = options(page, "zone-preset-select");
    await expect(opts.nth(2)).toBeVisible();
    const count = await opts.count();
    expect(count, "札が2つ以上無いと矢印キーを試せない").toBeGreaterThan(1);

    // radiogroup は**グループ全体で Tab の止まり先が1つ**。
    const tabbable = page.locator('#zone-preset-select [role="radio"][tabindex="0"]');
    await expect(tabbable).toHaveCount(1);
    // 止まり先は選ばれている札。
    await expect(tabbable).toHaveAttribute("aria-checked", "true");

    const first = await chosen(page, "zone-preset-select");
    await tabbable.focus();
    await page.keyboard.press("ArrowDown");
    // 移った先がその場で選ばれる（`<select>` を閉じたまま矢印で変えるのと同じ）。
    const second = await chosen(page, "zone-preset-select");
    expect(second).not.toBe(first);
    await expect(opts.nth(1)).toBeFocused();
    // 選んだ結果が盤面に出る（見た目だけ変わって何も起きない、にしない）。
    await expect(page.locator("#zone-preset .zp:not(.zp-preview)")).toHaveCount(1);

    // End で末尾、Home で先頭。
    await page.keyboard.press("End");
    await expect(opts.nth(count - 1)).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Home");
    await expect(opts.nth(0)).toHaveAttribute("aria-checked", "true");
    expect(await chosen(page, "zone-preset-select")).toBe(first);

    // Tab の止まり先は選び直したあとも1つだけ。
    await expect(page.locator('#zone-preset-select [role="radio"][tabindex="0"]')).toHaveCount(1);
  });

  test("読み上げに「1択の群れ」として渡る", async ({ page, context }) => {
    await openZoneDrawer(page, context, "9799", "読み上げ");
    const group = page.locator("#zone-preset-select");
    await expect(group).toHaveAttribute("role", "radiogroup");
    // 見出しと結び付いていること。`<label for>` は div に効かないので
    // `aria-labelledby` で繋ぐ。
    const labelId = await group.getAttribute("aria-labelledby");
    expect(labelId, "欄に見出しが結び付いていない").toBeTruthy();
    await expect(page.locator(`#${labelId}`)).toHaveText(/想定するパターン/);
    await expect(options(page, "zone-preset-select").first())
      .toHaveAttribute("aria-checked", /true|false/);
  });
});
