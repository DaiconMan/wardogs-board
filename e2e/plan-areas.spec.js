// エリア塗り（自陣・敵陣・中立・最重要・危険予測）の UIテスト。
//
// オーナーの要望（原文）:
//   「自分の陣営、ゾーン、ほっとぞーん、ドリルの位置がかかれないので、
//     どこに攻めるとかどこから攻められそうとかわかりにくい」
//
// ここで守りたいのは4つ。
//   1. **1ジェスチャ = 1行 = 取り消し1回で完全に戻る**（D-028 の懸念に抵触しない形）
//   2. **エリアモードでもドラッグはパンにならない**（逆に「移動」ではパンできる）
//   3. **5種が見た目で区別できる**（色とパターン。色だけに頼らない）
//   4. **寄ってもパターンの見た目の大きさが変わらない**（斜線が潰れない）
//   5. **ゲームが決める語をパレットに出さない**（コントロールエリアの円・
//      ホットゾーンはゲームのもので、ここで塗るのはチームの見立てだけ）
import { test, expect } from "@playwright/test";

import {
  boardPoint, coverViewBox, createPlan, fitViewBox, loginViaApi, planUrl, showWholeMap,
} from "./plan-helpers.js";

/** ゲーム内と同じ 1km セル。塗りの単位。 */
const CELL_M = 1000;
const KINDS = ["own", "enemy", "neutral", "key", "risk"];
/** パターンで塗る3種（自陣はベタ、中立は塗らない）。 */
const PATTERN_KINDS = ["enemy", "key", "risk"];

async function openPlan(page, context, discordId, name) {
  await loginViaApi(context, discordId, name);
  const planId = await createPlan(context, name);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  // 編集できるようになるまで（プランの取得が終わるまで）待つ。
  await expect(page.getByRole("button", { name: "円とマス", exact: true })).toBeEnabled();
  // マップ座標で位置を指すので、まずマップ全体が見える状態にする
  // （開いた直後は地図が画面を埋めていて、外周は画面の外にいる）。
  await showWholeMap(page);
  return planId;
}

/** エリアのパネルを開く。フッターのボタンは1個だけ（`#toggle-zones`）。 */
async function openZonePanel(page) {
  const panel = page.locator("#zonepanel");
  if (!(await panel.isVisible())) {
    await page.getByRole("button", { name: "円とマス", exact: true }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

/** 種類チップを選ぶ（もう一度押すと解除されるので、押していないときだけ押す）。 */
async function pickKind(page, kind) {
  await openZonePanel(page);
  const chip = page.locator(`#zone-kinds button[data-kind="${kind}"]`);
  if ((await chip.getAttribute("aria-pressed")) !== "true") await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  return chip;
}

/** セルの中心の画面座標。行は SVG 座標（上が 0）。 */
const cellCenter = (page, col, row) =>
  boardPoint(page, (col + 0.5) * CELL_M, (row + 0.5) * CELL_M);

/** 押して、引いて、離す。`steps` を刻まないと閾値（4px）を超えたと判定されない。 */
async function dragCells(page, from, to) {
  const a = await cellCenter(page, from.col, from.row);
  const b = await cellCenter(page, to.col, to.row);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
}

/** その種類が今いくつのセルを持っているか（app.js が data-cells に出す）。 */
const cells = (page, kind) => page.locator(`#areas .area[data-kind="${kind}"]`);

/** 今の viewBox。パンしたかどうかの判定に使う。 */
const viewBoxOf = (page) =>
  page.locator("#board").evaluate((el) => {
    const [x, y, w, h] = el.getAttribute("viewBox").split(" ").map(Number);
    return { x, y, w, h };
  });

test.describe("エリアを塗る", () => {
  test("敵陣をドラッグで塗ると、その矩形のぶんだけ塗られて1行で保存される", async ({ page, context }) => {
    await openPlan(page, context, "9600", "エリア塗り");
    await pickKind(page, "enemy");

    // 3列 × 2行 = 6マス。プレビューは離した時点で消える。
    await dragCells(page, { col: 3, row: 7 }, { col: 5, row: 8 });
    await expect(page.locator("#status")).toContainText("6マス");
    await expect(cells(page, "enemy")).toHaveAttribute("data-cells", "6");
    await expect(page.locator("#areas .area-preview")).toHaveCount(0);

    // 塗りと外周が実際に引かれている（属性が空のままになっていない）。
    const fill = page.locator('#areas .area[data-kind="enemy"] .area-fill');
    expect((await fill.getAttribute("d")).match(/M/g)).toHaveLength(6);
    // 外周だけ（6セルの塊なら 3×2 の周囲 10 辺）。
    const edge = page.locator('#areas .area[data-kind="enemy"] .area-edge');
    expect((await edge.getAttribute("d")).match(/M/g)).toHaveLength(10);

    // パネルの集計にも出る。
    await expect(page.locator("#zone-counts")).toHaveText("敵陣 6マス");

    // サーバには1行だけ（1ジェスチャ = 1行）。
    const res = await context.request.get(planUrl(`/api/sessions/${page.url().split("id=")[1]}`));
    const body = await res.json();
    expect(body.areas).toHaveLength(1);
    expect(body.areas[0]).toMatchObject({ kind: "enemy", op: "add", cell_m: 1000, rects: [[3, 7, 5, 8]] });
  });

  test("ドラッグ中はプレビューと「3×2 = 6マス」が出る", async ({ page, context }) => {
    await openPlan(page, context, "9601", "エリアのプレビュー");
    await pickKind(page, "enemy");

    const a = await cellCenter(page, 3, 7);
    const b = await cellCenter(page, 5, 8);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });

    await expect(page.locator("#areas .area-preview")).toHaveCount(1);
    await expect(page.locator("#readout .paint")).toHaveText("3×2 = 6マス");
    // まだ確定していないので、集合は空のまま。
    await expect(cells(page, "enemy")).toHaveAttribute("data-cells", "0");

    await page.mouse.up();
    await expect(page.locator("#areas .area-preview")).toHaveCount(0);
    await expect(page.locator("#readout .paint")).toBeEmpty();
    await expect(cells(page, "enemy")).toHaveAttribute("data-cells", "6");
  });

  test("「取り消す」1回でドラッグした6マスが完全に消える", async ({ page, context }) => {
    await openPlan(page, context, "9602", "エリアの取り消し");
    await pickKind(page, "enemy");

    await dragCells(page, { col: 3, row: 7 }, { col: 5, row: 8 });
    await expect(cells(page, "enemy")).toHaveAttribute("data-cells", "6");

    await page.getByRole("button", { name: "取り消す" }).click();
    await expect(page.locator("#status")).toContainText("取り消しました");
    await expect(cells(page, "enemy")).toHaveAttribute("data-cells", "0");

    // サーバからも消えている（画面だけ消えて行が残る、を防ぐ）。
    const res = await context.request.get(planUrl(`/api/sessions/${page.url().split("id=")[1]}`));
    expect((await res.json()).areas).toHaveLength(0);
  });

  test("同じマスをクリックすると付いて消える（トグル）", async ({ page, context }) => {
    await openPlan(page, context, "9603", "エリアのトグル");
    await pickKind(page, "risk");

    const c = await cellCenter(page, 8, 8);
    await page.mouse.click(c.x, c.y);
    await expect(cells(page, "risk")).toHaveAttribute("data-cells", "1");
    await expect(page.locator("#status")).toContainText("1マス");

    await page.mouse.click(c.x, c.y);
    await expect(cells(page, "risk")).toHaveAttribute("data-cells", "0");
    await expect(page.locator("#status")).toContainText("消しました");

    // 追記型なので行は2つ（add と sub）。取り消しは1回ずつ効く。
    const res = await context.request.get(planUrl(`/api/sessions/${page.url().split("id=")[1]}`));
    const { areas } = await res.json();
    expect(areas.map((a) => a.op)).toEqual(["add", "sub"]);
  });

  test("リロードしても塗ったエリアは残る", async ({ page, context }) => {
    await openPlan(page, context, "9604", "エリアの永続");
    await pickKind(page, "own");
    await dragCells(page, { col: 1, row: 1 }, { col: 2, row: 3 });
    await expect(cells(page, "own")).toHaveAttribute("data-cells", "6");

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(cells(page, "own")).toHaveAttribute("data-cells", "6");
    // パネルを開かなくても地図には出る（表示は既定で on）。
    await expect(page.locator('#areas .area[data-kind="own"] .area-fill'))
      .toHaveAttribute("d", /M 1000 1000/);
  });

  test("消しゴムを選んでドラッグすると、その範囲が消える", async ({ page, context }) => {
    await openPlan(page, context, "9605", "エリアの消しゴム");
    await pickKind(page, "key");
    await dragCells(page, { col: 4, row: 4 }, { col: 7, row: 7 });
    await expect(cells(page, "key")).toHaveAttribute("data-cells", "16");

    // 消しゴムはインクと同じボタン。エリアを選んでいる間は「塗ったものを消す」。
    await page.getByRole("button", { name: "消しゴム" }).click();
    await expect(page.getByRole("button", { name: "消しゴム" })).toHaveAttribute("aria-pressed", "true");
    // 種類の選択は外れない（外れたら塗り直しから始めることになる）。
    await expect(page.locator('#zone-kinds button[data-kind="key"]'))
      .toHaveAttribute("aria-pressed", "true");

    await dragCells(page, { col: 4, row: 4 }, { col: 5, row: 5 });
    await expect(cells(page, "key")).toHaveAttribute("data-cells", "12");
    await expect(page.locator("#status")).toContainText("消しました");
  });

  test("エリアを塗っている間もドラッグでパンしない。「移動」ならパンできる", async ({ page, context }) => {
    await openPlan(page, context, "9606", "エリアとパン");
    await pickKind(page, "enemy");

    // 全体表示のままだとパンしても clampView で戻るので、先に寄る。
    const mid = await cellCenter(page, 8, 8);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.wheel(0, -600);
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", await coverViewBox(page));
    const before = await viewBoxOf(page);

    await dragCells(page, { col: 7, row: 7 }, { col: 9, row: 8 });
    expect(await viewBoxOf(page)).toEqual(before);
    await expect(cells(page, "enemy")).toHaveAttribute("data-cells", "6");

    // 「移動」を押すと種類の選択が外れ、同じドラッグがパンになる。
    await page.getByRole("button", { name: "移動" }).click();
    await expect(page.locator('#zone-kinds button[data-kind="enemy"]'))
      .toHaveAttribute("aria-pressed", "false");
    await dragCells(page, { col: 7, row: 7 }, { col: 9, row: 8 });
    const after = await viewBoxOf(page);
    expect(after.x).not.toBeCloseTo(before.x, 1);
    // パンしただけなので塗りは増えていない。
    await expect(cells(page, "enemy")).toHaveAttribute("data-cells", "6");
  });
});

test.describe("エリアの見た目", () => {
  test("5種すべて塗れて、塗りと縁の見た目が種類ごとに違う", async ({ page, context }) => {
    await openPlan(page, context, "9610", "エリア5種");

    for (const [i, kind] of KINDS.entries()) {
      await pickKind(page, kind);
      await dragCells(page, { col: 1 + i * 3, row: 2 }, { col: 2 + i * 3, row: 4 });
      await expect(cells(page, kind)).toHaveAttribute("data-cells", "6");
    }

    const look = await page.evaluate((kinds) =>
      kinds.map((kind) => {
        const g = document.querySelector(`#areas .area[data-kind="${kind}"]`);
        const fill = getComputedStyle(g.querySelector(".area-fill"));
        const edge = getComputedStyle(g.querySelector(".area-edge"));
        return { kind, fill: fill.fill, edge: edge.stroke, dash: edge.strokeDasharray };
      }), KINDS);

    // 塗りは5種とも違う（3種はパターン、自陣はベタ塗り、中立は塗らない）。
    expect(new Set(look.map((l) => l.fill)).size).toBe(5);
    expect(look.find((l) => l.kind === "neutral").fill).toBe("none");
    for (const kind of PATTERN_KINDS) {
      expect(look.find((l) => l.kind === kind).fill).toContain(`area-pat-${kind}`);
    }
    // 縁の色も5種とも違う（色だけに頼らないよう、中立だけは破線にもする）。
    expect(new Set(look.map((l) => l.edge)).size).toBe(5);
    expect(look.find((l) => l.kind === "neutral").dash).not.toBe("none");

    // 名前は広く見ているときだけ出す。
    await expect(page.locator("#areas")).toHaveAttribute("data-names", "on");
    await expect(page.locator('#areas .area[data-kind="risk"] .area-name')).toHaveText("危険予測");
    await expect(page.locator('#areas .area[data-kind="key"] .area-name')).toHaveText("最重要");
  });

  test("寄ってもパターンの見た目の大きさは変わらない", async ({ page, context }) => {
    await openPlan(page, context, "9611", "エリアのパターン");
    await pickKind(page, "enemy");
    await dragCells(page, { col: 6, row: 6 }, { col: 9, row: 9 });
    await expect(cells(page, "enemy")).toHaveAttribute("data-cells", "16");

    const patternPx = () =>
      page.evaluate(() => {
        const pat = document.getElementById("area-pat-enemy");
        const m = document.getElementById("board").getScreenCTM();
        return Number(pat.getAttribute("width")) * m.a;
      });

    const far = await patternPx();
    expect(far).toBeCloseTo(8, 1);

    const mid = await cellCenter(page, 8, 8);
    await page.mouse.move(mid.x, mid.y);
    for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, -400);
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", await coverViewBox(page));

    expect(await patternPx()).toBeCloseTo(8, 1);
    // 寄ったら種類名は消える（邪魔になるので）。
    await expect(page.locator("#areas")).toHaveAttribute("data-names", "off");
  });

  // ゲームが決めるもの（コントロールエリアの円・ホットゾーン）と、チームが
  // 手で塗るものの名前が同じだと、Discord で喋ったときどちらの話か決まらない。
  // **パレットに出る語がゲームの用語と衝突していないこと**を機械で押さえる。
  test("パレットの種類名にゲームの用語が出ない（チームの見立てだと分かる）", async ({ page, context }) => {
    await openPlan(page, context, "9613", "エリアの語彙");
    await openZonePanel(page);

    const chips = page.locator("#zone-kinds button");
    await expect(chips).toHaveCount(5);
    expect(await chips.evaluateAll((els) => els.map((e) => e.dataset.kind))).toEqual(KINDS);

    const names = (await chips.allInnerTexts()).join(" ");
    expect(names).not.toContain("コントロール");
    expect(names).not.toContain("ホットゾーン");

    // 「ここで塗るのはチームの見立て」だと、パネルの言葉で分かる。
    await expect(page.locator("#zonepanel")).toContainText("チームの見立て");
    // ゲームが決める円は別の見出しの下にあり、そう書いてある。
    await expect(page.locator("#zp-head")).toContainText("ゲームが決める");
  });

  test("「エリアを表示」を伏せると地図から消え、塗る道具からも抜ける", async ({ page, context }) => {
    await openPlan(page, context, "9612", "エリアの表示切り替え");
    await pickKind(page, "own");
    await dragCells(page, { col: 2, row: 2 }, { col: 3, row: 3 });
    await expect(cells(page, "own")).toHaveAttribute("data-cells", "4");

    await page.getByRole("button", { name: "エリアを表示" }).click();
    await expect(page.locator("#areas")).toBeHidden();
    // 見えない所に塗れる状態を残さない。
    await expect(page.locator('#zone-kinds button[data-kind="own"]'))
      .toHaveAttribute("aria-pressed", "false");

    await page.getByRole("button", { name: "エリアを表示" }).click();
    await expect(page.locator("#areas")).toBeVisible();
    await expect(cells(page, "own")).toHaveAttribute("data-cells", "4");
  });
});

// 引き出し（建造物のパレット / エリアのパネル）は左に1枚だけ開く。
// **カタログの取得は盤面より後なので、届いた時点で「広い画面なら開く」が走る。**
// その間に利用者が「エリア」を開いていると、遅れて来た自動オープンが
// エリアのパネルを黙って閉じてしまう（実測: e2e が 3% の確率で
// 「#zonepanel が hidden のまま」で落ちていた原因がこれ）。
// カタログをわざと遅くして、その窓を必ず通す形で押さえる。
test.describe("引き出しの競合", () => {
  test("カタログが遅れて届いても、自分で開けたエリアのパネルは閉じない", async ({ page, context }) => {
    await loginViaApi(context, "9730", "引き出しの競合");
    const planId = await createPlan(context, "引き出しの競合");

    // カタログだけを 1.5 秒遅らせる。盤面（/api/sessions/:id）は素通しなので、
    // 「盤面は開いたがカタログはまだ」という窓が必ずできる。
    let released = null;
    const gate = new Promise((resolve) => { released = resolve; });
    await page.route("**/api/catalog", async (route) => {
      await gate;
      await route.continue();
    });

    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.getByRole("button", { name: "円とマス", exact: true })).toBeEnabled();

    // 窓の中で自分で開ける。
    await page.getByRole("button", { name: "円とマス", exact: true }).click();
    await expect(page.locator("#zonepanel")).toBeVisible();

    // ここでカタログが届く。広い画面なので「パレットを開く」が走ろうとする。
    released();
    // 中身が組み立てられた（＝カタログが届いた）ことを、開閉に依存しない形で見る。
    await expect(page.locator("#palette h2")).toHaveText("建造物・設置物・車輌");

    // **自分で開けたほうが勝つ。** パレットは開かない。
    await expect(page.locator("#zonepanel")).toBeVisible();
    await expect(page.locator("#palette")).toBeHidden();
    await expect(page.getByRole("button", { name: "円とマス", exact: true }))
      .toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("狭い画面", () => {
  test("390px でフッターの「エリア」がスクロールなしで見える", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPlan(page, context, "9620", "エリアの棚");

    const rail = page.locator("#rail");
    expect(await rail.evaluate((el) => el.scrollLeft)).toBe(0);

    const btn = page.getByRole("button", { name: "円とマス", exact: true });
    const b = await btn.boundingBox();
    const r = await rail.boundingBox();
    // 棚の見えている範囲に、はみ出さずに収まっていること。
    expect(b.x).toBeGreaterThanOrEqual(r.x - 0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(r.x + r.width + 0.5);

    // 押せば開いて、そのまま塗れる。
    await btn.click();
    await expect(page.locator("#zonepanel")).toBeVisible();
    await pickKind(page, "risk");
    // 狭い画面ではパネルが盤面を覆うので、選んだら畳む（置きたい場所を自分で隠さない）。
    await expect(page.locator("#zonepanel")).toBeHidden();
    const c = await cellCenter(page, 8, 12);
    await page.mouse.click(c.x, c.y);
    await expect(cells(page, "risk")).toHaveAttribute("data-cells", "1");
  });
});
