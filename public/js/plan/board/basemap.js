// 背景の地図（全体画像と詳細タイル、そして見せ方のフィルタ）。
//
// EN: The background map: the overview image, the detail tiles and the display filter.
//     Map images are not part of this repository. When they are absent the board is
//     drawn with nothing behind it and everything else keeps working — but that only
//     holds because every <image> here hides itself when the load fails. See
//     hideIfBroken() for why "it just 404s and nothing is drawn" is not true for free.

import { SVG_NS, basemapEl, basemapLayer, board, darkQuery, tileLayer } from "../dom.js";
import { BASEMAP_DEFAULT, state } from "../state.js";
import { clamp } from "../util.js";

/** 背景地図の見せ方。既定はモノクロ（インクが地形に埋もれないため）。 */
const BASEMAP_MODES = ["color", "mono", "posterize"];

const BASEMAP_KEY = "wardogs.plan.basemap";
/** 畳んだメニューのボタンに「いま何か」を出すための表示名。 */
const BASEMAP_LABELS = { color: "カラー", mono: "モノクロ", posterize: "高コントラスト" };

/**
 * 届かなかった `<image>` を隠す。
 *
 * **「無ければ何も描かれない」は、黙っていては成り立たない。**
 * SVG の `<image>` は読み込みに失敗すると、Chromium が**壊れた画像のアイコンを
 * 要素の大きさいっぱいに描く**。背景はマップの実寸（16km 四方）で張るので、
 * **画面全部がそのアイコンになる。** タイルも同じで、寄ると格子状に並ぶ。
 * マップ画像を置いていない環境では、それが「地図」に見えてしまう。
 *
 * 実測（2026-10-07、Chromium）: **404 でも、通信断でも、200 で画像以外が
 * 返ってきても、同じ絵になる。** `wrangler pages dev` と Cloudflare Pages は
 * 無いパスに index.html を 200 で返すので、「404 だから安全」は成り立たない。
 *
 * **`display` ではなく `visibility` で隠す。** `display:none` にすると
 * `getBoundingClientRect()` が 0 になり、「地図が画面を埋めているか」を
 * その矩形で測っている試験（e2e/plan-layout.spec.js）が壊れる。
 * ここで欲しいのは「見えないが、そこにある」。
 *
 * EN: Hides an <image> whose load failed. A failed SVG <image> is not blank in
 *     Chromium: it paints the broken-image placeholder across the element's full
 *     box, and this element is the size of the whole map. Measured the same for a
 *     404, an aborted request, and a 200 carrying non-image bytes — and Pages
 *     answers unknown paths with index.html at 200, so "it 404s" is not a defence.
 *     Hidden via `visibility`, not `display`, so the layout box survives for the
 *     tests that measure how much of the screen the map covers.
 */
function hideIfBroken(img) {
  img.addEventListener("error", () => { img.style.visibility = "hidden"; });
  img.addEventListener("load", () => { img.style.visibility = ""; });
}

hideIfBroken(basemapEl);

/** 背景の地図。無ければ何も描かれないだけで、他は普通に動く（hideIfBroken 参照）。 */
export function drawBasemap(map) {
  basemapEl.setAttribute("x", 0);
  basemapEl.setAttribute("y", 0);
  basemapEl.setAttribute("width", map.width_m);
  basemapEl.setAttribute("height", map.height_m);
  // マップを替えたら、前のマップで失敗したぶんの「隠し」を戻す。
  // 戻さないと、画像のあるマップに切り替えても背景が出ないままになる。
  basemapEl.style.visibility = "";
  // 2048x2048 の正方形でマップ全体（0〜16000m）を覆う。歪まないので
  // preserveAspectRatio は既定（xMidYMid meet）のままでよい。
  basemapEl.setAttribute("href", `/map/overview/${map.id}.webp`);
  for (const node of tileNodes.values()) node.remove();
  tileNodes.clear();
  tileKey = null;
}

// ── 詳細タイル ───────────────────────────────────────────────
// public/map/tiles/<map>/<z>/<y>/<x>.webp（512px、z は 0〜5、y が先で x が後）。
// z のタイル1枚は 16000/2^z メートル四方で、原点はマップの左上。
// 届かなかったタイルは何も描かれないだけで、下の overview が見える。
const TILE_PX = 512;
const TILE_MAX_Z = 5;
const tileNodes = new Map();   // "z/y/x" -> <image>
let tileKey = null;

export function drawTiles() {
  const { map } = state.plan;
  // タイルは正方形・2のべき乗の格子を前提にしている。違うマップでは
  // overview だけで見せる（座標がずれた背景を出すよりは粗いほうがよい）。
  if (map.width_m !== map.height_m) return;

  const rect = board.getBoundingClientRect();
  const scale = rect.width > 0 && rect.height > 0
    ? Math.min(rect.width / state.view.w, rect.height / state.view.h) : 0;
  // 512px のタイルが画面でだいたい等倍になる z を選ぶ。
  const z = scale > 0
    ? clamp(Math.ceil(Math.log2((map.width_m * scale) / TILE_PX)), 0, TILE_MAX_Z) : 0;

  const count = 2 ** z;
  const span = map.width_m / count;
  const v = state.view;
  const x0 = clamp(Math.floor(v.x / span), 0, count - 1);
  const x1 = clamp(Math.floor((v.x + v.w) / span), 0, count - 1);
  const y0 = clamp(Math.floor(v.y / span), 0, count - 1);
  const y1 = clamp(Math.floor((v.y + v.h) / span), 0, count - 1);

  const key = `${map.id} ${z} ${x0} ${x1} ${y0} ${y1}`;
  if (key === tileKey) return;
  tileKey = key;

  const wanted = new Set();
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const id = `${z}/${y}/${x}`;
      wanted.add(id);
      if (tileNodes.has(id)) continue;
      const img = document.createElementNS(SVG_NS, "image");
      img.setAttribute("x", x * span);
      img.setAttribute("y", y * span);
      img.setAttribute("width", span);
      img.setAttribute("height", span);
      img.setAttribute("href", `/map/tiles/${map.id}/${id}.webp`);
      hideIfBroken(img);
      tileLayer.appendChild(img);
      tileNodes.set(id, img);
    }
  }
  for (const [id, node] of tileNodes) {
    if (wanted.has(id)) continue;
    node.remove();
    tileNodes.delete(id);
  }
}

export function applyBasemapMode() {
  const dark = darkQuery.matches;
  const filter =
    state.basemap === "mono" ? `url(#map-mono${dark ? "-dark" : ""})`
      : state.basemap === "posterize" ? `url(#map-posterize${dark ? "-dark" : ""})`
        : "none";
  // overview とタイルをまとめた <g> にかける。2層に同じように効き、
  // かつ二重にかからない（個々の <image> には付けない）。
  basemapLayer.setAttribute("filter", filter);
  for (const b of document.querySelectorAll("#basemap-modes button")) {
    b.setAttribute("aria-pressed", String(b.dataset.basemap === state.basemap));
  }
  // 畳んでいる間も今の設定が読めるようにする（隠したぶん、状態は外に出す）。
  const current = document.getElementById("basemap-current");
  if (current) current.textContent = BASEMAP_LABELS[state.basemap] ?? state.basemap;
}

export function setBasemapMode(mode) {
  state.basemap = BASEMAP_MODES.includes(mode) ? mode : BASEMAP_DEFAULT;
  applyBasemapMode();
  // 保存できない（プライベートモード等）としても、表示は切り替わったままでよい。
  try { localStorage.setItem(BASEMAP_KEY, state.basemap); } catch { /* 覚えないだけ */ }
}

export function loadBasemapMode() {
  try { return localStorage.getItem(BASEMAP_KEY) ?? BASEMAP_DEFAULT; } catch { return BASEMAP_DEFAULT; }
}
