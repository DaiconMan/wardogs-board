// 1km セルの見出し（ガター）と、狭い画面で「物を置く手段」に届くかどうか。
//
// 背景: 実機（iPhone 390px）で 256個のセル名が地図を覆い、`A10B10C10D10…` と
// 潰れて地図がほとんど見えなかった。地図の上から文字を退かし、盤面の縁に
// 列（A〜P）と行（1〜16）の見出しを出す（海図・方眼図と同じ形）。
import { test, expect } from "@playwright/test";

import {
  boardPoint, coverViewBox, createPlan, fitViewBox, loginViaApi, planUrl, showWholeMap,
} from "./plan-helpers.js";


async function openPlan(page, context, id, name) {
  await loginViaApi(context, id, name);
  const planId = await createPlan(context, name);
  await page.goto(planUrl(`/plan?id=${planId}`));
  await expect(page.locator("#board")).toBeVisible();
  // マップ座標で位置を指すので、まずマップ全体が見える状態にする
  // （開いた直後は地図が画面を埋めていて、外周は画面の外にいる）。
  await showWholeMap(page);
}

/** 見えている見出しの文字を、画面上の並び順で返す。 */
function labels(page, sel) {
  return page.locator(sel).evaluateAll((els) =>
    els
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ text: el.textContent, ...el.getBoundingClientRect().toJSON() }))
  );
}

/** 盤面の中心から (dx,dy) ぶんドラッグしてパンする。 */
async function panBy(page, dx, dy) {
  await page.getByRole("button", { name: "移動" }).click();
  const box = await page.locator("#board").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 10 });
  await page.mouse.up();
}

test.describe("セル名のガター", () => {
  test("全体表示で盤面の縁に A〜P と 1〜16 が並ぶ", async ({ page, context }) => {
    await openPlan(page, context, "9400", "gutter");

    const cols = await labels(page, "#gutter-cols .gl");
    const rows = await labels(page, "#gutter-rows .gl");
    expect(cols.map((c) => c.text)).toEqual(
      ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"]
    );
    // **行は下が 1**。ゲームのマップ画面の縦軸が下 1・上 16 になっている
    // （オーナーがゲーム内で確認、2026-09-29）。DOM は上から順なので 16 → 1。
    // ここが逆だと、Discord で「D8」と言った場所と画面の「D8」が食い違う。
    expect(rows.map((r) => r.text)).toEqual(
      ["16", "15", "14", "13", "12", "11", "10", "9", "8", "7", "6", "5", "4", "3", "2", "1"]
    );

    // 列は左から右に A→P、行は上から下へ 16→1（＝下へ行くほど番号が小さい）。
    for (let i = 1; i < cols.length; i += 1) expect(cols[i].x).toBeGreaterThan(cols[i - 1].x);
    for (let i = 1; i < rows.length; i += 1) expect(rows[i].y).toBeGreaterThan(rows[i - 1].y);
    const rowNumbers = rows.map((r) => Number(r.text));
    for (let i = 1; i < rowNumbers.length; i += 1) {
      expect(rowNumbers[i], "下へ行くほど番号が小さい").toBeLessThan(rowNumbers[i - 1]);
    }

    // 帯は地図の縁に沿う。地図が盤面いっぱいに出ていて外に余地が無いときは
    // 縁の内側に寄るが、帯の厚みぶん（16/20px）までしか入らない。
    const map = await page.locator("#map-bounds").boundingBox();
    const colsBand = await page.locator("#gutter-cols").boundingBox();
    const rowsBand = await page.locator("#gutter-rows").boundingBox();
    expect(colsBand.y + colsBand.height).toBeLessThanOrEqual(map.y + 17);
    expect(rowsBand.x + rowsBand.width).toBeLessThanOrEqual(map.x + 21);

    // 見出しは必ず帯の中にいる（地図の上に散らばらない）。
    for (const c of cols) {
      expect(c.y).toBeGreaterThanOrEqual(colsBand.y - 1);
      expect(c.y + c.height).toBeLessThanOrEqual(colsBand.y + colsBand.height + 1);
    }
    for (const r of rows) {
      expect(r.x).toBeGreaterThanOrEqual(rowsBand.x - 1);
      expect(r.x + r.width).toBeLessThanOrEqual(rowsBand.x + rowsBand.width + 1);
    }
  });

  test("地図の上に 256個の <text> を撒かない", async ({ page, context }) => {
    await openPlan(page, context, "9401", "no256");

    // 旧実装（#grid-labels の 256個）が残っていないこと。
    await expect(page.locator("#grid-labels")).toHaveCount(0);
    await expect(page.locator("#grid-labels text")).toHaveCount(0);
    // 盤面（SVG）の中に、グリッド由来の文字要素が無い
    // （この作戦にはまだ配置も地名も無い）。
    // マップが持っている物の名前（ドリルタワー 5・陣営スポーン 3）は数に入れない。
    // こちらは 8 個しかなく、しかもタワー名は引いて見ている間は伏せてある。
    const stray = await page.locator("#board").evaluate((svg) =>
      [...svg.querySelectorAll("text")].filter((t) => !t.closest("#towers, #spawns")).length);
    expect(stray, "グリッド由来の文字が地図の上に残っている").toBe(0);
  });

  test("パンすると見出しがセルと一緒に動く", async ({ page, context }) => {
    await openPlan(page, context, "9402", "gutterpan");

    // 寄ってからパンする（全体表示のままだと動かせる余地が無い）。
    // ボタンのズームは 150ms かけて補間するので、ホイールで一息に寄せる
    // （途中の値を拾うと「動いた向き」を読み違える）。
    const box = await page.locator("#board").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await expect(page.locator("#board")).not.toHaveAttribute("viewBox", await coverViewBox(page));

    const before = await labels(page, "#gutter-cols .gl");
    await panBy(page, -120, 0);
    const after = await labels(page, "#gutter-cols .gl");

    const beforeAt = new Map(before.map((c) => [c.text, c.x]));
    const moved = after.filter((c) => beforeAt.has(c.text));
    expect(moved.length).toBeGreaterThan(0);
    for (const c of moved) expect(c.x).toBeLessThan(beforeAt.get(c.text) - 10);

    // 画面の外へ出た見出しは出さない（16個ぜんぶは出ていない）。
    expect(after.length).toBeLessThan(16);
  });

  test("寄るとセルの名前が中央に出る。ただし4個以下", async ({ page, context }) => {
    await openPlan(page, context, "9403", "cellnames");

    // 全体表示では出さない。
    await expect(page.locator("#cell-names .cn")).toHaveCount(0);

    // 視野 2000m 未満まで寄る（ホイール1回ぶんでは届かないので、届くまで回す）。
    const c = await boardPoint(page, 7750, 7750);
    await page.mouse.move(c.x, c.y);
    const viewWidth = async () =>
      Number((await page.locator("#board").getAttribute("viewBox")).split(" ")[2]);
    for (let i = 0; i < 12 && (await viewWidth()) >= 1900; i += 1) {
      await page.mouse.wheel(0, -400);
    }
    expect(await viewWidth()).toBeLessThan(2000);

    const names = page.locator("#cell-names .cn");
    const count = await names.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4);
    for (const text of await names.allTextContents()) {
      expect(text).toMatch(/^[A-P](1[0-6]|[1-9])$/);
    }
  });
});

test.describe("狭い画面（390x844）", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("ガターの文字が重ならない（隣り合う矩形が交差しない）", async ({ page, context }) => {
    await openPlan(page, context, "9410", "narrowgutter");

    const cols = await labels(page, "#gutter-cols .gl");
    const rows = await labels(page, "#gutter-rows .gl");
    expect(cols.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);

    for (let i = 1; i < cols.length; i += 1) {
      expect(cols[i].x).toBeGreaterThanOrEqual(cols[i - 1].x + cols[i - 1].width);
    }
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].y).toBeGreaterThanOrEqual(rows[i - 1].y + rows[i - 1].height);
    }

    // 列の帯と行の帯も互いに重ならない（角をどちらかが譲る）。
    const colsBand = await page.locator("#gutter-cols").boundingBox();
    const rowsBand = await page.locator("#gutter-rows").boundingBox();
    const overlap =
      colsBand.x < rowsBand.x + rowsBand.width &&
      rowsBand.x < colsBand.x + colsBand.width &&
      colsBand.y < rowsBand.y + rowsBand.height &&
      rowsBand.y < colsBand.y + colsBand.height;
    expect(overlap).toBe(false);
  });

  // 以前はここに 256個のセル名が乗っていて、地図がほとんど見えなかった。
  test("地図の内側に文字が1つも乗っていない", async ({ page, context }) => {
    await openPlan(page, context, "9411", "mapvisible");

    // 390px では地図が盤面の幅いっぱいなので、行の帯は左端に少しかぶる。
    // かぶってよいのは帯の厚み（20px）までで、そこから内側は地図だけにする。
    const map = await page.locator("#map-bounds").boundingBox();
    const inset = 24;
    const over = await page.evaluate(
      (m) =>
        [...document.querySelectorAll("#gutter .gl, #cell-names .cn")]
          .filter((el) => el.offsetParent !== null)
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.right > m.x && r.left < m.x + m.width &&
              r.bottom > m.y && r.top < m.y + m.height
            );
          })
          .map((el) => el.textContent),
      { x: map.x + inset, y: map.y + inset, width: map.width - inset * 2, height: map.height - inset * 2 }
    );
    expect(over).toEqual([]);
  });
});

