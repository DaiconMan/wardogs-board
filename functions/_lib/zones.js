// コントロールエリアのプリセット（ゲームが決めた円）の既定値と検証。
//
// EN: Defaults and validation for control-area presets, the circles the game decides.
//     Input arrives in in-game coordinates (1 unit = 100 m) because the owner types
//     the numbers shown on the game screen; the conversion to metres happens here.
//     Making a human convert to metres turns an off-by-one-digit mistake into "a
//     circle in an impossible place" instead of "that is outside the map".
//
// **入力はゲーム内座標（1単位 = 100m）で受け取る。**
// オーナーはゲーム画面に出ている数字（`75.07`）をそのまま打つ。メートルへの
// 換算はここでやる。人にメートルへ直させると、桁を1つ間違えたときに
// 「マップの外です」ではなく「ありえない場所に円が出る」形で失敗する。
//
// 出典: docs/research/2026-09-29-zones-drills-data.md §3.1（半径）・§2.1（重み）。

import { isFiniteNumber } from "./validate.js";

/** ゲーム内座標の1単位（m）。coords.js の GAME_UNIT_M と同じ値。 */
export const GAME_UNIT_M = 100;

/**
 * マップごとのコントロールエリアの半径（m）。**Ozeti だけ 550m。**
 *
 * 調査 §3.1: ネイティブ画像のピクセル半径 × m/px が
 * 500.0 / 550.0 / 500.0 になり、文章側の「Radius: 500 metres」
 * 「a 550-metre circle」とも独立に一致する。
 *
 * ここが唯一の持ち主。クライアントはこの値を API 越しに受け取る
 * （同じ数字を2箇所に書かない）。
 */
export const DEFAULT_RADIUS_M = { bakurani: 500, ozeti: 550, zestafona: 500 };

/** 知らないマップは 500m（3マップ中2マップの値）。 */
export const defaultRadiusM = (mapId) => DEFAULT_RADIUS_M[mapId] ?? 500;

/** 半径の許す幅。ホットゾーン（85m）より小さい円と、マップ半分を超える円は拒む。 */
export const MIN_RADIUS_M = 50;
export const MAX_RADIUS_M = 3000;

/** 識別子は英数字と `_-` だけ。ゲーム内のタグ名の一部（`Default`）をそのまま使う。 */
const KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const NAME_MAX = 40;
const TAG_MAX = 120;
const SOURCE_MAX = 400;

/** プリセットの id。`bakurani-default`。key の大文字小文字では別物にしない。 */
export const presetId = (mapId, key) => `${mapId}-${key.toLowerCase()}`;

export function keyError(raw) {
  if (typeof raw !== "string") return "プリセットの識別子が文字列ではありません";
  const t = raw.trim();
  if (!KEY_RE.test(t)) {
    return "プリセットの識別子は英数字と - _ だけ、32文字までです";
  }
  return null;
}

/**
 * 中心の座標。**ゲーム内座標で受け取り、メートルで返す。**
 * 範囲外は丸めない（placements と同じ方針。黙って縁に貼り付けない）。
 */
export function centreOf(x, y, map) {
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    return { error: "中心の座標が数値ではありません" };
  }
  const x_m = x * GAME_UNIT_M;
  const y_m = y * GAME_UNIT_M;
  if (x_m < 0 || y_m < 0 || x_m > map.width_m || y_m > map.height_m) {
    return {
      error:
        `中心がマップの範囲外です（x は 0〜${(map.width_m / GAME_UNIT_M).toFixed(2)}、` +
        `y は 0〜${(map.height_m / GAME_UNIT_M).toFixed(2)}）`,
    };
  }
  return { x_m, y_m };
}

export function radiusError(raw) {
  if (!isFiniteNumber(raw)) return "半径が数値ではありません";
  if (raw < MIN_RADIUS_M || raw > MAX_RADIUS_M) {
    return `半径は${MIN_RADIUS_M}〜${MAX_RADIUS_M}mです`;
  }
  return null;
}

/**
 * 重みは省略可（分からないなら入れない）。
 * **0 は通す。**「定義はあるが選ばれない」という意味のある値だから（調査 §2.1）。
 */
export function weightOf(raw) {
  if (raw === undefined || raw === null) return { weight: null };
  if (!isFiniteNumber(raw) || raw < 0) return { error: "重みは0以上の数値です" };
  return { weight: raw };
}

/** 任意の短い文字列（表示名・タグ・出典）。空文字は「無し」に倒す。 */
export function optionalText(raw, max, what) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== "string") return { error: `${what}の形式が不正です` };
  const t = raw.trim();
  if (!t) return { value: null };
  if ([...t].length > max) return { error: `${what}は${max}文字までです` };
  return { value: t };
}

export const NAME_LIMIT = NAME_MAX;
export const TAG_LIMIT = TAG_MAX;
export const SOURCE_LIMIT = SOURCE_MAX;

/**
 * 出典の既定文。
 *
 * この入力口は「オーナーがゲーム画面の数字を見て打つ」ためだけに作ってある
 * （他に値の入手経路が無い。調査 §5.3）。だから既定は**実機で読んだ**ことを
 * 明記する。誰が入れたかも残す。あとから「この数字はどこから来たのか」を
 * 追えない行を作らない。
 */
export const defaultSource = (userName, userId) =>
  `オーナーが実機のゲーム画面で計測し、管理画面から入力（${userName ?? "不明"} / ${userId}）`;

/** API が返す1件の形。x_m/y_m（メートル）と x/y（ゲーム内座標）の両方を出す。 */
export const toApi = (row) => ({
  id: row.id,
  map_id: row.map_id,
  key: row.key,
  name: row.name,
  tag: row.tag,
  x_m: row.x_m,
  y_m: row.y_m,
  x: row.x_m / GAME_UNIT_M,
  y: row.y_m / GAME_UNIT_M,
  radius_m: row.radius_m,
  weight: row.weight,
  source: row.source,
  measured_at: row.measured_at,
  patch: row.patch,
  verified: row.verified,
  sort_order: row.sort_order,
  created_by: row.created_by,
});
