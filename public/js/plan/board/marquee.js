// 範囲選択（「選択」の道具）。枠で囲ってまとめて消す・まとめて動かす。
//
// EN: Marquee selection. Drag a box to pick the placements and callouts inside it,
//     then delete or move them as a group. There is no bulk API, so a group action
//     is N single calls wrapped in batchCalls() so that only one change notice goes
//     out. Geometry lives in ../marquee.js (pure); this file is the operations.
//
// オーナーの要望（D-062）: 「マップにおけるアイテムが小さい場合、再度選択するのが
// つらいですね。Powerpoint みたいに範囲選択して削除とかできるといいなと。」
//
// 枠の計算（矩形・中にあるか・件数の文言）は ../marquee.js。ここは操作と描き替え。
//
// ── 3つの決めごと ───────────────────────────────────────────
// 1. **対象は配置と地名だけ**（v1）。線は消しゴムが、エリアは塗りの取り消しがある
// 2. **自分のものしか動かせない・消せない。** サーバが 403 を返す（admin は例外）ので、
//    **押せるのに 403 になる形にしない。** 枠に入った他人のものは薄く見せて、
//    件数を「7件を選択（うち自分のもの 4件）」と分けて出す
// 3. **まとめ操作の通知は1回。** DELETE も PATCH も1件ずつしか無いので、
//    20件消すと api.js の call() を20回通る。`batchCalls` でくるんで1通にする

import { batchCalls, deleteCallout, deletePlacement, patchCallout, patchPlacement } from "../api.js";
import { say } from "../chrome.js";
import { SVG_NS, bandLayer, board } from "../dom.js";
import { mineOf, normalizeBox, pickInBox, selectionText } from "../marquee.js";
import { canEdit, state } from "../state.js";
import { movedBeyond, tapSlop } from "../util.js";
import { moveCalloutTo, removeCallout, selectCallout } from "./callout.js";
import { renderDetail } from "./detail.js";
import { moveMarkerTo, removePlacement, selectPlacement } from "./place.js";
import { insideMap, pointerToMeters } from "./view.js";

/** 枠に入れられるもの（配置と地名）。**伏せているものは選ばない。** */
function selectable() {
  const out = [];
  // 見えていないものを選ばせない。「地名を表示」を切った状態で囲って消すと、
  // 見えない所から物が消えることになる（置く道具と同じ決まり）。
  for (const p of state.placements) out.push(p);
  if (state.showCallouts) for (const c of state.callouts) out.push(c);
  return out;
}

/** その物が配置か地名かを、持っている項目で見分ける（種類の札を増やさない）。 */
const isCallout = (o) => state.callouts.includes(o);

/** 種類ごとの差分。pointer.js の DRAGGABLE と同じ作法で、分岐を散らさない。 */
const KIND = {
  placement: {
    move: (o, at) => moveMarkerTo(o, at),
    save: (id, at) => patchPlacement(state.plan.session.id, id, at),
    remove: (o) => removePlacement(o),
    del: (id) => deletePlacement(state.plan.session.id, id),
  },
  callout: {
    move: (o, at) => moveCalloutTo(o, at),
    save: (id, at) => patchCallout(state.plan.session.id, id, at),
    remove: (o) => removeCallout(o),
    del: (id) => deleteCallout(state.plan.session.id, id),
  },
};

const kindOf = (o) => (isCallout(o) ? KIND.callout : KIND.placement);

/** 画面の要素（マーカー・地名）を持っている物。 */
const nodeOf = (o) => (isCallout(o) ? o.node : o.marker);

// ── 選んだものの印 ─────────────────────────────────────────
// **新しい見た目の語彙を足さない。** 選択の青（`.sel`）をそのまま使い、
// 他人のものだけ `data-picked="other"` で薄くする（§3 の「無効」と同じ .45）。

function markPicked(sel) {
  for (const o of state.placements.concat(state.callouts)) {
    const node = nodeOf(o);
    if (node) delete node.dataset.picked;
  }
  if (!sel) return;
  for (const o of sel.items) {
    const node = nodeOf(o);
    if (node) node.dataset.picked = canEdit(o) ? "mine" : "other";
  }
}

/**
 * 選択を置き換える。0件なら解く。
 *
 * **1件だけの選択（詳細パネル）とは排他。** どちらを選んでいるのか分からない
 * 状態を作らないため、まとめて選んだら1件の選択は外す（パネルは1枚しかない）。
 */
export function setPicked(items) {
  if (items.length === 0) { clearPicked(); return; }
  // 先に1件の選択を外す。**`state.picked` を立てる前に外す**ので、
  // selectPlacement(null) が走らせる renderDetail は空の検視台を描いて終わる。
  selectPlacement(null);
  selectCallout(null);
  state.picked = { items: [...items], mine: mineOf(items, canEdit) };
  markPicked(state.picked);
  renderDetail();
  say(selectionText(state.picked.items.length, state.picked.mine.length));
}

/**
 * 選択を解く（Esc / 枠の外を押す / 道具を切り替える / 0件の枠）。
 *
 * **`state.picked` が既に null でも後片付けをする。** まとめて消し切ったときは
 * `dropPicked`（state.js）が最後の1件を外した時点で null にしているので、
 * ここで早く帰ると**検視台に「選んだ4件を消す」が出たまま残る**（実測で踏んだ）。
 */
export function clearPicked() {
  state.picked = null;
  markPicked(null);
  renderDetail();
}

// ── 枠を引く ───────────────────────────────────────────────

/** 枠を引き始める。マップの外から引き始めた枠は受け付けない（線と同じ扱い）。 */
export function beginBand(evt) {
  const at = pointerToMeters(evt);
  if (!insideMap(at)) {
    say("マップの外です。マップの上から囲ってください。");
    return false;
  }
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("class", "band");
  bandLayer.appendChild(rect);
  state.band = {
    from: at, to: at, rect,
    start: { x: evt.clientX, y: evt.clientY },
    slop: tapSlop(evt.pointerType),
  };
  drawBand();
  board.setPointerCapture(evt.pointerId);
  return true;
}

export function bandMove(evt) {
  state.band.to = pointerToMeters(evt);
  drawBand();
}

/** 枠を今の矩形に合わせる。座標はメートル（＝ SVG ユーザー単位）。 */
function drawBand() {
  const { from, to, rect } = state.band;
  const box = normalizeBox(from, to);
  const svg0 = state.coords.toSvg({ x_m: box.x0, y_m: box.y0 });
  const svg1 = state.coords.toSvg({ x_m: box.x1, y_m: box.y1 });
  rect.setAttribute("x", Math.min(svg0.x, svg1.x));
  rect.setAttribute("y", Math.min(svg0.y, svg1.y));
  rect.setAttribute("width", Math.abs(svg1.x - svg0.x));
  rect.setAttribute("height", Math.abs(svg1.y - svg0.y));
}

/** 引きかけの枠を捨てる（2本目の指が触れたとき、pointercancel）。 */
export function cancelBand() {
  if (!state.band) return;
  state.band.rect.remove();
  state.band = null;
}

/**
 * 枠を離した。中のものを選ぶ。
 *
 * **閾値を超えずに離した（押しただけ）なら選択を解く。** 「枠の外を押す」が
 * 解除になっている（仕様 §2）ので、点を押したときは解除として扱う。
 */
export function endBand(b, evt) {
  if (!movedBeyond(b.start, evt, b.slop)) { clearPicked(); return; }
  setPicked(pickInBox(selectable(), normalizeBox(b.from, b.to)));
}

// ── まとめて動かす ─────────────────────────────────────────

/** 選んだもののどれかを掴んだか（掴めるのは自分のものだけ）。 */
export function pickedHit(target) {
  const sel = state.picked;
  if (!sel || !(target instanceof Element)) return null;
  const node = target.closest("#placements [data-uid], #callouts [data-uid]");
  if (!node) return null;
  const uid = Number(node.dataset.uid);
  return sel.mine.find((o) => o.uid === uid && nodeOf(o) === node) ?? null;
}

/**
 * まとめて運び始める。**動かすのは自分のものだけ。**
 *
 * **運んでいる最中を相手の画面に流さない**（v1 の割り切り。仕様 §2）。
 * D-069 の仕組み（`sendCarry`）は1個を前提にしていて、複数を載せると通が太る。
 * 落とした結果は `chg` で届くので、途中が見えないだけ。
 */
export function beginBandDrag(evt) {
  // **列は複製して持つ。** 運んでいる間に他の人がこの中の物を消すと
  // `dropPicked`（state.js）が `state.picked.mine` を縮めるので、
  // 参照のまま持つと `from` の添字と中身がずれる。
  const items = [...state.picked.mine];
  state.bandDrag = {
    items,
    from: items.map((o) => ({ x_m: o.x_m, y_m: o.y_m })),
    start: { x: evt.clientX, y: evt.clientY },
    slop: tapSlop(evt.pointerType),
    at: pointerToMeters(evt),
    moved: false,
  };
  board.setPointerCapture(evt.pointerId);
}

export function bandDragMove(evt) {
  const d = state.bandDrag;
  if (!d.moved) {
    if (!movedBeyond(d.start, evt, d.slop)) return;
    d.moved = true;
    board.dataset.dragging = "true";
  }
  const now = pointerToMeters(evt);
  const dx = now.x_m - d.at.x_m;
  const dy = now.y_m - d.at.y_m;
  d.items.forEach((o, i) => {
    kindOf(o).move(o, { x_m: d.from[i].x_m + dx, y_m: d.from[i].y_m + dy });
  });
}

/** 運びかけを元に戻す（2本目の指、pointercancel）。 */
export function cancelBandDrag() {
  const d = state.bandDrag;
  if (!d) return;
  state.bandDrag = null;
  delete board.dataset.dragging;
  if (!d.moved) return;
  restore(d);
}

const restore = (d) => d.items.forEach((o, i) => kindOf(o).move(o, d.from[i]));

/**
 * 落としたときの確定。**N 件の PATCH をまとめ操作にして、通知を1回にする。**
 *
 * 1件でもマップの外へ出たら**全部を元へ戻す。** 一部だけ置いて一部だけ戻すと、
 * 選んだ形（相対位置）が崩れる——まとめて動かす意味が無くなる。
 */
export async function endBandDrag(d) {
  delete board.dataset.dragging;
  if (!d.moved) return;

  if (d.items.some((o) => !insideMap({ x_m: o.x_m, y_m: o.y_m }))) {
    restore(d);
    say("マップの外です。マップの上へ動かしてください。");
    return;
  }

  // **まとめ操作の最中は盤面を取り直させない**（board/reload.js の `boardBusy`）。
  // 指は離れていてポインタも触れていないので、これが無いと他の人の `chg` が
  // 着地して、まだ保存していない座標がサーバの古い値へ引き戻される。
  state.bulk = true;
  let failed = 0;
  try {
    await batchCalls(async () => {
      for (const o of d.items) {
        const at = { x_m: o.x_m, y_m: o.y_m };
        let id;
        try {
          id = o.id ?? (await o.saving);
        } catch {
          continue;   // 保存自体が失敗していた。もう画面に無い
        }
        try {
          await kindOf(o).save(id, at);
        } catch {
          // 断られた1件だけ元へ戻す（通った物は動いたまま。全部戻すと、
          // 成功した書き込みと画面が食い違う）。
          const i = d.items.indexOf(o);
          kindOf(o).move(o, d.from[i]);
          failed += 1;
        }
      }
    });
  } finally {
    state.bulk = false;
  }

  const moved = d.items.length - failed;
  say(failed === 0
    ? `${moved}件を動かしました。`
    : `${moved}件を動かしました。${failed}件は動かせませんでした。`, failed > 0);
}

// ── まとめて消す ───────────────────────────────────────────

/**
 * 選んだもののうち**自分のものだけ**を消す。
 *
 * **通知は1回**（`batchCalls`）。20件消して20通飛ばすと、相手は20回取り直す。
 * 他人のものは最初から対象外なので、403 は出ない（件数で先に見せてある）。
 */
export async function deletePicked() {
  const sel = state.picked;
  if (!sel || sel.mine.length === 0) return;
  const targets = [...sel.mine];

  state.bulk = true;
  let failed = 0;
  try {
    await batchCalls(async () => {
      for (const o of targets) {
        const kind = kindOf(o);
        let id;
        try {
          id = o.id ?? (await o.saving);
        } catch {
          kind.remove(o);   // 保存自体が失敗していた。画面から外して済んだ扱い
          continue;
        }
        try {
          await kind.del(id);
          kind.remove(o);
        } catch {
          failed += 1;
        }
      }
    });
  } finally {
    state.bulk = false;
  }

  const gone = targets.length - failed;
  // 消し終わって1件も残らなければ選択を解く（`removePlacement` が
  // `dropPicked` 経由で列から外すので、ふつうはここで空になっている）。
  if (!state.picked || state.picked.items.length === 0) clearPicked();
  else { state.picked.mine = mineOf(state.picked.items, canEdit); renderDetail(); }
  say(failed === 0
    ? `${gone}件を消しました。`
    : `${gone}件を消しました。${failed}件は消せませんでした。`, failed > 0);
}
