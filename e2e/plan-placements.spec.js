// /plan の建造物パレットと配置、そして射程リングの UIテスト。
//
// ここで一番大事なのは「射程リングが実寸で出ているか」。viewBox はメートルなので、
// SVG の `r` がそのまま射程のメートル値になっているはず（L81 迫撃砲なら 684）。
// 画面上の半径も測って、ズームしても地図と同じ縮尺で伸縮することまで見る。
import { test, expect } from "@playwright/test";

import {
  boardPoint, chooseOption, choiceOptions, chosenValue, coverViewBox, createPlan,
  fitViewBox, loginViaApi, mapSizeM, openViewMenu, planUrl, showWholeMap, usePen,
} from "./plan-helpers.js";


/** MetaForge Artillery Tool の値（schema.sql）。UI はこれを実寸で描く。 */
const L81_MIN_M = 80;
const L81_MAX_M = 684;
/** FOB の建築範囲の暫定値（中心から±60m）。一辺は未確認。 */
const FOB_SIDE_M = 120;

async function openPlan(page, context, discordId, name) {
  await loginViaApi(context, discordId, name);
  const planId = await createPlan(context, name);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  // マップ座標で位置を指すので、まずマップ全体が見える状態にする
  // （開いた直後は地図が画面を埋めていて、外周は画面の外にいる）。
  await showWholeMap(page);
  return planId;
}

/**
 * パレットを開いた状態にする。
 *
 * 既定の開閉（広い画面は開く）はカタログが届いてから決まるので、中身が入る前に
 * 押すと「今の状態」を読み違える。先に中身が入るのを待ってから見る。
 */
async function openPalette(page) {
  const palette = page.locator("#palette");
  await expect(palette.locator(".pal-item").first()).toBeAttached();
  if (!(await palette.isVisible())) {
    await page.getByRole("button", { name: "建造物" }).click();
  }
  await expect(palette).toBeVisible();
  return palette;
}

/** パレットを畳んだ状態にする（盤面の左端を素で触りたいとき）。 */
async function closePalette(page) {
  const palette = page.locator("#palette");
  await expect(palette.locator(".pal-item").first()).toBeAttached();
  if (await palette.isVisible()) {
    await page.getByRole("button", { name: "建造物" }).click();
  }
  await expect(palette).toBeHidden();
}

/** パレットを開いて、種別の折りたたみを開いて、項目を選ぶ。 */
async function pickItem(page, kind, itemId) {
  const palette = await openPalette(page);
  const group = palette.locator(`.pal-group[data-kind="${kind}"]`);
  // `open` は属性だと空文字（= falsy）になるので、プロパティで見る。
  if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
  const item = palette.locator(`.pal-item[data-item-id="${itemId}"]`);
  // 選び直すと解除される（トグル）ので、既に選んでいるときは押さない。
  if ((await item.getAttribute("aria-pressed")) !== "true") await item.click();
  await expect(item).toHaveAttribute("aria-pressed", "true");
}

/**
 * 項目を選んで置き、保存が終わるまで待つ。
 *
 * (x, y) は SVG ユーザー単位（= メートル。ただし y はマップの上端が 0）。
 * boardPoint と同じ座標系なので、描かれた要素の座標もそのままこの値になる。
 */
async function placeItem(page, kind, itemId, x, y) {
  await pickItem(page, kind, itemId);
  const markers = page.locator("#placements .pm");
  const before = await markers.count();
  const p = await boardPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
  await expect(markers).toHaveCount(before + 1);
  // 「置きました」は POST が返ってから出る。固定待ちの代わりにこれを待つ。
  await expect(page.locator("#status")).toContainText("を置きました");
}

/**
 * SVG 図形の横幅を CSS px で測る。
 *
 * `getBoundingClientRect()` は線の太さ（non-scaling-stroke の 2〜3px）を含んでしまい、
 * 120m の正方形のように小さい図形では誤差が図形そのものより大きくなる。
 * getBBox（= 線を含まない図形の寸法）を getScreenCTM で画面へ写して測る。
 */
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

/** マーカーは <g> の scale で伸縮するので、こちらは画面上の矩形をそのまま測る。 */
const screenWidth = (locator) =>
  locator.evaluate((el) => el.getBoundingClientRect().width);

/** マーカーの中心（SVG ユーザー単位 = メートル）。transform から読む。 */
const markerAt = (locator) =>
  locator.evaluate((el) => {
    const m = el.getAttribute("transform").match(/translate\(([-\d.]+) ([-\d.]+)\)/);
    return { x: Number(m[1]), y: Number(m[2]) };
  });

/** 今の viewBox を数値で返す。パンしたかどうかの判定に使う。 */
const viewBoxOf = (page) =>
  page.locator("#board").evaluate((el) => {
    const [x, y, w, h] = el.getAttribute("viewBox").split(" ").map(Number);
    return { x, y, w, h };
  });

/**
 * 全体表示だとパンしても clampView で端に戻る（マップが画面より狭いため）ので、
 * パンの検証をする前に寄っておく。
 */
async function zoomIn(page, x, y, ticks = -600) {
  const c = await boardPoint(page, x, y);
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, ticks);
  await expect(page.locator("#board")).not.toHaveAttribute("viewBox", await coverViewBox(page));
}

/** 押して、動かして、離す。`steps` を刻まないとパンの判定に届かない。 */
async function dragBy(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
}

test.describe("建造物パレット", () => {
  test("種別ごとに項目が並び、コストと射程と未検証バッジが出る", async ({ page, context }) => {
    await openPlan(page, context, "9200", "palette");

    // 広い画面（1280px）なので最初から開いている。畳んで開き直せることも見る。
    const palette = page.locator("#palette");
    await expect(palette).toBeVisible();
    await page.getByRole("button", { name: "建造物" }).click();
    await expect(palette).toBeHidden();
    await page.getByRole("button", { name: "建造物" }).click();
    await expect(palette).toBeVisible();
    await expect(page.getByRole("button", { name: "建造物" })).toHaveAttribute("aria-pressed", "true");

    // 試合の要素 / 構造物 / 設置物 / 車輌 の4種別。57項目あるので畳めること。
    await expect(palette.locator(".pal-group")).toHaveCount(4);
    for (const kind of ["objective", "structure", "emplacement", "vehicle"]) {
      await expect(palette.locator(`.pal-group[data-kind="${kind}"]`)).toHaveCount(1);
    }
    // 種別不明の受け皿（.pal-group[data-kind="other"]）に落ちているものが無いこと。
    await expect(palette.locator('.pal-group[data-kind="other"]')).toHaveCount(0);
    // 先頭の種別だけ開いた状態で始まる（全部開くとマップを覆う）。
    expect(await palette.locator('.pal-group[data-kind="objective"]').evaluate((el) => el.open)).toBe(true);
    expect(await palette.locator('.pal-group[data-kind="structure"]').evaluate((el) => el.open)).toBe(false);
    expect(await palette.locator('.pal-group[data-kind="vehicle"]').evaluate((el) => el.open)).toBe(false);

    // カタログはゲームデータ48項目 + 試合の要素9項目。畳まれていても DOM には全部ある。
    await expect(palette.locator(".pal-item")).toHaveCount(57);
    await expect(palette.locator('.pal-group[data-kind="objective"] .pal-item')).toHaveCount(9);
    // ホットゾーン（人数2倍。D-052）は試合の要素の先頭に出る（sort_order 0）。
    await expect(palette.locator('.pal-group[data-kind="objective"] .pal-item').first())
      .toHaveAttribute("data-item-id", "mk_hotzone");

    // 未検証のバッジ。ゲームデータ由来の48項目は verified=0 なので全部に出る。
    // 試合の要素は測定値ではない（verified=1）ので出ない。
    // ホットゾーンの半径 85m が未検証であることは、カタログの列ではなく
    // 置いた直後の一言と詳細パネルで言う（plan-hotzones.spec.js）。
    await expect(palette.locator(".pal-item .unv")).toHaveCount(48);
    await expect(palette.locator('.pal-group[data-kind="objective"] .unv')).toHaveCount(0);
    await expect(palette.locator('.pal-item[data-item-id="fob"] .unv')).toHaveText("未検証");

    // コストと射程が項目ごとに読める。
    const fob = palette.locator('.pal-item[data-item-id="fob"]');
    await expect(fob).toContainText("物資 30");
    await expect(fob).toContainText("射程不明"); // 射程データが無いものは「不明」と書く

    await palette.locator('.pal-group[data-kind="emplacement"] summary').click();
    const mortar = palette.locator('.pal-item[data-item-id="mortar_l81"]');
    await expect(mortar).toContainText("物資 121");
    await expect(mortar).toContainText(`射程 ${L81_MIN_M}–${L81_MAX_M}m`);

    // コストが出典間で食い違っていて NULL のままの項目は「不明」と出す（0 で誤魔化さない）。
    await expect(palette.locator('.pal-item[data-item-id="talon_9k_sam"]')).toContainText("コスト不明");
  });

  // 置く作業のたびに開き直さなくて済むよう、広い画面では最初から開けておく。
  // 狭い画面（390px）で常設すると地図が見えなくなるので、そちらは従来どおり。
  test("広い画面では最初から開いていて、畳んだらリロードしても畳まれたまま", async ({ page, context }) => {
    await openPlan(page, context, "9242", "palette-default");

    const palette = page.locator("#palette");
    const toggle = page.getByRole("button", { name: "建造物" });
    await expect(palette).toBeVisible();
    // 常設なのにボタンが「押していない」ままだと嘘になる。
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // 常設でも畳める手段は残す。
    await palette.locator(".close").click();
    await expect(palette).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    // 畳んだことを覚えている（毎回畳み直させない）。
    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#palette")).toBeHidden();
    await expect(page.getByRole("button", { name: "建造物" }))
      .toHaveAttribute("aria-pressed", "false");

    // 開き直したら、その状態も覚えている。
    await page.getByRole("button", { name: "建造物" }).click();
    await expect(page.locator("#palette")).toBeVisible();
    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#palette")).toBeVisible();
  });

  test("狭い画面では従来どおり畳んだまま始まる", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPlan(page, context, "9243", "palette-narrow-default");

    const palette = page.locator("#palette");
    await expect(palette).toBeHidden();
    await expect(page.getByRole("button", { name: "建造物" }))
      .toHaveAttribute("aria-pressed", "false");

    // 開いたら盤面の上に浮く（従来どおり）。
    await page.getByRole("button", { name: "建造物" }).click();
    await expect(palette).toBeVisible();
    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    // 狭い画面でも、自分で開けた状態は覚えている。
    await expect(page.locator("#palette")).toBeVisible();
  });

  test("パレットを開いてもマップは押し出されない", async ({ page, context }) => {
    await openPlan(page, context, "9240", "palette-layout");
    const viewport = page.viewportSize();

    // 常設（既定で開いている）ので、比べる前に一度畳んでおく。
    await expect(page.locator("#palette")).toBeVisible();
    await page.getByRole("button", { name: "建造物" }).click();
    await expect(page.locator("#palette")).toBeHidden();
    const before = await page.locator("#board").boundingBox();

    await page.getByRole("button", { name: "建造物" }).click();
    await expect(page.locator("#palette")).toBeVisible();

    const after = await page.locator("#board").boundingBox();
    expect(after.width).toBeCloseTo(before.width, 0);
    expect(after.height).toBeCloseTo(before.height, 0);
    expect(after.height / viewport.height).toBeGreaterThan(0.6);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  // カタログは56件ある。全部開くと必ずパネルの高さを超えるので、超えたぶんは
  // 切り落とさずスクロールさせなければならない。届かない項目は無いのと同じ。
  // 「スクロールできる」ではなく「一番下の項目が実際に押せる」で確かめる。
  test("種別を全部開いても、一番下の項目まで届いて押せる", async ({ page, context }) => {
    await openPlan(page, context, "9241", "palette-scroll");

    const sizes = [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
    ];
    for (const size of sizes) {
      const tag = `${size.width}x${size.height}`;
      await page.setViewportSize(size);

      // 既定の開閉はカタログが届いてから決まる。中身を待たずに状態を読むと、
      // 「閉じている」と読んだ直後に自動で開き、押した結果が反対になる。
      // その待ちは openPalette が持っているので、ここで書き直さない。
      const palette = await openPalette(page);

      for (const kind of ["objective", "structure", "emplacement", "vehicle"]) {
        const group = palette.locator(`.pal-group[data-kind="${kind}"]`);
        if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
      }
      const items = palette.locator(".pal-item");
      await expect(items).toHaveCount(57);

      // 57件はどの画面幅でもパネルより高い。高さが足りているなら
      // このテストは何も守っていないので、前提として確かめておく。
      const box = await palette.evaluate((el) => ({ h: el.scrollHeight, c: el.clientHeight }));
      expect(box.h, `${tag}: 57件はパネルの高さを超える`).toBeGreaterThan(box.c);

      const last = items.last();
      await last.scrollIntoViewIfNeeded();
      const pb = await palette.boundingBox();
      const lb = await last.boundingBox();
      expect(lb.y + lb.height, `${tag}: 一番下の項目がパネルの中に出る`)
        .toBeLessThanOrEqual(pb.y + pb.height + 1);

      await last.click();
      await expect(last, `${tag}: 一番下の項目が選べる`).toHaveAttribute("aria-pressed", "true");
      // 次の画面幅に選択を持ち越さない（狭い画面では選ぶとパレットが畳まれる）。
      await page.keyboard.press("Escape");
    }
  });
});

// 試合の要素（ドリル位置・HQ・スポーン・敵FOB と、判断を書き込む記号）。
// 新テーブルも新ルートも作らず、catalog_items に kind='objective' の行を足して
// 既存の配置のしくみ（置く・選ぶ・動かす・消す）にそのまま相乗りさせている（設計書 §3-A-2）。
test.describe("試合の要素", () => {
  test("パレットの先頭グループで、開いた瞬間にドリル位置と HQ が見える", async ({ page, context }) => {
    await openPlan(page, context, "9290", "objective-palette");

    const palette = await openPalette(page);

    // 先頭グループであること（DOM の順序で見る）。
    const first = palette.locator(".pal-group").first();
    await expect(first).toHaveAttribute("data-kind", "objective");
    await expect(first.locator("summary")).toContainText("試合の要素");
    // 開いているので、折りたたみを触らずにそのまま押せる。
    await expect(palette.locator('.pal-item[data-item-id="mk_drill"]')).toBeVisible();
    await expect(palette.locator('.pal-item[data-item-id="mk_hq"]')).toBeVisible();
    await expect(palette.locator('.pal-item[data-item-id="mk_drill"] .nm')).toHaveText("ドリル位置");
  });

  test("コストと射程の行を出さない（測定値を持たないので「不明」も書かない）", async ({ page, context }) => {
    await openPlan(page, context, "9291", "objective-nometa");
    await placeItem(page, "objective", "mk_drill", 6000, 6000);

    // パレット側。
    const palItem = page.locator('#palette .pal-item[data-item-id="mk_drill"]');
    await expect(palItem).not.toContainText("コスト");
    await expect(palItem).not.toContainText("射程");
    await expect(palItem.locator(".cost")).toHaveCount(0);
    await expect(palItem.locator(".rg")).toHaveCount(0);

    // 詳細パネル側。名前・種別・位置・出典は出るが、コストと射程の行は無い。
    const detail = page.locator("#placement-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator("h2")).toHaveText("ドリル位置");
    await expect(detail).toContainText("試合の要素");
    await expect(detail).toContainText("出典:");
    await expect(detail).not.toContainText("コスト");
    await expect(detail).not.toContainText("射程");
    // 未検証バッジも出ない（作図用の記号であって測定値ではないため）。
    await expect(detail.locator(".unv")).toHaveCount(0);
    // 建造物のほうは今までどおりコストが出る（消し過ぎていないことの確認）。
    await expect(page.locator('#palette .pal-item[data-item-id="fob"]')).toContainText("物資 30");
  });

  test("置くとピン形のマーカーが出て、既存のハロー・名前・選択にそのまま乗る", async ({ page, context }) => {
    await openPlan(page, context, "9292", "objective-marker");
    await placeItem(page, "objective", "mk_drill", 6000, 6000);

    const marker = page.locator('#placements .pm[data-item-id="mk_drill"]');
    await expect(marker).toHaveAttribute("data-kind", "objective");
    // 形はピン（しずく型）。四角・三角・丸のどれでもない＝建てるものではない。
    await expect(marker.locator("path.pm-shape")).toHaveCount(1);
    await expect(marker.locator("rect.pm-shape, polygon.pm-shape, circle.pm-shape")).toHaveCount(0);
    // グリフで何のピンかが分かる。
    await expect(marker.locator(".pm-glyph")).toHaveText("D");

    // 既存のしくみに乗っていること。ハローも同じ形で敷かれ、当たり判定は増やさない。
    await expect(marker.locator("path.pm-halo")).toHaveCount(1);
    expect(
      await marker.locator(".pm-halo").evaluate((el) => getComputedStyle(el).pointerEvents)
    ).toBe("none");
    // 置いた直後は選ばれていて、名前が出ている。
    await expect(marker).toHaveClass(/\bsel\b/);
    await expect(marker.locator(".pm-label")).toHaveText("ドリル位置");
    await expect(marker.locator(".pm-label")).toBeVisible();
    // 射程データを持たないのでリングは描かない。
    await expect(page.locator("#ranges .rng")).toHaveCount(0);

    // 建造物は四角のまま（形で別物だと分かる）。
    await placeItem(page, "structure", "bunker", 9000, 9000);
    await expect(page.locator('#placements .pm[data-item-id="bunker"] rect.pm-shape')).toHaveCount(1);

    // ホバーで名前が出るのも既存と同じ。
    await page.locator("#placement-detail .close").click();
    await expect(marker.locator(".pm-label")).toBeHidden();
    const at = await boardPoint(page, 6000, 6000);
    await page.mouse.move(at.x, at.y);
    await expect(marker.locator(".pm-label")).toBeVisible();

    // リロードしても残る（既存の placements API にそのまま乗っている）。
    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator('#placements .pm[data-item-id="mk_drill"] path.pm-shape')).toHaveCount(1);
    await expect(page.locator('#placements .pm[data-item-id="mk_drill"] .pm-glyph')).toHaveText("D");
  });

  test("記号ごとに色が変わる（既存トークンの割り当てだけ）", async ({ page, context }) => {
    await openPlan(page, context, "9293", "objective-colors");
    await placeItem(page, "objective", "mk_drill", 4000, 4000);
    await placeItem(page, "objective", "mk_hq", 6000, 4000);
    await placeItem(page, "objective", "mk_enemy_fob", 8000, 4000);

    const fillOf = (itemId) =>
      page.locator(`#placements .pm[data-item-id="${itemId}"] .pm-shape`)
        .evaluate((el) => getComputedStyle(el).fill);
    const fills = [await fillOf("mk_drill"), await fillOf("mk_hq"), await fillOf("mk_enemy_fob")];
    expect(new Set(fills).size, `色が重複している: ${fills}`).toBe(3);
    // 形が同じピンなので、グリフでも区別できていること（色だけに頼らない）。
    await expect(page.locator('#placements .pm[data-item-id="mk_hq"] .pm-glyph')).toHaveText("H");
    await expect(page.locator('#placements .pm[data-item-id="mk_enemy_fob"] .pm-glyph')).toHaveText("F");
  });
});

test.describe("配置", () => {
  test("パレットで選んでマップを押すと置け、リロードしても残る", async ({ page, context }) => {
    await openPlan(page, context, "9210", "place");

    await placeItem(page, "structure", "bunker", 5000, 5000);
    const marker = page.locator("#placements .pm");
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAttribute("data-kind", "structure");
    await expect(marker).toHaveAttribute("data-item-id", "bunker");
    // 保存できた配置にはサーバの id が入る。
    await expect(marker).toHaveAttribute("data-placement-id", /^\d+$/);

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#placements .pm")).toHaveCount(1);

    // 置いた場所に戻っている（マーカーは画面基準の大きさなので中心で見る）。
    const at = await page.locator("#placements .pm").evaluate((el) => {
      const m = el.getAttribute("transform").match(/translate\(([-\d.]+) ([-\d.]+)\)/);
      return { x: Number(m[1]), y: Number(m[2]) };
    });
    expect(Math.abs(at.x - 5000)).toBeLessThan(40);
    expect(Math.abs(at.y - 5000)).toBeLessThan(40);
  });

  test("マーカーは種別ごとに形が違い、ズームしても画面上の大きさが変わらない", async ({ page, context }) => {
    await openPlan(page, context, "9211", "marker-shape");

    await placeItem(page, "structure", "bunker", 4000, 4000);
    await placeItem(page, "emplacement", "stingray", 6000, 4000);
    await placeItem(page, "vehicle", "humvee", 8000, 4000);

    // 色ではなく形で見分ける。
    await expect(page.locator('#placements .pm[data-kind="structure"] rect.pm-shape')).toHaveCount(1);
    await expect(page.locator('#placements .pm[data-kind="emplacement"] polygon.pm-shape')).toHaveCount(1);
    await expect(page.locator('#placements .pm[data-kind="vehicle"] circle.pm-shape')).toHaveCount(1);

    const shape = page.locator('#placements .pm[data-kind="vehicle"] circle.pm-shape');
    const fit = await screenWidth(shape);
    // 全体表示（16km）でも点にならない大きさであること。
    expect(fit).toBeGreaterThan(8);

    const c = await boardPoint(page, 8000, 4000);
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, -800);
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", await coverViewBox(page));

    // 実寸ではなく画面基準なので、寄っても大きさは変わらない。
    expect(Math.abs((await screenWidth(shape)) - fit)).toBeLessThan(1.5);
  });

  test("マップの外を押しても置かれない", async ({ page, context }) => {
    await openPlan(page, context, "9212", "outside-place");
    await pickItem(page, "structure", "bunker");

    // 盤面の右端とマップの右端の間（レターボックス＝マップ外）を狙う。
    // 左側はパレットが重なっているので、押してもパレットに当たってしまう。
    const box = await page.locator("#board").boundingBox();
    const mapRight = await boardPoint(page, (await mapSizeM(page)).w, 8000);
    expect(box.x + box.width - mapRight.x, "盤面の右に余白があること").toBeGreaterThan(40);
    await page.mouse.click((mapRight.x + box.x + box.width) / 2, mapRight.y);

    await expect(page.locator("#status")).toContainText("マップの外です");
    await expect(page.locator("#placements .pm")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#placements .pm")).toHaveCount(0);
  });

  test("配置を選ぶと詳細が出て、削除できる", async ({ page, context }) => {
    await openPlan(page, context, "9213", "detail-delete");
    await placeItem(page, "emplacement", "mortar_l81", 7500, 7500);

    // 置いた直後は選ばれている。詳細に名前・コスト・射程・出典・検証状態が出る。
    const detail = page.locator("#placement-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator("h2")).toHaveText("L81 迫撃砲");
    await expect(detail).toContainText("物資 121");
    await expect(detail).toContainText(`射程 ${L81_MIN_M}–${L81_MAX_M}m`);
    await expect(detail).toContainText("出典:");
    await expect(detail.locator(".unv")).toHaveText("未検証");

    // 閉じて、マーカーを押し直すと選び直せる。
    await detail.locator(".close").click();
    await expect(detail).toBeHidden();
    await page.locator("#placements .pm").click();
    await expect(detail).toBeVisible();

    const del = page.locator("#placement-delete");
    await expect(del).toBeEnabled();
    await del.click();
    await expect(page.locator("#placements .pm")).toHaveCount(0);
    await expect(page.locator("#ranges .rng")).toHaveCount(0);
    await expect(detail).toBeHidden();

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#placements .pm")).toHaveCount(0);
  });

  test("他の人の配置は消せないことがUIで分かる", async ({ page, context }) => {
    // 置いた本人（9214）のセッションに、別の人（9215）としてアクセスする。
    await loginViaApi(context, "9214", "owner");
    const planId = await createPlan(context, "shared-plan");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await placeItem(page, "structure", "bunker", 6000, 6000);

    await loginViaApi(context, "9215", "visitor");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#placements .pm")).toHaveCount(1);
    await page.locator("#placements .pm").click();

    const del = page.locator("#placement-delete");
    await expect(del).toBeDisabled();
    await expect(del).toHaveAttribute("title", /他の人の配置は消せません/);
    await expect(page.locator("#placements .pm")).toHaveCount(1);
  });

  test("配置が0件でもページは壊れない", async ({ page, context }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e));
    await openPlan(page, context, "9216", "empty");

    await expect(page.locator("#placements .pm")).toHaveCount(0);
    await expect(page.locator("#ranges .rng")).toHaveCount(0);
    await expect(page.locator("#placement-detail")).toBeHidden();
    await expect(page.locator("#status")).toHaveText("");

    // パレットも射程トグルも普通に動く。
    await openPalette(page);
    await openViewMenu(page);
    await page.getByRole("button", { name: "射程を表示" }).click();
    await expect(page.getByRole("button", { name: "射程を表示" })).toHaveAttribute("aria-pressed", "false");
    expect(errors).toEqual([]);
  });

  test("カタログの読み込みが遅くても、その間に出した案内を消さない", async ({ page, context }) => {
    // カタログと配置の取得はマップより後に走る。その取得が終わったときに
    // #status を無条件で空にすると、読み込み中にユーザーが操作して出た案内
    // （「マップの外です」など）が、本人が読む前に消えてしまう。
    // 実機では一瞬なので、わざと遅らせて再現させる。
    await loginViaApi(context, "9241", "slow-catalog");
    const planId = await createPlan(context, "slow-catalog");
    await page.route("**/api/catalog", async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });
    // 読み込みの終わりを掴むため、goto より先に待ち受けておく（後から登録すると
    // 既に返り終わっていて永久に待つことがある）。
    const placementsLoaded = page.waitForResponse(
      (r) => r.url().includes("/placements") && r.request().method() === "GET"
    );
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    // 線が引ける（= setEditable(true) 済み）が、カタログはまだ来ていない状態。
    await expect(page.locator("#tool-pen")).toBeEnabled();
    await expect(page.locator("#palette .pal-item")).toHaveCount(0);

    // 盤面の左のマップ外から引き始める。**全体表示にしないとマップ外が見えない**
    // （開いた直後は地図が画面を埋めている）。
    await showWholeMap(page);
    const box = await page.locator("#board").boundingBox();
    // **高さは真ん中あたりを選ぶ。** 枠は地図の上に浮いているので、
    // 上端近く（SVG y=1000）は左上の板に覆われていて盤面に届かない。
    const mapLeft = await boardPoint(page, 0, 8000);
    expect(mapLeft.x - box.x, "盤面の左に余白があること").toBeGreaterThan(40);
    const outsideX = (box.x + mapLeft.x) / 2;
    // 既定の道具は「移動」。線として扱わせるにはペンを選ぶ。
    await usePen(page);
    await page.mouse.move(outsideX, mapLeft.y);
    await page.mouse.down();
    await page.mouse.move(outsideX + 20, mapLeft.y + 40, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator("#status")).toContainText("マップの外です");

    // カタログと配置が届いて読み込みが終わっても、案内は残っている。
    await expect(page.locator("#palette .pal-item")).toHaveCount(57);
    await placementsLoaded;
    // 取得の直後に走る後始末（#status を空にする処理）を確実に通り越すための猶予。
    await page.waitForTimeout(300);
    await expect(page.locator("#status")).toContainText("マップの外です");
  });
});

// オーナーが本番で使って出た不具合の回帰テスト。
//   1. マップを動かしたいのに、項目を選んでいるとクリックが全部「置く」になる
//   2. 置いたものを動かせない（消して置き直すしかない）
//   3. 「取り消す」がインクにしか効かない／選択を外す手段が無い
test.describe("配置モードでの盤面操作", () => {
  test("項目を選んでいてもドラッグはパン。配置は増えない", async ({ page, context }) => {
    await openPlan(page, context, "9250", "drag-pans");
    await pickItem(page, "structure", "bunker");
    await zoomIn(page, 8000, 8000);

    const before = await viewBoxOf(page);
    const from = await boardPoint(page, 8000, 8000);
    await dragBy(page, from, -160, -80);

    const after = await viewBoxOf(page);
    expect(Math.abs(after.x - before.x), "横にパンしている").toBeGreaterThan(1);
    expect(Math.abs(after.y - before.y), "縦にパンしている").toBeGreaterThan(1);
    // ここが本題。ドラッグで置かれてはいけない。
    await expect(page.locator("#placements .pm")).toHaveCount(0);
    await expect(page.locator("#status")).not.toContainText("を置きました");

    // サーバにも行っていない（リロードしても無い）。
    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#placements .pm")).toHaveCount(0);
  });

  test("ドラッグでパンしたあとでも、クリックすれば置ける", async ({ page, context }) => {
    await openPlan(page, context, "9251", "drag-then-click");
    await pickItem(page, "structure", "bunker");
    await zoomIn(page, 8000, 8000);

    const from = await boardPoint(page, 8000, 8000);
    await dragBy(page, from, -120, 0);
    await expect(page.locator("#placements .pm")).toHaveCount(0);

    // 選択は外れていない（パンしただけ）。押せばそのまま置ける。
    await expect(
      page.locator('#palette .pal-item[data-item-id="bunker"]')
    ).toHaveAttribute("aria-pressed", "true");
    const at = await boardPoint(page, 8000, 8000);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator("#placements .pm")).toHaveCount(1);
    await expect(page.locator("#status")).toContainText("を置きました");
  });

  test("Esc でパレットの選択が外れて移動に戻る", async ({ page, context }) => {
    await openPlan(page, context, "9252", "esc-clears-pick");
    await pickItem(page, "structure", "bunker");
    await expect(page.locator("#board")).toHaveAttribute("data-mode", "place");

    await page.keyboard.press("Escape");
    await expect(
      page.locator('#palette .pal-item[data-item-id="bunker"]')
    ).toHaveAttribute("aria-pressed", "false");
    // 道具を外したら既定の「移動」に戻る。
    await expect(page.locator("#board")).toHaveAttribute("data-mode", "pan");
    await expect(page.locator("#tool-pan")).toHaveAttribute("aria-pressed", "true");

    // 外したあとに押しても置かれない。
    const at = await boardPoint(page, 7000, 7000);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator("#placements .pm")).toHaveCount(0);
  });
});

test.describe("置いたものを動かす", () => {
  test("マーカーをドラッグすると動き、リロードしても新しい位置に残る", async ({ page, context }) => {
    await openPlan(page, context, "9260", "move-marker");
    await placeItem(page, "emplacement", "mortar_l81", 5000, 5000);

    const marker = page.locator("#placements .pm");
    const from = await boardPoint(page, 5000, 5000);
    const to = await boardPoint(page, 9000, 6500);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator("#status")).toContainText("動かしました");
    const moved = await markerAt(marker);
    expect(Math.abs(moved.x - 9000)).toBeLessThan(60);
    expect(Math.abs(moved.y - 6500)).toBeLessThan(60);
    // 射程リングも一緒に動く（中心が置き去りにならない）。
    await expect(page.locator("#ranges circle.rng-max")).toHaveAttribute("cy", /^6[45]\d\d/);

    // マップは動いていない（マーカーの移動であってパンではない）。
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await fitViewBox(page));

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#placements .pm")).toHaveCount(1);
    const after = await markerAt(page.locator("#placements .pm"));
    expect(Math.abs(after.x - 9000)).toBeLessThan(60);
    expect(Math.abs(after.y - 6500)).toBeLessThan(60);
  });

  test("マーカーを押しただけ（動かさず離す）なら選ぶだけ", async ({ page, context }) => {
    await openPlan(page, context, "9261", "tap-marker");
    await placeItem(page, "structure", "bunker", 5000, 5000);
    const marker = page.locator("#placements .pm");
    const before = await markerAt(marker);

    await page.locator("#placement-detail .close").click();
    await marker.click();
    await expect(page.locator("#placement-detail")).toBeVisible();
    expect(await markerAt(marker)).toEqual(before);
    await expect(page.locator("#status")).not.toContainText("動かしました");
  });

  test("他の人の配置は動かせない（PATCH を投げない）", async ({ page, context }) => {
    await loginViaApi(context, "9262", "move-owner");
    const planId = await createPlan(context, "move-shared");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await placeItem(page, "structure", "bunker", 6000, 6000);

    await loginViaApi(context, "9263", "move-visitor");
    const patches = [];
    page.on("request", (r) => { if (r.method() === "PATCH") patches.push(r.url()); });
    await page.goto(planUrl(`/plan?id=${planId}`));
    const marker = page.locator("#placements .pm");
    await expect(marker).toHaveCount(1);
    const before = await markerAt(marker);

    const from = await boardPoint(page, 6000, 6000);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 150, from.y + 90, { steps: 12 });
    await page.mouse.up();

    expect(await markerAt(marker), "他人の配置は動かない").toEqual(before);
    expect(patches, "PATCH を投げていない").toEqual([]);

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    expect(await markerAt(page.locator("#placements .pm"))).toEqual(before);
  });

  test("マップの外へ落とすと元の位置に戻り、理由が出る", async ({ page, context }) => {
    await openPlan(page, context, "9264", "move-outside");
    await placeItem(page, "structure", "bunker", 15000, 8000);
    const marker = page.locator("#placements .pm");
    const before = await markerAt(marker);

    // 盤面の右のレターボックス（マップ外）へ落とす。
    const box = await page.locator("#board").boundingBox();
    const mapRight = await boardPoint(page, (await mapSizeM(page)).w, 8000);
    expect(box.x + box.width - mapRight.x, "盤面の右に余白があること").toBeGreaterThan(40);
    const from = await boardPoint(page, 15000, 8000);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((mapRight.x + box.x + box.width) / 2, from.y, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator("#status")).toContainText("マップの外です");
    expect(await markerAt(marker), "元の位置に戻る").toEqual(before);

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    expect(await markerAt(page.locator("#placements .pm"))).toEqual(before);
  });
});

test.describe("取り消す", () => {
  test("直前の配置を取り消せる", async ({ page, context }) => {
    await openPlan(page, context, "9270", "undo-place");
    await placeItem(page, "structure", "bunker", 4000, 4000);
    await placeItem(page, "vehicle", "humvee", 6000, 6000);
    await expect(page.locator("#placements .pm")).toHaveCount(2);

    await page.getByRole("button", { name: "取り消す" }).click();
    await expect(page.locator("#status")).toContainText("取り消しました");
    await expect(page.locator("#placements .pm")).toHaveCount(1);
    await expect(page.locator('#placements .pm[data-item-id="bunker"]')).toHaveCount(1);

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#placements .pm")).toHaveCount(1);
    await expect(page.locator('#placements .pm[data-item-id="bunker"]')).toHaveCount(1);
  });

  test("線と配置を操作した順に取り消せる", async ({ page, context }) => {
    await openPlan(page, context, "9271", "undo-order");

    // 先に線を引く（既定は「移動」なのでペンを選んでから）。
    await usePen(page);
    const a = await boardPoint(page, 3000, 3000);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 120, a.y + 60, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator("#ink path")).toHaveCount(1);
    await expect(page.locator("#status")).toContainText("保存しました");

    // そのあとに置く。
    await placeItem(page, "structure", "bunker", 9000, 9000);

    // 1回目の取り消しは「あとにやった配置」が消える。線は残る。
    await page.getByRole("button", { name: "取り消す" }).click();
    await expect(page.locator("#placements .pm")).toHaveCount(0);
    await expect(page.locator("#ink path")).toHaveCount(1);

    // 2回目で線が消える。
    await page.getByRole("button", { name: "取り消す" }).click();
    await expect(page.locator("#ink path")).toHaveCount(0);
  });
});

test.describe("マーカーの見分けやすさ", () => {
  test("種別ごとに形と色が変わり、背景から浮かせるハローが付く", async ({ page, context }) => {
    await openPlan(page, context, "9280", "marker-legibility");
    await placeItem(page, "structure", "bunker", 4000, 4000);
    await placeItem(page, "emplacement", "stingray", 6000, 4000);
    await placeItem(page, "vehicle", "humvee", 8000, 4000);

    // 形（既存の担保）に加えて、塗りの色も種別ごとに違う（二重符号化）。
    const fillOf = (kind) =>
      page.locator(`#placements .pm[data-kind="${kind}"] .pm-shape`)
        .evaluate((el) => getComputedStyle(el).fill);
    const fills = [await fillOf("structure"), await fillOf("emplacement"), await fillOf("vehicle")];
    expect(new Set(fills).size, `色が重複している: ${fills}`).toBe(3);

    // 背景（モノクロ航空写真）に埋もれないよう、外側にページ背景色のハローを回す。
    await expect(page.locator("#placements .pm .pm-halo")).toHaveCount(3);
    const halo = await page.locator('#placements .pm[data-kind="vehicle"] .pm-halo')
      .evaluate((el) => {
        const s = getComputedStyle(el);
        // strokeWidth は "6px" のような文字列で返る。
        return { stroke: s.stroke, width: parseFloat(s.strokeWidth) };
      });
    const panel = await page.evaluate(
      () => getComputedStyle(document.getElementById("placements")).getPropertyValue("--panel").trim()
    );
    expect(panel, "--panel トークンを使っている").not.toBe("");
    expect(halo.width, "ハローは図形の線より太い").toBeGreaterThan(3);

    // ハローは当たり判定を増やさない（マーカーの選択が甘くならないように）。
    const events = await page.locator('#placements .pm[data-kind="vehicle"] .pm-halo')
      .evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(events).toBe("none");
  });

  test("ホバーと選択で項目名が出る", async ({ page, context }) => {
    await openPlan(page, context, "9281", "marker-label");
    await placeItem(page, "structure", "bunker", 5000, 5000);

    const label = page.locator("#placements .pm .pm-label");
    await expect(label).toHaveText("バンカー");
    // 置いた直後は選ばれているので見えている。
    await expect(label).toBeVisible();

    // 選択を外すと消える。
    await page.locator("#placement-detail .close").click();
    await expect(label).toBeHidden();

    // ホバーで出る。
    const at = await boardPoint(page, 5000, 5000);
    await page.mouse.move(at.x, at.y);
    await expect(label).toBeVisible();
    await page.mouse.move(at.x + 200, at.y + 150);
    await expect(label).toBeHidden();
  });
});

test.describe("射程リング", () => {
  test("L81 を置くと 684m の最大射程と 80m の最小射程が実寸で描かれる", async ({ page, context }) => {
    await openPlan(page, context, "9220", "rings");
    await placeItem(page, "emplacement", "mortar_l81", 7500, 7500);

    // viewBox はメートルなので、r がそのまま射程のメートル値になる。
    const max = page.locator("#ranges circle.rng-max");
    const min = page.locator("#ranges circle.rng-min");
    await expect(max).toHaveCount(1);
    await expect(min).toHaveCount(1);
    await expect(max).toHaveAttribute("r", String(L81_MAX_M));
    await expect(min).toHaveAttribute("r", String(L81_MIN_M));

    // 中心は置いた地点。画面のピクセルからメートルに直しているので、
    // 1mm 未満のずれは出る（マップの一辺がちょうどの km ではないため、
    // 1px が割り切れる長さにならない）。1m 以内なら「そこに置けた」でよい。
    expect(Number(await max.getAttribute("cx"))).toBeCloseTo(7500, 0);
    expect(Number(await max.getAttribute("cy"))).toBeCloseTo(7500, 0);

    // 届く範囲の塗り。最小射程があるので内側に穴が開く（= 2つの円で evenodd）。
    const band = page.locator("#ranges .rng-band");
    await expect(band).toHaveAttribute("fill-rule", "evenodd");
    expect((await band.getAttribute("d")).match(/M /g)).toHaveLength(2);

    // 実寸であること: 全体表示（マップの一辺が盤面に収まる）での見た目の半径が
    // 684m ぶんになっている。1kmセルの 2/3 ほどの大きさ。
    const box = await page.locator("#board").boundingBox();
    const mapPx = Math.min(box.width, box.height); // マップの一辺ぶんの画面上の長さ
    const expectedPx = (L81_MAX_M / (await mapSizeM(page)).w) * mapPx;
    const fitSpan = await screenSpan(max);
    expect(Math.abs(fitSpan / 2 - expectedPx)).toBeLessThan(1);
    // 実際に描かれた円と、実際に描かれた 1km グリッドを見比べる。
    // 半径 684m は 1km セルの 2/3 ほど、直径はセル 1.37 個ぶん。
    const cellPx = await page.locator("#grid line").first().evaluate((el) => {
      const svg = el.ownerSVGElement;
      const m = svg.getScreenCTM();
      const a = svg.createSVGPoint();
      a.x = 0; a.y = 0;
      const b = svg.createSVGPoint();
      b.x = 1000; b.y = 0;
      return b.matrixTransform(m).x - a.matrixTransform(m).x;
    });
    expect(fitSpan / cellPx).toBeCloseTo(1.368, 1);

    // ズームしても地図と同じ縮尺で伸びる（マーカーと違い実寸なので大きくなる）。
    const c = await boardPoint(page, 7500, 7500);
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, -800);
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", await coverViewBox(page));

    const viewW = await page
      .locator("#board")
      .evaluate((el) => Number(el.getAttribute("viewBox").split(" ")[2]));
    const zoomedBox = await page.locator("#board").boundingBox();
    // viewBox の縦横比は盤面と同じなので、横で割れば倍率がそのまま出る。
    const zoomedPx = (L81_MAX_M / viewW) * zoomedBox.width;
    expect(zoomedPx).toBeGreaterThan(expectedPx * 1.5); // 実際に大きくなっている
    expect(Math.abs((await screenSpan(max)) / 2 - zoomedPx)).toBeLessThan(1.5);
  });

  test("射程データが無い項目にはリングが出ない", async ({ page, context }) => {
    await openPlan(page, context, "9221", "norange");
    await placeItem(page, "structure", "bunker", 5000, 5000);

    await expect(page.locator("#placements .pm")).toHaveCount(1);
    await expect(page.locator("#ranges .rng")).toHaveCount(0);
    await expect(page.locator("#ranges circle")).toHaveCount(0);
  });

  test("SPH-2 も出典どおりの 600–2600m で描かれる", async ({ page, context }) => {
    await openPlan(page, context, "9222", "sph2");
    // 射程データが入っているのは L81 と SPH-2 の2項目だけ（schema.sql）。
    await placeItem(page, "vehicle", "sph_2", 8000, 8000);
    await expect(page.locator("#ranges circle.rng-max")).toHaveAttribute("r", "2600");
    await expect(page.locator("#ranges circle.rng-min")).toHaveAttribute("r", "600");
  });

  test("選択中の配置だけリングが強調される", async ({ page, context }) => {
    await openPlan(page, context, "9223", "ring-select");
    await placeItem(page, "emplacement", "mortar_l81", 4000, 4000);
    await placeItem(page, "emplacement", "mortar_l81", 12000, 12000);

    // 置いた直後は2つ目が選ばれている。
    await expect(page.locator("#ranges .rng.sel")).toHaveCount(1);
    const opacity = (n) =>
      page.locator("#ranges .rng").nth(n).evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(await opacity(0)).toBeLessThan(await opacity(1));

    await page.locator("#placements .pm").first().click();
    await expect(page.locator("#ranges .rng").first()).toHaveAttribute("class", /\bsel\b/);
    expect(await opacity(0)).toBeGreaterThan(await opacity(1));
  });

  test("「射程を表示」で射程リングを隠せる", async ({ page, context }) => {
    await openPlan(page, context, "9224", "ring-toggle");
    await placeItem(page, "emplacement", "mortar_l81", 7000, 7000);

    await openViewMenu(page);
    const toggle = page.getByRole("button", { name: "射程を表示" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#ranges circle.rng-max")).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#ranges circle.rng-max")).toBeHidden();
    // リングを消してもマーカーは残る（どこに置いたかは分かり続ける）。
    await expect(page.locator("#placements .pm")).toBeVisible();

    await toggle.click();
    await expect(page.locator("#ranges circle.rng-max")).toBeVisible();
  });
});

// 位置に紐づく判断を書く（placements.label）と、取る順番（placements.rank）。
// サーバ側は先に出来ていて、ここで繋いだのは UI だけ（設計書 §3-D）。
test.describe("注記と優先度", () => {
  /** 詳細パネルの注記欄に書いて保存する。 */
  async function writeNote(page, text) {
    const input = page.locator("#placement-label");
    await input.fill(text);
    await page.locator("#placement-label-save").click();
  }

  test("注記を書いて保存すると、リロードしても残る", async ({ page, context }) => {
    await openPlan(page, context, "9300", "note-save");
    await placeItem(page, "objective", "mk_defend", 6000, 6000);

    const input = page.locator("#placement-label");
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    // サーバ側の上限と同じ。入力できるのに保存できない欄を作らない。
    await expect(input).toHaveAttribute("maxlength", "48");

    await writeNote(page, "北の橋を先に落とす");
    await expect(page.locator("#status")).toContainText("注記を保存しました");
    // 全体表示（16km）なので地図の上では省略される（省略そのものは別のテストで見る）。
    await expect(page.locator("#placements .pm .pm-label")).toHaveText("北の橋を先に…");

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#placements .pm")).toHaveCount(1);
    // 全体表示（16km）なので地図の文字は省略されるが、中身は残っている。
    await page.locator("#placements .pm").click();
    await expect(page.locator("#placement-label")).toHaveValue("北の橋を先に落とす");

    // 空にすれば消せる（「なし」に戻す手段があること）。
    await writeNote(page, "");
    await expect(page.locator("#status")).toContainText("注記を消しました");
    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await page.locator("#placements .pm").click();
    await expect(page.locator("#placement-label")).toHaveValue("");
  });

  test("注記がある配置は、選んでいなくても地図に文字が出る", async ({ page, context }) => {
    await openPlan(page, context, "9301", "note-always");
    // 注記の無い配置（比較用）と、ある配置。
    await placeItem(page, "structure", "bunker", 4000, 4000);
    await placeItem(page, "objective", "mk_defend", 9000, 9000);
    // 項目名（mk_defend = 「ここ守ろう」）とは違う文字にして、
    // どちらが出ているのかを見分けられるようにする。
    await writeNote(page, "東を守る");

    const plain = page.locator('#placements .pm[data-item-id="bunker"] .pm-label');
    const noted = page.locator('#placements .pm[data-item-id="mk_defend"] .pm-label');

    // 選択を外し、どちらにもホバーしていない状態にする。
    await page.locator("#placement-detail .close").click();
    await page.mouse.move(5, 5);

    // 注記が無いほうは従来どおり隠れ、あるほうは出たまま。
    await expect(plain).toBeHidden();
    await expect(noted).toBeVisible();
    // 項目名ではなく注記を出す（注記のほうが「今この試合で決めたこと」）。
    await expect(noted).toHaveText("東を守る");
  });

  test("視野が広いと注記は省略され、寄ると全文になる", async ({ page, context }) => {
    await openPlan(page, context, "9302", "note-abbrev");
    await placeItem(page, "objective", "mk_attack", 8000, 8000);
    await writeNote(page, "南の橋から回り込む");

    const label = page.locator("#placements .pm .pm-label");
    const view = () => viewBoxOf(page);

    // 全体表示はマップの一辺（16km 超）。4000m より広いので先頭6文字＋「…」。
    expect((await view()).w).toBeGreaterThan(4000);
    await expect(label).toHaveText("南の橋から回…");

    // 4000m 以下まで寄ると全文。
    const c = await boardPoint(page, 8000, 8000);
    await page.mouse.move(c.x, c.y);
    for (let i = 0; i < 6 && (await view()).w > 4000; i += 1) {
      await page.mouse.wheel(0, -600);
    }
    expect((await view()).w).toBeLessThanOrEqual(4000);
    await expect(label).toHaveText("南の橋から回り込む");

    // 引き戻すとまた省略される（片道の切り替えになっていないこと）。
    await page.getByRole("button", { name: "全体表示" }).click();
    await expect(label).toHaveText("南の橋から回…");
  });

  test("他の人の配置の注記欄は無効で、理由が出ている", async ({ page, context }) => {
    await loginViaApi(context, "9303", "note-owner");
    const planId = await createPlan(context, "note-shared");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await placeItem(page, "objective", "mk_danger", 6000, 6000);
    await writeNote(page, "見られてる");

    await loginViaApi(context, "9304", "note-visitor");
    const patches = [];
    page.on("request", (r) => { if (r.method() === "PATCH") patches.push(r.url()); });
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#placements .pm")).toHaveCount(1);
    // 他人が書いた注記も読める（読めなければ共有する意味が無い）。
    await expect(page.locator("#placements .pm .pm-label")).toHaveText("見られてる");
    await page.locator("#placements .pm").click();

    const input = page.locator("#placement-label");
    const save = page.locator("#placement-label-save");
    const rank = page.locator("#placement-rank");
    await expect(input).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(rank).toBeDisabled();
    for (const el of [input, save, rank]) {
      await expect(el).toHaveAttribute("title", /他の人の配置には書けません/);
    }
    // 読むのは自由（値は出ている）。
    await expect(input).toHaveValue("見られてる");
    expect(patches, "書けない欄から PATCH は飛ばない").toEqual([]);
  });

  test("使えない語を含む注記は弾かれ、理由が出て元に戻る", async ({ page, context }) => {
    await openPlan(page, context, "9305", "note-blocked");
    await placeItem(page, "objective", "mk_note", 7000, 7000);
    await writeNote(page, "ここは安全");
    await expect(page.locator("#status")).toContainText("注記を保存しました");

    await writeNote(page, "禁止語を書いてみる");
    const status = page.locator("#status");
    await expect(status).toContainText("使えない語");
    await expect(status).toHaveClass(/\berr\b/);

    // 楽観更新を巻き戻して、前の注記に戻っていること（画面も欄も）。
    await expect(page.locator("#placement-label")).toHaveValue("ここは安全");
    await expect(page.locator("#placements .pm .pm-label")).toHaveText("ここは安全");

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await page.locator("#placements .pm").click();
    await expect(page.locator("#placement-label")).toHaveValue("ここは安全");
  });

  test("長すぎる注記はサーバに弾かれ、理由が出て元に戻る", async ({ page, context }) => {
    await openPlan(page, context, "9306", "note-toolong");
    await placeItem(page, "objective", "mk_note", 7000, 7000);
    await writeNote(page, "みじかい");
    await expect(page.locator("#status")).toContainText("注記を保存しました");

    // 欄の maxlength は 48 なので、人の入力では 49 文字に届かない。
    // 貼り付けや将来の変更で抜けたときに理由が出ることを確かめる。
    await page.locator("#placement-label").evaluate((el) => {
      el.value = "あ".repeat(49);
    });
    await page.locator("#placement-label-save").click();

    const status = page.locator("#status");
    await expect(status).toContainText("48文字までです");
    await expect(status).toHaveClass(/\berr\b/);
    await expect(page.locator("#placement-label")).toHaveValue("みじかい");
    await expect(page.locator("#placements .pm .pm-label")).toHaveText("みじかい");
  });

  test("優先度を選ぶとマーカーに数字が出て、リロードしても残る", async ({ page, context }) => {
    await openPlan(page, context, "9307", "rank");
    await placeItem(page, "structure", "fob", 6000, 6000);

    const rank = page.locator("#placement-rank");
    await expect(rank).toBeVisible();
    // なし + 1〜9。
    await expect(choiceOptions(page, "placement-rank")).toHaveCount(10);
    expect(await chosenValue(page, "placement-rank")).toBe("");
    await expect(page.locator("#placements .pm .pm-rank")).toHaveCount(0);

    await chooseOption(page, "placement-rank", { value: "3" });
    await expect(page.locator("#status")).toContainText("優先度を 3 にしました");
    await expect(page.locator("#placements .pm .pm-rank")).toHaveText("3");

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#placements .pm .pm-rank")).toHaveText("3");
    await page.locator("#placements .pm").click();
    expect(await chosenValue(page, "placement-rank")).toBe("3");

    // 「なし」に戻せる。
    await chooseOption(page, "placement-rank", { value: "" });
    await expect(page.locator("#placements .pm .pm-rank")).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#placements .pm .pm-rank")).toHaveCount(0);
  });

  test("グリフと優先度の数字が重ならず、両方読める", async ({ page, context }) => {
    await openPlan(page, context, "9308", "rank-glyph");
    // 全角のグリフ（守）は頭の丸いっぱいに広がるので、いちばん重なりやすい。
    await placeItem(page, "objective", "mk_defend", 6000, 6000);
    await chooseOption(page, "placement-rank", { value: "8" });

    const marker = page.locator("#placements .pm");
    await expect(marker.locator(".pm-glyph")).toHaveText("守");
    await expect(marker.locator(".pm-rank")).toHaveText("8");

    // 画面上の矩形が重なっていないこと（どちらかが隠れていたら読めない）。
    const boxes = await marker.evaluate((el) => {
      const r = (sel) => {
        const b = el.querySelector(sel).getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height };
      };
      return { glyph: r(".pm-glyph"), rank: r(".pm-rank") };
    });
    for (const [name, b] of Object.entries(boxes)) {
      expect(b.w, `${name} に幅がある`).toBeGreaterThan(1);
      expect(b.h, `${name} に高さがある`).toBeGreaterThan(1);
    }
    const overlap =
      boxes.glyph.right > boxes.rank.left && boxes.rank.right > boxes.glyph.left &&
      boxes.glyph.bottom > boxes.rank.top && boxes.rank.bottom > boxes.glyph.top;
    expect(overlap, `グリフ ${JSON.stringify(boxes.glyph)} と数字 ${JSON.stringify(boxes.rank)} が重なっている`)
      .toBe(false);

    // 数字はズームしても画面上の大きさが変わらない（マーカーと同じ扱い）。
    const before = await screenWidth(marker.locator(".pm-rank-disc"));
    const c = await boardPoint(page, 6000, 6000);
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, -800);
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", await coverViewBox(page));
    expect(Math.abs((await screenWidth(marker.locator(".pm-rank-disc"))) - before)).toBeLessThan(1.5);
  });

  test("メモ系の記号を置くと、注記の欄にそのまま書き始められる", async ({ page, context }) => {
    await openPlan(page, context, "9309", "note-focus");

    // 「置く → 書く」が1動作で終わること。重ならないよう置く場所をずらす。
    const memoItems = ["mk_note", "mk_defend", "mk_attack", "mk_danger"];
    for (const [i, itemId] of memoItems.entries()) {
      await placeItem(page, "objective", itemId, 3000 + 2500 * i, 4000);
      await expect(
        page.locator("#placement-label"),
        `${itemId} を置いたら注記の欄にフォーカスが当たる`
      ).toBeFocused();
      // そのままキーボードで書ける（クリックし直さなくてよい）。
      await page.keyboard.type("あ");
      await expect(page.locator("#placement-label")).toHaveValue("あ");
      await page.locator("#placement-detail .close").click();
    }

    // 位置を示すだけの記号は奪わない（置いた直後に書くことが前提ではない）。
    await placeItem(page, "objective", "mk_drill", 11000, 11000);
    await expect(page.locator("#placement-label")).not.toBeFocused();
  });

  test("詳細パネルが伸びても、消すボタンまで届く", async ({ page, context }) => {
    // 注記と優先度のぶん縦に伸びる。パレットと同じ「潰れて切れる」事故を起こさない。
    await page.setViewportSize({ width: 390, height: 844 });
    await openPlan(page, context, "9310", "detail-scroll");
    await placeItem(page, "emplacement", "mortar_l81", 7000, 7000);

    const detail = page.locator("#placement-detail");
    await expect(detail).toBeVisible();
    const del = page.locator("#placement-delete");
    await del.scrollIntoViewIfNeeded();
    const db = await del.boundingBox();
    const pb = await detail.boundingBox();
    expect(db.y + db.height, "消すボタンがパネルの中に出る")
      .toBeLessThanOrEqual(pb.y + pb.height + 1);
    await del.click();
    await expect(page.locator("#placements .pm")).toHaveCount(0);
  });
});

test.describe("FOB の建築範囲", () => {
  test("FOB を置くと一辺 120m の正方形が実寸で描かれる", async ({ page, context }) => {
    await openPlan(page, context, "9230", "fob");
    await placeItem(page, "structure", "fob", 7500, 7500);

    // 円ではなく正方形（正方形であることはゲーム内で確認済み）。
    const square = page.locator("#ranges rect.fob-range");
    await expect(square).toHaveCount(1);
    await expect(square).toHaveAttribute("width", String(FOB_SIDE_M));
    await expect(square).toHaveAttribute("height", String(FOB_SIDE_M));
    // 中心から ±60m（画面のピクセル由来の 1mm 未満のずれは許す）。
    expect(Number(await square.getAttribute("x"))).toBeCloseTo(7500 - FOB_SIDE_M / 2, 0);
    expect(Number(await square.getAttribute("y"))).toBeCloseTo(7500 - FOB_SIDE_M / 2, 0);
    // FOB に射程データは無いので、リングは描かない。
    await expect(page.locator("#ranges circle")).toHaveCount(0);

    // 一辺の長さは未確認であることを必ず出す（確定値のように見せない）。
    await expect(page.locator("#status")).toContainText("未確認");
    const detail = page.locator("#placement-detail");
    await expect(detail).toContainText("120m四方（暫定・未確認）");
    await expect(detail).toContainText("一辺の長さは未確認");

    // 実寸（メートル）で描かれている。
    const box = await page.locator("#board").boundingBox();
    const expectedPx =
      (FOB_SIDE_M / (await mapSizeM(page)).w) * Math.min(box.width, box.height);
    expect(Math.abs((await screenSpan(square)) - expectedPx)).toBeLessThan(0.5);

    await page.reload();
    await expect(page.locator("#ranges rect.fob-range")).toHaveAttribute("width", String(FOB_SIDE_M));
  });
});
