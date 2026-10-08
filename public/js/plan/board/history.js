// 「戻す」と「やり直す」の入口。4種類（線・配置・エリア・地名）の振り分けだけを持つ。
//
// EN: The entry points for undo and redo. This file only dispatches over the four
//     kinds; each kind's own handling lives in its own module. Redo re-runs the
//     creation path, so the new row's id lands in a *fresh* ledger entry — no id is
//     ever rewritten, which is why "undo after redo" works.
//
// 台帳は**1本**で、線・配置・エリア・地名が操作した順に混ざって入っている
// （`state.mine`）。末尾から種類を見て戻す。「線だけ取り消せる」と、誤って置いた
// ものを消す手段がパレットと詳細を開き直す経路しか無くなる（オーナー報告の不具合3）。
//
// ── やり直しが id を書き換えない理由 ─────────────────────────
// 戻す ＝ DELETE、やり直す ＝ もう一度 POST なので新しい id が振られる。
// ここでは**置く経路をもう一度通し、その結果を新しい項目として積む**
// （`addPlacement(..., { replay: true })` など）。台帳の項目はオブジェクトの
// 参照を持ち、`id` は POST の `.then()` が入れるので、新しい id は自然に入る。
// **書き換える工程が無いので、書き忘れる場所も無い。**
//
// ── 「戻す」は空でも押せるままにする ────────────────────────
// 無効にしてはいけない。`e2e/plan-whiteboard.spec.js` の `drawLine()` が
// **「取り消す が押せること」を「道具が使えるようになった合図」として使っている**ので、
// 対称性のつもりで無効にすると、あのファイルの線を引くテストが広範囲で落ちる。
// 空のときは今までどおり理由を言う。**無効にするのは `やり直す` だけ。**

import { batchCalls } from "../api.js";
import { say } from "../chrome.js";
import {
  canRedo, onHistoryChange, pushUndone, restoreDone, snapshotOf, takeRedo, takeUndo,
} from "../history.js";
import { history, state } from "../state.js";
import { commitArea, undoArea } from "./area.js";
import { addCallout, undoCallout } from "./callout.js";
import { addPlacement, undoPlacement } from "./place.js";
import { saveStroke, undoStroke } from "./tools.js";

/**
 * 1つ戻す。確認は出さない（押した結果はすぐ画面に出るので、聞き返すほうが手を止める）。
 *
 * 戻せたら**写しをやり直しの山へ移す。** 戻せなかったら台帳へ返す
 * （どちらか片方にだけ居る状態を保つ）。
 */
export async function undo() {
  const h = history();
  const entry = takeUndo(h);
  if (entry === undefined) { say("取り消せる操作がありません。"); return; }

  // **写しは戻す前に取る。** 戻したあとでは、画面のオブジェクトがもう消えている。
  const snapshot = snapshotOf(entry);
  const ok = entry.placement ? await undoPlacement(entry)
    : entry.callout ? await undoCallout(entry)
      : entry.area ? await undoArea(entry)
        : await undoStroke(entry);

  if (!ok) { restoreDone(h, entry); return; }
  // 中身を持たない項目（やり直せないもの）は山に積まない。
  // 積むと「押せるのに何も起きない」やり直しができる。
  if (snapshot) pushUndone(h, snapshot);
}

/**
 * 1つやり直す。
 *
 * **1回ぶんをまとめ操作として扱う**（`batchCalls`）。配置の優先度は
 * `POST /placements` に乗らないので POST + PATCH の2往復になることがあり、
 * 素朴に流すと `chg` が2通飛ぶ。
 *
 * **通らなかったら黙って捨てる。** 他の人が作戦ごと消した、地名の上限に当たった、
 * 権限が無くなった、などで作り直せないことがある。その項目を山から落として終わり。
 * 画面を壊さない・エラーで止めない（仕様 §1）。
 */
export async function redo() {
  const h = history();
  const snapshot = takeRedo(h);
  if (snapshot === undefined) { say("やり直せる操作がありません。"); return; }

  let made = null;
  try {
    made = await batchCalls(() => replay(snapshot));
  } catch {
    made = null;
  }
  if (made) say("やり直しました。");
  else say("やり直せませんでした。", true);
}

/** 写し1件を作り直す。作れたら作ったもの、作れなければ null。 */
function replay(snapshot) {
  if (snapshot.kind === "placement") return addPlacement(snapshot, { replay: true });
  if (snapshot.kind === "callout") return addCallout(snapshot, { replay: true });
  if (snapshot.kind === "area") {
    return commitArea(snapshot.areaKind, snapshot.op, snapshot.rects, {
      replay: true, cellM: snapshot.cell_m,
    });
  }
  if (snapshot.kind === "ink") return saveStroke(snapshot, { replay: true });
  return null;
}

/**
 * 「やり直す」のボタンを、山の中身に合わせる。
 *
 * **押せるのに何も起きないボタンを置かない**（仕様の受け入れ条件5）。
 *
 * **`setEditable()` のあとに呼び直すこと。** あれは棚のボタンを名前も見ずに
 * 全部書き換えるので（`chrome.js`）、ここで立てた「押せない」を押せる側へ戻す。
 * 呼び直しは app.js の1箇所。
 *
 * 書けない作戦（読専・ゲスト・API 不通）では `setEditable(false)` が
 * 止めたままにする——やり直せる操作がそもそも生まれない。
 */
export function syncHistoryButtons() {
  const btn = document.getElementById("redo");
  if (!btn) return;
  btn.disabled = !state.editable || !canRedo(history());
}

/** ボタンを繋ぐ。山が動いたら押せる・押せないを合わせ直す。 */
export function wireHistory() {
  document.getElementById("undo")?.addEventListener("click", undo);
  document.getElementById("redo")?.addEventListener("click", redo);
  onHistoryChange(syncHistoryButtons);
  syncHistoryButtons();
}
