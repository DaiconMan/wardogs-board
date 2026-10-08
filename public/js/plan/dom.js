// /plan の画面にある要素と、配色・入力機器の問い合わせ。
//
// EN: The elements on the /plan page, plus the colour-scheme and input-device media
//     queries. Every getElementById call is collected here so that renaming an id in
//     plan.html cannot leave a stale lookup somewhere else.
//
// **getElementById をここ1箇所にまとめる。** 同じ id を別のファイルで引き直すと、
// plan.html の id を変えたときに直し漏れる場所ができる。
// <script type="module"> は解析のあとに走るので、読み込み時に引いてよい。

export const SVG_NS = "http://www.w3.org/2000/svg";

export const board = document.getElementById("board");
export const inkLayer = document.getElementById("ink");
// 他の人が**引いている最中**の線。D1 に無いものだけが入る（board/liveink.js）。
export const liveInkLayer = document.getElementById("live-ink");
export const rangeLayer = document.getElementById("ranges");
// ホットゾーンの円は射程とは別の層。「射程を表示」で一緒に消えてはいけない
// （これは射程ではなく、人数が2倍に数えられる範囲）。
export const hotzoneLayer = document.getElementById("hotzones");
export const placeLayer = document.getElementById("placements");
// スタンプ（図形・向きを持つ印・軍用記号）と、引いている最中のプレビュー。
export const stampLayer = document.getElementById("stamps");
export const stampDraftLayer = document.getElementById("stamp-draft");
export const calloutLayer = document.getElementById("callouts");
// 他の人のカーソル。**マップ座標系に置く**ので、パンとズームに自動で追従する。
export const cursorLayer = document.getElementById("cursor-layer");
export const bandLayer = document.getElementById("select-band");
export const towerLayer = document.getElementById("towers");
export const spawnLayer = document.getElementById("spawns");
export const paletteEl = document.getElementById("palette");
export const stampPanelEl = document.getElementById("stamppanel");
export const detailEl = document.getElementById("placement-detail");
export const gridLayer = document.getElementById("grid");
export const fineLayer = document.getElementById("grid-fine");
export const mainEl = document.querySelector("main");
export const gutterColsEl = document.getElementById("gutter-cols");
export const gutterRowsEl = document.getElementById("gutter-rows");
export const cellNamesEl = document.getElementById("cell-names");
export const zonesLayer = document.getElementById("zones");
export const areaLayer = document.getElementById("areas");
export const zonePanelEl = document.getElementById("zonepanel");
export const zoneCountsEl = document.getElementById("zone-counts");
export const basemapLayer = document.getElementById("basemap-layer");
export const basemapEl = document.getElementById("basemap");
export const tileLayer = document.getElementById("basemap-tiles");
export const readoutEl = document.getElementById("readout");
export const scalebarEl = document.getElementById("scalebar");
export const statusEl = document.getElementById("status");
export const toolsEl = document.getElementById("tools");
export const railEl = document.getElementById("rail");
export const viewMenu = document.getElementById("view-menu");
export const accountMenu = document.getElementById("account");
// この作戦の公開設定（作った人にだけ出る）と、書き込めない人に出す札。
export const visibilityMenu = document.getElementById("visibility");
export const visibilityChoiceEl = document.getElementById("visibility-choice");
export const visibilityValueEl = document.getElementById("visibility-current");
export const visibilityNoteEl = document.getElementById("visibility-note");
export const readOnlyBadge = document.getElementById("read-only");
export const headerEl = document.querySelector("header");
export const footerEl = toolsEl;
export const widthsEl = document.getElementById("widths");
export const scaleWrapEl = document.getElementById("scale-wrap");

export const darkQuery = matchMedia("(prefers-color-scheme: dark)");
export const reducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");

export const zonePresetLayer = document.getElementById("zone-preset");
export const zonePresetInfo = document.getElementById("zone-preset-info");
export const zoneAdminEl = document.getElementById("zone-admin");

export const zpInputs = {
  key: document.getElementById("zp-key"),
  x: document.getElementById("zp-x"),
  y: document.getElementById("zp-y"),
  radius: document.getElementById("zp-radius"),
  weight: document.getElementById("zp-weight"),
  tag: document.getElementById("zp-tag"),
};

/**
 * 狭い画面かどうか。plan.html の `@media (max-width:560px)` と同じ境目。
 * ここを超えるとパレットは左の引き出しではなく、盤面の上半分を覆う板になる。
 */
export const narrowQuery = matchMedia("(max-width:560px)");
