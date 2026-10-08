// 範囲選択の枠の計算。**ここは何も import しない**（DOM も触らない）。
//
// EN: Geometry for the marquee (rubber-band) selection. Imports nothing and touches
//     no DOM, so vitest can check it directly. Hit testing is point-in-rectangle
//     because markers and callout dots are screen-sized, not map-sized.
//
// オーナーの要望（D-062）: 「マップにおけるアイテムが小さい場合、再度選択するのが
// つらいですね。Powerpoint みたいに範囲選択して削除とかできるといいなと。」
//
// **当たり判定は「点が矩形の中にあるか」。形には合わせない。**
// マーカー（`.pm`）も地名の点（`.co`）も**画面基準の大きさ**（`markerScale()` で
// ズームを打ち消している）なので、形で判定すると**寄り方によって選べるものが変わる。**
// 同じ所を囲ったのに結果が違う、という形でいちばん分かりにくく壊れる。
//
// 枠に入れるのは**配置と地名だけ**（v1）。線は消しゴムが、エリアは塗りの取り消しがある。

/** 2つの角（メートル）から、向きを揃えた矩形を作る。 */
export function normalizeBox(a, b) {
  return {
    x0: Math.min(a.x_m, b.x_m),
    y0: Math.min(a.y_m, b.y_m),
    x1: Math.max(a.x_m, b.x_m),
    y1: Math.max(a.y_m, b.y_m),
  };
}

/**
 * その地点が枠の中にあるか。**縁ちょうどは「中」に数える。**
 * コントロールエリアの円（`zones.js` の `towersInZone`）と同じ約束にする。
 * 片方だけ違うと「同じ所を囲ったのに結果が違う」が起きる。
 */
export const boxContains = (box, { x_m, y_m }) =>
  x_m >= box.x0 && x_m <= box.x1 && y_m >= box.y0 && y_m <= box.y1;

/** 枠の中のものを、入れ物の並び順のまま拾う。 */
export const pickInBox = (items, box) => items.filter((o) => boxContains(box, o));

/**
 * 自分のものだけを抜き出す。
 *
 * **他人のものはサーバが 403 を返す**（admin は例外）。
 * **UI を「押せるのに 403 になる」形にしない**ので、操作する前にここで分ける。
 * 枠に入った他人のものは薄く出して、対象外だと見えるようにする（画面側）。
 */
export const mineOf = (items, canEdit) => items.filter((o) => canEdit(o));

/**
 * 件数の文言。
 *
 * **他人のものが混ざっているときは内訳を出す。** 「7件を選択」とだけ出して
 * 4件しか消えないと、3件が消えなかったことに気づけない。
 * 全部が自分のものなら内訳は出さない（同じ数を2回言わない）。
 */
export function selectionText(total, mine) {
  if (total <= 0) return "";
  if (total === mine) return `${total}件を選択`;
  return `${total}件を選択（うち自分のもの ${mine}件）`;
}
