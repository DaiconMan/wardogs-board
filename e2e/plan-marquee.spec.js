// 範囲選択（「選択」の道具）の UIテスト。
//
// オーナーの要望（原文）:
//   「マップにおけるアイテムが小さい場合、再度選択するのがつらいですね。
//     **Powerpointみたいに範囲選択して削除**とかできるといいなと。」
//
// ここで守りたいのは、仕様の受け入れ条件7〜13。
//    7. 枠で囲うと、中にある配置と地名が選ばれる（件数が出る）
//    8. まとめて削除できる
//    9. まとめて移動できる
//   10. 他人のものが混ざっていたら件数が分かれて見える。操作は自分のものだけに効く
//   11. **N件まとめて操作しても、相手への通知は1回**（実測して数を出す）
//   12. Esc で解除される
//   13. 「移動」でのパンと喧嘩しない（D-049 の再発防止）
//
// **11 は数える。** `api.js` の `call()` に通知のフックが入っているので、素朴に
// N 件 DELETE すると `chg` が N 通飛ぶ。20件消して20回配信すると相手は20回取り直す。
// `joinRoom()` で同じ部屋にもう1本 WebSocket を張り、受信したフレームを数えて確かめる。
//
// **2枚のタブは同じアカウントで**（D-068。身元は「人」ではなく「接続」）。
import { test, expect } from "@playwright/test";

import {
  boardPoint, coverViewBox, createPlan, joinRoom, loginHeadless, loginViaApi, planUrl,
  settleView, showWholeMap,
} from "./plan-helpers.js";

async function openPlan(page, context, discordId, name) {
  await loginViaApi(context, discordId, name);
  const planId = await createPlan(context, name);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.getByRole("button", { name: "取り消す" })).toBeEnabled();
  await showWholeMap(page);
  return planId;
}

const selectTool = async (page) => {
  const btn = page.getByRole("button", { name: "範囲選択" });
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
};

/**
 * パレットを開く。**広い画面では開いた状態で始まる**（`paletteOpenAtStart`）ので、
 * 無条件に押すと閉じてしまう。開いていないときだけ押す。
 */
async function openPalette(page) {
  const palette = page.locator("#palette");
  if (!(await palette.isVisible())) {
    await page.getByRole("button", { name: "建造物" }).click();
  }
  await expect(palette).toBeVisible();
}

/**
 * 項目を選ぶ。**種別の折りたたみ（`.pal-group`）を開いてから**押す。
 * 56項目あるので種別ごとに畳んであり、開いているのは先頭の種別だけ。
 */
async function pickItem(page, itemId) {
  await openPalette(page);
  const item = page.locator(`#palette .pal-item[data-item-id="${itemId}"]`);
  const group = page.locator(`#palette .pal-group:has(.pal-item[data-item-id="${itemId}"])`);
  // `open` は属性だと空文字（= falsy）になるので、プロパティで見る。
  if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
  await expect(item).toBeVisible();
  if ((await item.getAttribute("aria-pressed")) !== "true") await item.click();
  await expect(item).toHaveAttribute("aria-pressed", "true");
}

/**
 * 配置を n 件、同じ帯の上に等間隔で置く（枠で囲みやすい形にする）。
 *
 * **既に盤面にあるぶんから数える。** 他の人が置いたものがある作戦では
 * 0 から数えると、1件目を置いた時点で件数が合わない。
 */
async function placeMany(page, n, { y = 8000, x0 = 3000, step = 900 } = {}) {
  const pm = page.locator("#placements .pm");
  const before = await pm.count();
  await pickItem(page, "fob");
  for (let i = 0; i < n; i += 1) {
    const at = await boardPoint(page, x0 + i * step, y);
    await page.mouse.click(at.x, at.y);
    await expect(pm).toHaveCount(before + i + 1);
  }
  // パレットの選択を外す（置く道具のまま枠を引くと、置く操作になる）。
  await page.keyboard.press("Escape");
}

async function placeCalloutAt(page, x, y) {
  const before = await page.locator("#callouts .co").count();
  await page.getByRole("button", { name: "地名を置く" }).click();
  const at = await boardPoint(page, x, y);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator("#callouts .co")).toHaveCount(before + 1);
  await page.keyboard.press("Escape");
}

/** メートルの矩形を枠で囲う。 */
async function band(page, from, to) {
  const a = await boardPoint(page, from.x, from.y);
  const b = await boardPoint(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}

const picked = (page) => page.locator("#placements .pm[data-picked], #callouts .co[data-picked]");

// ── 受け入れ条件7・12 ──────────────────────────────────────────

test.describe("枠で選ぶ", () => {
  test("枠の中の配置と地名が選ばれ、件数が出る", async ({ page, context }) => {
    await openPlan(page, context, "10121", "枠で選ぶ");
    await placeMany(page, 3);
    await placeCalloutAt(page, 4000, 8500);
    // 枠の外に1件（囲っていないものが入らないことの確認）。
    await placeCalloutAt(page, 14000, 2000);

    await selectTool(page);
    await band(page, { x: 2000, y: 7000 }, { x: 6000, y: 9500 });

    // 配置3件（3000 / 3900 / 4800）と地名1件（4000, 8500）＝ 4件。
    await expect(picked(page)).toHaveCount(4);
    await expect(page.locator("#status")).toHaveText("4件を選択");
    // 検視台が「選んだもの」になる。
    await expect(page.locator("#placement-detail h2")).toHaveText("選んだもの");
    await expect(page.locator("#placement-detail dd").first()).toHaveText("4件を選択");
  });

  test("枠に1件も入らなければ選択が解ける", async ({ page, context }) => {
    await openPlan(page, context, "10122", "空の枠");
    await placeMany(page, 2);
    await selectTool(page);

    await band(page, { x: 2000, y: 7000 }, { x: 6000, y: 9500 });
    await expect(picked(page)).toHaveCount(2);

    await band(page, { x: 12000, y: 1000 }, { x: 15000, y: 3000 });
    await expect(picked(page)).toHaveCount(0);
    await expect(page.locator("#placement-detail")).toBeHidden();
  });

  // 受け入れ条件12
  test("Esc で解除される", async ({ page, context }) => {
    await openPlan(page, context, "10123", "枠の解除");
    await placeMany(page, 2);
    await selectTool(page);
    await band(page, { x: 2000, y: 7000 }, { x: 6000, y: 9500 });
    await expect(picked(page)).toHaveCount(2);

    await page.keyboard.press("Escape");
    await expect(picked(page)).toHaveCount(0);
    await expect(page.locator("#status")).toContainText("選択を解きました");
  });

  test("別の道具に切り替えても解除される", async ({ page, context }) => {
    await openPlan(page, context, "10124", "道具を替えて解除");
    await placeMany(page, 2);
    await selectTool(page);
    await band(page, { x: 2000, y: 7000 }, { x: 6000, y: 9500 });
    await expect(picked(page)).toHaveCount(2);

    await page.getByRole("button", { name: "移動" }).click();
    await expect(picked(page)).toHaveCount(0);
  });

  test("引いている最中は枠が見え、離すと消える", async ({ page, context }) => {
    await openPlan(page, context, "10125", "枠の見た目");
    await placeMany(page, 2);
    await selectTool(page);

    const a = await boardPoint(page, 2000, 7000);
    const b = await boardPoint(page, 6000, 9500);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await expect(page.locator("#select-band .band")).toHaveCount(1);
    // **エリアのプレビューとは別物**（同じ見た目だと「塗ろうとしている」に見える）。
    await expect(page.locator("#areas .area-preview")).toHaveCount(0);
    const dash = await page.locator("#select-band .band")
      .evaluate((el) => getComputedStyle(el).strokeDasharray);
    expect(dash === "none" || dash === "").toBe(true);   // 枠は実線

    await page.mouse.up();
    await expect(page.locator("#select-band .band")).toHaveCount(0);
  });
});

// ── 受け入れ条件8・9 ──────────────────────────────────────────

test("まとめて削除できる", async ({ page, context }) => {
  const planId = await openPlan(page, context, "10126", "まとめて削除");
  await placeMany(page, 4);
  await placeCalloutAt(page, 4000, 8500);
  await selectTool(page);
  await band(page, { x: 2000, y: 7000 }, { x: 7000, y: 9500 });
  await expect(picked(page)).toHaveCount(5);

  await page.locator("#picked-delete").click();
  await expect(page.locator("#status")).toContainText("5件を消しました");
  await expect(page.locator("#placements .pm")).toHaveCount(0);
  await expect(page.locator("#callouts .co")).toHaveCount(0);
  // **消し切ったら検視台も閉じる。** 残すと「選んだ5件を消す」が出たままになる
  // （消えたものに対して押せるボタンを置かない）。
  await expect(page.locator("#placement-detail")).toBeHidden();

  // サーバからも消えている（画面だけ消えて行が残る、を防ぐ）。
  const pl = await context.request.get(planUrl(`/api/sessions/${planId}/placements`));
  expect((await pl.json()).placements).toHaveLength(0);
  const co = await context.request.get(planUrl(`/api/sessions/${planId}/callouts`));
  expect((await co.json()).callouts).toHaveLength(0);
});

test("Delete キーでもまとめて削除できる", async ({ page, context }) => {
  await openPlan(page, context, "10127", "Delete で削除");
  await placeMany(page, 3);
  await selectTool(page);
  await band(page, { x: 2000, y: 7000 }, { x: 6000, y: 9500 });
  await expect(picked(page)).toHaveCount(3);

  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press("Delete");
  await expect(page.locator("#placements .pm")).toHaveCount(0);
});

test("まとめて移動できる（相対位置が崩れない）", async ({ page, context }) => {
  const planId = await openPlan(page, context, "10128", "まとめて移動");
  await placeMany(page, 3);
  await selectTool(page);
  await band(page, { x: 2000, y: 7000 }, { x: 6000, y: 9500 });
  await expect(picked(page)).toHaveCount(3);

  const before = await context.request.get(planUrl(`/api/sessions/${planId}/placements`));
  const was = (await before.json()).placements.map((p) => ({ x: p.x_m, y: p.y_m }));

  // 選んだもののうち1件を掴んで、まとめて動かす。
  const grab = await boardPoint(page, 3900, 8000);
  const drop = await boardPoint(page, 3900 + 2000, 8000 + 1500);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator("#status")).toContainText("3件を動かしました");

  const after = await context.request.get(planUrl(`/api/sessions/${planId}/placements`));
  const now = (await after.json()).placements.map((p) => ({ x: p.x_m, y: p.y_m }));
  expect(now).toHaveLength(3);
  // **3件が同じぶんだけ動いている**（相対位置が崩れていない。ここが本題）。
  const dx = now[0].x - was[0].x;
  const dy = now[0].y - was[0].y;
  for (let i = 1; i < 3; i += 1) {
    expect(Math.abs((now[i].x - was[i].x) - dx), `${i}件目の横のずれ`).toBeLessThan(2);
    expect(Math.abs((now[i].y - was[i].y) - dy), `${i}件目の縦のずれ`).toBeLessThan(2);
  }
  // 動いた量もおおむね掴んだぶん。**縦は符号が逆**になる——`boardPoint` は
  // SVG ユーザー単位（下が +）で、保存されるメートルは下が −（coords.js の
  // `flip`。マップの `y_axis_down` が偽なので `y_m = height - y`）。
  expect(Math.abs(dx - 2000), "横に動いた量").toBeLessThan(60);
  expect(Math.abs(dy + 1500), "縦に動いた量（SVG とは符号が逆）").toBeLessThan(60);
});

// ── 受け入れ条件10 ────────────────────────────────────────────

test("他人のものが混ざっていたら件数が分かれ、操作は自分のものだけに効く", async ({ page, context, browser }) => {
  // 作戦は「書き込める公開」にして、2人が同じ盤面に置ける状態を作る。
  await loginViaApi(context, "10129", "枠の所有者");
  const planId = await createPlan(context, "枠と所有者");
  await context.request.patch(planUrl(`/api/sessions/${planId}`), {
    headers: { "content-type": "application/json", origin: planUrl("") },
    data: { visibility: "public_edit" },
  });

  // 相手（別アカウント）が2件置く。API だけで置く（盤面を開く必要が無い）。
  const otherCtx = await browser.newContext();
  await loginViaApi(otherCtx, "10130", "枠の他人");
  for (const x of [5000, 5600]) {
    const res = await otherCtx.request.post(planUrl(`/api/sessions/${planId}/placements`), {
      headers: { "content-type": "application/json", origin: planUrl("") },
      // **`client_uuid` は毎回作る。** 決め打ちにすると、e2e の D1 は
      // `.wrangler/e2e-plan-state` に残るので**2回目の実行で 409
      // （別のプランで使用済み）になる。** 実測で踏んだ（`--repeat-each=2`）。
      data: {
        placements: [{
          client_uuid: crypto.randomUUID(), item_id: "fob", x_m: x, y_m: 8000,
        }],
      },
    });
    expect(res.status(), await res.text()).toBe(201);
  }
  await otherCtx.close();

  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.getByRole("button", { name: "取り消す" })).toBeEnabled();
  await showWholeMap(page);
  await placeMany(page, 2);   // 自分の2件（3000 / 3900）
  await expect(page.locator("#placements .pm")).toHaveCount(4);

  await selectTool(page);
  await band(page, { x: 2000, y: 7000 }, { x: 7000, y: 9500 });

  // **件数が分かれて見える。**
  await expect(page.locator("#status")).toHaveText("4件を選択（うち自分のもの 2件）");
  await expect(page.locator("#placement-detail dd").first())
    .toHaveText("4件を選択（うち自分のもの 2件）");
  // 他人のものは薄く、対象外だと見える。
  await expect(page.locator('#placements .pm[data-picked="other"]')).toHaveCount(2);
  await expect(page.locator('#placements .pm[data-picked="mine"]')).toHaveCount(2);
  // ボタンも「自分のものの件数」を名乗る（押してから403になる形にしない）。
  await expect(page.locator("#picked-delete")).toHaveText("選んだ2件を消す");

  await page.locator("#picked-delete").click();
  await expect(page.locator("#status")).toContainText("2件を消しました");
  // **他人の2件は残っている。**
  await expect(page.locator("#placements .pm")).toHaveCount(2);
  const res = await context.request.get(planUrl(`/api/sessions/${planId}/placements`));
  expect((await res.json()).placements).toHaveLength(2);
});

// ── 受け入れ条件11（実測して数を出す）─────────────────────────────

test.describe("まとめ操作の通知は1回", () => {
  /** 相手の席。**同じアカウントで**張る（D-068）。 */
  async function watcher(discordId, name, planId) {
    const cookie = await loginHeadless(discordId, name);
    const conn = await joinRoom(cookie, planId);
    return conn;
  }

  const chgCount = (conn) => conn.messages.filter((m) => m.includes('"chg"')).length;

  /**
   * **基準を「届くべき数」で固定する。**
   *
   * 置くぶんの通知が届き切る前に基準を取ると、残りがまとめ操作のぶんとして
   * 数に乗る。**実測で2回踏んだ。**
   *   1回目 … 1通目が届いた時点で基準を取り、あとから7通来て「8通」になった
   *   2回目 … 「値が変わらなくなったら」で待ったが、**届き方に 400ms 以上の
   *            切れ目があると途中で落ち着いたと見なして**しまった
   *
   * なので「落ち着くまで待つ」ではなく、**期待する数に達するまで待つ**。
   * 配置を1件ずつ置くと POST も1件ずつなので、`expected` は置いた件数そのもの。
   * これで**対照（門を通らない経路は N 通）も同時に測れる。**
   */
  async function baselineChg(page, conn, expected) {
    await expect
      .poll(() => chgCount(conn), { timeout: 20_000 })
      .toBe(expected);
    // 余分に来ないことも見る（来るならこのあと数がずれて必ず落ちる）。
    await page.waitForTimeout(800);
    expect(chgCount(conn), `1件ずつ置いたときの chg（門を通らない経路）`).toBe(expected);
    return expected;
  }

  test("8件まとめて消しても chg は1通（素朴なら8通）", async ({ page, context }) => {
    const planId = await openPlan(page, context, "10131", "通知1回・削除");
    const conn = await watcher("10131", "通知1回・削除", planId);
    try {
      await placeMany(page, 8, { step: 700 });
      // **対照。** 置くのは1件ずつの POST で、門を通らないので8通飛ぶ。
      // 「まとめ操作だから1通」が門の効果であることを、同じ試験の中で測る
      // （8 と 1 を並べて初めて「束ねている」と言える）。
      const before = await baselineChg(page, conn, 8);

      await selectTool(page);
      await band(page, { x: 2000, y: 7000 }, { x: 10000, y: 9500 });
      await expect(picked(page)).toHaveCount(8);

      await page.locator("#picked-delete").click();
      await expect(page.locator("#status")).toContainText("8件を消しました");

      // 届くのを待ってから数える。**増えた数が1であること。**
      await expect.poll(() => chgCount(conn) - before, { timeout: 10_000 }).toBe(1);
      // 少し待っても増えない（遅れて残りの7通が来ない）。
      await page.waitForTimeout(1500);
      expect(chgCount(conn) - before, "8件の DELETE で飛んだ chg の数").toBe(1);
    } finally {
      conn.close();
    }
  });

  test("8件まとめて動かしても chg は1通", async ({ page, context }) => {
    const planId = await openPlan(page, context, "10132", "通知1回・移動");
    const conn = await watcher("10132", "通知1回・移動", planId);
    try {
      await placeMany(page, 8, { step: 700 });

      await selectTool(page);
      await band(page, { x: 2000, y: 7000 }, { x: 10000, y: 9500 });
      await expect(picked(page)).toHaveCount(8);
      // 置くぶん（1件ずつ ＝ 8通）が届き切ってから基準を取る。
      const before = await baselineChg(page, conn, 8);

      const grab = await boardPoint(page, 3700, 8000);
      const drop = await boardPoint(page, 3700 + 1500, 8000 + 1000);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(drop.x, drop.y, { steps: 12 });
      await page.mouse.up();
      await expect(page.locator("#status")).toContainText("8件を動かしました");

      await expect.poll(() => chgCount(conn) - before, { timeout: 10_000 }).toBe(1);
      await page.waitForTimeout(1500);
      expect(chgCount(conn) - before, "8件の PATCH で飛んだ chg の数").toBe(1);
    } finally {
      conn.close();
    }
  });
});

// ── 受け入れ条件13（D-049 の再発防止）────────────────────────────

test.describe("「移動」でのパンと喧嘩しない", () => {
  /**
   * パンできる余地を作る（1段ズームする）。
   *
   * **引き切った状態ではパンは何もしない。** `clampAxis` が「マップより広く
   * 見ている軸は中央に寄せる」ので（viewport.js）、全体表示のままドラッグしても
   * viewBox は 1 も動かない。実測で踏んだ。
   */
  async function zoomIn(page) {
    const before = await page.locator("#board").getAttribute("viewBox");
    await page.getByRole("button", { name: "拡大" }).click();
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", before);
    // **補間（150ms）が終わるまで待つ。** 途中で掴むと、`boardPoint` が出した
    // 画面座標と、掴んだ瞬間の盤面がずれる（`settleView` の注記）。
    await settleView(page);
    await page.evaluate(() => document.activeElement?.blur?.());
  }

  test("「移動」のドラッグは今までどおりパンになる", async ({ page, context }) => {
    await openPlan(page, context, "10133", "パンと喧嘩しない");
    await placeMany(page, 2);

    // 「選択」を使ってから「移動」へ戻しても、パンが効くこと。
    await selectTool(page);
    await page.getByRole("button", { name: "移動" }).click();
    await zoomIn(page);

    const before = await page.locator("#board").getAttribute("viewBox");
    const a = await boardPoint(page, 9000, 9000);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x - 220, a.y - 160, { steps: 10 });
    await page.mouse.up();

    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", before);
    // 選択は作られていない（移動の道具で枠を引いていない）。
    await expect(picked(page)).toHaveCount(0);
  });

  test("「選択」のドラッグはパンにならない（盤面が動かない）", async ({ page, context }) => {
    await openPlan(page, context, "10134", "枠はパンにならない");
    await placeMany(page, 2);
    await selectTool(page);

    const before = await page.locator("#board").getAttribute("viewBox");
    await band(page, { x: 2000, y: 7000 }, { x: 6000, y: 9500 });
    await expect(picked(page)).toHaveCount(2);
    await expect(page.locator("#board")).toHaveAttribute("viewBox", before);
  });

  test("「選択」でも中ボタンとスペースは必ずパン（forcesPan は触っていない）", async ({ page, context }) => {
    await openPlan(page, context, "10135", "選択中のパン");
    await selectTool(page);
    await zoomIn(page);

    const before = await page.locator("#board").getAttribute("viewBox");
    const a = await boardPoint(page, 9000, 9000);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(a.x - 200, a.y - 150, { steps: 10 });
    await page.mouse.up({ button: "middle" });
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", before);
  });
});

// ── 棚の並び（390px）──────────────────────────────────────────
//
// 「選択」と「やり直す」を足したので、棚が1段の横スクロールになる幅で
// **何が初期表示に残るか**が変わる。頻度の高い `建造物` を残す判断（PM）を固定する。

test.describe("狭い画面の棚", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("「移動」と「建造物」が、横に送らずに読める", async ({ page, context }) => {
    await loginViaApi(context, "10136", "棚390");
    const planId = await createPlan(context, "棚390");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.getByRole("button", { name: "取り消す" })).toBeEnabled();
    // 開いた直後のまま（まだ横に送っていない）。
    expect(await page.locator("#board").getAttribute("viewBox")).toBe(await coverViewBox(page));
    expect(await page.locator("#rail").evaluate((el) => el.scrollLeft)).toBe(0);

    const pan = page.getByRole("button", { name: "移動" });
    await expect(pan).toHaveAttribute("aria-pressed", "true");
    const pbox = await pan.boundingBox();
    expect(pbox.x).toBeGreaterThanOrEqual(-0.5);
    expect(pbox.x + pbox.width).toBeLessThanOrEqual(390.5);

    // **置く入口が初期表示に残っている**（置くたびに押すので、取り消しより前）。
    const palette = await page.locator("#toggle-palette").boundingBox();
    expect(palette.x + palette.width).toBeLessThanOrEqual(390.5);

    // 「選択」も同じ組の中にいる（いま何の道具かが1箇所で読める）。
    const sel = await page.getByRole("button", { name: "範囲選択" }).boundingBox();
    expect(sel.x + sel.width).toBeLessThanOrEqual(390.5);

    // **実測値をログに残す。** 「入っている」だけでなく、どれだけ余裕があるかが
    // 読めないと、ラベルを1文字増やしたときに何が押し出されるか分からない。
    // 2026-10-08 の実測: 移動 54 / 選択 243 / 建造物 307 / 円とマス 373 /
    // スタンプ 439 / 戻す 496 / やり直す 562（棚の全幅 814）。
    // **「スタンプ」と「取り消し」が送り先。** スタンプを足したときに
    // 円とマス（373）より右へ置いたので、初期表示に残る2つは変わっていない。
    const edges = await page.evaluate(() => {
      const right = (id) => Math.round(document.getElementById(id).getBoundingClientRect().right);
      return {
        移動: right("tool-pan"), 選択: right("tool-select"),
        建造物: right("toggle-palette"), 円とマス: right("toggle-zones"),
        スタンプ: right("toggle-stamp-panel"),
        戻す: right("undo"), やり直す: right("redo"),
        棚の全幅: document.getElementById("rail").scrollWidth,
      };
    });
    console.log("390px の棚（各ボタンの右端）:", JSON.stringify(edges));
  });
});
