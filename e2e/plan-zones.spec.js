// コントロールエリアのプリセット（ゲームが決めた円）と、座標の持ち出し。
//
// 守りたいのは6つ。
//   1. **座標が主役**になっている（セル名より大きく、ゲーム画面と同じ形）
//   2. **座標をクリップボードにコピーできる**。右クリックと `c` キーの両方
//   3. admin が座標2つを打つと、**その場で盤面に円が出る**（保存前に確かめられる）
//   4. 作戦で円を選ぶと、**円と、円の中のタワーの強調と、本数**が出る
//   5. **リロードしても残る**
//   6. 切り替えは**フッターのボタンを増やさずに**できる（D-037）
//
// **ここで使う座標は実データではない。** プリセットの中心はオーナーが実機で
// 読んで入れるもので、こちらが埋めてよい値ではない（調査 §5.3）。
// タワーの座標（map_towers、MIT 由来）だけは本物なので、「この中心・この半径なら
// 何本入るか」は幾何で決まる。そこを検算に使う。
import { test, expect } from "@playwright/test";

import {
  PLAN_BASE_URL, boardPoint, chooseOption, choiceOptions, chosenValue,
  createPlan, execD1, loginViaApi, planUrl, showWholeMap,
} from "./plan-helpers.js";

/**
 * Bakurani の5本（schema.sql の map_towers）の重心。半径 500m で**5本とも入る**。
 * tests/plan-zones-geom.test.js が同じ数字で幾何を確かめている。
 */
const ALL_FIVE = { x: 79.84, y: 70.63 };

/**
 * Tower 3 の足元。半径 300m だと**その1本だけ**が入る
 * （次に近い Tower 2 でも 342m）。「本数が幾何で変わる」ことを見るための値。
 */
const ONLY_ONE = { x: 76.89, y: 73.15, radius: 300 };

async function openPlan(page, context, discordId, name, { asAdmin = false } = {}) {
  await loginViaApi(context, discordId, name);
  if (asAdmin) {
    // 権限を上げる導線は UI に作らない（作ると本番にも出てしまう）ので DB を直接触る。
    execD1(`UPDATE users SET role = 'admin' WHERE discord_id = '${discordId}'`);
    // 効いたことをページを開く前に確かめる。効いていないまま進むと
    // 「管理者の欄が出ない」という別の失敗に化けて原因が読めなくなる。
    const me = await context.request.get(planUrl("/api/me"));
    expect((await me.json()).user.role, "admin に上げられていない").toBe("admin");
  }
  const planId = await createPlan(context, name);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator("#towers .tw")).toHaveCount(5);
  // マップ座標で位置を指すので、まずマップ全体が見える状態にする
  // （開いた直後は地図が画面を埋めていて、外周は画面の外にいる）。
  await showWholeMap(page);
  return planId;
}

/**
 * エリアの引き出し（コントロールエリアの一画もこの中にある）を開く。
 *
 * **カタログの到着を先に待つ。** 左の引き出しは1枚しか開かない決まりで、
 * 広い画面ではカタログが届いた時点でパレットが自動で開く。待たずに開けると、
 * 後から開いたパレットにこちらが畳まれて「欄が見えない」形で落ちる（実測）。
 */
async function openZonePanel(page) {
  await expect(page.locator("#palette .pal-item").first()).toBeAttached();
  const panel = page.locator("#zonepanel");
  if (!(await panel.isVisible())) {
    await page.getByRole("button", { name: "円とマス", exact: true }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

/** 管理者の入力欄を開く。 */
async function openZoneAdmin(page) {
  const admin = page.locator("#zone-admin");
  await expect(admin).toBeVisible();
  if (!(await admin.evaluate((el) => el.open))) await admin.locator("> summary").click();
  return admin;
}

/**
 * **保存済み（実線）の円**だけを指す。
 *
 * 破線のプレビューも `.zp` / `.zp-name` / `.zp-ring` を持っているので、素の
 * `#zone-preset .zp` で数えると「保存が終わる前」に数が合ってしまう。実測では
 * それで保存を待たずに次の操作へ進み、同じ識別子で2回目の POST を投げて
 * 409 になっていた。
 */
const savedZone = (page) => page.locator("#zone-preset .zp:not(.zp-preview)");

/** 欄を埋める（半径は既定のまま使うことが多いので省略できる）。 */
async function fillPreset(page, { key, x, y, radius }) {
  if (key !== undefined) await page.locator("#zp-key").fill(key);
  await page.locator("#zp-x").fill(String(x));
  await page.locator("#zp-y").fill(String(y));
  if (radius !== undefined) await page.locator("#zp-radius").fill(String(radius));
}

test.describe("座標を主役にする", () => {
  test("座標のほうがセル名より大きく、ゲームと同じ形で出る", async ({ page, context }) => {
    await openPlan(page, context, "9601", "zone-readout");

    const at = await boardPoint(page, 8000, 7000);
    await page.mouse.move(at.x, at.y);
    const readout = page.locator("#readout");
    await expect(readout).toBeVisible();

    // ゲーム画面と同じ形（`x78.67 y71.62`）。
    await expect(readout.locator(".xy")).toHaveText(/^x\d+\.\d{2} y\d+\.\d{2}$/);
    // セル名は残っているが、添えるだけ。
    await expect(readout.locator(".cell")).toHaveText(/^\s*[A-P]\d{1,2}$/);

    const sizeOf = (sel) =>
      page.locator(sel).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const xy = await sizeOf("#readout .xy");
    const cell = await sizeOf("#readout .cell");
    expect(xy, `座標 ${xy}px / セル名 ${cell}px`).toBeGreaterThan(cell);

    // 等幅と桁揃えは維持する（design-system.md「グリッド参照の等幅タイポ」）。
    const font = await page
      .locator("#readout .xy")
      .evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase());
    expect(font).toContain("mono");
    const numeric = await page
      .locator("#readout .xy")
      .evaluate((el) => getComputedStyle(el).fontVariantNumeric);
    expect(numeric).toContain("tabular-nums");
  });

  test("右クリックで、見えている座標がそのままクリップボードに入る", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: PLAN_BASE_URL,
    });
    await openPlan(page, context, "9602", "zone-copy");

    const at = await boardPoint(page, 8000, 7000);
    await page.mouse.click(at.x, at.y, { button: "right" });

    // 「見えている値」と「コピーされる値」が同じであること自体が守りたい性質。
    const shown = await page.locator("#readout .xy").textContent();
    const [gx, gy] = shown.match(/[\d.]+/g);

    // ゲームの「座標をマーク」がチャットに流す形（📍 x70.47, y99.03）。
    const expected = `📍 x${gx}, y${gy}`;
    await expect(page.locator("#status")).toContainText(`コピーしました: ${expected}`);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(expected);
  });

  test("c キーでもコピーできる（キーボードだけでも届く）", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: PLAN_BASE_URL,
    });
    await openPlan(page, context, "9603", "zone-copy-key");

    const at = await boardPoint(page, 9000, 6500);
    await page.mouse.move(at.x, at.y);
    const shown = await page.locator("#readout .xy").textContent();
    const [gx, gy] = shown.match(/[\d.]+/g);

    await page.keyboard.press("c");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(`📍 x${gx}, y${gy}`);
  });

  test("右クリックは既存の操作を壊さない（置かない・消さない・パンしない）", async ({
    page, context,
  }) => {
    await context.grantPermissions(["clipboard-write"], { origin: PLAN_BASE_URL });
    await openPlan(page, context, "9604", "zone-copy-safe");

    const before = await page.locator("#board").getAttribute("viewBox");
    const at = await boardPoint(page, 8000, 7000);
    await page.mouse.click(at.x, at.y, { button: "right" });

    // 何も置かれていない・線も引かれていない・視野も動いていない。
    await expect(page.locator("#placements .pm")).toHaveCount(0);
    await expect(page.locator("#ink path")).toHaveCount(0);
    expect(await page.locator("#board").getAttribute("viewBox")).toBe(before);
    // ブラウザ既定のメニューは出さない（preventDefault している）。
    await expect(page.locator("#status")).toContainText("コピーしました");
  });
});

test.describe("コントロールエリアのプリセット", () => {
  test("管理者でなければ登録の入り口が出ない", async ({ page, context }) => {
    await openPlan(page, context, "9610", "zone-member");
    await openZonePanel(page);
    await expect(page.locator("#zone-admin")).toBeHidden();
    // 選ぶ側の欄は出る（プリセットが増えたら誰でも選べる）。
    // この作戦ではまだ選んでいないので、円も強調も無い。
    await expect(page.locator("#zone-preset-select")).toBeVisible();
    expect(await chosenValue(page, "zone-preset-select"), "まだ選んでいない").toBe("");
    await expect(savedZone(page)).toHaveCount(0);
    await expect(page.locator('#towers .tw[data-live="1"]')).toHaveCount(0);
    await expect(page.locator("#zone-preset-info")).toContainText("パターン");
  });

  test("座標2つを打つとその場で円が出て、保存すると実線になる", async ({ page, context }) => {
    await openPlan(page, context, "9611", "zone-admin-input", { asAdmin: true });
    await openZonePanel(page);
    await openZoneAdmin(page);

    // **半径はマップごとの既定が最初から入っている**（Bakurani は 500m）。
    await expect(page.locator("#zp-radius")).toHaveValue("500");

    // まだ何も出ていない。
    await expect(page.locator("#zone-preset .zp")).toHaveCount(0);

    await fillPreset(page, { key: "Default", ...ALL_FIVE });

    // **打った瞬間に破線の円が出る。**保存する前に位置を目で確かめられる。
    const preview = page.locator("#zone-preset .zp-preview");
    await expect(preview).toHaveCount(1);
    const r = await preview.locator(".zp-ring").getAttribute("r");
    expect(Number(r), "実寸（メートル）で描く").toBe(500);
    // 中心は打った座標そのもの（1 = 100m）。y は SVG 側で上下が反転する。
    const cx = Number(await preview.locator(".zp-ring").getAttribute("cx"));
    expect(cx).toBeCloseTo(ALL_FIVE.x * 100, 1);

    // 保存前はタワーの強調が動かない（打ち間違いを確定した事実に見せない）。
    await expect(page.locator('#towers .tw[data-live="1"]')).toHaveCount(0);

    await page.locator("#zp-save").click();

    // 保存したら実線になり、そのまま「想定するパターン」になる。
    await expect(page.locator("#zone-preset .zp:not(.zp-preview)")).toHaveCount(1);
    await expect(page.locator("#zone-preset .zp-preview")).toHaveCount(0);
    await expect(savedZone(page).locator(".zp-name")).toHaveText("Default");
    expect(await chosenValue(page, "zone-preset-select"), "保存したものが選ばれている").toBeTruthy();
  });

  test("円の中のタワーが強調され、本数が出る（幾何で決まる）", async ({ page, context }) => {
    await openPlan(page, context, "9612", "zone-live-towers", { asAdmin: true });
    await openZonePanel(page);
    await openZoneAdmin(page);

    // 5本の重心・半径500m → 5本とも円の中。
    await fillPreset(page, { key: "All", ...ALL_FIVE });
    await page.locator("#zp-save").click();
    await expect(page.locator('#towers .tw[data-live="1"]')).toHaveCount(5);
    await expect(page.locator("#zone-preset-info")).toContainText("対象のドリルタワー 5本");

    // Tower 3 の足元・半径300m → 1本だけ。**同じ盤面で本数が変わる。**
    await chooseOption(page, "zp-target", { value: "" });
    await fillPreset(page, { key: "Tight", x: ONLY_ONE.x, y: ONLY_ONE.y, radius: ONLY_ONE.radius });
    await page.locator("#zp-save").click();
    await expect(page.locator('#towers .tw[data-live="1"]')).toHaveCount(1);
    await expect(page.locator("#zone-preset-info")).toContainText("対象のドリルタワー 1本");

    // 強調されているのは Tower 3（円の中にあるのはこれだけ）。
    await expect(page.locator('#towers .tw[data-live="1"]'))
      .toHaveAttribute("data-tower-id", "bakurani-t3");

    // 選び直すと元に戻る（選択が円と強調の唯一の持ち主）。
    await chooseOption(page, "zone-preset-select", { label: "All" });
    await expect(page.locator('#towers .tw[data-live="1"]')).toHaveCount(5);
  });

  // オーナー指摘（2026-10-01）:
  //   > どのプリセットを選んでも、全タワーが有効になっているように見えます。
  //   > 有効のものだけ表示でお願いしたいです
  //
  // 「円の中だけ強調」では、9パターンぶんの座標を入れた意味が画面に出ていなかった。
  // **パターンを選んだら、その試合で戦わないタワーは出さない。**
  // 選んでいない間はどれが対象か決まらないので、従来どおり全部出す。
  test("パターンを選ぶと、円の中のタワーだけが残る（円外は出さない）", async ({ page, context }) => {
    const planId = await openPlan(page, context, "9619", "zone-only-live", { asAdmin: true });
    await openZonePanel(page);
    await openZoneAdmin(page);

    const shown = page.locator("#towers .tw:not([hidden])");
    const gone = page.locator("#towers .tw[hidden]");

    // 選ぶ前は5本とも出ている。
    // （文言はこのあと「選択を外す」ところで確かめる。ここでの `#zone-preset-info` は
    //  このファイルの実行順によって「まだ登録されていません」になりうる。）
    await expect(shown).toHaveCount(5);
    await expect(gone).toHaveCount(0);

    // Tower 3 の足元・半径300m → 1本だけ。残り4本は**消える**。
    await fillPreset(page, { key: "OnlyOne", x: ONLY_ONE.x, y: ONLY_ONE.y, radius: ONLY_ONE.radius });
    await page.locator("#zp-save").click();
    await expect(savedZone(page)).toHaveCount(1);
    await expect(shown).toHaveCount(1);
    await expect(shown).toHaveAttribute("data-tower-id", "bakurani-t3");
    await expect(gone).toHaveCount(4);
    await expect(page.locator("#zone-preset-info")).toContainText("対象のドリルタワー 1本");

    // **切り替えた瞬間に変わる。** 5本入る円を作って選び直すと5本に戻る。
    await chooseOption(page, "zp-target", { value: "" });
    await fillPreset(page, { key: "AllFive", x: ALL_FIVE.x, y: ALL_FIVE.y, radius: 500 });
    await page.locator("#zp-save").click();
    await expect(shown).toHaveCount(5);
    await expect(gone).toHaveCount(0);
    await expect(page.locator("#zone-preset-info")).toContainText("対象のドリルタワー 5本");

    // 選び直し（押すだけ）でも即座に変わる。
    await chooseOption(page, "zone-preset-select", { label: "OnlyOne" });
    await expect(shown).toHaveCount(1);
    await expect(gone).toHaveCount(4);

    // リロードしても絞られたまま（次に開いたときも0手で「対象だけ」が見える）。
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#towers .tw:not([hidden])")).toHaveCount(1);

    // 選択を外すと全部に戻る。**なぜ全部出ているのかが文で読める**こと。
    await openZonePanel(page);
    await chooseOption(page, "zone-preset-select", { value: "" });
    await expect(savedZone(page)).toHaveCount(0);
    await expect(page.locator("#towers .tw:not([hidden])")).toHaveCount(5);
    await expect(page.locator("#zone-preset-info")).toContainText("全部出しています");
  });

  test("選んだ円はリロードしても残る", async ({ page, context }) => {
    const planId = await openPlan(page, context, "9613", "zone-reload", { asAdmin: true });
    await openZonePanel(page);
    await openZoneAdmin(page);
    await fillPreset(page, { key: "Keep", ...ALL_FIVE });
    await page.locator("#zp-save").click();
    await expect(savedZone(page).locator(".zp-name")).toHaveText("Keep");

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(savedZone(page).locator(".zp-name")).toHaveText("Keep");
    await expect(page.locator('#towers .tw[data-live="1"]')).toHaveCount(5);
    await openZonePanel(page);
    await expect(page.locator("#zone-preset-info")).toContainText("対象のドリルタワー 5本");
    expect(planId).toBeTruthy();
  });

  // **以前ここが壊れていたのは見た目ではなく言葉だった。** 白い実線の円も
  // 緑の点描のマスも「コントロールエリア」で、同じ画面に並んでいた
  // （shots/28-zone-vs-areas-*.png）。見た目を3軸で分けても、Discord で
  // 「コントロールエリアが〜」と言った瞬間にどちらの話か決まらない。
  // 種類の名前をチームの語彙に貼り替えたので、**言葉も見た目も重ならない**ことを見る。
  test("マス塗りと円は、指す言葉も見た目も重ならない", async ({ page, context }) => {
    await openPlan(page, context, "9614", "zone-vs-areas", { asAdmin: true });
    const panel = await openZonePanel(page);
    await openZoneAdmin(page);
    await fillPreset(page, { key: "Both", ...ALL_FIVE });
    await page.locator("#zp-save").click();
    await expect(savedZone(page)).toHaveCount(1);

    // チームの塗り（最重要のマス）を並べて出す。
    await openZonePanel(page);
    await panel.locator('button[data-kind="key"]').click();
    const a = await boardPoint(page, 2500, 2500);
    const b = await boardPoint(page, 4500, 4500);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('#areas .area[data-kind="key"]'))
      .toHaveAttribute("data-cells", "9");

    // 1. 盤面に出る文字が重ならない。円はプリセット名、マスは種類名で、
    //    **どちらも「コントロールエリア」ではない。**
    await expect(savedZone(page).locator(".zp-name")).toHaveText("Both");
    // SVG の <text> は HTMLElement ではないので innerText を持たない
    // （allInnerTexts() は undefined の配列になる）。textContent で読む。
    expect(await page.locator("#areas .area-name").allTextContents()).toEqual(["最重要"]);

    // 2. 描き分けの実体: 円は <circle>（半径を実寸のメートルで持つ）、
    //    塗りは <path>（1km の格子に載る。3×3 = 9 個の部分パス）。
    await expect(savedZone(page).locator(".zp-ring")).toHaveAttribute("r", "500");
    const d = await page
      .locator('#areas .area[data-kind="key"] .area-fill')
      .getAttribute("d");
    expect(d.match(/M/g)).toHaveLength(9);

    // 3. 色も別。塗りは種別色、円は無彩色（--ink）。
    const ringColor = await savedZone(page)
      .locator(".zp-ring")
      .evaluate((el) => getComputedStyle(el).stroke);
    const areaColor = await page
      .locator('#areas .area[data-kind="key"] .area-edge')
      .evaluate((el) => getComputedStyle(el).stroke);
    expect(ringColor).not.toBe(areaColor);

    // 4. パネルの言葉でも切れている。マス塗りは「チームの見立て」、
    //    円は「ゲームが決める」。
    await expect(page.locator("#zk-head")).toContainText("チームの見立て");
    await expect(page.locator("#zp-head")).toContainText("ゲームが決める");

    // 円は押せない（地図が持っている物。タワー・スポーンと同じ扱い）。
    const events = await page
      .locator("#zone-preset")
      .evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(events).toBe("none");
  });

  test("円の表示を切れる。フッターのボタンは増えていない", async ({ page, context }) => {
    await openPlan(page, context, "9615", "zone-toggle", { asAdmin: true });
    await openZonePanel(page);
    await openZoneAdmin(page);
    await fillPreset(page, { key: "Toggle", ...ALL_FIVE });
    await page.locator("#zp-save").click();
    await expect(savedZone(page)).toHaveCount(1);

    const toggle = page.getByRole("button", { name: "円を表示" });
    // 切り替えはフッターに出ていない（引き出しの中にある）。
    expect(await toggle.evaluate((el) => !!el.closest("footer"))).toBe(false);

    await toggle.click();
    await expect(page.locator("#zone-preset")).toHaveAttribute("hidden", "");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await toggle.click();
    await expect(page.locator("#zone-preset")).not.toHaveAttribute("hidden", /.*/);
  });

  test("管理者は円を直せる・消せる", async ({ page, context }) => {
    await openPlan(page, context, "9616", "zone-edit", { asAdmin: true });
    await openZonePanel(page);
    await openZoneAdmin(page);
    await fillPreset(page, { key: "Fix", ...ALL_FIVE });
    await page.locator("#zp-save").click();
    await expect(savedZone(page).locator(".zp-ring")).toHaveCount(1);

    // 半径を縮める → 対象のタワーが減る（幾何がそのまま画面に出る）。
    // 破線（未保存）と実線（保存済み）を混ぜて数えないよう、実線だけを見る。
    await page.locator("#zp-radius").fill("200");
    await expect(page.locator("#zone-preset .zp-preview .zp-ring")).toHaveAttribute("r", "200");
    await page.locator("#zp-save").click();
    await expect(page.locator("#zone-preset .zp-preview")).toHaveCount(0);
    await expect(page.locator("#zone-preset .zp:not(.zp-preview) .zp-ring"))
      .toHaveAttribute("r", "200");
    await expect(page.locator("#zone-preset-info")).toContainText("半径 200m");

    // 消すと、円も強調も選択肢も無くなる。
    // **プリセットはマップ静的**（作戦ごとではない）ので、同じ実行の他のテストが
    // 入れたものは残っている。「0件になる」ではなく「この円が消える」を見る。
    await page.locator("#zp-delete").click();
    await expect(savedZone(page)).toHaveCount(0);
    await expect(page.locator('#towers .tw[data-live="1"]')).toHaveCount(0);
    await expect(choiceOptions(page, "zone-preset-select").filter({ hasText: "Fix" }))
      .toHaveCount(0);
    await expect(page.locator("#zone-preset-info")).toContainText("まだ選んでいません");
  });

  // D-037: 「実装した」と「使える」は別。実機相当の幅でも到達できること。
  test.describe("狭い画面（390x844）", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("狭い画面でも円を登録して選べる", async ({ page, context }) => {
      await openPlan(page, context, "9617", "zone-narrow", { asAdmin: true });
      await openZonePanel(page);
      await openZoneAdmin(page);

      const key = page.locator("#zp-key");
      await key.scrollIntoViewIfNeeded();
      const box = await key.boundingBox();
      expect(box.height, "欄の高さ").toBeGreaterThanOrEqual(44);

      await fillPreset(page, { key: "Narrow", ...ALL_FIVE });
      const save = page.locator("#zp-save");
      await save.scrollIntoViewIfNeeded();
      await save.click();
      await expect(savedZone(page).locator(".zp-name")).toHaveText("Narrow");
      await expect(page.locator('#towers .tw[data-live="1"]')).toHaveCount(5);
    });

    // 狭い画面では座標表示と縮尺が**同じ段**に並ぶ（下は詳細パネルが占めるので
    // 両方とも上へ逃がしてある）。「右クリックでコピー」の案内を横に足すと
    // そこで縮尺にぶつかる。実測で 390px でぶつかったので、案内は下の行へ
    // 折り返してある。§8「同じ隅に2つ置かない」を狭い画面でも守る。
    test("座標表示に案内が付いても、縮尺とぶつからない", async ({ page, context }) => {
      await openPlan(page, context, "9618", "zone-narrow-readout");
      const at = await boardPoint(page, 8000, 8000);
      await page.mouse.move(at.x, at.y);
      await expect(page.locator("#readout")).toBeVisible();
      await expect(page.locator("#readout .copyhint")).not.toBeEmpty();

      const scale = await page.locator("#scalebar").boundingBox();
      const readout = await page.locator("#readout").boundingBox();
      const overlaps =
        scale.x < readout.x + readout.width && readout.x < scale.x + scale.width &&
        scale.y < readout.y + readout.height && readout.y < scale.y + scale.height;
      expect(overlaps, "縮尺と座標表示が重なっている").toBe(false);
      // 画面の外へはみ出してもいない。
      expect(readout.x, "左に溢れている").toBeGreaterThanOrEqual(0);
      expect(readout.x + readout.width, "右に溢れている").toBeLessThanOrEqual(390);
    });
  });
});
