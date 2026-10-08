// 見える範囲（viewBox）と、そこから決まるもの。
//
// ズーム・パン・ピンチ、画面とメートルの変換、縮尺、座標表示、座標のコピー。
// 「画面1px が何メートルか」（metersPerPx）はここが持ち主で、
// マーカー・地名・塔・円・エリアはそれを使って画面基準の大きさに戻す。

import { say } from "../chrome.js";
import { board, readoutEl, reducedMotionQuery, scaleWrapEl, scalebarEl } from "../dom.js";
import { state } from "../state.js";
import { clamp } from "../util.js";
import {
  clampView, containView, fractionOf, lerpView, ratioOf, scaleBar, viewBoxString, zoomView,
} from "../viewport.js";
import { markText } from "../zones.js";
import { updateAreaScale } from "./area.js";
import { drawTiles } from "./basemap.js";
import { updateCalloutScale } from "./callout.js";
import { updateCursorScale } from "./cursor.js";
import { updateSpawnScale, updateTowerScale } from "./fixtures.js";
import { drawFineGrid, updateGutter } from "./grid.js";
import { updateMarkerScale } from "./place.js";
import { updateStampScale } from "./stamp.js";
import { updateZoneScale } from "./zone.js";

/** ボタンのズームの倍率と、アニメーションの長さ。 */
export const ZOOM_BUTTON_FACTOR = 1.6;
const ZOOM_ANIM_MS = 150;

/**
 * 「画面 1px が SVG ユーザー単位（= メートル）で何ぶんか」。
 *
 * viewBox の縦横比はマップと同じに保たれている（viewport.js）ので、
 * preserveAspectRatio の効き方は x と y で同じ。0 を返すのは盤面がまだ
 * 測れないとき（表示前など）で、呼び出し側が代わりの値を決める。
 */
export function metersPerPx() {
  const rect = board.getBoundingClientRect();
  const { w, h } = state.view;
  if (!(rect.width > 0 && rect.height > 0)) return 0;
  return 1 / Math.min(rect.width / w, rect.height / h);
}

/** マーカーの縮尺。盤面がまだ測れないときも「点」にしない。 */
export const markerScale = () => {
  const mpp = metersPerPx();
  return mpp > 0 ? mpp : state.view.w / 900;
};

// 画面の座標を SVG ユーザー単位（= メートル、y の向きだけ別）に直す。
// getBoundingClientRect からの手計算は viewBox の比率が効くとずれるので
// getScreenCTM を使う。ズームしても自動的に正しい値になる。
export function userAt(clientX, clientY) {
  const pt = board.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  return pt.matrixTransform(board.getScreenCTM().inverse());
}

// ポインタの位置をメートルで返す。丸めはしない。
export function pointerToMeters(evt) {
  const p = userAt(evt.clientX, evt.clientY);
  return state.coords.toMeters({ x: p.x, y: p.y });
}

// 盤面（svg 要素）はビューポートいっぱいだが、マップは preserveAspectRatio で
// 中央に収まるので、左右（または上下）にマップ外の余白ができる。
// 判定と丸めは SVG ユーザー単位ではなくメートルで行う。ズームを入れると
// 両者は一致しなくなるため。
export const insideMap = ({ x_m, y_m }) => {
  const { map } = state.plan;
  return x_m >= 0 && x_m <= map.width_m && y_m >= 0 && y_m <= map.height_m;
};

export const clampToMap = ({ x_m, y_m }) => {
  const { map } = state.plan;
  return { x_m: clamp(x_m, 0, map.width_m), y_m: clamp(y_m, 0, map.height_m) };
};

// ── 見える範囲（ズーム・パン）─────────────────────────────────
// viewBox を直接動かす。transform のスケールでやると
// vector-effect:non-scaling-stroke と噛み合わせが悪くなる。

export function applyView() {
  board.setAttribute("viewBox", viewBoxString(state.view));
  updateGutter();
  updateMarkerScale();
  updateCalloutScale();
  updateStampScale();
  updateTowerScale();
  updateSpawnScale();
  updateZoneScale();
  updateAreaScale();
  // 他の人のカーソルもマーカーと同じ逆スケールで画面上の大きさを一定に保つ
  // （ズーム時の更新経路を新設せず、ここに相乗りする）。
  updateCursorScale();
  updateScaleBar();
  drawFineGrid();
  drawTiles();
}

// ── 縮尺（スケールバー）────────────────────────────────────
// バーの長さを決め打ちにせず、きりのいい距離（100m / 200m / 500m / 1km …）を
// 選んで長さのほうを伸縮させる（GoogleMap と同じ）。計算は viewport.js。
const scalebarBar = scalebarEl?.querySelector(".bar") ?? null;
const scalebarLabel = scalebarEl?.querySelector(".label") ?? null;

function updateScaleBar() {
  if (!scalebarEl) return;
  const bar = scaleBar(metersPerPx());
  // 盤面がまだ測れないとき（表示前など）は出さない。出鱈目な縮尺を出すより、
  // 何も出ていないほうが誤解が無い。「未検証」の印も一緒に伏せる
  // （縮尺が出ていないなら、その未検証を言う相手もいない）。
  if (!bar) { if (scaleWrapEl) scaleWrapEl.hidden = true; return; }
  scalebarBar.style.width = `${bar.px}px`;
  scalebarLabel.textContent = bar.label;
  // 図形と数字が別々に読み上げられても意味を成さないので、1つの文にまとめる。
  scalebarEl.setAttribute("aria-label", `縮尺 ${bar.label}`);
  if (scaleWrapEl) scaleWrapEl.hidden = false;
}

/**
 * 盤面の縦横比。**viewBox の形はここが決める。**
 *
 * マップの縦横比に合わせていた頃は、正方形のマップが 16:9 の画面に対して
 * 左右へレターボックスを作り、地図が画面の 42.4% しか占めていなかった。
 * 画面と同じ比にすれば余白は構造的に出ない（viewport.js の冒頭）。
 */
export const boardRatio = () => ratioOf(board.getBoundingClientRect());

export function setView(next) {
  state.view = clampView(next, state.plan.map, boardRatio());
  applyView();
}

export function stopAnim() {
  if (state.anim === null) return;
  cancelAnimationFrame(state.anim);
  state.anim = null;
}

/**
 * `anchor`（メートル）を画面上の `client` の位置に置いたまま、視野を factor 倍する。
 * ホイールズームは anchor＝カーソルの下の地点なので、カーソルの下が動かない。
 * パンは factor=1 の同じ計算（掴んだ地点が指から離れない）。
 */
export function gestureTo(anchor, client, factor) {
  const fraction = fractionOf(state.view, userAt(client.x, client.y));
  setView(zoomView(state.view, state.plan.map, {
    anchor, fraction, factor, ratio: boardRatio(),
  }));
}

/**
 * ボタンのズーム。画面の中心を軸にする。
 * prefers-reduced-motion のときは補間せず一息で移す。
 */
function animateTo(target) {
  stopAnim();
  if (reducedMotionQuery.matches) { setView(target); return; }
  const from = state.view;
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / ZOOM_ANIM_MS);
    setView(t >= 1 ? target : lerpView(from, target, t * (2 - t)));
    state.anim = t >= 1 ? null : requestAnimationFrame(step);
  };
  state.anim = requestAnimationFrame(step);
}

/**
 * ボタン1押しぶんのズーム。画面の中心を軸にする。
 *
 * ── 既知の不具合（D-076。**未対応**）─────────────────────────
 * **連打すると、押した回数ぶん拡大できない。**
 *
 * 倍率を掛ける起点が `state.view` ＝ **いま画面に出ている viewBox** なので、
 * 補間（`ZOOM_ANIM_MS` = 150ms）の途中で次を押すと、`stopAnim()` が
 * 動きを止めて**中途半端な値を起点に**掛け直す。速く押すほど目減りする。
 *
 * 実測（2026-10-08。全体表示から8回押した。Bakurani 16,320m）:
 *
 * | 押し方 | 1回ごとに読んだ幅 | 最終の幅 |
 * |---|---|---|
 * | 補間を待たずに連打 | `29013, 27652, 19530, 13461, …, 2378` | **1150m** |
 * | 1回ごとに落ち着くまで待つ | `29013, 18133, 11333, 7083, …, 1081` | **676m**（理論値） |
 *
 * **連打すると 1.7 倍広いまま終わる。** 8回押したのに 6回ぶんも進んでいない。
 *
 * 地図の UI は普通**補間の行き先に積む**（いまの見た目ではなく、アニメーションが
 * 向かっている先を起点に次の倍率を掛ける）。そうすれば連打しても
 * 押した回数ぶん正確に効く。**直すならそこ**（`state.anim` が走っている間の
 * 目標値を覚えておき、`zoomByButton` はそちらを起点にする）。
 *
 * **人は待ってくれない。** テスト側は `e2e/plan-helpers.js` の `settleView()` で
 * 待つようにしたが、あれは試験を安定させるためのもので、**この不具合の対策ではない。**
 */
export function zoomByButton(factor) {
  if (!state.view) return;
  const center = { x: state.view.x + state.view.w / 2, y: state.view.y + state.view.h / 2 };
  const fraction = { x: 0.5, y: 0.5 };
  animateTo(zoomView(state.view, state.plan.map, {
    anchor: center, fraction, factor, ratio: boardRatio(),
  }));
}

/** 「全体表示」。マップ全体が収まるところまで引く（いちばん引いた状態）。 */
export function showAll() {
  if (!state.view) return;
  animateTo(containView(state.plan.map, boardRatio()));
}

export function startPinch() {
  const [a, b] = [...state.pointers.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  state.pinch = { anchor: userAt(mid.x, mid.y), dist: Math.hypot(a.x - b.x, a.y - b.y) };
}

// 2本指は「パン＋ピンチズーム」。中点の下にある地点を動かさないまま、
// 指の間隔の変化ぶんだけ視野を広げ／狭める。
export function movePinch() {
  const [a, b] = [...state.pointers.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const factor = dist > 4 && state.pinch.dist > 4 ? state.pinch.dist / dist : 1;
  state.pinch.dist = dist;
  gestureTo(state.pinch.anchor, mid, factor);
}

// ── 座標表示 ────────────────────────────────────────────────
// ゲーム画面と同じ `x78.67 y71.62`（1単位 = 100m）。**これが主役。**
//
// チーム内の会話は地名や目印で行われていて、座標は「正確に伝えるための道具」。
// しかも**ゲームはセル名（A1〜P16）を表示しない**（軸に出るのは km の数字だけ。
// オーナーが実機で確認、2026-09-29）。ゲーム画面と突き合わせられるのは座標の
// ほうなので、座標を大きく、セル名は小さく添えるだけにする。
// 並べ替え（CSS の order）はもう使っていない — DOM の順がそのまま見た目の順。
const readoutXy = readoutEl?.querySelector(".xy") ?? null;
const readoutCell = readoutEl?.querySelector(".cell") ?? null;
// 「右クリックでコピー」の案内。操作の存在を画面から見つけられるようにする。
const readoutHint = readoutEl?.querySelector(".copyhint") ?? null;
// エリアを塗っている最中だけ「3×2 = 6マス」が入る。それ以外は空。
export const readoutPaint = readoutEl?.querySelector(".paint") ?? null;

/** マウスがある環境か。案内の文言を「右クリック」と「長押し」で分ける。 */
const hoverQuery = matchMedia("(hover: hover)");
const copyHintText = () => (hoverQuery.matches ? "右クリックでコピー" : "長押しでコピー");

export function updateReadout(evt) {
  if (!state.coords) return;
  const m = pointerToMeters(evt);
  if (!insideMap(m)) { readoutEl.hidden = true; return; }
  const g = state.coords.toGame(m);
  const cell = state.coords.cellOf(m);
  readoutXy.textContent = `x${g.x.toFixed(2)} y${g.y.toFixed(2)}`;
  readoutCell.textContent = cell ? ` ${cell}` : "";
  if (readoutHint) readoutHint.textContent = copyHintText();
  // キーボードでコピーするとき（c キー）に使う、最後にポインタがあった地点。
  state.lastPoint = m;
  readoutEl.hidden = false;
}

// ── 座標を Discord に持ち出す ───────────────────────────────
// ゲームには「座標をマーク」があり、チャットに `📍 x70.47, y99.03` と流れる。
// **その形に寄せて**クリップボードへ入れる。Discord に貼ったとき、ゲームから
// 流れてきたものと同じ見た目になるので、読む側が形式を覚え直さずに済む。
//
// **操作は右クリック（指なら長押し）。** 既存の作法と衝突しない根拠:
//   * 左ボタン … クリック＝置く／選ぶ、ドラッグ＝パン・移動・塗り（D-028）
//   * 中ボタン … パン
//   * ホイール … ズーム
//   * スペース … パン、Esc … 選択解除
//   **右ボタンには何も割り当てられていない**（ブラウザ既定のメニューが出るだけ）。
//   長押しも同じ `contextmenu` として飛ぶので、指でも同じ操作で届く。
// キーボードからは `c`（修飾キー無し）。Ctrl/Cmd+C は普通のコピーなので触らない。
// **フッターのボタンは増やしていない**（D-037）。

/** 今見えている範囲の中心（ポインタがまだ盤面に入っていないときの既定）。 */
export const viewCentreM = () => {
  if (!state.view || !state.coords) return null;
  const c = { x: state.view.x + state.view.w / 2, y: state.view.y + state.view.h / 2 };
  return state.coords.toMeters(c);
};

export async function copyMarkAt(m) {
  if (!state.coords || !m) return;
  if (!insideMap(m)) {
    say("マップの外です。マップの上でもう一度どうぞ。", true);
    return;
  }
  const text = markText(state.coords.toGame(m));
  try {
    await navigator.clipboard.writeText(text);
    say(`コピーしました: ${text}`);
  } catch {
    // クリップボードが使えない環境（非HTTPS・許可が無い）。共有URLのボタンと
    // 同じ落とし方で、せめて値そのものを出して手で選べるようにする。
    say(text);
  }
}
