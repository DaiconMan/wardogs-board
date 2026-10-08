// エリア（自陣・敵陣・中立・最重要・危険予測）の塗り。
//
// 計算（集合・外周・ラベルの位置）は ../areas.js。ここは操作と描き替え。

import { deleteArea, postAreas } from "../api.js";
import {
  AREA_KINDS, AREA_NAME_PX, AREA_NAME_VIEW_M, PATTERN_PX, areaLabel, buildAreaSets, cellAtSvg,
  countText, edgePathData, fillPathData, hasCell, labelAnchor, normalizeRect, rectSize,
  rectText,
} from "../areas.js";
import { say } from "../chrome.js";
import { GRID_CELL_M } from "../coords.js";
import { SVG_NS, areaLayer, board, narrowQuery, readoutEl, zoneCountsEl } from "../dom.js";
import { dropDone, record, recordReplay } from "../history.js";
import { DEFAULT_MODE, history, state } from "../state.js";
import { movedBeyond, tapSlop } from "../util.js";
import { clearPick, setZonePanelOpen } from "./drawers.js";
import { setMode } from "./tools.js";
import { metersPerPx, readoutPaint, userAt } from "./view.js";

// ── エリア（自陣・敵陣・中立・最重要・危険予測）───────────────────
// オーナーの要望「自分の陣営、ゾーン、ほっとぞーん…がかかれないので、どこに攻める
// とかどこから攻められそうとかわかりにくい」に対する面の表現（設計書 §3-A-1）。
//
// **ここで塗るのはチームの見立てだけ。** ゲームが決めるもの（コントロールエリアの
// 円・ホットゾーン）は renderZonePreset() が実寸の円で描く実データで、手では描かない。
// 種類の名前がゲームの用語と衝突していたので、チームの語彙に貼り替えてある
// （control → key「最重要」／ hot → risk「危険予測」）。
//
// 形はゲーム内と同じ 1km セルの集合。データは「1ジェスチャ = 1行」の追記型で、
// 画面側は id の昇順に op を適用して集合を作り直す（計算は areas.js）。
// 1ジェスチャが1行なので、**取り消し1回でそのひと塗りが完全に戻る**。

/** 1km グリッドの寸法。列・行の数は coords.js が数えたものを使う。 */
const areaGrid = () => ({
  cols: state.coords.cols, rows: state.coords.rows, cellM: GRID_CELL_M,
});

/**
 * 種類ごとの <g> と中身。塗りと外周は plan.html に静的に置いてあるので引くだけ。
 * 種類名（<text>）だけは、塗ってあるときに作って、消えたら外す
 * （空の文字要素を地図の上に置きっぱなしにしない）。
 */
const areaNodes = new Map(AREA_KINDS.map(({ kind }) => {
  const group = areaLayer?.querySelector(`.area[data-kind="${kind}"]`) ?? null;
  return [kind, group && {
    group,
    fill: group.querySelector(".area-fill"),
    halo: group.querySelector(".area-halo"),
    edge: group.querySelector(".area-edge"),
    name: null,
  }];
}));

/** 塗りパターン。applyView がタイルの一辺を画面基準に書き換える。 */
const areaPatterns = [...document.querySelectorAll("#board defs pattern[data-area-pattern]")];

/**
 * 行が増減したときだけ呼ぶ。集合を作り直して盤面とパネルを合わせる。
 * 256セル × 5種なので毎回フル再計算で足りる（ズーム・パンでは呼ばない）。
 */
export function refreshAreas() {
  if (!state.coords) return;
  state.areaSets = buildAreaSets(state.areas, areaGrid());
  renderAreas();
  if (zoneCountsEl) zoneCountsEl.textContent = countText(state.areaSets);
}

/** 種類ごとに、塗り・外周・種類名を今の集合に合わせる。 */
function renderAreas() {
  const grid = areaGrid();
  for (const { kind, label } of AREA_KINDS) {
    const node = areaNodes.get(kind);
    if (!node) continue;
    const set = state.areaSets.get(kind) ?? new Set();
    node.fill.setAttribute("d", fillPathData(set, grid));
    // 縁とその下敷きは同じ形（下敷きは太さだけが違う）。
    const edge = edgePathData(set, grid);
    node.halo.setAttribute("d", edge);
    node.edge.setAttribute("d", edge);
    const at = labelAnchor(set, grid);
    if (at) {
      if (!node.name) {
        node.name = document.createElementNS(SVG_NS, "text");
        node.name.setAttribute("class", "area-name");
        node.group.appendChild(node.name);
      }
      node.name.textContent = label;
      node.name.setAttribute("x", at.x);
      node.name.setAttribute("y", at.y);
    } else if (node.name) {
      node.name.remove();
      node.name = null;
    }
    // 何マス塗ってあるかを DOM にも出す（数えるとき・テストのため）。
    node.group.dataset.cells = String(set.size);
  }
  updateAreaScale();
}

/**
 * パターンと種類名を画面基準の大きさに戻す。
 *
 * SVG の `<pattern>` は自動では画面固定にならない。タイルの一辺を
 * `PATTERN_PX × metersPerPx()` に書き換えると、寄っても斜線の間隔が
 * 画面上で一定のままになる（マーカーの scale を打ち消すのと同じ手口）。
 */
export function updateAreaScale() {
  if (!areaLayer || !state.view) return;
  const mpp = metersPerPx() || state.view.w / 900;
  for (const pat of areaPatterns) {
    pat.setAttribute("width", PATTERN_PX * mpp);
    pat.setAttribute("height", PATTERN_PX * mpp);
  }
  // 寄ったら種類名は消す（色とパターンで分かるので、文字は邪魔になるだけ）。
  areaLayer.dataset.names = state.view.w > AREA_NAME_VIEW_M ? "on" : "off";
  for (const { kind } of AREA_KINDS) {
    areaNodes.get(kind)?.name?.setAttribute("font-size", AREA_NAME_PX * mpp);
  }
}

function markZoneKind() {
  for (const b of document.querySelectorAll("#zone-kinds button")) {
    b.setAttribute("aria-pressed", String(b.dataset.kind === state.zoneKind));
  }
}

/** 種類の選択を外す。既定の道具に戻すかどうかは呼ぶ側が決める（clearPick と同じ形）。 */
export function clearZoneKind() {
  if (state.zoneKind === null) return;
  state.zoneKind = null;
  state.zoneErase = false;
  markZoneKind();
}

/**
 * エリアの種類を選ぶ／外す。もう一度押す・Esc で外れる（pickItem と同じ挙動）。
 * 建造物の選択とは排他にする（盤面を押したときの意味は常に1つだけ）。
 */
export function setZoneKind(kind) {
  if (state.zoneKind === kind) {
    clearZoneKind();
    setMode(DEFAULT_MODE);
    say("エリアの選択を外しました。移動に戻ります。");
    return;
  }
  clearPick();
  // 見えない所に塗らせない（地名を置く道具と同じ決まり）。
  if (!state.showAreas) setAreasVisible(true);
  // 消しゴムを選んだまま種類を選んだときは、その意味（消す）を引き継ぐ。
  state.zoneErase = state.mode === "eraser" || (state.mode === "zone" && state.zoneErase);
  state.zoneKind = kind;
  markZoneKind();
  setMode("zone");
  // 狭い画面では、選んだ直後に「塗りたい場所」がパネル自身に隠れている。
  if (narrowQuery.matches) setZonePanelOpen(false);
  say(state.zoneErase
    ? `${areaLabel(kind)} を消します。ドラッグした範囲が消えます。`
    : `${areaLabel(kind)} を選びました。マップをドラッグすると 1km のマス目で塗ります。`);
}

/**
 * エリアの表示 on/off。伏せたら塗る道具からも抜ける
 * （見えない所に物が増える状態を作らない。地名と同じ決まり）。
 */
export function setAreasVisible(on) {
  state.showAreas = on;
  // SVG 要素には HTMLElement の `hidden` プロパティが無い（属性で操作する）。
  if (on) areaLayer.removeAttribute("hidden");
  else areaLayer.setAttribute("hidden", "");
  document.getElementById("toggle-areas")?.setAttribute("aria-pressed", String(on));
  if (!on && state.mode === "zone") { clearZoneKind(); setMode(DEFAULT_MODE); }
}

/** ポインタの下のセル。マップの外なら null（丸めない）。 */
function cellAtPointer(evt) {
  const p = userAt(evt.clientX, evt.clientY);
  return cellAtSvg({ x: p.x, y: p.y }, areaGrid());
}

/**
 * 塗り始める。**押した瞬間からプレビュー枠を出す。**
 *
 * D-028 が禁じたのは「ドラッグしたら取り消し困難な複数オブジェクトができる」こと
 * であって、ドラッグそのものではない。離す前に結果（枠と「3×2 = 6マス」）が
 * 見えていて、できるものが1行なので、あの事故とは別物になる。
 */
export function beginPaint(evt) {
  const cell = cellAtPointer(evt);
  if (!cell) { say("マップの外です。マップの上から塗ってください。"); return; }
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("class", "area-preview");
  areaLayer.appendChild(rect);
  state.paint = {
    from: cell, to: cell, rect,
    start: { x: evt.clientX, y: evt.clientY },
    slop: tapSlop(evt.pointerType),
  };
  drawPaintPreview();
  board.setPointerCapture(evt.pointerId);
}

export function paintMove(evt) {
  // マップの外へ出たぶんは直前のセルで止める（縁に貼り付けるのではなく、
  // 最後に通った中のセルまでを塗る）。
  const cell = cellAtPointer(evt);
  if (cell) state.paint.to = cell;
  drawPaintPreview();
}

/** プレビューの枠と「3×2 = 6マス」を今の矩形に合わせる。 */
function drawPaintPreview() {
  const { from, to, rect } = state.paint;
  const box = normalizeRect(from, to);
  const [c0, r0, c1, r1] = box;
  rect.setAttribute("x", c0 * GRID_CELL_M);
  rect.setAttribute("y", r0 * GRID_CELL_M);
  rect.setAttribute("width", (c1 - c0 + 1) * GRID_CELL_M);
  rect.setAttribute("height", (r1 - r0 + 1) * GRID_CELL_M);
  if (!readoutPaint) return;
  readoutPaint.textContent = rectText(box);
  // マップの外へ出ても、何マス塗ろうとしているかは見えていないといけない。
  readoutEl.hidden = false;
}

/** 塗りかけを捨てる（2本目の指が触れたとき、pointercancel）。 */
export function cancelPaint() {
  if (!state.paint) return;
  state.paint.rect.remove();
  state.paint = null;
  if (readoutPaint) readoutPaint.textContent = "";
}

/**
 * 離したときの確定。1ジェスチャ = 1行。
 *   * 閾値未満（押しただけ）… そのセル1つのトグル。同じ種類で既に塗ってあれば消す
 *   * 閾値以上（引いた）  … 矩形。「消しゴム」を選んでいれば消す
 */
export function endPaint(p, evt) {
  const kind = state.zoneKind;
  if (!kind) return;
  const moved = movedBeyond(p.start, evt, p.slop);
  const rect = normalizeRect(p.from, moved ? p.to : p.from);
  const op = state.zoneErase ? "sub"
    : moved ? "add"
      : hasCell(state.areaSets, kind, rect[0], rect[1], areaGrid()) ? "sub" : "add";
  commitArea(kind, op, [rect]);
}

/**
 * ひと塗りを1行として保存する。楽観更新で、断られたら取り除いて理由を出す
 * （配置・地名とまったく同じ流れ）。**塗る経路とやり直しの経路が共有する実体。**
 *
 * `rects` が複数になりうるのはやり直しのときだけ（1ジェスチャは常に矩形1つだが、
 * 保存した行をそのまま作り直すので、行が持っている形に合わせる）。
 * `cellM` も行から来る（いまは 1km 固定だが、保存した値を書き換えない）。
 *
 * 戻り値は作った行、保存できなければ null。
 */
export async function commitArea(kind, op, rects, { replay = false, cellM = GRID_CELL_M } = {}) {
  const row = {
    id: null, kind, op, cell_m: cellM, rects: rects.map((r) => [...r]),
    created_by: state.me.user.id,
  };
  state.areas.push(row);
  refreshAreas();
  // 取り消しの台帳に、線・配置・地名と同じ列へ操作した順で載せる。
  const entry = { area: row };
  if (replay) recordReplay(history(), entry);
  else record(history(), entry);

  row.saving = postAreas(state.plan.session.id, [{
    client_uuid: crypto.randomUUID(),
    kind, op, cell_m: cellM, rects: row.rects,
  }]).then((res) => { row.id = res.ids[0]; return res.ids[0]; });

  try {
    await row.saving;
    // 保存を待つ間に取り消されていたら、その結果の表示を上書きしない。
    if (!state.areas.includes(row)) return null;
    if (!replay) {
      const { cells } = rectSize(row.rects[0]);
      say(op === "sub"
        ? `${areaLabel(kind)} を ${cells}マス 消しました。`
        : `${areaLabel(kind)} を ${cells}マス 塗りました。`);
    }
    return row;
  } catch (e) {
    removeArea(row);
    if (!replay) {
      say(`${op === "sub" ? "消せませんでした" : "塗れませんでした"}。${e.message}`, true);
    }
    return null;
  }
}

function removeArea(row) {
  const i = state.areas.indexOf(row);
  if (i !== -1) state.areas.splice(i, 1);
  // 取り消しの台帳からも外す。残すと、消えたものをもう一度消しにいく。
  dropDone(history(), (e) => e.area === row);
  refreshAreas();
}

/**
 * 直前のひと塗りを取り消す（配置・地名の取り消しとまったく同じ流れ）。
 * **戻せたら true。** 台帳の出し入れは呼ぶ側（board/history.js）がする。
 */
export async function undoArea(entry) {
  const row = entry.area;
  let id;
  try {
    id = row.id ?? (await row.saving);
  } catch {
    // 保存自体が失敗していた行。もう画面に無いので取り消しは済んだ扱い。
    removeArea(row);
    say("取り消しました。");
    return true;
  }

  try {
    await deleteArea(state.plan.session.id, id);
    removeArea(row);
    say("取り消しました。");
    return true;
  } catch (e) {
    say(`取り消せませんでした。${e.message}`, true);
    return false;
  }
}
