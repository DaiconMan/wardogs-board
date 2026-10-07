// 盤面の見えている範囲（= SVG の viewBox）の計算。DOM は一切触らない。
//
// ズームを `transform` のスケールでやると `vector-effect:non-scaling-stroke` と
// 噛み合わせが悪くなる（線の太さの基準が変わる）ので、viewBox そのものを
// 動かす方式にしている。viewBox の単位はメートルで、倍率は常に 1。
//
// EN: Pure computation of the visible region of the board (the SVG viewBox); touches
//     no DOM. Zooming moves the viewBox itself instead of applying a transform scale,
//     because scaling changes the reference width of
//     vector-effect:non-scaling-stroke. The viewBox aspect ratio follows the board
//     element rather than the map, so letterboxing cannot appear by construction.
//
// **viewBox の縦横比は、マップではなく「盤面（画面）」の縦横比に合わせる。**
//
// 以前はマップの縦横比に合わせていた。マップは正方形なので、16:9 の画面では
// preserveAspectRatio（既定の xMidYMid meet）が左右にレターボックスを作り、
// 1920x1080 では地図が 938x938 にしかならず、左右 490px ずつが完全な余白に
// なっていた（実測 42.4%）。画面と同じ縦横比にすると meet と slice が
// 一致するので、**レターボックスが構造的に出なくなる**。
//
// そのうえで「どこまで見せるか」を2つの関数に分ける。
//
//   containView … マップ全体が収まる（いちばん引いた状態。「全体表示」）
//   coverView   … マップが画面を埋める（開いた直後。余白が1pxも出ない）
//
// 縦横比が画面任せになっても、「カーソルの下の地点を動かさない」計算は
// 割合（fraction）で書いてあるので変わらない。

/** これ以上は寄れない（画面の幅が何メートルぶんか）。 */
export const MIN_VIEW_M = 200;

/** はみ出しを許す量（見えている幅に対する割合）。マップが画面から消えない。 */
const OVERSCROLL = 0.25;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 盤面の縦横比（幅 ÷ 高さ）。測れないときの逃げ道も1箇所に置く。 */
export const ratioOf = (rect) =>
  rect && rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1;

const mapRatio = (map) => map.width_m / map.height_m;

/**
 * マップ全体が収まる、いちばん引いた状態（「全体表示」）。
 *
 * 画面がマップより横長なら高さで決まり、縦長なら幅で決まる。
 * 余るほうの軸にはマップの外（盤面の下地）が見えるが、これは
 * **利用者が自分で引き切ったとき**にだけ起きる。
 */
export function containView(map, ratio = mapRatio(map)) {
  const wide = ratio >= mapRatio(map);
  const w = wide ? map.height_m * ratio : map.width_m;
  const h = wide ? map.height_m : map.width_m / ratio;
  return { x: (map.width_m - w) / 2, y: (map.height_m - h) / 2, w, h };
}

/**
 * マップが画面を埋める状態（開いた直後はここ）。
 *
 * 見えている範囲がまるごとマップの中に入るので、**余白が 1px も出ない**。
 * そのぶん外周は切れるが、引く手段（全体表示・ホイール・ピンチ）は
 * どれも1操作で届く。
 */
export function coverView(map, ratio = mapRatio(map)) {
  const wide = ratio >= mapRatio(map);
  const w = wide ? map.width_m : map.height_m * ratio;
  const h = wide ? map.width_m / ratio : map.height_m;
  return { x: (map.width_m - w) / 2, y: (map.height_m - h) / 2, w, h };
}

/**
 * 行き過ぎたパン・ズームを戻す。
 *
 * マップより広く見ている軸は中央に寄せる（引き切った状態でマップが端に
 * 寄っていると、余白を掴んで動かしているように見えて気持ちが悪い）。
 * 寄っている軸は、見えている幅の 1/4 までのはみ出しを許す。
 */
function clampAxis(pos, size, extent) {
  if (size >= extent) return (extent - size) / 2;
  const slack = size * OVERSCROLL;
  return clamp(pos, -slack, extent - size + slack);
}

export function clampView(view, map, ratio = mapRatio(map)) {
  // 引ける上限は「マップ全体が収まるところ」。マップの幅で頭打ちにすると、
  // 横長の画面ではマップの上下が永久に画面の外に残る。
  const w = clamp(view.w, Math.min(MIN_VIEW_M, map.width_m), containView(map, ratio).w);
  const h = w / ratio;
  return {
    x: clampAxis(view.x, w, map.width_m),
    y: clampAxis(view.y, h, map.height_m),
    w,
    h,
  };
}

/** 点が viewBox の中でどの割合の位置にいるか。レターボックス側は 0〜1 を外れる。 */
export const fractionOf = (view, point) => ({
  x: (point.x - view.x) / view.w,
  y: (point.y - view.y) / view.h,
});

/**
 * 「`anchor`（メートル）を、viewBox の中の割合 `fraction` の位置に置いたまま、
 * 見える幅を `factor` 倍する」。
 *
 * ホイールズームは anchor＝カーソルの下の地点・fraction＝カーソルの位置なので、
 * カーソルの下が動かない（GoogleMap と同じ）。パンは factor=1 の同じ計算。
 * ピンチは 2本指の中点を anchor にする。
 */
export function zoomView(view, map, { anchor, fraction, factor, ratio = mapRatio(map) }) {
  const w = clamp(view.w * factor, Math.min(MIN_VIEW_M, map.width_m), containView(map, ratio).w);
  const h = w / ratio;
  return clampView(
    { x: anchor.x - fraction.x * w, y: anchor.y - fraction.y * h, w, h },
    map,
    ratio
  );
}

/** ボタンのズーム用の補間。t=1 で必ず to そのものになる。 */
export const lerpView = (from, to, t) => ({
  x: from.x + (to.x - from.x) * t,
  y: from.y + (to.y - from.y) * t,
  w: from.w + (to.w - from.w) * t,
  h: from.h + (to.h - from.h) * t,
});

// ── 縮尺バー ───────────────────────────────────────────────
// GoogleMap の左下にあるのと同じ考え方。バーの長さを固定して「このバーは
// 137m です」と書くのではなく、**きりのいい距離を選んでバーの側を伸縮させる**。
// 137m と 200m を目で比べるのは難しいが、100m のバーが2本ぶんなら数えられる。
//
// 倍率（「×2.5」のような値）は出さない。作戦の議論で持ち出されるのは
// 「あの丘まで 400m」という距離であって、画面の倍率ではない。

/** 選べる距離。1-2-5 の刻み（目盛りとして数えやすい比になる並び）。 */
export const SCALE_STEPS_M = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

/** バーの最大の長さ（CSS px）。これ以下でいちばん大きい刻みを選ぶ。 */
export const SCALE_MAX_PX = 120;

/** 1000m 以上は km で書く。桁を減らしたほうが一目で読める。 */
export const scaleLabel = (meters) =>
  meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;

/**
 * 縮尺バーの目盛り。`metersPerPx` は「画面 1px が何メートルか」。
 *
 * 戻り値は `{ meters, px, label }` で、`px` は必ず `maxPx` 以下になる
 * （最小の刻みにも届かないほど寄ったときだけ例外的に超える。
 * MIN_VIEW_M = 200m があるので実際には起きない）。
 * 盤面がまだ測れない（mpp が 0 以下や NaN）ときは null を返す。呼ぶ側は隠す。
 */
export function scaleBar(metersPerPx, maxPx = SCALE_MAX_PX) {
  if (!Number.isFinite(metersPerPx) || metersPerPx <= 0) return null;
  const limit = metersPerPx * maxPx;
  let meters = SCALE_STEPS_M[0];
  for (const step of SCALE_STEPS_M) {
    if (step <= limit) meters = step;
  }
  return { meters, px: meters / metersPerPx, label: scaleLabel(meters) };
}

// 属性値に 15999.999999999998 のような値を出さない。
// 「全体表示」が `0 0 16000 16000` に戻ることをテストで見ているので、
// 丸めた結果が -0 になる場合も "0" に揃える。
const fmt = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

export const viewBoxString = (v) => `${fmt(v.x)} ${fmt(v.y)} ${fmt(v.w)} ${fmt(v.h)}`;
