// 配置（建造物・設置物・車輌）の操作。置く・動かす・選ぶ・消す・読む。
//
// 描き方そのもの（マーカー・射程リング・ホットゾーンの円）は ../placements.js。

import {
  deletePlacement, getCatalog, getPlacements, patchPlacement, postPlacements,
} from "../api.js";
import { say } from "../chrome.js";
import { hotzoneLayer, placeLayer, rangeLayer } from "../dom.js";
import { dropDone, record, recordReplay } from "../history.js";
import {
  FOB_RANGE_NOTE, HOTZONE_ITEM_ID, createHotzone, createMarker, createRange, hasRange,
  hotzoneNote, isFob, isHotzone, rangeText, setHotzoneLabelScale, setMarkerLabel,
  setMarkerRank, setMarkerTransform, wantsNote,
} from "../placements.js";
import { canEdit, dropPicked, history, state } from "../state.js";
import { renderDetail } from "./detail.js";
import { buildPalette, drawerTouched, paletteOpenAtStart, setPaletteOpen } from "./drawers.js";
import { insideMap, markerScale, metersPerPx, pointerToMeters } from "./view.js";

// 保存前（サーバの id が無い間）でも配置を一意に指すための通し番号。
let placementUid = 0;

// ── 建造物・設置物・車輌の配置 ────────────────────────────────
// 配置そのものはメートルで保存する（インクと同じ）。画面に出すものは2種類:
//   * マーカー … 画面上で一定の大きさ。footprint_* が全項目 NULL で実寸が
//     描けないので、マップ座標で固定サイズにすると全体表示では見えない。
//   * 射程リングと FOB の建築範囲 … 実寸（メートル）。意味のある寸法なので、
//     地図と同じ縮尺で伸縮しなければ「このFOBからどこを叩けるか」が読めない。

/**
 * ズーム・リサイズのあと、マーカーの見た目の大きさを一定に戻す。
 * あわせて注記の文字も出し直す（視野の広さで全文と省略が変わるため）。
 */
export function updateMarkerScale() {
  if (!state.coords || state.placements.length === 0) return;
  const mpp = metersPerPx();
  // 盤面がまだ測れないときも「点」にはしない。全体表示で妥当な値を置く。
  const scale = mpp > 0 ? mpp : state.view.w / 900;
  for (const p of state.placements) {
    if (!p.marker) continue;
    // **他の人が運んでいる最中は、そちらの位置のまま**（`p.carry`。board/carry.js）。
    // ここで `p` を使うと、ズームやリサイズのたびに運ばれている物が
    // 保存済みの位置へ跳ね戻る。
    setMarkerTransform(p.marker, state.coords.toSvg(p.carry ?? p), scale);
    setMarkerLabel(p.marker, p, state.catalog.get(p.item_id) ?? null, state.view.w);
    // 円は実寸なので viewBox だけで伸縮する。札だけ画面基準に戻す。
    if (p.hotzone) setHotzoneLabelScale(p.hotzone, scale, state.view.w);
  }
}

/** 今の視野の広さ。盤面がまだ読めていないときは省略しない側に倒す。 */
const viewWidthM = () => state.view?.w ?? 0;

/** 注記を書き換えて、地図の文字もその場で合わせる（保存はしない）。 */
export function applyLabel(p, label) {
  p.label = label;
  if (p.marker) setMarkerLabel(p.marker, p, state.catalog.get(p.item_id) ?? null, viewWidthM());
}

/** 優先度を書き換えて、マーカーの数字もその場で合わせる（保存はしない）。 */
export function applyRank(p, rank) {
  p.rank = rank;
  if (p.marker) setMarkerRank(p.marker, rank);
}

/** 配置1件を盤面に描く。カタログが取れていない項目でもマーカーだけは出す。 */
function renderPlacement(p) {
  const item = state.catalog.get(p.item_id) ?? null;
  const at = state.coords.toSvg(p);
  p.marker = createMarker(p, item);
  setMarkerLabel(p.marker, p, item, viewWidthM());
  setMarkerRank(p.marker, p.rank ?? null);
  if (p.id !== null) p.marker.dataset.placementId = String(p.id);
  // 動かせる配置だけカーソルを変える（押す前に動かせるかが分かるように）。
  if (canEdit(p)) p.marker.dataset.mine = "true";
  placeLayer.appendChild(p.marker);
  p.range = createRange(p, item, at);
  if (p.range) rangeLayer.appendChild(p.range);
  // ホットゾーンだけは実寸の円（半径 85m）も一緒に描く。カタログに寸法を持つ
  // 項目（射程・FOB）とは別の層・別の色・別の線にする（plan.html 参照）。
  p.hotzone = isHotzone(item) ? createHotzone(p, at) : null;
  if (p.hotzone) {
    hotzoneLayer.appendChild(p.hotzone);
    setHotzoneLabelScale(p.hotzone, markerScale(), viewWidthM());
  }
  setMarkerTransform(p.marker, at, markerScale());
}

/**
 * **絵だけを描き直す。** `p.x_m` には触らない。
 *
 * 描く位置は `p.carry ?? p`。`p.carry` は「他の人がいま運んでいる途中の位置」で
 * （board/carry.js が入れる）、**保存された座標は `p.x_m` のまま**にしてある。
 * ここを混ぜて `p.x_m` に書き込むと、運ばれている途中の値が手元の「正しい座標」に
 * なってしまい、**D1 が唯一の真実**でなくなる（2人が同じ物を触ったときに
 * どちらが正しいか決められない）。
 *
 * 射程リングは中心の座標を属性で持っているので、作り直して置き換える
 * （transform でずらすと、属性が示す位置と実際の位置が食い違う）。
 */
export function redrawPlacement(p) {
  if (!p.marker || !state.coords) return;
  const svg = state.coords.toSvg(p.carry ?? p);
  setMarkerTransform(p.marker, svg, markerScale());
  const selected = state.selected === p;
  p.range?.remove();
  p.range = createRange(p, state.catalog.get(p.item_id) ?? null, svg);
  if (p.range) {
    p.range.classList.toggle("sel", selected);
    rangeLayer.appendChild(p.range);
  }
  // ホットゾーンの円も同じ理由で作り直す（円は cx / cy を属性で持っている）。
  if (p.hotzone) {
    p.hotzone.remove();
    p.hotzone = createHotzone(p, svg);
    p.hotzone.classList.toggle("sel", selected);
    hotzoneLayer.appendChild(p.hotzone);
    setHotzoneLabelScale(p.hotzone, markerScale(), viewWidthM());
  }
}

/** 保存される座標を書き換えて、絵もそこへ合わせる。保存そのものはしない。 */
export function moveMarkerTo(p, at) {
  p.x_m = at.x_m;
  p.y_m = at.y_m;
  redrawPlacement(p);
}

export function removePlacement(p) {
  p.marker?.remove();
  p.range?.remove();
  p.hotzone?.remove();
  const i = state.placements.indexOf(p);
  if (i !== -1) state.placements.splice(i, 1);
  // 取り消しの台帳からも外す。残すと、消えたものをもう一度消しにいく。
  dropDone(history(), (e) => e.placement === p);
  // 範囲選択で選んでいた列からも外す（消えたものを掴み続けない）。
  dropPicked(p);
  if (state.selected === p) selectPlacement(null);
}

/**
 * 選択中の配置だけを強調する（複数置いたときにリングが混ざらないように）。
 * 詳細パネルは配置と地名で1枚を使い回すので、地名の選択は必ず外す
 * （どちらを選んでいるのか分からない状態を作らない）。
 */
export function selectPlacement(p) {
  state.selected = p;
  state.selectedCallout = null;
  for (const c of state.callouts) c.node?.classList.remove("sel");
  for (const other of state.placements) {
    const on = other === p;
    other.marker?.classList.toggle("sel", on);
    other.range?.classList.toggle("sel", on);
    other.hotzone?.classList.toggle("sel", on);
  }
  renderDetail();
}

/**
 * 更新する対象の id を確かめる。まだ保存中なら終わるのを待つ。
 * 保存そのものが失敗していた配置は、もう盤面に無いので取り除いて null を返す。
 */
export async function placementId(p) {
  try {
    return p.id ?? (await p.saving);
  } catch {
    removePlacement(p);
    return null;
  }
}

/** 置いたときに添える一言。寸法が未確認のものはそれを必ず言う。 */
function placedNote(item) {
  // ホットゾーンは**効果（人数2倍）を最初に言う。** 置いた本人は「何の円か」を
  // 知っていても、Discord で画面を見た人は円の意味を知らない。
  if (isHotzone(item)) return hotzoneNote();
  if (isFob(item)) return FOB_RANGE_NOTE;
  if (hasRange(item)) return `${rangeText(item)}（未検証）。`;
  return "";
}

/**
 * パレットで選んだ項目をその地点に置く。
 *
 * 引数は `{ clientX, clientY }` を持つもの（PointerEvent でも可）。押した位置と
 * 離した位置が違いうる（不具合1の閾値判定）ので、呼ぶ側が地点を決められる形にする。
 *
 * マップの外は受け付けない（インクと同じ扱い）。丸めて縁に貼り付けると、
 * 余白を押しただけの配置がマップ内に置いたものと見分けられなくなる。
 */
export async function placeAt(point) {
  const item = state.catalog.get(state.pick);
  if (!item) return;
  const at = pointerToMeters(point);
  if (!insideMap(at)) {
    say("マップの外です。マップの上を押してください。");
    return;
  }
  await addPlacement({ item_id: item.id, x_m: at.x_m, y_m: at.y_m });
}

/**
 * 配置を1件作って保存する。**置く経路とやり直しの経路が共有する唯一の実体。**
 *
 * `seed` は `{ item_id, x_m, y_m, label, rank }`（注記と優先度は任意）。
 * 座標がマップの中にあることは呼ぶ側が確かめる（置く側は案内を出したいが、
 * やり直す側は元々マップの中にあったものなので確かめる必要が無い）。
 *
 * **`replay` のときだけ振る舞いを変える所は3つ。**
 *   1. 注記の欄にフォーカスしない（やり直しは「書き始める」操作ではない）
 *   2. 台帳に積むのに `recordReplay` を使う（やり直しの山を捨てない）
 *   3. 注記と優先度を復元する（`POST /placements` は `label` は受けるが
 *      **`rank` を受けない**ので、優先度だけは後から PATCH で付ける）
 *
 * 戻り値は作った配置、保存できなければ null。
 */
export async function addPlacement(seed, { replay = false } = {}) {
  const item = state.catalog.get(seed.item_id) ?? null;
  const label = seed.label ?? null;
  const rank = Number.isInteger(seed.rank) ? seed.rank : null;

  placementUid += 1;
  const p = {
    uid: placementUid,
    id: null,
    item_id: seed.item_id,
    x_m: seed.x_m,
    y_m: seed.y_m,
    label,
    rank,
    created_by: state.me.user.id,
  };
  state.placements.push(p);
  renderPlacement(p);
  selectPlacement(p);
  // 「置く → 書く」を1動作で終わらせる。メモ・守る・攻める・危険は、記号そのものには
  // 「守る」しか意味が無く、何をどう守るのかは書かないと伝わらない記号なので、
  // 置いた直後に注記の欄へ入れる（位置に紐づく判断を書きたい、が元々の要望）。
  if (!replay && wantsNote(seed.item_id)) document.getElementById("placement-label")?.focus();
  // 取り消しの台帳に、線と同じ列へ操作した順で載せる。
  // **やり直しで作ったものは `recordReplay`**（やり直しの山を捨てない。history.js）。
  const entry = { placement: p };
  if (replay) recordReplay(history(), entry);
  else record(history(), entry);

  // インクと同じく client_uuid で冪等にする（再送しても二重に増えない）。
  // 回転は 0 固定。footprint が全項目 NULL で向きに意味を持たせられないため。
  p.saving = postPlacements(state.plan.session.id, [{
    client_uuid: crypto.randomUUID(),
    item_id: seed.item_id,
    x_m: seed.x_m,
    y_m: seed.y_m,
    rotation: 0,
    label,
  }]).then((res) => {
    p.id = res.ids[0];
    if (p.marker) p.marker.dataset.placementId = String(res.ids[0]);
    return res.ids[0];
  });

  try {
    const id = await p.saving;
    // 優先度は POST に乗らないので、やり直しのときだけ後から付ける。
    // **落としても配置そのものは戻っている**ので、失敗しても作り直しは取り消さない。
    if (replay && rank !== null) {
      try {
        await patchPlacement(state.plan.session.id, id, { rank });
      } catch {
        applyRank(p, null);
      }
    }
    if (!replay) say(`${item ? item.name_ja : seed.item_id} を置きました。${placedNote(item)}`);
    return p;
  } catch (e) {
    removePlacement(p);
    if (!replay) say(`置けませんでした。${e.message}`, true);
    return null;
  }
}

/**
 * 直前の配置を取り消す。**戻せたら true、戻せなければ false。**
 * 消す権限は自分の配置にしかないが、台帳に載るのは自分が置いたものだけ。
 *
 * **台帳の出し入れはここでしない**（呼ぶ側 ＝ board/history.js の `undo()` が、
 * 戻り値を見て「やり直しの山へ移す」か「台帳へ返す」かを決める）。
 * ここで `state.mine.push` もしていた頃は、やり直しの山と台帳の両方に
 * 同じ操作が居る状態が作れてしまう。
 */
export async function undoPlacement(entry) {
  const p = entry.placement;
  let id;
  try {
    id = p.id ?? (await p.saving);
  } catch {
    // 保存自体が失敗していた配置。もう画面に無いので取り消しは済んだ扱い。
    removePlacement(p);
    say("取り消しました。");
    return true;
  }

  try {
    await deletePlacement(state.plan.session.id, id);
    removePlacement(p);
    say("取り消しました。");
    return true;
  } catch (e) {
    say(`取り消せませんでした。${e.message}`, true);
    return false;
  }
}

export function setRangesVisible(on) {
  state.showRanges = on;
  // SVG 要素には HTMLElement の `hidden` プロパティが無い（属性で操作する）。
  // CSS 側の `[hidden]{display:none}` もセレクタが属性なので、これで両方効く。
  if (on) rangeLayer.removeAttribute("hidden");
  else rangeLayer.setAttribute("hidden", "");
  document.getElementById("toggle-ranges").setAttribute("aria-pressed", String(on));
}

/**
 * カタログと保存済みの配置を読む。
 *
 * どちらが失敗しても盤面は壊さない（マップとインクはそのまま使える）。
 * 戻り値は「両方読めたか」で、呼び出し側が #status を消すかを決める。
 */
export async function loadPlacements() {
  let ok = true;

  try {
    const { items } = await getCatalog();
    state.catalog = new Map(items.map((i) => [i.id, i]));
    buildPalette(items);
    // 「円とマス」のホットゾーンのボタンは静的な HTML なので、中身の到着を
    // 待っていない。カタログにその行があるときだけ押せるようにする
    // （本番の D1 に schema.sql をまだ流していないときは行が無い）。
    const hz = document.getElementById("place-hotzone");
    if (hz && state.catalog.has(HOTZONE_ITEM_ID)) {
      hz.disabled = false;
      hz.removeAttribute("title");
    }
    // 置く作業のたびに開き直さずに済むよう、広い画面では最初から開けておく。
    // 中身が届いてから開く（空のパネルを先に出さない）。
    // カタログを待っている間に自分で開閉していたら、そちらを優先する
    // （待たされた末に、押したのと反対の状態へ勝手に戻されるのは不愉快）。
    if (!drawerTouched) setPaletteOpen(paletteOpenAtStart());
  } catch (e) {
    ok = false;
    document.getElementById("toggle-palette").disabled = true;
    // ホットゾーンもカタログの1行なので、取れていないなら置けない。
    // 押せるままにしておくと、押しても何も起きないボタンが残る。
    const hz = document.getElementById("place-hotzone");
    if (hz) hz.disabled = true;
    say(`カタログを取得できませんでした。${e.message}`, true);
  }

  try {
    showPlacements((await getPlacements(state.plan.session.id)).placements);
  } catch (e) {
    ok = false;
    say(`配置を取得できませんでした。${e.message}`, true);
  }

  return ok;
}

/**
 * サーバから来た配置の列に、画面を合わせる。
 *
 * **作り直さずに差分で当てる。** 丸ごと作り直すと、
 *   * 取り消しの台帳（`state.mine`）が持っている参照が宙に浮く
 *   * 選んでいた配置の選択が外れ、詳細パネルが閉じる
 *   * 掴んでいる最中のマーカーが手から消える
 * という形で、**他人が何か保存するたびに自分の作業が壊れる**（変更通知を
 * 入れた意味が無くなる）。id が同じものは同じオブジェクトのまま位置と
 * 注記だけ直す。
 *
 * **id がまだ無い行（保存の途中）には触らない。** サーバはまだその行を
 * 知らないので、消すと「置いた瞬間に消える」になる。
 * （board/reload.js は保存中が1つでもあれば取り直しを遅らせるので、
 * ここに来る時点では普通は居ない。保険。）
 */
export function showPlacements(rows) {
  const byId = new Map(state.placements.filter((p) => p.id !== null).map((p) => [p.id, p]));
  const incoming = new Set();

  for (const row of rows) {
    incoming.add(row.id);
    const rank = Number.isInteger(row.rank) ? row.rank : null;
    const found = byId.get(row.id);
    if (found) {
      applyLabel(found, row.label ?? null);
      applyRank(found, rank);
      if (found.x_m !== row.x_m || found.y_m !== row.y_m) {
        moveMarkerTo(found, { x_m: row.x_m, y_m: row.y_m });
      }
      continue;
    }
    placementUid += 1;
    const p = {
      uid: placementUid,
      id: row.id,
      item_id: row.item_id,
      x_m: row.x_m,
      y_m: row.y_m,
      label: row.label ?? null,
      rank,
      created_by: row.created_by,
    };
    state.placements.push(p);
    renderPlacement(p);
  }

  for (const p of [...state.placements]) {
    if (p.id !== null && !incoming.has(p.id)) removePlacement(p);
  }
  // **ここで詳細パネルを組み直さない。**
  // 組み直すと注記の欄のフォーカスと打ちかけの文字が飛ぶ。初回の読み込みは
  // 人の操作と競るので（置いた直後に配置や地名の取得が着地する）、
  // ここで触ると「置いた直後にそのまま書き始める」導線が壊れる（実測で2回踏んだ）。
  // 取り直しのときだけ必要なので、board/reload.js が最後に1回だけ呼ぶ。
}
