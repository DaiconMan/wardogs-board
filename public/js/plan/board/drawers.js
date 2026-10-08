// 左の引き出し（パレットと「円とマス」のパネル）。**開くのは1枚だけ。**

import { say } from "../chrome.js";
import { narrowQuery, paletteEl, stampPanelEl, zonePanelEl } from "../dom.js";
import { HOTZONE_ITEM_ID, KINDS, costText, isUnverified, rangeText } from "../placements.js";
import { clearChildren } from "../render.js";
import { state } from "../state.js";
import { clearZoneKind } from "./area.js";
import { clearStampPick } from "./stamp.js";
import { setMode } from "./tools.js";

/**
 * パレットを開いたままにしておく画面幅。
 *
 * 置く作業のたびに開き直すのは手数の無駄なので、広い画面では最初から開けておく。
 * ただし 390px で常設すると盤面がほぼ隠れて「マップが主役」でなくなるため、
 * 狭い画面では従来どおり畳んだ状態で始める。
 * この幅は #palette が盤面の左のレターボックス（正方形のマップの外側）に
 * おおむね収まる目安でもある。
 */
const PALETTE_ALWAYS_W = 1024;
const PALETTE_KEY = "wardogs.plan.palette";

// ── パレット ──────────────────────────────────────────────
// 56項目あるので種別ごとに <details> で畳む。ゲームデータ由来の項目にはコストと
// 射程の短い表示を付け、verified=0 のものには必ず「未検証」を出す（数値は全項目
// NULL か暫定値なので、確定値のように見せると作戦の判断を誤らせる）。
// 試合の要素（作図用の記号）はどちらも持たないので、名前だけの行になる。

function paletteItem(item) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pal-item";
  btn.dataset.itemId = item.id;
  btn.setAttribute("aria-pressed", "false");

  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = item.name_ja;

  const meta = document.createElement("span");
  meta.className = "meta";
  const costLabel = costText(item);
  if (costLabel) {
    const cost = document.createElement("span");
    cost.className = "cost";
    cost.textContent = costLabel;
    meta.appendChild(cost);
  }
  const rangeLabel = rangeText(item);
  if (rangeLabel) {
    const rng = document.createElement("span");
    rng.className = "rg";
    rng.textContent = rangeLabel;
    meta.appendChild(rng);
  }
  if (isUnverified(item)) {
    const unv = document.createElement("span");
    unv.className = "unv";
    unv.textContent = "未検証";
    meta.appendChild(unv);
  }

  btn.appendChild(nm);
  // 試合の要素は3つとも空になる。空の行を足すと項目の高さだけ間延びする。
  if (meta.childElementCount) btn.appendChild(meta);
  btn.addEventListener("click", () => pickItem(item.id));
  return btn;
}

function paletteGroup(kind, label, items, open) {
  const det = document.createElement("details");
  det.className = "pal-group";
  det.dataset.kind = kind;
  det.open = open;

  const sum = document.createElement("summary");
  sum.appendChild(document.createTextNode(label));
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = `${items.length}件`;
  sum.appendChild(count);
  det.appendChild(sum);

  const list = document.createElement("div");
  list.className = "pal-list";
  for (const item of items) list.appendChild(paletteItem(item));
  det.appendChild(list);
  return det;
}

export function buildPalette(items) {
  if (!paletteEl) return;
  clearChildren(paletteEl);

  const head = document.createElement("div");
  head.className = "head";
  const h2 = document.createElement("h2");
  h2.textContent = "建造物・設置物・車輌";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close quiet";
  close.textContent = "閉じる";
  close.addEventListener("click", () => setPaletteOpen(false, true));
  head.append(h2, close);
  paletteEl.appendChild(head);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "コスト・射程は出典からの暫定値です。「未検証」はゲーム内で実測していない数値です。" +
    "寸法（footprint）は未実測なのでマーカーは実寸ではありません。";
  paletteEl.appendChild(note);

  const known = new Set(KINDS.map((k) => k.kind));
  for (const { kind, label } of KINDS) {
    const list = items.filter((i) => i.kind === kind);
    if (list.length === 0) continue;
    // 先頭の種別だけ開いておく（全部開くとマップを覆う）。
    paletteEl.appendChild(paletteGroup(kind, label, list, kind === KINDS[0].kind));
  }
  // カタログに未知の kind が増えたとき、黙って落とさない。
  const rest = items.filter((i) => !known.has(i.kind));
  if (rest.length) paletteEl.appendChild(paletteGroup("other", "その他", rest, false));
}

function markPicked() {
  // ホットゾーンは**パレットと「円とマス」の2箇所から選べる**（円を探す人は
  // 引き出しを開ける。D-049）。選んでいる状態の見え方は必ず両方に出す。
  // 片方だけ更新すると、押していないほうのボタンが「押せる」ように見える。
  document.getElementById("place-hotzone")
    ?.setAttribute("aria-pressed", String(state.pick === HOTZONE_ITEM_ID));
  if (!paletteEl) return;
  for (const b of paletteEl.querySelectorAll(".pal-item")) {
    b.setAttribute("aria-pressed", String(b.dataset.itemId === state.pick));
  }
}

/** 同じ項目をもう一度押したら選択を解除する（既定の道具に戻る）。 */
export function pickItem(id) {
  // **カタログが届く前でも押せるボタンがある**（「円とマス」のホットゾーン。
  // パレットと違って静的な HTML なので、中身の到着を待っていない）。
  // 選ばせてしまうと、置こうとした瞬間に項目が見つからず黙って何も起きない。
  if (id !== null && !state.catalog.has(id)) {
    say("まだ読み込み中です。少し待ってからもう一度押してください。");
    return;
  }
  const next = state.pick === id ? null : id;
  state.pick = next;
  markPicked();
  // 建造物・エリア・スタンプは排他（盤面を押したときの意味は常に1つだけ）。
  clearZoneKind();
  clearStampPick();
  // パレットから選んだ＝置く道具は「配置」。地名の道具からは抜ける。
  setMode(next ? "place" : "pen");
  if (!next) { say(""); return; }
  const item = state.catalog.get(next);
  // 狭い画面では、選んだ直後に「置きたい場所」が引き出し自身に隠れている。
  // 広い画面（左端の引き出し）では続けて何個も選びたいので畳まない。
  // **引き出しは2枚ありうる**（パレット / 円とマス）ので両方畳む。
  if (narrowQuery.matches) { setPaletteOpen(false); setZonePanelOpen(false); }
  say(`${item.name_ja} を選びました。マップを押すと置きます。`);
}

export function clearPick() {
  if (state.pick === null) return;
  state.pick = null;
  markPicked();
}

/**
 * パレットの開閉。`remember` を立てたときだけ次回に持ち越す。
 *
 * 狭い画面で項目を選んだときの自動の畳み（置きたい場所を自分で隠さないための処置）
 * まで覚えると、一度選んだだけで「畳んだ状態が既定」になってしまう。
 * 覚えるのは自分でボタンを押したときだけにする。
 */
/**
 * 左の引き出し（パレット / エリアのパネル）を**自分で**開閉したか。
 *
 * 立っていると、遅れて届くカタログの自動オープン（loadPlacements）が
 * 利用者の選択を上書きしない。名前が `paletteTouched` だった頃はパレット側の
 * 操作しか立てておらず、エリアのパネルを開けた直後に自動オープンが走ると
 * 黙って閉じていた（e2e が 3% の確率で落ちていた原因）。
 */
export let drawerTouched = false;

/**
 * 左の引き出しの一覧。**開くのは1枚だけ**を、ここ1箇所で保証する。
 *
 * 引き出しが3枚になった時点で「開くときに他の2枚を畳む」を各関数へ書き写すのを
 * やめた。書き写すと、新しい引き出しを足した人が**1組だけ書き忘れて、
 * その2枚だけが重なる**（しかも狭い画面でしか見えない）。
 */
const DRAWERS = {
  palette: { el: () => paletteEl, btn: "toggle-palette" },
  zones: { el: () => zonePanelEl, btn: "toggle-zones" },
  stamps: { el: () => stampPanelEl, btn: "toggle-stamp-panel" },
};

/** 1枚の開閉を画面に当てる（他の引き出しのことは見ない）。 */
function applyDrawer(name, on) {
  const d = DRAWERS[name];
  const el = d.el();
  if (!el) return false;
  el.hidden = !on;
  const btn = document.getElementById(d.btn);
  if (btn) {
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-expanded", String(on));
  }
  return true;
}

/** `name` を開く（他は畳む）／畳む。 */
function setDrawerOpen(name, on) {
  if (!applyDrawer(name, on)) return false;
  if (!on) return true;
  for (const other of Object.keys(DRAWERS)) {
    if (other !== name) applyDrawer(other, false);
  }
  return true;
}

export function setPaletteOpen(on, remember = false) {
  if (!setDrawerOpen("palette", on)) return;
  if (!remember) return;
  drawerTouched = true;
  // 保存できない（プライベートモード等）としても、開閉そのものは効いたままでよい。
  try { localStorage.setItem(PALETTE_KEY, on ? "open" : "closed"); } catch { /* 覚えないだけ */ }
}

/**
 * スタンプの棚の開閉。
 *
 * 自分で開けたら、遅れて届くカタログの自動オープン（`loadPlacements`）に勝たせる
 * （`setZonePanelOpen` と同じ理由。あちらの注記を参照）。
 * localStorage には書かない（「次もスタンプを開いておく」は決めていない）。
 */
export function setStampPanelOpen(on) {
  if (!setDrawerOpen("stamps", on)) return;
  if (on) drawerTouched = true;
}

/**
 * 最初にパレットを開けておくか。
 * 自分で決めた指定があればそれに従い、無ければ画面の広さで決める。
 */
export function paletteOpenAtStart() {
  let saved = null;
  try { saved = localStorage.getItem(PALETTE_KEY); } catch { /* 覚えていないだけ */ }
  if (saved === "open") return true;
  if (saved === "closed") return false;
  return innerWidth >= PALETTE_ALWAYS_W;
}

/** エリアのパネルの開閉。左の引き出しは1枚だけにする（重ねると読めない）。 */
export function setZonePanelOpen(on) {
  if (!setDrawerOpen("zones", on)) return;
  if (!on) return;
  // **自分で引き出しを開けたら、遅れて届くカタログの自動オープンに勝たせる。**
  // カタログは盤面より後に読むので、届いた時点で「広い画面ならパレットを開く」が
  // 走る（loadPlacements）。パレットを開くと引き出しは1枚だけの決まりで
  // エリアのパネルが閉じるため、押した直後に黙って閉じることがあった
  // （実測: e2e が 3% の確率で「#zonepanel が hidden のまま」で落ちていた）。
  // setPaletteOpen(_, remember=true) と同じ意図で、こちらは localStorage には
  // 書かない（「次もエリアを開いておく」は決めていないため）。
  drawerTouched = true;
  setPaletteOpen(false);
}
