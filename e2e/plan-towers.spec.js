// ドリルタワー（マップ固定の設備）の UIテスト。
//
// ここで守りたいのは4つ。
//   1. **作戦を開いた時点で、何もしなくても見えている**（手で置くものではない）
//   2. **マップごとに本数が違う**（Bakurani 5 / Ozeti 4 / Zestafona 3）
//   3. **置いた物（placements）と見た目がはっきり違う**
//      置いた物は塗りつぶした形で押せる。タワーは線だけで押せない。
//   4. **表示を切れる**。しかもフッターのボタンは増えていない（D-037）
import { test, expect } from "@playwright/test";

import {
  boardPoint, createPlan, loginViaApi, planUrl, showWholeMap, usePen,
} from "./plan-helpers.js";

/** 調査 §4.1 の本数。マップの性質なので、ここに並べて持つ。 */
const TOWER_COUNT = { bakurani: 5, ozeti: 4, zestafona: 3 };

/** Bakurani のタワーはこの辺りに固まっている（調査 §4.1。H9〜I10）。 */
const BAKURANI_CLUSTER = { x: 8000, y: 9300 };

async function openPlan(page, context, discordId, name, mapId = "bakurani") {
  await loginViaApi(context, discordId, name);
  const planId = await createPlan(context, name, mapId);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  // マップ座標で位置を指すので、まずマップ全体が見える状態にする
  // （開いた直後は地図が画面を埋めていて、外周は画面の外にいる）。
  await showWholeMap(page);
  return planId;
}

/** 「見る」の畳んだメニューを開く（表示の設定はここに集めてある）。 */
async function openViewMenu(page) {
  const menu = page.locator("#view-menu");
  if (!(await menu.evaluate((el) => el.open))) await menu.locator("> summary").click();
}

test.describe("ドリルタワー", () => {
  test("作戦を開いた時点で、何もしなくても5本見えている", async ({ page, context }) => {
    await openPlan(page, context, "9501", "towers-open");

    const towers = page.locator("#towers .tw");
    await expect(towers).toHaveCount(TOWER_COUNT.bakurani);
    await expect(towers.first()).toBeVisible();

    // 置いた物は1つも無い。タワーは「置かれた物」ではない。
    await expect(page.locator("#placements .pm")).toHaveCount(0);

    // 名前は伏せたまま（全体表示では 600m 四方に5本なので必ず重なる）。
    await expect(page.locator("#towers")).toHaveAttribute("data-names", "off");
  });

  test("マップごとに本数が違う", async ({ page, context }) => {
    let n = 0;
    for (const [mapId, count] of Object.entries(TOWER_COUNT)) {
      n += 1;
      await openPlan(page, context, `951${n}`, `towers-${mapId}`, mapId);
      await expect(page.locator("#towers .tw"), mapId).toHaveCount(count);
    }
  });

  test("寄ると名前が出る", async ({ page, context }) => {
    await openPlan(page, context, "9502", "towers-name");
    await expect(page.locator("#towers .tw")).toHaveCount(5);

    // 「拡大」1回で 1/1.6 倍。2000m を切るまで押す。
    for (let i = 0; i < 8; i += 1) {
      const w = await page
        .locator("#board")
        .evaluate((el) => Number(el.getAttribute("viewBox").split(" ")[2]));
      if (w <= 2000) break;
      await page.getByRole("button", { name: "拡大" }).click();
    }
    await expect(page.locator("#towers")).toHaveAttribute("data-names", "on");
    await expect(page.locator("#towers .tw-name").first()).toHaveText(/^Tower \d$/);
  });

  test("置いた物と見た目が違う（塗らない・押せない）", async ({ page, context }) => {
    await openPlan(page, context, "9503", "towers-vs-placements");
    await expect(page.locator("#towers .tw")).toHaveCount(5);

    // 同じ「ドリル」でも、チームが置く記号は別物（作図用の mk_drill）。
    // パレットから1つ置いて、両方が同時に出ている状態で比べる。
    // 既定の開閉はカタログが届いてから決まる（広い画面は開く）ので、
    // 中身が入るのを待ってから「開いていなければ開く」。
    const palette = page.locator("#palette");
    await expect(palette.locator(".pal-item").first()).toBeAttached();
    if (!(await palette.isVisible())) {
      await page.getByRole("button", { name: "建造物" }).click();
    }
    await expect(palette).toBeVisible();
    const group = page.locator('#palette .pal-group[data-kind="objective"]');
    if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
    await group.locator('.pal-item[data-item-id="mk_drill"]').click();
    const at = await boardPoint(page, BAKURANI_CLUSTER.x, BAKURANI_CLUSTER.y - 1500);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator("#placements .pm")).toHaveCount(1);

    // 1. 塗りの有無。置いた物は塗りつぶし、タワーは線だけ。
    const fill = (locator) => locator.evaluate((el) => getComputedStyle(el).fill);
    expect(await fill(page.locator("#placements .pm .pm-shape"))).not.toBe("none");
    expect(await fill(page.locator("#towers .tw-mark").first())).toBe("none");

    // 2. 当たり判定。タワーは押せない（＝自分たちの持ち物ではない）。
    const events = await page
      .locator("#towers")
      .evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(events).toBe("none");

    // 置いた直後は詳細（検視台）が開いていて、記号も選んだままなので、
    // どちらも外してから「押しても何も起きない」ことを見る。
    await page.locator("#placement-detail .close").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#placement-detail")).toBeHidden();

    const center = (locator) =>
      locator.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });

    const tower = await center(page.locator("#towers .tw").first());
    await page.mouse.click(tower.x, tower.y);
    await expect(page.locator("#placement-detail")).toBeHidden();
    // 押しても増えも減りもしない（タワーは触れない）。
    await expect(page.locator("#placements .pm")).toHaveCount(1);
    await expect(page.locator("#towers .tw")).toHaveCount(5);

    // 3. 置いた物は押せば詳細が出る（比較のための裏取り）。
    const marker = await center(page.locator("#placements .pm"));
    await page.mouse.click(marker.x, marker.y);
    await expect(page.locator("#placement-detail")).toBeVisible();
  });

  test("表示を切れる。フッターのボタンは増えていない", async ({ page, context }) => {
    await openPlan(page, context, "9504", "towers-toggle");
    const layer = page.locator("#towers");
    await expect(page.locator("#towers .tw")).toHaveCount(5);
    await expect(layer).not.toHaveAttribute("hidden", /.*/);

    // 切り替えはフッターに露出していない（畳んだメニューの中にある）。
    const toggle = page.getByRole("button", { name: "ドリルタワー" });
    await expect(toggle).toBeHidden();

    await openViewMenu(page);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(layer).toHaveAttribute("hidden", "");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#towers .tw").first()).toBeHidden();

    await openViewMenu(page);
    await toggle.click();
    await expect(layer).not.toHaveAttribute("hidden", /.*/);
    await expect(page.locator("#towers .tw").first()).toBeVisible();
  });

  // 座標系の端から端まで（DB → API → SVG → 座標表示）を1本で通す。
  // オーナーがゲーム内で Zestafona の Tower 3 にカーソルを合わせたとき、
  // ゲームは x70.01 y100.31 と出した（2026-09-29）。盤面で同じ場所に
  // カーソルを置いたら、同じ数字が出なければならない。
  test("タワーの上にカーソルを置くと、ゲームと同じ座標が出る（Zestafona Tower 3）", async ({
    page, context,
  }) => {
    await openPlan(page, context, "9506", "towers-readout", "zestafona");
    const tower = page.locator('#towers .tw[data-tower-id="zestafona-t3"]');
    await expect(tower).toHaveCount(1);

    // 盤面に描かれている位置（SVG ユーザー単位）をそのまま使う。
    // ここから座標表示までの経路に反転が二重に入っていないかを見る。
    const at = await tower.evaluate((el) => {
      const m = el.getAttribute("transform").match(/translate\(([-\d.]+) ([-\d.]+)\)/);
      return { x: Number(m[1]), y: Number(m[2]) };
    });
    const p = await boardPoint(page, at.x, at.y);
    await page.mouse.move(p.x, p.y);

    // 座標は `.xy`（主役の span）から読む。`#readout` 全体には
    // 「右クリックでコピー」の案内も入っている。
    const [gx, gy] = (await page.locator("#readout .xy").textContent())
      .match(/\d+\.\d{2}/g).map(Number);
    // ゲーム内の実測値。カーソルの読み取り誤差ぶん（0.25単位 = 25m）を許す。
    expect(Math.abs(gx - 70.01), `x（実測 70.01・表示 ${gx}）`).toBeLessThan(0.25);
    expect(Math.abs(gy - 100.31), `y（実測 100.31・表示 ${gy}）`).toBeLessThan(0.25);
  });

  test("陣営スポーンが3つ、実寸の四角で出る", async ({ page, context }) => {
    await openPlan(page, context, "9507", "spawns-open");
    const spawns = page.locator("#spawns .sp");
    await expect(spawns).toHaveCount(3);
    await expect(page.locator('#spawns .sp[data-faction="lonestar"] .sp-name'))
      .toHaveText("ローンスター");

    // 実寸（メートル）で描く。一辺およそ 480m の回転した正方形。
    const box = await page
      .locator('#spawns .sp[data-faction="valkyra"] .sp-shape')
      .evaluate((el) => {
        const b = el.getBBox();
        return { w: b.width, h: b.height };
      });
    // 45度ほど回った正方形なので、外接矩形は一辺の 1〜1.42 倍に収まる。
    expect(box.w).toBeGreaterThan(460);
    expect(box.w).toBeLessThan(480 * 1.45);
    expect(box.h).toBeGreaterThan(460);
    expect(box.h).toBeLessThan(480 * 1.45);

    // 押せない（マップが持っている物。チームが置いた物ではない）。
    const events = await page
      .locator("#spawns")
      .evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(events).toBe("none");
  });

  test("陣営スポーンの表示も切れる", async ({ page, context }) => {
    await openPlan(page, context, "9508", "spawns-toggle");
    const layer = page.locator("#spawns");
    await expect(page.locator("#spawns .sp")).toHaveCount(3);

    const toggle = page.getByRole("button", { name: "陣営スポーン" });
    await openViewMenu(page);
    await toggle.click();
    await expect(layer).toHaveAttribute("hidden", "");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // タワーのほうは消えない（別々に切れる）。
    await expect(page.locator("#towers")).not.toHaveAttribute("hidden", /.*/);
  });

  // D-037: 「実装した」と「使える」は別。狭い画面では棚が横に溢れるので、
  // 実機相当の幅でも切り替えに**到達できる**ことを確かめる。
  test.describe("狭い画面（390x844）", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("ドリルタワーの表示は狭い画面でも切り替えられる", async ({ page, context }) => {
      await openPlan(page, context, "9509", "towers-narrow");
      await expect(page.locator("#towers .tw")).toHaveCount(5);

      await openViewMenu(page);
      const toggle = page.getByRole("button", { name: "ドリルタワー" });
      // 棚は横スクロールする。押せる所まで持ってこられること自体を見る。
      await toggle.scrollIntoViewIfNeeded();
      await expect(toggle).toBeVisible();
      const box = await toggle.boundingBox();
      expect(box.width, "押しどころの幅").toBeGreaterThanOrEqual(44);
      expect(box.height, "押しどころの高さ").toBeGreaterThanOrEqual(44);

      await toggle.click();
      await expect(page.locator("#towers")).toHaveAttribute("hidden", "");
    });
  });

  test("タワーの上にも線が引ける（当たり判定を奪っていない）", async ({ page, context }) => {
    await openPlan(page, context, "9505", "towers-ink");
    await expect(page.locator("#towers .tw")).toHaveCount(5);

    await usePen(page);
    const a = await boardPoint(page, BAKURANI_CLUSTER.x - 200, BAKURANI_CLUSTER.y);
    const b = await boardPoint(page, BAKURANI_CLUSTER.x + 400, BAKURANI_CLUSTER.y + 200);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();

    await expect(page.locator("#ink path")).toHaveCount(1);
    await expect(page.locator("#status")).toContainText("保存しました");
  });
});
