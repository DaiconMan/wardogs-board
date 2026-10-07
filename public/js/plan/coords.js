// メートル ↔ SVG ユーザー単位の変換と、ゲーム内の座標・グリッドの呼び方。
// SVG は viewBox をメートルでそのまま張るので倍率は 1。y 軸の向きだけ吸収する。
//
// EN: Metre <-> SVG user-unit conversion, in-game coordinates and grid cell names.
//     The viewBox is laid out directly in metres, so the scale factor is always 1 and
//     only the y-axis direction has to be absorbed. In-game coordinates have their
//     origin at the bottom left (x grows right, y grows up) while SVG grows y
//     downward, so the flip happens exactly once, at draw time.
//
// **ゲーム内の座標は左下が 0,0 で、x は右・y は上に増える**
// （オーナーがゲーム内で確認、2026-09-29）。保存する y_m もこの向きに揃えてある
// （maps.y_axis_down = 0）。SVG は上が 0 なので、描くときだけ上下を反転する。
// 反転は1回だけ。toGame() で二重に反転しないこと。

/** ゲーム内座標は 1単位 = 100m（MetaForge の `x78.67 y71.62`。オーナー確認）。 */
export const GAME_UNIT_M = 100;

/**
 * ゲーム内グリッドは 1km セル（https://wardogshub.gg/map/ の A–P × 1–16）。
 *
 * マップの一辺は 16,320m / 16,384m で、ちょうど 16km ではない。
 * よって 16 セルぶん（16,000m）の外側に 320〜384m の余りが出る。
 * ゲームが「1km セルを16個並べて端が余る」としているのか
 * 「一辺を16分割している」のかは未確認（調査 §7.1 Z-2）。ここでは前者を採る。
 */
export const GRID_CELL_M = 1000;

const COL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * 0 始まりの列・行から `A1`〜`P16` の呼び方を作る。
 *
 * **行番号は下が 1。** ゲームのマップ画面の縦軸が下 1・上 16 になっている
 * （オーナーがゲーム内で確認、2026-09-29）。`row` は SVG 座標の行（常に上が 0）
 * なので、総行数から引いて下から数え直す。
 *
 * ここが逆だと、Discord で「D8」と言った場所と画面の「D8」が食い違う。
 * 配置がずれるより誤解を招くので、必ず `rows` を渡すこと。
 */
export const cellName = (col, row, rows) => `${colName(col)}${rows - row}`;

/** 列だけの呼び方（`A`〜`P`）。盤面の縁のガターの見出しに使う。 */
export const colName = (col) => COL_LETTERS[col] ?? "?";

export function makeCoords(map) {
  const height = map.height_m;
  const flip = !map.y_axis_down;
  // マップの一辺はちょうどの km ではない（16,320 / 16,320 / 16,384m）。
  // **丸ごと入るセルだけを数える**（端の 320〜384m はどのセルにも属さない）。
  // サーバ側（functions/api/sessions/[id]/areas.js の resolveCell）と同じ
  // 数え方でなければならない。ずれると端のセルだけ保存に失敗する。
  const cols = Math.max(1, Math.floor(map.width_m / GRID_CELL_M));
  const rows = Math.max(1, Math.floor(map.height_m / GRID_CELL_M));

  const toSvg = ({ x_m, y_m }) => ({ x: x_m, y: flip ? height - y_m : y_m });
  const toMeters = ({ x, y }) => ({ x_m: x, y_m: flip ? height - y : y });

  return {
    toSvg,
    toMeters,
    viewBoxAll() {
      return `0 0 ${map.width_m} ${map.height_m}`;
    },
    /**
     * ゲーム内の座標表示（`x70.01 y100.31`）と同じ数字。単位換算だけで済む。
     *
     * **ここで上下を反転しない。** 保存している y_m はゲームと同じ左下原点なので、
     * 100 で割るだけでゲームの表示に一致する。反転するのは SVG へ描くときだけ
     * （toSvg）。両方で反転すると元に戻ってしまう。
     *
     * 裏取り: Zestafona の Tower 3（x_m 7017.3 / y_m 10017.2）に対して
     * ゲームは x70.01 y100.31 と出す。
     */
    toGame({ x_m, y_m }) {
      return { x: x_m / GAME_UNIT_M, y: y_m / GAME_UNIT_M };
    },
    /** その地点のセル名（`H8` など）。マップの外なら null。行は下から数える。 */
    cellOf(point) {
      const s = toSvg(point);
      const col = Math.floor(s.x / GRID_CELL_M);
      const row = Math.floor(s.y / GRID_CELL_M);
      if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
      return cellName(col, row, rows);
    },
    cols,
    rows,
  };
}
