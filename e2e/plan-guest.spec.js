// ログイン無しで見る（ゲスト）の UIテスト。
//
// 仕様: docs/superpowers/specs/2026-10-02-guest-viewers.md
//
// **受け入れ条件のうち、画面でしか確かめられないものをここに置く。**
// サーバ側（書き込みの総当たり・行が増えないこと・接頭辞の検査）は
// `tests/plan-guest.test.js` が持つ。重ねない。
//
//   1. URL を知っている作戦を開ける（非公開も含む）     … ここ
//   2. ログイン済みとゲストで**おたがいの**カーソルが見える … ここ（主役）
//   3. 名前が毎回同じ。localStorage を消すと変わる        … ここ
//   7. 満員でログイン済みがゲストを押し出して入れる        … ここ
//   8. ログイン済みの挙動が変わっていない                 … 既存の全 spec ＋ ここ1本
//
// テスト用 Discord ID の帯: 9931–9960（e2e/config.js の採番表を参照）
import { expect, test } from "@playwright/test";

import { GUEST_STORAGE_KEY, guestName, newGuestId } from "../public/js/plan/guest.js";
import { MAX_MEMBERS } from "../public/js/plan/presence.js";

import {
  boardPoint, createPlan, joinRoom, joinRoomAsGuest, loginHeadless, loginViaApi,
  mapSizeM, openAccountMenu, planUrl, seedGuestId, showWholeMap,
} from "./plan-helpers.js";

const cursors = (page) => page.locator("#cursor-layer .cursor");
const presNames = (page) => page.locator("#presence .pres-name");

async function openPlan(page, planId) {
  await page.goto(planUrl(`/plan?id=${planId}`));
  await mapSizeM(page);
  await showWholeMap(page);
}

/** 1人ログインして作戦を1つ作る（下ごしらえ）。 */
async function ownerWithPlan(browser, discordId, name, title) {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, discordId, name);
  const planId = await createPlan(ctx, title);
  return { ctx, planId };
}

// ══ 受け入れ条件 1 ══════════════════════════════════════════════
test("ログイン無しで、URL を知っている非公開の作戦を開ける", async ({ browser }) => {
  const { ctx: owner, planId } = await ownerWithPlan(browser, "9931", "作った人", "ゲストが見る作戦");

  const guestCtx = await browser.newContext();
  const errors = [];
  const guestId = await seedGuestId(guestCtx);
  const page = await guestCtx.newPage();
  page.on("pageerror", (e) => errors.push(e));
  await openPlan(page, planId);

  // 盤面が出ている（**非公開のまま**。URL を知っていれば開けるのは
  // いまのログイン済みとまったく同じ扱い）。
  await expect(page.locator("#board")).toBeVisible();
  await expect(page.locator("#map-bounds")).toHaveCount(1);
  await expect(page.locator("#title")).toHaveText("ゲストが見る作戦");
  expect(errors, "ゲストの画面で例外が出た").toEqual([]);

  // 右上に自分の名前（生成名）。**式はサーバと同じ1箇所から来る。**
  await expect(page.locator("#account-name")).toHaveText(guestName(guestId));

  await guestCtx.close();
  await owner.close();
});

test("ゲストには書く道具が出ず、理由が画面に出る", async ({ browser }) => {
  const { ctx: owner, planId } = await ownerWithPlan(browser, "9932", "作った人2", "道具が止まる作戦");

  const guestCtx = await browser.newContext();
  await seedGuestId(guestCtx);
  const page = await guestCtx.newPage();
  await openPlan(page, planId);

  // **書く道具は無効。**（ペンが押せたら、引いた線が消えたように見える）
  await expect(page.getByRole("button", { name: "ペン" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "建造物" })).toBeDisabled();

  // **見る道具は残す。**「読むだけ」の読むほうが成り立たなくなる（setViewOnly）。
  await expect(page.getByRole("button", { name: "拡大" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "全体表示" })).toBeEnabled();

  // 理由が2か所に出る。札（短く）と状態表示（1文で）。
  await expect(page.locator("#read-only")).toBeVisible();
  await expect(page.locator("#status")).toContainText("書き込むには");
  await expect(page.locator("#status")).toContainText("ログイン");

  // 公開設定の欄は出さない（作った人のものなので）。
  await expect(page.locator("#visibility")).toBeHidden();

  // ログインの導線は「自分」の引き出しの中（ログアウトと同じ場所）。
  await openAccountMenu(page);
  await expect(page.locator("#to-login")).toBeVisible();
  await expect(page.locator("#logout")).toBeHidden();

  // 押したら Discord の認可の入口へ向かう（ログイン前の `#login` と同じやり方）。
  // **本物の discord.com へは行かせない。** 入口を横取りして、
  // 「どこへ向かったか」だけを見る（外へ出る試験は落ちやすく、遅い）。
  await page.route("**/api/auth/discord/start*", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "stub" }));
  await page.locator("#to-login").click();
  await expect.poll(() => page.url()).toContain("/api/auth/discord/start");

  await guestCtx.close();
  await owner.close();
});

// ══ 受け入れ条件 3 ══════════════════════════════════════════════
test("ゲストの名前はリロードしても同じ。localStorage を消すと変わる", async ({ browser }) => {
  const { ctx: owner, planId } = await ownerWithPlan(browser, "9933", "作った人3", "名前が変わらない作戦");

  // **身元を先に置かない。** 画面が自分で作るところから見たいので、
  // 素のコンテキストで開いて localStorage に何が入るかを確かめる。
  const guestCtx = await browser.newContext();
  const page = await guestCtx.newPage();
  await openPlan(page, planId);

  const first = await page.locator("#account-name").textContent();
  expect(first, "名前が付いていない").toBeTruthy();

  // **置いているのは乱数1つだけ**（指紋の材料を貯める器にしない）。
  const stored = await page.evaluate((key) => localStorage.getItem(key), GUEST_STORAGE_KEY);
  expect(stored, "身元が localStorage に無い").toMatch(/^anon:[A-Za-z0-9_-]{22}$/);
  expect(guestName(stored), "画面の名前がサーバの式と違う").toBe(first);

  // リロードしても同じ名前（＝同じ身元が使い回されている）。
  for (let i = 0; i < 2; i += 1) {
    await openPlan(page, planId);
    await expect(page.locator("#account-name")).toHaveText(first);
  }

  // 消すと別人になる。
  await page.evaluate((key) => localStorage.removeItem(key), GUEST_STORAGE_KEY);
  await openPlan(page, planId);
  const second = await page.locator("#account-name").textContent();
  const storedAgain = await page.evaluate((key) => localStorage.getItem(key), GUEST_STORAGE_KEY);
  expect(storedAgain).not.toBe(stored);
  expect(guestName(storedAgain)).toBe(second);

  await guestCtx.close();
  await owner.close();
});

// ══ 受け入れ条件 2（このファイルの主役）════════════════════════════
//
// **2枚のタブで、片方はログイン済み・片方はログイン無し。**
// おたがいのカーソルが見えること。ここが「価値の本体」（仕様 §画面）。
test("ログイン済みとゲストで、おたがいのカーソルが見える", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  await loginViaApi(ownerCtx, "9934", "ログイン済み");
  const planId = await createPlan(ownerCtx, "カーソルを見せ合う作戦");

  const guestCtx = await browser.newContext();
  const guestId = await seedGuestId(guestCtx);
  const guestLabel = guestName(guestId);

  const pageIn = await ownerCtx.newPage();
  await openPlan(pageIn, planId);
  const pageOut = await guestCtx.newPage();
  await openPlan(pageOut, planId);

  // 在室一覧に2人そろう（ゲストも「人」として席を1つ取る）。
  await expect(presNames(pageIn)).toHaveCount(2);
  await expect(presNames(pageOut)).toHaveCount(2);
  await expect(presNames(pageIn)).toContainText([guestLabel]);

  // **ゲストだと分かる印が付いている**（書けない人だと周りに分かるように）。
  const guestChip = pageIn.locator('#presence .pres-chip[data-guest="1"]');
  await expect(guestChip, "ログイン済みの画面にゲストの印が出ていない").toHaveCount(1);
  await expect(guestChip.locator(".pres-name")).toHaveText(guestLabel);
  await expect(guestChip.locator(".pres-guest")).toHaveText("見るだけ");
  // ログイン済みのほうには印が付かない。
  await expect(pageIn.locator('#presence .pres-chip:not([data-guest])')).toHaveCount(1);

  // ── ゲスト → ログイン済み ───────────────────────────────
  const atGuest = await boardPoint(pageOut, 6000, 7000);
  await pageOut.mouse.move(atGuest.x, atGuest.y);
  await expect(cursors(pageIn), "ゲストのカーソルが相手に出ない").toHaveCount(1);
  await expect(cursors(pageIn).locator(".cursor-name")).toHaveText(guestLabel);

  // ── ログイン済み → ゲスト ───────────────────────────────
  const atOwner = await boardPoint(pageIn, 9000, 3000);
  await pageIn.mouse.move(atOwner.x, atOwner.y);
  await expect(cursors(pageOut), "ログイン済みのカーソルがゲストに出ない").toHaveCount(1);
  await expect(cursors(pageOut).locator(".cursor-name")).toHaveText("ログイン済み");

  // 自分のカーソルは描かない（OS のポインタと二重になる）。ゲストでも同じ。
  const where = await cursors(pageOut).evaluate((el) => {
    const m = el.getAttribute("transform")?.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
    return { x: Number(m[1]), y: Number(m[2]) };
  });
  expect(Math.abs(where.x - 9000)).toBeLessThan(40);
  expect(Math.abs(where.y - 3000)).toBeLessThan(40);

  await guestCtx.close();
  await ownerCtx.close();
});

// ══ /plan（一覧）をログイン無しで開く ════════════════════════════
test("ログイン無しの /plan は、公開されている作戦とログインの案内", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  await loginViaApi(ownerCtx, "9935", "公開する人");
  const openId = await createPlan(ownerCtx, "ゲストに見せる公開の作戦");
  const secretId = await createPlan(ownerCtx, "ゲストに見せない非公開の作戦");
  const res = await ownerCtx.request.patch(planUrl(`/api/sessions/${openId}`), {
    headers: { "content-type": "application/json", origin: planUrl("") },
    data: { visibility: "public" },
  });
  expect(res.status(), "公開にできなかった").toBe(200);

  const guestCtx = await browser.newContext();
  await seedGuestId(guestCtx);
  const page = await guestCtx.newPage();
  await page.goto(planUrl("/plan"));

  // ログイン前の画面のまま（地の色も体裁も既存と同じ型）。
  await expect(page.locator("main.gate")).toBeVisible();
  await expect(page.getByRole("button", { name: /Discord でログイン/ })).toBeVisible();
  // 道具の棚は出さない（できることが1つも増えない）。
  await expect(page.locator("#rail")).toBeHidden();
  await expect(page.locator("#board")).toHaveCount(0);

  // 公開されている作戦だけが並ぶ。
  const rows = page.locator("#public-sessions li");
  await expect(rows.filter({ hasText: "ゲストに見せる公開の作戦" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "ゲストに見せない非公開の作戦" })).toHaveCount(0);
  // 「自分の作戦」と「開いたことがある作戦」の節は出ない（ゲストには無い）。
  await expect(page.locator("#sessions")).toHaveCount(0);
  await expect(page.locator("#visited-list")).toHaveCount(0);

  // 行から開ける（ここが「公開」の意味）。
  await rows.filter({ hasText: "ゲストに見せる公開の作戦" }).getByRole("link", { name: "開く" }).click();
  await expect(page.locator("#board")).toBeVisible();
  expect(page.url()).toContain(openId);
  await expect(page.locator("#read-only")).toBeVisible();
  // 非公開のほうは一覧から辿れないが、URL を知っていれば開ける（条件1）。
  await page.goto(planUrl(`/plan?id=${secretId}`));
  await expect(page.locator("#board")).toBeVisible();

  await guestCtx.close();
  await ownerCtx.close();
});

// ══ 受け入れ条件 7 ══════════════════════════════════════════════
//
// **ゲストは誰でも何個でも身元を作れる。** これが無いと、URL が漏れた作戦の
// 部屋をゲストで埋めてチームを入れなくできる。
//
// ゲストの接続はログインの往復が1回も要らないので、満員を作るのは速い
// （それ自体がこの対策を入れた理由でもある）。
test("満員でも、ログイン済みはゲストを押し出して入れる", async ({ browser }) => {
  test.setTimeout(300_000);

  const ownerCtx = await browser.newContext();
  await loginViaApi(ownerCtx, "9936", "部屋の主");
  const planId = await createPlan(ownerCtx, "満員の部屋");

  // 上限ちょうどまでゲストで埋める（主はまだ入っていない）。
  const guests = [];
  for (let i = 0; i < MAX_MEMBERS; i += 1) {
    guests.push(await joinRoomAsGuest(planId, newGuestId()));
  }
  expect(guests.filter((c) => c.closed), "埋める途中で断られた接続がある").toEqual([]);

  // ── ゲストが来ても入れない（押し出すのはログイン済みが来たときだけ）──
  // ゲスト同士で押し合うと、2人目が1人目を蹴るだけの椅子取りになる。
  const extraGuest = await joinRoomAsGuest(planId, newGuestId());
  await expect.poll(() => extraGuest.closed?.code, { timeout: 10_000 }).toBe(1013);
  // 押し合っていないこと（既に居るゲストは誰も閉じられていない）。
  expect(guests.filter((c) => c.closed).length, "ゲスト同士で押し出し合った").toBe(0);

  // ── ログイン済みが来たら入れる ────────────────────────────
  const cookie = await loginHeadless("9937", "あとから来た人");
  const member = await joinRoom(cookie, planId);
  expect(member.status, "ログイン済みが満員で断られた").toBe(101);

  // ゲストが**ちょうど1人**押し出されている（既存の 1013 の経路）。
  await expect
    .poll(() => guests.filter((c) => c.closed?.code === 1013).length, { timeout: 10_000 })
    .toBe(1);
  // 閉じたのは「満員です」の経路（新しい番号を作っていない）。
  const pushed = guests.find((c) => c.closed);
  expect(pushed.closed.code).toBe(1013);

  // 入った人は在室一覧に出る（席が本当に空いた）。
  await expect
    .poll(() => {
      const who = member.messages.map((m) => { try { return JSON.parse(m); } catch { return null; } })
        .filter((m) => m?.t === "who").at(-1);
      return who?.members?.some((m) => m.id === "9937") ?? false;
    }, { timeout: 10_000 })
    .toBe(true);

  for (const c of [...guests, extraGuest, member]) {
    try { c.close(); } catch { /* 既に閉じている */ }
  }
  await ownerCtx.close();
});

// ══ 受け入れ条件 8 ══════════════════════════════════════════════
//
// 既存の spec 群が全部ログイン済みなので、退行はそちらが広く見ている。
// ここは**ゲストの仕組みが入ったあとのログイン済み**を1本だけ名指しで見る
// （ヘッダの文言と、書けること）。
test("ログイン済みの挙動は変わっていない", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginViaApi(ctx, "9938", "いつもの人");
  const planId = await createPlan(ctx, "退行の見張り");
  const page = await ctx.newPage();
  await openPlan(page, planId);

  await expect(page.locator("#account-name")).toHaveText("いつもの人");
  await openAccountMenu(page);
  await expect(page.locator("#who")).toContainText("でログイン中");
  await expect(page.locator("#logout")).toBeVisible();
  await expect(page.locator("#to-login"), "ログイン済みに入る導線が出た").toBeHidden();
  await page.keyboard.press("Escape");

  // 自分の作戦なので公開設定の欄が出て、「見るだけ」の札は出ない。
  await expect(page.locator("#visibility")).toBeVisible();
  await expect(page.locator("#read-only")).toBeHidden();
  // 書ける。
  await expect(page.getByRole("button", { name: "ペン" })).toBeEnabled();

  await ctx.close();
});
