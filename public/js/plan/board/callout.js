// 地名（コールアウト）の操作。置く・動かす・選ぶ・消す・読む。
//
// 描き方そのもの（点と文字）は ../callouts.js。

import { deleteCallout, getCallouts, postCallouts } from "../api.js";
import {
  MAX_CALLOUTS_PER_PLAN, createCallout, namesVisibleAt, setCalloutName, setCalloutTransform,
} from "../callouts.js";
import { say } from "../chrome.js";
import { calloutLayer } from "../dom.js";
import { dropDone, record, recordReplay } from "../history.js";
import { DEFAULT_MODE, canEdit, dropPicked, history, state } from "../state.js";
import { clearZoneKind } from "./area.js";
import { renderDetail } from "./detail.js";
import { clearPick } from "./drawers.js";
import { setMode } from "./tools.js";
import { insideMap, markerScale, pointerToMeters } from "./view.js";

// 保存前（サーバの id が無い間）でも地名を一意に指すための通し番号。
let calloutUid = 0;

// ── 地名（コールアウト）────────────────────────────────────
// 「あの丘」「工場」「北の橋」といった、Discord でそのまま喋る呼び名を地図に置く。
//
// 実体は**この作戦の中だけ**（session_callouts）。同じマップでも試合ごとに注目する
// 場所が変わるので、作戦によって呼び名を変えたり要らない地名を消したりできる。
// ここで直しても他の作戦の地名は変わらない。
//
// 操作モデルは配置とまったく同じ: ドラッグはパン、クリックだけで置く。自分の
// 地名はそのままドラッグで動かせる。他人のものは動かせず、掴んだらパンになる。

/** 地名の点と文字の大きさを画面基準に戻し、名前を出すかどうかも決め直す。 */
export function updateCalloutScale() {
  if (!calloutLayer) return;
  // 広く見ているときは点だけにする（判定は callouts.js）。選択中とホバーは CSS 側で戻す。
  calloutLayer.dataset.names = namesVisibleAt(state.view?.w) ? "on" : "off";
  if (!state.coords || state.callouts.length === 0) return;
  const scale = markerScale();
  for (const c of state.callouts) {
    // 他の人が運んでいる最中はそちらの位置のまま（配置と同じ。board/carry.js）。
    if (c.node) setCalloutTransform(c.node, state.coords.toSvg(c.carry ?? c), scale);
  }
}

/** 地名1件を盤面に描く。 */
function renderCallout(c) {
  c.node = createCallout(c);
  if (c.id !== null) c.node.dataset.calloutId = String(c.id);
  // 動かせる地名だけカーソルを変える（押す前に動かせるかが分かるように）。
  if (canEdit(c)) c.node.dataset.mine = "true";
  calloutLayer.appendChild(c.node);
  setCalloutTransform(c.node, state.coords.toSvg(c), markerScale());
}

/**
 * **絵だけを描き直す。** `c.x_m` には触らない（配置の `redrawPlacement` と同じ作法。
 * `c.carry` は他の人が運んでいる途中の位置で、保存された座標は `c.x_m` のまま）。
 */
export function redrawCallout(c) {
  if (!c.node || !state.coords) return;
  setCalloutTransform(c.node, state.coords.toSvg(c.carry ?? c), markerScale());
}

/** 保存される座標を書き換えて、絵もそこへ合わせる。保存そのものはしない。 */
export function moveCalloutTo(c, at) {
  c.x_m = at.x_m;
  c.y_m = at.y_m;
  redrawCallout(c);
}

export function removeCallout(c) {
  c.node?.remove();
  const i = state.callouts.indexOf(c);
  if (i !== -1) state.callouts.splice(i, 1);
  dropDone(history(), (e) => e.callout === c);
  // 範囲選択で選んでいた列からも外す（消えたものを掴み続けない）。
  dropPicked(c);
  if (state.selectedCallout === c) selectCallout(null);
}

/** 選択中の地名だけを強調する。配置・スタンプの選択とは排他（パネルは1枚しかない）。 */
export function selectCallout(c) {
  state.selectedCallout = c;
  state.selected = null;
  state.selectedStamp = null;
  for (const p of state.placements) {
    p.marker?.classList.remove("sel");
    p.range?.classList.remove("sel");
  }
  for (const s of state.stamps) s.node?.classList.remove("sel");
  for (const other of state.callouts) other.node?.classList.toggle("sel", other === c);
  renderDetail();
}

/** 呼び名を書き換えて、地図の文字もその場で合わせる（保存はしない）。 */
export function applyCalloutName(c, name) {
  c.name = name;
  if (c.node) setCalloutName(c.node, name);
}

/** 更新する対象の id を確かめる。まだ保存中なら終わるのを待つ。 */
export async function calloutId(c) {
  try {
    return c.id ?? (await c.saving);
  } catch {
    removeCallout(c);
    return null;
  }
}

/**
 * その地点に地名を置く。
 *
 * 既定の名前はその地点のセル名（`H8` など）。`name` は空にできないので何かを
 * 入れる必要があるが、「無題」より**そのまま使える呼び名**にしておく。
 * 置いた直後に欄へ入って全選択するので、上書きして打てばそのまま改名になる。
 */
export async function placeCalloutAt(point) {
  const at = pointerToMeters(point);
  if (!insideMap(at)) {
    say("マップの外です。マップの上を押してください。");
    return;
  }

  await addCallout({ name: state.coords.cellOf(at) ?? "地名", x_m: at.x_m, y_m: at.y_m });
}

/**
 * 地名を1件作って保存する。**置く経路とやり直しの経路が共有する唯一の実体。**
 *
 * `replay` のときに変える所は2つ（配置の `addPlacement` と同じ作法）。
 *   1. 呼び名の欄にフォーカスしない（やり直しは「書き始める」操作ではない）
 *   2. 台帳に積むのに `recordReplay` を使う（やり直しの山を捨てない）
 *
 * 件数の上限と座標の確認は呼ぶ側の受け持ちにしない——**やり直しでも上限に当たる**
 * （戻したあとに他の人が置いて埋まることがある）ので、ここで見る。
 *
 * 戻り値は作った地名、保存できなければ null。
 */
export async function addCallout(seed, { replay = false } = {}) {
  if (state.callouts.length >= MAX_CALLOUTS_PER_PLAN) {
    if (!replay) {
      say(
        `地名は1つの作戦に${MAX_CALLOUTS_PER_PLAN}件までです。要らないものを消してください。`,
        true
      );
    }
    return null;
  }

  const { name } = seed;
  calloutUid += 1;
  const c = {
    uid: calloutUid,
    id: null,
    name,
    x_m: seed.x_m,
    y_m: seed.y_m,
    created_by: state.me.user.id,
  };
  state.callouts.push(c);
  renderCallout(c);
  selectCallout(c);
  // 置いた直後に打ち替えられるようにする。既定値は全選択しておく
  // （消してから打ち直させない）。
  if (!replay) {
    const input = document.getElementById("callout-name");
    input?.focus();
    input?.select();
  }
  // 取り消しの台帳に、線・配置と同じ列へ操作した順で載せる。
  const entry = { callout: c };
  if (replay) recordReplay(history(), entry);
  else record(history(), entry);

  c.saving = postCallouts(state.plan.session.id, [{
    client_uuid: crypto.randomUUID(),
    name,
    x_m: seed.x_m,
    y_m: seed.y_m,
  }]).then((res) => {
    c.id = res.ids[0];
    if (c.node) c.node.dataset.calloutId = String(res.ids[0]);
    return res.ids[0];
  });

  try {
    await c.saving;
    if (!replay) say(`地名「${name}」を置きました。呼び名を書き換えられます。`);
    return c;
  } catch (e) {
    removeCallout(c);
    if (!replay) say(`地名を置けませんでした。${e.message}`, true);
    return null;
  }
}

/**
 * 直前に置いた地名を取り消す（配置の取り消しとまったく同じ流れ）。
 * **戻せたら true。** 台帳の出し入れは呼ぶ側（board/history.js）がする。
 */
export async function undoCallout(entry) {
  const c = entry.callout;
  const id = await calloutId(c);
  if (id === null) { say("取り消しました。"); return true; }

  try {
    await deleteCallout(state.plan.session.id, id);
    removeCallout(c);
    say("取り消しました。");
    return true;
  } catch (e) {
    say(`取り消せませんでした。${e.message}`, true);
    return false;
  }
}

/**
 * 地名の表示 on/off。置く道具と別にしてあるのは、見る設定と置く操作が別物だから。
 *
 * 伏せるときは置く道具からも抜ける。見えない所に置ける状態を残すと、押しても
 * 何も出てこない（実際は増えている）という、いちばん分かりにくい形になる。
 */
export function setCalloutsVisible(on) {
  state.showCallouts = on;
  // SVG 要素には HTMLElement の `hidden` プロパティが無い（属性で操作する）。
  if (on) calloutLayer.removeAttribute("hidden");
  else calloutLayer.setAttribute("hidden", "");
  document.getElementById("toggle-callouts").setAttribute("aria-pressed", String(on));
  if (!on && state.mode === "callout") setMode(DEFAULT_MODE);
}

/** 地名を置く道具の on/off。入るときはパレットの選択を外す（道具は1つだけ）。 */
export function setCalloutMode(on) {
  if (on) {
    clearPick();
    clearZoneKind();
    // 見えない所に置かせない。置く道具に入ったら必ず地名を出す。
    if (!state.showCallouts) setCalloutsVisible(true);
    setMode("callout");
    say("マップを押すと地名を置きます。押した所のセル名が仮の呼び名になります。");
  } else if (state.mode === "callout") {
    setMode(DEFAULT_MODE);
    say("");
  }
}

/**
 * カタログとは別に地名を読む。ここが失敗しても盤面は壊さない。
 * 戻り値は「読めたか」で、呼び出し側が #status を消すかを決める。
 */
export async function loadCallouts() {
  try {
    showCallouts((await getCallouts(state.plan.session.id)).callouts);
    return true;
  } catch (e) {
    say(`地名を取得できませんでした。${e.message}`, true);
    return false;
  }
}

/**
 * サーバから来た地名の列に、画面を合わせる。
 *
 * **配置（place.js の `showPlacements`）とまったく同じ作法**で、
 * 作り直さずに差分で当てる。理由もあちらと同じ（取り消しの台帳・選択・
 * 掴んでいる最中のものを壊さない）。
 */
export function showCallouts(rows) {
  const byId = new Map(state.callouts.filter((c) => c.id !== null).map((c) => [c.id, c]));
  const incoming = new Set();

  for (const row of rows) {
    incoming.add(row.id);
    const found = byId.get(row.id);
    if (found) {
      if (found.name !== row.name) applyCalloutName(found, row.name);
      if (found.x_m !== row.x_m || found.y_m !== row.y_m) {
        moveCalloutTo(found, { x_m: row.x_m, y_m: row.y_m });
      }
      continue;
    }
    calloutUid += 1;
    const c = {
      uid: calloutUid,
      id: row.id,
      name: row.name,
      x_m: row.x_m,
      y_m: row.y_m,
      created_by: row.created_by,
    };
    state.callouts.push(c);
    renderCallout(c);
  }

  for (const c of [...state.callouts]) {
    if (c.id !== null && !incoming.has(c.id)) removeCallout(c);
  }
  // 読み込みは applyView より後なので、名前を出すかどうかをここで決め直す。
  updateCalloutScale();
  // 詳細パネルはここで組み直さない（理由は place.js の showPlacements と同じ）。
}
