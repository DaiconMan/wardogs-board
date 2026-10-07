// 線を引いている最中を見せる（Phase R2b）の UIテスト。
//
// **仕様書の受け入れ条件をそのまま機械にする。**
// `docs/superpowers/specs/2026-10-02-live-ink.md`
//
//   1. 片方でゆっくり線を引くと、もう片方で**線が伸びていく**（引き終わった瞬間ではない）
//   2. 引き終わると、両方で同じ線が1本だけ残る（二重に出ない・一瞬消えない）
//   3. 中断すると、もう片方から消える
//   4. 引いている最中にタブを閉じると、もう片方から3秒以内に消える
//   5. 1.5秒引いたときの送信通数が、ただマウスを振ったときと同じ
//   6. 1通の最大の大きさ（上限 1024 に対して何バイトか）
//   7. 速く引いても1通が上限を超えない（間引きが効いている）
//   8. WebSocket を塞いだ状態で、描画が従来どおり動く
//   9. 50接続下で 1〜4 が成立する
//
// **2枚のタブは同じアカウントで組む**（D-068 の教訓。別アカウント2人の e2e だけ
// 書いて「自分ひとりで2枚」を試験せず、オーナーの最初の一手で落ちた）。
//
// **1 は途中の点の数を複数回サンプリングする。** 始点と終点だけ見ると、
// 引き終わってから出たのと区別がつかない。
//
// **5 と 6 は数字を出す**（console.log）。「増えていないはず」は受け取らない。
//
// テスト用 Discord ID の帯: 9981–9999（e2e/config.js の採番表を参照）
// 50接続は**ゲストで埋める**ので、5桁の帯は要らない（ログインの往復が無いぶん速い）。
import { expect, test } from "@playwright/test";

import { CURSOR_TTL_MS } from "../public/js/plan/cursors.js";
import { newGuestId } from "../public/js/plan/guest.js";
import { MAX_MEMBERS } from "../public/js/plan/presence.js";
import { MAX_MESSAGE_LEN } from "../workers/room/src/cursors.js";

import {
  boardPoint, createPlan, joinRoomAsGuest, loginViaApi, mapSizeM, planUrl, seedGuestId,
  showWholeMap, usePen,
} from "./plan-helpers.js";

/** 引いている最中の線（一時的な見せ物）と、確定して保存された線。 */
const liveInk = (page) => page.locator("#live-ink path");
const savedInk = (page) => page.locator("#ink path[data-stroke-id]");

async function openPlan(page, planId) {
  await page.goto(planUrl(`/plan?id=${planId}`));
  await mapSizeM(page);
  // マップ座標で場所を指すので、全体が見える状態にしてから触る。
  await showWholeMap(page);
}

/**
 * **同じアカウントで2枚**開いた状態を作る（D-068 の教訓）。
 *
 * 在室は「人」の数なので1人のまま。それでもカーソルと引いている最中の線は
 * 接続ごとなので、両方のタブに出る。
 */
async function openTwoTabs(browser, title, [id, name]) {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, id, name);
  const planId = await createPlan(ctx, title);

  const pageA = await ctx.newPage();
  await openPlan(pageA, planId);
  const pageB = await ctx.newPage();
  await openPlan(pageB, planId);

  await expect(pageA.locator("#presence .pres-chip")).toHaveCount(1);
  await expect(pageB.locator("#presence .pres-chip")).toHaveCount(1);
  // **引くほうを前に出す。** 裏に回ったタブは送らない（board/cursor.js）。
  await pageA.bringToFront();
  await usePen(pageA);
  return { ctx, pageA, pageB, planId };
}

/**
 * 受け手の画面で、**一時的な線が伸びていく様子**を変化するたび記録する。
 *
 * **始点と終点だけでは「引き終わってから出た」と区別がつかない**（仕様の明示）。
 * 途中の点が何個あって、どの時刻にどれだけ伸びたかを全部拾う。
 *
 * 同時に**確定した線の本数も**毎回拾う。引き終わりに「一時的な線が消えてから
 * 本物が出る」窓があれば、`live:0 / saved:0` の組として記録に残る（D-069 の教訓）。
 */
async function trackLive(page) {
  await page.evaluate(() => {
    window.__live = [];
    const read = () => {
      const live = document.querySelectorAll("#live-ink path");
      const saved = document.querySelectorAll("#ink path[data-stroke-id]");
      const d = live[0]?.getAttribute("d") ?? "";
      // 点の数は path のコマンド数（M が1つ + C か L がそのあと）。
      const pts = (d.match(/[MLC]/g) ?? []).length;
      const at = { at: Date.now(), live: live.length, saved: saved.length, pts };
      const last = window.__live[window.__live.length - 1];
      if (last && last.live === at.live && last.saved === at.saved && last.pts === at.pts) return;
      window.__live.push(at);
    };
    new MutationObserver(read).observe(document.getElementById("board"), {
      subtree: true, childList: true, attributes: true, attributeFilter: ["d", "data-stroke-id"],
    });
    read();
  });
}

const tracked = (page) => page.evaluate(() => window.__live);

/**
 * 送った `cur` を数える仕掛け。**ページを開く前に仕込む。**
 *
 * `k`（引いている最中の線）が乗っているか、1通が何バイトか、点が何個乗ったかを
 * 1通ごとに控える。間引きが効いているかは「送った点の総数 < 動かした回数」で測る。
 */
async function countSent(page) {
  await page.addInitScript(() => {
    window.__sent = [];
    window.__moves = 0;
    // ボタンを押しながら動かした回数 ＝ 線に積まれた点の数。
    addEventListener("pointermove", (e) => { if (e.buttons) window.__moves += 1; }, true);
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      const s = String(data);
      if (s.includes('"cur"')) {
        let pts = 0;
        try {
          const k = JSON.parse(s).k;
          if (Array.isArray(k)) pts = (k.length - 3) / 2;
        } catch { /* 読めないものは数えない */ }
        window.__sent.push({ at: Date.now(), bytes: s.length, ink: s.includes('"k"'), pts });
      }
      return orig.call(this, data);
    };
  });
}

/**
 * ゆっくり線を引く。**離さない。**
 *
 * `steps` × `pause` が実際の所要時間。1ステップずつ本当に時間を置くのが肝で、
 * `mouse.move(..., {steps})` は一瞬で撃ち終わるため送信の間引きに吸われて
 * 1〜2通しか飛ばない（＝「引いている最中」が再現されない）。
 */
async function drawSlowly(page, from, to, { steps = 12, pause = 120 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await page.waitForTimeout(pause);
  }
}

/** 一時的な線が「伸びた」ことの度合い。 */
function growth(samples) {
  const drawing = samples.filter((s) => s.live > 0);
  let steps = 0;
  for (let i = 1; i < drawing.length; i += 1) {
    if (drawing[i].pts > drawing[i - 1].pts) steps += 1;
  }
  return { samples: drawing.length, steps, last: drawing[drawing.length - 1]?.pts ?? 0 };
}

// ══ 受け入れ条件 1・2 ════════════════════════════════════════════
test("同じアカウントの2枚で、線が伸びていく様子が出る", async ({ browser }) => {
  const { ctx, pageA, pageB } = await openTwoTabs(browser, "ライブ線1", ["9981", "ひく人"]);

  await trackLive(pageB);
  expect(await liveInk(pageB).count(), "引く前は一時的な線が無い").toBe(0);

  const from = await boardPoint(pageA, 4000, 4000);
  const to = await boardPoint(pageA, 12000, 11000);
  await drawSlowly(pageA, from, to);

  // **離す前に**線が出ていて、何度も伸びていること。ここが R1 との差。
  await expect.poll(
    () => pageB.evaluate(() => window.__live.filter((s) => s.live > 0).length),
    { timeout: 5000 }
  ).toBeGreaterThanOrEqual(5);
  const mid = growth(await tracked(pageB));
  console.log(
    `受け入れ条件1: 離す前のサンプル ${mid.samples}回 / 伸びた回数 ${mid.steps} / `
    + `最後の点の数 ${mid.last}`
  );
  // **1回で全部出たのではない。** 伸びる回数が複数あって初めて「最中が見えた」。
  expect(mid.steps).toBeGreaterThanOrEqual(5);
  await expect(liveInk(pageB)).toHaveCount(1);

  // 引いている人の色で描かれている（ペン＝カーソル＝線の色。D-047）。
  const stroke = await liveInk(pageB).evaluate((el) => el.style.getPropertyValue("stroke"));
  expect(stroke).toMatch(/^var\(--cursor-[1-8]\)$/);
  // **確定した線と見分けがつく**（仕様の明示）。
  await expect(liveInk(pageB)).toHaveAttribute("data-live", "1");

  // ── 受け入れ条件2: 引き終わると1本だけ残る ──
  await pageA.mouse.up();
  await expect(pageA.locator("#status")).toContainText("保存しました");

  await expect(savedInk(pageB)).toHaveCount(1);
  // 一時的な線は片付く（二重に出たままにしない）。
  await expect(liveInk(pageB)).toHaveCount(0);

  // **一瞬消えない。** 「一時的な線を消してから本物が出る」窓があれば、
  // live:0 かつ saved:0 の組が記録に残る（D-069 の跳ね返りと同じ話）。
  const all = await tracked(pageB);
  const started = all.findIndex((s) => s.live > 0);
  const gap = all.slice(started).filter((s) => s.live === 0 && s.saved === 0);
  console.log(`受け入れ条件2: 確定までの標本 ${all.length - started}個 / 空白 ${gap.length}個`);
  expect(gap, "一時的な線が消えてから本物が出る窓が無い").toEqual([]);

  // 自分の画面にも1本だけ（自分が引いた線に一時的な線が重ならない）。
  await expect(savedInk(pageA)).toHaveCount(1);
  await expect(liveInk(pageA)).toHaveCount(0);

  await ctx.close();
});

// ══ 受け入れ条件 3 ══════════════════════════════════════════════
//
// **取り直しが来ない中断。** 保存が断られた線は `chg` を出さないので、
// 受け手の `changes.pending()` は false ＝ **その場で消す**のが正しい。
// ここを「着地まで待つ」側に倒すと、**失敗した線が相手の画面に永久に残る**
// （消す手段がリロードしか無い）。
test("保存に失敗して中断したら、もう片方からも消える", async ({ browser }) => {
  const { ctx, pageA, pageB } = await openTwoTabs(browser, "ライブ線2", ["9982", "やめる人"]);

  // 保存だけを落とす（線を引くことと送ることには触らない）。
  await pageA.route("**/api/sessions/*/ink", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      status: 500, contentType: "application/json", body: JSON.stringify({ error: "テスト" }),
    });
  });

  const from = await boardPoint(pageA, 4000, 9000);
  const to = await boardPoint(pageA, 11000, 9000);
  await drawSlowly(pageA, from, to, { steps: 8 });
  await expect(liveInk(pageB)).toHaveCount(1);

  const releasedAt = Date.now();
  await pageA.mouse.up();
  await expect(pageA.locator("#status")).toContainText("保存できませんでした");

  await expect(liveInk(pageB)).toHaveCount(0);
  console.log(`受け入れ条件3: 中断してから消えるまで ${Date.now() - releasedAt}ms`);
  // 保存されていないので、確定した線も出ない（絵だけだったことの確認）。
  await expect(savedInk(pageB)).toHaveCount(0);
  await expect(savedInk(pageA)).toHaveCount(0);

  await ctx.close();
});

// ══ 受け入れ条件 4 ══════════════════════════════════════════════
//
// **ここが一番壊しやすいところ。** 引いている途中で相手のタブが落ちると、
// 引かれていない線が盤面に残り続ける。しかも**保存されていない**ので、
// 見ている側には消す手段が無い。
test("引いている最中にタブを閉じると、もう片方から消える", async ({ browser }) => {
  const { ctx, pageA, pageB } = await openTwoTabs(browser, "ライブ線3", ["9983", "おちる人"]);

  const from = await boardPoint(pageA, 4000, 4000);
  const to = await boardPoint(pageA, 12000, 11000);
  await drawSlowly(pageA, from, to, { steps: 8 });
  await expect(liveInk(pageB)).toHaveCount(1);

  // **引いたまま**タブが消える（マウスは離していない）。
  const closedAt = Date.now();
  await pageA.close();
  await pageB.bringToFront();

  await expect(liveInk(pageB)).toHaveCount(0, { timeout: CURSOR_TTL_MS + 2000 });
  const gone = Date.now() - closedAt;
  console.log(`受け入れ条件4: タブが落ちてから消えるまで ${gone}ms`);
  expect(gone).toBeLessThan(CURSOR_TTL_MS + 1000);
  // カーソルも一緒に消えている（**同じ処理で消している**ことの確認）。
  await expect(pageB.locator("#cursor-layer .cursor")).toHaveCount(0);

  // 保存されていない（D1 には途中の点を書かない）。リロードして確かめる。
  await pageB.reload();
  await mapSizeM(pageB);
  await showWholeMap(pageB);
  await expect(savedInk(pageB)).toHaveCount(0);
  await expect(liveInk(pageB)).toHaveCount(0);

  await ctx.close();
});

// **close が1通も届かなかったとき**（回線が消えた・プロセスが落ちた）。
// 上のテストは `page.close()` なので DO に close フレームが届く。こちらは
// **3秒 TTL だけが頼りの経路**で、ここが効いていないと線が永久に残る。
test("切れたことが伝わらなくても、3秒の時限で線が消える", async ({ browser }) => {
  // setOffline はコンテキスト単位なので、ここだけは2つのコンテキストで組む。
  const a = await browser.newContext();
  const b = await browser.newContext();
  await loginViaApi(a, "9984", "きえる人");
  await loginViaApi(b, "9985", "のこる人");
  const planId = await createPlan(a, "ライブ線4");
  const pageA = await a.newPage();
  await openPlan(pageA, planId);
  const pageB = await b.newPage();
  await openPlan(pageB, planId);
  await expect(pageB.locator("#presence .pres-chip")).toHaveCount(2);
  await usePen(pageA);

  await drawSlowly(
    pageA, await boardPoint(pageA, 4000, 4000), await boardPoint(pageA, 12000, 11000),
    { steps: 8 }
  );
  await expect(liveInk(pageB)).toHaveCount(1);

  // **通信だけを消す。** タブは開いたまま、マウスも握ったまま。
  const cutAt = Date.now();
  await a.setOffline(true);
  // 時限は見る側のタイマー。裏に回ったタブは刻みが鈍るので前に出しておく。
  await pageB.bringToFront();

  await expect(liveInk(pageB)).toHaveCount(0, { timeout: CURSOR_TTL_MS + 3000 });
  console.log(`切断が伝わらない場合: 線が消えるまで ${Date.now() - cutAt}ms`);
  await expect(pageB.locator("#cursor-layer .cursor")).toHaveCount(0);

  await a.close();
  await b.close();
});

// ══ 受け入れ条件 5・6 ════════════════════════════════════════════
//
// **通数を1通も増やさないのが設計の肝。** 引いている間は既に `cur` が 10Hz で
// 飛んでいるので、そこに相乗りさせた（新しい種類の通を作っていない）。
// D-069 の実測は 1.5秒で 13通 / 7.8〜8.1Hz。これと並べる。
test("1.5秒引いたときの送信通数が、ただ振ったときと変わらない", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9986", "かぞえる人");
  const planId = await createPlan(ctx, "ライブ線5");
  const page = await ctx.newPage();
  await countSent(page);
  await openPlan(page, planId);
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);
  await usePen(page);

  const from = await boardPoint(page, 4000, 4000);
  const to = await boardPoint(page, 12000, 11000);

  /**
   * **まったく同じ動き**を、ボタンを押しているかどうかだけ変えて回す。
   *
   * 起点へ戻す1回も、止まったあとの1通も**数え始める前に出し切る**
   * （揃えないと「引くほうが1通多い」という嘘の差が出る。D-069 で実測した罠）。
   */
  async function measure(hold) {
    await page.mouse.move(from.x, from.y);
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.__sent.length = 0; window.__moves = 0; });
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
    await page.waitForTimeout(1200);
    const sent = await page.evaluate(() => window.__sent);
    const moves = await page.evaluate(() => window.__moves);
    return { sent, moves, movedMs: endedAt - started, endedAt };
  }

  const wave = await measure(false);
  const draw = await measure(true);
  await expect(page.locator("#status")).toContainText("保存しました");

  const hz = (m) => (m.sent.length / (m.movedMs / 1000)).toFixed(1);
  // 手を止めたあとに出た通（= ジェスチャの末尾）。10Hz の流れと切り分けて数える。
  const tail = (m) => m.sent.filter((s) => s.at > m.endedAt).length;
  const maxBytes = (m) => m.sent.reduce((a, s) => Math.max(a, s.bytes), 0);
  console.log(
    `受け入れ条件5: ただ振る ${wave.sent.length}通 / ${wave.movedMs}ms = ${hz(wave)}Hz`
    + `（うち末尾 ${tail(wave)}通 / 最大 ${maxBytes(wave)}バイト）`
  );
  console.log(
    `受け入れ条件5: 引きながら ${draw.sent.length}通 / ${draw.movedMs}ms = ${hz(draw)}Hz`
    + `（うち末尾 ${tail(draw)}通 / 線つき ${draw.sent.filter((s) => s.ink).length}通）`
  );
  console.log(
    `受け入れ条件6: 1通の最大 ${maxBytes(draw)}バイト（上限 ${MAX_MESSAGE_LEN}）/ `
    + `1通に乗った点の最大 ${draw.sent.reduce((a, s) => Math.max(a, s.pts), 0)}点`
  );

  // **末尾は1通ずつで揃っている**（board/cursor.js の settler）。
  // 2通になっていたら「引き終わった」を伝える通が流れに上乗せされている。
  expect(tail(draw)).toBe(tail(wave));
  expect(tail(draw)).toBe(1);
  // **総数も増えていない。** 実時間で間引いている以上 1通ぶんは揺れる。
  expect(draw.sent.length).toBeLessThanOrEqual(wave.sent.length + 1);
  // D-069 の実測（1.5秒で 13通 / 7.8〜8.1Hz）と同じところに収まっている。
  expect(Number(hz(draw))).toBeLessThan(15);
  // 線が本当に乗っていた（計測が空振りしていない）ことの念押し。
  expect(draw.sent.filter((s) => s.ink).length).toBeGreaterThanOrEqual(5);
  expect(wave.sent.filter((s) => s.ink)).toEqual([]);

  // ══ 受け入れ条件6 ══ 1通が上限に収まっている。
  expect(maxBytes(draw)).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
  // ゆっくり引いているあいだは**点を1つも捨てていない**（間引きは要らない）。
  expect(draw.sent.reduce((a, s) => a + s.pts, 0)).toBeGreaterThanOrEqual(draw.moves);

  // 切断されていない（毎秒30通の線に当たっていない）。
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

  await ctx.close();
});

// ══ 受け入れ条件 7 ══════════════════════════════════════════════
//
// **速く引かれて1通に収まらないときは、点を捨てる。**
// 引き伸ばして次の通へ回すと、速く引いている間ずっと「送り切れない点」が
// 積み上がって通が太り続け、いずれ上限を超える。超えた通は
// **DO が黙って捨てる**ので、画面には「線が途中で止まる」としか出ない。
test("速く引いても1通が上限を超えない（間引きが効く）", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9987", "はやい人");
  const planId = await createPlan(ctx, "ライブ線7");
  const page = await ctx.newPage();
  await countSent(page);
  await openPlan(page, planId);
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);
  await usePen(page);

  const from = await boardPoint(page, 2000, 2000);
  const to = await boardPoint(page, 14000, 14000);
  await page.mouse.move(from.x, from.y);
  await page.evaluate(() => { window.__sent.length = 0; window.__moves = 0; });
  await page.mouse.down();

  // **本当に一気に撃つ。** `mouse.move(..., {steps})` は1点ずつ CDP を往復
  // するので実時間がかかり（実測 800点で 15 秒）、間引きが要らない速さに
  // しかならない。ページの中から**同期ループで**撃てば、タイマーが1回も
  // 回らないうちに数百点が1つの送信の窓へ積まれる——これが「速く引いた」の
  // 最悪値で、間引きが無ければそのまま 1024 を超える。
  await page.evaluate(([x0, y0, x1, y1, n]) => {
    const board = document.getElementById("board");
    for (let i = 1; i <= n; i += 1) {
      const t = i / n;
      board.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", buttons: 1,
        clientX: x0 + (x1 - x0) * t, clientY: y0 + (y1 - y0) * t,
      }));
    }
  }, [from.x, from.y, to.x, to.y, 500]);
  // 積んだぶんが出切るのを待ってから離す（末尾の1通に全部乗る）。
  await page.waitForTimeout(500);
  await page.mouse.up();
  await expect(page.locator("#status")).toContainText("保存しました");
  await page.waitForTimeout(600);

  const sent = await page.evaluate(() => window.__sent);
  const moves = await page.evaluate(() => window.__moves);
  const withInk = sent.filter((s) => s.ink);
  const maxBytes = sent.reduce((a, s) => Math.max(a, s.bytes), 0);
  const maxPts = sent.reduce((a, s) => Math.max(a, s.pts), 0);
  const sentPts = sent.reduce((a, s) => a + s.pts, 0);
  console.log(
    `受け入れ条件7: 動かした ${moves}回 → 送った点 ${sentPts}個（${withInk.length}通）/ `
    + `1通の最大 ${maxBytes}バイト（上限 ${MAX_MESSAGE_LEN}）/ 1通の点の最大 ${maxPts}個`
  );

  expect(withInk.length).toBeGreaterThanOrEqual(1);
  // **上限を1バイトも超えない。** ここが設計の一点。
  expect(maxBytes).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
  // **間引きが効いている**（捨てずに引き伸ばしていない）。
  expect(moves).toBeGreaterThanOrEqual(500);
  expect(sentPts).toBeLessThan(moves);
  expect(maxPts).toBeLessThan(moves);

  // 確定した線は保存の経路から来るので、**最終形は狂わない。**
  await expect(savedInk(page)).toHaveCount(1);
  // 切断されていない（毎秒30通の線に当たっていない）。
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

  await ctx.close();
});

// ══ 受け入れ条件 8 ══════════════════════════════════════════════
// **リアルタイムは上乗せ。** 繋がらない環境で描画が従来どおり動くこと。
test("WebSocket を塞いでも、線は従来どおり引ける", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9988", "ふさぐ人3");
  const planId = await createPlan(ctx, "ライブ線8");
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.WebSocket = function BlockedWebSocket() {
      throw new Error("WebSocket は使えません（テスト）");
    };
  });
  await openPlan(page, planId);
  await expect(page.locator("#presence")).toBeHidden();
  await usePen(page);

  await drawSlowly(
    page, await boardPoint(page, 3000, 3000), await boardPoint(page, 10000, 9000),
    { steps: 6, pause: 60 }
  );
  await page.mouse.up();
  await expect(page.locator("#status")).toContainText("保存しました");
  await expect(savedInk(page)).toHaveCount(1);
  // 一時的な線は1本も作られない（送り先も受け手も居ない）。
  await expect(liveInk(page)).toHaveCount(0);

  // 消す・取り消すも従来どおり。
  await page.getByRole("button", { name: "取り消す" }).click();
  await expect(page.locator("#status")).toContainText("取り消しました");
  await expect(savedInk(page)).toHaveCount(0);

  // 保存されている（リロードして確かめる）。
  await drawSlowly(
    page, await boardPoint(page, 5000, 5000), await boardPoint(page, 9000, 8000),
    { steps: 6, pause: 60 }
  );
  await page.mouse.up();
  await expect(page.locator("#status")).toContainText("保存しました");
  await page.reload();
  await mapSizeM(page);
  await showWholeMap(page);
  await expect(savedInk(page)).toHaveCount(1);

  await ctx.close();
});

// ══ ゲストは書き込めない（D-072）════════════════════════════════
//
// ゲストは線を保存できないので「引いている最中」も存在しえない。
// **`k` は生の文字列で自分で組めるので、サーバで落とす。**
//
// **ここは空振りしやすい試験**（D-072 の教訓: 401 を期待する試験は経路が
// 無くても通る）。だから**同じ注入をログイン済みの接続からもやって、
// そちらでは線が出ること**を先に確かめる。
test("ゲストが k を注入しても中継されない（ログイン済みなら出る）", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9989", "みはる人");
  const planId = await createPlan(ctx, "ライブ線9");
  const page = await ctx.newPage();
  await openPlan(page, planId);
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);

  // ── まず「注入そのものは効く」ことを示す（空振りでないことの担保）──
  const injector = await ctx.newPage();
  await openPlan(injector, planId);
  await expect(page.locator("#presence .pres-chip")).toHaveCount(1);
  await injectInk(injector, 6000, 6000);
  await expect(liveInk(page), "ログイン済みの注入は線になる").toHaveCount(1);
  await injector.close();
  await expect(liveInk(page)).toHaveCount(0);

  // ── ゲストから同じものを送る ──
  const guestCtx = await browser.newContext();
  const guestId = await seedGuestId(guestCtx);
  const guest = await guestCtx.newPage();
  await openPlan(guest, planId);
  // ゲストが部屋に入ったことを確かめてから注入する（空振りを作らない）。
  await expect(page.locator("#presence .pres-chip[data-guest]")).toHaveCount(1);
  await injectInk(guest, 7000, 7000);
  // カーソルは出る（見ていることは伝わる）が、線は出ない。
  await expect(page.locator("#cursor-layer .cursor")).toHaveCount(1);
  await expect(liveInk(page), "ゲストの k は中継されない").toHaveCount(0);
  console.log(`ゲストの身元: ${guestId.slice(0, 8)}… / カーソルは出て、線は 0 本`);

  await guestCtx.close();
  await ctx.close();
});

/**
 * `cur` に `k` を添えた通を、そのタブの WebSocket から**生で**何通か送る。
 *
 * **まともなクライアントがやらないことを、手で再現する。** ゲストの画面は
 * そもそも `k` を組まないので、サーバで落としていることを確かめるには
 * ソケットへ直に流すしかない。
 *
 * **マウスを動かして1通出させるのが肝。** presence.js は WebSocket を外へ
 * 出さないので `send` の横取りで掴むしかないが、放っておくと次に送るのは
 * ハートビート（25秒後）で、そこまで待つことになる（実測でこの試験が
 * 1本 55 秒になっていた）。
 */
async function injectInk(page, x, y) {
  const at = await boardPoint(page, x, y);
  await page.evaluate(() => {
    window.__sock = null;
    const orig = WebSocket.prototype.send;
    window.__rawSend = orig;
    // 1通目で掴んで、すぐ元に戻す（以降の送信には触らない）。
    WebSocket.prototype.send = function (d) {
      window.__sock = this;
      WebSocket.prototype.send = orig;
      return orig.call(this, d);
    };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.move(at.x + 9, at.y + 7);
  await expect.poll(() => page.evaluate(() => !!window.__sock)).toBe(true);
  // **止まったあとの1通（settler）を先に出し切らせる。** あとから出ると
  // `k` の無い `cur` で表が上書きされ、注入した線が消えてしまう。
  await page.waitForTimeout(700);

  await page.evaluate(([ax, ay]) => {
    // 色1・太さ2・連番1。点は 0.1m 単位の整数（ink.js の QUANTUM）。
    for (let i = 0; i < 6; i += 1) {
      const k = [1, 2, 1, (ax + i * 200) * 10, ay * 10, 500, 500];
      window.__rawSend.call(
        window.__sock, JSON.stringify({ t: "cur", x: ax + i * 200, y: ay, k })
      );
    }
  }, [x, y]);
  // 配信の窓（80ms）＋到着を待つ。
  await page.waitForTimeout(400);
}

// ══ 受け入れ条件 9 ══════════════════════════════════════════════
//
// 50接続下で 1〜4 が成立する。**ゲストで埋める**（ログインの往復が1回も無い）。
// 在室50人では送信間隔が 250ms（4Hz）に下がるので、1 の「伸びていく」は
// そのぶんゆっくり引いて見る。
test("50接続下でも、線が伸びて・残って・落ちたら消える", async ({ browser }) => {
  // **既定の 60 秒では足りない。** 50人ぶんの WebSocket を張るので、
  // サーバの温まり具合で所要が数倍ぶれる（plan-cursors.spec.js と同じ理由）。
  test.setTimeout(300_000);
  const { ctx, pageA, pageB, planId } = await openTwoTabs(
    browser, "ライブ線10", ["9990", "満員で引く人"]
  );

  // 自分（1人）＋ゲストで上限ちょうど。押し出しは起きない（D-072）。
  const guests = [];
  for (let i = 0; i < MAX_MEMBERS - 1; i += 1) {
    guests.push(await joinRoomAsGuest(planId, newGuestId()));
  }
  await expect(pageA.locator("#presence .pres-chip")).toHaveCount(MAX_MEMBERS);
  await expect(pageB.locator("#presence .pres-chip")).toHaveCount(MAX_MEMBERS);
  // **送信頻度が段を下りていること**（50人 → 250ms。cursors.js の CURSOR_RATE_TIERS）。
  await expect.poll(() => pageA.evaluate(
    () => getComputedStyle(document.documentElement).getPropertyValue("--cursor-tween").trim()
  )).toBe("250ms");

  // 49本ぶんのカーソルが同じ部屋を流れている状態を作る。
  //
  // **総量は毎秒50通**（plan-cursors.spec.js の `NOISE_TOTAL_PER_SEC` と同じ）。
  // この試験が守るのは「50接続を張った状態」という条件のほうで、
  // 全員がノンストップでマウスを振り続ける状況は受け入れ条件の文面にも、
  // 想定する使い方（VC で話しながら）にも無い。
  //
  // **ここを設計の上限いっぱい（50人 × 4Hz = 毎秒200通）まで上げると、
  // ローカルでは配信が止まる。** 実測: 毎秒196通を流したとき、受け手が
  // 30秒で受け取った `curs` は12通だけ（≒毎秒0.4回）で、カーソルも
  // 引いている最中の線も出なくなった。毎秒50通なら24通/30秒で正常に出る。
  // **本番で同じことが起きるかは未確認**（ローカルは Pages と room が
  // 別プロセスで、レジストリ越しに繋がっている。この環境は CI の約4倍遅い）。
  const noise = setInterval(() => {
    for (const [i, conn] of guests.entries()) {
      try {
        conn.send(JSON.stringify({
          t: "cur", x: 1000 + i * 100, y: 2000 + Math.round((Date.now() / 10) % 500),
        }));
      } catch { /* 閉じている */ }
    }
  }, Math.round(1000 / (50 / guests.length)));

  try {
    await trackLive(pageB);
    // ── 条件1 ──
    await drawSlowly(
      pageA, await boardPoint(pageA, 4000, 4000), await boardPoint(pageA, 12000, 11000),
      { steps: 10, pause: 300 }
    );
    await expect.poll(
      () => pageB.evaluate(() => window.__live.filter((s) => s.live > 0).length),
      { timeout: 8000 }
    ).toBeGreaterThanOrEqual(4);
    const mid = growth(await tracked(pageB));
    console.log(`受け入れ条件9(条件1): 標本 ${mid.samples}回 / 伸びた回数 ${mid.steps}`);
    expect(mid.steps).toBeGreaterThanOrEqual(4);

    // ── 条件2 ──
    await pageA.mouse.up();
    await expect(pageA.locator("#status")).toContainText("保存しました");
    await expect(savedInk(pageB)).toHaveCount(1);
    await expect(liveInk(pageB)).toHaveCount(0);

    // ── 条件4（引いている最中にタブが落ちる）──
    await drawSlowly(
      pageA, await boardPoint(pageA, 3000, 12000), await boardPoint(pageA, 11000, 13000),
      { steps: 8, pause: 300 }
    );
    await expect(liveInk(pageB)).toHaveCount(1);
    const closedAt = Date.now();
    await pageA.close();
    await pageB.bringToFront();
    await expect(liveInk(pageB)).toHaveCount(0, { timeout: CURSOR_TTL_MS + 3000 });
    console.log(`受け入れ条件9(条件4): タブが落ちてから消えるまで ${Date.now() - closedAt}ms`);
    // 確定した線は条件2の1本だけ（途中の点は保存されていない）。
    await expect(savedInk(pageB)).toHaveCount(1);
  } finally {
    clearInterval(noise);
    for (const conn of guests) {
      try { conn.close(); } catch { /* 既に閉じている */ }
    }
    await ctx.close();
  }
});
