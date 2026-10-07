// 1km セルの見出し（ガター）の計算。DOM は一切触らない。
//
// EN: Computes the 1 km cell headings shown in the board gutter; touches no DOM. Cell
//     names used to be scattered over the map as 256 text nodes, which collapsed into
//     unreadable runs on a 390 px phone. They now sit outside the board like the
//     margins of a nautical chart, which also means they can be plain HTML.
//
// もともとはセル名（A1〜P16）を 256個の <text> として地図の上に撒いていた。
// iPhone（390px）では文字が重なって `A10B10C10D10…` と潰れ、地図が見えなくなる。
//
// そこで海図・方眼図と同じ形にする。**地図の上から文字を退かし、盤面の縁に
// 列（A〜P）と行（1〜16）の見出しを出す。** 見出しは盤面の外にいるので、
// SVG ではなく HTML で置ける（viewBox からの font-size の逆算が要らない）。
//
// ここで決めるのは3つだけ。
//   * 見出しを何セルおきに出すか（狭くて重なるなら間引く）
//   * 帯（ガター）をどこに置くか（地図の縁に沿わせ、縁が画面の外なら盤面の縁で止める）
//   * 寄ったときだけ出す「セルの真ん中の名前」（最大4個）

import { GRID_CELL_M, cellName } from "./coords.js";

/**
 * 隣り合う見出しの最小間隔（CSS px）。これより詰まるなら間引く。
 *
 * 横は文字の幅（1文字＋字送り）、縦は行の高さで決まるので別の値にする。
 * 390px の盤面に 16列が入ると 1セル 24.4px なので、どちらも間引かずに収まる。
 */
export const GUTTER_MIN_PITCH_X_PX = 20;
export const GUTTER_MIN_PITCH_Y_PX = 18;

/** セルの名前を地図の上に出す寄り具合。これより広く見ているときは出さない。 */
export const CELL_NAME_VIEW_M = 2000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 何セルおきに見出しを出すか。1 / 2 / 4 / 8 … と倍々で間引く。
 *
 * 倍々にするのは、間引き方が変わったときに残る見出しが前の並びの部分集合に
 * なるため（3つおき→4つおきのように、位置が総取っ替えになるのを避ける）。
 */
export function gutterStep(pitchPx, minPitchPx) {
  if (!(pitchPx > 0)) return 1;
  let step = 1;
  while (pitchPx * step < minPitchPx) step *= 2;
  return step;
}

/**
 * 1軸ぶんの見出しの位置。
 *
 * `scale` は「メートル → px」の倍率、`offset` はマップの 0m が来る px。
 * 返すのは「出してよい範囲 `lo`〜`hi` に入ったものだけ」で、画面の外に
 * 出た見出しは最初から作らない。
 */
export function gutterTicks({ count, cellM, scale, offset, lo, hi, minPitch }) {
  const step = gutterStep(cellM * scale, minPitch);
  const out = [];
  for (let index = 0; index < count; index += step) {
    const pos = (index + 0.5) * cellM * scale + offset;
    if (pos >= lo && pos <= hi) out.push({ index, pos });
  }
  return out;
}

/**
 * 列の帯と行の帯の置き場所。座標はすべて同じ入れ物の左上からの px。
 *
 * `map` は地図の四辺、`board` は盤面（見えている窓）の四辺。
 * 地図の縁が画面の外に出たら盤面の縁で止める（寄っていても見出しが消えない）。
 * 角は列の帯のものとし、行の帯のほうを下げる。**見出しの位置は動かさない**
 * （ずらすと行と帯の対応が崩れて、見出しの意味そのものが無くなる）。
 */
export function gutterLayout(map, board, bandH, bandW) {
  const colsTop = clamp(map.y0 - bandH, board.y0, Math.max(board.y0, board.y1 - bandH));
  const colsLeft = Math.max(map.x0, board.x0);
  const colsRight = Math.min(map.x1, board.x1);

  const rowsLeft = clamp(map.x0 - bandW, board.x0, Math.max(board.x0, board.x1 - bandW));
  const rowsBottom = Math.min(map.y1, board.y1);
  let rowsTop = Math.max(map.y0, board.y0);
  const sideBySide = rowsLeft < colsRight && rowsLeft + bandW > colsLeft;
  if (sideBySide) rowsTop = Math.max(rowsTop, colsTop + bandH);

  return {
    cols: { left: colsLeft, right: colsRight, top: colsTop, height: bandH },
    rows: { top: rowsTop, bottom: rowsBottom, left: rowsLeft, width: bandW },
  };
}

/**
 * 寄ったときだけ地図の上に出す、セルの名前。
 *
 * **セルの真ん中が視野に入っているものだけ**を返す。セルの間隔は 1000m
 * なので、視野が 2000m 未満なら1辺に最大2つしか入らない。つまり返る数は
 * 必ず4個以下になり、昔のように文字が地図を埋めることが構造的に起きない。
 */
export function centerCells(view, cols, rows, cellM = GRID_CELL_M, maxViewM = CELL_NAME_VIEW_M) {
  if (!(view.w < maxViewM)) return [];
  const out = [];
  const range = (pos, size, count) => {
    const first = Math.max(0, Math.ceil((pos - cellM / 2) / cellM));
    const last = Math.min(count - 1, Math.floor((pos + size - cellM / 2) / cellM));
    return [first, last];
  };
  const [c0, c1] = range(view.x, view.w, cols);
  const [r0, r1] = range(view.y, view.h, rows);
  for (let col = c0; col <= c1; col += 1) {
    for (let row = r0; row <= r1; row += 1) {
      out.push({
        col, row,
        x: (col + 0.5) * cellM,
        y: (row + 0.5) * cellM,
        // 行番号は下から数える（ゲームのマップ画面の縦軸が下 1・上 16）。
        name: cellName(col, row, rows),
      });
    }
  }
  return out;
}
