// 運んでいる最中を見せる（Phase R2a）の UIテスト。
//
// **仕様書の受け入れ条件をそのまま機械にする。**
// `docs/superpowers/specs/2026-10-02-r2-live-drag.md`
//
//   1. 片方でピンを掴んで動かすと、もう片方で**連続して**動いて見える
//   2. 落としたあと、両方の座標が一致する
//   3. マップ外で離して中断すると、もう片方で元の位置に戻る
//   4. **運んでいる最中にタブを閉じる**と、もう片方で3秒以内に元の位置へ戻る
//   5. 1.5秒ドラッグしたときの送信通数が、ただマウスを振ったときと同じ
//   6. 地名（callout）でも 1〜4 が成立する
//   7. WebSocket を塞いだ状態で、ドラッグが従来どおり動く
//
// **2枚のタブは同じアカウントで組む**（D-068 の教訓。別アカウント2人の e2e だけ
// 書いて「自分ひとりで2枚」を試験せず、オーナーの最初の一手で落ちた。
// オーナーはチームに見せる前に必ず自分ひとりで触る）。
//
// **1 は途中の座標を複数点サンプリングする。** 始点と終点だけ見ると、
// 瞬間移動（R1 の挙動）と区別がつかない。
//
// テスト用 Discord ID の帯: 9892–9900（e2e/config.js の採番表を参照）
import { expect, test } from "@playwright/test";

import { CURSOR_TTL_MS } from "../public/js/plan/cursors.js";

import {
  boardPoint, createPlan, loginViaApi, mapSizeM, planUrl, showWholeMap,
} from "./plan-helpers.js";

/** 敵FOB の記号。R1 でオーナーが「反映されない」と報告したのと同じ物で試す。 */
const ENEMY_FOB = "mk_enemy_fob";

const fob = (page) => page.locator(`#placements .pm[data-item-id="${ENEMY_FOB}"]`);
const callout = (page) => page.locator("#callouts .co");

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

/**
 * **同じアカウントで2枚**開いた状態を作る（D-068 の教訓）。
 *
 * 在室は「人」の数なので1人のまま（D-047 の設計どおり）。それでも
 * カーソルと運んでいるものは接続ごとなので、両方のタブに出る。
 */
async function openTwoTabs(browser, title, [id, name]) {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, id, name);
  const planId = await createPlan(ctx, title);

  const pageA = await ctx.newPage();
  await openPlan(pageA, planId);
  const pageB = await ctx.newPage();
  await openPlan(pageB, planId);

  // 在室が届いてから始める（運んでいる物の縁取りの色は在室一覧から引く）。
  await expect(pageA.locator("#presence .pres-chip")).toHaveCount(1);
  await expect(pageB.locator("#presence .pres-chip")).toHaveCount(1);
  // **動かすほうを前に出す。** 裏に回ったタブは送らない（board/cursor.js）。
  await pageA.bringToFront();
  return { ctx, pageA, pageB, planId };
}

/** パレットから項目を選んで置く（plan-placements.spec.js と同じ手順）。 */
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
  await page.mouse.click(p.x, p.y);
  await expect(markers).toHaveCount(before + 1);
  await expect(page.locator("#status")).toContainText("を置きました");
  // 置く道具から抜けて既定の「移動」に戻す（Esc。同じ項目をもう一度押すと
  // ペンに戻る実装なので、ドラッグが線になりかねない）。
  await page.keyboard.press("Escape");
  await expect(item).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "移動" })).toHaveAttribute("aria-pressed", "true");
}

/** 地名を1つ置く（plan-callouts.spec.js と同じ手順）。 */
async function placeCallout(page, x, y) {
  const btn = page.getByRole("button", { name: "地名を置く" });
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  const dots = callout(page);
  const before = await dots.count();
  const p = await boardPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
  await expect(dots).toHaveCount(before + 1);
  await expect(page.locator("#status")).toContainText("を置きました");
  // 置く道具から抜ける（ドラッグで動かすため）。
  await page.keyboard.press("Escape");
  await expect(btn).toHaveAttribute("aria-pressed", "false");
}

/**
 * もう片方のタブで、その要素の位置と「運ばれている印」を**変化するたび**記録する。
 *
 * **始点と終点だけでは瞬間移動と区別がつかない**（R1 でも落とした瞬間には動く）。
 * 途中の点が何個あって、1回の飛びがどれだけかを見るために全部拾う。
 */
async function trackMoves(page, selector) {
  await page.evaluate((sel) => {
    window.__track = [];
    const read = () => {
      const el = document.querySelector(sel);
      const m = el?.getAttribute("transform")?.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
      if (!m) return;
      const at = { x: Number(m[1]), y: Number(m[2]), carry: el.hasAttribute("data-carry") };
      const last = window.__track[window.__track.length - 1];
      if (last && last.x === at.x && last.y === at.y && last.carry === at.carry) return;
      window.__track.push(at);
    };
    new MutationObserver(read).observe(document.body, {
      subtree: true, attributes: true, attributeFilter: ["transform", "data-carry"],
    });
    read();
  }, selector);
}

const tracked = (page) => page.evaluate(() => window.__track);

/**
 * ゆっくり掴んで動かす。**離さない。**
 *
 * `steps` × `pause` が実際の所要時間になる。1ステップずつ本当に時間を置くのが
 * 肝で、`mouse.move(..., {steps})` は一瞬で撃ち終わるため 100ms スロットルに
 * 吸われて1〜2通しか飛ばない（＝「運んでいる最中」が再現されない）。
 */
async function grabAndDrag(page, from, to, { steps = 12, pause = 120 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await page.waitForTimeout(pause);
  }
}

/** 途中の点の「連続している度合い」を測る。 */
function continuity(track, total) {
  const moving = track.filter((s) => s.carry);
  let biggest = 0;
  for (let i = 1; i < moving.length; i += 1) {
    biggest = Math.max(biggest, Math.abs(moving[i].x - moving[i - 1].x));
  }
  return { points: moving.length, biggest, ratio: total > 0 ? biggest / total : 1 };
}

// ══ 受け入れ条件 1・2 ════════════════════════════════════════════
test("同じアカウントの2枚で、ピンを運んでいる最中が連続して出る", async ({ browser }) => {
  const { ctx, pageA, pageB } = await openTwoTabs(browser, "運ぶ1", ["9892", "はこぶ人"]);

  await placeItem(pageA, "objective", ENEMY_FOB, 5000, 5000);
  await expect(fob(pageB)).toHaveCount(1);
  const before = await translateOf(fob(pageB));
  expect(Math.abs(before.x - 5000)).toBeLessThan(60);

  await trackMoves(pageB, `#placements .pm[data-item-id="${ENEMY_FOB}"]`);

  const from = await boardPoint(pageA, 5000, 5000);
  const to = await boardPoint(pageA, 12000, 11000);
  await grabAndDrag(pageA, from, to);

  // **離す前に**中間の位置が届いていること。ここが R1 との差。
  await expect.poll(() => pageB.evaluate(() => window.__track.filter((s) => s.carry).length), {
    timeout: 5000,
  }).toBeGreaterThanOrEqual(5);
  const mid = continuity(await tracked(pageB), 12000 - 5000);
  console.log(
    `受け入れ条件1: 離す前に届いた途中の位置 ${mid.points}点 / `
    + `1回の最大の飛び ${Math.round(mid.biggest)}m（全体の ${Math.round(mid.ratio * 100)}%）`
  );
  // **瞬間移動ではないこと。** 1回の飛びが道のりの大半を占めていたら、
  // それは「途中が見えている」ではなく「落ちた瞬間に動いた」。
  expect(mid.points).toBeGreaterThanOrEqual(5);
  expect(mid.ratio).toBeLessThan(0.4);

  // 運んでいる人の色で縁取られている（「それ動かしてるの俺」が言わずに伝わる）。
  await expect(fob(pageB)).toHaveAttribute("data-carry", "1");
  const color = await fob(pageB).evaluate((el) => el.style.getPropertyValue("--carry"));
  expect(color).toMatch(/^var\(--cursor-[1-8]\)$/);

  // ── 受け入れ条件2: 落としたあと、両方の座標が一致する ──
  await pageA.mouse.up();
  await expect(pageA.locator("#status")).toContainText("動かしました");

  // 印が外れる（運ばれたままに見えない）。
  await expect(fob(pageB)).not.toHaveAttribute("data-carry", "1");
  const afterA = await translateOf(fob(pageA));
  await expect.poll(async () => Math.abs((await translateOf(fob(pageB))).x - afterA.x), {
    timeout: 5000,
  }).toBeLessThan(2);
  const afterB = await translateOf(fob(pageB));
  console.log(
    `受け入れ条件2: A(${Math.round(afterA.x)}, ${Math.round(afterA.y)}) / `
    + `B(${Math.round(afterB.x)}, ${Math.round(afterB.y)})`
  );
  expect(Math.abs(afterB.y - afterA.y)).toBeLessThan(2);
  expect(Math.abs(afterA.x - 12000)).toBeLessThan(80);

  // **跳ね返りが無いこと。** 離したあとに「元の位置へ戻ってから新しい位置へ飛ぶ」
  // が見えないこと（D1 が唯一の真実なので、戻すのを再取得の着地まで預けている）。
  const all = await tracked(pageB);
  const tail = all.slice(all.map((s) => s.carry).lastIndexOf(true) + 1);
  expect(
    tail.filter((s) => Math.abs(s.x - before.x) < 100),
    "離したあとに元の位置へ跳ね返っていない"
  ).toEqual([]);

  await ctx.close();
});

// ══ 受け入れ条件 3 ══════════════════════════════════════════════
test("マップの外で離して中断すると、もう片方で元の位置に戻る", async ({ browser }) => {
  const { ctx, pageA, pageB } = await openTwoTabs(browser, "運ぶ2", ["9893", "やめる人"]);

  await placeItem(pageA, "objective", ENEMY_FOB, 14000, 8000);
  await expect(fob(pageB)).toHaveCount(1);
  const before = await translateOf(fob(pageB));

  await trackMoves(pageB, `#placements .pm[data-item-id="${ENEMY_FOB}"]`);

  // 盤面の右のレターボックス（マップ外）へ落とす。
  const box = await pageA.locator("#board").boundingBox();
  const mapRight = await boardPoint(pageA, (await mapSizeM(pageA)).w, 8000);
  expect(box.x + box.width - mapRight.x, "盤面の右に余白があること").toBeGreaterThan(40);
  const from = await boardPoint(pageA, 14000, 8000);
  await grabAndDrag(
    pageA, from, { x: (mapRight.x + box.x + box.width) / 2, y: from.y }, { steps: 8 }
  );

  // 途中は相手にも届いている（動いていたものが戻ることを見たい）。
  await expect(fob(pageB)).toHaveAttribute("data-carry", "1");
  const movedTo = await translateOf(fob(pageB));
  expect(Math.abs(movedTo.x - before.x)).toBeGreaterThan(300);

  const releasedAt = Date.now();
  await pageA.mouse.up();
  await expect(pageA.locator("#status")).toContainText("マップの外です");

  // **元の位置に戻る**（途中の位置で residue が残らない）。
  // 保存していないので `chg` も飛ばない ＝ 取り直しは来ない ＝ その場で戻す。
  await expect.poll(async () => Math.abs((await translateOf(fob(pageB))).x - before.x), {
    timeout: 5000,
  }).toBeLessThan(2);
  console.log(`受け入れ条件3: 中断してから元の位置に戻るまで ${Date.now() - releasedAt}ms`);
  await expect(fob(pageB)).not.toHaveAttribute("data-carry", "1");
  expect(await translateOf(fob(pageA))).toEqual(before);

  await ctx.close();
});

// ══ 受け入れ条件 4 ══════════════════════════════════════════════
//
// **ここが一番壊しやすいところ。** 運んでいる最中に相手のタブが落ちると、
// 物が動かされた位置のまま残る。カーソルが残るのとは害が違って、
// **実際には動いていない盤面を全員が見ながら作戦を立てることになる。**
test("運んでいる最中にタブを閉じると、もう片方で元の位置に戻る", async ({ browser }) => {
  const { ctx, pageA, pageB } = await openTwoTabs(browser, "運ぶ3", ["9894", "おちる人"]);

  await placeItem(pageA, "objective", ENEMY_FOB, 5000, 5000);
  await expect(fob(pageB)).toHaveCount(1);
  const before = await translateOf(fob(pageB));

  const from = await boardPoint(pageA, 5000, 5000);
  const to = await boardPoint(pageA, 12000, 11000);
  await grabAndDrag(pageA, from, to, { steps: 8 });

  // 運ばれている最中であることを確かめてから落とす。
  await expect(fob(pageB)).toHaveAttribute("data-carry", "1");
  const movedTo = await translateOf(fob(pageB));
  expect(Math.abs(movedTo.x - before.x)).toBeGreaterThan(1000);

  // **掴んだまま**タブが消える（マウスは離していない）。
  const closedAt = Date.now();
  await pageA.close();
  await pageB.bringToFront();

  await expect.poll(async () => Math.abs((await translateOf(fob(pageB))).x - before.x), {
    timeout: CURSOR_TTL_MS + 2000,
  }).toBeLessThan(2);
  const back = Date.now() - closedAt;
  console.log(`受け入れ条件4: タブが落ちてから元の位置に戻るまで ${back}ms`);
  // 3秒 TTL が上限。ふつうは close が届くので即座に戻る。
  expect(back).toBeLessThan(CURSOR_TTL_MS + 1000);
  await expect(fob(pageB)).not.toHaveAttribute("data-carry", "1");

  // 保存されていない（D1 には受け取った座標を書かない）。リロードして確かめる。
  await pageB.reload();
  await mapSizeM(pageB);
  await showWholeMap(pageB);
  expect(await translateOf(fob(pageB)), "途中の座標が保存されていない").toEqual(before);

  await ctx.close();
});

// **close が1通も届かなかったとき**（回線が消えた・プロセスが落ちた）。
// 上のテストは `page.close()` なので DO に close フレームが届く。こちらは
// **3秒 TTL だけが頼りの経路**で、ここが効いていないと物が永久に残る。
test("切れたことが伝わらなくても、3秒の時限で元の位置に戻る", async ({ browser }) => {
  // setOffline はコンテキスト単位なので、ここだけは2つのコンテキストで組む
  // （同じアカウントの2枚は上の3本で見ている）。
  const a = await browser.newContext();
  const b = await browser.newContext();
  await loginViaApi(a, "9895", "きえる人");
  await loginViaApi(b, "9896", "のこる人");
  const planId = await createPlan(a, "運ぶ4");
  const pageA = await a.newPage();
  await openPlan(pageA, planId);
  const pageB = await b.newPage();
  await openPlan(pageB, planId);
  await expect(pageB.locator("#presence .pres-chip")).toHaveCount(2);

  await placeItem(pageA, "objective", ENEMY_FOB, 5000, 5000);
  await expect(fob(pageB)).toHaveCount(1);
  const before = await translateOf(fob(pageB));

  const from = await boardPoint(pageA, 5000, 5000);
  const to = await boardPoint(pageA, 12000, 11000);
  await grabAndDrag(pageA, from, to, { steps: 8 });
  await expect(fob(pageB)).toHaveAttribute("data-carry", "1");

  // **通信だけを消す。** タブは開いたまま、マウスも握ったまま。
  const cutAt = Date.now();
  await a.setOffline(true);
  // 時限は見る側のタイマー。裏に回ったタブは刻みが鈍るので前に出しておく。
  await pageB.bringToFront();

  await expect.poll(async () => Math.abs((await translateOf(fob(pageB))).x - before.x), {
    timeout: CURSOR_TTL_MS + 3000,
  }).toBeLessThan(2);
  console.log(`切断が伝わらない場合: 元の位置に戻るまで ${Date.now() - cutAt}ms`);
  await expect(fob(pageB)).not.toHaveAttribute("data-carry", "1");
  // カーソルも一緒に消えている（**同じ処理で消している**ことの確認）。
  await expect(pageB.locator("#cursor-layer .cursor")).toHaveCount(0);

  await a.close();
  await b.close();
});

// ══ 受け入れ条件 5 ══════════════════════════════════════════════
//
// **通数を1通も増やさないのが設計の肝。** ドラッグ中は既に `cur` が 10Hz で
// 飛んでいるので、そこに相乗りさせた（新しい種類の通を作っていない）。
// R1 の実測は 1.5秒の振り回しで 12〜13通 / 7.9〜8.5Hz。これと並べる。
test("1.5秒ドラッグしたときの送信通数が、ただ振ったときと変わらない", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9897", "かぞえる人");
  const planId = await createPlan(ctx, "運ぶ5");
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
  await openPlan(page, planId);
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

  await placeItem(page, "objective", ENEMY_FOB, 5000, 5000);

  const from = await boardPoint(page, 5000, 5000);
  const to = await boardPoint(page, 12000, 11000);

  /**
   * **まったく同じ動き**を、ボタンを押しているかどうかだけ変えて回す。
   *
   * 起点へ戻す1回も、止まったあとの1通も**数え始める前に出し切る**。
   * ここを揃えないと「ドラッグのほうが1通多い」という嘘の差が出る
   * （実測で踏んだ。起点へ戻す move がそのまま1通になっていた）。
   */
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

  // 先に「ただ振る」（ボタンを押さないので何も動かない）。
  const wave = await measure(false);
  const drag = await measure(true);

  // 動かしている時間だけで Hz を出す（末尾の1通を拾う待ちは分母に入れない）。
  const hz = (m) => (m.sent.length / (m.movedMs / 1000)).toFixed(1);
  // 手を止めたあとに出た通（= ジェスチャの末尾）。10Hz の流れと切り分けて数える。
  const tail = (m) => m.sent.filter((s) => s.at > m.endedAt).length;
  console.log(
    `受け入れ条件5: ただ振る ${wave.sent.length}通 / ${wave.movedMs}ms = ${hz(wave)}Hz`
    + `（うち末尾 ${tail(wave)}通）`
  );
  console.log(
    `受け入れ条件5: 運びながら ${drag.sent.length}通 / ${drag.movedMs}ms = ${hz(drag)}Hz`
    + `（うち末尾 ${tail(drag)}通 / 運んでいる印つき ${drag.sent.filter((s) => s.carry).length}通）`
  );

  // **末尾は1通ずつで揃っている。** ここが設計の肝で、10Hz の流れの揺れとは
  // 無関係に決まる（board/cursor.js の `pushSettled`）。2通になっていたら、
  // 「運ぶのをやめた」を伝える通が流れに上乗せされている。
  expect(tail(drag)).toBe(tail(wave));
  expect(tail(drag)).toBe(1);
  // **総数も増えていない。** 10Hz の流れそのものは同じ動きなので同数になるが、
  // 実時間で間引いている以上 1通ぶんは揺れる（CI の遅さで前後する）。
  expect(drag.sent.length).toBeLessThanOrEqual(wave.sent.length + 1);
  // R1 の実測（1.5秒で 12〜13通 / 7.9〜8.5Hz）と同じところに収まっている。
  expect(Number(hz(drag))).toBeLessThan(15);
  // 運んでいる印が本当に乗っていた（計測が空振りしていない）ことの念押し。
  expect(drag.sent.filter((s) => s.carry).length).toBeGreaterThanOrEqual(5);
  // ただ振ったときに印は1通も乗らない。
  expect(wave.sent.filter((s) => s.carry)).toEqual([]);

  // 切断されていない（毎秒30通の線に当たっていない）。
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

  await ctx.close();
});

// 仕様 §4「自分が触っている物は、相手の指示で動かさない」。
//
// **手元の操作が奪われるのが一番不快。** 2人が同じ物を掴んだときは、
// 画面上では手元が勝つ（確定はどちらにせよ保存した順）。
//
// 相手が掴みっぱなしなので、こちらが動かしている間も 10Hz で
// 「その物はここ」が届き続ける状況になる。そこで手元が負けると、
// **掴んだ物が自分のポインタから離れて相手の位置へ吸い付く。**
test("同じ物を2人が掴んだら、手元の操作が勝つ", async ({ browser }) => {
  const { ctx, pageA, pageB } = await openTwoTabs(browser, "運ぶ8", ["9900", "とりあう人"]);

  await placeItem(pageA, "objective", ENEMY_FOB, 5000, 5000);
  await expect(fob(pageB)).toHaveCount(1);

  // A が掴んで動かし、**離さない**。
  await grabAndDrag(
    pageA, await boardPoint(pageA, 5000, 5000), await boardPoint(pageA, 3000, 3000), { steps: 6 }
  );
  await expect(fob(pageB)).toHaveAttribute("data-carry", "1");

  // B も同じ物を掴んで、別の方へ動かす。
  await pageB.bringToFront();
  const at = await translateOf(fob(pageB));
  const grab = await boardPoint(pageB, at.x, at.y);
  await grabAndDrag(pageB, grab, await boardPoint(pageB, 13000, 12000), { steps: 8 });

  // **B のポインタに付いてきている**（A が送り続けている位置に吸い付かない）。
  const held = await translateOf(fob(pageB));
  console.log(`手元優先: B の手元 ${Math.round(held.x)}（A が送っている先は 3000 付近）`);
  expect(Math.abs(held.x - 13000)).toBeLessThan(200);

  await pageB.mouse.up();
  await expect(pageB.locator("#status")).toContainText("動かしました");
  expect(Math.abs((await translateOf(fob(pageB))).x - 13000)).toBeLessThan(80);

  await ctx.close();
});

// ══ 受け入れ条件 6 ══════════════════════════════════════════════
// 地名でも 1〜4 が成立する。**配置と同じ道を通っている**ことを見る
// （種別は通の中で1文字しか違わない）。
test("地名も運んでいる最中が出て、中断すれば戻り、落ちても戻る", async ({ browser }) => {
  const { ctx, pageA, pageB } = await openTwoTabs(browser, "運ぶ6", ["9898", "ちめいの人"]);

  await placeCallout(pageA, 5000, 5000);
  await expect(callout(pageB)).toHaveCount(1);
  const before = await translateOf(callout(pageB));
  expect(Math.abs(before.x - 5000)).toBeLessThan(60);

  await trackMoves(pageB, "#callouts .co");

  // ── 条件1: 途中が連続して届く ──
  const from = await boardPoint(pageA, 5000, 5000);
  const to = await boardPoint(pageA, 12000, 11000);
  await grabAndDrag(pageA, from, to);
  await expect.poll(() => pageB.evaluate(() => window.__track.filter((s) => s.carry).length), {
    timeout: 5000,
  }).toBeGreaterThanOrEqual(5);
  const mid = continuity(await tracked(pageB), 12000 - 5000);
  console.log(
    `受け入れ条件6(地名): 途中の位置 ${mid.points}点 / `
    + `最大の飛び ${Math.round(mid.biggest)}m（全体の ${Math.round(mid.ratio * 100)}%）`
  );
  expect(mid.ratio).toBeLessThan(0.4);
  await expect(callout(pageB)).toHaveAttribute("data-carry", "1");

  // ── 条件2: 落としたら一致する ──
  await pageA.mouse.up();
  await expect(pageA.locator("#status")).toContainText("地名を動かしました");
  const afterA = await translateOf(callout(pageA));
  await expect.poll(async () => Math.abs((await translateOf(callout(pageB))).x - afterA.x), {
    timeout: 5000,
  }).toBeLessThan(2);
  await expect(callout(pageB)).not.toHaveAttribute("data-carry", "1");

  // ── 条件3: マップの外で離すと戻る ──
  const box = await pageA.locator("#board").boundingBox();
  const mapRight = await boardPoint(pageA, (await mapSizeM(pageA)).w, 11000);
  const held = await boardPoint(pageA, afterA.x, afterA.y);
  await grabAndDrag(
    pageA, held, { x: (mapRight.x + box.x + box.width) / 2, y: held.y }, { steps: 8 }
  );
  await expect(callout(pageB)).toHaveAttribute("data-carry", "1");
  await pageA.mouse.up();
  await expect(pageA.locator("#status")).toContainText("マップの外です");
  await expect.poll(async () => Math.abs((await translateOf(callout(pageB))).x - afterA.x), {
    timeout: 5000,
  }).toBeLessThan(2);

  // ── 条件4: 運んでいる最中にタブが落ちると戻る ──
  await grabAndDrag(pageA, held, await boardPoint(pageA, 3000, 3000), { steps: 8 });
  await expect(callout(pageB)).toHaveAttribute("data-carry", "1");
  const closedAt = Date.now();
  await pageA.close();
  await pageB.bringToFront();
  await expect.poll(async () => Math.abs((await translateOf(callout(pageB))).x - afterA.x), {
    timeout: CURSOR_TTL_MS + 2000,
  }).toBeLessThan(2);
  console.log(`受け入れ条件6(地名): タブが落ちてから戻るまで ${Date.now() - closedAt}ms`);
  await expect(callout(pageB)).not.toHaveAttribute("data-carry", "1");

  // **中断した2回ぶんは保存されていない**（絵だけ動かしていた）。
  // サーバに残っているのは条件2で確定させた位置だけ。
  await pageB.reload();
  await mapSizeM(pageB);
  await showWholeMap(pageB);
  expect(Math.abs((await translateOf(callout(pageB))).x - afterA.x)).toBeLessThan(2);

  await ctx.close();
});

// ══ 受け入れ条件 7 ══════════════════════════════════════════════
// **リアルタイムは上乗せ。** 繋がらない環境でドラッグが従来どおり動くこと。
test("WebSocket を塞いでも、ドラッグは従来どおり動く", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9899", "ふさぐ人2");
  const planId = await createPlan(ctx, "運ぶ7");
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.WebSocket = function BlockedWebSocket() {
      throw new Error("WebSocket は使えません（テスト）");
    };
  });
  await openPlan(page, planId);
  await expect(page.locator("#presence")).toBeHidden();

  await placeItem(page, "objective", ENEMY_FOB, 5000, 5000);
  const from = await boardPoint(page, 5000, 5000);
  const to = await boardPoint(page, 11000, 9000);
  await grabAndDrag(page, from, to, { steps: 6, pause: 60 });
  await page.mouse.up();
  await expect(page.locator("#status")).toContainText("動かしました");
  expect(Math.abs((await translateOf(fob(page))).x - 11000)).toBeLessThan(80);

  // 地名も同じ（送り先が無いことで例外が漏れていないか）。
  await placeCallout(page, 3000, 3000);
  const cFrom = await boardPoint(page, 3000, 3000);
  const cTo = await boardPoint(page, 7000, 6000);
  await grabAndDrag(page, cFrom, cTo, { steps: 6, pause: 60 });
  await page.mouse.up();
  await expect(page.locator("#status")).toContainText("地名を動かしました");

  // 保存されている（リロードして確かめる）。
  await page.reload();
  await mapSizeM(page);
  await showWholeMap(page);
  expect(Math.abs((await translateOf(fob(page))).x - 11000)).toBeLessThan(80);
  expect(Math.abs((await translateOf(callout(page))).x - 7000)).toBeLessThan(80);

  await ctx.close();
});
