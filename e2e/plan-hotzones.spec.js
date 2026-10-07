// ホットゾーン（半径 85m の円）の UIテスト。
//
// **守りたいのは5つ**（D-052。ホットゾーンに入ると人数が2倍に数えられる）。
//   1. 置ける・動かせる・消せる・リロードしても残る（既存の配置と同じ作法）
//   2. **半径が実寸 85m** であること。ズームしても地図と同じ縮尺で伸縮する
//   3. **コントロールエリアの円（半径 500m）と見分けがつく**こと。
//      同じ画面に出して、大きさ・色・線・中心の4つが違うことを機械で押さえる
//   4. **「人数2倍」が画面から分かる**こと（置いた直後の一言／札／詳細）
//   5. 390px でも引き出しから2手で置ける
import { test, expect } from "@playwright/test";

import {
  boardPoint, createPlan, execD1, loginViaApi, openViewMenu, planUrl, showWholeMap,
} from "./plan-helpers.js";

/** placements.js の HOTZONE_RADIUS_M と同じ値。ここを直すならあちらも直す。 */
const HOTZONE_RADIUS_M = 85;

/** コントロールエリアの既定の半径（Bakurani）。円の大きさの差を測る相手。 */
const ZONE_RADIUS_M = 500;

/** Bakurani の5本のタワーの重心（plan-zones.spec.js と同じ値。実データではない）。 */
const ZONE_CENTRE = { x: 79.84, y: 70.63 };

async function openPlan(page, context, discordId, name, { asAdmin = false } = {}) {
  await loginViaApi(context, discordId, name);
  if (asAdmin) {
    // 権限を上げる導線は UI に作らない（作ると本番にも出る）ので DB を直接触る。
    execD1(`UPDATE users SET role = 'admin' WHERE discord_id = '${discordId}'`);
    const me = await context.request.get(planUrl("/api/me"));
    expect((await me.json()).user.role, "admin に上げられていない").toBe("admin");
  }
  const planId = await createPlan(context, name);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  // マップ座標で位置を指すので、まず全体が見える状態にする。
  await showWholeMap(page);
  return planId;
}

/** カタログの到着を待つ（左の引き出しは1枚だけなので、待たずに開くと畳まれる）。 */
async function openZonePanel(page) {
  await expect(page.locator("#palette .pal-item").first()).toBeAttached();
  const panel = page.locator("#zonepanel");
  if (!(await panel.isVisible())) {
    await page.getByRole("button", { name: "円とマス", exact: true }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * 「円とマス」の引き出しからホットゾーンを選んで置く。
 * **これが本番で使う導線**（引き出し1手 → ボタン1手 → 盤面を押す）。
 */
async function placeHotzone(page, x, y, expected = 1) {
  await openZonePanel(page);
  const button = page.locator("#place-hotzone");
  // 選び直すと解除される（トグル）。置いたあとも選んだままなので、
  // 2個目を置くときに押すと外れてしまう。
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const p = await boardPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
  await expect(page.locator("#hotzones .hz")).toHaveCount(expected);
  await expect(page.locator("#status")).toContainText("ホットゾーン");
}

/** 円の半径を SVG の属性から読む（viewBox はメートルなので、そのまま実寸）。 */
const radiusOf = (locator) => locator.evaluate((el) => Number(el.getAttribute("r")));

/** 円の中心（SVG ユーザー単位 = メートル）。 */
const centreOf = (locator) =>
  locator.evaluate((el) => ({
    x: Number(el.getAttribute("cx")),
    y: Number(el.getAttribute("cy")),
  }));

/** 画面上の直径（CSS px）。線の太さを含めないため getBBox を画面へ写して測る。 */
const screenSpan = (locator) =>
  locator.evaluate((el) => {
    const svg = el.ownerSVGElement;
    const m = svg.getScreenCTM();
    const b = el.getBBox();
    const a = svg.createSVGPoint();
    a.x = b.x; a.y = b.y;
    const c = svg.createSVGPoint();
    c.x = b.x + b.width; c.y = b.y;
    return c.matrixTransform(m).x - a.matrixTransform(m).x;
  });

const viewWidth = (page) =>
  page.locator("#board").evaluate((el) => Number(el.getAttribute("viewBox").split(" ")[2]));

/** 視野が指定の広さ以下になるまで寄る（全体表示の広さは画面の形で変わる）。 */
async function zoomUntil(page, limitM, at = { x: 8000, y: 8000 }) {
  const p = await boardPoint(page, at.x, at.y);
  await page.mouse.move(p.x, p.y);
  for (let i = 0; i < 14 && (await viewWidth(page)) > limitM; i += 1) {
    await page.mouse.wheel(0, -400);
  }
  expect(await viewWidth(page), `視野が ${limitM}m 以下にならない`).toBeLessThanOrEqual(limitM);
}

test.describe("ホットゾーンを置く", () => {
  test("引き出しから2手で置けて、円は実寸 85m、札に「人数×2」が出る", async ({ page, context }) => {
    await openPlan(page, context, "9782", "hz-place");

    // 置く前は1つも無い（空の <g> だけが居る）。
    await expect(page.locator("#hotzones .hz")).toHaveCount(0);

    await placeHotzone(page, 8000, 8000);

    // 円は3枚（面・ハロー・輪）とも同じ実寸。viewBox はメートルなので r がそのまま。
    for (const cls of ["hz-face", "hz-halo", "hz-ring"]) {
      expect(await radiusOf(page.locator(`#hotzones .hz .${cls}`)), cls)
        .toBe(HOTZONE_RADIUS_M);
    }
    // 中心は押した所（y は SVG なので上が 0）。ビューポート座標から
    // メートルへ戻す計算が入るので、1m の中に入っていればよい。
    const at = await centreOf(page.locator("#hotzones .hz-ring"));
    expect(Math.abs(at.x - 8000)).toBeLessThan(1);
    expect(Math.abs(at.y - 8000)).toBeLessThan(1);

    // **「人数2倍」が画面から分かる。** 置いた直後の一言に効果と未検証が出る。
    const status = page.locator("#status");
    await expect(status).toContainText("人数が2倍");
    await expect(status).toContainText("85m");
    await expect(status).toContainText("未検証");

    // 詳細（検視台）にも効果と範囲が出る。
    const detail = page.locator("#placement-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("人数が2倍");
    await expect(detail).toContainText(`半径 ${HOTZONE_RADIUS_M}m`);

    // ピンの中の字は「倍」（同じ形のピンが9種あるので字で見分ける）。
    await expect(page.locator('#placements .pm[data-item-id="mk_hotzone"] .pm-glyph'))
      .toHaveText("倍");

    // 札は寄ったときだけ出す。全体表示では伏せる（円が数 px なので文字だけ浮く）。
    const label = page.locator("#hotzones .hz-label");
    await expect(label).toHaveAttribute("hidden", "");
    await zoomUntil(page, 4000);
    await expect(label).not.toHaveAttribute("hidden", "");
    await expect(page.locator("#hotzones .hz-name")).toHaveText("人数×2");
  });

  test("複数置ける（引き寄せる候補を並べて比べられる）", async ({ page, context }) => {
    await openPlan(page, context, "9783", "hz-many");
    await placeHotzone(page, 7000, 7000, 1);
    await placeHotzone(page, 9000, 7000, 2);
    await placeHotzone(page, 8000, 9000, 3);
    await expect(page.locator("#hotzones .hz")).toHaveCount(3);
    await expect(page.locator('#placements .pm[data-item-id="mk_hotzone"]')).toHaveCount(3);
  });

  test("ズームすると地図と同じ縮尺で伸縮する（実寸であることの確認）", async ({ page, context }) => {
    await openPlan(page, context, "9784", "hz-scale");
    await placeHotzone(page, 8000, 8000);

    const ring = page.locator("#hotzones .hz-ring");
    const before = await screenSpan(ring);
    const viewBefore = await viewWidth(page);

    await zoomUntil(page, viewBefore / 4);
    const after = await screenSpan(ring);
    const viewAfter = await viewWidth(page);

    // 画面上の直径は、視野が狭くなった比のぶんだけ大きくなる（誤差 2% 以内）。
    const expected = before * (viewBefore / viewAfter);
    expect(Math.abs(after - expected) / expected,
      `画面上の直径 ${before.toFixed(1)}px → ${after.toFixed(1)}px（期待 ${expected.toFixed(1)}px）`)
      .toBeLessThan(0.02);
    // 属性としての半径は 85m のまま（伸縮は viewBox だけで起きている）。
    expect(await radiusOf(ring)).toBe(HOTZONE_RADIUS_M);
  });
});

test.describe("動かす・消す・残る", () => {
  test("ドラッグで動かすと円も付いてくる", async ({ page, context }) => {
    await openPlan(page, context, "9785", "hz-move");
    await placeHotzone(page, 8000, 8000);

    const from = await boardPoint(page, 8000, 8000);
    const to = await boardPoint(page, 10000, 9000);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator("#status")).toContainText("動かしました");

    const ring = page.locator("#hotzones .hz-ring");
    const at = await centreOf(ring);
    expect(Math.abs(at.x - 10000)).toBeLessThan(60);
    expect(Math.abs(at.y - 9000)).toBeLessThan(60);
    // 動かしても半径は変わらない（作り直しているので、ここを間違えると 0 になる）。
    expect(await radiusOf(ring)).toBe(HOTZONE_RADIUS_M);

    // 動かした先がリロード後も残る。
    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#hotzones .hz")).toHaveCount(1);
    const again = await centreOf(page.locator("#hotzones .hz-ring"));
    expect(Math.abs(again.x - at.x)).toBeLessThan(1);
    expect(Math.abs(again.y - at.y)).toBeLessThan(1);
  });

  test("消すと円も消える（取り消しでも消える）", async ({ page, context }) => {
    await openPlan(page, context, "9786", "hz-delete");
    await placeHotzone(page, 8000, 8000);

    await page.locator("#placement-delete").click();
    await expect(page.locator("#status")).toContainText("配置を消しました");
    await expect(page.locator("#hotzones .hz")).toHaveCount(0);
    await expect(page.locator('#placements .pm[data-item-id="mk_hotzone"]')).toHaveCount(0);

    // もう一度置いて、棚の「戻す」でも円が残らないことを見る。
    await placeHotzone(page, 7000, 7000);
    await page.getByRole("button", { name: "取り消す" }).click();
    await expect(page.locator("#hotzones .hz")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#placements .pm")).toHaveCount(0);
    await expect(page.locator("#hotzones .hz")).toHaveCount(0);
  });

  test("リロードしても残る（別の人が開いても見える）", async ({ page, context }) => {
    const planId = await openPlan(page, context, "9787", "hz-reload");
    await placeHotzone(page, 8600, 7400);

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#hotzones .hz")).toHaveCount(1);
    expect(await radiusOf(page.locator("#hotzones .hz-ring"))).toBe(HOTZONE_RADIUS_M);

    // 別の人（同じ共有URL）でも見える。消そうとすると断られる。
    await loginViaApi(context, "9788", "hz-other");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#hotzones .hz")).toHaveCount(1);
    await page.locator('#placements .pm[data-item-id="mk_hotzone"]').click();
    await expect(page.locator("#placement-delete")).toBeDisabled();
  });
});

test.describe("コントロールエリアの円と見分けがつく", () => {
  test("同じ画面に出したとき、大きさ・色・線・中心の4つが違う", async ({ page, context }) => {
    await openPlan(page, context, "9789", "hz-vs-zone", { asAdmin: true });

    // コントロールエリアの円（ゲームが決める。半径 500m）を登録して選ぶ。
    const panel = await openZonePanel(page);
    const admin = page.locator("#zone-admin");
    await expect(admin).toBeVisible();
    if (!(await admin.evaluate((el) => el.open))) await admin.locator("> summary").click();
    await page.locator("#zp-key").fill("HzCompare");
    await page.locator("#zp-x").fill(String(ZONE_CENTRE.x));
    await page.locator("#zp-y").fill(String(ZONE_CENTRE.y));
    await page.locator("#zp-save").click();
    const zone = page.locator("#zone-preset .zp:not(.zp-preview)");
    await expect(zone).toHaveCount(1);
    await expect(panel).toBeVisible();

    // その円の中にホットゾーンを置く（**同じ画面に両方居る**状態を作る）。
    const zoneCentreSvg = { x: ZONE_CENTRE.x * 100, y: 16320 - ZONE_CENTRE.y * 100 };
    await placeHotzone(page, zoneCentreSvg.x, zoneCentreSvg.y);

    const zoneRing = page.locator("#zone-preset .zp:not(.zp-preview) .zp-ring");
    const hotRing = page.locator("#hotzones .hz-ring");

    // 1. 大きさ: 500m 対 85m。画面上でも約 5.9 倍の差。
    expect(await radiusOf(zoneRing)).toBe(ZONE_RADIUS_M);
    expect(await radiusOf(hotRing)).toBe(HOTZONE_RADIUS_M);
    const zoneSpan = await screenSpan(zoneRing);
    const hotSpan = await screenSpan(hotRing);
    expect(zoneSpan / hotSpan).toBeGreaterThan(5);

    // 2. 色: ホットゾーンは黄（--hot）、コントロールエリアは無彩色。
    const strokeOf = (l) => l.evaluate((el) => getComputedStyle(el).stroke);
    const hotStroke = await strokeOf(hotRing);
    const zoneStroke = await strokeOf(zoneRing);
    expect(hotStroke).not.toBe(zoneStroke);
    // --hot（#E3B341）は赤が緑より強く、緑が青よりはっきり強い黄色。
    const rgb = (s) => s.match(/\d+/g).map(Number);
    const [hr, hg, hb] = rgb(hotStroke);
    expect(hr).toBeGreaterThan(hb + 60);
    expect(hg).toBeGreaterThan(hb + 30);
    // 無彩色は3成分がほぼ同じ。
    const [zr, zg, zb] = rgb(zoneStroke);
    expect(Math.max(zr, zg, zb) - Math.min(zr, zg, zb)).toBeLessThan(30);

    // 3. 線: ホットゾーンは破線（動くもの・想定）、あちらは実線。
    const dashOf = (l) => l.evaluate((el) => getComputedStyle(el).strokeDasharray);
    expect(await dashOf(hotRing)).toMatch(/\d/);
    expect(["none", ""]).toContain(await dashOf(zoneRing));

    // 4. 中心: ホットゾーンは掴めるピン、コントロールエリアは触れない十字。
    await expect(page.locator('#placements .pm[data-item-id="mk_hotzone"]')).toHaveCount(1);
    await expect(page.locator("#zone-preset .zp-centre")).toHaveCount(1);
    expect(
      await page.locator("#zone-preset").evaluate((el) => getComputedStyle(el).pointerEvents)
    ).toBe("none");
    expect(
      await page.locator("#hotzones").evaluate((el) => getComputedStyle(el).pointerEvents)
    ).toBe("none");

    // **後片付け。** プリセットはマップ静的なので、残すと他のテストの一覧に出る。
    if (!(await admin.evaluate((el) => el.open))) await admin.locator("> summary").click();
    await page.locator("#zp-delete").click();
    await expect(page.locator("#zone-preset .zp")).toHaveCount(0);
  });

  test("「射程を表示」を切ってもホットゾーンの円は消えない（射程ではない）", async ({
    page, context,
  }) => {
    await openPlan(page, context, "9790", "hz-not-range");
    await placeHotzone(page, 8000, 8000);

    await openViewMenu(page);
    await page.locator("#toggle-ranges").click();
    await expect(page.locator("#ranges")).toHaveAttribute("hidden", "");
    await expect(page.locator("#hotzones")).not.toHaveAttribute("hidden", "");
    await expect(page.locator("#hotzones .hz")).toHaveCount(1);
  });
});

test.describe("狭い画面（390px）", () => {
  test("引き出しから2手で置けて、置いたあと盤面が見える", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPlan(page, context, "9791", "hz-narrow");

    await openZonePanel(page);
    // ボタンがスクロールせずに見えること（引き出しの先頭の一画にある）。
    await expect(page.locator("#place-hotzone")).toBeInViewport();
    await page.locator("#place-hotzone").click();

    // 狭い画面では、選んだ時点で引き出しを畳む（置きたい場所を自分で隠さない）。
    await expect(page.locator("#zonepanel")).toBeHidden();

    const p = await boardPoint(page, 8000, 8000);
    await page.mouse.click(p.x, p.y);
    await expect(page.locator("#hotzones .hz")).toHaveCount(1);
    expect(await radiusOf(page.locator("#hotzones .hz-ring"))).toBe(HOTZONE_RADIUS_M);
    await expect(page.locator("#status")).toContainText("人数が2倍");
  });
});
