// 地名（コールアウト）と縮尺バーの UIテスト。
//
// ここで一番大事なのは「地名がプランごとに独立していること」。同じマップの
// 別の作戦を開いたときに、片方で置いた地名が出てこないことを実際に確かめる。
import { test, expect } from "@playwright/test";

import {
  boardPoint, coverViewBox, createPlan, fitViewBox, loginViaApi, openViewMenu, planUrl,
  showWholeMap,
} from "./plan-helpers.js";


async function openBoard(page, planId) {
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  // 道具が使える（= プランとマップを読み終えた）まで待つ。
  await expect(page.getByRole("button", { name: "地名を置く" })).toBeEnabled();
  // マップ座標で位置を指すので、まずマップ全体が見える状態にする
  // （開いた直後は地図が画面を埋めていて、外周は画面の外にいる）。
  await showWholeMap(page);
}

async function openPlan(page, context, discordId, name) {
  await loginViaApi(context, discordId, name);
  const planId = await createPlan(context, name);
  await openBoard(page, planId);
  return planId;
}

/** パレットを畳む（盤面の左側を素で触れるようにする）。 */
async function closePalette(page) {
  const palette = page.locator("#palette");
  await expect(palette.locator(".pal-item").first()).toBeAttached();
  if (await palette.isVisible()) {
    await page.getByRole("button", { name: "建造物" }).click();
  }
  await expect(palette).toBeHidden();
}

/** 地名を置く道具に入る（入っていれば何もしない）。 */
async function calloutMode(page) {
  const btn = page.getByRole("button", { name: "地名を置く" });
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
}

/** 地名を1つ置いて、呼び名を付けて、保存まで待つ。 */
async function placeCallout(page, x, y, name) {
  await calloutMode(page);
  const dots = page.locator("#callouts .co");
  const before = await dots.count();
  const p = await boardPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
  await expect(dots).toHaveCount(before + 1);
  await expect(page.locator("#status")).toContainText("を置きました");

  if (name === undefined) return;
  await page.locator("#callout-name").fill(name);
  await page.locator("#callout-name-save").click();
  await expect(page.locator("#status")).toContainText(`「${name}」にしました`);
}

/** 今の viewBox を数値で返す。 */
const viewBoxOf = (page) =>
  page.locator("#board").evaluate((el) => {
    const [x, y, w, h] = el.getAttribute("viewBox").split(" ").map(Number);
    return { x, y, w, h };
  });

/** 縮尺バーの「バーの画面上の長さ（px）」と、書いてある距離。 */
async function scaleBarOf(page) {
  const label = await page.locator("#scalebar .label").textContent();
  const px = await page.locator("#scalebar .bar").evaluate((el) =>
    el.getBoundingClientRect().width
  );
  return { label: label.trim(), px };
}

/** 「500 m」「1 km」をメートルの数値に直す。 */
function labelToMeters(label) {
  const m = label.match(/^([\d.]+)\s*(m|km)$/);
  if (!m) throw new Error(`縮尺の表記が読めない: ${label}`);
  return Number(m[1]) * (m[2] === "km" ? 1000 : 1);
}

test.describe("地名を置く・直す・消す", () => {
  test("置くとセル名が仮の呼び名になり、書き換えられる", async ({ page, context }) => {
    await openPlan(page, context, "9600", "callout-place");
    await closePalette(page);
    await calloutMode(page);

    // 盤面（SVG）の (7500, 7500)。列は H（左から8番目）。
    // 行は**下から**数えるので、上から8行目は 9（ゲームのマップ画面と同じ向き）。
    const p = await boardPoint(page, 7500, 7500);
    await page.mouse.click(p.x, p.y);

    await expect(page.locator("#callouts .co")).toHaveCount(1);
    // 仮の呼び名はそのセル名。「無題」より、そのまま使える呼び名を入れる。
    await expect(page.locator("#callout-name")).toHaveValue("H9");
    await expect(page.locator("#status")).toContainText("地名「H9」を置きました");

    // 置いた直後に欄へ入っているので、そのまま打ち替えられる。
    await expect(page.locator("#callout-name")).toBeFocused();
    await page.locator("#callout-name").fill("中央の丘");
    await page.locator("#callout-name-save").click();
    await expect(page.locator("#status")).toContainText("「中央の丘」にしました");
    await expect(page.locator("#callouts .co-name")).toHaveText("中央の丘");
  });

  test("リロードしても残る", async ({ page, context }) => {
    const planId = await openPlan(page, context, "9601", "callout-reload");
    await closePalette(page);
    await placeCallout(page, 4000, 4000, "工場");

    await openBoard(page, planId);
    await expect(page.locator("#callouts .co")).toHaveCount(1);
    await expect(page.locator("#callouts .co-name")).toHaveText("工場");
  });

  test("マーカーとは別の見た目で描かれる（点＋文字。ピンでも四角でもない）", async ({ page, context }) => {
    await openPlan(page, context, "9602", "callout-look");
    await closePalette(page);
    await placeCallout(page, 3000, 3000, "沢");

    const co = page.locator("#callouts .co");
    // 点（円が2つ: ハローと本体）と文字。配置マーカーの .pm-shape は持たない。
    await expect(co.locator("circle.co-dot")).toHaveCount(1);
    await expect(co.locator("circle.co-halo")).toHaveCount(1);
    await expect(co.locator("text.co-name")).toHaveCount(1);
    await expect(co.locator(".pm-shape")).toHaveCount(0);
    // 文字は点の右（x が正）。配置の項目名は真下（中央揃え）なので紛れない。
    expect(await co.locator(".co-name").evaluate((el) => Number(el.getAttribute("x"))))
      .toBeGreaterThan(0);
    expect(await co.locator(".co-name").getAttribute("text-anchor")).toBe("start");
  });

  test("自分の地名はドラッグで動かせる", async ({ page, context }) => {
    await openPlan(page, context, "9603", "callout-drag");
    await closePalette(page);
    await placeCallout(page, 5000, 5000, "橋");

    const before = await page.locator("#callouts .co").getAttribute("transform");
    const from = await boardPoint(page, 5000, 5000);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 90, from.y + 40, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator("#status")).toContainText("地名を動かしました");
    await expect(page.locator("#callouts .co")).not.toHaveAttribute("transform", before);
  });

  test("消せる。取り消すでも戻せる", async ({ page, context }) => {
    await openPlan(page, context, "9604", "callout-delete");
    await closePalette(page);

    await placeCallout(page, 6000, 6000, "北の橋");
    await page.locator("#callout-delete").click();
    await expect(page.locator("#status")).toContainText("地名を消しました");
    await expect(page.locator("#callouts .co")).toHaveCount(0);

    // 取り消しの台帳は線・配置と共通。地名も同じ列に載る。
    await placeCallout(page, 6500, 6500, "南の丘");
    await page.getByRole("button", { name: "取り消す" }).click();
    await expect(page.locator("#status")).toContainText("取り消しました");
    await expect(page.locator("#callouts .co")).toHaveCount(0);
  });

  test("24文字を超える呼び名は入力できない（サーバの上限と同じ）", async ({ page, context }) => {
    await openPlan(page, context, "9605", "callout-len");
    await closePalette(page);
    await placeCallout(page, 2000, 2000);

    const input = page.locator("#callout-name");
    await expect(input).toHaveAttribute("maxlength", "24");
    await input.fill("あ".repeat(30));
    expect((await input.inputValue()).length).toBe(24);
  });

  test("使えない語を含む呼び名は断られ、元の名前に戻る", async ({ page, context }) => {
    await openPlan(page, context, "9606", "callout-blocked");
    await closePalette(page);
    await placeCallout(page, 2500, 2500, "元の呼び名");

    await page.locator("#callout-name").fill("禁止語の丘");
    await page.locator("#callout-name-save").click();
    await expect(page.locator("#status")).toHaveClass(/err/);
    await expect(page.locator("#status")).toContainText("使えない語");
    // 楽観更新を巻き戻して、地図も欄も元の呼び名に戻っている。
    await expect(page.locator("#callouts .co-name")).toHaveText("元の呼び名");
    await expect(page.locator("#callout-name")).toHaveValue("元の呼び名");
  });
});

test.describe("地名は作戦ごとに独立している", () => {
  test("別の作戦を開くと、その作戦の地名だけが見える", async ({ page, context }) => {
    await loginViaApi(context, "9610", "callout-scope");
    const planA = await createPlan(context, "作戦A");
    const planB = await createPlan(context, "作戦B");

    await openBoard(page, planA);
    await closePalette(page);
    await placeCallout(page, 4000, 4000, "Aの丘");
    await expect(page.locator("#callouts .co")).toHaveCount(1);

    // 同じマップの別の作戦。A で付けた地名は出てこない。
    await openBoard(page, planB);
    await expect(page.locator("#callouts .co")).toHaveCount(0);

    await closePalette(page);
    await placeCallout(page, 4000, 4000, "Bの丘");
    await expect(page.locator("#callouts .co-name")).toHaveText("Bの丘");

    // A に戻っても A の呼び名のまま（B で置いたものは出ない）。
    await openBoard(page, planA);
    await expect(page.locator("#callouts .co")).toHaveCount(1);
    await expect(page.locator("#callouts .co-name")).toHaveText("Aの丘");
  });

  test("片方で改名しても、もう片方は変わらない", async ({ page, context }) => {
    await loginViaApi(context, "9611", "callout-rename");
    const planA = await createPlan(context, "改名A");
    const planB = await createPlan(context, "改名B");

    await openBoard(page, planA);
    await closePalette(page);
    await placeCallout(page, 8000, 8000, "共通の丘");
    await openBoard(page, planB);
    await closePalette(page);
    await placeCallout(page, 8000, 8000, "共通の丘");

    // B 側だけ改名する。
    await page.locator("#callouts .co").click();
    await page.locator("#callout-name").fill("Bだけ改名");
    await page.locator("#callout-name-save").click();
    await expect(page.locator("#callouts .co-name")).toHaveText("Bだけ改名");

    await openBoard(page, planA);
    await expect(page.locator("#callouts .co-name")).toHaveText("共通の丘");
  });
});

test.describe("他の人の地名", () => {
  test("読めるが、直せない・消せない（理由を先に見せる）", async ({ page, context, browser }) => {
    // 置く人。
    await loginViaApi(context, "9620", "callout-owner");
    const planId = await createPlan(context, "共有の作戦");
    await openBoard(page, planId);
    await closePalette(page);
    await placeCallout(page, 7000, 7000, "工場裏");

    // 別の人が同じ作戦を開く（共有URL）。
    const other = await browser.newContext();
    try {
      await loginViaApi(other, "9621", "callout-guest");
      const guest = await other.newPage();
      await guest.goto(planUrl(`/plan?id=${planId}`));
      await expect(guest.locator("#board")).toBeVisible();

      // 呼び名は読める（読めないとチームの共通語彙にならない）。
      await expect(guest.locator("#callouts .co-name")).toHaveText("工場裏");

      await guest.locator("#callouts .co").click();
      // 押せるようにしておいて 403 を出すのではなく、押せないことと理由を先に見せる。
      await expect(guest.locator("#callout-name")).toBeDisabled();
      await expect(guest.locator("#callout-name-save")).toBeDisabled();
      await expect(guest.locator("#callout-delete")).toBeDisabled();
      await expect(guest.locator("#callout-delete")).toHaveAttribute("title", /他の人の地名/);
    } finally {
      await other.close();
    }
  });
});

test.describe("ズームでの出し分けと表示の切り替え", () => {
  test("全体表示では点だけ、寄ると名前が出る", async ({ page, context }) => {
    await openPlan(page, context, "9630", "callout-zoom");
    await closePalette(page);
    await placeCallout(page, 8000, 8000, "中央の交差点");

    const layer = page.locator("#callouts");
    const name = page.locator("#callouts .co-name");

    // 選んでいる間は広くても名前を出す仕様なので、先に選択を外しておく。
    await page.locator("#placement-detail .close").click();
    await expect(page.locator("#callouts .co")).not.toHaveClass(/sel/);

    await page.getByRole("button", { name: "全体表示" }).click();
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await fitViewBox(page));
    // 16km 四方を見渡しているときは名前を伏せる（点は残る）。
    await expect(layer).toHaveAttribute("data-names", "off");
    await expect(name).toBeHidden();
    await expect(page.locator("#callouts .co-dot")).toBeVisible();

    // 4km 四方より寄ると名前が出る。
    const c = await boardPoint(page, 8000, 8000);
    await page.mouse.move(c.x, c.y);
    for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -600);
    expect((await viewBoxOf(page)).w).toBeLessThanOrEqual(4000);
    await expect(layer).toHaveAttribute("data-names", "on");
    await expect(name).toBeVisible();
  });

  test("「地名を表示」で丸ごと消せる", async ({ page, context }) => {
    await openPlan(page, context, "9631", "callout-toggle");
    await closePalette(page);
    await placeCallout(page, 3000, 9000, "土手");

    await openViewMenu(page);
    const toggle = page.getByRole("button", { name: "地名を表示" });
    const place = page.getByRole("button", { name: "地名を置く" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // 置いた直後なので、まだ「地名を置く」道具に入っている。
    await expect(place).toHaveAttribute("aria-pressed", "true");

    // 伏せたら置く道具からも抜ける（見えない所に置ける状態を残さない）。
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#callouts")).toBeHidden();
    await expect(place).toHaveAttribute("aria-pressed", "false");

    await toggle.click();
    await expect(page.locator("#callouts")).toBeVisible();

    // 伏せていても、置く道具に入ったら必ず出す（逆向きも同じ）。
    await toggle.click();
    await expect(page.locator("#callouts")).toBeHidden();
    await place.click();
    await expect(page.locator("#callouts")).toBeVisible();
    // 棚のボタンを押したので「表示」のメニューは畳まれる。開き直して状態を見る。
    await openViewMenu(page);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("Esc で地名を置く道具から抜ける", async ({ page, context }) => {
    await openPlan(page, context, "9632", "callout-esc");
    const btn = page.getByRole("button", { name: "地名を置く" });
    await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(btn).toHaveAttribute("aria-pressed", "false");
    // 道具を外したら既定の「移動」に戻る（ペンではない）。
    await expect(page.getByRole("button", { name: "移動" })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("縮尺（スケールバー）", () => {
  test("全体表示では km 単位、寄るほど短い距離に切り替わる", async ({ page, context }) => {
    await openPlan(page, context, "9640", "scalebar");
    await closePalette(page);

    const scalebar = page.locator("#scalebar");
    await expect(scalebar).toBeVisible();

    await page.getByRole("button", { name: "全体表示" }).click();
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await fitViewBox(page));
    const wide = await scaleBarOf(page);
    // 16km 四方を見渡しているので、目盛りは km の桁になる（盤面の実寸で
    // 1km か 2km かは変わるため、値そのものは固定しない）。
    expect(wide.label).toMatch(/ km$/);
    expect(labelToMeters(wide.label)).toBeGreaterThanOrEqual(1000);
    // 読み上げは図形と数字を1つの文にまとめる。
    await expect(scalebar).toHaveAttribute("aria-label", `縮尺 ${wide.label}`);

    const c = await boardPoint(page, 8000, 8000);
    await page.mouse.move(c.x, c.y);
    for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, -600);
    const near = await scaleBarOf(page);
    expect(labelToMeters(near.label)).toBeLessThan(labelToMeters(wide.label));
  });

  test("バーの長さが、書いてある距離と地図の上で一致する", async ({ page, context }) => {
    await openPlan(page, context, "9641", "scalebar-len");
    await closePalette(page);

    for (const ticks of [0, -600, -1800, -3000]) {
      if (ticks !== 0) {
        const c = await boardPoint(page, 8000, 8000);
        await page.mouse.move(c.x, c.y);
        await page.mouse.wheel(0, ticks);
      }
      const bar = await scaleBarOf(page);
      const meters = labelToMeters(bar.label);

      // 地図の上で「その距離ぶん」が画面で何 px になるかを実測して突き合わせる。
      const a = await boardPoint(page, 0, 0);
      const b = await boardPoint(page, meters, 0);
      expect(Math.abs(bar.px - (b.x - a.x)), `${bar.label} のバーの長さ`).toBeLessThan(1.5);

      // 数字はきりのいい値だけ（137m のような端数を出さない）。
      expect([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000])
        .toContain(meters);
      // 上限（120px）を超えない。
      expect(bar.px).toBeLessThanOrEqual(121);
    }
  });

  test("座標表示（右下）とぶつからない", async ({ page, context }) => {
    await openPlan(page, context, "9642", "scalebar-clash");
    await closePalette(page);

    const c = await boardPoint(page, 8000, 8000);
    await page.mouse.move(c.x, c.y);
    await expect(page.locator("#readout")).toBeVisible();

    const scale = await page.locator("#scalebar").boundingBox();
    const readout = await page.locator("#readout").boundingBox();
    const overlaps =
      scale.x < readout.x + readout.width && readout.x < scale.x + scale.width &&
      scale.y < readout.y + readout.height && readout.y < scale.y + scale.height;
    expect(overlaps, "縮尺と座標表示が重なっている").toBe(false);
  });
});
