// /plan（ホワイトボード）の UIテスト。
// 実際のブラウザで線が引けること、保存が残ること、API が落ちてもページが
// 壊れないことを確かめる。
import { test, expect } from "@playwright/test";

import {
  boardPoint, coverViewBox, createPlan, createViaGrid, fitViewBox, loginViaApi, mapSizeM,
  openAccountMenu, planUrl, showWholeMap, usePen, waitForGrid,
} from "./plan-helpers.js";


/**
 * マップ上の (x_m, y_m) を通る線を1本引く。
 *
 * **道具が使えるようになるまで待つ。** `#board` が見えていても、プランと
 * マップを読み終えるまでは `setEditable(false)` のままで、引いた線は残らない。
 * 盤面の可視だけを待って引くと、負荷が高いときにだけ空振りする
 * （DECISIONS D-028 が記録している既知のフレーキーの原因）。
 *
 * **ペンを選んでから引く。** 開いた直後の既定は「移動」で、
 * そのままドラッグしても地図が動くだけで線にならない。
 */
async function drawLine(page, points) {
  await expect(page.getByRole("button", { name: "取り消す" })).toBeEnabled();
  // **まだ動かしていないなら、マップ全体が見える状態にしてから引く。**
  // 開いた直後は地図が画面を埋めていて、マップの外周は画面の外にいる。
  // わざと寄った状態で引くテストもあるので、既定のままのときだけ戻す。
  if (await page.locator("#board").getAttribute("viewBox") === await coverViewBox(page)) {
    await showWholeMap(page);
  }
  await usePen(page);
  const screen = [];
  for (const [x, y] of points) screen.push(await boardPoint(page, x, y));
  await page.mouse.move(screen[0].x, screen[0].y);
  await page.mouse.down();
  for (const p of screen.slice(1)) await page.mouse.move(p.x, p.y, { steps: 10 });
  await page.mouse.up();
}

/** 盤面の中心（からのずらし）のビューポート座標。 */
async function boardCenter(page, dx = 0, dy = 0) {
  const box = await page.locator("#board").boundingBox();
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}

/**
 * その画面座標が「今」どのメートル地点を指しているか。
 * ページ本体と同じ getScreenCTM を使うので、ズーム中でも正しい値になる。
 */
function metersAt(page, x, y) {
  return page.evaluate(([cx, cy]) => {
    const board = document.getElementById("board");
    const pt = board.createSVGPoint();
    pt.x = cx;
    pt.y = cy;
    const p = pt.matrixTransform(board.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  }, [x, y]);
}

/** ホイールでマップの中心あたりに寄る。以降のテストの下ごしらえ。 */
async function zoomIn(page, deltaY = -400) {
  // **盤面が読み込み終わるのを先に待つ。**
  // `#board` は静的な HTML なので `toBeVisible()` はページを開いた直後に通るが、
  // viewBox が入るのは getMe → getPlan の2往復が終わってから。待たずにホイールを
  // 送ると「まだ view が無い」ので何も起きず、そのあとで比べて落ちる。
  // 実測: `#board` が見えた時点では `#basemap` の width がまだ 0 だった。
  // `coverViewBox()` は中で寸法が入るまで待つので、これが読み込み完了の合図になる。
  await mapSizeM(page);
  const before = await page.locator("#board").getAttribute("viewBox");
  const c = await boardCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, deltaY);
  await expect(page.locator("#board")).not.toHaveAttribute("viewBox", before);
}

/**
 * 背景の見せ方は畳んだメニュー（#view-menu）の中にある。
 * 一度選ぶと閉じるので、押す前に毎回開く。
 */
async function openViewMenu(page) {
  const menu = page.locator("#view-menu");
  if (!(await menu.evaluate((el) => el.open))) await menu.locator("> summary").click();
}

/**
 * 背景の選択肢を data 属性で名指しする。
 * 畳んでいる間は display:none なので、`getByRole` では見つからない
 * （アクセシビリティツリーから外れる）。状態だけを見たいときはこちらを使う。
 */
const basemapOption = (page, mode) =>
  page.locator(`#basemap-modes button[data-basemap="${mode}"]`);

/** 盤面の bbox（メートル）。線が正しい位置に保存されたかを見るのに使う。 */
function inkBBox(page) {
  return page.locator("#ink path").evaluate((el) => {
    const b = el.getBBox();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
}

test.describe("ホワイトボード", () => {
  test("ログインしていないとログインボタンだけが見える", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e));
    await page.goto(planUrl("/plan"));
    await expect(page.getByRole("button", { name: /Discord でログイン/ })).toBeVisible();
    await expect(page.locator("#board")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("ログインするとマップが描画される", async ({ page, context }) => {
    await loginViaApi(context, "9001", "e2e-user");
    const planId = await createPlan(context, "e2e");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await coverViewBox(page));
    // 「未検証」の文字は建造物パレットの各項目にも出るので、id で名指しする。
    // 置き場所は**縮尺のすぐ隣**（この印が指しているのはマップの一辺）。
    await expect(page.locator("#unverified")).toBeVisible();
    // マップの縁が見えている（盤面の余白との境目）
    await expect(page.locator("#map-bounds")).toHaveCount(1);
    // 背景の地図が敷かれている（0m からマップの一辺までをそのまま覆う）。
    // 一辺はマップごとに違う（Bakurani は 16,320m）ので、数値は直接書かない。
    const basemap = page.locator("#basemap");
    await expect(basemap).toHaveAttribute("href", /\/map\/overview\/bakurani\.webp$/);
    const size = await mapSizeM(page);
    expect(size.w, "背景の幅").toBe(size.h);
    expect(size.w, "背景の幅がマップの一辺になっていない").toBeGreaterThan(16000);
    // 「全体表示」ではマップの一辺がそのまま見えている側（横長の画面なら縦）に出る。
    await page.getByRole("button", { name: "全体表示" }).click();
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await fitViewBox(page));
  });

  test("グリッドがゲーム内と同じ 1km の 16×16 セルになっている", async ({ page, context }) => {
    await loginViaApi(context, "9020", "grid");
    const planId = await createPlan(context, "grid");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    // 1km ごとの線を引く（1000〜16000 の 16本 × 2方向 = 32本）。
    // いちばん外側の縁は #map-bounds が描く。
    // 16本目（16000m）が引かれるのは、**マップの一辺がちょうどの km ではない**から。
    // Bakurani は 16,320m なので、16 個の 1km セルの外に 320m の余りが残る。
    // その境目を線で示す（余りの帯はどのセルにも属さない）。
    await expect(page.locator("#grid line")).toHaveCount(32);

    // 全体表示では 100m の補助線は出さない（潰れて読めなくなるため）。
    await expect(page.locator("#grid-fine line")).toHaveCount(0);

    // 線の位置が 1000m ごとであること（最初の縦線が x=1000）。
    const xs = await page
      .locator("#grid line")
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute("x1")).filter((v, i, a) => a.indexOf(v) === i)
      );
    expect(xs).toContain("1000");
    expect(xs).toContain("15000");
  });

  // セル名は地図の上ではなく盤面の縁（ガター）に出す。詳しくは plan-gutter.spec.js。
  test("セルの呼び名は縁の見出し（A–P × 1–16）として出ている", async ({ page, context }) => {
    await loginViaApi(context, "9021", "labels");
    const planId = await createPlan(context, "labels");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    await expect(page.locator("#gutter-cols .gl")).toHaveCount(16);
    await expect(page.locator("#gutter-rows .gl")).toHaveCount(16);
    await expect(page.locator("#gutter-cols .gl").first()).toHaveText("A");
    // 行は下が 1（ゲームのマップ画面と同じ向き）。DOM の最後 = 画面のいちばん下。
    await expect(page.locator("#gutter-rows .gl").last()).toHaveText("1");
    await expect(page.locator("#gutter-rows .gl").first()).toHaveText("16");

    // 潰れない大きさ（画面で 8px 以上）で出ている。
    const px = await page
      .locator("#gutter-cols .gl")
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(px).toBeGreaterThan(8);
  });

  // 回帰: `pointer-events:none` は当たり判定から外すだけで、テキスト選択の
  // 範囲からは外れない。そのため盤面をドラッグすると 1km セルのラベル
  // （D8 など）が青くハイライトされ、見た目が荒れていた。
  // セル名はガターへ移したが、縁の見出しや地名でも同じことは起こりうる。
  test("盤面をドラッグしてもセルラベルが選択されない", async ({ page, context }) => {
    await loginViaApi(context, "9023", "noselect");
    const planId = await createPlan(context, "noselect");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#gutter-cols .gl")).toHaveCount(16);

    // 縁の見出しの上まで通す（C3 の中心 → H8 の中心）。線を引く操作は従来どおり成立する。
    await drawLine(page, [[2500, 2500], [7500, 7500]]);
    await expect(page.locator("#ink path")).toHaveCount(1);
    expect(await page.evaluate(() => window.getSelection().toString())).toBe("");

    // 移動ツールでのパンでも選択されない（パン自体は効いている）。
    const before = await page.locator("#board").getAttribute("viewBox");
    await page.getByRole("button", { name: "移動" }).click();
    await zoomIn(page, -500);
    const a = await boardPoint(page, 4000, 4000);
    const b = await boardPoint(page, 9000, 9000);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();

    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", before);
    expect(await page.evaluate(() => window.getSelection().toString())).toBe("");

    // 選択を止めたのは道具の部分だけ。配置の詳細（座標や出典）は写せるままにする。
    const detail = await page.evaluate(
      () => getComputedStyle(document.getElementById("placement-detail")).userSelect
    );
    expect(detail).toBe("text");
  });

  test("100m の補助線はズームインしたときだけ出る", async ({ page, context }) => {
    await loginViaApi(context, "9022", "fine");
    const planId = await createPlan(context, "fine");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#grid-fine line")).toHaveCount(0);

    await zoomIn(page, -800);
    await zoomIn(page, -800);
    await expect(page.locator("#grid-fine line")).not.toHaveCount(0);

    await page.getByRole("button", { name: "全体表示" }).click();
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await fitViewBox(page));
    await expect(page.locator("#grid-fine line")).toHaveCount(0);
  });

  test("線が引けて、再読み込みしても残る", async ({ page, context }) => {
    await loginViaApi(context, "9002", "drawer");
    const planId = await createPlan(context, "draw");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    await drawLine(page, [[400, 400], [800, 600], [1200, 450]]);

    await expect(page.locator("#ink path")).toHaveCount(1);
    await expect(page.locator("#status")).toContainText("保存しました");

    await page.reload();
    await expect(page.locator("#ink path")).toHaveCount(1);
  });

  // オーナー報告: 「初期設定がペンだと、スクロールしようとして書いてしまう」。
  // 地図を見るつもりのドラッグが線になってはいけない。
  test("開いた直後の道具は「移動」で、ドラッグしても線にならない", async ({ page, context }) => {
    await loginViaApi(context, "9106", "default-tool");
    const planId = await createPlan(context, "既定の道具");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.getByRole("button", { name: "取り消す" })).toBeEnabled();

    await expect(page.getByRole("button", { name: "移動" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "ペン" }))
      .toHaveAttribute("aria-pressed", "false");

    // 地図の上をドラッグする。線は1本も増えず、見えている範囲が動く。
    await zoomIn(page, -500);
    const before = await page.locator("#board").getAttribute("viewBox");
    const c = await boardCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x - 140, c.y - 70, { steps: 10 });
    await page.mouse.up();

    await expect(page.locator("#ink path")).toHaveCount(0);
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", before);

    // 描きたい人が詰まらないこと。ペンは押せば効く。
    // （パンで動かしたままだと引く先が画面の外に出るので、全体表示に戻す。
    //   戻りは補間が入るので、収まり切るまで待ってから座標を取る）
    await page.getByRole("button", { name: "全体表示" }).click();
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await fitViewBox(page));
    await drawLine(page, [[400, 400], [1200, 900]]);
    await expect(page.locator("#ink path")).toHaveCount(1);
  });

  test("引いた線は割り当てられた色で描かれる", async ({ page, context }) => {
    await loginViaApi(context, "9006", "colored");
    const planId = await createPlan(context, "color");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    await drawLine(page, [[300, 300], [900, 900]]);
    await expect(page.locator("#ink path")).toHaveCount(1);

    // var(--cursor-N) が実際に解決されていること（未解決なら空文字か "none"）。
    const stroke = await page
      .locator("#ink path")
      .evaluate((el) => getComputedStyle(el).stroke);
    expect(stroke).toMatch(/^rgb/);
    expect(stroke).not.toBe("rgb(0, 0, 0)");
  });

  test("消しゴムで自分の線が消える", async ({ page, context }) => {
    await loginViaApi(context, "9003", "eraser");
    const planId = await createPlan(context, "erase");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    await drawLine(page, [[400, 1000], [1400, 1000]]);
    await expect(page.locator("#ink path")).toHaveCount(1);

    const eraser = page.getByRole("button", { name: "消しゴム" });
    await eraser.click();
    await expect(eraser).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "ペン" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    const mid = await boardPoint(page, 900, 1000);
    await page.mouse.click(mid.x, mid.y);
    await expect(page.locator("#ink path")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("#ink path")).toHaveCount(0);
  });

  test("取り消しで直前の線が消える", async ({ page, context }) => {
    await loginViaApi(context, "9004", "undoer");
    const planId = await createPlan(context, "undo");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    await drawLine(page, [[300, 1500], [1500, 1500]]);
    await expect(page.locator("#ink path")).toHaveCount(1);

    // 確認ダイアログを出さない（出ると dialog が握られて click が返らない）。
    await page.getByRole("button", { name: "取り消す" }).click();
    await expect(page.locator("#ink path")).toHaveCount(0);
  });

  test("保存が終わる前に取り消しても線は消える", async ({ page, context }) => {
    await loginViaApi(context, "9010", "hasty");
    const planId = await createPlan(context, "hasty");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    // 保存を意図的に遅らせて「指を離した直後に取り消す」状況を必ず作る。
    await page.route("**/ink", async (route) => {
      await new Promise((r) => setTimeout(r, 1000));
      await route.continue();
    });

    await drawLine(page, [[400, 800], [1400, 800]]);
    await expect(page.locator("#ink path")).toHaveCount(1);
    // まだ保存中（「保存しました」は出ていない）うちに押す
    await expect(page.locator("#status")).not.toContainText("保存しました");
    await page.getByRole("button", { name: "取り消す" }).click();

    await expect(page.locator("#ink path")).toHaveCount(0);
    await expect(page.locator("#status")).toContainText("取り消しました");

    await page.unroute("**/ink");
    await page.reload();
    await expect(page.locator("#ink path")).toHaveCount(0);
  });

  test("マップ外から引き始めた線は受け付けない", async ({ page, context }) => {
    await loginViaApi(context, "9011", "outside");
    const planId = await createPlan(context, "outside");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    // 広い画面ではパレットが左のレターボックスに常設されるので、先に畳む
    // （ここで確かめたいのは「マップ外から引けないこと」で、パレットの話ではない）。
    const palette = page.locator("#palette");
    await expect(palette.locator(".pal-item").first()).toBeAttached();
    if (await palette.isVisible()) {
      await page.getByRole("button", { name: "建造物" }).click();
      await expect(palette).toBeHidden();
    }

    // 盤面の左端とマップの左端の間（レターボックス＝マップ外）を狙う。
    const box = await page.locator("#board").boundingBox();
    // **全体表示にしないとマップの外が見えない**（開いた直後は地図が画面を埋める）。
    await showWholeMap(page);
    // **高さはマップの真ん中を取る。** 上端近く（かつては y=1000m）を狙っていたが、
    // そこは浮いているヘッダの板が覆う帯で、**板の幅は中身で変わる**
    // （作戦名の長さ、板に置いたボタンの数）。公開設定の欄を板に足したとき、
    // 板が x=124 → x=215 まで伸びて、狙っていた点 (140, 44) が
    // `#board` ではなく `<summary>` に当たるようになった（実測）。
    // 真ん中なら、覆うものはパレット（上で畳んだ）しか無い。
    const mapLeft = await boardPoint(page, 0, (await mapSizeM(page)).h / 2);
    // そもそも余白が無い画面では、このテストは何も確かめていない。
    expect(mapLeft.x - box.x, "盤面の左に余白があること").toBeGreaterThan(40);
    const outsideX = (box.x + mapLeft.x) / 2;

    // **狙った点が本当に盤面か。** 浮いている板に当たっていると、線を引く操作が
    // そもそも盤面に届かず、「マップの外だから断られた」と見分けが付かない
    // （＝テストが通っても何も確かめていない状態になる）。先に落とす。
    const onBoard = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.id === "board",
      [outsideX, mapLeft.y]
    );
    expect(onBoard, "狙った点が浮いている板に覆われている").toBe(true);

    // 既定は「移動」なので、線として扱わせるにはペンを選ぶ。
    await usePen(page);
    await page.mouse.move(outsideX, mapLeft.y);
    await page.mouse.down();
    await page.mouse.move(outsideX + 20, mapLeft.y + 40, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator("#status")).toContainText("マップの外です");
    await expect(page.locator("#ink path")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#ink path")).toHaveCount(0);
  });

  test("マップ内で引き始めれば、途中で外へ出ても縁で止めて保存される", async ({ page, context }) => {
    await loginViaApi(context, "9012", "runoff");
    const planId = await createPlan(context, "runoff");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    const box = await page.locator("#board").boundingBox();
    // 右端から 10% 内側から引き始め、盤面右側のレターボックス
    // （マップ外の余白）まではみ出させる。
    const mapW = (await mapSizeM(page)).w;
    // **全体表示にしないとマップの外が見えない**（開いた直後は地図が画面を埋める）。
    await showWholeMap(page);
    const start = await boardPoint(page, mapW * 0.9, 8000);
    const mapRight = await boardPoint(page, mapW, 8000);
    expect(box.x + box.width - mapRight.x, "盤面の右に余白があること").toBeGreaterThan(40);
    const outsideX = (mapRight.x + box.x + box.width) / 2;

    await usePen(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(outsideX, start.y, { steps: 10 }); // マップの外へはみ出す
    await page.mouse.up();

    await expect(page.locator("#ink path")).toHaveCount(1);
    await expect(page.locator("#status")).toContainText("保存しました");

    // 丸めが効いていること: 線はマップの右端を越えていない
    const maxX = await page
      .locator("#ink path")
      .evaluate((el) => el.getBBox().x + el.getBBox().width);
    expect(maxX).toBeLessThanOrEqual(mapW + 0.5);
    expect(maxX).toBeGreaterThan(mapW - 100); // 縁まで届いている＝救済が効いた

    await page.reload();
    await expect(page.locator("#ink path")).toHaveCount(1);
  });

  test("APIが全部落ちてもログイン画面にせず、マップを残して編集だけ止める", async ({ page, context }) => {
    await loginViaApi(context, "9013", "downed");
    const planId = await createPlan(context, "downed");

    const errors = [];
    page.on("pageerror", (e) => errors.push(e));
    // /api/me も含めて全滅させる。ログイン切れ（authenticated:false）とは別物。
    await page.route("**/api/**", (r) => r.abort());
    await page.goto(planUrl(`/plan?id=${planId}`));

    await expect(page.locator("#status")).toContainText("接続できません");
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.getByRole("button", { name: /Discord でログイン/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ペン" })).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test("太さは線のプレビューで選ぶ", async ({ page, context }) => {
    await loginViaApi(context, "9007", "width");
    const planId = await createPlan(context, "width");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    // 太さはペンの設定なので、ペンを持っているときだけ棚に出る。
    await usePen(page);
    // 数値ラベルではなく、太さの見本（.bar）で選ばせる
    await expect(page.locator("#widths button")).toHaveCount(3);
    await expect(page.locator("#widths button .bar")).toHaveCount(3);

    const thick = page.locator('#widths button[data-w="3"]');
    await thick.click();
    await expect(thick).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('#widths button[data-w="2"]')).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    await drawLine(page, [[500, 700], [1500, 700]]);
    await expect(page.locator("#ink path")).toHaveCount(1);
    await expect(page.locator("#ink path")).toHaveAttribute("stroke-width", "6");
  });

  test("タップ対象は 44x44 CSS px 以上", async ({ page, context }) => {
    await loginViaApi(context, "9008", "tapsize");
    const planId = await createPlan(context, "tap");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    // 畳んであるもの・文脈で出るものも、出した状態にしてから測る
    // （閉じたままだと boundingBox が null になり、測れないまま見逃す）。
    await usePen(page);           // 太さはペンを持っているときだけ出る
    await openViewMenu(page);     // 背景・重ねるもの・地図にあるもの

    const buttons = page.locator("#tools button");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      const name = await buttons.nth(i).evaluate((el) => el.id || el.textContent.trim());
      expect(box, `ボタン ${i}（${name}）が測れない`).not.toBeNull();
      expect(box.width, `ボタン ${i}（${name}）の幅`).toBeGreaterThanOrEqual(44);
      expect(box.height, `ボタン ${i}（${name}）の高さ`).toBeGreaterThanOrEqual(44);
    }

    // メニューを開くボタン（<summary>）も同じ大きさを守る。
    const summary = await page.locator("#view-menu > summary").boundingBox();
    expect(summary.width, "背景メニューの幅").toBeGreaterThanOrEqual(44);
    expect(summary.height, "背景メニューの高さ").toBeGreaterThanOrEqual(44);
  });

  test("マップが画面の大半を占める", async ({ page, context }) => {
    await loginViaApi(context, "9009", "layout");
    const planId = await createPlan(context, "layout");
    await page.goto(planUrl(`/plan?id=${planId}`));
    const board = page.locator("#board");
    await expect(board).toBeVisible();

    const viewport = page.viewportSize();
    const box = await board.boundingBox();
    // ツールバーとヘッダがマップを押し出していないこと
    expect(box.height / viewport.height).toBeGreaterThan(0.6);
    expect(box.width).toBeCloseTo(viewport.width, 0);
    // ページ自体はスクロールしない（マップが縦に伸びて溢れていない）
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("API が落ちてもページが壊れない", async ({ page, context }) => {
    await loginViaApi(context, "9005", "offline");
    const planId = await createPlan(context, "offline");

    const errors = [];
    page.on("pageerror", (e) => errors.push(e));
    await page.route("**/api/sessions/**", (r) => r.abort());
    await page.goto(planUrl(`/plan?id=${planId}`));

    await expect(page.locator("#status")).toContainText("接続できません");
    await expect(page.getByRole("button", { name: "ペン" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "取り消す" })).toBeDisabled();
    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator("#tools")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("ズームとパン", () => {
  test("ホイールでズームすると viewBox が変わる", async ({ page, context }) => {
    await loginViaApi(context, "9030", "wheel");
    const planId = await createPlan(context, "wheel");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await coverViewBox(page));

    const c = await boardCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, -400);

    // 寄った＝見える幅がマップの一辺より狭くなった
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", await coverViewBox(page));
    const width = await page
      .locator("#board")
      .evaluate((el) => Number(el.getAttribute("viewBox").split(" ")[2]));
    expect(width).toBeLessThan((await mapSizeM(page)).w);
    expect(width).toBeGreaterThanOrEqual(200);
  });

  test("ズームしてもカーソルの下の地点は動かない", async ({ page, context }) => {
    await loginViaApi(context, "9031", "anchor");
    const planId = await createPlan(context, "anchor");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await coverViewBox(page));

    // 中心をわざと外す（中心だとどんな計算でも偶然一致してしまう）。
    const p = await boardCenter(page, 80, 40);
    const before = await metersAt(page, p.x, p.y);

    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, -300);
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", await coverViewBox(page));

    const after = await metersAt(page, p.x, p.y);
    // 16km 超四方のマップで 1m 未満なら「動いていない」と言ってよい。
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  });

  test("拡大・縮小ボタンと「全体表示」が効く", async ({ page, context }) => {
    await loginViaApi(context, "9032", "zoombtn");
    const planId = await createPlan(context, "zoombtn");
    await page.goto(planUrl(`/plan?id=${planId}`));
    const board = page.locator("#board");
    await expect(board).toHaveAttribute("viewBox", await coverViewBox(page));

    await page.getByRole("button", { name: "拡大" }).click();
    await expect(board).not.toHaveAttribute("viewBox", await coverViewBox(page));

    await page.getByRole("button", { name: "全体表示" }).click();
    await expect(board).toHaveAttribute("viewBox", await fitViewBox(page));

    // 全体表示より外へは引けない（縮小を押しても変わらない）
    await page.getByRole("button", { name: "縮小" }).click();
    await expect(board).toHaveAttribute("viewBox", await fitViewBox(page));
  });

  test("移動ツールのドラッグはパンになり、線は引かれない", async ({ page, context }) => {
    await loginViaApi(context, "9033", "panner");
    const planId = await createPlan(context, "panner");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    // 全体表示のままではパンする先が無いので、先に寄る。
    await zoomIn(page, -500);

    const pan = page.getByRole("button", { name: "移動" });
    await pan.click();
    await expect(pan).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "ペン" })).toHaveAttribute("aria-pressed", "false");

    const before = await page.locator("#board").getAttribute("viewBox");
    const c = await boardCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x - 120, c.y - 60, { steps: 10 });
    await page.mouse.up();

    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", before);
    await expect(page.locator("#ink path")).toHaveCount(0);
  });

  test("スペースキーを押しながらなら、ペンのままでもパンになる", async ({ page, context }) => {
    await loginViaApi(context, "9034", "spacepan");
    const planId = await createPlan(context, "spacepan");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await zoomIn(page, -500);

    // ペンを選び、そのまま（道具を変えずに）スペースでパンできるかを見る。
    // **押したボタンからフォーカスを外す。** ボタンに焦点があるときの
    // スペースは「そのボタンを押す」操作なので、app.js はパンに使わない。
    await usePen(page);
    await page.evaluate(() => document.activeElement?.blur());

    const before = await page.locator("#board").getAttribute("viewBox");
    const c = await boardCenter(page);
    await page.keyboard.down("Space");
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 120, c.y + 60, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Space");

    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", before);
    await expect(page.locator("#ink path")).toHaveCount(0);
  });

  test("パンしてもマップは画面から消えない", async ({ page, context }) => {
    await loginViaApi(context, "9035", "panlimit");
    const planId = await createPlan(context, "panlimit");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    await zoomIn(page, -500);

    await page.getByRole("button", { name: "移動" }).click();
    const c = await boardCenter(page);
    // 端に向かって何度も引っぱる
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.move(c.x - 200, c.y - 200);
      await page.mouse.down();
      await page.mouse.move(c.x + 300, c.y + 300, { steps: 6 });
      await page.mouse.up();
    }

    const view = await page
      .locator("#board")
      .evaluate((el) => el.getAttribute("viewBox").split(" ").map(Number));
    const [x, y, w, h] = view;
    // 見えている範囲がマップと重なり続けている（マップが画面外へ出ていない）
    const map = await mapSizeM(page);
    expect(x).toBeLessThan(map.w);
    expect(y).toBeLessThan(map.h);
    expect(x + w).toBeGreaterThan(0);
    expect(y + h).toBeGreaterThan(0);
    // はみ出しは見えている幅の 1/4 まで
    expect(x).toBeGreaterThanOrEqual(-w * 0.25 - 1);
    expect(y).toBeGreaterThanOrEqual(-h * 0.25 - 1);
  });

  test("ズームした状態で引いた線も、正しいメートル座標で保存される", async ({ page, context }) => {
    await loginViaApi(context, "9036", "zoomdraw");
    const planId = await createPlan(context, "zoomdraw");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    await zoomIn(page, -600);
    await drawLine(page, [[7600, 7600], [8400, 8400]]);
    await expect(page.locator("#ink path")).toHaveCount(1);
    await expect(page.locator("#status")).toContainText("保存しました");

    // 全体表示に戻しても、線は引いた場所にある
    await page.getByRole("button", { name: "全体表示" }).click();
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await fitViewBox(page));

    await page.reload();
    await expect(page.locator("#ink path")).toHaveCount(1);
    const box = await inkBBox(page);
    expect(Math.abs(box.x - 7600)).toBeLessThan(60);
    expect(Math.abs(box.y - 7600)).toBeLessThan(60);
    expect(Math.abs(box.x + box.w - 8400)).toBeLessThan(60);
    expect(Math.abs(box.y + box.h - 8400)).toBeLessThan(60);
  });

  // ゲーム内の座標は**左下が 0,0 ／ x は右 ／ y は上**（オーナーがゲーム内で確認、
  // 2026-09-29）。ここがゲームと食い違うと、オーナーが画面で読んだ数字を
  // そのまま打ち込めない。数字の向きと、セル名の行の向きの両方を見る。
  test("カーソル位置のゲーム内座標とセル名が出る（左下が 0,0 ／ y は上）", async ({ page, context }) => {
    await loginViaApi(context, "9037", "readout");
    const planId = await createPlan(context, "readout");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();
    const { h } = await mapSizeM(page);
    // マップの上端近く（SVG y=3500）まで指すので、全体が見える状態にする。
    await showWholeMap(page);

    // 座標とセル名は別の span。**座標が主役**になったので、値はそちらから読む
     // （`#readout` 全体には「右クリックでコピー」の案内も入っている）。
    const gameXY = async () =>
      (await page.locator("#readout .xy").textContent()).match(/\d+\.\d{2}/g).map(Number);

    // 盤面（SVG）の (7500, 7500)。SVG は上が 0 なので、ゲームの y は下から
    // 測った h - 7500 になる。行は下から数えるので、上から 8 行目は 9。
    const p = await boardPoint(page, 7500, 7500);
    await page.mouse.move(p.x, p.y);

    const readout = page.locator("#readout");
    // ゲーム内と同じ形式（1単位 = 100m、小数2桁）。セル名は添えるだけ。
    await expect(readout.locator(".xy")).toHaveText(/^x\d+\.\d{2} y\d+\.\d{2}$/);
    await expect(readout.locator(".cell")).toHaveText("H9");

    const [gx, gy] = await gameXY();
    expect(Math.abs(gx - 75)).toBeLessThan(1);
    expect(Math.abs(gy - (h - 7500) / 100), "y は下から測る").toBeLessThan(1);

    // 画面の上へ動かすと、ゲームの y は**増える**（北が大きい）。
    // セル名の行番号も一緒に増える。
    const upper = await boardPoint(page, 7500, 3500);
    await page.mouse.move(upper.x, upper.y);
    await expect(readout.locator(".cell")).toHaveText("H13");
    const [, gyUp] = await gameXY();
    expect(gyUp, "上へ動かしたのに y が増えていない").toBeGreaterThan(gy);
  });
});

test.describe("背景の地図", () => {
  test("背景の見せ方は既定がモノクロで、3つを切り替えられる", async ({ page, context }) => {
    await loginViaApi(context, "9040", "basemap");
    const planId = await createPlan(context, "basemap");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    const layer = page.locator("#basemap-layer");
    // 既定はモノクロ（インクの8色が地形に埋もれないため）
    await expect(layer).toHaveAttribute("filter", /url\(#map-mono/);
    await expect(basemapOption(page, "mono")).toHaveAttribute("aria-pressed", "true");

    await openViewMenu(page);
    await page.getByRole("button", { name: "高コントラスト" }).click();
    await expect(layer).toHaveAttribute("filter", /url\(#map-posterize/);
    await expect(basemapOption(page, "posterize")).toHaveAttribute("aria-pressed", "true");
    await expect(basemapOption(page, "mono")).toHaveAttribute("aria-pressed", "false");

    await openViewMenu(page);
    await page.getByRole("button", { name: "カラー" }).click();
    await expect(layer).toHaveAttribute("filter", "none");
  });

  test("選んだ背景の見せ方はリロードしても残る", async ({ page, context }) => {
    await loginViaApi(context, "9041", "basemap2");
    const planId = await createPlan(context, "basemap2");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    await openViewMenu(page);
    await page.getByRole("button", { name: "高コントラスト" }).click();
    await expect(page.locator("#basemap-layer")).toHaveAttribute("filter", /url\(#map-posterize/);
    expect(await page.evaluate(() => localStorage.getItem("wardogs.plan.basemap"))).toBe("posterize");

    await page.reload();
    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#basemap-layer")).toHaveAttribute("filter", /url\(#map-posterize/);
    await expect(basemapOption(page, "posterize")).toHaveAttribute("aria-pressed", "true");
    // 畳んだままでも、いま何かがボタンの上で読める。
    await expect(page.locator("#view-menu > summary")).toContainText("高コントラスト");
  });

  test("背景の画像が届かなくても、グリッドも描画も生きている", async ({ page, context }) => {
    await loginViaApi(context, "9042", "nomap");
    const planId = await createPlan(context, "nomap");

    const errors = [];
    page.on("pageerror", (e) => errors.push(e));
    // overview もタイルも全部落とす
    await page.route("**/map/**", (r) => r.abort());
    await page.goto(planUrl(`/plan?id=${planId}`));

    await expect(page.locator("#board")).toBeVisible();
    await expect(page.locator("#board")).toHaveAttribute("viewBox", await coverViewBox(page));
    await expect(page.locator("#grid line")).toHaveCount(32);
    await expect(page.locator("#gutter-cols .gl")).toHaveCount(16);

    // **壊れた画像のアイコンを盤面いっぱいに出さない。**
    //
    // SVG の `<image>` は読み込みに失敗すると、Chromium が**壊れた画像のアイコンを
    // 要素の大きさいっぱいに描く**。背景はマップの実寸（16km 四方）で張ってあるので、
    // 画面全部がそのアイコンになる。タイルも同じなので、寄ると格子状に並ぶ。
    // **マップ画像を置いていない環境では、それが「地図」に見えてしまう。**
    // 実測: 404 でも、通信断でも、200 で画像以外が返っても、同じ絵になる
    // （`wrangler pages dev` と Cloudflare Pages は、無いパスに index.html を
    //   200 で返すので「404 なら安全」は成り立たない）。
    await expect(page.locator("#basemap")).toBeHidden();

    // **ただし場所は保つ。** `display:none` にすると矩形が 0 になり、
    // 「地図が画面を埋めているか」を測る試験（e2e/plan-layout.spec.js）が
    // 読む `getBoundingClientRect()` が壊れる。隠すのは visibility のほうで、
    // 「見えないが、そこにある」状態にする。
    const box = await page.locator("#basemap").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, visibility: getComputedStyle(el).visibility };
    });
    expect(box.visibility).toBe("hidden");
    expect(box.w).toBeGreaterThan(0);
    expect(box.h).toBeGreaterThan(0);

    // 詳細タイルも同じ扱い（1枚でも出ていたら格子に見える）
    const tiles = page.locator("#basemap-tiles image");
    for (let i = 0; i < await tiles.count(); i += 1) {
      await expect(tiles.nth(i)).toBeHidden();
    }

    await drawLine(page, [[3000, 3000], [5000, 5000]]);
    await expect(page.locator("#ink path")).toHaveCount(1);
    await expect(page.locator("#status")).toContainText("保存しました");
    expect(errors).toEqual([]);
  });
});

test.describe("作戦を作る", () => {
  // ?id= 無しの /plan は「マップ × 想定するパターン」の**枠の表**（D-046）。
  // 常設の作成フォームは置かない。**空いている枠そのものが作る入口**で、
  // マップもパターンも押した枠が決める（選ぶ欄が無い）。
  test("ログイン済みで id 指定が無いと、枠の表が見える", async ({ page, context }) => {
    await loginViaApi(context, "9101", "creator");
    await page.goto(planUrl("/plan"));
    await waitForGrid(page);

    // マップの区画が3つとも出る（作戦が0件でも）。
    await expect(page.locator("#sessions .s-group")).toHaveCount(3);
    // 空の枠には作る口がある。
    await expect(page.locator("#sessions button.s-new").first()).toBeVisible();
    // 題名の欄は枠を押すまで出さない（常設しない）。
    await expect(page.locator("#create-title")).toHaveCount(0);
    // ?id= が無い間は #board を出さない（一覧と排他）。
    await expect(page.locator("#board")).toHaveCount(0);
  });

  test("枠を押して題名を入れると新しい作戦に遷移する", async ({ page, context }) => {
    await loginViaApi(context, "9102", "creator2");
    await page.goto(planUrl("/plan"));
    await createViaGrid(page, "新しい作戦");

    await expect(page).toHaveURL(/\/plan\?id=[\w-]{22}$/);
    await expect(page.locator("#board")).toBeVisible();
  });

  test("題名が空のまま押すと、遷移せず理由が表示される", async ({ page, context }) => {
    await loginViaApi(context, "9103", "creator3");
    await page.goto(planUrl("/plan"));
    await waitForGrid(page);

    await page.locator("#sessions button.s-new").first().click();
    // 題名は枠の名前で埋まっている（そのまま Enter で作れる）。空にしてから押す。
    await expect(page.locator("#create-title")).not.toHaveValue("");
    await page.locator("#create-title").fill("");
    await page.getByRole("button", { name: "作戦を作る" }).click();

    await expect(page.locator("#status")).toContainText("題名を入力してください");
    await expect(page).toHaveURL(planUrl("/plan"));
    await expect(page.locator("#board")).toHaveCount(0);
  });

  test("共有URLをコピーするボタンが ?id= があるときに見える", async ({ page, context }) => {
    await loginViaApi(context, "9104", "sharer");
    const planId = await createPlan(context, "share-test");
    await page.goto(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    // 共有は「自分」のメニューの中（枠に常駐させない）。
    await openAccountMenu(page);
    const shareBtn = page.getByRole("button", { name: "共有URLをコピー" });
    await expect(shareBtn).toBeVisible();
    await shareBtn.click();
    // クリップボードの中身は環境依存なので検証しない。#status が変化することだけ見る。
    await expect(page.locator("#status")).not.toHaveText("");
  });

  // **枠を描くにはマップ（＝パターンの一覧）が要る。**取れないと枠は出せないが、
  // **作ってある作戦は開ける**必要がある（試合中はこちらのほうが大事）。
  // 行き止まりにせず、理由を書いて旧来のマップごとの一覧に落とす。
  test("マップ取得が失敗しても、作ってある作戦は一覧から開ける", async ({ page, context }) => {
    await loginViaApi(context, "9105", "mapsdown");
    const planId = await createPlan(context, "マップが落ちても開ける");
    await page.route("**/api/maps", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
    );
    await page.goto(planUrl("/plan"));

    // 理由が画面に出る（黙って空の画面にしない）。
    await expect(page.locator("#session-grid .err")).toContainText("空いている枠を出せません");

    // それでも行は出て、そこから開ける。
    const row = page.locator("#sessions li", { hasText: "マップが落ちても開ける" });
    await expect(row).toHaveCount(1);
    await row.getByRole("link", { name: "開く" }).click();
    await expect(page).toHaveURL(planUrl(`/plan?id=${planId}`));
    await expect(page.locator("#board")).toBeVisible();

    await page.unroute("**/api/maps");
  });
});
