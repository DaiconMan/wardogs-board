// どこからでも使う小さな道具。**ここは何も import しない**（循環を作らない）。

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * 「押しただけ」と「動かした」を分ける距離（CSS px）。
 *
 * 項目を選んでいる間、盤面のクリックが全部「置く」になっていて、マップを
 * 動かそうとして誤配置する事故が起きた。そこで押してから離すまでの移動量が
 * この値**未満**のときだけクリック（置く・選ぶ）として扱い、超えたらパン
 * （マーカーの上ならマーカーの移動）にする。
 *
 * 値を入力機器で分けているのは、同じ「押しただけ」でもぶれ方が違うため。
 * マウスは 1〜2px しかぶれないので小さめにしないと反応が鈍く感じる。指は
 * ブラウザ自身がスクロール判定に使う touch slop（Android は 8dp 前後、
 * iOS も同程度）と同じくらいぶれるので、そこに合わせないと誤配置が残る。
 */
const TAP_SLOP_PX = { mouse: 4, pen: 6, touch: 10 };
export const tapSlop = (pointerType) => TAP_SLOP_PX[pointerType] ?? TAP_SLOP_PX.mouse;
export const movedBeyond = (start, evt, slop) =>
  Math.hypot(evt.clientX - start.x, evt.clientY - start.y) > slop;
