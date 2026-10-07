// 地図の上の線と、盤面の縁の見出し。
//
// 1km グリッド・100m の補助線・マップの縁・セル名のガター・寄ったときのセル名。

import { GRID_CELL_M, colName } from "../coords.js";
import {
  SVG_NS, board, cellNamesEl, fineLayer, gridLayer, gutterColsEl, gutterRowsEl, mainEl,
  zonesLayer,
} from "../dom.js";
import {
  GUTTER_MIN_PITCH_X_PX, GUTTER_MIN_PITCH_Y_PX, centerCells, gutterLayout, gutterTicks,
} from "../gutter.js";
import { clearChildren } from "../render.js";
import { state } from "../state.js";

/** 補助線の間隔と、それを出し始める視野の広さ。広いうちは出さない（潰れる）。 */
const FINE_STEP_M = 100;
const FINE_VISIBLE_W_M = 4000;

/**
 * セル名のガター（盤面の縁の見出し）の帯の厚み（CSS px）。
 *
 * ここが唯一の持ち主で、CSS（縮尺と座標表示の逃がし先）へは
 * `--gut-h` / `--gut-w` として渡す。2箇所に数値を書かない。
 */
const GUTTER_BAND_H_PX = 16;
const GUTTER_BAND_W_PX = 20;

/** 見出しが帯の端で切れないよう、端から空けておく量（CSS px）。 */
const GUTTER_EDGE_PAD_PX = { x: 9, y: 6 };

function addLine(layer, x1, y1, x2, y2) {
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", x1); line.setAttribute("y1", y1);
  line.setAttribute("x2", x2); line.setAttribute("y2", y2);
  layer.appendChild(line);
}

/**
 * ゲーム内と同じ 1km グリッド（A–P × 1–16 の 256セル）。
 *
 * 1km ごとに線を引く（16,320m なら 1000〜16000 の 16本 × 2方向 = 32本）。
 * いちばん外側の縁は #map-bounds が描いているので、重ねて引かない。
 * **マップの一辺はちょうどの km ではない**ので、最後の線（16000m）と
 * 縁（16320m）の間に 320m の余りが残る。そこはどのセルにも属さない。
 *
 * 行番号は**下が 1**（ゲームのマップ画面の縦軸と同じ。coords.js の cellName）。
 *
 * セル名そのものは地図の上には描かない。盤面の縁のガター（HTML）に出す。
 */
export function drawGrid(map) {
  clearChildren(gridLayer);
  clearChildren(fineLayer);
  fineKey = null;

  for (let x = GRID_CELL_M; x < map.width_m - 0.5; x += GRID_CELL_M) {
    addLine(gridLayer, x, 0, x, map.height_m);
  }
  for (let y = GRID_CELL_M; y < map.height_m - 0.5; y += GRID_CELL_M) {
    addLine(gridLayer, 0, y, map.width_m, y);
  }

  buildGutter(map);
}

// マップの縁。盤面は画面いっぱいだがマップは中央に収まるので、
// 縁が見えないと「どこから先がマップ外か」が分からない。
export function drawBounds(map) {
  clearChildren(zonesLayer);
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("id", "map-bounds");
  rect.setAttribute("x", 0);
  rect.setAttribute("y", 0);
  rect.setAttribute("width", map.width_m);
  rect.setAttribute("height", map.height_m);
  rect.setAttribute("fill", "none");
  zonesLayer.appendChild(rect);
}

// ── セル名のガター（盤面の縁の見出し）────────────────────────────
// 以前は 256個の <text> を地図の上に撒いていた。iPhone（390px）では文字が
// 重なって `A10B10C10D10…` と潰れ、地図がほとんど見えなかった。
//
// 地図の上から文字を退かし、盤面の縁に列（A〜P）と行（1〜16）の見出しを出す。
// HTML なので盤面のズームの影響を受けず、font-size をメートルに逆算する
// 計算も要らない。要素は列＋行の 32個だけで、位置だけを毎回付け替える。

/** 見出しの札を列・行のぶんだけ作る。中身が変わらないので1度だけ。 */
function buildGutter(map) {
  const cells = { cols: [], rows: [] };
  const build = (parent, count, text) => {
    clearChildren(parent);
    const nodes = [];
    for (let i = 0; i < count; i += 1) {
      const el = document.createElement("span");
      el.className = "gl";
      el.textContent = text(i);
      parent.appendChild(el);
      nodes.push(el);
    }
    return nodes;
  };
  // 列・行の数え方は1箇所（coords.js）に任せる。ここで数え直すと、端の
  // 余り（マップの一辺はちょうどの km ではない）の扱いが食い違う。
  const { cols, rows } = state.coords;
  cells.cols = build(gutterColsEl, cols, colName);
  // 行の見出しは**下が 1**。札は上から順に作るので、番号は逆から振る
  // （ゲームのマップ画面の縦軸が下 1・上 16。オーナー確認 2026-09-29）。
  cells.rows = build(gutterRowsEl, rows, (i) => String(rows - i));
  gutterNodes = cells;

  // 縮尺（左下・狭い画面では左上）と座標表示が帯に重ならないよう、
  // 帯の厚みを CSS へ渡す。数値の持ち主はこのファイル1箇所だけにする。
  mainEl.style.setProperty("--gut-h", `${GUTTER_BAND_H_PX}px`);
  mainEl.style.setProperty("--gut-w", `${GUTTER_BAND_W_PX}px`);
}

let gutterNodes = { cols: [], rows: [] };

/**
 * ガターと、寄ったときのセル名を今の視野に合わせる。
 *
 * 位置は getScreenCTM（= 盤面が実際に画面のどこに何倍で出ているか）から
 * 取る。viewBox とレターボックスを自前で計算し直さずに済む。
 */
export function updateGutter() {
  const ctm = board.getScreenCTM();
  const mainRect = mainEl.getBoundingClientRect();
  const boardRect = board.getBoundingClientRect();
  if (!ctm || !(boardRect.width > 0)) return;

  const { map } = state.plan;
  const scale = ctm.a;
  const offX = ctm.e - mainRect.left;
  const offY = ctm.f - mainRect.top;
  const layout = gutterLayout(
    { x0: offX, x1: map.width_m * scale + offX, y0: offY, y1: map.height_m * scale + offY },
    {
      x0: boardRect.left - mainRect.left, x1: boardRect.right - mainRect.left,
      y0: boardRect.top - mainRect.top, y1: boardRect.bottom - mainRect.top,
    },
    GUTTER_BAND_H_PX, GUTTER_BAND_W_PX
  );

  placeBand(gutterColsEl, gutterNodes.cols, {
    band: layout.cols,
    lo: layout.cols.left + GUTTER_EDGE_PAD_PX.x,
    hi: layout.cols.right - GUTTER_EDGE_PAD_PX.x,
    origin: layout.cols.left,
    minPitch: GUTTER_MIN_PITCH_X_PX,
    scale, offset: offX, axis: "x",
    style: {
      left: `${layout.cols.left}px`, top: `${layout.cols.top}px`,
      width: `${Math.max(0, layout.cols.right - layout.cols.left)}px`,
      height: `${layout.cols.height}px`,
    },
  });
  placeBand(gutterRowsEl, gutterNodes.rows, {
    band: layout.rows,
    lo: layout.rows.top + GUTTER_EDGE_PAD_PX.y,
    hi: layout.rows.bottom - GUTTER_EDGE_PAD_PX.y,
    origin: layout.rows.top,
    minPitch: GUTTER_MIN_PITCH_Y_PX,
    scale, offset: offY, axis: "y",
    style: {
      left: `${layout.rows.left}px`, top: `${layout.rows.top}px`,
      width: `${layout.rows.width}px`,
      height: `${Math.max(0, layout.rows.bottom - layout.rows.top)}px`,
    },
  });

  updateCellNames(scale, offX, offY);
}

/** 帯1本ぶん。見えるものだけ位置を付け、残りは畳む（作り直さない）。 */
function placeBand(bandEl, nodes, opt) {
  Object.assign(bandEl.style, opt.style);
  bandEl.hidden = !(opt.hi > opt.lo);
  if (bandEl.hidden) return;

  const ticks = gutterTicks({
    count: nodes.length, cellM: GRID_CELL_M,
    scale: opt.scale, offset: opt.offset,
    lo: opt.lo, hi: opt.hi, minPitch: opt.minPitch,
  });
  for (const node of nodes) node.hidden = true;
  for (const tick of ticks) {
    const node = nodes[tick.index];
    node.hidden = false;
    // 帯の中での位置にする（帯ごと動かしても札は付いてくる）。
    node.style[opt.axis === "x" ? "left" : "top"] = `${tick.pos - opt.origin}px`;
  }
}

/** 寄ったときだけ、真ん中が見えているセルの名前を薄く出す（最大4個）。 */
function updateCellNames(scale, offX, offY) {
  const cells = centerCells(state.view, state.coords.cols, state.coords.rows);
  const key = cells.map((c) => c.name).join(" ");
  if (key !== cellNamesKey) {
    cellNamesKey = key;
    clearChildren(cellNamesEl);
    for (const cell of cells) {
      const el = document.createElement("span");
      el.className = "cn";
      el.textContent = cell.name;
      cellNamesEl.appendChild(el);
    }
  }
  cellNamesEl.childNodes.forEach((el, i) => {
    el.style.left = `${cells[i].x * scale + offX}px`;
    el.style.top = `${cells[i].y * scale + offY}px`;
  });
}

let cellNamesKey = "";

// 直前に描いた補助線の範囲。同じなら描き直さない（パン中に毎フレーム
// 100本前後の要素を作り直すのは無駄）。
let fineKey = null;

/** 寄ったときだけ 100m の補助線を出す。画面に入っている範囲だけ描く。 */
export function drawFineGrid() {
  const { map } = state.plan;
  const v = state.view;
  const on = v.w <= FINE_VISIBLE_W_M;
  const x0 = Math.max(0, Math.floor(v.x / FINE_STEP_M) * FINE_STEP_M);
  const x1 = Math.min(map.width_m, Math.ceil((v.x + v.w) / FINE_STEP_M) * FINE_STEP_M);
  const y0 = Math.max(0, Math.floor(v.y / FINE_STEP_M) * FINE_STEP_M);
  const y1 = Math.min(map.height_m, Math.ceil((v.y + v.h) / FINE_STEP_M) * FINE_STEP_M);

  const key = on ? `${x0} ${x1} ${y0} ${y1}` : "off";
  if (key === fineKey) return;
  fineKey = key;
  clearChildren(fineLayer);
  if (!on) return;

  for (let x = x0; x <= x1 + 0.5; x += FINE_STEP_M) {
    if (Math.round(x) % GRID_CELL_M !== 0) addLine(fineLayer, x, y0, x, y1);
  }
  for (let y = y0; y <= y1 + 0.5; y += FINE_STEP_M) {
    if (Math.round(y) % GRID_CELL_M !== 0) addLine(fineLayer, x0, y, x1, y);
  }
}
