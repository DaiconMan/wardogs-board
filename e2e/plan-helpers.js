// /plan（作戦プランナー）の UIテスト用ヘルパー。
//
// 叩くのは e2e 専用のインスタンス（8832。e2e/config.js）。認証は Discord ログイン
// （mock）なので、public/ をそのまま配信したサーバでよい。
// **かつてはノート専用のサーバ（8821）がもう1本あった**（議論欄の人間確認の
// サイトキーをテスト用に差し替えたコピーを配信していた）。`/` の配信と議論欄の
// API を畳んだときに廃止した。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@playwright/test";

import { SESSION_COOKIE, STATE_COOKIE } from "../functions/_lib/session.js";
import {
  GUEST_QUERY, GUEST_STORAGE_KEY, newGuestId,
} from "../public/js/plan/guest.js";
import { containView, coverView, viewBoxString } from "../public/js/plan/viewport.js";
import { execD1In } from "../testlib/d1-direct.js";
import { connect } from "../tools/ws-min.mjs";

import { PLAN_PERSIST, PLAN_PORT } from "./config.js";

export const PLAN_BASE_URL = `http://127.0.0.1:${PLAN_PORT}`;
export const planUrl = (path) => `${PLAN_BASE_URL}${path}`;

/**
 * APIResponse から Set-Cookie を1件1行の配列で取り出す。
 * `headers()` のカンマ結合文字列に正規表現をかけると、Cookie 名の接頭辞を
 * 取りこぼした別名を静かに組み立ててしまうので、名前の完全一致で照合する。
 * 実装によって複数の Set-Cookie が1エントリに改行で詰められることがあるため、
 * 改行でも割っておく。
 */
function setCookieLines(res) {
  const lines = [];
  for (const header of res.headersArray()) {
    if (header.name.toLowerCase() !== "set-cookie") continue;
    for (const line of header.value.split("\n")) {
      if (line.trim()) lines.push(line.trim());
    }
  }
  return lines;
}

/**
 * Cookie を API 経由で取得してブラウザコンテキストに入れる。
 * 実際の Discord 認可画面は人間の操作が必要なので通らないため、
 * `DISCORD_API_BASE=mock` + `ALLOW_DEBUG=1` のモック経路を使う。
 *
 * 発行される Cookie は `Secure` 付きだが、ブラウザ側は http://127.0.0.1 で
 * 動くので `secure: false` で入れ直す（127.0.0.1 は信頼できるオリジン扱いだが、
 * 取り回しを単純にするため明示する）。
 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 稼働中の e2e サーバと同じ D1（ローカル persist）へ直接 SQL を流す。
 *
 * API を増やさずに「管理者だけができること」を試すために要る（UI から
 * 権限を上げる導線は、作ると本番でも作ることになるので作らない）。
 *
 * 中身は `testlib/d1-direct.js`（vitest と共用。**`wrangler d1 execute` を起動しない**
 * 理由と経緯はあちらのヘッダに書いてある）。ここは e2e 側の persist
 * （`.wrangler/e2e-plan-state`。vitest とは別物）を**絶対パス**で渡すだけ。
 * Playwright の cwd に依存させないため、リポジトリ直下から組み立てる。
 * 挙動は e2e/plan-execd1.spec.js が見張る。
 */
export const execD1 = (sql) => execD1In(join(ROOT, PLAN_PERSIST), sql);

/**
 * テスト用のユーザーでログインする。
 *
 * **`discordId` は e2e 全体で一意にすること。** D1 はファイルをまたいで
 * 共有され、作戦も消えないので、番号がぶつかると他のファイルが作った作戦が
 * 自分のユーザーに見える。空いている帯は `e2e/config.js` の採番表を見る。
 *
 * `avatar` はアイコンの hash（32桁の16進）。**`code` に混ぜず別のクエリ**で
 * 渡す（`<username>` が `-` を含みうるため）。渡さなければ NULL ＝
 * 「Discord の既定アイコンの人」で、画面は色の丸のままになる。
 */
export async function loginViaApi(context, discordId, username, { avatar = null } = {}) {
  const state = `teststate-${discordId}`;
  const res = await context.request.get(
    planUrl(
      `/api/auth/discord/callback` +
        `?code=mock-${discordId}-${encodeURIComponent(username)}&state=${state}` +
        (avatar ? `&avatar=${encodeURIComponent(avatar)}` : "")
    ),
    { headers: { cookie: `${STATE_COOKIE}=${state}` }, maxRedirects: 0 }
  );

  const found = setCookieLines(res).find(
    (c) => c.slice(0, c.indexOf("=")).trim() === SESSION_COOKIE
  );
  if (!found) {
    throw new Error(
      `ログインに失敗した: status=${res.status()} set-cookie=${JSON.stringify(setCookieLines(res))}`
    );
  }
  const value = found.slice(found.indexOf("=") + 1).split(";")[0];

  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  return value;
}

/**
 * ブラウザを立てずにログインして、Cookie 1行（`wb_session=...`）を返す。
 *
 * **在室の「その他大勢」を作るための道具。** `loginViaApi` と同じ mock 経路を
 * 叩くが、`BrowserContext` を要求しない。
 *
 * 実測（2026-10-02、`e2e/tmp-probe.spec.js` で計測）: 在室8人のテストは
 * 7人ぶんの `browser.newContext()` + `/plan?id=` の読み込み + `close()` で
 * **13.9 秒**かかっていて、内訳は goto 4.8s / context の後片付け 3.6s /
 * 盤面の描画待ち 1.3s。**7人は盤面を見る必要が無く、部屋に居ればよい**ので、
 * ページを開かずに WebSocket だけ張る（`joinRoom`）。
 */
export async function loginHeadless(discordId, username, { avatar = null } = {}) {
  const state = `teststate-${discordId}`;
  const res = await fetch(
    planUrl(
      `/api/auth/discord/callback` +
        `?code=mock-${discordId}-${encodeURIComponent(username)}&state=${state}` +
        (avatar ? `&avatar=${encodeURIComponent(avatar)}` : "")
    ),
    { headers: { cookie: `${STATE_COOKIE}=${state}` }, redirect: "manual" }
  );
  await res.arrayBuffer();  // keep-alive の接続を本文で詰まらせない
  const line = res.headers
    .getSetCookie()
    .find((c) => c.slice(0, c.indexOf("=")).trim() === SESSION_COOKIE);
  if (!line) throw new Error(`ログインに失敗した: status=${res.status}`);
  return line.split(";")[0];
}

/**
 * 作戦の部屋に WebSocket を1本だけ張る（ブラウザを使わない在室者）。
 *
 * **ページを開かないので、在室一覧に出る以外のことは何もしない。**
 * 戻り値は `tools/ws-min.mjs` の接続で、`.send()` / `.close()` /
 * `.messages`（受信したテキストの配列）が使える。
 *
 * 開いた直後に `{"t":"who"}` を送るのは本物のクライアント（presence.js）と
 * 同じ作法。ローカルでは DO → クライアントの初回送信がこちらから何か送るまで
 * 流れてこないため。
 */
export async function joinRoom(cookie, planId, { silent = false } = {}) {
  const conn = await connect(
    `ws://127.0.0.1:${PLAN_PORT}/api/sessions/${encodeURIComponent(planId)}/ws`,
    { headers: { cookie, origin: PLAN_BASE_URL } }
  );
  if (conn.status !== 101) {
    throw new Error(`部屋に入れなかった: status=${conn.status} body=${conn.body ?? ""}`);
  }
  if (!silent) conn.send(JSON.stringify({ t: "who" }));
  return conn;
}

/**
 * **ログイン無しで**作戦の部屋に WebSocket を1本だけ張る。
 *
 * ゲストの身元はクエリで渡す（ブラウザの `new WebSocket()` がヘッダを
 * 足せないため。`public/js/plan/guest.js` の `GUEST_QUERY`）。
 *
 * **ログインの往復が1回も無い**ので `joinRoom` より速い。満員の試験で
 * 50人ぶんの席を埋めるのに向く（ゲストは誰でも何個でも身元を作れる——
 * それ自体が「満員ではログイン済みを優先する」を入れた理由でもある）。
 */
export async function joinRoomAsGuest(planId, guestId = newGuestId(), { silent = false } = {}) {
  const url = `ws://127.0.0.1:${PLAN_PORT}/api/sessions/${encodeURIComponent(planId)}/ws`
    + `?${GUEST_QUERY}=${encodeURIComponent(guestId)}`;
  const conn = await connect(url, { headers: { origin: PLAN_BASE_URL } });
  if (conn.status !== 101) {
    throw new Error(`ゲストが部屋に入れなかった: status=${conn.status} body=${conn.body ?? ""}`);
  }
  if (!silent) conn.send(JSON.stringify({ t: "who" }));
  conn.guestId = guestId;
  return conn;
}

/**
 * ゲスト（ログイン無しで見る人）の身元を、ブラウザの localStorage に先に置く。
 *
 * **これを使うと名前が決め打ちできる。** 置かないと `api.js` が開いた時点で
 * 乱数を1つ作るので、同じ人が2回目に開いたときの名前を試験から知る手段が無い。
 *
 * `addInitScript` なので、**どのページを開く前でも効く**（`goto` のたびに走る）。
 */
export async function seedGuestId(context, guestId = newGuestId()) {
  await context.addInitScript(
    ([key, value]) => {
      try { localStorage.setItem(key, value); } catch { /* 塞がれている */ }
    },
    [GUEST_STORAGE_KEY, guestId]
  );
  return guestId;
}

/**
 * ペンを選ぶ。
 *
 * **盤面を開いた直後の既定は「移動」**（地図を見るつもりのドラッグが線に
 * なってはいけない。オーナー報告）。線を引くテストは必ずここを通る。
 */
export async function usePen(page) {
  const pen = page.getByRole("button", { name: "ペン" });
  await pen.click();
  await expect(pen).toHaveAttribute("aria-pressed", "true");
}

/**
 * マップ全体が見える状態にする（「全体表示」を押す）。
 *
 * **開いた直後は地図が画面を埋めている**ので、横長の画面ではマップの上下が、
 * 縦長の画面では左右が画面の外にいる。マップ座標で場所を指すテストは、
 * まずここを通して「どの地点も画面の中にある」状態を作る。
 */
export async function showWholeMap(page) {
  await page.getByRole("button", { name: "全体表示" }).click();
  await expect(page.locator("#board")).toHaveAttribute("viewBox", await fitViewBox(page));
  // 「全体表示」は棚の右端にあるので、押すと Playwright が棚を横に送る。
  // 「まだ送っていない」状態を前提にしたテストのために元へ戻す。
  await page.locator("#rail").evaluate((el) => { el.scrollLeft = 0; });
  // 押したボタンにフォーカスが残ると、以降のキー操作（`c` でのコピーなど）が
  // 「欄に文字を打っている最中」と見なされて無視される。盤面へ戻しておく。
  await page.evaluate(() => document.activeElement?.blur?.());
}

/** いま見えている範囲の幅（メートル）。viewBox の3つ目。 */
export const viewWidthM = (page) => page.locator("#board")
  .evaluate((el) => Number(el.getAttribute("viewBox").split(" ")[2]));

/**
 * ズームの補間（`ZOOM_ANIM_MS` = 150ms）が終わって viewBox が落ち着くのを待つ。
 *
 * **「拡大」「縮小」を続けて押すテストは必ずこれを挟むこと。**
 * `animateTo` は押された時点の `state.view` を起点に倍率を掛け直すので、
 * **動いている途中で次を押すと、そのぶん縮尺が目減りする。**
 *
 * 実測（2026-10-08、全体表示から8回押した）:
 *
 * | | 読んだ値 | 最終幅 |
 * |---|---|---|
 * | 待たない | `[29013, 27652, 19530, 13461, …, 2378]` | **1150** |
 * | 毎回待つ | `[29013, 18133, 11333, 7083, …, 1081]` | **676**（理論値どおり） |
 *
 * **待たないと 1.7 倍広いまま終わる。** 機械の負荷が高いほど目減りが大きく、
 * 「8回押せば 2000m を切る」という前提のテストが**負荷の高いときだけ落ちる**
 * （公開リポジトリの全件実行で `plan-towers.spec.js` が1本落ちた）。
 */
export async function settleView(page) {
  let last = -1;
  for (let i = 0; i < 25; i += 1) {
    const w = await viewWidthM(page);
    if (w === last) return w;
    last = w;
    await page.waitForTimeout(60);
  }
  return viewWidthM(page);
}

/**
 * 「表示」のメニューを開く（既に開いていれば何もしない）。
 *
 * 背景の見せ方・重ねるもの（射程 / 地名）・地図にあるもの（タワー / スポーン）は
 * **全部このメニューの中**。棚に常設するのは、よく使う5かたまりだけにしてある。
 */
export async function openViewMenu(page) {
  const menu = page.locator("#view-menu");
  if (!(await menu.evaluate((el) => el.open))) await menu.locator("> summary").click();
}

/** 「自分」のメニューを開く（共有URLのコピーとログアウトはこの中）。 */
export async function openAccountMenu(page) {
  const menu = page.locator("#account");
  if (!(await menu.evaluate((el) => el.open))) await menu.locator("> summary").click();
}

/**
 * 「公開 ▾」のメニューを開く（この作戦を誰が見られるか）。
 *
 * **作戦を作った人にしか出ない。** 他の人の画面では `#visibility` が
 * `hidden` のままなので、ここを呼ぶ前に作成者であることを確かめること。
 */
export async function openVisibilityMenu(page) {
  const menu = page.locator("#visibility");
  await expect(menu, "公開設定のメニューが出ていない").toBeVisible();
  if (!(await menu.evaluate((el) => el.open))) await menu.locator("> summary").click();
}

/**
 * 作戦（セッション）を作って id を返す。
 *
 * ページの `fetch` ではなく `context.request` を使う理由: テスト開始直後の
 * ページは about:blank なので相対 URL の fetch が投げられない。また
 * 「API が落ちる」テストでは `page.route` を張る前に作成を終えたい。
 * `/api/sessions` は Origin を検証するので明示的に付ける。
 *
 * `presetId` は「想定するパターン」（コントロールエリアのプリセット）。
 * 省略すると未設定のまま作る。**そのマップのプリセットでなければサーバが 400 を
 * 返す**ので、ここで弾かれたら map と preset の対応が間違っている。
 */
export async function createPlan(context, title, mapId = "bakurani", presetId = null) {
  const res = await context.request.post(planUrl("/api/sessions"), {
    headers: { "content-type": "application/json", origin: PLAN_BASE_URL },
    data: { map_id: mapId, title, preset_id: presetId },
  });
  if (res.status() !== 201) {
    throw new Error(`作戦の作成に失敗した: status=${res.status()} body=${await res.text()}`);
  }
  return (await res.json()).session.id;
}

/**
 * マップの一辺（メートル）。
 *
 * **マップごとに違う**（Bakurani / Ozeti 16,320m、Zestafona 16,384m）。
 * `16000` のような固定値を書くと寸法が直るたびに全ファイルを書き換えることに
 * なるので、盤面から実寸を読む。
 *
 * 読み先は背景画像の width / height。これは app.js の drawBasemap() が
 * `map.width_m` / `map.height_m` をそのまま入れたもので、**viewBox とは別の
 * 経路**なので「viewBox が正しいか」を viewBox 自身で確かめる循環にならない。
 * 背景の画像が届かなくても属性は付くので、通信を落とすテストでも使える。
 *
 * **値が入るまで待つ。** `#board` は静的な HTML なので `toBeVisible()` は
 * ページを開いた直後に通るが、`width` / `height` が入るのは `getMe` →
 * `getPlan` の2往復が終わってからで、その間は `0` のまま。0 を読んでしまうと
 * `fitViewBox()` が `"0 0 0 0"` という嘘の期待値を一度だけ作り、以後は何を
 * 待っても一致しない（`toHaveAttribute` は期待値の側を読み直さない）。
 * 実測で、モジュールが1本増えただけでこの窓に落ちて13本が落ちた。
 */
export async function mapSizeM(page) {
  const basemap = page.locator("#basemap");
  await expect
    .poll(() => basemap.evaluate((el) => Number(el.getAttribute("width"))))
    .toBeGreaterThan(0);
  return basemap.evaluate((el) => ({
    w: Number(el.getAttribute("width")),
    h: Number(el.getAttribute("height")),
  }));
}

/**
 * 盤面の縦横比（幅 ÷ 高さ）。**viewBox の形はここが決める。**
 *
 * viewBox の縦横比をマップ（正方形）に合わせていた頃は、16:9 の画面に
 * レターボックスが出て地図が画面の 42.4% しか占めていなかった。いまは
 * 画面と同じ比なので、期待値を作るにも盤面の実寸が要る。
 */
export async function boardRatio(page) {
  return page.locator("#board").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width / r.height;
  });
}

/**
 * 「全体表示」の viewBox（マップ全体が収まる、いちばん引いた状態）。
 *
 * **マップの一辺はマップごとに違う**（Bakurani / Ozeti 16,320m、
 * Zestafona 16,384m）ので、盤面から実寸を読む。計算はページと同じ
 * `viewport.js` をそのまま使う（期待値を手で書き写して食い違わせない）。
 */
export async function fitViewBox(page) {
  const { w, h } = await mapSizeM(page);
  return viewBoxString(containView({ width_m: w, height_m: h }, await boardRatio(page)));
}

/**
 * **開いた直後**の viewBox（マップが画面を埋める）。
 *
 * 「まだ動かしていない」「動かした」を見分けるのはこちら。
 * 全体表示（fitViewBox）とは別物なので、名前で取り違えないこと。
 */
export async function coverViewBox(page) {
  const { w, h } = await mapSizeM(page);
  return viewBoxString(coverView({ width_m: w, height_m: h }, await boardRatio(page)));
}

/**
 * 作戦の一覧（?id= 無しの /plan）が描き終わるのを待つ。
 *
 * 一覧は「マップ × 想定するパターン」の**枠の表**。マップと作戦の2往復が
 * 揃ってから描かれるので、`#sessions` が出るまで待ってから操作する。
 */
export async function waitForGrid(page) {
  await expect(page.locator("#sessions")).toBeVisible();
  await expect(page.locator("#sessions .s-group").first()).toBeVisible();
}

/**
 * **枠から作戦を作る**（UI 操作だけ）。
 *
 * マップもパターンも**押した枠が決める**ので、選ぶ欄は無い。要るのは題名だけ。
 * `presetId` を省くと、そのマップの最初の枠を押す（プリセットが1件も
 * 登録されていないマップでは「パターン未登録」の枠が1つ出る）。
 */
export async function createViaGrid(page, title, { mapId = "bakurani", presetId = null } = {}) {
  await waitForGrid(page);
  const group = page.locator(`#sessions .s-group[data-map-id="${mapId}"]`);
  await expect(group, `${mapId} の区画が無い`).toHaveCount(1);
  const cell = presetId
    ? group.locator(`.s-cell[data-preset-id="${presetId}"]`)
    : group.locator(".s-cell").first();
  await cell.locator("button.s-new").click();
  await page.locator("#create-title").fill(title);
  await page.getByRole("button", { name: "作戦を作る" }).click();
}

// ── 1択の欄（`<select>` の置き換え）──────────────────────────────
// `<select>` は全部やめた（`public/js/plan/choice.js` の冒頭に理由）。
// 選択肢は `role="radio"` の `<button>` なので `selectOption()` は使えない。
// **同じことを1行で書けるように、ここに置き換えを用意する。**

/** 欄の中の札（選択肢）。並び順は DOM 順。 */
export const choiceOptions = (page, id) => page.locator(`#${id} [role="radio"]`);

/**
 * 1択の欄から選ぶ。`selectOption()` の置き換え。
 *
 * @param {string} id   欄の id（`create-map` など。`#` は付けない）
 * @param {object} by   `{ value }` か `{ label }`。label は**完全一致**で探す
 *                      （部分一致にすると `Default` が `Default（全タワー）` も
 *                      拾って、どちらが選ばれたか分からなくなる）。
 */
export async function chooseOption(page, id, by) {
  const opt = by.value !== undefined
    ? page.locator(`#${id} [role="radio"][data-value="${by.value}"]`)
    : choiceOptions(page, id).filter({ hasText: new RegExp(`^${escapeRe(by.label)}$`) });
  await expect(opt, `#${id} に「${by.value ?? by.label}」の札が無い`).toHaveCount(1);
  await opt.click();
  await expect(opt).toHaveAttribute("aria-checked", "true");
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 欄がいまどの値を選んでいるか（`toHaveValue()` の置き換え）。 */
export const chosenValue = (page, id) =>
  page.locator(`#${id} [role="radio"][aria-checked="true"]`).getAttribute("data-value");

/**
 * 2色のコントラスト比（WCAG 2.x の定義）。
 *
 * 色は `getComputedStyle` が返す `rgb(...)` / `rgba(...)` の文字列で受ける。
 * **細線や板は半透明**（`--hud-line` / `--hud-raise` 系）なので、前景に alpha が
 * あれば背景の上に合成してから測る。合成しないと「白の 16:1」を測ってしまい、
 * 実際より良い値が出る。背景のほうは不透明な面を渡すこと
 * （`flatBackground()` が重ねて不透明にしてくれる）。
 */
export function contrast(fg, bg) {
  const parse = (s) => {
    const n = s.match(/[\d.]+/g).map(Number);
    return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 };
  };
  const lum = (c) => {
    const s = c.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  };
  const back = parse(bg);
  if (back.a !== 1) throw new Error(`背景が半透明では測れない: ${bg}`);
  const front = parse(fg);
  const flat = front.rgb.map((c, i) => front.a * c + (1 - front.a) * back.rgb[i]);
  const [a, b] = [lum(flat), lum(back.rgb)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
}

/**
 * その要素の文字が、**実際に重なっている面**に対して何対何で出ているか。
 *
 * `/plan` の板もボタンも半透明（`--hud` .90 / `--hud-raise` .96）なので、
 * 要素1枚の `backgroundColor` だけでは測れない。先祖を遡って不透明な面に
 * 当たるまで集め、下から順に重ねて不透明な1色にしてから測る。
 *
 * **これが `<select>` を捨てた理由そのものに効く。** ポップアップを
 * ブラウザに描かせていた間は、選択肢の文字色も背景も DOM に無く、
 * ここで測れなかった（だから実機で読めないことに気づけなかった）。
 */
export async function textContrast(loc) {
  const [fg, bg] = await loc.evaluate((el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const nums = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
      if (!nums) continue;
      const a = nums.length > 3 ? Number(nums[3]) : 1;
      if (a === 0) continue;
      layers.push([Number(nums[0]), Number(nums[1]), Number(nums[2]), a]);
      if (a === 1) break;
    }
    // いちばん下（不透明）から順に重ねる。1枚も見つからなければ白地とみなす。
    let out = layers.length ? layers[layers.length - 1].slice(0, 3) : [255, 255, 255];
    for (let i = layers.length - 2; i >= 0; i -= 1) {
      const [r, g, b, a] = layers[i];
      out = [r, g, b].map((v, k) => a * v + (1 - a) * out[k]);
    }
    const round = (v) => Math.round(v);
    return [getComputedStyle(el).color, `rgb(${out.map(round).join(", ")})`];
  });
  return contrast(fg, bg);
}

/**
 * SVG ユーザー単位（Bakurani では 1 単位 = 1m）を、マウス操作に渡せる
 * ビューポート座標に変換する。
 *
 * `boundingBox()` の左上からのオフセットで座標を決めると、viewBox の
 * preserveAspectRatio（既定 xMidYMid meet）でマップが中央寄せ・余白つきに
 * なるぶんだけずれ、マップ外の座標を送ってしまう。ページと同じ
 * `getScreenCTM()` を使って「マップ上のこの地点」を指す。
 */
export async function boardPoint(page, x, y) {
  return page.evaluate(([ux, uy]) => {
    const board = document.getElementById("board");
    const pt = board.createSVGPoint();
    pt.x = ux;
    pt.y = uy;
    const s = pt.matrixTransform(board.getScreenCTM());
    return { x: s.x, y: s.y };
  }, [x, y]);
}
