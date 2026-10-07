// 作戦一覧を「マップ × パターンの**枠の表**」にすること（D-046 の目的3）。
//
// このツールは試合の記録ではなく**パターンごとの準備**を置く場所で、作戦は
// 「マップ × パターン」の単位。総数は 9〜12 件で頭打ちになる。
//
// オーナー指摘（2026-10-01、作戦1件の実画面を見て）: 「これでいいとおもってます？」
// それまでの一覧は**作った作戦しか存在しなかった**ので、9つのうち何が埋まって
// いて何が空いているかが読めなかった。いまは**空いている枠も最初から並べる**。
//
// 見るのは5つ:
//   * 作戦が0件でも、プリセットの数だけ枠が並ぶ（埋まっている／空が形で分かる）
//   * 埋まった枠は「開く」、空の枠は押すとその組み合わせで作れる
//   * パターン未設定の作戦が隠れない（既存の作戦は全部これ）
//   * パターンが無いマップでも詰まらない
//   * 390px（試合中にスマホで開く可能性がある）
import { test, expect } from "@playwright/test";

import {
  chooseOption, chosenValue, createPlan, createViaGrid,
  execD1, loginViaApi, planUrl, waitForGrid,
} from "./plan-helpers.js";

/**
 * Ozeti に2つのパターンを入れる。
 *
 * 2行は SQL 1文にまとめる（`execD1` は速くなったので回数の制約は無いが、
 * 「このマップのパターン一式」は1文のほうが読んで分かる）。
 *
 * Ozeti を使うのは、他の spec が触らないマップだから。プリセットは**マップ静的**で
 * e2e の D1 は全ファイルで共有されるので、Bakurani（plan-zones.spec.js が
 * 管理者UIから登録する）に入れると、枠の数の前提がファイルの実行順で変わる。
 * `sort_order` を 10 / 20 にしてあるのは「名前順ではなく admin が付けた順で並ぶ」
 * ことを見るため（Bravo を先に作っても Alpha が左に来る）。
 */
function seedOzetiPatterns() {
  execD1(
    `INSERT OR IGNORE INTO map_zone_presets
       (id, map_id, key, name, x_m, y_m, radius_m, source, verified, sort_order, created_at, updated_at)
     VALUES
       ('e2e-ozeti-alpha', 'ozeti', 'Alpha', 'Alpha', 8000, 8000, 550, 'e2e の作り物', 0, 10,
        strftime('%s','now'), strftime('%s','now')),
       ('e2e-ozeti-bravo', 'ozeti', 'Bravo', 'Bravo', 9000, 9000, 550, 'e2e の作り物', 0, 20,
        strftime('%s','now'), strftime('%s','now'))`
  );
}

const groups = (page) => page.locator("#sessions .s-group");
const groupOf = (page, mapId) => page.locator(`#sessions .s-group[data-map-id="${mapId}"]`);
const cells = (group) => group.locator(".s-cell");
const cellOf = (group, presetId) => group.locator(`.s-cell[data-preset-id="${presetId}"]`);

test.describe("マップ × パターンの枠が並ぶ", () => {
  test("作戦が0件でも、プリセットの数だけ枠が並ぶ（空の枠が形で分かる）", async ({ page, context }) => {
    seedOzetiPatterns();
    await loginViaApi(context, "9759", "pat-empty-grid");

    await page.goto(planUrl("/plan"));
    await waitForGrid(page);

    // **マップは3つとも出る。**作戦が無いマップが消える作りにしない。
    await expect(groups(page)).toHaveCount(3);
    await expect(groups(page).locator(".s-group-name"))
      .toHaveText(["Bakurani", "Ozeti", "Zestafona"]);

    // Ozeti は Alpha / Bravo の2枠。**どちらも空**。
    const ozeti = groupOf(page, "ozeti");
    await expect(cells(ozeti)).toHaveCount(2);
    await expect(cells(ozeti).locator(".pattern")).toHaveText(["Alpha", "Bravo"]);
    for (const state of await cells(ozeti).evaluateAll((els) => els.map((e) => e.dataset.state))) {
      expect(state, "作戦が無いのに埋まった枠になっている").toBe("empty");
    }
    // 空の枠は押すと作れる口を持っている。
    await expect(cells(ozeti).first().locator("button.s-new")).toBeVisible();
    // 件数も1行で読める。
    await expect(page.locator("#grid-progress")).toContainText("枠に作戦があります");
  });

  test("埋まった枠は開ける、空の枠は作れる（枠の数は変わらない）", async ({ page, context }) => {
    seedOzetiPatterns();
    await loginViaApi(context, "9750", "pat-list");

    // わざと「後のパターン」を先に、未設定も混ぜて作る。
    // 作った順に並ぶなら、この順番がそのまま画面に出てしまう。
    await createPlan(context, "オゼティ ブラボー想定", "ozeti", "e2e-ozeti-bravo");
    await createPlan(context, "オゼティ 未設定のまま", "ozeti");
    await createPlan(context, "オゼティ アルファ想定", "ozeti", "e2e-ozeti-alpha");
    await createPlan(context, "ゼスタフォナ 既定想定", "zestafona", "zestafona-default");

    await page.goto(planUrl("/plan"));
    await waitForGrid(page);
    await expect(page.locator("#sessions li")).toHaveCount(4);

    // マップの区画はマップ名の順。位置が毎回変わらない（試合中の速さになる）。
    await expect(groups(page).locator(".s-group-name"))
      .toHaveText(["Bakurani", "Ozeti", "Zestafona"]);

    const ozeti = groupOf(page, "ozeti");
    // 枠は**パターンの並び順**（Bravo を先に作っても Alpha が左）。
    await expect(cells(ozeti).locator(".pattern")).toHaveText(["Alpha", "Bravo"]);

    // 枠の中に作戦が入り、そこから開ける。
    const alpha = cellOf(ozeti, "e2e-ozeti-alpha");
    await expect(alpha).toHaveAttribute("data-state", "ready");
    await expect(alpha.locator(".s-title")).toHaveText("オゼティ アルファ想定");
    await expect(alpha.getByRole("link", { name: "開く" })).toBeVisible();
    // **枠の見出しがパターンの名前なので、行では繰り返さない。**
    await expect(alpha.locator("li .pattern")).toHaveCount(0);
    await expect(alpha.locator("li .badge")).toHaveCount(0);

    // 2つのうち2つ埋まっているので「2 / 2」。
    await expect(ozeti.locator(".s-group-count")).toHaveText("2 / 2");

    // Bakurani は1件も作っていないが**枠は残る**（空の枠が作る入口）。
    const bakurani = groupOf(page, "bakurani");
    await expect(bakurani.locator("li")).toHaveCount(0);
    await expect(bakurani.locator("button.s-new").first()).toBeVisible();
  });

  test("パターン未設定の作戦は別区画に出る（枠には数えないが隠さない）", async ({ page, context }) => {
    seedOzetiPatterns();
    await loginViaApi(context, "9751", "pat-none");
    await createPlan(context, "オゼティ 未設定その1", "ozeti");
    await createPlan(context, "オゼティ 未設定その2", "ozeti");

    await page.goto(planUrl("/plan"));
    await waitForGrid(page);
    await expect(page.locator("#sessions li")).toHaveCount(2);

    const ozeti = groupOf(page, "ozeti");
    const extra = ozeti.locator(".s-extra");
    await expect(extra).toHaveCount(1);
    await expect(extra.locator(".pattern")).toHaveText("パターン未設定");
    // **順番は見ない。** 並びは更新の新しい順だが、`updated_at` は秒なので
    // 続けて作ると同じ値になり、どちらが先かは入力順で決まってしまう。
    // ここで見たいのは「2件とも出ること」。
    const titles = await extra.locator(".s-title").allTextContents();
    expect(titles.sort()).toEqual(["オゼティ 未設定その1", "オゼティ 未設定その2"]);
    // **開ける。**隠れない。
    await expect(extra.locator("li").first().getByRole("link", { name: "開く" })).toBeVisible();
    // どうすればパターンを決められるかが書いてある（状態だけ述べて終わらない）。
    await expect(extra).toContainText("円とマス");

    // 枠そのものは空のまま（未設定は枠の数に入らない）。
    await expect(ozeti.locator(".s-group-count")).toHaveText("0 / 2");
  });

  test("パターンが1件も無いマップでも作れる（詰まらない）", async ({ page, context }) => {
    await loginViaApi(context, "9753", "pat-empty");

    // **プリセットが 0 件のマップを確実に作る。** プリセットはマップ静的で e2e の
    // D1 は全ファイル共有なので、どのマップも「他のファイルが入れていない」
    // ことをこのファイルだけでは保証できない。見たいのは画面側の振る舞いなので、
    // パターンを削ったマップ一覧を返させる。
    await page.route("**/api/maps", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const m of body.maps) m.presets = [];
      await route.fulfill({ response: res, json: body });
    });

    await page.goto(planUrl("/plan"));
    await waitForGrid(page);

    const bakurani = groupOf(page, "bakurani");
    // 枠が作れないので、代わりに「パターン未登録」の枠が1つ出る。
    // **「選べない」を「作れない」と読ませない。**
    await expect(cells(bakurani)).toHaveCount(1);
    await expect(cells(bakurani).locator(".pattern")).toHaveText("パターン未登録");
    await expect(cells(bakurani)).toContainText("パターンなしで作れます");

    await createViaGrid(page, "パターン無しでも作る");
    await expect(page).toHaveURL(/\/plan\?id=[\w-]{22}$/);
    await expect(page.locator("#title")).toHaveText("パターン無しでも作る");

    await page.unroute("**/api/maps");
  });

  test("開いたことがある作戦の行にもパターンが出る", async ({ page, context }) => {
    seedOzetiPatterns();
    // 配る側。
    await loginViaApi(context, "9755", "pat-owner");
    const shared = await createPlan(context, "配られたアルファ想定", "ozeti", "e2e-ozeti-alpha");

    // 受け取る側。共有URLで開くと訪問履歴に載る。
    await loginViaApi(context, "9756", "pat-guest");
    await page.goto(planUrl(`/plan?id=${shared}`));
    await expect(page.locator("#title")).toHaveText("配られたアルファ想定");

    await page.goto(planUrl("/plan"));
    const row = page.locator("#visited li", { hasText: "配られたアルファ想定" });
    await expect(row).toHaveCount(1);
    // こちらは「最後に開いた順」の一覧なのでマップ名も行に出す（枠で分けない）。
    await expect(row.locator(".badge")).toHaveText("Ozeti");
    await expect(row.locator(".pattern")).toHaveText("Alpha");
  });
});

test.describe("空いている枠から作る", () => {
  test("枠を押すとその組み合わせで作られ、開いた盤面に円が出ている", async ({ page, context }) => {
    await loginViaApi(context, "9752", "pat-create");
    await page.goto(planUrl("/plan"));
    await waitForGrid(page);

    // **マップもパターンも選ぶ欄が無い。**押した枠が決める。
    await expect(page.locator("#create-map")).toHaveCount(0);
    await expect(page.locator("#create-pattern")).toHaveCount(0);

    const zest = groupOf(page, "zestafona");
    const cell = cellOf(zest, "zestafona-default");
    await expect(cell.locator(".pattern")).toHaveText("Default（全タワー）");
    await cell.locator("button.s-new").click();

    // 題名は枠の名前で埋まっている（そのまま作れる）。
    await expect(page.locator("#create-title")).toHaveValue(/Zestafona/);
    await page.locator("#create-title").fill("作成時にパターン付き");
    await page.getByRole("button", { name: "作戦を作る" }).click();

    // 盤面が開いた時点で、その枠のパターンの円が選ばれている。
    await expect(page.locator("#title")).toHaveText("作成時にパターン付き");
    await expect(page.locator("#zone-preset .zp:not(.zp-preview)")).toHaveCount(1);
    expect(await chosenValue(page, "zone-preset-select")).toBe("zestafona-default");

    // 一覧に戻ると、その枠が埋まっている。
    await page.goto(planUrl("/plan"));
    await waitForGrid(page);
    const after = cellOf(groupOf(page, "zestafona"), "zestafona-default");
    await expect(after).toHaveAttribute("data-state", "ready");
    await expect(after.locator(".s-title")).toHaveText("作成時にパターン付き");
  });

  // **1枠1作戦を前提にしない。**同じパターンに「初動」と「巻き返し」を
  // 並べたいことがある。枠を潰さず中に積む。
  test("埋まっている枠にもう1つ作れる（枠は増えない）", async ({ page, context }) => {
    seedOzetiPatterns();
    await loginViaApi(context, "9760", "pat-two");
    await createPlan(context, "アルファ 初動", "ozeti", "e2e-ozeti-alpha");

    await page.goto(planUrl("/plan"));
    await waitForGrid(page);
    const alpha = cellOf(groupOf(page, "ozeti"), "e2e-ozeti-alpha");
    await alpha.locator("button.s-new").click();
    await page.locator("#create-title").fill("アルファ 巻き返し");
    await page.getByRole("button", { name: "作戦を作る" }).click();
    await expect(page.locator("#title")).toHaveText("アルファ 巻き返し");

    await page.goto(planUrl("/plan"));
    await waitForGrid(page);
    const ozeti = groupOf(page, "ozeti");
    await expect(cells(ozeti)).toHaveCount(2);                 // 枠は増えない
    await expect(cellOf(ozeti, "e2e-ozeti-alpha").locator("li")).toHaveCount(2);
    await expect(ozeti.locator(".s-group-count")).toHaveText("1 / 2");
  });
});

// オーナー報告: 「円を出すのに導線が長すぎます」。
//
// 直前までの手順は【エリアを開く → パネルを下までスクロール → 欄を探す → 選ぶ】。
// ここで守るのは、**開いた作戦から2手（引き出しを開く → 選ぶ）で円が出ること**と、
// 引き出しを開く前に「まだ選んでいない」と分かること。
test.describe("円を出すまでの導線", () => {
  test("引き出しを開いた時点で欄が見えていて、選べば円が出る", async ({ page, context }) => {
    seedOzetiPatterns();
    await loginViaApi(context, "9757", "pat-reach");
    const planId = await createPlan(context, "円の導線", "ozeti");

    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#title")).toHaveText("円の導線");

    // 開く前に「まだ選んでいない」と分かる（引き出しを開けずに気づける）。
    const drawerBtn = page.getByRole("button", { name: "円とマス" });
    await expect(drawerBtn).toHaveAttribute("data-unset", "true");

    // 1手目: 引き出しを開く。
    await expect(page.locator("#palette .pal-item").first()).toBeAttached();
    await drawerBtn.click();
    const panel = page.locator("#zonepanel");
    await expect(panel).toBeVisible();

    // **スクロールせずに欄が見えている。** 引き出しの見えている範囲に収まっていること。
    const select = page.locator("#zone-preset-select");
    await expect(select).toBeVisible();
    const fits = await panel.evaluate((el) => {
      const sel = document.getElementById("zone-preset-select");
      const p = el.getBoundingClientRect();
      const s = sel.getBoundingClientRect();
      return { scrollTop: el.scrollTop, inside: s.bottom <= p.bottom + 1 && s.top >= p.top - 1 };
    });
    expect(fits.scrollTop, "開いた直後にスクロールしていない").toBe(0);
    expect(fits.inside, "欄が引き出しの見えている範囲に無い").toBe(true);

    // 2手目: 選ぶ。円が盤面に出る。
    await chooseOption(page, "zone-preset-select", { label: "Alpha" });
    await expect(page.locator("#zone-preset .zp:not(.zp-preview)")).toHaveCount(1);
    await expect(drawerBtn).not.toHaveAttribute("data-unset", "true");

    // リロードしても出たまま（＝次に開いたときは0手）。
    await page.reload();
    await expect(page.locator("#zone-preset .zp:not(.zp-preview)")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "円とマス" }))
      .not.toHaveAttribute("data-unset", "true");
  });

  test("パターンが無いマップでは催促の印を出さない（押しても選べないため）", async ({ page, context }) => {
    await loginViaApi(context, "9758", "pat-nocue");
    const planId = await createPlan(context, "印なし", "bakurani");
    await page.route("**/api/sessions/*", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      // このマップのパターンが0件の状態を、他のファイルの登録に左右されずに作る。
      if (Array.isArray(body.zone_presets)) body.zone_presets = [];
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#title")).toHaveText("印なし");

    const drawerBtn = page.getByRole("button", { name: "円とマス" });
    await expect(drawerBtn).not.toHaveAttribute("data-unset", "true");
  });
});

// D-037 / D-046: 試合中にスマホで開く可能性がある。実機相当の幅で使えること。
test.describe("狭い画面（390x844）", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("390px でも枠が読めて、開くボタンが押せる", async ({ page, context }) => {
    seedOzetiPatterns();
    await loginViaApi(context, "9754", "pat-narrow");
    await createPlan(context, "アルファ想定 初動", "ozeti", "e2e-ozeti-alpha");
    await createPlan(context, "ブラボー想定 初動", "ozeti", "e2e-ozeti-bravo");
    await createPlan(context, "未設定の古い作戦", "ozeti");

    await page.goto(planUrl("/plan"));
    await waitForGrid(page);
    await expect(page.locator("#sessions li")).toHaveCount(3);

    const ozeti = groupOf(page, "ozeti");
    await expect(ozeti.locator(".s-group-name")).toBeVisible();
    // 枠の見出し（パターンの名前）が読める。
    await expect(cells(ozeti).first().locator(".pattern")).toBeVisible();
    await expect(ozeti.locator(".s-extra .pattern")).toHaveText("パターン未設定");

    // 横に溢れない（横スクロールしながら探すことになると数秒では開けない）。
    const overflow = await page.evaluate(() => {
      const el = document.querySelector("main");
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow, "一覧が横に溢れている").toBeLessThanOrEqual(1);

    // 「開く」は指で押せる大きさで、画面の中に収まっている。
    const open = cellOf(ozeti, "e2e-ozeti-alpha").getByRole("link", { name: "開く" });
    const box = await open.boundingBox();
    expect(box.height, "開くの高さ").toBeGreaterThanOrEqual(44);
    expect(box.x + box.width, "開くが画面の外に出ている").toBeLessThanOrEqual(390);

    // 空の枠の「作る」も押せる大きさで収まっている。
    const make = groupOf(page, "bakurani").locator("button.s-new").first();
    const makeBox = await make.boundingBox();
    expect(makeBox.height, "作るの高さ").toBeGreaterThanOrEqual(44);
    expect(makeBox.x + makeBox.width, "作るが画面の外に出ている").toBeLessThanOrEqual(390);

    // 実際に開ける。
    await open.click();
    await expect(page.locator("#title")).toHaveText("アルファ想定 初動");
  });
});
