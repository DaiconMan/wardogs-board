// 目視確認用のスクリーンショット。既定の実行からは外してある
// （playwright.config.js の testIgnore）。`npm run shots` で撮る。
//
// 撮るもの: 1920x1080 と 390x844 の両方で、
//   * 作戦の一覧と作成（?id= 無し）
//   * 盤面（背景3種）
//   * パレットを開いた状態
//   * 配置を選んだ状態（詳細パネル）
// を、ライトとダークの両方。
import { test, expect } from "@playwright/test";

import {
  boardPoint, chooseOption, choiceOptions, createPlan, execD1, loginViaApi, planUrl,
  waitForGrid,
} from "./plan-helpers.js";

const OUT = "shots";

const SIZES = [
  { name: "wide", width: 1920, height: 1080 },
  { name: "narrow", width: 390, height: 844 },
];
const SCHEMES = ["light", "dark"];

async function openPalette(page) {
  const palette = page.locator("#palette");
  // 既定の開閉はカタログが届いてから決まる。中身を待ってから状態を見る。
  await expect(palette.locator(".pal-item").first()).toBeAttached();
  if (!(await palette.isVisible())) {
    await page.getByRole("button", { name: "建造物" }).click();
  }
  await expect(palette).toBeVisible();
}

/** 盤面だけを撮りたいときは畳む（広い画面では既定で開いている）。 */
async function closePalette(page) {
  const palette = page.locator("#palette");
  await expect(palette.locator(".pal-item").first()).toBeAttached();
  if (await palette.isVisible()) {
    await page.getByRole("button", { name: "建造物" }).click();
  }
  await expect(palette).toBeHidden();
}

async function pickAndPlace(page, kind, itemId, x, y, expected = 1) {
  await openPalette(page);
  const group = page.locator(`#palette .pal-group[data-kind="${kind}"]`);
  if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
  await page.locator(`#palette .pal-item[data-item-id="${itemId}"]`).click();
  const p = await boardPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
  await expect(page.locator("#placements .pm")).toHaveCount(expected);
}

/**
 * エリアの引き出しを開く。
 * カタログの到着を先に待つ（左の引き出しは1枚だけなので、後から開くパレットに
 * 畳まれてしまう）。
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

/**
 * エリアの引き出しを畳む。
 * **狭い画面では種類を選んだ時点で app.js が畳んでいる**ことがあるので、
 * 開いているときだけ押す（無条件に押すと「閉じるが見えない」で止まる）。
 */
async function closeZonePanel(page) {
  const panel = page.locator("#zonepanel");
  if (await panel.isVisible()) await page.locator("#zonepanel-close").click();
  await expect(panel).toBeHidden();
}

/** エリアのパネルを開いて、種類を選ぶ（狭い画面では選んだ時点で畳まれる）。 */
async function pickKind(page, kind) {
  const panel = await openZonePanel(page);
  await panel.locator(`button[data-kind="${kind}"]`).click();
}

/** セルの矩形をドラッグで塗る（行は SVG 座標。上が 0）。 */
async function paintCells(page, [c0, r0, c1, r1]) {
  const a = await boardPoint(page, (c0 + 0.5) * 1000, (r0 + 0.5) * 1000);
  const b = await boardPoint(page, (c1 + 0.5) * 1000, (r1 + 0.5) * 1000);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
}

/**
 * 一覧の撮影用に、マップごとのパターンを入れる。
 *
 * 一覧は「マップ × 想定するパターンの**枠の表**」（D-046 の目的3）。
 * パターンが空だと枠が1つも並ばず、**見たいもの（9つのうちどれが埋まって
 * いて、どれが空いているか）が写らない。** 本番に近い数を用意してから撮る。
 * **座標は作り物**（写るのは枠の名前と状態なので、円の位置は問わない）。
 *
 * Bakurani に `Default` を入れないのは、下の「コントロールエリアの円」が
 * 管理者UIから Bakurani の `Default` を登録するので `(map_id, key)` の
 * 一意制約とぶつかるため。
 *
 * 7行は SQL 1文にまとめる（`execD1` は速くなったので回数の制約は無いが、
 * 「撮影用の一式」は1文のほうが読んで分かる）。
 */
function seedShotPatterns() {
  const row = (id, mapId, key, name, sort) =>
    `('${id}', '${mapId}', '${key}', '${name}', 8000, 8000, 550, '撮影用の作り物', 0, ${sort},` +
    ` strftime('%s','now'), strftime('%s','now'))`;
  execD1(
    `INSERT OR IGNORE INTO map_zone_presets
       (id, map_id, key, name, x_m, y_m, radius_m, source, verified, sort_order, created_at, updated_at)
     VALUES ${[
       row("shots-bak-farmland", "bakurani", "Farmland", "Farmland（タワー3が圏外）", 20),
       row("shots-bak-lumber", "bakurani", "Lumberyard", "Lumberyard（タワー1・4・5）", 30),
       row("shots-ozeti-default", "ozeti", "Default", "Default（全タワー）", 10),
       row("shots-ozeti-refinery", "ozeti", "Refinery", "Church（タワー2・3・4）", 20),
       row("shots-ozeti-ridge", "ozeti", "Ridge", "River（タワー1・2）", 30),
       row("shots-zest-two", "zestafona", "Two", "2本型（タワー1・3）", 20),
       row("shots-zest-three", "zestafona", "Three", "3本型（タワー1が中心）", 30),
     ].join(",\n            ")}`
  );
}

async function setBasemap(page, mode) {
  const menu = page.locator("#view-menu");
  if (!(await menu.evaluate((el) => el.open))) await menu.locator("> summary").click();
  await page.locator(`#basemap-modes button[data-basemap="${mode}"]`).click();
  await expect(menu).not.toHaveAttribute("open", "");
}

for (const scheme of SCHEMES) {
  for (const size of SIZES) {
    test.describe(`${scheme}-${size.name}`, () => {
      test.use({ colorScheme: scheme, viewport: { width: size.width, height: size.height } });

      const tag = `${size.name}-${scheme}`;

      // ログイン前。**撮れていなかった画面。** 一覧・盤面と並べて、
      // 3枚とも同じ配色に見えるかを目で確かめるために要る。
      test(`ログイン前 (${tag})`, async ({ browser }) => {
        // Cookie を持たない素のコンテキストで開く（showLoginOnly が走る）。
        const ctx = await browser.newContext({
          colorScheme: scheme,
          viewport: { width: size.width, height: size.height },
        });
        const page = await ctx.newPage();
        await page.goto(planUrl("/plan"));
        await expect(page.locator("main.gate")).toBeVisible();
        await page.screenshot({ path: `${OUT}/00-gate-${tag}.png` });
        await ctx.close();
      });

      test(`一覧と盤面 (${tag})`, async ({ page, context }) => {
        const uid = `93${scheme === "dark" ? 5 : 4}${size.name === "wide" ? 0 : 1}`;

        // 一覧は「マップ × パターン」でまとまる（D-046）ので、パターンが
        // 入っていない一覧を撮ると、見たいものが写らない。実運用の姿
        // （1マップ 3〜4 パターン）に近い状態を作ってから撮る。
        seedShotPatterns();

        // 先に「他人」として2つ作る。あとで開いて訪問履歴に載せる。
        await loginViaApi(context, `${uid}9`, "分隊長カズ");
        const theirs = [
          await createPlan(context, "Ozeti 東の拠点 共有案", "ozeti", "shots-ozeti-ridge"),
          await createPlan(context, "南橋 封鎖の検討（改）"),
        ];

        await loginViaApi(context, uid, "シャッター");

        // いくつか作戦を作って一覧に厚みを出す。**パターン未設定も1つ混ぜる**
        // （既存の作戦は全部これなので、並んだときの見え方を確かめる）。
        const mine = [
          ["Ozeti 高地の抑え", "ozeti", "shots-ozeti-default"],
          ["Ozeti 製油所ルート v2", "ozeti", "shots-ozeti-refinery"],
          ["ゼスタフォナ 初動の型", "zestafona", "zestafona-default"],
          ["南橋 封鎖の検討", "bakurani", null],
        ];
        for (const [title, mapId, presetId] of mine) {
          await createPlan(context, title, mapId, presetId);
        }

        // 共有URLで他人の作戦を開く。GET /api/sessions/{id} が訪問を記録する。
        for (const id of theirs) {
          await page.goto(planUrl(`/plan?id=${id}`));
          await expect(page.locator("#board")).toBeVisible();
          await expect(page.locator("#title")).not.toHaveText("作戦プランナー");
        }

        await page.goto(planUrl("/plan"));
        await waitForGrid(page);
        await expect(page.locator("#sessions li")).toHaveCount(4);
        // **埋まっている枠と空いている枠が両方写ること**が、この1枚の用。
        await expect(page.locator('#sessions .s-cell[data-state="ready"]').first()).toBeVisible();
        await expect(page.locator('#sessions .s-cell[data-state="empty"]').first()).toBeVisible();
        // 「開いたことがある作戦」も同じ1枚に入れたい。
        await expect(page.locator("#visited li")).toHaveCount(2);
        await page.screenshot({ path: `${OUT}/01-list-${tag}.png`, fullPage: false });
        // 狭い画面では訪問履歴が折り返しの下に来る。**スクロールするのは main**
        // （`main.create{overflow:auto}`）なので fullPage では写らない。送ってから撮る。
        await page.locator("#visited li").last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${OUT}/01b-visited-${tag}.png`, fullPage: false });

        // 盤面へ。
        await page.locator("#sessions li").first().getByRole("link", { name: "開く" }).click();
        await expect(page.locator("#board")).toBeVisible();
        await expect(page.locator("#title")).not.toHaveText("作戦プランナー");
        // 背景の見せ方だけを見る3枚はパレットを畳んで撮る。
        await closePalette(page);
        await page.waitForTimeout(1200);   // 背景タイルの到着を待つ
        await page.screenshot({ path: `${OUT}/02-board-mono-${tag}.png` });

        await setBasemap(page, "color");
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${OUT}/03-board-color-${tag}.png` });

        await setBasemap(page, "posterize");
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${OUT}/04-board-posterize-${tag}.png` });

        await setBasemap(page, "mono");
        await page.waitForTimeout(400);

        // パレットを開く。
        await openPalette(page);
        await page.screenshot({ path: `${OUT}/05-palette-${tag}.png` });

        // L81 を置いて、射程リングと詳細パネルを出す。
        await pickAndPlace(page, "emplacement", "mortar_l81", 7500, 7500);
        await expect(page.locator("#placement-detail")).toBeVisible();
        await page.screenshot({ path: `${OUT}/06-detail-${tag}.png` });

        // 座標表示（右下）。
        const p = await boardPoint(page, 7500, 7500);
        await page.mouse.move(p.x, p.y);
        await expect(page.locator("#readout")).toBeVisible();
        await page.screenshot({ path: `${OUT}/07-readout-${tag}.png` });

        // 背景メニューを開いた状態。
        await page.locator("#view-menu > summary").click();
        await page.screenshot({ path: `${OUT}/08-viewmenu-${tag}.png` });
        await page.keyboard.press("Escape");

        // 注記と優先度。グリフ（D / 守 …）と数字が両方読めるかを目で見るための1枚。
        // 8種類の記号を並べ、それぞれに注記と 1〜8 の優先度を付ける。
        const marks = [
          ["mk_drill", "ドリルA", 1], ["mk_hq", "本部", 2],
          ["mk_spawn", "湧き", 3], ["mk_enemy_fob", "敵FOB", 4],
          ["mk_defend", "東を守る", 5], ["mk_attack", "南から", 6],
          ["mk_danger", "見られてる", 7], ["mk_note", "補給はここ", 8],
        ];
        for (const [i, [itemId, note, rank]] of marks.entries()) {
          // **どの画面でも触れる帯に置く。** 枠とパネルは地図の上に浮いている
          // ので、左右の端や下半分は押しても板に当たる（狭い画面では詳細パネルが
          // 下 45% を覆う）。狭い画面の視野（x 4389〜11931）にも収まる範囲。
          await pickAndPlace(page, "objective", itemId, 5100 + 870 * i, 5000, i + 2);
          await page.locator("#placement-label").fill(note);
          await page.locator("#placement-label-save").click();
          await expect(page.locator("#status")).toContainText("注記を保存しました");
          await chooseOption(page, "placement-rank", { value: String(rank) });
          await expect(page.locator(".pm-rank").nth(i)).toHaveText(String(rank));
        }
        await page.locator("#placement-detail .close").click();
        await page.mouse.move(2, 2);
        await page.screenshot({ path: `${OUT}/09-notes-wide-${tag}.png` });

        // 寄った状態。注記が全文になり、ピンの中の文字が大きく見える。
        const near = await boardPoint(page, 6000, 8000);
        await page.mouse.move(near.x, near.y);
        for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, -600);
        await page.mouse.move(2, 2);
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${OUT}/10-notes-near-${tag}.png` });

        // 注記と優先度の欄がある詳細パネル。寄ったままだと枠外にいることがあるので戻す。
        await page.getByRole("button", { name: "全体表示" }).click();
        await page.waitForTimeout(400);
        await page.locator('#placements .pm[data-item-id="mk_defend"]').click();
        await expect(page.locator("#placement-label")).toHaveValue("東を守る");
        await page.screenshot({ path: `${OUT}/11-detail-edit-${tag}.png` });

        // パレットを全種別開いた状態（56件に届くかを目で見る）。
        await openPalette(page);
        for (const kind of ["objective", "structure", "emplacement", "vehicle"]) {
          const g = page.locator(`#palette .pal-group[data-kind="${kind}"]`);
          if (!(await g.evaluate((el) => el.open))) await g.locator("summary").click();
        }
        await page.screenshot({ path: `${OUT}/12-palette-all-top-${tag}.png` });
        await page.locator("#palette .pal-item").last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${OUT}/13-palette-all-bottom-${tag}.png` });
      });

      // 地名と縮尺。見たいのは3つ:
      //   * 地名が配置マーカーと見分けられるか（点＋文字 vs 形＋色）
      //   * 全体表示で文字が潰れていないか（＝名前を伏せる判断が効いているか）
      //   * 縮尺バーの数字ときりのいい長さ、座標表示との距離
      test(`地名と縮尺 (${tag})`, async ({ page, context }) => {
        const uid = `96${scheme === "dark" ? 5 : 4}${size.name === "wide" ? 0 : 1}`;
        await loginViaApi(context, uid, "地名係");
        const planId = await createPlan(context, "地名の確認");
        await page.goto(planUrl(`/plan?id=${planId}`));
        await expect(page.locator("#board")).toBeVisible();
        await expect(page.getByRole("button", { name: "地名を置く" })).toBeEnabled();
        await closePalette(page);
        await page.waitForTimeout(1200);   // 背景タイルの到着を待つ

        // 中央の 3.2km × 4km に 20 件。名前を出す寄り具合（4km 四方）で
        // 20 件が同時に見える置き方にしてある（実際に想定する密度は 12〜13件
        // なので、これは読めるかどうかの上振れ側の確認になる）。
        const names = [
          "あの丘", "工場", "北の橋", "南の橋", "採石場", "給水塔", "三叉路", "牧場",
          "廃村", "鉄塔", "峠", "沢の合流", "高台", "トンネル出口", "駅裏", "資材置場",
          "見晴らし", "土手", "東の門", "貯水池",
        ];
        await page.getByRole("button", { name: "地名を置く" }).click();
        for (const [i, name] of names.entries()) {
          const x = 6400 + (i % 5) * 800;
          const y = 6400 + Math.floor(i / 5) * 1000;
          const p = await boardPoint(page, x, y);
          await page.mouse.click(p.x, p.y);
          await expect(page.locator("#callouts .co")).toHaveCount(i + 1);
          await page.locator("#callout-name").fill(name);
          await page.locator("#callout-name-save").click();
          await expect(page.locator("#status")).toContainText(`「${name}」にしました`);
          // 選んだままにすると、その地名だけ広くても名前が出て（仕様）次の
          // 置き場所に重なる。狭い画面では詳細パネル自体が盤面の下半分を覆う。
          await page.locator("#placement-detail .close").click();
          await expect(page.locator("#placement-detail")).toBeHidden();
        }
        await page.mouse.move(2, 2);

        // 全体表示。名前は伏せて点だけ（16km 四方に 20 件の文字を出すと読めない）。
        await page.getByRole("button", { name: "全体表示" }).click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/14-callouts-far-${tag}.png` });

        // 寄った状態。名前が出て、縮尺バーの目盛りも短い距離に切り替わる。
        // 全体表示の広さは画面の形で変わる（横長なら 29km 幅）ので、回数を
        // 決め打ちにせず**名前を出す境目（4000m）の内側に入るまで**寄る。
        const viewW = () => page.locator("#board")
          .evaluate((el) => Number(el.getAttribute("viewBox").split(" ")[2]));
        for (let i = 0; i < 8 && (await viewW()) > 3990; i += 1) {
          await page.getByRole("button", { name: "拡大" }).click();
          await page.waitForTimeout(250);
        }
        await expect(page.locator("#callouts")).toHaveAttribute("data-names", "on");
        await page.mouse.move(2, 2);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/15-callouts-near-${tag}.png` });

        // 配置マーカーと並べる。地名（点＋文字）と配置（形＋色＋名前）が
        // 見分けられることを目で確かめるための1枚。寄った範囲の中に置く。
        // 寄った視野（マップ中心のまわり）の中に入る点を選ぶ。
        await pickAndPlace(page, "objective", "mk_drill", 7600, 8500);
        await page.locator("#placement-label").fill("ドリルA");
        await page.locator("#placement-label-save").click();
        await expect(page.locator("#status")).toContainText("注記を保存しました");
        await closePalette(page);
        await page.locator("#placement-detail .close").click();
        await page.mouse.move(2, 2);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/16-callouts-vs-marker-${tag}.png` });

        // 地名を選んだ状態の詳細パネル（呼び名の欄と、作戦ごとであることの注記）。
        // **寄った視野の中にいる粒を選ぶ**（1個目は左上の隅で画面の外にいる）。
        await page.locator("#callouts .co").nth(12).click();
        await expect(page.locator("#callout-name")).toBeVisible();
        await page.screenshot({ path: `${OUT}/17-callout-detail-${tag}.png` });

        // セル名のガター。寄って（視野 2000m 未満）、盤面の縁の見出しが
        // 地図の端に張り付き、真ん中のセル名が薄く出ることを目で見る。
        await page.locator("#placement-detail .close").click();
        const near = await boardPoint(page, 7500, 7500);
        await page.mouse.move(near.x, near.y);
        for (let i = 0; i < 12; i += 1) {
          const vb = await page.locator("#board").getAttribute("viewBox");
          if (Number(vb.split(" ")[2]) < 1600) break;
          await page.mouse.wheel(0, -400);
        }
        await page.mouse.move(2, 2);
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${OUT}/18-gutter-near-${tag}.png` });
      });

      // エリア（1km セルの塗り）。見たいのは3つ:
      //   * 5種が色と塗り方で区別できるか（隣り合わせに置かないと分からない）
      //   * 塗った下の地図が読めるか（塗り潰して地形が消えていないか）
      //   * 寄ってもパターンが潰れないか
      test(`エリア (${tag})`, async ({ page, context }) => {
        const uid = `97${scheme === "dark" ? 5 : 4}${size.name === "wide" ? 0 : 1}`;
        await loginViaApi(context, uid, "エリア係");
        const planId = await createPlan(context, "エリアの確認");
        await page.goto(planUrl(`/plan?id=${planId}`));
        await expect(page.locator("#board")).toBeVisible();
        await expect(page.getByRole("button", { name: "円とマス", exact: true })).toBeEnabled();
        await page.waitForTimeout(1200);   // 背景タイルの到着を待つ

        // **開いた直後の引き出し**を1枚。円（ゲームが決める）が先頭に来ていて、
        // 「想定するパターン」の欄がスクロールせずに見えるかを目で確かめる
        // （オーナー報告「円を出すのに導線が長すぎます」への答えがここに写る）。
        await openZonePanel(page);
        await page.mouse.move(2, 2);
        await page.screenshot({ path: `${OUT}/18b-zone-first-${tag}.png` });

        // **マップの端まで塗るので、全体が見える状態にしてから。**
        // 開いた直後は地図が画面を埋めていて、外周は画面の外にいる。
        await page.getByRole("button", { name: "全体表示" }).click();
        await page.waitForTimeout(400);

        // 5種を隣り合わせに塗る。離れた所に置くと「区別がつくか」が分からない。
        const plots = [
          ["own", [1, 9, 5, 14]],
          ["enemy", [10, 1, 14, 6]],
          ["neutral", [6, 6, 9, 9]],
          ["key", [7, 11, 8, 12]],
          ["risk", [11, 8, 13, 10]],
        ];
        for (const [kind, rect] of plots) {
          await pickKind(page, kind);
          await paintCells(page, rect);
          const [c0, r0, c1, r1] = rect;
          await expect(page.locator(`#areas .area[data-kind="${kind}"]`))
            .toHaveAttribute("data-cells", String((c1 - c0 + 1) * (r1 - r0 + 1)));
        }

        // パネルを開いたまま1枚（種類チップの色見本と集計が読めるか）。
        if (!(await page.locator("#zonepanel").isVisible())) {
          await page.getByRole("button", { name: "円とマス", exact: true }).click();
        }
        await expect(page.locator("#zonepanel")).toBeVisible();
        await page.mouse.move(2, 2);
        await page.screenshot({ path: `${OUT}/19-areas-panel-${tag}.png` });

        // パネルを畳んで盤面だけ（5種の見分けと、地図が透けて見えるか）。
        await page.locator("#zonepanel-close").click();
        await expect(page.locator("#zonepanel")).toBeHidden();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/20-areas-board-${tag}.png` });

        // 高コントラストの背景の上でも読めるか（いちばん塗りに紛れやすい）。
        await setBasemap(page, "posterize");
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${OUT}/21-areas-posterize-${tag}.png` });
        await setBasemap(page, "mono");

        // 寄った状態。パターンの間隔は画面固定なので、ここでも同じ細かさに見える。
        // 種類名は視野 2000m 以下では消える。危険予測と中立の境目に寄せる
        // （何も塗っていない所へ寄っても、確かめたいものが写らない）。
        const near = await boardPoint(page, 11000, 9000);
        await page.mouse.move(near.x, near.y);
        for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -400);
        await page.mouse.move(2, 2);
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${OUT}/22-areas-near-${tag}.png` });
      });

      // マップが持っている物（ドリルタワー・陣営スポーン）。見たいのは3つ:
      //   * チームが置いた物（塗りつぶした形＋色）と見分けが付くか
      //   * 塔の線画が航空写真に沈まないか（ハローが効いているか）
      //   * 寄ったときに出る塔の名前が読めるか
      test(`マップの設備 (${tag})`, async ({ page, context }) => {
        const uid = `98${scheme === "dark" ? 5 : 4}${size.name === "wide" ? 0 : 1}`;
        await loginViaApi(context, uid, "設備係");
        const planId = await createPlan(context, "ドリルタワーの確認");
        await page.goto(planUrl(`/plan?id=${planId}`));
        await expect(page.locator("#board")).toBeVisible();
        await expect(page.locator("#towers .tw")).toHaveCount(5);
        await page.waitForTimeout(1200);   // 背景タイルの到着を待つ

        // 全体表示。3陣営のスポーンと、中央に固まったタワー5本。
        await closePalette(page);
        await page.mouse.move(2, 2);
        await page.screenshot({ path: `${OUT}/23-mapfeatures-far-${tag}.png` });

        // タワーのすぐ隣に、チームが置く「ドリル位置」の記号を置く。
        // **この1枚で「ゲームの設備」と「置いた物」の差が分かる**ようにする。
        await pickAndPlace(page, "objective", "mk_drill", 8600, 9300);
        await closePalette(page);
        if (await page.locator("#placement-detail").isVisible()) {
          await page.locator("#placement-detail .close").click();
        }
        await page.keyboard.press("Escape");

        // 名前が出る広さ（2000m 以下）まで寄る。「拡大」1回で 1/1.6 倍。
        const at = await boardPoint(page, 8000, 9200);
        await page.mouse.move(at.x, at.y);
        for (let i = 0; i < 8; i += 1) {
          const w = await page
            .locator("#board")
            .evaluate((el) => Number(el.getAttribute("viewBox").split(" ")[2]));
          if (w <= 2000) break;
          await page.mouse.wheel(0, -400);
        }
        await expect(page.locator("#towers")).toHaveAttribute("data-names", "on");
        await page.mouse.move(2, 2);
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${OUT}/24-mapfeatures-near-${tag}.png` });
      });

      // コントロールエリア（ゲームが決めた円）と、主役になった座標表示。見たいのは4つ:
      //   * 円がマス塗りと混ざらないか（円 vs マス、線 vs パターン、無彩色 vs 種別色）
      //   * 円の中のタワーの強調が、モノクロの航空写真の上で読めるか
      //   * 入力中の破線（未保存）と保存済みの実線の差が分かるか
      //   * 座標表示で、座標がセル名より主役に見えるか
      test(`コントロールエリアの円 (${tag})`, async ({ page, context }) => {
        const uid = `99${scheme === "dark" ? 5 : 4}${size.name === "wide" ? 0 : 1}`;
        await loginViaApi(context, uid, "円係");
        execD1(`UPDATE users SET role = 'admin' WHERE discord_id = '${uid}'`);
        const planId = await createPlan(context, "コントロールエリアの確認");
        await page.goto(planUrl(`/plan?id=${planId}`));
        await expect(page.locator("#board")).toBeVisible();
        await expect(page.locator("#towers .tw")).toHaveCount(5);
        await page.waitForTimeout(1200);   // 背景タイルの到着を待つ

        // 座標で位置を指すので、全体が見える状態にしてから。
        await page.getByRole("button", { name: "全体表示" }).click();
        await page.waitForTimeout(400);
        await openZonePanel(page);
        const admin = page.locator("#zone-admin");
        await expect(admin).toBeVisible();
        if (!(await admin.evaluate((el) => el.open))) await admin.locator("> summary").click();

        // 入力中（破線）の1枚。**ここは実データではない**。Bakurani の5本の重心。
        await page.locator("#zp-key").fill("Default");
        await page.locator("#zp-x").fill("79.84");
        await page.locator("#zp-y").fill("70.63");
        await expect(page.locator("#zone-preset .zp-preview")).toHaveCount(1);
        await page.mouse.move(2, 2);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/25-zone-input-${tag}.png` });

        // 保存後（実線＋タワー5本の強調）。パネルの集計も読めるように開いたまま。
        await page.locator("#zp-save").click();
        await expect(page.locator("#zone-preset .zp:not(.zp-preview)")).toHaveCount(1);
        await expect(page.locator('#towers .tw[data-live="1"]')).toHaveCount(5);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/26-zone-panel-${tag}.png` });

        // **「まだパターンを選んでいない」印**（フッターの「円とマス」に出る点）。
        // 引き出しを開けなくても、この作戦の円が決まっていないことが分かるか。
        // わざと選択を外して撮り、すぐ戻す。
        await chooseOption(page, "zone-preset-select", { value: "" });
        await expect(page.getByRole("button", { name: "円とマス", exact: true }))
          .toHaveAttribute("data-unset", "true");
        await closeZonePanel(page);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/26b-zone-unset-${tag}.png` });
        await openZonePanel(page);
        await chooseOption(page, "zone-preset-select", { label: "Default" });
        await expect(page.locator("#zone-preset .zp:not(.zp-preview)")).toHaveCount(1);

        // **パターンを選ぶと円の外のタワーが消える**（オーナー指示 2026-10-01）。
        // 上の Default は5本とも円の中なので、絞られたことが絵に出ない。
        // Tower 3 の足元だけを囲む円をもう1つ作って、**5本 → 1本**を撮る。
        await chooseOption(page, "zp-target", { value: "" });
        await page.locator("#zp-key").fill("Tight");
        await page.locator("#zp-x").fill("76.89");
        await page.locator("#zp-y").fill("73.15");
        await page.locator("#zp-radius").fill("300");
        await page.locator("#zp-save").click();
        await expect(page.locator("#towers .tw:not([hidden])")).toHaveCount(1);
        await page.mouse.move(2, 2);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/26c-zone-only-live-${tag}.png` });

        // 撮り終えたら Tight を消して Default に戻す。
        // **この撮影は4通り（ライト/ダーク × 広い/狭い）が1つの DB を共有する。**
        // 残すと次の回で同じ名前を作れず 409 になり、最後の片付けも対象が
        // ずれて止まる。以降の絵も「タワー5本」が前提。
        await page.locator("#zp-delete").click();
        await expect(choiceOptions(page, "zone-preset-select").filter({ hasText: "Tight" }))
          .toHaveCount(0);
        await chooseOption(page, "zp-target", { label: "Default" });
        await chooseOption(page, "zone-preset-select", { label: "Default" });
        await expect(page.locator("#towers .tw:not([hidden])")).toHaveCount(5);

        // 円の近くまで寄る。実寸 1km の円と、強調された塔の足元の丸が見える広さ。
        await closeZonePanel(page);
        const at = await boardPoint(page, 7984, 16320 - 7063);
        await page.mouse.move(at.x, at.y);
        for (let i = 0; i < 8; i += 1) {
          const w = await page
            .locator("#board")
            .evaluate((el) => Number(el.getAttribute("viewBox").split(" ")[2]));
          if (w <= 5000) break;
          await page.mouse.wheel(0, -400);
        }
        // 座標表示を出したまま撮る（主役が座標になっているかを目で見る）。
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${OUT}/27-zone-near-${tag}.png` });

        // マス塗り（チームの見立て）を円に**並べて**、混ざらないことを目で見る。
        // **以前はここが問題の現場だった。** 白い実線の円も緑の点描のマスも
        // 「コントロールエリア」という同じ名前で、見た目が違うのに言葉が1つ
        // しかなかった。今はマス側が「最重要」なので、指す言葉が重ならない。
        // 円は SVG の (7984, 9257) を中心に半径 500m。その左の2マス
        // （列6〜7・行9）に塗ると、円の左半分と隣り合って写る。
        // **寄ったまま塗るので、見えている所を選ぶ**（画面の外を指すと
        // `boardPoint` がマップ外の点を返し、黙って0マスのままになる）。
        // **塗る前に全体表示へ戻す。** 寄ったままだと塗りたいマスが画面の外に
        // あることがあり、boardPoint がマップ外の点を返して黙って0マスになる。
        await page.getByRole("button", { name: "全体表示" }).click();
        await page.waitForTimeout(400);
        await pickKind(page, "key");
        const a = await boardPoint(page, 6500, 9500);
        const b = await boardPoint(page, 7500, 9500);
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(b.x, b.y, { steps: 10 });
        await page.mouse.up();
        // 塗れたことを確かめてから撮る（黙って0マスのまま撮らない）。
        await expect(page.locator('#areas .area[data-kind="key"]'))
          .toHaveAttribute("data-cells", "2");
        await closeZonePanel(page);
        await page.mouse.move(2, 2);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${OUT}/28-zone-vs-areas-${tag}.png` });

        // **ホットゾーン（半径 85m）をコントロールエリアの円（半径 500m）の中に置く。**
        // 見たいのは「大きさの差が一目で分かるか」と「黄色い破線の円と無彩色の
        // 実線の円を取り違えないか」。D-052 で分かったとおり、ホットゾーンに入ると
        // 人数が2倍に数えられるので、この2つを混同すると作戦の読み違いになる。
        // **置く点は円の上半分に取る。** 狭い画面では詳細パネルが盤面の下側を
        // 覆うので、下半分を押すと板に当たって置けない。
        await openZonePanel(page);
        await page.locator("#place-hotzone").click();
        const hz = await boardPoint(page, 7984, 8800);
        await page.mouse.click(hz.x, hz.y);
        await expect(page.locator("#hotzones .hz")).toHaveCount(1);
        // 2つ目を少し離して置く（「いくつでも置ける」と、札が重ならないこと）。
        // 選んだ道具は置いたあとも選ばれたままなので、押すだけで続けて置ける。
        await page.locator("#placement-detail .close").click();
        const hz2 = await boardPoint(page, 7600, 8900);
        await page.mouse.click(hz2.x, hz2.y);
        await expect(page.locator("#hotzones .hz")).toHaveCount(2);
        await page.locator("#placement-detail .close").click();
        await closeZonePanel(page);
        await page.mouse.move(2, 2);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/29-hotzone-vs-zone-far-${tag}.png` });

        // 札（人数×2）が出る広さ（4000m 以下）まで寄る。500m の円と 85m の円が
        // 同じ画面に入る広さなので、**大きさの差が一番はっきり写る1枚**になる。
        await page.mouse.move(hz.x, hz.y);
        for (let i = 0; i < 10; i += 1) {
          const w = await page
            .locator("#board")
            .evaluate((el) => Number(el.getAttribute("viewBox").split(" ")[2]));
          if (w <= 2600) break;
          await page.mouse.wheel(0, -400);
        }
        await expect(page.locator("#hotzones .hz-label").first()).not.toHaveAttribute("hidden", "");
        await page.mouse.move(2, 2);
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${OUT}/30-hotzone-vs-zone-near-${tag}.png` });

        // 選んだときの詳細（検視台）。「効果: 中に入ると人数が2倍に数えられます」と
        // 「範囲: 半径 85m（未検証）」が読めるか。**円を見ただけでは効果は分からない**
        // ので、ここで必ず言う。
        await page.locator('#placements .pm[data-item-id="mk_hotzone"]').first().click();
        await expect(page.locator("#placement-detail")).toBeVisible();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/31-hotzone-detail-${tag}.png` });
        await page.locator("#placement-detail .close").click();

        // 引き出しを開けた1枚（3つの一画が並ぶ。ホットゾーンのボタンが
        // スクロールせずに見えるか）。
        await page.getByRole("button", { name: "全体表示" }).click();
        await page.waitForTimeout(300);
        await openZonePanel(page);
        await page.mouse.move(2, 2);
        await page.screenshot({ path: `${OUT}/32-hotzone-panel-${tag}.png` });
        await closeZonePanel(page);

        // **最後に消しておく。** プリセットはマップ静的で、4通りの撮影
        // （ライト/ダーク × 広い/狭い）が1つの DB を共有している。残したまま
        // 次へ行くと、同じ名前で作れず 409 になって撮影が止まる。
        await openZonePanel(page);
        if (!(await admin.evaluate((el) => el.open))) await admin.locator("> summary").click();
        await page.locator("#zp-delete").click();
        await expect(page.locator("#zone-preset .zp")).toHaveCount(0);
      });
    });
  }
}
