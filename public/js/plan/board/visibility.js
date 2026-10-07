// 作戦の公開設定の欄（ヘッダの「公開 ▾」）と、書き込めない人に出す札。
//
// 仕様: docs/superpowers/specs/2026-10-02-plan-visibility.md
//
// ── 置き場 ─────────────────────────────────────────────────
// **作戦の画面**に置く（一覧ではない）。中身を見ながら決めるものなので。
//
//   作った人   … ヘッダ右の「公開 ▾」。3つの札から選ぶ
//   他の人     … ヘッダ左の「見るだけ」の札（`public` のときだけ）
//
// **読専で公開されていることは書き込めない人にも見せる。** 道具の棚ごと
// 押せなくなるので、理由がどこにも無いと「壊れている」に見える。
//
// ── `<select>` を使わない ────────────────────────────────────
// D-051。実機（Windows Chrome）で選択肢が薄いグレー地に薄いグレー文字になり
// 読めなかった。1択は `.choice`（ARIA radiogroup）で出す。

import { patchVisibility } from "../api.js";
import { say } from "../chrome.js";
import { createChoice } from "../choice.js";
import {
  readOnlyBadge, visibilityChoiceEl, visibilityMenu, visibilityNoteEl, visibilityValueEl,
} from "../dom.js";
import { state } from "../state.js";
import {
  GUEST_VIEW_ONLY, VISIBILITY_CHOICES, WRITE_DENIED, canWrite, normalizeVisibility,
  visibilityNote, visibilityShort,
} from "../visibility.js";

/** いま開いている作戦に自分が書き込めるか（公開設定の層）。 */
export const canWriteHere = () => canWrite(state.plan?.session, state.me?.user);

/** いま開いている作戦を自分が作ったか（＝公開設定を変えられるか）。 */
const isMine = () =>
  state.plan?.session?.created_by === state.me?.user?.id
  || state.me?.user?.role === "admin";

/**
 * 公開設定の欄と札を組み立てる。**盤面を開いたときに1回だけ呼ぶ。**
 *
 * 保存は押した瞬間に走る（「保存」ボタンを置かない）。1択の欄は選び直しが
 * 1手なので、確認を挟む価値が無い。失敗したら元の値へ戻して理由を出す。
 */
export function wireVisibility() {
  const session = state.plan?.session;
  if (!session) return;

  showReadOnlyBadge();
  if (!isMine()) return;
  if (!visibilityMenu || !visibilityChoiceEl) return;

  let current = normalizeVisibility(session.visibility);

  const paint = () => {
    if (visibilityValueEl) visibilityValueEl.textContent = visibilityShort(current);
    if (visibilityNoteEl) visibilityNoteEl.textContent = visibilityNote(current);
    // aria-label は中身を上書きするので、ここに値を入れないと読み上げから
    // 「いまどれか」が消える（#account の summary と同じ理由）。
    const summary = visibilityMenu.querySelector("summary");
    if (summary) {
      summary.setAttribute("aria-label", `この作戦の公開設定（${visibilityShort(current)}）`);
    }
  };

  const choice = createChoice({
    el: visibilityChoiceEl,
    labelledBy: "visibility-head",
    onChange: (next) => save(next),
  });
  choice.setOptions(
    VISIBILITY_CHOICES.map((c) => ({ value: c.value, text: c.text, title: c.note })),
    current
  );
  paint();
  visibilityMenu.hidden = false;

  async function save(next) {
    if (next === current) return;
    const previous = current;
    // 押した瞬間に値を進める（押したのに何も変わらない間を作らない）。
    current = next;
    paint();
    choice.setDisabled(true);
    try {
      const res = await patchVisibility(session.id, next);
      // サーバが返した値を正とする（丸めや将来の既定値の違いを画面に残さない）。
      current = normalizeVisibility(res.visibility);
      session.visibility = current;
      paint();
      say(visibilityNote(current));
    } catch (e) {
      current = previous;
      paint();
      choice.value = previous;
      say(`公開設定を変えられませんでした。${e.message}`, true);
    } finally {
      choice.setDisabled(false);
    }
  }
}

/**
 * 「見るだけ」の札。**書き込めない人にだけ出す。**
 *
 * 作成者と admin には出さない（あちらは公開設定の欄に値が出ているので、
 * 同じことを2箇所で言わない）。
 *
 * **札の文字は短いまま、理由だけを人によって変える。**
 * 書けない理由は2つあって（公開設定が読専／ログインしていない）、
 * **直し方が違う**ので同じ文で済ませない。札に長い文を入れないのは、
 * 固定幅の札が隣の作戦名と幅を奪い合うため（D-070 で実測した失敗）。
 */
function showReadOnlyBadge() {
  if (!readOnlyBadge) return;
  const show = !canWriteHere();
  readOnlyBadge.hidden = !show;
  if (show) readOnlyBadge.title = state.me?.user?.guest ? GUEST_VIEW_ONLY : WRITE_DENIED;
}
