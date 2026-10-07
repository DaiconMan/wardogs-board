// 共有カーソルと変更通知（Phase R1）の UIテスト。
//
// **仕様書の受け入れ条件をそのまま機械にする。**
// `docs/superpowers/specs/2026-10-02-r1-cursor-and-change-notify.md`
//
//   1. 片方でマウスを動かすと、もう片方に名前付きのカーソルが 200ms 以内に出る
//   2. 片方で敵 FOB を動かすと、もう片方にリロード無しで1秒以内に反映される
//   4. WebSocket を塞いだ状態で、配置・移動・削除・描画が全部通る
//   5. 50接続を張った状態で 1〜4 が成立する（仕様当時は 20。上限を上げた）
//
// 3（2分静止して duration が伸びない）は Playwright では測れない。
// タイマーの継続判定は tests/room-cursors.test.js が単体で見ている。
//
// **2 はオーナーが報告した現象の直接の反証。**
// > やっぱり何も出ないですね。ちなみに敵FOBを移動させても片方に反映されないです
//
// テスト用 Discord ID の帯: 9802–9891 と 10001–10101（e2e/config.js の採番表を参照）\n// 5桁のほうは在室50人の2本だけが使う（4桁に100個の連続した空きが無い）。
// **9840 / 9841 / 9850 / 9851 は shots.spec.js のものなので使わない。**
import { expect, test } from "@playwright/test";

import { CURSOR_TTL_MS } from "../public/js/plan/cursors.js";

import {
  boardPoint, createPlan, joinRoom, loginHeadless, loginViaApi, mapSizeM, planUrl,
  showWholeMap, usePen,
} from "./plan-helpers.js";

/** 敵FOB の記号（試合の要素）。オーナーが「反映されない」と報告したのがこれ。 */
const ENEMY_FOB = "mk_enemy_fob";

const cursors = (page) => page.locator("#cursor-layer .cursor");
const fob = (page) => page.locator(`#placements .pm[data-item-id="${ENEMY_FOB}"]`);

/** マップ座標（SVG ユーザー単位）で、その要素がどこに居るか。 */
const translateOf = (locator) =>
  locator.evaluate((el) => {
    const m = el.getAttribute("transform")?.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  });

async function openPlan(page, planId) {
  await page.goto(planUrl(`/plan?id=${planId}`));
  await mapSizeM(page);
  // マップ座標で位置を指すので、全体が見える状態にしてから触る。
  await showWholeMap(page);
}

/** 2人が同じ作戦を開いた状態を作る。戻り値は [ホスト側, 相手側]。 */
async function openTwo(browser, planTitle, [idA, nameA], [idB, nameB]) {
  const a = await browser.newContext();
  const b = await browser.newContext();
  await loginViaApi(a, idA, nameA);
  await loginViaApi(b, idB, nameB);
  const planId = await createPlan(a, planTitle);

  const pageA = await a.newPage();
  await openPlan(pageA, planId);
  const pageB = await b.newPage();
  await openPlan(pageB, planId);

  // 在室が揃ってから始める（カーソルの名前は在室一覧から引く）。
  await expect(page2Names(pageA)).toHaveText([nameA, nameB].sort((x, y) => x.localeCompare(y, "ja")));
  await expect(page2Names(pageB)).toHaveCount(2);
  return { a, b, pageA, pageB, planId };
}

const page2Names = (page) => page.locator("#presence .pres-name");

/**
 * パレットから項目を選んで置く（plan-placements.spec.js と同じ手順）。
 *
 * 戻り値は**盤面を押した時刻**。棚を開いて項目を選ぶ手間（1秒近くかかる）を
 * 遅延の計測に混ぜないため（混ぜると「通知が1秒かかった」という嘘の数字が出る）。
 */
async function placeItem(page, kind, itemId, x, y) {
  const palette = page.locator("#palette");
  await expect(palette.locator(".pal-item").first()).toBeAttached();
  if (!(await palette.isVisible())) await page.getByRole("button", { name: "建造物" }).click();
  const group = palette.locator(`.pal-group[data-kind="${kind}"]`);
  if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
  const item = palette.locator(`.pal-item[data-item-id="${itemId}"]`);
  if ((await item.getAttribute("aria-pressed")) !== "true") await item.click();
  await expect(item).toHaveAttribute("aria-pressed", "true");

  const markers = page.locator("#placements .pm");
  const before = await markers.count();
  const p = await boardPoint(page, x, y);
  const clickedAt = Date.now();
  await page.mouse.click(p.x, p.y);
  await expect(markers).toHaveCount(before + 1);
  await expect(page.locator("#status")).toContainText("を置きました");
  return clickedAt;
}

// ══ 受け入れ条件 1 ══════════════════════════════════════════════
test("片方でマウスを動かすと、もう片方に名前付きのカーソルが出る", async ({ browser }) => {
  const { a, b, pageA, pageB } = await openTwo(
    browser, "カーソル1", ["9802", "さす人"], ["9803", "みる人"]
  );

  // **相手の画面は別のズームにしておく。** 送っているのが画面 px ではなく
  // マップのメートル座標であることを、ここで確かめる（px を送っていたら
  // ズームが違う時点で別の地点を指す）。
  await pageB.getByRole("button", { name: "拡大" }).click();

  // カーソルが出た瞬間を相手の画面側で記録する（往復の実測）。
  await pageB.evaluate(() => {
    window.__seenAt = null;
    const layer = document.getElementById("cursor-layer");
    const check = () => {
      if (window.__seenAt === null && layer.querySelector(".cursor")) window.__seenAt = Date.now();
    };
    new MutationObserver(check).observe(layer, { childList: true, subtree: true });
    check();
  });

  const at = await boardPoint(pageA, 8000, 4000);
  const t0 = Date.now();
  await pageA.mouse.move(at.x, at.y);

  await expect(cursors(pageB)).toHaveCount(1);
  const seenAt = await pageB.evaluate(() => window.__seenAt);
  const latency = seenAt - t0;
  console.log(`受け入れ条件1: カーソルが相手の画面に出るまで ${latency}ms`);
  // 仕様は 200ms。CI の揺れを見込んで 2.5倍で止める（これを超えたら
  // 「同時に同じ画面を見ている」感じが壊れている）。
  expect(latency).toBeLessThan(500);

  // 名前が付いている（8色を超えると色相が重なるので、名前が最後の手がかり）。
  await expect(cursors(pageB).locator(".cursor-name")).toHaveText("さす人");

  // **同じ地点を指している。** 相手はズームが違うが、送っているのがマップ座標
  // なので盤面の同じ場所に出る。
  //
  // `boardPoint` は SVG ユーザー単位で指すので、期待値もその単位。通り道は
  //   A の画面 px → pointerToMeters（上下反転）→ 整数のメートルで送信
  //   → B が toSvg（もう一度反転）→ 元の SVG 座標
  // で、**往復して戻ってくることがここの意味**（片方でも反転が抜けていれば
  // y が h - 4000 側に出る）。
  const where = await translateOf(cursors(pageB));
  expect(Math.abs(where.x - 8000)).toBeLessThan(40);
  expect(Math.abs(where.y - 4000)).toBeLessThan(40);

  // 自分のカーソルは描かない（OS のポインタと二重になる）。
  await expect(cursors(pageA)).toHaveCount(0);

  await a.close();
  await b.close();
});

// **同じ人が2枚開いた場合**（本番でオーナーが踏んだ形。2026-10-02）。
//
// > ピンは移動したら即時反映されるのですが、マウスカーソルは出ないですね
//
// 「ピンは出るがカーソルだけ出ない」は、この形でだけ起きる:
//   * `chg` は**送信者のソケット**だけ除いて配るので、同じ人の別タブには届く
//   * `cur` は**人（Discord ID）**でキーを持っていたので、唯一あるカーソルを
//     両方のタブが「自分のもの」として消していた
//
// **2枚開いている人は実際にポインタを2つ持っている。** 消すべきなのは
// 自分のタブのカーソルであって、同じ人の別タブのカーソルではない。
//
// 在室が1人のままなのは D-047 の設計どおり（上限は「人」の数）。ここは仕様。
test("同じアカウントで2枚開いても、もう片方のタブにカーソルが出る", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9891", "ふたまた");
  const planId = await createPlan(ctx, "同一アカウント2タブ");

  const pageA = await ctx.newPage();
  await openPlan(pageA, planId);
  const pageB = await ctx.newPage();
  await openPlan(pageB, planId);

  // 在室は「人」の数（D-047）。2枚開いても1人のまま。
  await expect(page2Names(pageA)).toHaveCount(1);
  await expect(page2Names(pageB)).toHaveCount(1);

  // 動かすほうのタブを前に出す（裏に回ったタブは送らない。board/cursor.js）。
  await pageA.bringToFront();
  const at = await boardPoint(pageA, 8000, 4000);
  await pageA.mouse.move(at.x, at.y);

  // **もう片方のタブに出る。** ここが落ちていた。
  await expect(cursors(pageB)).toHaveCount(1);
  await expect(cursors(pageB).locator(".cursor-name")).toHaveText("ふたまた");
  const where = await translateOf(cursors(pageB));
  expect(Math.abs(where.x - 8000)).toBeLessThan(40);
  expect(Math.abs(where.y - 4000)).toBeLessThan(40);

  // **自分のタブには出ない。** OS のポインタと二重になる。
  // 「人で外す」のをやめても、ここが守られていなければ直したことにならない。
  await expect(cursors(pageA)).toHaveCount(0);

  await ctx.close();
});

test("盤面から出ると相手の画面からカーソルが消える", async ({ browser }) => {
  const { a, b, pageA, pageB } = await openTwo(
    browser, "カーソル2", ["9804", "出る人"], ["9805", "のこる人"]
  );

  const at = await boardPoint(pageA, 6000, 6000);
  await pageA.mouse.move(at.x, at.y);
  await expect(cursors(pageB)).toHaveCount(1);

  // **道具の上へ指を移す ＝ 盤面から出た。**
  //
  // ヘッダやフッタの「隙間」へ動かしても出たことにはならない。
  // `#board` はビューポート全面で、枠（header / footer）自身は
  // `pointer-events:none`、中の操作子だけが触れる作りだから
  // （plan-base.css の「板と板の隙間はどこでも地図として触れる」）。
  // 隙間を指しているのは**地図を指している**ので、消すほうが間違い。
  const btn = await pageA.locator("#tool-pen").boundingBox();
  const leftAt = Date.now();
  await pageA.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2);
  await expect(cursors(pageB)).toHaveCount(0);
  const latency = Date.now() - leftAt;
  console.log(`盤面から出てからカーソルが消えるまで ${latency}ms`);
  // **3秒 TTL では消えていないこと。** 消す通は配信の窓を無視して即送られる
  // （DO の `sendCursors(force)`）。TTL は切断の取りこぼし用の保険であって、
  // ふつうの「盤面から出た」でそこまで待たせると「まだ指している」に見える。
  expect(latency).toBeLessThan(CURSOR_TTL_MS);

  await a.close();
  await b.close();
});

// **自分が引く線の色と、相手に見える自分のカーソルの色が同じであること。**
// サーバは部屋の中で色がぶつからないようずらすことがあるので、開いた直後の
// 仮の色（Discord ID のハッシュ）のままだと食い違う。食い違うと、
// インクには名前が無いので「どの線が誰のか」が分からなくなる（D-047 / D-048）。
test("自分のペンの色と、相手に見える自分のカーソルの色が同じ", async ({ browser }) => {
  const { a, b, pageA, pageB } = await openTwo(
    browser, "色合わせ", ["9864", "いろА"], ["9865", "いろБ"]
  );

  // A のペンの色（CSS 変数 --me が指している番号）。
  const penVar = await pageA.evaluate(
    () => document.documentElement.style.getPropertyValue("--me").trim()
  );
  expect(penVar).toMatch(/^var\(--cursor-[1-8]\)$/);

  // 相手の画面に出る A のカーソルの色。
  const at = await boardPoint(pageA, 7000, 7000);
  await pageA.mouse.move(at.x, at.y);
  await expect(cursors(pageB)).toHaveCount(1);
  const cursorFill = await cursors(pageB).locator(".cursor-arrow").getAttribute("fill");
  expect(cursorFill).toBe(penVar);

  // 在室一覧の粒の色とも揃っている（3か所が同じ番号）。
  const chipBg = await pageB
    .locator("#presence .pres-chip:not([data-me]) .pres-dot")
    .getAttribute("style");
  expect(chipBg).toContain(penVar);

  // 実際に引いた線にもその色が乗る。
  await usePen(pageA);
  const p1 = await boardPoint(pageA, 3000, 3000);
  const p2 = await boardPoint(pageA, 5000, 5000);
  await pageA.mouse.move(p1.x, p1.y);
  await pageA.mouse.down();
  await pageA.mouse.move(p2.x, p2.y, { steps: 8 });
  await pageA.mouse.up();
  await expect(pageA.locator("#status")).toContainText("保存しました");
  // 線の色は `style` 経由（render.js: プレゼンテーション属性に custom property を
  // 書くのはブラウザ依存なので、インラインスタイルで当てている）。
  const strokeVar = await pageA
    .locator("#ink path")
    .evaluate((el) => el.style.getPropertyValue("stroke").trim());
  expect(strokeVar).toBe(penVar);

  await a.close();
  await b.close();
});

// **送りすぎない。** 受信は到達した時点で課金される（調査 §2.4）ので、
// 枠を決めているのはクライアントの送信頻度。しかも DO は毎秒30通を超えた
// socket を閉じるので、**送りすぎると自分で自分を切断する。**
test("マウスを振り回しても送信は 10Hz を超えない", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9861", "ふりまわす");
  const planId = await createPlan(ctx, "送信量");
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__sent = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      if (String(d).includes('"cur"')) window.__sent.push(Date.now());
      return orig.call(this, d);
    };
  });
  await openPlan(page, planId);
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);
  await page.evaluate(() => { window.__sent.length = 0; });

  // 盤面の上で 1秒ぶん振り回す（60fps 相当の 60 回）。
  const a = await boardPoint(page, 4000, 4000);
  const b = await boardPoint(page, 10000, 10000);
  const started = Date.now();
  for (let i = 0; i < 60; i += 1) {
    const t = i / 59;
    await page.mouse.move(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  }
  const movedMs = Date.now() - started;
  await page.waitForTimeout(500);
  const onBoard = await page.evaluate(() => window.__sent.length);
  const hz = onBoard / ((movedMs + 500) / 1000);
  console.log(`盤面の上で振り回したとき: ${onBoard}通 / ${movedMs + 500}ms = ${hz.toFixed(1)}Hz`);
  // 10Hz + 末尾1通 + 止まったあとの1通ぶんの余裕。30Hz（DO が切る線）には遠い。
  expect(hz).toBeLessThan(15);

  // **棚のボタンの上を横切る。** ここで「消して」を連打すると、
  // pointermove の 60Hz がそのまま送信になって自分で切断される。
  await page.evaluate(() => { window.__sent.length = 0; });
  const pen = await page.locator("#tool-pen").boundingBox();
  const fit = await page.locator("#zoom-fit").boundingBox();
  for (let i = 0; i < 40; i += 1) {
    const t = i / 39;
    await page.mouse.move(
      pen.x + (fit.x - pen.x) * t,
      pen.y + pen.height / 2 + (fit.y - pen.y) * t
    );
  }
  await page.waitForTimeout(300);
  const offBoard = await page.evaluate(() => window.__sent.length);
  console.log(`棚の上を 40回 横切ったとき: ${offBoard}通`);
  // 「消して」は1通で足りる（既に消えているなら送らない）。
  expect(offBoard).toBeLessThanOrEqual(2);

  // 切断されていない（在室一覧が生きている）。
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

  await ctx.close();
});

test("タブを閉じた人のカーソルは残らない", async ({ browser }) => {
  const { a, b, pageA, pageB } = await openTwo(
    browser, "カーソル3", ["9806", "きえる人"], ["9807", "のこる人2"]
  );

  const at = await boardPoint(pageA, 5000, 5000);
  await pageA.mouse.move(at.x, at.y);
  await expect(cursors(pageB)).toHaveCount(1);

  await a.close();
  await expect(cursors(pageB)).toHaveCount(0);
  await expect(page2Names(pageB)).toHaveCount(1);

  await b.close();
});

// ══ 受け入れ条件 2 ══════════════════════════════════════════════
// オーナーの報告「敵FOBを移動させても片方に反映されない」の直接の反証。
test("片方で敵FOBを置くと、もう片方にリロード無しで出る", async ({ browser }) => {
  const { a, b, pageA, pageB } = await openTwo(
    browser, "通知1", ["9808", "おく人"], ["9809", "みる人2"]
  );

  await expect(fob(pageB)).toHaveCount(0);

  // 相手の画面に出た瞬間を記録する（押した時刻からの往復を測る）。
  await pageB.evaluate(() => {
    window.__fobAt = null;
    const layer = document.getElementById("placements");
    const check = () => {
      if (window.__fobAt === null && layer.querySelector('.pm[data-item-id="mk_enemy_fob"]')) {
        window.__fobAt = Date.now();
      }
    };
    new MutationObserver(check).observe(layer, { childList: true, subtree: true });
  });

  const clickedAt = await placeItem(pageA, "objective", ENEMY_FOB, 8000, 4000);
  await expect(fob(pageB)).toHaveCount(1);
  const latency = (await pageB.evaluate(() => window.__fobAt)) - clickedAt;
  console.log(`受け入れ条件2(置く): 押してから相手に出るまで ${latency}ms`);
  expect(latency).toBeLessThan(1000);

  // **リロードしていない**ことの念押し（同じページのまま出ている）。
  await expect(pageB.locator("#board")).toBeVisible();

  await a.close();
  await b.close();
});

test("片方で敵FOBを動かすと、もう片方にリロード無しで1秒以内に反映される", async ({ browser }) => {
  const { a, b, pageA, pageB } = await openTwo(
    browser, "通知2", ["9810", "うごかす人"], ["9811", "みる人3"]
  );

  await placeItem(pageA, "objective", ENEMY_FOB, 8000, 4000);
  await expect(fob(pageB)).toHaveCount(1);
  const from = await translateOf(fob(pageB));

  // 相手の画面で「動いた瞬間」を記録する。
  await pageB.evaluate((startX) => {
    window.__movedAt = null;
    const layer = document.getElementById("placements");
    const check = () => {
      const el = layer.querySelector('.pm[data-item-id="mk_enemy_fob"]');
      const m = el?.getAttribute("transform")?.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
      if (m && Math.abs(Number(m[1]) - startX) > 500) window.__movedAt ??= Date.now();
    };
    new MutationObserver(check).observe(layer, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["transform"],
    });
  }, from.x);

  const p1 = await boardPoint(pageA, 8000, 4000);
  const p2 = await boardPoint(pageA, 11000, 7000);
  await pageA.mouse.move(p1.x, p1.y);
  await pageA.mouse.down();
  await pageA.mouse.move(p2.x, p2.y, { steps: 8 });
  const t0 = Date.now();
  await pageA.mouse.up();
  await expect(pageA.locator("#status")).toContainText("動かしました");

  await expect.poll(() => pageB.evaluate(() => window.__movedAt), { timeout: 10_000 })
    .not.toBeNull();
  const movedAt = await pageB.evaluate(() => window.__movedAt);
  // **Phase R2a で、動き始めが離す前に来るようになった**（運んでいる最中が
  // 相手の画面にも出る）。R1 のときここは「離してから 431〜441ms」で、
  // いまは負の値になりうる。動き出しの速さはもう受け入れ条件ではないので記録だけ。
  console.log(`動き始めるまで ${movedAt - t0}ms（負 ＝ 離す前から動いている。R2a）`);

  // **受け入れ条件2の本体はここ。** 相手の画面が同じ地点を指すまでを測る。
  //
  // **一致するまで待ってから読む。** 読んだ値をそのまま突き合わせると、
  // まだ運んでいる最中の位置を「届いた」と誤読する（CI で実測: 11000 のはずが
  // 10625。ローカルでは最後まで届いていて気づけなかった）。
  await expect.poll(async () => Math.abs((await translateOf(fob(pageB))).x - 11000), {
    timeout: 10_000,
  }).toBeLessThan(60);
  const latency = Date.now() - t0;
  console.log(`受け入れ条件2(動かす): 相手が同じ地点を指すまで ${latency}ms`);
  expect(latency).toBeLessThan(1000);

  // **運んでいる印が外れたあとも同じ地点。**
  // 上の一致は運んでいる最中の絵でも満たせるので、絵を剥がしてもう一度見る。
  // ここで一致していれば、D1 から来た確定値が同じだということ
  // （絵だけ動かして保存していない、という壊れ方をしていない）。
  await expect(fob(pageB)).not.toHaveAttribute("data-carry", "1");
  expect(Math.abs((await translateOf(fob(pageB))).x - 11000)).toBeLessThan(60);

  await a.close();
  await b.close();
});

test("片方で消すと、もう片方からも消える", async ({ browser }) => {
  const { a, b, pageA, pageB } = await openTwo(
    browser, "通知3", ["9812", "けす人"], ["9813", "みる人4"]
  );

  await placeItem(pageA, "objective", ENEMY_FOB, 7000, 7000);
  await expect(fob(pageB)).toHaveCount(1);

  await pageA.getByRole("button", { name: "取り消す" }).click();
  await expect(pageA.locator("#status")).toContainText("取り消しました");
  await expect(fob(pageB)).toHaveCount(0);

  await a.close();
  await b.close();
});

test("片方で引いた線が、もう片方に出る", async ({ browser }) => {
  const { a, b, pageA, pageB } = await openTwo(
    browser, "通知4", ["9814", "ひく人"], ["9815", "みる人5"]
  );

  await usePen(pageA);
  const p1 = await boardPoint(pageA, 4000, 4000);
  const p2 = await boardPoint(pageA, 9000, 9000);
  await pageA.mouse.move(p1.x, p1.y);
  await pageA.mouse.down();
  await pageA.mouse.move(p2.x, p2.y, { steps: 8 });
  await pageA.mouse.up();
  await expect(pageA.locator("#status")).toContainText("保存しました");

  await expect(pageB.locator("#ink path")).toHaveCount(1);

  await a.close();
  await b.close();
});

// **再取得は手元の作業を壊さない。**
// 盤面を丸ごと作り直すと、取り消しの台帳（state.mine）が持っている参照も
// 選んでいたものも宙に浮く。そうなると「他人が何か保存するたびに自分の
// 作業が壊れる」ので、変更通知を入れた意味が無くなる。
test("相手の保存で再取得が走っても、自分の取り消しと選択は生きている", async ({ browser }) => {
  const { a, b, pageA, pageB } = await openTwo(
    browser, "壊さない", ["9859", "こちら"], ["9860", "あちら"]
  );

  // 自分で線を引いて、自分で配置を置いて、置いたものを選んだ状態にする。
  await usePen(pageA);
  const p1 = await boardPoint(pageA, 3000, 3000);
  const p2 = await boardPoint(pageA, 5000, 5000);
  await pageA.mouse.move(p1.x, p1.y);
  await pageA.mouse.down();
  await pageA.mouse.move(p2.x, p2.y, { steps: 8 });
  await pageA.mouse.up();
  await expect(pageA.locator("#status")).toContainText("保存しました");
  await placeItem(pageA, "objective", ENEMY_FOB, 7000, 7000);
  await expect(pageA.locator("#placement-detail")).toBeVisible();

  // **相手側にこちらの分が届き切るのを待ってから置く。**
  // 待たずに置くと、`placeItem` が数える「置く前の数」を読んだ直後に
  // 再取得が1件増やしてしまい、数が合わずに落ちる（実測で踏んだ）。
  await expect(fob(pageB)).toHaveCount(1);
  await expect(pageB.locator("#ink path")).toHaveCount(1);

  // 相手が別の場所に置く → こちらで再取得が走る。
  await placeItem(pageB, "objective", "mk_hq", 11000, 11000);
  await expect(pageA.locator('#placements .pm[data-item-id="mk_hq"]')).toHaveCount(1);

  // 選んでいた詳細は開いたまま。
  await expect(pageA.locator("#placement-detail")).toBeVisible();

  // **取り消しが効く。** 1回目は配置、2回目は線（操作した順の逆）。
  await pageA.getByRole("button", { name: "取り消す" }).click();
  await expect(pageA.locator("#status")).toContainText("取り消しました");
  await expect(fob(pageA)).toHaveCount(0);

  await pageA.getByRole("button", { name: "取り消す" }).click();
  await expect(pageA.locator("#status")).toContainText("取り消しました");
  // ここが本題。作り直していると、サーバからは消えても画面に残る。
  await expect(pageA.locator("#ink path")).toHaveCount(0);

  // 相手の置いたものは残っている（自分の取り消しが相手のものを巻き込まない）。
  await expect(pageA.locator('#placements .pm[data-item-id="mk_hq"]')).toHaveCount(1);

  await a.close();
  await b.close();
});

// **置いた直後に注記へ書き始める導線を、読み込みの着地が壊さない。**
// 盤面に当て直すとき詳細パネルを組み直すとフォーカスが飛ぶ。R1 で
// 配置と地名の読み込みを「差分で当てる」形にしたときに踏んだ回帰で、
// 全体実行でだけ落ちる（地名の取得が置いた「あと」に着地したときだけ起きる）形だった。
test("地名の読み込みが遅れて着地しても、注記のフォーカスが飛ばない", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9866", "ふぉーかす");
  const planId = await createPlan(ctx, "フォーカス");
  const page = await ctx.newPage();
  // 地名の取得だけ遅らせて、置いた「あと」に必ず着地させる（競走を固定する）。
  await page.route("**/callouts", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await openPlan(page, planId);

  await placeItem(page, "objective", "mk_note", 8000, 8000);
  await expect(page.locator("#placement-label")).toBeFocused();

  // 遅れていた地名がここで着地する。
  await page.waitForTimeout(2000);
  await expect(page.locator("#placement-label")).toBeFocused();
  await page.keyboard.type("ここ重要");
  await expect(page.locator("#placement-label")).toHaveValue("ここ重要");

  await ctx.close();
});

// **暴走したクライアントは閉じる。**
// 受信は到達した時点で課金されるので、無視しても枠は減る（調査 §2.4）。
// 止める方法は閉じることだけで、これが無いと壊れたタブ1枚が1日枠を数分で溶かす。
test("毎秒30通を超えて送ってくる接続は閉じられる（他の人は無事）", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9862", "まとも");
  const planId = await createPlan(ctx, "暴走");
  const page = await ctx.newPage();
  await openPlan(page, planId);
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

  const mad = await joinRoom(await loginHeadless("9863", "あばれる"), planId);
  await expect(page.locator("#presence .pres-chip")).toHaveCount(2);

  // 1秒に 100通。正常なクライアント（10Hz）の10倍。
  for (let i = 0; i < 100; i += 1) {
    mad.send(JSON.stringify({ t: "cur", x: 1000 + i, y: 2000 }));
  }

  // 1008 = Policy Violation。
  await expect.poll(() => mad.closed?.code, { timeout: 10_000 }).toBe(1008);

  // **まともな人は巻き込まれない。** 盤面も在室も生きている。
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);
  await expect(page.locator("#board")).toBeVisible();
  await placeItem(page, "objective", ENEMY_FOB, 6000, 6000);
  await expect(fob(page)).toHaveCount(1);

  await ctx.close();
});

// ══ 受け入れ条件 4 ══════════════════════════════════════════════
// **これが R0 からの設計の核。** リアルタイムは上乗せであって前提ではない
// （`/api/sessions/:id/ws` が 503 を返す環境が実在する）。
test("WebSocket を塞いでも、配置・移動・削除・描画が全部通る", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9816", "ふさぐ人");
  const planId = await createPlan(ctx, "WS遮断");

  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.WebSocket = function BlockedWebSocket() {
      throw new Error("WebSocket は使えません（テスト）");
    };
  });
  await openPlan(page, planId);
  await expect(page.locator("#presence")).toBeHidden();
  await expect(cursors(page)).toHaveCount(0);

  // 置く
  await placeItem(page, "objective", ENEMY_FOB, 6000, 6000);
  await expect(fob(page)).toHaveCount(1);

  // 動かす（ここが「変更通知のフックが例外を投げていないか」の試験でもある。
  // api.js の call() は WebSocket が無くても必ず成功を返さなければならない）。
  const p1 = await boardPoint(page, 6000, 6000);
  const p2 = await boardPoint(page, 9000, 9000);
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  await page.mouse.move(p2.x, p2.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#status")).toContainText("動かしました");
  expect(Math.abs((await translateOf(fob(page))).x - 9000)).toBeLessThan(60);

  // 描く
  await usePen(page);
  const q1 = await boardPoint(page, 3000, 3000);
  const q2 = await boardPoint(page, 5000, 5000);
  await page.mouse.move(q1.x, q1.y);
  await page.mouse.down();
  await page.mouse.move(q2.x, q2.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#status")).toContainText("保存しました");
  await expect(page.locator("#ink path")).toHaveCount(1);

  // 消す（取り消しで線 → 配置の順に戻る）
  await page.getByRole("button", { name: "取り消す" }).click();
  await expect(page.locator("#status")).toContainText("取り消しました");
  await expect(page.locator("#ink path")).toHaveCount(0);
  await page.getByRole("button", { name: "取り消す" }).click();
  await expect(page.locator("#status")).toContainText("取り消しました");
  await expect(fob(page)).toHaveCount(0);

  // 全部サーバに残っている（リロードして確かめる）
  await page.reload();
  await mapSizeM(page);
  await expect(fob(page)).toHaveCount(0);
  await expect(page.locator("#ink path")).toHaveCount(0);

  await ctx.close();
});

// ══ 受け入れ条件 5 ══════════════════════════════════════════════
// 同時接続の上限は 50（D-048 で 20 と決め、のちにオーナー判断で 50 へ）。
// ブラウザ2枚＋ヘッドレス48本で埋めてから、受け入れ条件 1 と 2 をもう一度通す。
//
// **ブラウザコンテキストを50本立てない**（D-067 / D-069）。48本は
// `tools/ws-min.mjs` で WebSocket だけ張る。48枚のページを開くと、
// テストが落ちるのは製品の問題ではなく Playwright の負荷になる。
//
// **動かす速さについて（実測。ここを上げる前に読むこと）。**
// ローカルは `wrangler pages dev` と `wrangler dev`（room）の2プロセス構成で、
// 全フレームがそのあいだのプロキシを通る（D-047 の決定3）。**ここが詰まる。**
// 18本 × 10Hz（180通/秒）で切り分けた結果:
//   * Node の送信側は 180通/秒 を維持できている（計測済み）
//   * DO も毎秒 106〜149 通を受けて処理できている（DO 側のログで計測済み）
//   * 詰まるのはプロキシ。本番にはこの経路が無い
// 54通/秒（18本 × 3Hz）までは毎秒きっかり配信されるのを確認した。
//
// なので**本数ではなく「毎秒の合計通数」を 50 前後に固定する。** 48本になった
// のでヘッドレス1本あたりは約 1Hz になる。本番のクライアントは在室50人なら
// 4Hz（＝200通/秒）で送るが、それはローカルのプロキシが運べない量で、
// **運べないことはローカルの性質であって製品の性質ではない。**
//
// **この試験は「50接続を張った状態」という条件のほうを守る。**
// 全員がノンストップでマウスを振り続ける状況は、受け入れ条件の文面にも
// 想定する使い方（VC で話しながら）にも無い。
const NOISE_TOTAL_PER_SEC = 50;

/** ヘッドレス接続の数。ブラウザ2枚と足して在室 50人（＝上限）になる。 */
const EXTRA_CONNECTIONS = 48;

// **この2本だけ既定の 60 秒では足りない。**
// 50人ぶんのログイン（HTTP）と WebSocket の確立を行うので、18本の頃でさえ
// 単体の計測で 6.6s〜22.5s とばらついた（サーバの温まり具合で3倍変わる）。
// 全体の timeout を伸ばすと他のテストの寝落ちを見逃すので、ここだけ伸ばす。
const MANY_CONNECTIONS_TIMEOUT_MS = 300_000;

/**
 * ヘッドレスの在室者をまとめて作る。
 *
 * **ログインは束ねて並べる。** 1本ずつ順に待つと 48本で HTTP の往復が
 * 48回直列に積み上がる。束の大きさを切ってあるのは、`wrangler pages dev` に
 * 48本同時に投げても嬉しくないため（実測して決めた値ではなく、素直な上限）。
 * WebSocket の確立は束ねない（部屋に入る順が入り混じると、満員の境目を
 * 見るテストで「何本目が断られたか」が読めなくなる）。
 */
async function fillRoom(planId, count, firstId, label) {
  const BATCH = 8;
  const cookies = [];
  for (let i = 0; i < count; i += BATCH) {
    const batch = [];
    for (let k = i; k < Math.min(i + BATCH, count); k += 1) {
      batch.push(loginHeadless(String(firstId + k), `${label}${k}`));
    }
    cookies.push(...(await Promise.all(batch)));
  }
  const conns = [];
  for (const cookie of cookies) conns.push(await joinRoom(cookie, planId));
  return conns;
}

/**
 * 「敵FOB が相手の画面に出るまで」を相手側の時計で測る。
 *
 * 棚を開いて項目を選ぶ手間（1秒近い）を混ぜないため、押した時刻は
 * `placeItem` が返すものを使う（それ以外だと「通知が1秒かかった」という
 * 嘘の数字が出る）。
 */
async function measureNotify(pageA, pageB, expectCount, at) {
  await pageB.evaluate((want) => {
    window.__fobAt = null;
    const layer = document.getElementById("placements");
    const check = () => {
      const n = layer.querySelectorAll('.pm[data-item-id="mk_enemy_fob"]').length;
      if (window.__fobAt === null && n >= want) window.__fobAt = Date.now();
    };
    new MutationObserver(check).observe(layer, { childList: true, subtree: true });
    check();
  }, expectCount);
  const clickedAt = await placeItem(pageA, "objective", ENEMY_FOB, at[0], at[1]);
  await expect(fob(pageB)).toHaveCount(expectCount);
  return (await pageB.evaluate(() => window.__fobAt)) - clickedAt;
}

test("50接続を張った状態でも、カーソルと変更通知が通る", async ({ browser }) => {
  test.setTimeout(MANY_CONNECTIONS_TIMEOUT_MS);
  const { a, b, pageA, pageB, planId } = await openTwo(
    browser, "満員テスト", ["9817", "満員A"], ["9818", "満員B"]
  );

  const filledAt = Date.now();
  const extras = await fillRoom(planId, EXTRA_CONNECTIONS, 10001, "満員");
  await expect(page2Names(pageA)).toHaveCount(50);
  await expect(page2Names(pageB)).toHaveCount(50);
  console.log(`受け入れ条件5(50人の在室が揃うまで): ${Date.now() - filledAt}ms`);

  // **送信頻度が段を1つ下りていること。** 在室50人なら 4Hz（250ms 間隔）で、
  // 見た目の補間も同じ長さになる（public/js/plan/cursors.js の
  // `CURSOR_RATE_TIERS`）。ここが 100ms のままなら、50人 × 10Hz = 500通/秒 で
  // DO の受信リクエスト枠を 45% 食う（20人のときの 18% から跳ねる）。
  for (const page of [pageA, pageB]) {
    await expect
      .poll(() => page.evaluate(
        () => getComputedStyle(document.documentElement).getPropertyValue("--cursor-tween").trim()
      ))
      .toBe("250ms");
  }

  // ══ 受け入れ条件2（50接続・全員が黙っている）══════════════════
  // **こちらが仕様の条件そのもの**（1秒以内）。VC で話している時間のほうが
  // 長いので、これが想定する使い方に一番近い。
  const quiet = await measureNotify(pageA, pageB, 1, [10000, 5000]);
  console.log(`受け入れ条件5(変更通知): 50接続・静止中で ${quiet}ms`);
  expect(quiet).toBeLessThan(1000);

  // 48本が動いている状態を作る（50人ぶんのカーソルが同じ部屋を流れている）。
  const noise = setInterval(() => {
    for (const [i, conn] of extras.entries()) {
      try {
        conn.send(JSON.stringify({
          t: "cur", x: 1000 + i * 100, y: 2000 + Math.round((Date.now() / 10) % 500),
        }));
      } catch { /* 閉じている */ }
    }
  }, Math.round(1000 / (NOISE_TOTAL_PER_SEC / extras.length)));

  try {
    // ══ 受け入れ条件1 ════════════════════════════════════════════
    const at = await boardPoint(pageA, 8000, 4000);
    const t0 = Date.now();
    await pageA.mouse.move(at.x, at.y);
    await expect(cursors(pageB).filter({ hasText: "満員A" })).toHaveCount(1);
    console.log(`受け入れ条件5(カーソル): 50接続下で ${Date.now() - t0}ms`);
    // ヘッドレス48本ぶんも描かれている（自分とBを除いて 49 本）。
    await expect(cursors(pageB)).toHaveCount(49);

    // **1通あたりの配信の大きさ。** 50人ぶんのスナップショットが1つの文字列で
    // 配られる（`buildCursors`）。名前と色を通に載せず在室一覧から引くのは
    // このためで、1人あたり 30バイト強に収まっている。
    // **配信の総バイトは人数の2乗で伸びる**（1通が N人ぶん × 配る先が N人）ので、
    // ここを太らせると人数の上限がそのまま重くなる。
    const snapshot = extras[0].messages.filter((m) => m.startsWith('{"t":"curs"')).at(-1);
    expect(snapshot).toBeTruthy();
    const seats = Object.keys(JSON.parse(snapshot).c).length;
    console.log(
      `受け入れ条件5(1通の大きさ): ${snapshot.length} バイト / ${seats}人 ` +
      `= ${Math.round(snapshot.length / seats)} バイト/人`
    );

    // ══ 受け入れ条件2（50接続・全員が動いている）══════════════════
    // **ここだけ 1秒では測れない。ローカルの作りのせい。** 全フレームが
    // `wrangler pages dev` ↔ `wrangler dev` のプロキシを通る（D-047 の決定3）
    // ので、配信の通数 × 在室数ぶんのフレームがそこに集中し、同じ経路を使う
    // HTTP（`GET /api/sessions/:id`）が後ろに並ぶ。
    // 実測: 20接続では 1秒以内、50接続では 3.2秒（通数は同じ 50通/秒）。
    // **伸びているのは接続数のほうで、製品の通数ではない。**
    // 本番にこの経路は無い。ここは「止まらないこと」だけを見る。
    const loaded = await measureNotify(pageA, pageB, 2, [11000, 6000]);
    console.log(`受け入れ条件5(変更通知): 50接続・全員が動いている状態で ${loaded}ms`);
    expect(loaded).toBeLessThan(10_000);
  } finally {
    clearInterval(noise);
    for (const conn of extras) conn.close();
  }

  await a.close();
  await b.close();
});

// 51人目は入れない（上限 50）。**カーソルを足しても上限の守り方が
// 変わっていない**ことを見る。
test("51人目は満員で断られる（カーソルを足しても上限は 50 のまま）", async ({ browser }) => {
  test.setTimeout(MANY_CONNECTIONS_TIMEOUT_MS);
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9819", "主");
  const planId = await createPlan(ctx, "満員の境目");

  const inside = await fillRoom(planId, 50, 10051, "席");

  // 51人目。満員の socket は印だけ付いて返り、最初の1通で閉じられる。
  const over = await joinRoom(await loginHeadless("10101", "あぶれ"), planId);
  await expect
    .poll(() => over.closed?.code, { timeout: 10_000 })
    .toBe(1013);

  // あぶれた人が送ったカーソルは、部屋の誰にも配られない。
  const probe = inside[0];
  const before = probe.messages.length;
  for (let i = 0; i < 5; i += 1) over.send(JSON.stringify({ t: "cur", x: 500, y: 500 }));
  inside[1].send(JSON.stringify({ t: "cur", x: 100, y: 100 }));
  await expect.poll(() => probe.messages.length, { timeout: 10_000 }).toBeGreaterThan(before);
  const last = probe.messages.filter((m) => m.includes('"curs"')).at(-1);
  expect(last).not.toContain("10101");

  for (const conn of inside) conn.close();
  await ctx.close();
});
