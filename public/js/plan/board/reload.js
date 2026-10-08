// 誰かが保存したときに、盤面を取り直して差分を当てる。
//
// EN: Re-fetches the board and applies the difference when somebody else saves. The
//     Durable Object only ever says "something changed", so the receiver calls the
//     existing GET and D1 stays the single source of truth. changes.js decides when
//     this runs.
//
// **DO は「何かが変わった」としか言わない**（`{"t":"chg"}` に中身は載っていない）。
// 載せると DO が盤面の形を知ることになり、スキーマを変えるたびに DO も直す羽目に
// なる。受け取った側が既存の GET を叩くので、**D1 が唯一の真実**のままになる。
//
// いつ走らせるかは changes.js が決める（300ms デバウンス、操作中は保留）。
// ここは「走らせると決まったときに何をするか」だけ。

import { getCallouts, getPlacements, getPlan } from "../api.js";
import { inkLayer } from "../dom.js";
import { renderStroke } from "../render.js";
import { state } from "../state.js";
import { refreshAreas } from "./area.js";
import { showCallouts } from "./callout.js";
import { refreshDetail, renderDetail } from "./detail.js";
import { settleLive } from "./live.js";
import { showPlacements } from "./place.js";

/**
 * 保存の途中のものが1つでもあるか。
 *
 * **あるうちは取り直さない。** サーバはまだその行を知らないので、
 * いま取り直すと「置いた瞬間に自分のものが消える」ことになる。
 * 保存が終われば `id` が入る（線は `dataset.strokeId`）ので、
 * 数ミリ秒〜数百ミリ秒遅らせれば必ず解消する。
 *
 * 落ちた保存は呼び出し元が画面から取り除く（`removePlacement` など）ので、
 * ここで永久に待ち続けることはない。
 */
export const hasPendingSave = () =>
  state.placements.some((p) => p.id === null)
  || state.callouts.some((c) => c.id === null)
  || state.areas.some((a) => a.id === null || a.id === undefined)
  || state.mine.some((e) => e.path && !e.path.dataset.strokeId);

/**
 * いま盤面を作り直してはいけないか。
 *
 * ドラッグ中・描いている最中・塗っている最中・ピンチ中に作り直すと、
 * **手元の操作が消える**。欄に文字を打っている間も同じ（詳細パネルは
 * 作り直しで組み直される）。
 *
 * **まとめ操作（`state.bulk`）もここで止める。** まとめて動かす・まとめて消すは
 * **指を離したあとに N 回の PATCH / DELETE が流れる**ので、その間ポインタは
 * 触れていないし `drag` も無い。止めないと他の人の `chg` が着地して、
 * まだ保存していない座標がサーバの古い値へ引き戻される（消す途中のものは生え直す）。
 */
export function boardBusy(active = document.activeElement) {
  if (state.drag || state.drawing || state.paint || state.pan || state.pinch) return true;
  if (state.bandDrag || state.band || state.bulk) return true;
  if (state.pointers.size > 0) return true;
  if (active && /^(input|textarea|select)$/i.test(active.tagName)) return true;
  return hasPendingSave();
}

/**
 * 盤面を取り直す。**投げる**（握りつぶすのは changes.js の仕事）。
 *
 * 取り直すのは「人が編集するもの」だけ:
 *   線 / エリア … `GET /api/sessions/:id` に相乗り（初回と同じ1往復）
 *   配置 / 地名 … それぞれの GET
 *
 * マップ・タワー・スポーンは取り直さない（マップ静的で、変わらない）。
 * **「どのパターンを想定するか」（zone preset）も取り直さない** — 作戦ごとに
 * 一度決める設定で、取り直すと admin が入力中の円の欄まで作り直すことになる。
 * ここは R1 の受け入れ条件（配置が1秒以内に反映される）の外。
 */
export async function reloadBoard() {
  const id = state.plan?.session?.id;
  if (!id) return;
  try {
    await applyBoard(id);
  } finally {
    // **他の人が「やっている最中」として見せていたものを、ここで片付ける。**
    // 運び終えた物の絵は本当の座標へ戻り、引き終わった線は消える（確定した線は
    // 上の `applyBoard` が既に置いている）。
    //
    // 片付けをこの着地まで預けてあるのは、離した瞬間に片付けると保存された値が
    // 届くまでの数百ミリ秒だけ「元の位置へ跳ね返る」「線が一瞬消える」が
    // 見えるため（board/live.js）。
    // **失敗しても呼ぶ**（呼ばないと預けたものが永久に残る）。
    settleLive();
  }
}

async function applyBoard(id) {
  const [plan, placements, callouts] = await Promise.all([
    getPlan(id),
    getPlacements(id),
    getCallouts(id),
  ]);

  // 線も id で突き合わせる。**作り直さない。**
  // 取り消しの台帳（`state.mine`）が `path` の参照を持っているので、
  // 作り直すと台帳の参照が画面から外れた要素を指す。そうなると
  // 「取り消しを押すとサーバからは消えるのに、画面には残り続ける」
  // （次の取り直しまで直らない）という形で壊れる。
  //
  // 保存の途中の線は `data-stroke-id` をまだ持たないので、この突き合わせに
  // 引っかからない ＝ 触らない（`hasPendingSave` でそもそも待つが、保険）。
  const have = new Map();
  for (const node of inkLayer.querySelectorAll("path[data-stroke-id]")) {
    have.set(node.dataset.strokeId, node);
  }
  const incoming = new Set();
  for (const stroke of plan.strokes) {
    const key = String(stroke.id ?? "");
    incoming.add(key);
    if (!have.has(key)) inkLayer.appendChild(renderStroke(stroke, state.coords));
  }
  for (const [key, node] of have) {
    if (!incoming.has(key)) node.remove();
  }

  // エリアは追記型の op ログ。id 昇順に適用し直すだけで和集合になる
  // （2人が別のセルを塗っても競合しない。調査 §5.6）。
  state.areas = Array.isArray(plan.areas) ? [...plan.areas] : [];
  refreshAreas();

  showPlacements(placements.placements);
  showCallouts(callouts.callouts);

  // 開いている詳細パネルを今の値に合わせる（他の人が動かした座標など）。
  // **取り直しのときだけ。** 初回の読み込みでやると、置いた直後の注記の欄から
  // フォーカスと打ちかけの文字を奪う（実測で2回踏んだので show* からは外した）。
  // ここへ来る時点で欄に入力中でないことは `boardBusy()` が保証している。
  if (state.selected) refreshDetail(state.selected);
  else if (state.selectedCallout) refreshDetail(state.selectedCallout);
  // 範囲選択の件数も出し直す。他の人が選択の中の物を消していれば
  // `dropPicked` が列から外しているので、出している数が古いままになる。
  else if (state.picked) renderDetail();
}
