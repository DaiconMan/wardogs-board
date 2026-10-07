// 「地図が画面の何%を占めるか」を機械で押さえる。
//
// オーナー指摘（2026-10-01）:
//   > 他サイトはやりたいことがスムーズにできて操作しやすいのに、
//   > うちのサイトは入り組んでたり文字が多かったり操作性いまいちなんですか？
//
// 原因は2つとも**構造**だった（調査 docs/research/2026-10-01-ux-benchmark.md）。
//   1. header / footer が**レイアウトの行**として高さを取っていた
//   2. 既定の視野が「正方形のマップ全体を収める」で、16:9 の画面では
//      幅の 56% しか使えないことが数学的に確定していた
//
// 実測（同じ測り方で、作り直す前後。d96fb62 と比較）:
//
//   | 画面      | 前（地図の実寸）     | 後            |
//   |-----------|---------------------|---------------|
//   | 1920x1080 | 938x938 = **42.4%** | **100%**      |
//   | 390x844   | 390x390 = **46.2%** | **100%**      |
//
// 枠の高さも 1920 で 61+81 → 70+72（どちらも行ではなく浮いた板）、
// 390 で 137+91（ヘッダ3段）→ 122+72 になった。
// ここが勝手に狭くならないよう、下限を機械で固定する。
import { test, expect } from "@playwright/test";

import {
  createPlan, loginViaApi, mapSizeM, planUrl, showWholeMap,
} from "./plan-helpers.js";

/**
 * 地図（背景画像）が画面に占める割合。
 *
 * `#basemap` は app.js がマップの実寸（メートル）で張った SVG の <image> で、
 * `getBoundingClientRect()` は**実際に画面のどこに出ているか**を返す。
 * 画面からはみ出したぶんは数えない（見えている面積だけを割合にする）。
 */
async function mapCoverage(page) {
  return page.evaluate(() => {
    const r = document.getElementById("basemap").getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return (w * h) / (innerWidth * innerHeight);
  });
}

async function openBoard(page, context, id, name) {
  await loginViaApi(context, id, name);
  const planId = await createPlan(context, name);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  await mapSizeM(page);
  return planId;
}

test.describe("地図が画面を埋める（広い画面）", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("開いた直後、地図が画面の 99% 以上を占める", async ({ page, context }) => {
    await openBoard(page, context, "9761", "全面1920");
    expect(await mapCoverage(page)).toBeGreaterThan(0.99);
  });

  test("盤面そのものが画面いっぱい（枠が行として高さを取らない）", async ({ page, context }) => {
    await openBoard(page, context, "9762", "枠1920");
    const box = await page.locator("#board").boundingBox();
    const vp = page.viewportSize();
    expect(box.width).toBeGreaterThanOrEqual(vp.width - 1);
    expect(box.height).toBeGreaterThanOrEqual(vp.height - 1);
  });

  test("「全体表示」を押すとマップ全体が画面に入る", async ({ page, context }) => {
    await openBoard(page, context, "9763", "全体表示1920");
    await showWholeMap(page);

    const { w, h } = await mapSizeM(page);
    // 全体表示では、マップの四隅が盤面の中に収まっている。
    const corners = await page.evaluate(([mw, mh]) => {
      const board = document.getElementById("board");
      const m = board.getScreenCTM();
      const at = (x, y) => {
        const p = board.createSVGPoint();
        p.x = x; p.y = y;
        const s = p.matrixTransform(m);
        // DOMPoint は page.evaluate の戻りで消える。素の数値に直す。
        return { x: s.x, y: s.y };
      };
      return [at(0, 0), at(mw, mh)];
    }, [w, h]);
    const vp = page.viewportSize();
    expect(corners[0].x).toBeGreaterThanOrEqual(-1);
    expect(corners[0].y).toBeGreaterThanOrEqual(-1);
    expect(corners[1].x).toBeLessThanOrEqual(vp.width + 1);
    expect(corners[1].y).toBeLessThanOrEqual(vp.height + 1);
  });
});

test.describe("地図が画面を埋める（狭い画面）", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("開いた直後、地図が画面の 99% 以上を占める", async ({ page, context }) => {
    await openBoard(page, context, "9764", "全面390");
    expect(await mapCoverage(page)).toBeGreaterThan(0.99);
  });

  test("いま何の道具かが、横に送らずに読める", async ({ page, context }) => {
    await openBoard(page, context, "9765", "道具390");

    // 既定は「移動」。**それが最初の画面に出ていること。**
    // 以前は「置く」を先頭にする order のせいで、選ばれている道具が
    // 横スクロールの先にあり、開いた画面から読めなかった。
    const rail = page.locator("#rail");
    expect(await rail.evaluate((el) => el.scrollLeft)).toBe(0);

    const pan = page.getByRole("button", { name: "移動" });
    await expect(pan).toHaveAttribute("aria-pressed", "true");
    const box = await pan.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(390 + 0.5);

    // 物を置く入口も、同じ画面から押せる（半分に切れていない）。
    const palette = page.locator("#toggle-palette");
    const pbox = await palette.boundingBox();
    expect(pbox.x + pbox.width).toBeLessThanOrEqual(390 + 0.5);
  });
});

test.describe("常駐する文字を減らす", () => {
  test("ヘッダに「未検証」バッジを常駐させない（数値のそばに出す）", async ({ page, context }) => {
    await openBoard(page, context, "9766", "未検証の置き場");

    // ヘッダの中には無い。
    await expect(page.locator("header #unverified")).toHaveCount(0);
    // 縮尺（＝マップの一辺を根拠にした数値）のすぐ隣にある。
    const unv = page.locator("#scale-wrap #unverified");
    await expect(unv).toBeVisible();
    await expect(unv).toHaveText("未検証");
  });

  test("自分の名前・共有・ログアウトは1つに畳む", async ({ page, context }) => {
    await openBoard(page, context, "9767", "畳んだ自分");

    // 畳んでいる間は出ていない。
    await expect(page.locator("#share")).toBeHidden();
    await expect(page.locator("#logout")).toBeHidden();
    // 開けば全部ある。
    await page.locator("#account > summary").click();
    await expect(page.locator("#share")).toBeVisible();
    await expect(page.locator("#logout")).toBeVisible();
    await expect(page.locator("#who")).toContainText("でログイン中");
  });

  test("太さはペンを持っているときだけ出る", async ({ page, context }) => {
    await openBoard(page, context, "9768", "太さは文脈で");

    await expect(page.locator("#widths")).toBeHidden();
    await page.getByRole("button", { name: "ペン" }).click();
    await expect(page.locator("#widths")).toBeVisible();
    await page.getByRole("button", { name: "移動" }).click();
    await expect(page.locator("#widths")).toBeHidden();
  });

  test("名前の見え方の注記は、一度読んだら畳まれる", async ({ page, context }) => {
    await openBoard(page, context, "9769", "注記は一度だけ");

    // 初めて開いた人には出した状態で見せる。
    const note = page.locator("#presence .pres-priv");
    await expect(note).toBeVisible();

    // 読んだあと（＝同じブラウザでもう一度開く）は畳まれる。
    // **消えてはいない。** `i` を押せばいつでも読める。
    await page.reload();
    await expect(page.locator("#presence .pres-chip")).toHaveCount(1);
    await expect(page.locator("#presence .pres-priv")).toBeHidden();
    await page.locator("#presence .pres-info").click();
    await expect(page.locator("#presence .pres-priv")).toBeVisible();
    await expect(page.locator("#presence .pres-priv"))
      .toHaveText("あなたの名前とアイコンも相手に見えます（記録は残りません）");
  });
});
