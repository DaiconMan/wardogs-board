// コントロールエリアのプリセット（ゲームが決めた円）と、その周りの計算。
//
// EN: Control-area presets -- the circles the game decides -- and the geometry around
//     them. Each map has three or four fixed presets; one is picked by weighted random
//     at match start and then never moves. Distinct from session_areas, which is the
//     team's own hand-painted judgement.
//
// **これはチームの判断ではない。ゲームが決めた円である。**
// マップごとに 3〜4 個の固定プリセット（`ZoneAlternator.<Map>.<Name>.Circle`）が
// あり、試合開始時に重みつきランダムで1個選ばれる。選ばれた円は試合中動かない。
// その円の中に入っているドリルタワーが、その試合で戦う対象になる
// （docs/research/2026-09-29-zones-drills-data.md §2.1・§2.3・§4.3）。
//
// **`session_areas`（1km マスの手塗り）とは別物。**
// あちらは「この辺を自陣と考える」というチームの判断で、こちらはゲームの事実。
// 盤面でも見た目をはっきり分ける（マスの塗り vs 実寸の円。plan.html 参照）。
//
// 中心座標はこのファイルにも DB にも**最初から入っていない**。
// 値の出所が1サイトしか無く、そこの規約が再配布を禁じているため、
// **オーナーがゲーム画面を見て入力したものだけ**を持つ（調査 §5.3・§5.6 案4）。
//
// 単位: `*_m` はメートル（左下原点・x 右・y 上。maps.y_axis_down = 0）。
// ゲーム画面に出る数字は 1単位 = 100m なので、入出力の境目で必ず換算する。

import { GAME_UNIT_M } from "./coords.js";

/** ゲーム内座標 → メートル。画面の `75.07` は 7,507m。 */
export const gameToM = (v) => v * GAME_UNIT_M;

/** メートル → ゲーム内座標。盤面の値をゲームと同じ数字で見せるとき。 */
export const mToGame = (v) => v / GAME_UNIT_M;

/** 2点の距離（メートル）。 */
export const distanceM = (a, b) => Math.hypot(a.x_m - b.x_m, a.y_m - b.y_m);

/**
 * **円の縁ちょうど（距離 = 半径）を「中」に数えるか。**
 *
 * 数える（true）。理由は2つ。
 *   * タワー座標の確度は 0.5〜6.5m ある（schema.sql の `accuracy_m`）。
 *     1m 未満を分ける境界に意味が無い。
 *   * どちらかに決め打つなら、**目で見て円の縁に乗っているタワーを
 *     黙って対象から落とす**ほうが実害が大きい。落とすと「なぜこの塔が
 *     光らないのか」が画面から説明できなくなる。
 *
 * 定数として外に出してあるのは、テストと実装が同じ1つの決めを見るため。
 */
export const ZONE_EDGE_INCLUSIVE = true;

/** 円として成立しているか（壊れた行で盤面を落とさないための門番）。 */
const usableZone = (zone) =>
  !!zone &&
  Number.isFinite(zone.x_m) && Number.isFinite(zone.y_m) &&
  Number.isFinite(zone.radius_m) && zone.radius_m > 0;

/**
 * 円の中に入っているドリルタワー。**渡された順のまま**返す
 * （並べ替えると画面の並びが選ぶたびに変わる）。
 *
 * 円が無い・壊れているときは空配列。「プリセットを選んでいない」と
 * 「1本も入っていない」は、どちらも「光る塔が無い」で同じ見え方になる。
 */
export function towersInZone(towers, zone) {
  if (!usableZone(zone) || !Array.isArray(towers)) return [];
  return towers.filter((t) => {
    if (!Number.isFinite(t?.x_m) || !Number.isFinite(t?.y_m)) return false;
    const d = distanceM(t, zone);
    return ZONE_EDGE_INCLUSIVE ? d <= zone.radius_m : d < zone.radius_m;
  });
}

/** 同じ判定の id だけの集合。盤面の強調を付け外しするときに使う。 */
export const towerIdsInZone = (towers, zone) =>
  new Set(towersInZone(towers, zone).map((t) => t.id));

/**
 * ゲームの「座標をマーク」がチャットに流す文字列。
 *
 * 実物は `📍 x70.47, y99.03`（オーナーが実機で確認、2026-09-29）。
 * Discord に貼ったとき、ゲームから流れてきたものと同じ見た目にするために
 * **記号・空白・カンマ・小数2桁まで揃える**。
 *
 * 引数はゲーム内座標（1単位 = 100m）。メートルを渡さないこと。
 */
export const markText = ({ x, y }) => `📍 x${x.toFixed(2)}, y${y.toFixed(2)}`;

/** 「その円で戦うのは何本か」の言い方。0本のときだけ数字を出さない。 */
export const zoneCountText = (n) =>
  n > 0 ? `対象のドリルタワー ${n}本` : "対象のドリルタワー なし";

/** プリセットの見出し。表示名が無ければ識別子をそのまま出す。 */
export const zoneLabel = (preset) => preset?.name || preset?.key || "";

/**
 * プリセット1件の要約（パネルに出す1行）。
 * 重みは分かっているときだけ添える（`weight 0` は「出ない」なので意味がある）。
 */
export function zoneSummary(preset, towerCount) {
  if (!preset) return "パターンを選んでいません";
  const parts = [zoneLabel(preset), `半径 ${Math.round(preset.radius_m)}m`, zoneCountText(towerCount)];
  if (Number.isFinite(preset.weight)) parts.push(`重み ${preset.weight}`);
  return parts.join(" ／ ");
}
