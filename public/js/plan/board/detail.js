// 選んだものの詳細パネル。**1枚を配置と地名で使い回す**（選べるのは片方だけ）。
//
// 読む所（カタログの値）と書く所（自分たちの判断）を分けて、書く所を先に出す。

import { deleteCallout, deletePlacement, deleteStamp, patchCallout, patchPlacement } from "../api.js";
import { NAME_MAX_LEN } from "../callouts.js";
import { NOTE_MAX_LEN, isVector, stampSide } from "../stamps.js";
import { createChoice } from "../choice.js";
import { say } from "../chrome.js";
import { detailEl } from "../dom.js";
import {
  FOB_RANGE_NOTE, FOB_SIDE_M, HOTZONE_RADIUS_M, KINDS, LABEL_MAX_LEN, RANK_CHOICES, costText,
  hasMinRange, isFob, isHotzone, isUnverified, rangeText,
} from "../placements.js";
import { selectionText } from "../marquee.js";
import { clearChildren } from "../render.js";
import { canEdit, state } from "../state.js";
import { WRITE_DENIED } from "../visibility.js";
import { applyCalloutName, calloutId, removeCallout, selectCallout } from "./callout.js";
import {
  applyStampNote, defOf, removeStamp, saveStampAt, selectStamp, stampId,
} from "./stamp.js";
import { clearPicked, deletePicked } from "./marquee.js";
import {
  applyLabel, applyRank, placementId, removePlacement, selectPlacement,
} from "./place.js";

/**
 * 1択の欄の見出し。
 *
 * `<label for>` は `<input>` や `<select>` にしか効かないので、1択の欄
 * （`role="radiogroup"` の `div`）には使えない。`id` を振って
 * `aria-labelledby` から指す。見た目は `<label>` と同じにする
 * （CSS は `#create label, #create .field-label` でまとめてある）。
 */
function fieldLabel(id, text) {
  const el = document.createElement("span");
  el.id = id;
  el.className = "field-label";
  el.textContent = text;
  return el;
}

/**
 * 詳細に出している座標を出し直す。ドラッグ中の1フレームごとには呼ばない
 * （パネルを丸ごと組み直すので、動かしている間ずっとちらつく）。
 * 配置と地名のどちらでも同じ扱いにする（パネルは1枚を使い回している）。
 */
export function refreshDetail(p) {
  if (state.selected === p || state.selectedCallout === p || state.selectedStamp === p) {
    renderDetail();
  }
}

/** 種別の日本語名。未知の kind が来ても生の値を出す（黙って隠さない）。 */
const kindLabel = (kind) => KINDS.find((k) => k.kind === kind)?.label ?? kind ?? "不明";

/**
 * 詳細の1行。`data` を立てると値を等幅で組む。
 * 数値（コスト・射程・座標）は桁が揃って初めて比べられる。
 */
function addRow(dl, term, value, data = false) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  if (data) dd.className = "data";
  dd.textContent = value;
  dl.append(dt, dd);
}

/** 書けない理由。削除ボタンと同じ作法で、押す前に「できない」と理由を見せる。 */
const NO_EDIT_TITLE = "他の人の配置には書けません";

/**
 * 書けない理由は2つあって、**別物なので文を分ける。**
 *
 *   作戦が読専（`public`） … 盤面のどれも触れない。棚ごと止まっている
 *   他の人のもの            … この1件だけ触れない
 *
 * 「権限がありません」でまとめると、どちらなのか画面から分からない。
 * 作戦の層は `state.editable`（app.js が `canWrite` で立てる）が持っている。
 */
const noEditTitle = (own) => (state.editable ? own : WRITE_DENIED);

/** この1件に書けるか。**作戦の層と所有者の層の両方**を満たすときだけ。 */
const canEditHere = (o) => state.editable && canEdit(o);

/**
 * この配置について書く欄（注記と優先度）。
 *
 * 上の <dl> が「カタログが言っていること」なのに対し、こちらは「自分たちが
 * 決めたこと」。位置に紐づく判断を書けることが、この画面の元々の要望の中核。
 *
 * 書けるのは置いた本人と admin だけ（サーバが 403 を返す）。押せるようにして
 * おいて 403 の理由を出すより、押せないことと理由を先に見せる（削除ボタンと同じ）。
 */
function buildEditFields(p) {
  const editable = canEditHere(p);
  const box = document.createElement("div");
  box.className = "edit";

  const noteField = document.createElement("div");
  noteField.className = "field";
  const noteLabel = document.createElement("label");
  noteLabel.htmlFor = "placement-label";
  noteLabel.textContent = "注記";
  const row = document.createElement("div");
  row.className = "row";

  const input = document.createElement("input");
  input.type = "text";
  input.id = "placement-label";
  // サーバ側の上限と同じ。ここを緩めると、入力できるのに保存で 400 になる欄ができる。
  input.maxLength = LABEL_MAX_LEN;
  input.placeholder = "ここ守ろう";
  input.value = p.label ?? "";

  const save = document.createElement("button");
  save.type = "button";
  save.id = "placement-label-save";
  save.textContent = "保存";

  // 優先度も1択の欄（`<select>` は使わない。choice.js の冒頭を参照）。
  // 札は10枚（なし / 1〜9）。**並べたほうが押す手数も減る**（開く → 選ぶ が
  // 1手になる）。数字は等幅で組むので、桁が揃って順位として読める。
  const rank = createChoice({
    id: "placement-rank",
    labelledBy: "placement-rank-label",
    onChange: () => saveRank(p, rank),
  });
  rank.setOptions(
    [{ value: "", text: "なし" }, ...RANK_CHOICES.map((n) => ({ value: String(n), text: String(n) }))],
    Number.isInteger(p.rank) ? String(p.rank) : ""
  );

  if (!editable) {
    for (const el of [input, save]) {
      el.disabled = true;
      el.title = noEditTitle(NO_EDIT_TITLE);
    }
    rank.setDisabled(true);
    rank.el.title = noEditTitle(NO_EDIT_TITLE);
  }

  save.addEventListener("click", () => saveLabel(p, input, save));
  // 1行の欄なので改行の用が無い。Enter でそのまま保存できるようにする
  // （「置く → 書く」を1動作にしたのに、保存でマウスに戻るのでは意味が薄い）。
  input.addEventListener("keydown", (evt) => {
    if (evt.key !== "Enter" || evt.isComposing) return;
    evt.preventDefault();
    saveLabel(p, input, save);
  });

  row.append(input, save);
  noteField.append(noteLabel, row);

  const rankField = document.createElement("div");
  rankField.className = "field";
  const rankLabel = fieldLabel("placement-rank-label", "優先度");
  rankField.append(rankLabel, rank.el);

  box.append(noteField, rankField);
  return box;
}

/**
 * 注記を保存する。楽観更新なので、断られたら元の文字へ戻す
 * （置いたものを動かすときとまったく同じ流れ）。
 */
async function saveLabel(p, input, button) {
  const before = p.label ?? null;
  const next = input.value.trim() || null;
  if (next === before) { say("注記は変わっていません。"); return; }

  button.disabled = true;
  const id = await placementId(p);
  if (id === null) return;

  applyLabel(p, next);
  try {
    await patchPlacement(state.plan.session.id, id, { label: next });
    say(next ? "注記を保存しました。" : "注記を消しました。");
  } catch (e) {
    applyLabel(p, before);
    input.value = before ?? "";
    say(
      e.status === 403
        ? "他の人の配置には書けません。書けるのは置いた本人と管理者だけです。"
        : `注記を保存できませんでした。${e.message}`,
      true
    );
  } finally {
    button.disabled = false;
  }
}

/** 優先度を保存する。注記と同じく楽観更新＋失敗したら元に戻す。 */
async function saveRank(p, rank) {
  const before = Number.isInteger(p.rank) ? p.rank : null;
  const next = rank.value === "" ? null : Number(rank.value);
  if (next === before) return;

  rank.setDisabled(true);
  const id = await placementId(p);
  if (id === null) return;

  applyRank(p, next);
  try {
    await patchPlacement(state.plan.session.id, id, { rank: next });
    say(next === null ? "優先度をなしにしました。" : `優先度を ${next} にしました。`);
  } catch (e) {
    applyRank(p, before);
    rank.value = before === null ? "" : String(before);
    say(
      e.status === 403
        ? "他の人の配置には書けません。書けるのは置いた本人と管理者だけです。"
        : `優先度を変えられませんでした。${e.message}`,
      true
    );
  } finally {
    rank.setDisabled(false);
  }
}

/**
 * 選んだ配置の詳細。
 *
 * 数値は全項目 verified=0 なので、「未検証」のバッジと出典を必ず一緒に出す。
 * 確定値のように見せないことが目的なので、出典は畳まずそのまま出す。
 */
export function renderDetail() {
  if (!detailEl) return;
  // パネルは1枚を配置・地名・範囲選択で使い回す。選べるのは一度に1つだけ。
  // **範囲選択をいちばん先に見る**（まとめて選んだら1件の選択は外れている）。
  if (state.picked) { renderPickedDetail(state.picked); return; }
  if (state.selectedCallout) { renderCalloutDetail(state.selectedCallout); return; }
  if (state.selectedStamp) { renderStampDetail(state.selectedStamp); return; }
  const p = state.selected;
  if (!p) { detailEl.hidden = true; clearChildren(detailEl); return; }

  const item = state.catalog.get(p.item_id) ?? null;
  clearChildren(detailEl);

  const head = document.createElement("div");
  head.className = "head";
  const h2 = document.createElement("h2");
  h2.textContent = item ? item.name_ja : p.item_id;
  head.appendChild(h2);
  if (isUnverified(item)) {
    const unv = document.createElement("span");
    unv.className = "unv";
    unv.textContent = "未検証";
    head.appendChild(unv);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close quiet";
  close.textContent = "閉じる";
  close.addEventListener("click", () => selectPlacement(null));
  head.appendChild(close);
  detailEl.appendChild(head);

  const dl = document.createElement("dl");
  addRow(dl, "種別", `${kindLabel(item?.kind)}${item?.name_en ? `（${item.name_en}）` : ""}`);
  // 試合の要素（ドリル位置など）はコストも射程も持たないので、文言が空になる。
  // 「コスト不明 / 射程不明」を並べても読む人の判断材料が増えないため行ごと出さない。
  const cost = costText(item);
  if (cost) addRow(dl, "コスト", cost, true);
  const range = rangeText(item);
  if (range) addRow(dl, "射程", range, true);
  if (hasMinRange(item)) {
    addRow(dl, "デッドゾーン", `中心から ${item.range_min_m}m までは撃てません`);
  }
  if (isFob(item)) addRow(dl, "建築範囲", `${FOB_SIDE_M}m四方（暫定・未確認）`, true);
  // ホットゾーンは「何をするものか」が本体。寸法より先に効果を出す。
  if (isHotzone(item)) {
    addRow(dl, "効果", "中に入ると人数が2倍に数えられます");
    addRow(dl, "範囲", `半径 ${HOTZONE_RADIUS_M}m（未検証）`, true);
  }
  const g = state.coords.toGame(p);
  const cell = state.coords.cellOf(p);
  addRow(dl, "位置", `x${g.x.toFixed(2)} y${g.y.toFixed(2)}${cell ? ` ${cell}` : ""}`, true);
  detailEl.appendChild(dl);

  // 読む所（カタログの値）と書く所（自分たちの判断）を分けて、書く所を先に出す。
  // 出典や備考より手前に置かないと、置いた直後に書く流れが途切れる。
  detailEl.appendChild(buildEditFields(p));

  if (isFob(item)) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = FOB_RANGE_NOTE;
    detailEl.appendChild(note);
  }

  const src = document.createElement("p");
  src.className = "src";
  src.textContent = `出典: ${item?.source || "不明（出典なし）"}`;
  detailEl.appendChild(src);

  if (item?.notes) {
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "備考を見る";
    const body = document.createElement("p");
    body.className = "src";
    body.textContent = item.notes;
    det.append(sum, body);
    detailEl.appendChild(det);
  }

  // 消せるのは置いた本人と admin だけ（サーバが403を返す）。押せるようにしておいて
  // 403 の理由を出すより、押せないことと理由を先に見せる。
  const del = document.createElement("button");
  del.type = "button";
  del.id = "placement-delete";
  del.className = "quiet danger";
  del.textContent = "この配置を消す";
  if (!canEditHere(p)) {
    del.disabled = true;
    del.title = noEditTitle("他の人の配置は消せません");
  }
  del.addEventListener("click", () => deleteSelected(del));
  detailEl.appendChild(del);

  detailEl.hidden = false;
}

async function deleteSelected(button) {
  const p = state.selected;
  if (!p) return;
  button.disabled = true;

  let id;
  try {
    id = p.id ?? (await p.saving);
  } catch {
    // 保存自体が失敗していた配置。もう盤面に無いので消す操作は済んだ扱い。
    removePlacement(p);
    return;
  }

  try {
    await deletePlacement(state.plan.session.id, id);
    removePlacement(p);
    say("配置を消しました。");
  } catch (e) {
    say(
      e.status === 403
        ? "他の人の配置は消せません。消せるのは置いた本人と管理者だけです。"
        : `消せませんでした。${e.message}`,
      true
    );
    button.disabled = false;
  }
}

/**
 * 枠で選んだものの詳細（検視台を「いま選んでいる範囲」について語らせる）。
 *
 * **棚にボタンを増やさない**（design-system §6）。まとめて消す導線は、1件消す
 * 導線（`#placement-delete`）と同じ場所・同じ見た目（`.quiet .danger`）に置く。
 *
 * **件数は分けて出す。** 他人のものが混ざっていると操作は自分のものにしか
 * 効かないので、「7件を選択」とだけ出して4件しか消えないと、
 * 3件が消えなかったことに気づけない（仕様 §2）。
 */
function renderPickedDetail(sel) {
  clearChildren(detailEl);

  const head = document.createElement("div");
  head.className = "head";
  const h2 = document.createElement("h2");
  h2.textContent = "選んだもの";
  head.appendChild(h2);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close quiet";
  close.textContent = "閉じる";
  close.addEventListener("click", () => clearPicked());
  head.appendChild(close);
  detailEl.appendChild(head);

  const total = sel.items.length;
  const mine = sel.mine.length;
  const dl = document.createElement("dl");
  addRow(dl, "件数", selectionText(total, mine), true);
  detailEl.appendChild(dl);

  // 他人のものが混ざっているときだけ、なぜ効かないのかを書く
  // （混ざっていなければ言う相手がいない）。
  if (mine < total) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent =
      "他の人が置いたものは動かせません・消せません。できるのは置いた本人と管理者だけです。";
    detailEl.appendChild(note);
  }

  const hint = document.createElement("p");
  hint.className = "src";
  hint.textContent = "選んだものを掴むとまとめて動かせます。Esc で選択を解きます。";
  detailEl.appendChild(hint);

  const del = document.createElement("button");
  del.type = "button";
  del.id = "picked-delete";
  del.className = "quiet danger";
  del.textContent = `選んだ${mine}件を消す`;
  if (!state.editable || mine === 0) {
    del.disabled = true;
    del.title = state.editable ? "自分のものが1件も含まれていません" : WRITE_DENIED;
  }
  del.addEventListener("click", () => { del.disabled = true; deletePicked(); });
  detailEl.appendChild(del);

  detailEl.hidden = false;
}

/**
 * 選んだ地名の詳細。配置の詳細と同じパネルを使う。
 *
 * 出すのは「位置」と「呼び名を書く欄」だけ。地名にはカタログも出典も無く、
 * 値はすべて自分たちが決めたものなので、読む所と書く所を分ける必要がない。
 */
function renderCalloutDetail(c) {
  const editable = canEditHere(c);
  clearChildren(detailEl);

  const head = document.createElement("div");
  head.className = "head";
  const h2 = document.createElement("h2");
  h2.textContent = "地名";
  head.appendChild(h2);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close quiet";
  close.textContent = "閉じる";
  close.addEventListener("click", () => selectCallout(null));
  head.appendChild(close);
  detailEl.appendChild(head);

  const dl = document.createElement("dl");
  const g = state.coords.toGame(c);
  const cell = state.coords.cellOf(c);
  addRow(dl, "位置", `x${g.x.toFixed(2)} y${g.y.toFixed(2)}${cell ? ` ${cell}` : ""}`, true);
  detailEl.appendChild(dl);

  const box = document.createElement("div");
  box.className = "edit";
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.htmlFor = "callout-name";
  label.textContent = "呼び名";
  const row = document.createElement("div");
  row.className = "row";

  const input = document.createElement("input");
  input.type = "text";
  input.id = "callout-name";
  // サーバ側の上限と同じ。緩めると入力できるのに保存で 400 になる欄ができる。
  input.maxLength = NAME_MAX_LEN;
  input.placeholder = "あの丘";
  input.value = c.name;

  const save = document.createElement("button");
  save.type = "button";
  save.id = "callout-name-save";
  save.textContent = "保存";

  if (!editable) {
    for (const el of [input, save]) {
      el.disabled = true;
      el.title = noEditTitle(NO_CALLOUT_EDIT_TITLE);
    }
  }

  save.addEventListener("click", () => saveCalloutName(c, input, save));
  // 1行の欄なので改行の用が無い。置いた直後に名前を書く流れを Enter で閉じる。
  input.addEventListener("keydown", (evt) => {
    if (evt.key !== "Enter" || evt.isComposing) return;
    evt.preventDefault();
    saveCalloutName(c, input, save);
  });

  row.append(input, save);
  field.append(label, row);
  box.append(field);
  detailEl.appendChild(box);

  // 「マップに付けた地名」と誤解されると、消すのをためらわせる。
  // どこまで効く変更なのかをその場に書いておく。
  const scope = document.createElement("p");
  scope.className = "src";
  scope.textContent = "この地名はこの作戦の中だけのものです。他の作戦には出ません。";
  detailEl.appendChild(scope);

  const del = document.createElement("button");
  del.type = "button";
  del.id = "callout-delete";
  del.className = "quiet danger";
  del.textContent = "この地名を消す";
  if (!editable) {
    del.disabled = true;
    del.title = noEditTitle("他の人の地名は消せません");
  }
  del.addEventListener("click", () => deleteSelectedCallout(del));
  detailEl.appendChild(del);

  detailEl.hidden = false;
}

/** 書けない理由。配置の欄と同じ作法で、押す前に理由を見せる。 */
const NO_CALLOUT_EDIT_TITLE = "他の人の地名は直せません";

/** 呼び名を保存する。楽観更新で、断られたら元の文字へ戻す（配置の注記と同じ）。 */
async function saveCalloutName(c, input, button) {
  const before = c.name;
  const next = input.value.trim();
  if (!next) { say("呼び名を入力してください。", true); return; }
  if (next === before) { say("呼び名は変わっていません。"); return; }

  button.disabled = true;
  const id = await calloutId(c);
  if (id === null) return;

  applyCalloutName(c, next);
  try {
    await patchCallout(state.plan.session.id, id, { name: next });
    say(`地名を「${next}」にしました。`);
  } catch (e) {
    applyCalloutName(c, before);
    input.value = before;
    say(
      e.status === 403
        ? "他の人の地名は直せません。直せるのは置いた本人と管理者だけです。"
        : `地名を保存できませんでした。${e.message}`,
      true
    );
  } finally {
    button.disabled = false;
  }
}

async function deleteSelectedCallout(button) {
  const c = state.selectedCallout;
  if (!c) return;
  button.disabled = true;

  const id = await calloutId(c);
  // 保存自体が失敗していた地名。もう盤面に無いので消す操作は済んだ扱い。
  if (id === null) return;

  try {
    await deleteCallout(state.plan.session.id, id);
    removeCallout(c);
    say("地名を消しました。");
  } catch (e) {
    say(
      e.status === 403
        ? "他の人の地名は消せません。消せるのは置いた本人と管理者だけです。"
        : `消せませんでした。${e.message}`,
      true
    );
    button.disabled = false;
  }
}


// ── 選んだスタンプの詳細 ───────────────────────────────────
// 配置・地名と同じパネルを使い回す（選べるのは一度に1つだけ）。
//
// 出すのは「何のスタンプか」「位置」「注記」「消す」。カタログも出典も無く、
// 値はすべてこちらが決めたものなので、読む所と書く所を分ける必要がない
// （地名の詳細と同じ形）。

/** 書けない理由。配置・地名の欄と同じ作法で、押す前に理由を見せる。 */
const NO_STAMP_EDIT_TITLE = "他の人のスタンプは直せません";

function renderStampDetail(s) {
  const def = defOf(s);
  const editable = canEditHere(s);
  clearChildren(detailEl);

  const head = document.createElement("div");
  head.className = "head";
  const h2 = document.createElement("h2");
  h2.textContent = def ? def.label : "スタンプ";
  head.appendChild(h2);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close quiet";
  close.textContent = "閉じる";
  close.addEventListener("click", () => selectStamp(null));
  head.appendChild(close);
  detailEl.appendChild(head);

  const dl = document.createElement("dl");
  // 軍用記号のときだけ「外形が陣営、中の字が兵種」を言う（図形には陣営が無い）。
  const side = def?.glyph ? stampSide(def) : null;
  if (side) addRow(dl, "陣営", side);
  const g = state.coords.toGame(s);
  const cell = state.coords.cellOf(s);
  addRow(dl, isVector(def) ? "始点" : "位置",
    `x${g.x.toFixed(2)} y${g.y.toFixed(2)}${cell ? ` ${cell}` : ""}`, true);
  if (isVector(def) && Number.isFinite(s.x2_m)) {
    const g2 = state.coords.toGame({ x_m: s.x2_m, y_m: s.y2_m });
    const cell2 = state.coords.cellOf({ x_m: s.x2_m, y_m: s.y2_m });
    addRow(dl, "終点",
      `x${g2.x.toFixed(2)} y${g2.y.toFixed(2)}${cell2 ? ` ${cell2}` : ""}`, true);
  }
  detailEl.appendChild(dl);

  const box = document.createElement("div");
  box.className = "edit";
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.htmlFor = "stamp-note";
  label.textContent = "注記";
  const row = document.createElement("div");
  row.className = "row";

  const input = document.createElement("input");
  input.type = "text";
  input.id = "stamp-note";
  // サーバ側の上限と同じ。緩めると入力できるのに保存で 400 になる欄ができる。
  input.maxLength = NOTE_MAX_LEN;
  input.placeholder = "道路経由だから取りづらい";
  input.value = s.note ?? "";

  const save = document.createElement("button");
  save.type = "button";
  save.id = "stamp-note-save";
  save.textContent = "保存";

  if (!editable) {
    for (const el of [input, save]) {
      el.disabled = true;
      el.title = noEditTitle(NO_STAMP_EDIT_TITLE);
    }
  }

  save.addEventListener("click", () => saveStampNote(s, input, save));
  input.addEventListener("keydown", (evt) => {
    if (evt.key !== "Enter" || evt.isComposing) return;
    evt.preventDefault();
    saveStampNote(s, input, save);
  });

  row.append(input, save);
  field.append(label, row);
  box.append(field);
  detailEl.appendChild(box);

  if (isVector(def)) {
    const hint = document.createElement("p");
    hint.className = "src";
    hint.textContent = "掴んで動かすと、向きを保ったまま全体が移動します。";
    detailEl.appendChild(hint);
  }

  const del = document.createElement("button");
  del.type = "button";
  del.id = "stamp-delete";
  del.className = "quiet danger";
  del.textContent = "このスタンプを消す";
  if (!editable) {
    del.disabled = true;
    del.title = noEditTitle("他の人のスタンプは消せません");
  }
  del.addEventListener("click", () => deleteSelectedStamp(del));
  detailEl.appendChild(del);

  detailEl.hidden = false;
}

/** 注記を保存する。楽観更新で、断られたら元の文字へ戻す（配置の注記と同じ）。 */
async function saveStampNote(s, input, button) {
  const before = s.note ?? null;
  const next = input.value.trim() || null;
  if (next === before) { say("注記は変わっていません。"); return; }

  button.disabled = true;
  const id = await stampId(s);
  if (id === null) return;

  applyStampNote(s, next);
  try {
    await saveStampAt(id, { note: next });
    say(next ? "注記を保存しました。" : "注記を消しました。");
  } catch (e) {
    applyStampNote(s, before);
    input.value = before ?? "";
    say(
      e.status === 403
        ? "他の人のスタンプには書けません。書けるのは置いた本人と管理者だけです。"
        : `注記を保存できませんでした。${e.message}`,
      true
    );
  } finally {
    button.disabled = false;
  }
}

async function deleteSelectedStamp(button) {
  const s = state.selectedStamp;
  if (!s) return;
  button.disabled = true;

  const id = await stampId(s);
  // 保存自体が失敗していたスタンプ。もう盤面に無いので消す操作は済んだ扱い。
  if (id === null) return;

  try {
    await deleteStamp(state.plan.session.id, id);
    removeStamp(s);
    say("スタンプを消しました。");
  } catch (e) {
    say(
      e.status === 403
        ? "他の人のスタンプは消せません。消せるのは置いた本人と管理者だけです。"
        : `消せませんでした。${e.message}`,
      true
    );
    button.disabled = false;
  }
}
