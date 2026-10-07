// 作戦の一覧（?id= が無いときの入口）。枠の表・作成フォーム・訪問履歴。

import { createSession, deleteSession, getMaps, listSessions } from "../api.js";
import { avatarBroken, avatarUrl, fillAvatar } from "../avatar.js";
import { say, sayOffline, setEditable, setPage, setRailVisible } from "../chrome.js";
import { clearChildren } from "../render.js";
import {
  buildPatternGrid, groupSessionsByMap, patternName, seenLabel, timeAgo,
} from "../sessions.js";

/**
 * 作戦の題名の上限。**サーバ（functions/api/sessions/index.js）と同じ値。**
 * ここを緩めると、入力できるのに保存で 400 になる欄ができる。
 */
const TITLE_MAX_LEN = 48;

/** 区画の下に1行だけ添える説明。見出しだけでは伝わらない決めごとを書く。 */
function lead(text) {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

// ?id= が無いときの入口。/plan にはブックマークも無しに来る人がいるので、
// エラーで止めるのではなく「作る」導線をここに置く。#board はこのとき
// 使わないので main を丸ごと作り替える（ログインゲートと同じやり方）。
//
// ── 画面の形（2026-10-01 に作り直した）───────────────────────
// オーナー指摘（作戦1件の実画面を見て）: 「これでいいとおもってます？」
//
// それまでは**左に大きく作成フォーム、右に小さく一覧**で、主従が逆だった。
// 作戦は 9〜12 個作ったら終わりで、あとは試合のたびに開くもの（D-046 の目的3）。
// しかも**まだ作っていないマップ × パターンの枠が画面に存在しなかった**ので、
// 「9つのうち何が埋まっていて何が空いているか」が読めなかった。
//
// いまは**枠の表が主役**。埋まっている枠は「開く」、空の枠はそこが作る入口になる。
// 作成フォームは常設をやめて、押した枠の中に開く。
// これで `<select>` の常設も消えた（マップもパターンも、押した枠が決める）。
export async function showCreateForm() {
  const main = document.querySelector("main");
  setPage("list");
  clearChildren(main);
  main.classList.add("create");
  setEditable(false);
  setRailVisible(false);

  const sheet = document.createElement("div");
  sheet.className = "sheet";
  main.appendChild(sheet);

  const section = document.createElement("section");
  section.id = "session-grid";
  section.className = "list-sec";
  const heading = document.createElement("h2");
  heading.textContent = "作戦の枠";
  const intro = lead(
    "マップごとに、想定するパターンの枠が並びます。試合が始まったら、その日のパターンの枠を開いてください。"
  );
  const progress = document.createElement("p");
  progress.id = "grid-progress";
  progress.className = "grid-progress";
  const body = document.createElement("div");
  section.append(heading, intro, progress, body);
  sheet.appendChild(section);

  const showMessage = (text, isError = false) => {
    clearChildren(body);
    progress.textContent = "";
    const p = document.createElement("p");
    if (isError) p.className = "err";
    p.textContent = text;
    body.appendChild(p);
  };

  // **枠を出すにはマップ（＝パターンの一覧）と作戦の両方が要る。**
  // 片方が落ちてももう片方は使えるように、同時に投げて別々に扱う。
  const [mapsRes, listRes] = await Promise.allSettled([getMaps(), listSessions()]);

  if (listRes.status === "rejected") {
    const e = listRes.reason;
    if (e.status === undefined) { sayOffline(); return; }
    showMessage(`一覧を取得できませんでした。${e.message}`, true);
    return;
  }
  const { sessions, visited = [] } = listRes.value;
  // サーバは「公開されている他人の作戦」をそのまま返す（訪問済みも除かない）。
  // **画面では訪問済みを落とす。** 同じ行が2つの節に出ると、どちらを押しても
  // 同じ所に行くのに「別のものかもしれない」と読ませてしまう。
  // 落とすのは公開の節のほうで、訪問履歴は残す（「開いたことがある」が消えると
  // URL を無くした人の辿り先が減る。D-034）。
  const seen = new Set(visited.map((v) => v.id));
  const shared = (listRes.value.public ?? []).filter((s) => !seen.has(s.id));

  if (mapsRes.status === "rejected") {
    const e = mapsRes.reason;
    if (e.status === undefined) { sayOffline(); return; }
    // **枠は出せないが、作った作戦は開ける。**試合中はこちらのほうが大事なので、
    // 旧来のマップごとの一覧に落として画面を使えるままにする。
    clearChildren(body);
    progress.textContent = "";
    const warn = document.createElement("p");
    warn.className = "err";
    warn.textContent =
      `マップを取得できなかったので、空いている枠を出せません（${e.message}）。`
      + `いま作ってある作戦は下から開けます。`;
    body.append(warn, renderMineGroups(sessions, showMessage));
  } else {
    clearChildren(body);
    renderGrid(body, progress, mapsRes.value.maps, sessions);
  }

  // **0件の節は出さない。** 空の見出しだけが並ぶ画面にしない。
  if (shared.length) sheet.appendChild(renderPublicSection(shared));
  if (visited.length) sheet.appendChild(renderVisitedSection(visited));
}

/**
 * 枠の表を描く。**枠の数はサーバが返したプリセットの行数で決まる**
 * （画面に 9 と書かない。プリセットは今後も増減する）。
 */
function renderGrid(body, progress, maps, sessions) {
  const { groups, ready, total } = buildPatternGrid(maps, sessions);

  progress.textContent = total === 0
    ? "想定するパターンがまだ1件も登録されていません（管理者が入れると枠が並びます）。"
    : `${total}枠のうち ${ready}枠に作戦があります。空いている枠を押すと、その組み合わせで作れます。`;

  const box = document.createElement("div");
  box.id = "sessions";
  box.className = "s-grid";
  // 消したあとに枠の表示（埋まっている／空）が変わる。作り直すのがいちばん確実で、
  // 件数も 9〜12 なので作り直しても目に見える間はない。
  const refresh = () => { showCreateForm(); };
  for (const group of groups) box.appendChild(renderGridGroup(group, refresh));
  body.appendChild(box);
}

/** マップ1つぶんの区画（見出し＋枠＋パターン未設定の作戦）。 */
function renderGridGroup(group, refresh) {
  const section = document.createElement("section");
  section.className = "s-group";
  section.dataset.mapId = group.map_id;

  const head = document.createElement("h3");
  const name = document.createElement("span");
  name.className = "s-group-name";
  name.textContent = group.map_name;
  const count = document.createElement("span");
  count.className = "s-group-count data";
  // **埋まった数 / 枠の数。**ここが「このマップの準備はどこまで進んだか」。
  count.textContent = group.cells.length
    ? `${group.ready} / ${group.cells.length}`
    : `${group.extra.length}件`;
  head.append(name, count);

  const cells = document.createElement("div");
  cells.className = "s-cells";
  for (const cell of group.cells) cells.appendChild(renderCell(group, cell, refresh));
  // **パターンが1件も登録されていないマップ。**枠が作れないので作る入口も
  // 消えてしまう。そのマップだけ「パターンなしで作る」枠を1つ置く。
  if (group.cells.length === 0) {
    cells.appendChild(renderCell(
      group,
      { preset_id: null, pattern_name: "パターン未登録", sessions: [] },
      refresh,
      { note: "このマップのパターンはまだ登録されていません。パターンなしで作れます。" }
    ));
  }
  section.append(head, cells);

  // **枠に入らない作戦を隠さない。** 既存の作戦は全部パターン未設定なので、
  // ここを落とすと「作戦が消えた」ように見える。
  if (group.extra.length) section.appendChild(renderExtraCell(group, refresh));
  return section;
}

/**
 * 枠1つ。
 *
 * **空の枠は破線。** 「まだ決まっていない」を破線で表すのは、行のパターン札
 * （`.pattern.none`）と同じ約束。色を足さずに、埋まっている枠との差を形で出す。
 */
function renderCell(group, cell, refresh, { note } = {}) {
  const el = document.createElement("div");
  el.className = "s-cell";
  el.dataset.state = cell.sessions.length ? "ready" : "empty";
  if (cell.preset_id) el.dataset.presetId = cell.preset_id;

  const title = document.createElement("h4");
  title.className = "pattern";
  title.textContent = cell.pattern_name;
  el.appendChild(title);
  if (note) el.appendChild(lead(note));

  if (cell.sessions.length) {
    const list = document.createElement("ul");
    list.className = "s-list";
    for (const s of cell.sessions) list.appendChild(renderSessionRow(s, refresh));
    el.appendChild(list);
  }
  // 埋まっている枠にも作る口を残す（1枠1作戦を前提にしない。「初動」と
  // 「巻き返し」のように同じパターンで案を並べたいことがある）。
  el.appendChild(createCellButton(group, cell, el, refresh));
  return el;
}

/** パターン未設定の作戦を置く区画。枠の数には数えない。 */
function renderExtraCell(group, refresh) {
  // **`.s-cell` は付けない。**「枠」はパターン1つに1つで、未設定はそこに
  // 入らないもの。同じクラスにすると枠の数が狂う（実測で狂った）。
  const el = document.createElement("div");
  el.className = "s-extra";

  const title = document.createElement("h4");
  title.className = "pattern none";
  title.textContent = "パターン未設定";
  const why = lead("どのパターン向けか決まっていない作戦です。開いて「円とマス」から決められます。");

  const list = document.createElement("ul");
  list.className = "s-list";
  for (const s of group.extra) list.appendChild(renderSessionRow(s, refresh));

  el.append(title, why, list);
  return el;
}

/** 枠の中の「作る」。押すとその枠の中に題名の欄が開く。 */
function createCellButton(group, cell, cellEl, refresh) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cell.sessions.length ? "s-new quiet" : "s-new";
  // **何がどうなるかを書く。**「作る」だけだと、どのマップのどのパターンで
  // 作られるのかがボタンから読めない（押した枠が決める、が伝わらない）。
  btn.textContent = cell.sessions.length ? "この枠にもう1つ作る" : "この枠に作る";
  btn.addEventListener("click", () => openCellForm(group, cell, cellEl, btn, refresh));
  return btn;
}

/**
 * 枠の中に作成フォームを開く。
 *
 * **マップもパターンも押した枠が決める**ので、選ぶ欄は無い。要るのは題名だけ。
 * 題名は枠の名前で埋めておく（そのまま Enter で作れる）。
 *
 * `id` は `#create` / `#create-title` のまま。同時に開くフォームは1つだけなので
 * id は重複しない。
 */
function openCellForm(group, cell, cellEl, btn, refresh) {
  // 開いているフォームは1つだけにする（複数開くと id が重複する）。
  for (const open of document.querySelectorAll("#create")) open.remove();
  for (const b of document.querySelectorAll(".s-new")) b.hidden = false;
  btn.hidden = true;

  const form = document.createElement("form");
  form.id = "create";
  form.className = "s-form";

  const label = document.createElement("label");
  label.htmlFor = "create-title";
  label.textContent = "題名";
  const input = document.createElement("input");
  input.id = "create-title";
  input.type = "text";
  input.maxLength = TITLE_MAX_LEN;
  input.placeholder = "題名（1〜48文字）";
  input.value = defaultTitle(group, cell);

  const actions = document.createElement("div");
  actions.className = "s-form-actions";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "作戦を作る";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "quiet";
  cancel.textContent = "やめる";
  actions.append(submit, cancel);

  cancel.addEventListener("click", () => { form.remove(); btn.hidden = false; btn.focus(); });
  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    const title = input.value.trim();
    // サーバも空題名を 400 で弾くが、往復させる理由が無い。
    if (!title) { say("題名を入力してください。", true); input.focus(); return; }
    submit.disabled = true;
    try {
      const { session } = await createSession(group.map_id, title, cell.preset_id ?? null);
      location.href = `/plan?id=${session.id}`;
    } catch (e) {
      say(`作戦を作れませんでした。${e.message}`, true);
      submit.disabled = false;
    }
  });

  form.append(label, input, actions);
  cellEl.appendChild(form);
  input.focus();
  input.select();
}

/**
 * 枠から決まる既定の題名。押してそのまま Enter で作れるようにする。
 * サーバの上限に合わせて切る（入力できるのに保存で 400 になる欄を作らない）。
 */
function defaultTitle(group, cell) {
  const base = cell.preset_id
    ? `${group.map_name} ${cell.pattern_name}`
    : `${group.map_name} の作戦`;
  return base.slice(0, TITLE_MAX_LEN);
}

// ざっくりした相対時刻。秒までは要らない（一覧の並び順が本体なので、
// 表示は「だいたいいつ」が分かれば十分）。
/** 一覧の1行に置く「開く」。自分の作戦でも他人の作戦でも同じ見た目にする。 */
function createOpenLink(sessionId) {
  const open = document.createElement("a");
  open.className = "open";
  open.href = `/plan?id=${sessionId}`;
  open.textContent = "開く";
  return open;
}

/**
 * 一覧の1行に置く「共有URLをコピー」。
 * #share（?id= があるときのヘッダのボタン）と同じやり方。
 * clipboard API が使えない環境では、コピーの代わりにURLをそのまま出す。
 */
function createCopyButton(sessionId) {
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "quiet";
  copyBtn.textContent = "共有URLをコピー";
  copyBtn.addEventListener("click", async () => {
    const shareUrl = `${location.origin}/plan?id=${sessionId}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      say("コピーしました。");
    } catch {
      say(shareUrl);
    }
  });
  return copyBtn;
}

/** 一覧の1行。読むもの（題名・マップ・時刻）を左、操作を右にまとめる。 */
function createSessionRow(readables, actionEls) {
  const li = document.createElement("li");

  const info = document.createElement("div");
  info.className = "s-main";
  info.append(...readables);

  const actions = document.createElement("div");
  actions.className = "s-actions";
  actions.append(...actionEls);

  li.append(info, actions);
  return li;
}

function createTitleSpan(text) {
  const title = document.createElement("span");
  title.className = "s-title";
  title.textContent = text;
  return title;
}

function createMapBadge(mapName) {
  const mapBadge = document.createElement("span");
  mapBadge.className = "badge";
  mapBadge.textContent = mapName;
  return mapBadge;
}

/**
 * 「どのパターン向けか」を行に出すバッジ。
 *
 * これが**探すときの手掛かり**なので、マップ名のバッジより濃く出す
 * （試合が始まって「今日は Default」と分かってから開くまでを短くする）。
 * 未設定は隠さずに、そう書いた札を出す。既存の作戦は全部これで、
 * 空白のままにすると「情報が欠けている」のか「まだ決めていない」のか
 * 画面から区別できない。
 */
function createPatternBadge(s) {
  const el = document.createElement("span");
  const name = patternName(s);
  el.className = name === null ? "pattern none" : "pattern";
  el.textContent = name ?? "パターン未設定";
  return el;
}

/**
 * 自分の作戦の1行。開く・共有URLのコピー・削除をここにまとめる。
 *
 * `pattern` は「行がパターンを名乗るか」。**枠の中では名乗らない**
 * （枠の見出しが既にパターンの名前なので、行で繰り返すと同じ語が二度出る）。
 * マップが取れなかったときの退避一覧だけ、行が自分で名乗る。
 */
function renderSessionRow(s, onRemoved, { pattern = false } = {}) {
  const updated = document.createElement("span");
  updated.className = "updated";
  updated.textContent = timeAgo(s.updated_at);

  const open = createOpenLink(s.id);
  const copyBtn = createCopyButton(s.id);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "quiet danger";
  del.textContent = "削除";

  // マップ名は区画の見出しに1つ出るので、行では繰り返さない。
  const li = createSessionRow(
    [createTitleSpan(s.title), ...(pattern ? [createPatternBadge(s)] : []), updated],
    [open, copyBtn, del]
  );

  // 描いた線も含めて消えるので、ここだけは確認を出す（取り消しとは違い、
  // 押し間違えても引き直せない操作のため）。
  del.addEventListener("click", async () => {
    if (!confirm(`「${s.title}」を削除します。描いた線もすべて消えます。よろしいですか？`)) return;
    del.disabled = true;
    try {
      await deleteSession(s.id);
      li.remove();
      onRemoved();
    } catch (e) {
      say(`削除できませんでした。${e.message}`, true);
      del.disabled = false;
    }
  });

  return li;
}

/**
 * 「作成 〈アイコン〉〈名前〉」。**訪問履歴の行と公開の行で共用する。**
 *
 * **アイコンは出せる人にだけ付く。** ゲストが作った作戦は存在しないので
 * ここに来るのは必ずログイン済みの人だが、Discord の既定アイコンの人は
 * `avatar` が NULL で、消された hash は読み込みに失敗する。
 * **どちらも「枠ごと出ない」に倒す**（空の丸も壊れた画像も残さない）。
 *
 * ここには色が無い（色は部屋の中で決まるもので、一覧には部屋が無い）。
 * なので**色の輪は描かない**——描くと、同じ人が一覧とカーソルで違う色に
 * 見えることがある（部屋の中では色がぶつかるとずれる。`pickColor`）。
 */
function createdBy(s) {
  const by = document.createElement("span");
  by.className = "by";
  const name = document.createElement("strong");
  // 作成者の行が消えていても作戦は残る（サーバは LEFT JOIN で返す）。
  // 空のまま出すと「作成 」という壊れた行になるので、言葉で埋める。
  name.textContent = s.created_by_name || "不明な人";
  by.append("作成 ");

  const url = avatarUrl(s.created_by, s.created_by_avatar);
  if (url && !avatarBroken(url)) {
    const face = document.createElement("span");
    face.className = "by-face";
    // 読めなければ `<img>` ごと消える（`fillAvatar`）。空の枠は残らない。
    fillAvatar(face, url);
    by.appendChild(face);
  }
  by.appendChild(name);
  return by;
}

/**
 * 訪問履歴の1行。**削除は置かない**（自分のものではないので消せない）。
 *
 * 自分の作戦の行と違うのは3つ。
 *   * 誰が作ったかを出す（共有URLを配られた側には、これが無いと誰のか分からない）
 *   * 時刻が「更新」ではなく「開いた」を指す
 *   * **マップ名を行に出す。** こちらは「最後に開いた順」の一覧で、
 *     マップごとの区画に分けていないので、行が自分でマップを名乗る必要がある
 */
function renderVisitedRow(v) {
  const by = createdBy(v);

  const seen = document.createElement("span");
  seen.className = "updated";
  seen.textContent = seenLabel(v.last_seen_at);

  return createSessionRow(
    [createTitleSpan(v.title), createMapBadge(v.map_name), createPatternBadge(v), by, seen],
    [createOpenLink(v.id), createCopyButton(v.id)]
  );
}

/**
 * 「開いたことがある作戦」。共有URLで開いた**他人の**作戦。
 *
 * URL を無くすと二度と辿り着けないという穴を塞ぐためのもの（D-034）。
 * 0件のときは呼ばない（空の見出しだけが残ると邪魔になる）。
 *
 * ここに出る他人の名前は「その作戦を作った人」だけ。**誰が自分の作戦を見たか**を
 * 見せる画面は作らない（訪問記録は本人だけが読む）。
 */
function renderVisitedSection(visited) {
  const section = document.createElement("section");
  section.id = "visited-list";
  section.className = "list-sec";

  const heading = document.createElement("h2");
  heading.textContent = "開いたことがある作戦";

  // 「自分の作戦」との違いを、見出しだけに頼らず1文で言う。
  // 記録が自分にしか見えないことも、ここで伝える（黙って増やさない）。
  const note = lead("共有URLで開いた、他の人の作戦です。この記録はあなたにだけ見えます。");

  const listEl = document.createElement("ul");
  listEl.id = "visited";
  listEl.className = "s-list";
  for (const v of visited) listEl.appendChild(renderVisitedRow(v));

  section.append(heading, note, listEl);
  return section;
}

/**
 * 公開されている作戦の1行。
 *
 * 訪問履歴の行との違いは2つ。
 *   * 時刻が「開いた」ではなく「更新」を指す（開いたことが無い行もある）
 *   * **書き込めるかを札で出す。** 開いてから棚が押せないことに気づくのでは
 *     「壊れている」に見える。`public` は見るだけ、`public_edit` は書き込める
 */
function renderPublicRow(s) {
  const by = createdBy(s);

  const mode = document.createElement("span");
  mode.className = "badge";
  // 文言は「結果」で書く（状態の名前を画面に出さない）。
  mode.textContent = s.visibility === "public_edit" ? "書き込める" : "見るだけ";

  const updated = document.createElement("span");
  updated.className = "updated";
  updated.textContent = timeAgo(s.updated_at);

  return createSessionRow(
    [
      createTitleSpan(s.title), createMapBadge(s.map_name), createPatternBadge(s),
      mode, by, updated,
    ],
    [createOpenLink(s.id), createCopyButton(s.id)]
  );
}

/**
 * 「公開されている作戦」。**自分が作ったものでも開いたことがあるものでもない**
 * のに、一覧から辿れる唯一の群。
 *
 * これが要望の本体（「公開設定したプランは一覧で見れるように」）。
 * 自分の枠の表の下に置くのは、試合中に開くのは自分の枠のほうだから。
 *
 * **0件のときは呼ばない**（空の見出しだけが残ると邪魔になる）。
 * 削除は置かない（自分のものではない）。
 *
 * **ログイン前の画面（`pages/gate.js`）からも呼ぶ。** ゲストに返るのは
 * この節だけなので、同じ節を2つ書かずに貸し出す。行の形が2つに分かれると
 * 「ログインすると札の文言が変わる」ような食い違いが静かに入る。
 */
export function renderPublicSection(shared) {
  const section = document.createElement("section");
  section.id = "public-list";
  section.className = "list-sec";

  const heading = document.createElement("h2");
  heading.textContent = "公開されている作戦";

  const note = lead(
    "他の人が公開した作戦です。「見るだけ」のものには書き込めません。"
  );

  const listEl = document.createElement("ul");
  listEl.id = "public-sessions";
  listEl.className = "s-list";
  for (const s of shared) listEl.appendChild(renderPublicRow(s));

  section.append(heading, note, listEl);
  return section;
}

/**
 * **マップが取れなかったときの退避一覧。**
 *
 * 通常は「マップ × パターンの枠」（`renderGrid`）を出す。枠を描くには
 * マップごとのパターン一覧が要るので、`/api/maps` が落ちると枠は出せない。
 * そのときでも**作った作戦は開ける**必要がある（試合中はこちらが大事）ので、
 * 自分の作戦をマップごとの区画にして出すだけの形に落とす。
 *
 * `#sessions` は `ul` ではなく区画を並べる箱（`li` は行だけなので、
 * `#sessions li` は枠の表と同じく「作戦の件数」を指す）。
 */
function renderMineGroups(sessions, showEmpty) {
  const box = document.createElement("div");
  box.id = "sessions";
  box.className = "s-groups";

  // 1件消すと区画が空になることがある。空の見出しを残さないための後始末。
  const afterRemove = () => {
    for (const group of [...box.querySelectorAll(".s-group")]) {
      if (!group.querySelector("li")) group.remove();
    }
    if (!box.querySelector("li")) showEmpty("作戦はまだ1つもありません。");
  };

  for (const group of groupSessionsByMap(sessions)) {
    const section = document.createElement("section");
    section.className = "s-group";
    section.dataset.mapId = group.map_id;

    // 見出しはマップ名と件数。h2（区画）の下なので h3。
    const head = document.createElement("h3");
    const name = document.createElement("span");
    name.className = "s-group-name";
    name.textContent = group.map_name;
    const count = document.createElement("span");
    count.className = "s-group-count data";
    count.textContent = `${group.sessions.length}件`;
    head.append(name, count);

    const listEl = document.createElement("ul");
    listEl.className = "s-list";
    for (const s of group.sessions) {
      listEl.appendChild(renderSessionRow(s, afterRemove, { pattern: true }));
    }

    section.append(head, listEl);
    box.appendChild(section);
  }
  return box;
}
