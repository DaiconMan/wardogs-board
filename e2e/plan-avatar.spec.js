// Discord のアイコン（アバター）を名前の横に出す — UIテスト。
//
// 仕様: docs/superpowers/specs/2026-10-02-avatar-opt-in.md（受け入れ条件1〜8）
//
// **画像は Discord の CDN から取りに来る。** テストでそこへ出て行くわけには
// いかないので、`context.route()` で `cdn.discordapp.com` を横取りする。
//   * 読める人  … 小さな PNG を返す
//   * 404 の人  … 404 を返す（**壊れた画像のアイコンを出さない**ことの試験）
// 横取りしていること自体が「ブラウザが直接読んでいる（サーバが中継して
// いない）」の証拠でもある——中継していたら、ここを塞いでも画像は出る。
//
// テスト用 Discord ID の帯: 9961–9980（e2e/config.js の採番表を参照）
import { expect, test } from "@playwright/test";

import {
  boardPoint, createPlan, joinRoomAsGuest, loginViaApi, mapSizeM, planUrl, showWholeMap,
} from "./plan-helpers.js";

/** 読める hash と、CDN に無い hash。32桁の16進（Discord と同じ形）。 */
const OK_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const GONE_HASH = "ffffffffffffffffffffffffffffffff";

const CDN = "https://cdn.discordapp.com/**";

/** 4x4 の PNG。中身は何でもよく、**読めること**だけが要る。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGO4bK0HRwzEcQAMIhPB+HY8wwAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * Discord の CDN を横取りする。`GONE_HASH` を含む URL だけ 404 にする。
 *
 * **取りに来た URL を記録する。** 「hash を URL に組み立ててブラウザが直接
 * 読む」が実際に起きていることの証拠として使う。
 */
async function stubCdn(context) {
  const asked = [];
  await context.route(CDN, (route) => {
    const url = route.request().url();
    asked.push(url);
    if (url.includes(GONE_HASH)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  return asked;
}

const chips = (page) => page.locator("#presence .pres-chip");
const dots = (page) => page.locator("#presence .pres-dot");
const faces = (page) => page.locator("#presence .pres-dot .avatar-img");

async function openPlan(page, planId) {
  await page.goto(planUrl(`/plan?id=${planId}`));
  await mapSizeM(page);
  await showWholeMap(page);
}

/** 要素の画面上の大きさ（小数のまま。ズームの比較に使う）。 */
const sizeOf = (loc) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { w: r.width, h: r.height };
});

// ══ 受け入れ条件 1 ══════════════════════════════════════════════
test("自分のアイコンが在室の粒に出る（色の輪は残る）", async ({ browser }) => {
  const ctx = await browser.newContext();
  const asked = await stubCdn(ctx);
  await loginViaApi(ctx, "9961", "かおあり", { avatar: OK_HASH });
  const planId = await createPlan(ctx, "アイコン1");
  const page = await ctx.newPage();
  await openPlan(page, planId);

  await expect(chips(page)).toHaveCount(1);
  await expect(faces(page)).toHaveCount(1);
  // 画像が本当に読めている（0x0 の壊れた画像ではない）。
  expect(await faces(page).evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);

  // **ブラウザが Discord へ直接取りに行っている**（サーバは中継していない）。
  expect(asked.some((u) => u.includes(`/9961/${OK_HASH}.png`))).toBe(true);

  // ══ 受け入れ条件 4 ══ 色の輪が残っている（誰のペンの色か分かる）。
  // アイコンは丸の「中身」で、丸そのものを置き換えていない。
  await expect(dots(page)).toHaveAttribute("style", /var\(--cursor-[1-8]\)/);
  const dot = await sizeOf(dots(page));
  const face = await sizeOf(faces(page));
  expect(face.w, "アイコンが輪をはみ出している").toBeLessThan(dot.w);
  expect(face.w).toBeGreaterThan(0);

  await ctx.close();
});

// ══ 受け入れ条件 8 ══════════════════════════════════════════════
// **実態と食い違わせない**（D-048。見られていることを、見る前に知れる状態にする）。
test("プライバシーの注記がアイコンのことも言っている", async ({ browser }) => {
  const ctx = await browser.newContext();
  await stubCdn(ctx);
  await loginViaApi(ctx, "9962", "注記あばた", { avatar: OK_HASH });
  const planId = await createPlan(ctx, "アイコン2");
  const page = await ctx.newPage();
  await openPlan(page, planId);

  const note = page.locator("#presence .pres-priv");
  await expect(note).toBeVisible();
  await expect(note).toHaveText("あなたの名前とアイコンも相手に見えます（記録は残りません）");

  await ctx.close();
});

// ══ 受け入れ条件 2・5・7 ════════════════════════════════════════
test("相手のアイコンがカーソルのラベルと在室の粒に出る", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  await stubCdn(a);
  await stubCdn(b);
  await loginViaApi(a, "9963", "さすかお", { avatar: OK_HASH });
  // **相手はアイコンを持たない人**（Discord の既定アイコン）。
  // ログイン済みでアイコンのある人と無い人が同じ一覧に並ぶ形を、ここで作る。
  await loginViaApi(b, "9964", "みるのっぺら");
  const planId = await createPlan(a, "アイコン3");

  const pageA = await a.newPage();
  await openPlan(pageA, planId);
  const pageB = await b.newPage();
  await openPlan(pageB, planId);

  await expect(chips(pageB)).toHaveCount(2);

  // ── 在室の粒: アイコンがあるのは1人だけ。もう1人は色の丸のまま ──
  await expect(faces(pageB)).toHaveCount(1);
  await expect(dots(pageB)).toHaveCount(2);
  // 粒の大きさが揃っている（混ざっても列が凸凹にならない）。
  const [d1, d2] = await dots(pageB).evaluateAll(
    (els) => els.map((el) => el.getBoundingClientRect().width)
  );
  expect(d1).toBe(d2);

  // ── カーソルのラベル ──────────────────────────────────────
  const at = await boardPoint(pageA, 8000, 4000);
  await pageA.mouse.move(at.x, at.y);
  await pageA.mouse.move(at.x + 3, at.y + 3);

  const cursor = pageB.locator("#cursor-layer .cursor");
  await expect(cursor).toHaveCount(1);
  await expect(cursor.locator(".cursor-avatar-img")).toHaveCount(1);
  // 色の輪はカーソルにも残る（ペンの色と同じ色）。
  await expect(cursor.locator(".cursor-ring")).toHaveAttribute("stroke", /var\(--cursor-[1-8]\)/);
  // 名前も消えない（8色を超えると色相が重なるため。D-047）。
  await expect(cursor.locator(".cursor-name")).toHaveText("さすかお");

  // ── 逆向き: アイコンの無い人のカーソルは今までどおり ──────
  const at2 = await boardPoint(pageB, 4000, 8000);
  await pageB.mouse.move(at2.x, at2.y);
  await pageB.mouse.move(at2.x + 3, at2.y + 3);
  const back = pageA.locator("#cursor-layer .cursor");
  await expect(back).toHaveCount(1);
  await expect(back.locator(".cursor-avatar-img")).toHaveCount(0);
  await expect(back.locator(".cursor-name")).toHaveText("みるのっぺら");

  await a.close();
  await b.close();
});

// ══ 受け入れ条件 7 ══════════════════════════════════════════════
// **10Hz の経路に載せていない。** 実際に飛んでいる通を読んで確かめる
// （単体では `tests/room-cursors.test.js` が形を固定している）。
test("curs の中身が増えていない（hash はカーソルの通に載らない）", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  await stubCdn(a);
  await stubCdn(b);
  await loginViaApi(a, "9965", "通をみる", { avatar: OK_HASH });
  await loginViaApi(b, "9966", "通をおくる", { avatar: OK_HASH });
  const planId = await createPlan(a, "アイコン4");

  const pageA = await a.newPage();
  // **開く前から全部のフレームを拾う。** 繋がった直後の `who` も含めて見る。
  const frames = [];
  pageA.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
  await openPlan(pageA, planId);

  const pageB = await b.newPage();
  await openPlan(pageB, planId);
  await expect(chips(pageA)).toHaveCount(2);

  const at = await boardPoint(pageB, 6000, 6000);
  await pageB.mouse.move(at.x, at.y);
  for (let i = 1; i <= 10; i += 1) await pageB.mouse.move(at.x + i * 4, at.y + i * 4);
  await expect(pageA.locator("#cursor-layer .cursor")).toHaveCount(1);

  const curs = frames.filter((f) => f.includes('"t":"curs"'));
  const who = frames.filter((f) => f.includes('"t":"who"'));
  expect(curs.length, "カーソルの通が1つも流れていない").toBeGreaterThan(0);
  expect(who.length, "在室の通が1つも流れていない").toBeGreaterThan(0);

  // **hash が出てよいのは `who` だけ。**
  expect(who.some((f) => f.includes(OK_HASH)), "who に hash が載っていない").toBe(true);
  for (const f of curs) {
    expect(f, `curs に hash が載っている: ${f}`).not.toContain(OK_HASH);
    expect(f, `curs に avatar が載っている: ${f}`).not.toContain("avatar");
    // 値は [x, y, 所有者] の3つのまま。
    for (const v of Object.values(JSON.parse(f).c)) expect(v.length).toBeLessThanOrEqual(3);
  }

  await a.close();
  await b.close();
});

// ══ 受け入れ条件 5 ══════════════════════════════════════════════
// **「アバターが無い」と「読めなかった」を同じ結果に倒す。**
// Discord 側で消された hash や、CDN が塞がれている環境がある。
test("画像が404のときは色の丸に戻る（壊れた画像を出さない）", async ({ browser }) => {
  const ctx = await browser.newContext();
  await stubCdn(ctx);
  await loginViaApi(ctx, "9967", "きえたかお", { avatar: GONE_HASH });
  const planId = await createPlan(ctx, "アイコン5");
  const page = await ctx.newPage();
  await openPlan(page, planId);

  await expect(chips(page)).toHaveCount(1);
  // 色の丸は出る。中身（アイコン）は出ない。
  await expect(dots(page)).toHaveAttribute("style", /var\(--cursor-[1-8]\)/);
  await expect(faces(page)).toHaveCount(0);

  // **壊れた画像の形跡が1つも無い。** 消したあとに生き返らないことも見る
  // （在室は更新のたびに描き直すので、覚えていないと出かけては消える）。
  await page.waitForTimeout(500);
  await expect(faces(page)).toHaveCount(0);
  await expect(page.locator("#presence img")).toHaveCount(0);

  await ctx.close();
});

// ══ 受け入れ条件 5（ゲスト）════════════════════════════════════
// **ゲストにはアバターが無い**（D-072）。ログイン済みと混ざって並ぶ。
test("ログイン済みとゲストが混ざっても一覧が破綻しない", async ({ browser }) => {
  const ctx = await browser.newContext();
  await stubCdn(ctx);
  await loginViaApi(ctx, "9968", "あいこん持ち", { avatar: OK_HASH });
  const planId = await createPlan(ctx, "アイコン6");
  const page = await ctx.newPage();
  await openPlan(page, planId);
  await expect(chips(page)).toHaveCount(1);

  // ログイン無しの人を2人、部屋に入れる（ブラウザは開かない）。
  const g1 = await joinRoomAsGuest(planId);
  const g2 = await joinRoomAsGuest(planId);
  await expect(chips(page)).toHaveCount(3);

  // ゲストには色の丸だけ。アイコンは1つ（ログイン済みの1人ぶん）。
  await expect(faces(page)).toHaveCount(1);
  await expect(page.locator("#presence .pres-chip[data-guest] .avatar-img")).toHaveCount(0);
  await expect(page.locator("#presence .pres-guest")).toHaveCount(2);

  // **粒の高さが揃っている。** アイコンの有無で行の高さが変わると、
  // 混ざった一覧がガタガタになる（ヘッダの高さは在室で動かさない約束）。
  const heights = await chips(page).evaluateAll(
    (els) => [...new Set(els.map((el) => el.getBoundingClientRect().height))]
  );
  expect(heights, `粒の高さが揃っていない: ${JSON.stringify(heights)}`).toHaveLength(1);

  // 色の丸も全員ぶん同じ大きさ。
  const dotSizes = await dots(page).evaluateAll(
    (els) => [...new Set(els.map((el) => el.getBoundingClientRect().width))]
  );
  expect(dotSizes).toHaveLength(1);

  g1.close();
  g2.close();
  await ctx.close();
});

// ══ 受け入れ条件 6 ══════════════════════════════════════════════
// **ズームで大きさを変えない**（既存の逆スケールに相乗りする。D-068）。
test("ズームしてもカーソルのアイコンの大きさが変わらない", async ({ browser }) => {
  // **補間を切ってから測る。** カーソルの `transform` には `scale()` が
  // 入っていて、`transition:transform` がそれも補間する（実測: 出た直後に
  // 2.9px、ズーム直後に 19.4px と、どちらも通過点を拾った）。
  // CSS は `prefers-reduced-motion` で補間を切る分岐を既に持っている。
  const a = await browser.newContext({ reducedMotion: "reduce" });
  const b = await browser.newContext({ reducedMotion: "reduce" });
  await stubCdn(a);
  await stubCdn(b);
  await loginViaApi(a, "9969", "ズームさす", { avatar: OK_HASH });
  await loginViaApi(b, "9970", "ズームみる");
  const planId = await createPlan(a, "アイコン7");

  const pageA = await a.newPage();
  await openPlan(pageA, planId);
  const pageB = await b.newPage();
  await openPlan(pageB, planId);
  await expect(chips(pageB)).toHaveCount(2);

  const at = await boardPoint(pageA, 8000, 8000);
  await pageA.mouse.move(at.x, at.y);
  await pageA.mouse.move(at.x + 3, at.y + 3);

  const face = pageB.locator("#cursor-layer .cursor .cursor-avatar-img");
  await expect(face).toHaveCount(1);
  const before = await sizeOf(face);
  expect(before.w).toBeGreaterThan(0);

  await pageB.getByRole("button", { name: "拡大" }).click();
  await pageB.getByRole("button", { name: "拡大" }).click();
  // 動かし続けて、拡大後の盤面にもカーソルが届いている状態にする。
  await pageA.mouse.move(at.x + 6, at.y + 6);
  await expect(face).toHaveCount(1);

  const after = await sizeOf(face);
  expect(Math.abs(after.w - before.w), `${before.w} → ${after.w}`).toBeLessThan(1);
  expect(Math.abs(after.h - before.h)).toBeLessThan(1);

  await a.close();
  await b.close();
});

// ══ 受け入れ条件 3 ══════════════════════════════════════════════
test("一覧の作成者名の横にアイコンが出る", async ({ browser }) => {
  const owner = await browser.newContext();
  await loginViaApi(owner, "9971", "公開した人", { avatar: OK_HASH });
  const withFace = await createPlan(owner, "アイコンのある作成者の作戦");
  await loginViaApi(owner, "9972", "のっぺら作成者");
  const noFace = await createPlan(owner, "アイコンの無い作成者の作戦");

  // 公開しないと他人の一覧に出ない。**Cookie は最後にログインした人のもの**
  // なので、`noFace` → `withFace` の順に戻しながら公開する。
  for (const [id, discordId, name] of [
    [noFace, "9972", "のっぺら作成者"],
    [withFace, "9971", "公開した人"],
  ]) {
    await loginViaApi(owner, discordId, name, { avatar: id === withFace ? OK_HASH : null });
    const res = await owner.request.fetch(planUrl(`/api/sessions/${id}`), {
      method: "PATCH",
      headers: { origin: planUrl(""), "content-type": "application/json" },
      data: { visibility: "public" },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  const ctx = await browser.newContext();
  const asked = await stubCdn(ctx);
  await loginViaApi(ctx, "9973", "一覧をみる人");
  const page = await ctx.newPage();
  await page.goto(planUrl("/plan"));

  const rows = page.locator("#public-sessions li");
  const rowWith = rows.filter({ hasText: "アイコンのある作成者の作戦" });
  const rowNo = rows.filter({ hasText: "アイコンの無い作成者の作戦" });
  await expect(rowWith).toHaveCount(1);
  await expect(rowNo).toHaveCount(1);

  await expect(rowWith.locator(".by .avatar-img")).toHaveCount(1);
  expect(asked.some((u) => u.includes(`/9972/`)), "アイコンの無い人の URL を組み立てた")
    .toBe(false);
  // アイコンの無い作成者の行は今までどおり（壊れた画像も空の枠も出さない）。
  await expect(rowNo.locator(".by img")).toHaveCount(0);
  await expect(rowNo.locator(".by strong")).toHaveText("のっぺら作成者");

  await ctx.close();
  await owner.close();
});
