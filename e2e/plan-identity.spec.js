// 「誰がいるか」が画面から読めること、そして**どの画面でも同じ配色に見えること**。
//
// オーナー指摘（2026-10-01、D-050 の積み残し）:
//   > 右上のDって何ですか・・・画面の前後で配色がかなり違います
//
// 実測して分かった原因は2つとも別物だった。
//
// 1. **畳んだアカウントのボタンは、意図して1文字に切っていた。**
//    `app.js` が `[...name][0]` を入れていたので、幅や text-overflow は無関係。
//    `#account-name` の scrollWidth === clientWidth（＝溢れていない）で、
//    中身がそもそも "D" だった。
//
// 2. **在室の粒は幅で切れていた。** `.pres-chip{max-width:18ch}`（108px）の中で、
//    `（あなた）` が `white-space:nowrap` ゆえ min-content = 55px を手放さず、
//    `min-width:0` を持つ `.pres-name` だけが潰れていた。
//    実測: 1920px で `.pres-name` は clientWidth 21px / scrollWidth 43px。
//    「DAICON」が「D…」になっていた。
//
// 3. **配色**: 盤面は `--void`（#0B0E11）の地に濃い HUD、一覧は `--paper`
//    （ライトでは #E4E7EA）の白地で、同じサイトに見えなかった。
//
// ここはその3つを機械で押さえる。
import { test, expect } from "@playwright/test";

import { contrast, createPlan, loginViaApi, planUrl } from "./plan-helpers.js";

/** `[セレクタ, 読む色, 背景のセレクタ]` の組を、計算済みの色の組に変える。 */
const readColors = (page, pairs) =>
  page.evaluate(
    (list) =>
      list.map(([sel, prop, bgSel]) => [
        getComputedStyle(document.querySelector(sel))[prop],
        getComputedStyle(document.querySelector(bgSel)).backgroundColor,
      ]),
    pairs
  );

async function openBoard(page, context, id, name, title = name) {
  await loginViaApi(context, id, name);
  const planId = await createPlan(context, title);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  return planId;
}

/**
 * 要素の「見えている幅」と「溢れている幅」。
 *
 * **必ず expect.poll で包むこと。** 在室の一覧は `who` が届くたびに
 * `presence.js` が中身を作り直す（`el.textContent = ""` → 組み直し）ので、
 * locator を解決した直後に古いノードが外れることがある。外れたノードでは
 * `clientWidth` も `getComputedStyle()` も 0 / 空を返すため、1回きりの
 * `evaluate` では偽の 0 を拾う（実測: 8回に1回）。poll なら解決からやり直す。
 */
const sizes = (loc) =>
  loc.evaluate((el) => ({ scrollW: el.scrollWidth, clientW: el.clientWidth }));

/** 見えている幅（px）。溢れていてもここは縮まない。 */
const visibleWidth = (loc) => expect.poll(async () => (await sizes(loc)).clientW);

/** 溢れている量（px）。0 なら1文字も切れていない。 */
const clippedBy = (loc) =>
  expect.poll(async () => {
    const { scrollW, clientW } = await sizes(loc);
    return Math.max(0, scrollW - clientW);
  });

test.describe("自分が誰かが、畳んだボタンから読める", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("畳んだアカウントのボタンに、自分の名前が最後まで出る", async ({ page, context }) => {
    await openBoard(page, context, "9770", "DAICON", "名前が出る");

    const label = page.locator("#account-name");
    await expect(label).toBeVisible();
    // **1文字ではない。** ここが「右上のDって何ですか」の当のもの。
    await expect(label).toHaveText("DAICON");
    await clippedBy(label).toBe(0);
  });

  test("アカウントのメニューだと分かる印が、目で見て出ている", async ({ page, context }) => {
    await openBoard(page, context, "9771", "DAICON", "人型の印");

    // aria-label だけでは「見れば分かる」にならない。人型の図形を出す。
    const icon = page.locator("#account > summary .acct-icon");
    await expect(icon).toBeVisible();
    const box = await icon.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(12);
    expect(box.height).toBeGreaterThanOrEqual(12);

    // 読み上げには「誰の」設定かまで渡す。
    await expect(page.locator("#account > summary")).toHaveAttribute(
      "aria-label", "自分の設定（DAICON）"
    );
  });

  test("長い日本語の名前でも、頭1文字では終わらない", async ({ page, context }) => {
    await openBoard(page, context, "9772", "たかはしけんいちろう", "長い名前");

    const label = page.locator("#account-name");
    // 中身は全文のまま（読み上げと title のため）。見た目だけ省略する。
    await expect(label).toHaveText("たかはしけんいちろう");
    // 13px の日本語は 1文字 13px。4文字ぶん以上は必ず見えること。
    await visibleWidth(label).toBeGreaterThanOrEqual(52);
    // 全文は title から取り返せる。
    await expect(page.locator("#account > summary")).toHaveAttribute("title", "たかはしけんいちろう");
  });

  test("絵文字の名前でも崩れない", async ({ page, context }) => {
    await openBoard(page, context, "9773", "🐶WARDOG🐶", "絵文字の名前");

    await expect(page.locator("#account-name")).toHaveText("🐶WARDOG🐶");
    const box = await page.locator("#account > summary").boundingBox();
    // ヘッダの右の板（最大 560px）を1つで食い潰さない。
    expect(box.width).toBeLessThanOrEqual(260);
  });
});

test.describe("在室の粒から、誰がいるかが読める", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("短い名前は1文字も切れない", async ({ page, context }) => {
    await openBoard(page, context, "9774", "DAICON", "在室の名前");
    await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

    const name = page.locator("#presence .pres-chip[data-me] .pres-name");
    await expect(name).toHaveText("DAICON");
    // ここが「D..（あなた）」の当のもの。前は 43px が 21px に潰れていた。
    await clippedBy(name).toBe(0);
  });

  test("「（あなた）」が名前の場所を食わない", async ({ page, context }) => {
    await openBoard(page, context, "9775", "たかはしけんいちろう", "添え字と名前");
    await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

    const name = page.locator("#presence .pres-chip[data-me] .pres-name");
    // 11px の日本語は 1文字 11px。6文字ぶん以上は必ず見える
    //（「タカハシさんが指してるところ」が成立する最低限）。
    await visibleWidth(name).toBeGreaterThanOrEqual(66);
    // 添え字は変わらず出ている（自分の行であることの二重符号化を壊さない）。
    await expect(page.locator("#presence .pres-chip[data-me] .pres-self"))
      .toHaveText("（あなた）");
    // 省略されても全文は取り返せる。
    await expect(name).toHaveAttribute("title", "たかはしけんいちろう");
  });
});

test.describe("在室の粒から、誰がいるかが読める（狭い画面）", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("狭い画面でも名前が4文字ぶん以上は見える", async ({ page, context }) => {
    await openBoard(page, context, "9776", "たかはしけんいちろう", "狭い在室");
    await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

    const name = page.locator("#presence .pres-chip[data-me] .pres-name");
    await visibleWidth(name).toBeGreaterThanOrEqual(44);
    // 畳んだアカウントのボタンも、名前が読める形で残る。
    const label = page.locator("#account-name");
    await expect(label).toHaveText("たかはしけんいちろう");
    await visibleWidth(label).toBeGreaterThanOrEqual(26);
  });
});

test.describe("どの画面も同じ配色に見える", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  const bodyBg = (page) =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  for (const scheme of ["light", "dark"]) {
    test(`一覧と盤面で地の色が同じ（${scheme}）`, async ({ page, context }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const id = scheme === "light" ? "9777" : "9778";
      await openBoard(page, context, id, `配色${scheme}`, `配色の地続き ${scheme}`);
      const boardBg = await bodyBg(page);

      await page.goto(planUrl("/plan"));
      await expect(page.locator("main.create")).toBeVisible();
      const listBg = await bodyBg(page);

      expect(listBg).toBe(boardBg);
      // マップの外周（--void）と同じ地。ゲームから地続きに見せるための約束。
      expect(listBg).toBe("rgb(11, 14, 17)");
    });
  }

  test("ログイン前の画面も同じ地の色", async ({ browser }) => {
    // Cookie を持たない素のコンテキストで開く（showLoginOnly が走る）。
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(planUrl("/plan"));
    await expect(page.locator("main.gate")).toBeVisible();
    expect(await bodyBg(page)).toBe("rgb(11, 14, 17)");
    await ctx.close();
  });

  test("一覧の文字が濃い地の上で読める（本文 7:1 / 添え字 4.5:1）", async ({ page, context }) => {
    await loginViaApi(context, "9779", "コントラスト");
    // **枠に入る作戦を作る。** パターン未設定だと別区画（.s-extra）に出て
    // `.s-cell` が空のままになる。`zestafona-default` は schema.sql が
    // 必ず入れているので、どのファイルの実行順でも枠が1つ埋まる。
    await createPlan(context, "読みやすさ", "zestafona", "zestafona-default");
    await page.goto(planUrl("/plan"));
    await expect(page.locator("#sessions li")).toHaveCount(1);

    const [title, meta, heading] = await readColors(page, [
      // 作戦の題名（本文）は枠の上。
      ["#sessions .s-title", "color", "#sessions .s-cell[data-state='ready']"],
      // 「たった今」などの添え字。
      ["#sessions .updated", "color", "#sessions .s-cell[data-state='ready']"],
      // 節の見出しは地の上。
      [".sheet h2", "color", "body"],
    ]);

    expect(contrast(...title)).toBeGreaterThanOrEqual(7);
    expect(contrast(...meta)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(...heading)).toBeGreaterThanOrEqual(7);
  });

  test("面が3段ある（地 ＜ 板 ＜ 押せる面、書き込む面は沈む）", async ({ page, context }) => {
    await loginViaApi(context, "9781", "面の段差");
    await createPlan(context, "面の段差", "zestafona", "zestafona-default");
    await page.goto(planUrl("/plan"));
    await expect(page.locator("#sessions li")).toHaveCount(1);
    // 書き込む面（題名の欄）は枠を押すまで出ない（常設フォームをやめたため）。
    await page.locator("#sessions button.s-new").first().click();
    await expect(page.locator("#create-title")).toBeVisible();

    const bg = await page.evaluate(() =>
      Object.fromEntries(
        [
          ["ground", "body"],
          ["panel", "#sessions .s-cell[data-state='ready']"],
          ["raised", "#sessions a.open"],
          ["sunken", "#create-title"],
        ].map(([k, sel]) => [k, getComputedStyle(document.querySelector(sel)).backgroundColor])
      )
    );

    // 押せる面と書き込む面は半透明なので、下の面に重ねてから明るさを比べる。
    const rgba = (s) => {
      const n = s.match(/[\d.]+/g).map(Number);
      return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 };
    };
    /** `fg`（CSSの色）を `under`（[r,g,b] の配列）の上に重ねた色。 */
    const on = (fg, under) => {
      const f = rgba(fg);
      return f.rgb.map((c, i) => f.a * c + (1 - f.a) * under[i]);
    };
    const light = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

    const ground = rgba(bg.ground).rgb;
    const panel = on(bg.panel, ground);
    // **これが「開く」が板に沈んで見えなくなる事故を止める。**
    // `.s-list li a.open` のほうが後に書いてあるので、同じ重みの規則では負ける
    // （実測で一度そうなった）。
    expect(light(on(bg.raised, panel))).toBeGreaterThan(light(panel));
    expect(light(panel)).toBeGreaterThan(light(ground));
    expect(light(on(bg.sunken, panel))).toBeLessThan(light(panel));
  });

  test("押せるものの枠が地から見分けられる（3:1）", async ({ page, context }) => {
    await loginViaApi(context, "9780", "枠のコントラスト");
    await createPlan(context, "枠が見える", "zestafona", "zestafona-default");
    await page.goto(planUrl("/plan"));
    await expect(page.locator("#sessions li")).toHaveCount(1);
    await page.locator("#sessions button.s-new").first().click();
    await expect(page.locator("#create-title")).toBeVisible();

    const edges = await readColors(page, [
      ["#sessions a.open", "borderTopColor", "#sessions .s-cell[data-state='ready']"],
      // 題名の欄は**空いている枠の中**に開く。空の枠は面を敷かない（破線だけ）ので、
      // 欄の枠の後ろにあるのは地そのもの。
      ["#create-title", "borderTopColor", "body"],
      // **空いている枠の破線も地から見分けられること。**
      // 「9つのうちどれが空いているか」を形で読ませる唯一の手掛かりなので、
      // 枠線が地に沈むと機能そのものが消える。
      ["#sessions .s-cell[data-state='empty']", "borderTopColor", "body"],
    ]);

    for (const edge of edges) expect(contrast(...edge)).toBeGreaterThanOrEqual(3);
  });
});
