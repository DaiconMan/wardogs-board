// スタンプの操作。棚を組む・置く・引く・動かす・選ぶ・消す・読む。
//
// 描き方そのもの（外形・四葉・矢の先・逆スケール）は ../stamps.js。
//
// オーナーの要望（D-062）:
//   「四角とか、丸、などスタンプほしいですね」
//   「スタンプは、凸型の敵とか見方を示すものもあっていいし、自由に追加もいいと思います」
//   「軍用記号です」
//
// 仕様: docs/superpowers/specs/2026-10-08-stamps.md（第1段 ＝ 組み込みの一式）
//
// **操作モデルは配置（place.js）に揃える。新しい作法を作らない。**
//   点のもの   … 棚から選んで盤面を押す（ドラッグはパン）
//   向きのもの … 棚から選んで盤面をドラッグ（始点と終点が決まる）
//
// 向きのものだけはドラッグで置くが、これは D-028（ドラッグはパン、クリックだけ配置）に
// 反しない。あれが禁じたのは「ドラッグで**取り消し困難な複数オブジェクト**ができる」
// ことで、こちらは1回のドラッグで1本（戻すで消える。エリアの塗りと同じ扱い）。

import { deleteStamp, getStamps, patchStamp, postStamps } from "../api.js";
import { say } from "../chrome.js";
import { stampDraftLayer, stampLayer, stampPanelEl } from "../dom.js";
import { dropDone, record, recordReplay } from "../history.js";
import { clearChildren } from "../render.js";
import { DEFAULT_MODE, canEdit, dropPicked, history, state } from "../state.js";
import {
  MAX_STAMPS_PER_PLAN, STAMP_NOTE, STAMP_PX, VECTOR_MIN_PX, createStamp, groupStamps,
  isVector, isWideGlyph, setStampNote, setStampTransform, setVectorTransform, stampShape,
  stampSide,
} from "../stamps.js";
import { clearZoneKind } from "./area.js";
import { clearPick, setStampPanelOpen } from "./drawers.js";
import { renderDetail } from "./detail.js";
import { setMode } from "./tools.js";
import { insideMap, markerScale, pointerToMeters } from "./view.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// 保存前（サーバの id が無い間）でもスタンプを一意に指すための通し番号。
let stampUid = 0;

/** 定義を引く。知らない id でも落ちない（置いた行だけ先に届くことがある）。 */
export const defOf = (s) => state.stampDefById.get(s?.stamp_id) ?? null;

/** 今の視野の広さ。盤面がまだ読めていないときは省略しない側に倒す。 */
const viewWidthM = () => state.view?.w ?? 0;

// ── 棚（#stamppanel）────────────────────────────────────────
// パレットと同じ「左の引き出し」。**中身の組み立ては .pal-group / .pal-list を
// そのまま借りる**（棚の作法を2通り作らない。design-system §6）。
// 違うのは1項目の中身だけで、こちらは名前の前に**形そのもの**を出す
// （軍用記号は「見た形」で選ぶものなので、名前だけ並べても選べない）。

/** 棚に出す見本。盤面と同じ形・同じ色の約束で描く。 */
function previewOf(def) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "st-preview");
  svg.setAttribute("viewBox", `${-STAMP_PX - 3} ${-STAMP_PX - 3} ${STAMP_PX * 2 + 6} ${STAMP_PX * 2 + 6}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.style.setProperty("--st", `var(--${def.color})`);

  if (isVector(def)) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "st-line");
    line.setAttribute("x1", -STAMP_PX);
    line.setAttribute("y1", STAMP_PX * 0.7);
    line.setAttribute("x2", STAMP_PX);
    line.setAttribute("y2", -STAMP_PX * 0.7);
    svg.appendChild(line);
    if (def.shape === "arrow") {
      const head = document.createElementNS(SVG_NS, "polygon");
      head.setAttribute("class", "st-shape");
      // 棚の中では向きを固定する（右上がり）。盤面では引いた向きに回る。
      head.setAttribute("points", `${STAMP_PX},${-STAMP_PX * 0.7} ${STAMP_PX * 0.1},${-STAMP_PX * 0.2} ${STAMP_PX * 0.45},${STAMP_PX * 0.45}`);
      svg.appendChild(head);
    }
    return svg;
  }

  svg.appendChild(stampShape(def.shape, "st-halo"));
  svg.appendChild(stampShape(def.shape, "st-shape"));
  if (def.glyph) {
    const glyph = document.createElementNS(SVG_NS, "text");
    glyph.setAttribute("class", "st-glyph");
    glyph.setAttribute("x", "0");
    glyph.setAttribute("y", "0");
    glyph.setAttribute("text-anchor", "middle");
    glyph.setAttribute("dominant-baseline", "central");
    if (isWideGlyph(def.glyph)) {
      glyph.setAttribute("textLength", String(STAMP_PX * 1.4));
      glyph.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
    glyph.textContent = def.glyph;
    svg.appendChild(glyph);
  }
  return svg;
}

function stampItem(def) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "st-item";
  btn.dataset.stampId = String(def.id);
  btn.setAttribute("aria-pressed", "false");
  // 読み上げは「敵 装甲」だけで足りる（形は見本の役目で、読み上げない）。
  const side = stampSide(def);
  btn.title = side && def.glyph ? `${def.label}（外形が陣営、中の字が兵種）` : def.label;

  btn.appendChild(previewOf(def));
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = def.label;
  btn.appendChild(nm);
  btn.addEventListener("click", () => pickStamp(def.id));
  return btn;
}

/**
 * 棚を組み直す。**空のまとまりは出さない**（`groupStamps`）。
 *
 * 先頭のまとまり（図形）だけ開いておく（パレットと同じ。全部開くとマップを覆う）。
 */
export function buildStampPanel(defs) {
  if (!stampPanelEl) return;
  clearChildren(stampPanelEl);

  const head = document.createElement("div");
  head.className = "head";
  const h2 = document.createElement("h2");
  h2.textContent = "スタンプ";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close quiet";
  close.textContent = "閉じる";
  close.addEventListener("click", () => setStampPanelOpen(false));
  head.append(h2, close);
  stampPanelEl.appendChild(head);

  // **どこが APP-6 で、どこが独自かを、使う場所に書く。**
  // 軍用記号は見慣れた人に一目で伝わることが狙いなので、そこを曖昧にすると
  // 読み手が自分の知識とこの画面のどちらを信じるか決められない。
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = STAMP_NOTE;
  stampPanelEl.appendChild(note);

  const groups = groupStamps(defs);
  groups.forEach(({ group, label, items }, i) => {
    const det = document.createElement("details");
    det.className = "pal-group";
    det.dataset.kind = group;
    det.open = i === 0;
    const sum = document.createElement("summary");
    sum.appendChild(document.createTextNode(label));
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${items.length}件`;
    sum.appendChild(count);
    det.appendChild(sum);
    const list = document.createElement("div");
    list.className = "pal-list";
    for (const def of items) list.appendChild(stampItem(def));
    det.appendChild(list);
    stampPanelEl.appendChild(det);
  });
}

function markStampPick() {
  if (!stampPanelEl) return;
  for (const b of stampPanelEl.querySelectorAll(".st-item")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.stampId) === state.stampPick));
  }
}

/** 同じ項目をもう一度押したら選択を解除する（既定の道具に戻る。パレットと同じ）。 */
export function pickStamp(id) {
  const next = state.stampPick === id ? null : id;
  state.stampPick = next;
  markStampPick();
  // 盤面を押したときの意味は常に1つだけ。建造物とエリアの選択は外す。
  clearPick();
  clearZoneKind();
  setMode(next === null ? DEFAULT_MODE : "stamp");
  if (next === null) { say(""); return; }
  const def = state.stampDefById.get(next);
  // 見えない所に置かせない（地名の道具と同じ決まり）。
  if (!state.showStamps) setStampsVisible(true);
  say(isVector(def)
    ? `${def.label} を選びました。マップをドラッグすると向きが決まります。`
    : `${def.label} を選びました。マップを押すと置きます。`);
}

export function clearStampPick() {
  if (state.stampPick === null) return;
  state.stampPick = null;
  markStampPick();
}

// ── 盤面に描く ─────────────────────────────────────────────

/** その位置に終点があるか（点のスタンプは持たない）。 */
const endOf = (s) =>
  (s.x2_m === null || s.x2_m === undefined || s.y2_m === null || s.y2_m === undefined)
    ? null : { x_m: s.x2_m, y_m: s.y2_m };

/**
 * ズーム・リサイズのあと、スタンプの見た目の大きさを一定に戻す（条件9）。
 *
 * **向きを持つものの線はマップ座標のまま**で、太さ（CSS の non-scaling-stroke）と
 * 矢の先だけ画面基準へ戻す。長さと向きは情報なので、地図と一緒に伸縮させる。
 */
export function updateStampScale() {
  if (!state.coords || state.stamps.length === 0) return;
  for (const s of state.stamps) redrawStamp(s);
}

/** スタンプ1件を盤面に描く。定義が取れていない行でも形だけは出す。 */
function renderStamp(s) {
  const def = defOf(s);
  s.node = createStamp(s, def);
  if (s.id !== null) s.node.dataset.stampId = String(s.id);
  // 動かせるスタンプだけカーソルを変える（押す前に動かせるかが分かるように）。
  if (canEdit(s)) s.node.dataset.mine = "true";
  stampLayer.appendChild(s.node);
  setStampNote(s.node, s, def, viewWidthM());
  redrawStamp(s);
}

/**
 * **絵だけを描き直す。** `s.x_m` には触らない。
 *
 * 描く位置は `s.carry ?? s`（他の人が運んでいる途中の位置。board/carry.js）。
 * 保存された座標は `s.x_m` のままにしてある——混ぜると **D1 が唯一の真実**で
 * なくなる（place.js の `redrawPlacement` と同じ理由）。
 *
 * **運ばれている最中の終点は、始点のずれと同じだけ動かす**（v1 は平行移動だけ）。
 * 通に乗るのは始点1組だけなので（`carryOf`）、終点はここで足す。
 */
export function redrawStamp(s) {
  if (!s.node || !state.coords) return;
  const scale = markerScale();
  const at = s.carry ?? s;
  const end = endOf(s);
  if (!end) {
    setStampTransform(s.node, state.coords.toSvg(at), scale);
    return;
  }
  const dx = at.x_m - s.x_m;
  const dy = at.y_m - s.y_m;
  setVectorTransform(
    s.node,
    state.coords.toSvg(at),
    state.coords.toSvg({ x_m: end.x_m + dx, y_m: end.y_m + dy }),
    scale
  );
}

/**
 * 保存される座標を書き換えて、絵もそこへ合わせる。保存そのものはしない。
 *
 * `at` は**新しい始点**。終点は同じだけずらす（v1 は全体の平行移動だけ。
 * 端だけ動かすのは第2段）。この形にしておくと、1件のドラッグ（pointer.js）と
 * まとめて動かす（marquee.js）が同じ関数をそのまま呼べる。
 */
export function moveStampTo(s, at) {
  const dx = at.x_m - s.x_m;
  const dy = at.y_m - s.y_m;
  s.x_m = at.x_m;
  s.y_m = at.y_m;
  if (endOf(s)) {
    s.x2_m += dx;
    s.y2_m += dy;
  }
  redrawStamp(s);
}

/** 保存に送る座標。向きを持つものは**両端を一緒に**送る（サーバが片側だけを断る）。 */
export function stampPatchBody(s) {
  const end = endOf(s);
  if (!end) return { x_m: s.x_m, y_m: s.y_m };
  return { x_m: s.x_m, y_m: s.y_m, x2_m: s.x2_m, y2_m: s.y2_m };
}

/** マップの中にあるか。向きを持つものは**両端とも**中にあること。 */
export function stampInside(s) {
  if (!insideMap({ x_m: s.x_m, y_m: s.y_m })) return false;
  const end = endOf(s);
  return end ? insideMap(end) : true;
}

export function removeStamp(s) {
  s.node?.remove();
  const i = state.stamps.indexOf(s);
  if (i !== -1) state.stamps.splice(i, 1);
  // 取り消しの台帳からも外す（残すと、消えたものをもう一度消しにいく）。
  dropDone(history(), (e) => e.stamp === s);
  // 範囲選択で選んでいた列からも外す（消えたものを掴み続けない）。
  dropPicked(s);
  if (state.selectedStamp === s) selectStamp(null);
}

/**
 * 選択中のスタンプだけを強調する。
 * 詳細パネルは配置・地名・スタンプで1枚を使い回すので、他の選択は必ず外す
 * （どれを選んでいるのか分からない状態を作らない）。
 */
export function selectStamp(s) {
  state.selectedStamp = s;
  state.selected = null;
  state.selectedCallout = null;
  for (const p of state.placements) {
    p.marker?.classList.remove("sel");
    p.range?.classList.remove("sel");
    p.hotzone?.classList.remove("sel");
  }
  for (const c of state.callouts) c.node?.classList.remove("sel");
  for (const other of state.stamps) other.node?.classList.toggle("sel", other === s);
  renderDetail();
}

/** 注記を書き換えて、地図の文字もその場で合わせる（保存はしない）。 */
export function applyStampNote(s, note) {
  s.note = note;
  if (s.node) setStampNote(s.node, s, defOf(s), viewWidthM());
}

/** 更新する対象の id を確かめる。まだ保存中なら終わるのを待つ。 */
export async function stampId(s) {
  try {
    return s.id ?? (await s.saving);
  } catch {
    removeStamp(s);
    return null;
  }
}

// ── 置く ───────────────────────────────────────────────────

/**
 * 選んでいる点のスタンプをその地点に置く。
 *
 * マップの外は受け付けない（配置・地名・インクと同じ扱い）。縁へ丸めると、
 * 余白を押しただけのスタンプがマップ内に置いたものと見分けられなくなる。
 */
export async function placeStampAt(point) {
  const def = state.stampDefById.get(state.stampPick);
  if (!def || isVector(def)) return;
  const at = pointerToMeters(point);
  if (!insideMap(at)) {
    say("マップの外です。マップの上を押してください。");
    return;
  }
  await addStamp({ stamp_id: def.id, x_m: at.x_m, y_m: at.y_m });
}

/**
 * スタンプを1件作って保存する。**置く経路とやり直しの経路が共有する唯一の実体。**
 *
 * `seed` は `{ stamp_id, x_m, y_m, x2_m, y2_m, note }`（終点と注記は任意）。
 *
 * `replay` のときに変える所は2つ（配置・地名と同じ作法）。
 *   1. 注記の欄にフォーカスしない（やり直しは「書き始める」操作ではない）
 *   2. 台帳に積むのに `recordReplay` を使う（やり直しの山を捨てない）
 *
 * 件数の上限は**やり直しでも当たる**（戻したあとに他の人が置いて埋まる）ので、
 * 呼ぶ側ではなくここで見る。
 *
 * 戻り値は作ったスタンプ、保存できなければ null。
 */
export async function addStamp(seed, { replay = false } = {}) {
  if (state.stamps.length >= MAX_STAMPS_PER_PLAN) {
    if (!replay) {
      say(
        `スタンプは1つの作戦に${MAX_STAMPS_PER_PLAN}件までです。要らないものを消してください。`,
        true
      );
    }
    return null;
  }

  const def = state.stampDefById.get(seed.stamp_id) ?? null;
  const note = seed.note ?? null;
  const hasEnd = Number.isFinite(seed.x2_m) && Number.isFinite(seed.y2_m);

  stampUid += 1;
  const s = {
    uid: stampUid,
    id: null,
    stamp_id: seed.stamp_id,
    x_m: seed.x_m,
    y_m: seed.y_m,
    x2_m: hasEnd ? seed.x2_m : null,
    y2_m: hasEnd ? seed.y2_m : null,
    note,
    created_by: state.me.user.id,
  };
  state.stamps.push(s);
  renderStamp(s);
  selectStamp(s);
  // 取り消しの台帳に、線・配置・地名・エリアと同じ列へ操作した順で載せる。
  const entry = { stamp: s };
  if (replay) recordReplay(history(), entry);
  else record(history(), entry);

  // 配置・地名と同じく client_uuid で冪等にする（再送しても二重に増えない）。
  s.saving = postStamps(state.plan.session.id, [{
    client_uuid: crypto.randomUUID(),
    stamp_id: seed.stamp_id,
    x_m: seed.x_m,
    y_m: seed.y_m,
    ...(hasEnd ? { x2_m: seed.x2_m, y2_m: seed.y2_m } : {}),
    note,
  }]).then((res) => {
    s.id = res.ids[0];
    if (s.node) s.node.dataset.stampId = String(res.ids[0]);
    return res.ids[0];
  });

  try {
    await s.saving;
    if (!replay) say(`${def ? def.label : "スタンプ"} を置きました。`);
    return s;
  } catch (e) {
    removeStamp(s);
    if (!replay) say(`置けませんでした。${e.message}`, true);
    return null;
  }
}

/**
 * スタンプ1件を取り消す（配置・地名の取り消しとまったく同じ流れ）。
 * **戻せたら true。** 台帳の出し入れは呼ぶ側（board/history.js）がする。
 */
export async function undoStamp(entry) {
  const s = entry.stamp;
  const id = await stampId(s);
  if (id === null) { say("取り消しました。"); return true; }

  try {
    await deleteStamp(state.plan.session.id, id);
    removeStamp(s);
    say("取り消しました。");
    return true;
  } catch (e) {
    say(`取り消せませんでした。${e.message}`, true);
    return false;
  }
}

// ── 向きを持つスタンプを引く ───────────────────────────────
// エリアの塗り（`beginPaint`）と同じ作法: 押した瞬間からプレビューを出して、
// 離す前に結果を見せる。確定前は破線（まだ保存していないことを形で示す）。

/** 引き始める。マップの外から引き始めたものは受け付けない（線と同じ扱い）。 */
export function beginStampDraw(evt) {
  const def = state.stampDefById.get(state.stampPick);
  if (!def || !isVector(def)) return false;
  const at = pointerToMeters(evt);
  if (!insideMap(at)) {
    say("マップの外です。マップの上から引いてください。");
    return false;
  }
  const node = createStamp({ uid: 0, note: null }, def);
  stampDraftLayer.appendChild(node);
  state.stampDraw = {
    def, node, from: at, to: at,
    start: { x: evt.clientX, y: evt.clientY },
  };
  drawDraft();
  return true;
}

export function stampDrawMove(evt) {
  state.stampDraw.to = pointerToMeters(evt);
  drawDraft();
}

function drawDraft() {
  const d = state.stampDraw;
  setVectorTransform(
    d.node, state.coords.toSvg(d.from), state.coords.toSvg(d.to), markerScale()
  );
}

/** 引きかけを捨てる（2本目の指が触れたとき、pointercancel）。 */
export function cancelStampDraw() {
  if (!state.stampDraw) return;
  state.stampDraw.node.remove();
  state.stampDraw = null;
}

/**
 * 引き終わった。
 *
 * **短すぎるものは置かない。** 長さ0の矢印は向きが読めず、押すたびに
 * 消す手間だけが増える（インクが1点のタップを線にしないのと同じ）。
 * 判定は画面の px（ズームの倍率によらず「指が動いたか」で決める）。
 */
export async function endStampDraw(d, evt) {
  const dx = evt.clientX - d.start.x;
  const dy = evt.clientY - d.start.y;
  if (Math.hypot(dx, dy) < VECTOR_MIN_PX) {
    say(`${d.def.label} は、向きが決まるまでドラッグしてください。`);
    return;
  }
  const to = pointerToMeters(evt);
  if (!insideMap(to)) {
    say("マップの外です。マップの上で離してください。");
    return;
  }
  await addStamp({
    stamp_id: d.def.id, x_m: d.from.x_m, y_m: d.from.y_m, x2_m: to.x_m, y2_m: to.y_m,
  });
}

// ── 表示の on/off ──────────────────────────────────────────

/**
 * スタンプの表示 on/off。置く道具と別にしてあるのは、見る設定と置く操作が別物だから。
 *
 * 伏せるときは置く道具からも抜ける（地名と同じ。見えない所に置ける状態を残すと、
 * 押しても何も出てこないという、いちばん分かりにくい形になる）。
 */
export function setStampsVisible(on) {
  state.showStamps = on;
  // SVG 要素には HTMLElement の `hidden` プロパティが無い（属性で操作する）。
  if (on) stampLayer.removeAttribute("hidden");
  else stampLayer.setAttribute("hidden", "");
  document.getElementById("toggle-stamps")?.setAttribute("aria-pressed", String(on));
  if (!on && state.mode === "stamp") {
    clearStampPick();
    setMode(DEFAULT_MODE);
  }
}

// ── 読む ───────────────────────────────────────────────────

/**
 * 定義と置いたものを読む（**1往復**）。ここが失敗しても盤面は壊さない。
 * 戻り値は「読めたか」で、呼び出し側が #status を消すかを決める。
 */
export async function loadStamps() {
  try {
    const body = await getStamps(state.plan.session.id);
    setStampDefs(body.defs ?? []);
    showStamps(body.stamps ?? []);
    return true;
  } catch (e) {
    // 棚を押せるままにしておくと、開いても空のパネルが出る。
    const btn = document.getElementById("toggle-stamp-panel");
    if (btn) btn.disabled = true;
    say(`スタンプを取得できませんでした。${e.message}`, true);
    return false;
  }
}

/** 定義を入れて棚を組む。**id で引く表も一緒に作る**（描くたびに探さない）。 */
export function setStampDefs(defs) {
  state.stampDefs = defs;
  state.stampDefById = new Map(defs.map((d) => [d.id, d]));
  buildStampPanel(defs);
}

/**
 * サーバから来たスタンプの列に、画面を合わせる。
 *
 * **配置（place.js の `showPlacements`）とまったく同じ作法**で、作り直さずに
 * 差分で当てる。理由もあちらと同じ（取り消しの台帳・選択・掴んでいる最中の
 * ものを壊さない）。id がまだ無い行（保存の途中）には触らない。
 */
export function showStamps(rows) {
  const byId = new Map(state.stamps.filter((s) => s.id !== null).map((s) => [s.id, s]));
  const incoming = new Set();

  for (const row of rows) {
    incoming.add(row.id);
    const found = byId.get(row.id);
    if (found) {
      if (found.note !== (row.note ?? null)) applyStampNote(found, row.note ?? null);
      // **`moveStampTo` は通さない。** あれは終点を「始点のずれと同じだけ」動かす
      // 関数で、サーバから来る値はもう両端とも絶対値になっている（二重に動く）。
      if (found.x_m !== row.x_m || found.y_m !== row.y_m
        || found.x2_m !== row.x2_m || found.y2_m !== row.y2_m) {
        found.x_m = row.x_m;
        found.y_m = row.y_m;
        found.x2_m = row.x2_m;
        found.y2_m = row.y2_m;
        redrawStamp(found);
      }
      continue;
    }
    stampUid += 1;
    const s = {
      uid: stampUid,
      id: row.id,
      stamp_id: row.stamp_id,
      x_m: row.x_m,
      y_m: row.y_m,
      x2_m: row.x2_m,
      y2_m: row.y2_m,
      note: row.note ?? null,
      created_by: row.created_by,
    };
    state.stamps.push(s);
    renderStamp(s);
  }

  for (const s of [...state.stamps]) {
    if (s.id !== null && !incoming.has(s.id)) removeStamp(s);
  }
  // 詳細パネルはここで組み直さない（理由は place.js の showPlacements と同じ）。
}

/** 更新を保存する下請け（詳細パネルと範囲選択が使う）。 */
export const saveStampAt = (id, body) => patchStamp(state.plan.session.id, id, body);
