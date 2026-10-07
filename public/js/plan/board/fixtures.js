// マップが持っている設備（ドリルタワーと陣営スポーン）。
//
// どちらもチームが置いた物ではないので、作ったあとは位置と大きさを直すだけ。

import { spawnLayer, towerLayer } from "../dom.js";
import { clearChildren } from "../render.js";
import { createSpawn, setSpawnLabelScale } from "../spawns.js";
import { state } from "../state.js";
import { createTower, setTowerTransform, towerNamesVisibleAt } from "../towers.js";
import { markerScale } from "./view.js";

// ── ドリルタワー（マップ固定の設備）──────────────────────────
// ゲームが持っている物であって、チームが置いた物ではない。位置は毎試合同じで、
// 作戦を開いた1往復（GET /api/sessions/{id} の `towers`）で降りてくる。
// 見た目と当たり判定の分け方は towers.js の冒頭に書いてある。
//
// FOB に建てる「ドリルリグ」（catalog_items.drill_rig）とは別物。
// 「その試合で戦うのはどれか」はここでは扱わない（コントロールエリアが決まれば
// 幾何で決まる。調査 §4.3）。

/** タワーを盤面に敷く。編集しないので、読み込み時に1度だけ作る。 */
export function renderTowers(towers) {
  if (!towerLayer) return;
  clearChildren(towerLayer);
  state.towers = Array.isArray(towers) ? towers : [];
  for (const t of state.towers) {
    t.node = createTower(t);
    towerLayer.appendChild(t.node);
  }
  updateTowerScale();
}

/** 塔の形と文字の大きさを画面基準に戻し、名前を出すかどうかも決め直す。 */
export function updateTowerScale() {
  if (!towerLayer) return;
  towerLayer.dataset.names = towerNamesVisibleAt(state.view?.w) ? "on" : "off";
  if (!state.coords || state.towers.length === 0) return;
  const scale = markerScale();
  for (const t of state.towers) {
    if (t.node) setTowerTransform(t.node, state.coords.toSvg(t), scale);
  }
}

/**
 * タワーの表示 on/off。
 *
 * 置く道具ではないので、地名・エリアのように「伏せたら道具から抜ける」処理は
 * 要らない（伏せても誰も何も置けなくならない）。
 */
export function setTowersVisible(on) {
  state.showTowers = on;
  // SVG 要素には HTMLElement の `hidden` プロパティが無い（属性で操作する）。
  if (on) towerLayer?.removeAttribute("hidden");
  else towerLayer?.setAttribute("hidden", "");
  document.getElementById("toggle-towers")?.setAttribute("aria-pressed", String(on));
}

// ── 陣営スポーン（セーフゾーン）────────────────────────────
// タワーと同じくマップ固定だが、**実寸（メートル）で描く**点だけが違う。
// 一辺 480m は地図の上で意味のある大きさなので、地図と同じ縮尺で伸縮させる。

/** スポーンを盤面に敷く。編集しないので読み込み時に1度だけ作る。 */
export function renderSpawns(spawns) {
  if (!spawnLayer) return;
  clearChildren(spawnLayer);
  state.spawns = [];
  for (const s of Array.isArray(spawns) ? spawns : []) {
    // 壊れた多角形は、その1件を描かないだけにする（盤面全体を落とさない）。
    const node = createSpawn(s, state.coords.toSvg);
    if (!node) continue;
    s.node = node;
    spawnLayer.appendChild(node);
    state.spawns.push(s);
  }
  updateSpawnScale();
}

/** 陣営名だけを画面基準の大きさに戻す（多角形は実寸なのでそのまま）。 */
export function updateSpawnScale() {
  if (!spawnLayer || state.spawns.length === 0) return;
  const scale = markerScale();
  for (const s of state.spawns) {
    if (s.node) setSpawnLabelScale(s.node, scale);
  }
}

/** スポーンの表示 on/off。タワーと同じ作法。 */
export function setSpawnsVisible(on) {
  state.showSpawns = on;
  if (on) spawnLayer?.removeAttribute("hidden");
  else spawnLayer?.setAttribute("hidden", "");
  document.getElementById("toggle-spawns")?.setAttribute("aria-pressed", String(on));
}
