// 道具（移動・ペン・消しゴム）と、フッターの棚の配線。
//
// 線を引く・消す・取り消すはここ。配置やエリアのように「選ぶこと自体が
// 意思表示」になる道具は、棚にボタンを持たない（setMode の注記を参照）。

import { deleteInk, postInk } from "../api.js";
import { areaLabel } from "../areas.js";
import { closeViewMenu, say, wireMenu } from "../chrome.js";
import {
  accountMenu, board, darkQuery, inkLayer, paletteEl, viewMenu, visibilityMenu,
  widthsEl, zonePanelEl,
} from "../dom.js";
import { dropDone, record, recordReplay } from "../history.js";
import { encodePoints, simplify, toSmoothPath } from "../ink.js";
import { createStrokePath } from "../render.js";
import { history, state } from "../state.js";
import { clearZoneKind, setAreasVisible, setZoneKind } from "./area.js";
import { applyBasemapMode, loadBasemapMode, setBasemapMode } from "./basemap.js";
import { setCalloutMode, setCalloutsVisible } from "./callout.js";
import { beginInk, endInk, extendInk } from "./cursor.js";
import { clearPick, setPaletteOpen, setZonePanelOpen } from "./drawers.js";
import { setSpawnsVisible, setTowersVisible } from "./fixtures.js";
import { wireHistory } from "./history.js";
import { clearPicked } from "./marquee.js";
import { setRangesVisible } from "./place.js";
import {
  ZOOM_BUTTON_FACTOR, clampToMap, insideMap, pointerToMeters, showAll, zoomByButton,
} from "./view.js";
import { wireZonePreset } from "./zone.js";

/**
 * 線を引き始める。引き始められたら true。
 *
 * マップの外から引き始めた線は受け付けない。丸めて受け入れると、
 * 余白を押しただけでマップの縁に貼り付いた線が保存され、
 * 見た目ではマップ内に引いた線と区別がつかなくなる。
 * 黙って無視すると壊れたと思われるので、理由を出す。
 */
export function beginStroke(evt) {
  const start = pointerToMeters(evt);
  if (!insideMap(start)) {
    say("マップの外です。マップの上から引いてください。");
    return false;
  }
  const path = createStrokePath({ color: state.color, width: state.width });
  inkLayer.appendChild(path);
  // 1点だけ（タップ）では線にしない。finishStroke が path を捨てる。
  state.drawing = { points: [start], path };
  // **引いている最中を相手の画面にも出す**（Phase R2b）。ここは値を置くだけで、
  // 送るのは既に 10Hz で飛んでいるカーソルの通（board/cursor.js の `push`）。
  // 通を1つも増やさないのが R2a から続く設計の肝。
  beginInk(state.color, state.width);
  extendInk(start);
  return true;
}

export function extendStroke(evt) {
  const pts = state.drawing.points;
  // 引いている途中に指が外へ滑ったぶんは縁で止める（救済）。
  // ここを丸めないと validateEncoded が 400 を返して線ごと失われる。
  const at = clampToMap(pointerToMeters(evt));
  pts.push(at);
  // **相手に送るのも、縁で止めたあとの点。** 生の座標を送ると、相手の画面では
  // マップの外へはみ出した線が出て、確定した線と形が食い違う。
  extendInk(at);
  const d = pts.map((p, i) => {
    const s = state.coords.toSvg(p);
    return `${i === 0 ? "M" : "L"} ${s.x} ${s.y}`;
  }).join(" ");
  state.drawing.path.setAttribute("d", d);
}

// 2本目の指が触れたときなど、引きかけの線を保存せずに捨てる。
export function cancelStroke() {
  if (!state.drawing) return;
  state.drawing.path.remove();
  state.drawing = null;
  // **その場で終わりを伝える。** 保存しないので `chg` も飛ばない ＝ 相手に
  // 取り直しは来ない ＝ 相手はその場で線を消す。これが正しい（捨てた線が
  // 相手の画面に残ると、保存されていないので消す手段が無い）。
  endInk();
}

function drop(entry) {
  dropDone(history(), (e) => e === entry);
}

/**
 * 指を離した。保存して、**保存が片付いてから**「引き終わった」を相手へ伝える。
 *
 * **`endInk()` を離した瞬間に呼ばない。** 呼ぶと受け手は「引き終わった」と
 * 読むが、`chg` はまだ届いていないので**取り直しが来ると分からず、その場で
 * 線を消す**——確定した線が届くまでの数百ミリ秒「一瞬消えてから本物が出る」が
 * 見える（D-069 で跳ね返りとして踏んだのと同じ罠。board/pointer.js の
 * `endDrag` が `d` を外すのを保存の後にしてあるのと同じ理由）。
 */
export async function finishStroke() {
  const { points, path } = state.drawing;
  state.drawing = null;
  // 押しただけ（タップ）。線にしないので、相手にもその場で終わりを伝える。
  if (points.length < 2) { path.remove(); endInk(); return; }

  try {
    // **間引いたあとの点を台帳に持たせる**（保存したものと同じ形）。生の点を
    // 持つと、やり直した線が元の線と1点ずつ違う形になる。
    await saveStroke({ color: state.color, width: state.width, points: simplify(points) }, { path });
  } finally {
    // **成功でも失敗でも必ず外す。** 外さないと、相手の画面に引きっぱなしの線が
    // ポインタを止めた位置で残る（次に引き始めるまで `k` が乗り続ける）。
    // 失敗したときは `chg` が飛んでいないので、相手はその場で消す——正しい。
    endInk();
  }
}

/**
 * 線を1本保存して台帳に積む。**引き終わった経路とやり直しの経路が共有する実体。**
 *
 * `path` を渡せばその要素をそのまま使う（引き終わった線は既に盤面に出ている）。
 * 渡さなければ作って置く（やり直し）。
 *
 * **台帳に `ink` を持たせるのがこの関数の肝。** 以前は `{ path, saving }` だけで、
 * 色・太さ・点は `postInk()` に渡したあと捨てていたので、戻した線をやり直せなかった。
 *
 * 戻り値は台帳の項目、保存できなければ null。
 */
export async function saveStroke(ink, { path = null, replay = false } = {}) {
  const node = path ?? inkLayer.appendChild(createStrokePath(ink));
  if (!path) {
    node.setAttribute("d", toSmoothPath(ink.points.map((p) => state.coords.toSvg(p))));
  }

  // 保存の Promise を先に台帳へ載せる。指を離した直後に取り消しを押されても、
  // その線が「自分が最後に引いた線」として拾えるようにするため。
  const entry = { path: node, ink };
  entry.saving = postInk(state.plan.session.id, [{
    client_uuid: crypto.randomUUID(),
    color: ink.color,
    width: ink.width,
    points: encodePoints(ink.points),
  }]).then((res) => {
    node.dataset.strokeId = String(res.ids[0]);
    node.dataset.owner = state.me.user.id;
    return res.ids[0];
  });
  if (replay) recordReplay(history(), entry);
  else record(history(), entry);

  try {
    await entry.saving;
    // 保存を待つ間に取り消されていたら、その結果の表示を上書きしない。
    if (!replay && state.mine.includes(entry)) say("保存しました。");
    return entry;
  } catch (e) {
    drop(entry);
    node.remove();
    if (!replay) say(`保存できませんでした。${e.message}`, true);
    return null;
  }
}

/** 画面上の線から、削除に使う id を得る。自分の線は保存の完了を待つ。 */
async function strokeIdOf(path) {
  const entry = state.mine.find((e) => e.path === path);
  if (entry) return { entry, id: await entry.saving };
  const id = Number(path.dataset.strokeId);
  return { entry: null, id };
}

export async function eraseAt(evt) {
  const path = evt.target;
  if (!(path instanceof SVGPathElement)) return;
  let found;
  try {
    found = await strokeIdOf(path);
  } catch {
    return; // 保存に失敗した線。finishStroke が既に画面から外している
  }
  if (!Number.isInteger(found.id) || found.id <= 0) return;
  try {
    await deleteInk(state.plan.session.id, found.id);
    path.remove();
    if (found.entry) drop(found.entry);
    say("消しました。");
  } catch (e) {
    say(`消せませんでした。${e.message}`, true);
  }
}

/**
 * 線1本を取り消す（台帳の末尾が線だったとき）。戻せたら true。
 *
 * 取り消しそのものの入口は board/history.js の `undo()`。4種類の振り分けを
 * あちらに置いて、種類ごとの手当てはそれぞれのファイルに置く作法に揃えてある
 * （配置は `undoPlacement`、地名は `undoCallout`、エリアは `undoArea`）。
 */
export async function undoStroke(entry) {
  let id;
  try {
    id = await entry.saving;
  } catch {
    // 保存自体が失敗していた線。もう画面にないので、取り消しは済んだ扱い。
    say("取り消しました。");
    return true;
  }

  try {
    await deleteInk(state.plan.session.id, id);
    entry.path.remove();
    say("取り消しました。");
    return true;
  } catch (e) {
    say(`取り消せませんでした。${e.message}`, true);
    return false;
  }
}

/**
 * 道具の切り替え。
 *
 * "place"（パレットで項目を選んでいる状態）は footer にボタンを持たない。
 * 配置はパレットで選ぶこと自体が「配置する」という意思表示なので、
 * ボタンをもう1つ増やすと同じことを二度指定させることになる。
 * この状態では pen / eraser / pan の3つとも aria-pressed=false になる。
 *
 * "callout"（地名を置く）は逆にパレットを持たないので、専用のボタンを1つ持つ。
 * これは排他の1組（.segmented）ではなく単独の on/off なので、押下は淡いほうの段。
 *
 * "zone"（エリアを塗る）はパネルで種類を選ぶこと自体が意思表示なので、配置と
 * 同じくフッターに道具のボタンを持たない。ただし**「消しゴム」だけは、この状態
 * でも「塗ったものを消す」という意味で効く**ので、押した表示にする
 * （道具の名前と効き目を食い違わせない）。
 */
const MODE_BUTTONS = [
  ["tool-pan", "pan"], ["tool-pen", "pen"], ["tool-eraser", "eraser"], ["tool-select", "select"],
];

export function setMode(mode) {
  state.mode = mode;
  const eraserOn = mode === "eraser" || (mode === "zone" && state.zoneErase);
  for (const [id, value] of MODE_BUTTONS) {
    const on = value === "eraser" ? eraserOn : mode === value;
    document.getElementById(id)?.setAttribute("aria-pressed", String(on));
  }
  document.getElementById("tool-callout")
    ?.setAttribute("aria-pressed", String(mode === "callout"));
  board.dataset.mode = mode;
  // 太さはペンの設定。**ペンを持っているときだけ棚に出す。**
  // 使わない道具の設定を常に並べておくと、そのぶん棚が長くなって
  // 狭い画面では本当に要るボタンが画面の外へ押し出される。
  if (widthsEl) widthsEl.hidden = mode !== "pen";
}

export function wireTools() {
  for (const [id, value] of MODE_BUTTONS) {
    document.getElementById(id).addEventListener("click", () => {
      // エリアを塗っている最中の「消しゴム」は、種類の選択を外さずに
      // 「塗る／消す」を入れ替える（消すたびに選び直させない）。
      if (value === "eraser" && state.mode === "zone") {
        state.zoneErase = !state.zoneErase;
        setMode("zone");
        say(state.zoneErase
          ? `${areaLabel(state.zoneKind)} を消します。ドラッグした範囲が消えます。`
          : `${areaLabel(state.zoneKind)} を塗ります。`);
        return;
      }
      // 道具を選び直したらパレットとエリアの選択は外す
      // （押した道具と盤面の挙動を一致させる）。
      clearPick();
      clearZoneKind();
      // 範囲選択も外す。選んだまま別の道具に移ると、画面に選択の印が残ったまま
      // それに効かない操作をすることになる（仕様 §2 の「解除」の3つ目）。
      if (value !== "select") clearPicked();
      setMode(value);
      if (value === "select") {
        say("マップをドラッグすると、枠の中の配置と地名を選びます。");
      }
    });
  }
  setMode(state.mode);

  const zonesBtn = document.getElementById("toggle-zones");
  zonesBtn.addEventListener("click", () => setZonePanelOpen(zonePanelEl?.hidden !== false));
  document.getElementById("zonepanel-close")
    ?.addEventListener("click", () => setZonePanelOpen(false));
  for (const b of document.querySelectorAll("#zone-kinds button")) {
    b.addEventListener("click", () => setZoneKind(b.dataset.kind));
  }
  document.getElementById("toggle-areas")
    .addEventListener("click", () => setAreasVisible(!state.showAreas));
  setAreasVisible(state.showAreas);
  wireZonePreset();

  document.getElementById("tool-callout").addEventListener("click", () => {
    setCalloutMode(state.mode !== "callout");
  });
  document.getElementById("toggle-callouts").addEventListener("click", () => {
    setCalloutsVisible(!state.showCallouts);
  });
  setCalloutsVisible(state.showCallouts);

  // ドリルタワーの表示は「見る」の畳んだメニューの中。フッターのボタンは増やさない
  // （横に溢れると端のボタンが切れて見つけられなくなる。D-037）。
  document.getElementById("toggle-towers")?.addEventListener("click", () => {
    setTowersVisible(!state.showTowers);
  });
  setTowersVisible(state.showTowers);
  document.getElementById("toggle-spawns")?.addEventListener("click", () => {
    setSpawnsVisible(!state.showSpawns);
  });
  setSpawnsVisible(state.showSpawns);

  const paletteBtn = document.getElementById("toggle-palette");
  paletteBtn.addEventListener("click", () => {
    setPaletteOpen(paletteEl?.hidden !== false, true);
  });
  const rangesBtn = document.getElementById("toggle-ranges");
  rangesBtn.addEventListener("click", () => setRangesVisible(!state.showRanges));
  setRangesVisible(state.showRanges);

  for (const b of document.querySelectorAll("#widths button")) {
    b.addEventListener("click", () => {
      state.width = Number(b.dataset.w);
      for (const other of document.querySelectorAll("#widths button")) {
        other.setAttribute("aria-pressed", String(other === b));
      }
    });
  }
  // 「戻す」と「やり直す」は board/history.js が受け持つ（4種類の振り分けと
  // 2つの山の出し入れがそこに揃っているので、配線もあちらに置く）。
  wireHistory();

  document.getElementById("zoom-in").addEventListener("click", () => zoomByButton(1 / ZOOM_BUTTON_FACTOR));
  document.getElementById("zoom-out").addEventListener("click", () => zoomByButton(ZOOM_BUTTON_FACTOR));
  document.getElementById("zoom-fit").addEventListener("click", showAll);

  for (const b of document.querySelectorAll("#basemap-modes button")) {
    b.addEventListener("click", () => {
      setBasemapMode(b.dataset.basemap);
      closeViewMenu();
    });
  }
  wireMenu(viewMenu);
  wireMenu(accountMenu);
  // 公開設定のメニューも同じ作法（外を押すか Esc で畳む。同時に2枚開かない）。
  // 中身は作成者のときだけ入るが、要素は最初から在るのでここで繋いでよい。
  wireMenu(visibilityMenu);
  state.basemap = loadBasemapMode();
  applyBasemapMode();
  // OS の配色が切り替わったら、そのモード用のフィルタに差し替える。
  darkQuery.addEventListener("change", applyBasemapMode);
}
