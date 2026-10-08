// スタンプ（図形・向きを持つ印・軍用記号）の UIテスト。
//
// オーナーの要望（原文。D-062）:
//   「四角とか、丸、などスタンプほしいですね」
//   「スタンプは、**凸型の敵とか見方を示すもの**もあっていいし、**自由に追加**もいいと思います」
//   「**軍用記号です**」
//
// 仕様: docs/superpowers/specs/2026-10-08-stamps.md（第1段 ＝ 組み込みの一式）
// 受け入れ条件:
//   1. 図形3種・向きを持つ印2種・軍用記号が棚から置ける
//   2. `vector` はドラッグで向きが決まる
//   3. 置いたものを動かせる・消せる。他人のものは 403
//   4. 戻す → やり直す → もう一度戻す が効く（D-078 と同じ形）
//   5. 範囲選択の枠でスタンプも選べる。配置・地名と混ぜて選べる
//   6. 運んでいる最中が相手に見える。**通数がただ振ったときと同じ**
//   7. 読専で置けない。ゲストで置けない（tests/plan-visibility・plan-guest で総当たり）
//   8. 同じ client_uuid で2回 POST しても1つしか増えない（tests/plan-stamps）
//   9. ズームしてもスタンプの大きさが変わらない
//
// **2枚のタブは同じアカウントで**（D-068。身元は「人」ではなく「接続」）。
//
// テスト用 Discord ID の帯: 10141–10160（e2e/config.js の採番表を参照）
import { expect, test } from "@playwright/test";

import {
  boardPoint, createPlan, loginViaApi, planUrl, showWholeMap,
} from "./plan-helpers.js";

/** 組み込みのスタンプの id（schema.sql の種まきと対で持つ）。 */
const SQUARE = 1;        // 図形・四角
const CIRCLE = 2;
const TRIANGLE = 3;
const ARROW_OWN = 4;     // 矢印（味方）— vector
const LINE_ENEMY = 7;    // 線（敵）— vector
const OWN_INF = 8;       // 味方 歩兵（square / 歩）
const ENEMY_ARMOUR = 15; // 敵 装甲（diamond / 装）
const UNKNOWN_ARTY = 22; // 不明 砲兵（quatrefoil / 砲）

const stamps = (page) => page.locator("#stamps .st");

async function openPlan(page, context, discordId, name) {
  await loginViaApi(context, discordId, name);
  const planId = await createPlan(context, name);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.getByRole("button", { name: "取り消す" })).toBeEnabled();
  // 棚が組めている（定義が届いた）ことを待つ。
  await expect(page.locator("#stamppanel .st-item")).toHaveCount(25);
  await showWholeMap(page);
  return planId;
}

/** スタンプの棚を開く（パレットと同じ左の引き出しなので、開くとあちらは閉じる）。 */
async function openStampPanel(page) {
  const panel = page.locator("#stamppanel");
  if (!(await panel.isVisible())) {
    await page.getByRole("button", { name: "スタンプ", exact: true }).click();
  }
  await expect(panel).toBeVisible();
}

/** 棚から1つ選ぶ。**まとまりの折りたたみを開いてから**押す（先頭以外は畳んである）。 */
async function pickStamp(page, stampId) {
  await openStampPanel(page);
  const item = page.locator(`#stamppanel .st-item[data-stamp-id="${stampId}"]`);
  const group = page.locator(`#stamppanel .pal-group:has(.st-item[data-stamp-id="${stampId}"])`);
  // `open` は属性だと空文字（= falsy）になるので、プロパティで見る。
  if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
  await expect(item).toBeVisible();
  if ((await item.getAttribute("aria-pressed")) !== "true") await item.click();
  await expect(item).toHaveAttribute("aria-pressed", "true");
}

/** 点のスタンプを1件置く。 */
async function placePoint(page, stampId, x, y) {
  const before = await stamps(page).count();
  await pickStamp(page, stampId);
  const at = await boardPoint(page, x, y);
  await page.mouse.click(at.x, at.y);
  await expect(stamps(page)).toHaveCount(before + 1);
  await page.keyboard.press("Escape");
}

/** 向きを持つスタンプを1本引く。 */
async function drawVector(page, stampId, from, to) {
  const before = await stamps(page).count();
  await pickStamp(page, stampId);
  const a = await boardPoint(page, from.x, from.y);
  const b = await boardPoint(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
  await expect(stamps(page)).toHaveCount(before + 1);
  await page.keyboard.press("Escape");
}

/** 向きを持つスタンプの線の両端（マップ座標）。 */
const lineOf = (locator) =>
  locator.locator(".st-line").evaluate((el) => ({
    x1: Number(el.getAttribute("x1")), y1: Number(el.getAttribute("y1")),
    x2: Number(el.getAttribute("x2")), y2: Number(el.getAttribute("y2")),
  }));

// ── 受け入れ条件1 ─────────────────────────────────────────────

test.describe("棚から置ける", () => {
  test("図形3種・向きを持つ印2種・軍用記号が、まとまりに分かれて並ぶ", async ({ page, context }) => {
    await openPlan(page, context, "10141", "スタンプの棚");
    await openStampPanel(page);

    const groups = page.locator("#stamppanel .pal-group");
    await expect(groups).toHaveCount(3);
    await expect(groups.nth(0).locator("summary")).toContainText("図形");
    await expect(groups.nth(1).locator("summary")).toContainText("向きを持つ印");
    await expect(groups.nth(2).locator("summary")).toContainText("軍用記号");
    await expect(groups.nth(0).locator(".st-item")).toHaveCount(3);
    await expect(groups.nth(1).locator(".st-item")).toHaveCount(4);
    await expect(groups.nth(2).locator(".st-item")).toHaveCount(18);

    // **APP-6 から外れている所を棚が名乗っている**（勝手な記号だと思われないため）。
    const note = page.locator("#stamppanel > .note");
    await expect(note).toContainText("APP-6");
    await expect(note).toContainText("兵種");
    await expect(note).toContainText("独自");
  });

  test("図形3種を置ける（形がそれぞれ違う）", async ({ page, context }) => {
    await openPlan(page, context, "10142", "図形3種");
    await placePoint(page, SQUARE, 4000, 4000);
    await placePoint(page, CIRCLE, 6000, 4000);
    await placePoint(page, TRIANGLE, 8000, 4000);
    await expect(stamps(page)).toHaveCount(3);
    const shapes = await stamps(page).evaluateAll((els) => els.map((e) => e.dataset.shape));
    expect(shapes).toEqual(["square", "circle", "triangle"]);
  });

  test("軍用記号は、外形が陣営・中の字が兵種になっている", async ({ page, context }) => {
    await openPlan(page, context, "10143", "軍用記号");
    await placePoint(page, OWN_INF, 4000, 6000);
    await placePoint(page, ENEMY_ARMOUR, 6000, 6000);
    await placePoint(page, UNKNOWN_ARTY, 8000, 6000);

    const got = await stamps(page).evaluateAll((els) => els.map((e) => ({
      shape: e.dataset.shape,
      color: e.dataset.color,
      glyph: e.querySelector(".st-glyph")?.textContent ?? null,
    })));
    expect(got).toEqual([
      { shape: "square", color: "blue", glyph: "歩" },
      { shape: "diamond", color: "red", glyph: "装" },
      { shape: "quatrefoil", color: "hot", glyph: "砲" },
    ]);
    // 「不明」は APP-6 の四葉をそのまま描いている（弧4本で閉じた輪郭）。
    const d = await page.locator('#stamps .st[data-shape="quatrefoil"] .st-shape')
      .getAttribute("d");
    expect((d.match(/A /g) ?? []).length).toBe(4);
  });

  test("詳細パネルが陣営と位置を出し、注記を書ける", async ({ page, context }) => {
    await openPlan(page, context, "10144", "スタンプの検視台");
    await placePoint(page, ENEMY_ARMOUR, 5000, 5000);
    // 置いた直後は選ばれている。
    await expect(page.locator("#placement-detail")).toBeVisible();
    await expect(page.locator("#placement-detail h2")).toHaveText("敵 装甲");
    await expect(page.locator("#placement-detail")).toContainText("敵");

    await page.fill("#stamp-note", "ここに装甲");
    await page.click("#stamp-note-save");
    await expect(page.locator("#status")).toContainText("注記を保存しました");
    await expect(page.locator("#stamps .st .st-note")).toHaveText("ここに装甲");
  });
});

// ── 受け入れ条件2 ─────────────────────────────────────────────

test.describe("向きを持つ印", () => {
  test("ドラッグで向きが決まる（引いた向きが保存される）", async ({ page, context }) => {
    await openPlan(page, context, "10145", "矢印の向き");
    await drawVector(page, ARROW_OWN, { x: 3000, y: 3000 }, { x: 11000, y: 9000 });

    const line = await lineOf(stamps(page).first());
    // **座標は SVG ユーザー単位**（`boardPoint` が受けるのもこちら。y は下向きが正）。
    // 右下へ引いたので、x も y も増える向きになる。
    expect(line.x2).toBeGreaterThan(line.x1);
    expect(line.y2).toBeGreaterThan(line.y1);
    // 矢の先が終点にあり、引いた向きへ回っている。
    const head = await page.locator("#stamps .st-head").getAttribute("transform");
    expect(head).toMatch(/translate\(/);
    expect(head).toMatch(/rotate\(/);
  });

  test("逆向きに引くと、向きも逆になる", async ({ page, context }) => {
    await openPlan(page, context, "10146", "矢印の逆向き");
    await drawVector(page, ARROW_OWN, { x: 11000, y: 9000 }, { x: 3000, y: 3000 });
    const line = await lineOf(stamps(page).first());
    expect(line.x2).toBeLessThan(line.x1);
  });

  test("押しただけでは置かない（向きが決まらないので）", async ({ page, context }) => {
    await openPlan(page, context, "10147", "矢印のタップ");
    await pickStamp(page, LINE_ENEMY);
    const at = await boardPoint(page, 6000, 6000);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator("#status")).toContainText("ドラッグ");
    await expect(stamps(page)).toHaveCount(0);
  });

  test("引いている最中はプレビューが出て、離すと消える", async ({ page, context }) => {
    await openPlan(page, context, "10148", "矢印のプレビュー");
    await pickStamp(page, ARROW_OWN);
    const a = await boardPoint(page, 4000, 4000);
    const b = await boardPoint(page, 10000, 10000);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await expect(page.locator("#stamp-draft .st")).toHaveCount(1);
    await page.mouse.up();
    await expect(page.locator("#stamp-draft .st")).toHaveCount(0);
    await expect(stamps(page)).toHaveCount(1);
  });
});

// ── 受け入れ条件3 ─────────────────────────────────────────────

test.describe("動かす・消す", () => {
  test("自分のスタンプはドラッグで動かせて、保存される", async ({ page, context }) => {
    const planId = await openPlan(page, context, "10149", "スタンプを動かす");
    await placePoint(page, SQUARE, 5000, 5000);

    const from = await boardPoint(page, 5000, 5000);
    const to = await boardPoint(page, 11000, 11000);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator("#status")).toContainText("スタンプを動かしました");

    // サーバにも入っている（画面だけ動いて保存されていない、を弾く）。
    const res = await context.request.get(planUrl(`/api/sessions/${planId}/stamps`));
    const body = await res.json();
    expect(Math.abs(body.stamps[0].x_m - 11000)).toBeLessThan(200);
  });

  test("向きを持つスタンプは、向きを保ったまま全体が動く", async ({ page, context }) => {
    const planId = await openPlan(page, context, "10150", "矢印を動かす");
    await drawVector(page, ARROW_OWN, { x: 3000, y: 3000 }, { x: 7000, y: 3000 });
    const before = await lineOf(stamps(page).first());

    // 線の真ん中を掴む（.st-hit が掴みどころ）。
    const grab = await boardPoint(page, 5000, 3000);
    const drop = await boardPoint(page, 5000, 9000);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator("#status")).toContainText("スタンプを動かしました");

    const after = await lineOf(stamps(page).first());
    // 長さと向きは変わっていない（平行移動だけ）。
    expect(Math.abs((after.x2 - after.x1) - (before.x2 - before.x1))).toBeLessThan(1);
    expect(Math.abs((after.y2 - after.y1) - (before.y2 - before.y1))).toBeLessThan(1);
    // 下へ 6000 ぶん運んだ（SVG は下向きが正なので、画面では下へ移った）。
    expect(after.y1 - before.y1).toBeGreaterThan(5000);

    // **両端とも保存されている。** 片側だけ送るとサーバが 400 を返すので、
    // ここが通ることが「両端を一緒に送っている」ことの証明になる。
    const body = await (await context.request.get(
      planUrl(`/api/sessions/${planId}/stamps`)
    )).json();
    const row = body.stamps[0];
    // 水平に引いた線なので、保存された両端の y_m は等しいまま。
    expect(Math.abs(row.y2_m - row.y_m), "向きが崩れた").toBeLessThan(1);
    // 長さ（4000m）も保たれている。
    expect(Math.abs(Math.abs(row.x2_m - row.x_m) - 4000)).toBeLessThan(50);
    // 運ぶ前の y_m（SVG 3000 ＝ マップの上辺から 3000）から 6000 ぶん下がっている。
    const { height_m } = await (await context.request.get(planUrl("/api/maps"))).json()
      .then((b) => b.maps.find((m) => m.id === "bakurani"));
    expect(Math.abs(row.y_m - (height_m - 9000))).toBeLessThan(300);
  });

  test("検視台から消せる", async ({ page, context }) => {
    await openPlan(page, context, "10151", "スタンプを消す");
    await placePoint(page, CIRCLE, 6000, 6000);
    await stamps(page).first().click();
    await page.click("#stamp-delete");
    await expect(page.locator("#status")).toContainText("スタンプを消しました");
    await expect(stamps(page)).toHaveCount(0);
  });

  test("他の人のスタンプは動かせない・消せない（押す前に理由が出る）", async ({ page, browser }) => {
    const ownerCtx = await browser.newContext();
    const planId = await openPlan(ownerCtx.pages()[0] ?? await ownerCtx.newPage(),
      ownerCtx, "10152", "他人のスタンプ");
    const ownerPage = ownerCtx.pages()[0];
    await placePoint(ownerPage, SQUARE, 7000, 7000);

    // 別の人が同じ作戦を開く（private は URL を知っていれば書き込める。D-070）。
    const otherCtx = await browser.newContext();
    await loginViaApi(otherCtx, "10153", "よその人");
    const other = await otherCtx.newPage();
    await other.goto(planUrl(`/plan?id=${planId}`));
    await expect(other.locator("#stamps .st")).toHaveCount(1);
    await showWholeMap(other);

    await other.locator("#stamps .st").first().click();
    await expect(other.locator("#stamp-delete")).toBeDisabled();
    await expect(other.locator("#stamp-delete"))
      .toHaveAttribute("title", /他の人のスタンプは消せません/);
    await expect(other.locator("#stamp-note")).toBeDisabled();

    // サーバも断る（押せるのに 403、ではなく押せない＋サーバも 403 の二段）。
    const res = await otherCtx.request.delete(
      planUrl(`/api/sessions/${planId}/stamps?id=1`),
      { headers: { origin: new URL(planUrl("/")).origin } }
    );
    expect([403, 404]).toContain(res.status());

    await otherCtx.close();
    await ownerCtx.close();
  });
});

// ── 受け入れ条件9 ─────────────────────────────────────────────

test("ズームしてもスタンプの大きさが変わらない（既存の逆スケールに相乗り）",
  async ({ page, context }) => {
    await openPlan(page, context, "10154", "スタンプの大きさ");
    await placePoint(page, ENEMY_ARMOUR, 8000, 8000);

    const sizeOf = () => page.locator("#stamps .st .st-shape")
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });

    const wide = await sizeOf();
    // 2段寄る（ズームのボタン2回）。
    await page.getByRole("button", { name: "拡大" }).click();
    await page.getByRole("button", { name: "拡大" }).click();
    await page.waitForTimeout(400);
    const near = await sizeOf();

    // **画面上の大きさは同じ**（1px の丸めは許す）。
    expect(Math.abs(near.w - wide.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(near.h - wide.h)).toBeLessThanOrEqual(1);

    // 一方、向きを持つスタンプの線はマップ座標なので**長くなる**（長さは情報）。
    await drawVector(page, ARROW_OWN, { x: 7800, y: 7800 }, { x: 8200, y: 8200 });
    const px = () => page.locator("#stamps .st-line")
      .evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const nearPx = await px();
    await page.getByRole("button", { name: "縮小" }).click();
    await page.getByRole("button", { name: "縮小" }).click();
    await page.waitForTimeout(400);
    expect(await px()).toBeLessThan(nearPx);
  });

// ── 受け入れ条件4（D-078 と同じ形）─────────────────────────────
//
// 戻す ＝ サーバから DELETE、やり直す ＝ もう一度 POST なので **id が変わる。**
// やり直しは「古い項目の id を書き換える」のではなく「置く経路をもう一度通して
// 新しい項目として積む」形なので、**やり直したあともう一度戻しても 404 にならない。**
// ここはその挙動を外から確かめる（`#status` と、サーバの行数）。

test.describe("戻す・やり直す", () => {
  const rowCount = async (context, planId) => {
    const body = await (await context.request.get(
      planUrl(`/api/sessions/${planId}/stamps`)
    )).json();
    return body.stamps.length;
  };

  test("点のスタンプで 戻す → やり直す → もう一度戻す が効く", async ({ page, context }) => {
    const planId = await openPlan(page, context, "10155", "スタンプを戻す");
    await placePoint(page, OWN_INF, 6000, 6000);
    expect(await rowCount(context, planId), "置いた直後").toBe(1);

    await page.getByRole("button", { name: "取り消す" }).click();
    await expect(page.locator("#status")).toContainText("取り消しました");
    await expect(stamps(page)).toHaveCount(0);
    expect(await rowCount(context, planId), "戻したあと").toBe(0);

    await page.getByRole("button", { name: "やり直す" }).click();
    await expect(page.locator("#status")).toContainText("やり直しました");
    await expect(stamps(page)).toHaveCount(1);
    expect(await rowCount(context, planId), "やり直したあと").toBe(1);

    // **ここが肝。** id が変わっているので、書き換え忘れがあれば 404 になる。
    await page.getByRole("button", { name: "取り消す" }).click();
    await expect(page.locator("#status")).toContainText("取り消しました");
    await expect(stamps(page)).toHaveCount(0);
    expect(await rowCount(context, planId), "もう一度戻したあと").toBe(0);
  });

  test("向きを持つスタンプをやり直すと、向きも戻る（終点を写しに持っている）",
    async ({ page, context }) => {
      const planId = await openPlan(page, context, "10156", "矢印を戻す");
      await drawVector(page, ARROW_OWN, { x: 3000, y: 4000 }, { x: 9000, y: 4000 });
      const before = await lineOf(stamps(page).first());

      await page.getByRole("button", { name: "取り消す" }).click();
      await expect(stamps(page)).toHaveCount(0);
      await page.getByRole("button", { name: "やり直す" }).click();
      await expect(stamps(page)).toHaveCount(1);

      const after = await lineOf(stamps(page).first());
      expect(after).toEqual(before);
      // サーバにも終点が入っている（**ここが空だと 400 で黙って失敗する**）。
      const body = await (await context.request.get(
        planUrl(`/api/sessions/${planId}/stamps`)
      )).json();
      expect(body.stamps[0].x2_m).not.toBe(null);
    });

  test("注記もやり直しで戻る", async ({ page, context }) => {
    await openPlan(page, context, "10157", "注記を戻す");
    await placePoint(page, ENEMY_ARMOUR, 7000, 7000);
    await stamps(page).first().click();
    await page.fill("#stamp-note", "装甲2輌");
    await page.click("#stamp-note-save");
    await expect(page.locator("#status")).toContainText("注記を保存しました");

    // 注記の保存は台帳に積まれない（置いた操作が末尾のまま）ので、1回で消える。
    await page.getByRole("button", { name: "取り消す" }).click();
    await expect(stamps(page)).toHaveCount(0);
    await page.getByRole("button", { name: "やり直す" }).click();
    await expect(stamps(page)).toHaveCount(1);
    await expect(page.locator("#stamps .st .st-note")).toHaveText("装甲2輌");
  });
});

// ── 受け入れ条件5 ─────────────────────────────────────────────
//
// **「配置と地名は選べるのにスタンプは選べない」にしない。**
// 枠で囲う操作の期待は「見えている物をまとめて」なので、1種類だけ外れていると
// 「壊れている」と読まれる。

test.describe("範囲選択", () => {
  const selectTool = async (page) => {
    const btn = page.getByRole("button", { name: "範囲選択" });
    await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", "true");
  };

  /** 建造物を1件置く（パレットは「スタンプ」を開くと閉じるので、毎回開き直す）。 */
  async function placeItem(page, itemId, x, y) {
    const before = await page.locator("#placements .pm").count();
    const palette = page.locator("#palette");
    if (!(await palette.isVisible())) {
      await page.getByRole("button", { name: "建造物" }).click();
    }
    await expect(palette).toBeVisible();
    const item = page.locator(`#palette .pal-item[data-item-id="${itemId}"]`);
    const group = page.locator(`#palette .pal-group:has(.pal-item[data-item-id="${itemId}"])`);
    if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
    await item.click();
    const at = await boardPoint(page, x, y);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator("#placements .pm")).toHaveCount(before + 1);
    await page.keyboard.press("Escape");
  }

  async function placeCallout(page, x, y) {
    const before = await page.locator("#callouts .co").count();
    await page.getByRole("button", { name: "地名を置く" }).click();
    const at = await boardPoint(page, x, y);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator("#callouts .co")).toHaveCount(before + 1);
    await page.keyboard.press("Escape");
  }

  async function band(page, from, to) {
    const a = await boardPoint(page, from.x, from.y);
    const b = await boardPoint(page, to.x, to.y);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();
  }

  test("枠で配置・地名・スタンプを混ぜて選べて、まとめて消せる", async ({ page, context }) => {
    await openPlan(page, context, "10158", "枠でスタンプ");
    await placeItem(page, "fob", 4000, 8000);
    await placeCallout(page, 5000, 8000);
    await placePoint(page, SQUARE, 6000, 8000);
    await placePoint(page, ENEMY_ARMOUR, 7000, 8000);
    await drawVector(page, ARROW_OWN, { x: 8000, y: 8000 }, { x: 8000, y: 11000 });
    // 枠の外に1件（囲っていないものが入らないことの確認）。
    await placePoint(page, CIRCLE, 15000, 2000);

    await selectTool(page);
    await band(page, { x: 3000, y: 7000 }, { x: 9000, y: 9000 });

    // 5件（配置1・地名1・スタンプ3）が選ばれている。
    await expect(page.locator("#placement-detail")).toContainText("5件を選択");
    await expect(page.locator("#stamps .st[data-picked]")).toHaveCount(3);
    await expect(page.locator("#placements .pm[data-picked]")).toHaveCount(1);
    await expect(page.locator("#callouts .co[data-picked]")).toHaveCount(1);

    await page.click("#picked-delete");
    await expect(page.locator("#status")).toContainText("5件を消しました");
    // 枠の外のスタンプだけが残る。
    await expect(stamps(page)).toHaveCount(1);
    await expect(page.locator("#placements .pm")).toHaveCount(0);
    await expect(page.locator("#callouts .co")).toHaveCount(0);
  });

  test("枠で選んだスタンプをまとめて動かせる（向きを持つものも崩れない）",
    async ({ page, context }) => {
      const planId = await openPlan(page, context, "10159", "枠でまとめて動かす");
      await placePoint(page, SQUARE, 4000, 8000);
      await placePoint(page, TRIANGLE, 5000, 8000);
      await drawVector(page, LINE_ENEMY, { x: 6000, y: 8000 }, { x: 6000, y: 10000 });

      await selectTool(page);
      await band(page, { x: 3000, y: 7000 }, { x: 7000, y: 11000 });
      await expect(page.locator("#placement-detail")).toContainText("3件を選択");

      // 選んだもののどれかを掴んでまとめて運ぶ。
      const grab = await boardPoint(page, 4000, 8000);
      const drop = await boardPoint(page, 10000, 8000);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(drop.x, drop.y, { steps: 8 });
      await page.mouse.up();
      await expect(page.locator("#status")).toContainText("3件を動かしました");

      const body = await (await context.request.get(
        planUrl(`/api/sessions/${planId}/stamps`)
      )).json();
      // 向きを持つものは**両端が同じだけ**動いている（片側だけだとサーバが 400）。
      const vector = body.stamps.find((r) => r.x2_m !== null);
      expect(Math.abs(vector.x2_m - vector.x_m), "縦の線が斜めになった").toBeLessThan(1);
      // 3件とも右へ 6000 ぶん寄っている。
      for (const row of body.stamps) expect(row.x_m).toBeGreaterThan(9000);
    });
});

// ── 受け入れ条件6（D-069 の仕組みに相乗り。**通数を増やさない**）──────────
//
// スタンプを運んでいる最中が相手の画面に出ること、そして **1.5秒動かしたときの
// 送信通数が、ただマウスを振ったときと同じ**こと。
//
// `cur` の `d` に1文字（`s`）足しただけで、新しい種類の通は作っていない。
// 向きを持つスタンプも**始点1組しか載せない**（終点は受け取る側が同じだけずらす）。
//
// **2枚のタブは同じアカウントで**（D-068）。

test.describe("運んでいる最中", () => {
  /** ゆっくり掴んで動かす（離さない）。plan-carry.spec.js と同じ手順。 */
  async function grabAndDrag(page, from, to, { steps = 12, pause = 120 } = {}) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      await page.waitForTimeout(pause);
    }
  }

  const translateXOf = (page) => page.locator("#stamps .st").evaluate((el) => {
    const m = el.getAttribute("transform")?.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
    return m ? Number(m[1]) : null;
  });

  test("もう片方のタブで、スタンプが運ばれている最中が見える", async ({ browser }) => {
    const ctx = await browser.newContext();
    await loginViaApi(ctx, "10160", "スタンプを運ぶ人");
    const planId = await createPlan(ctx, "スタンプを運ぶ");

    const pageA = await ctx.newPage();
    await pageA.goto(planUrl(`/plan?id=${planId}`));
    await expect(pageA.locator("#stamppanel .st-item")).toHaveCount(25);
    await showWholeMap(pageA);
    const pageB = await ctx.newPage();
    await pageB.goto(planUrl(`/plan?id=${planId}`));
    await expect(pageB.locator("#board")).toBeVisible();
    await showWholeMap(pageB);
    await expect(pageA.locator("#presence .pres-chip")).toHaveCount(1);
    await expect(pageB.locator("#presence .pres-chip")).toHaveCount(1);
    await pageA.bringToFront();

    await placePoint(pageA, ENEMY_ARMOUR, 5000, 5000);
    await expect(pageB.locator("#stamps .st")).toHaveCount(1);

    const from = await boardPoint(pageA, 5000, 5000);
    const to = await boardPoint(pageA, 12000, 5000);
    await grabAndDrag(pageA, from, to, { steps: 10, pause: 120 });

    // **離す前に**相手の画面で動いている（落としてから動くのが R1 の挙動）。
    await expect
      .poll(() => translateXOf(pageB), { timeout: 5000 })
      .toBeGreaterThan(9000);
    // 運んでいる人の色で縁取られている。
    await expect(pageB.locator("#stamps .st[data-carry]")).toHaveCount(1);

    await pageA.mouse.up();
    // 落としたあとは両方の座標が一致して、縁取りが外れる。
    await expect(pageB.locator("#stamps .st[data-carry]")).toHaveCount(0);
    await expect.poll(() => translateXOf(pageB), { timeout: 8000 }).toBeGreaterThan(11000);

    await ctx.close();
  });

  test("1.5秒ドラッグしたときの通数が、ただ振ったときと変わらない", async ({ browser }) => {
    const ctx = await browser.newContext();
    await loginViaApi(ctx, "10161", "スタンプをかぞえる人");
    const planId = await createPlan(ctx, "スタンプの通数");
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__sent = [];
      const orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) {
        const s = String(d);
        if (s.includes('"cur"')) window.__sent.push({ at: Date.now(), carry: s.includes('"d"') });
        return orig.call(this, d);
      };
    });
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#stamppanel .st-item")).toHaveCount(25);
    await showWholeMap(page);
    await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

    await placePoint(page, SQUARE, 5000, 5000);

    const from = await boardPoint(page, 5000, 5000);
    const to = await boardPoint(page, 12000, 11000);

    /** **まったく同じ動き**を、ボタンを押しているかどうかだけ変えて回す。 */
    async function measure(hold) {
      await page.mouse.move(from.x, from.y);
      await page.waitForTimeout(500);
      await page.evaluate(() => { window.__sent.length = 0; });
      const started = Date.now();
      if (hold) await page.mouse.down();
      for (let i = 1; i <= 12; i += 1) {
        const t = i / 12;
        await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
        await page.waitForTimeout(120);
      }
      const endedAt = Date.now();
      if (hold) await page.mouse.up();
      // 止まったあとの1通（settler）と、保存が片付いたあとの1通を拾い切る。
      await page.waitForTimeout(900);
      const sent = await page.evaluate(() => window.__sent);
      return { sent, movedMs: endedAt - started, endedAt };
    }

    const wave = await measure(false);
    const drag = await measure(true);

    const hz = (m) => (m.sent.length / (m.movedMs / 1000)).toFixed(1);
    const tail = (m) => m.sent.filter((s) => s.at > m.endedAt).length;
    console.log(
      `受け入れ条件6: ただ振る ${wave.sent.length}通 / ${wave.movedMs}ms = ${hz(wave)}Hz`
      + `（うち末尾 ${tail(wave)}通）`
    );
    console.log(
      `受け入れ条件6: スタンプを運びながら ${drag.sent.length}通 / ${drag.movedMs}ms`
      + ` = ${hz(drag)}Hz（うち末尾 ${tail(drag)}通 / 運んでいる印つき`
      + ` ${drag.sent.filter((s) => s.carry).length}通）`
    );

    // **末尾は1通ずつで揃っている**（「運ぶのをやめた」が流れに上乗せされていない）。
    expect(tail(drag)).toBe(tail(wave));
    expect(tail(drag)).toBe(1);
    // 総数も増えていない（実時間の間引きなので 1通ぶんは揺れる）。
    expect(drag.sent.length).toBeLessThanOrEqual(wave.sent.length + 1);
    // D-069 / D-073 の実測（1.5秒で 12〜13通 / 7.9〜8.5Hz）と同じところ。
    expect(Number(hz(drag))).toBeLessThan(15);
    // 運んでいる印が本当に乗っていた（計測が空振りしていない）ことの念押し。
    expect(drag.sent.filter((s) => s.carry).length).toBeGreaterThanOrEqual(5);
    // ただ振ったときに印は1通も乗らない。
    expect(wave.sent.filter((s) => s.carry)).toEqual([]);

    // 切断されていない（毎秒30通の線に当たっていない）。
    await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

    await ctx.close();
  });
});
