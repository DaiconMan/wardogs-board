// ログイン前の画面。
//
// **2つの状態がここにある。**
//
//   身元が1つも無い … ログインのボタンだけ（`showLoginOnly`）
//   ゲスト          … ログインのボタン ＋ **公開されている作戦**（`showGuestGate`）
//
// どちらも `main.gate` のまま。「ログイン前」という1つの場所に、
// 入れるものが増えただけという形にしてある（状態ごとに別の画面を作らない）。

import { listSessions } from "../api.js";
import { sayOffline, setEditable, setPage, setRailVisible } from "../chrome.js";
import { clearChildren } from "../render.js";
import { renderPublicSection } from "./list.js";

/** ログインのボタン。両方の状態で同じものを出す（押す先を2つ作らない）。 */
function loginButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "login";
  btn.className = "primary";
  btn.textContent = "Discord でログイン";
  btn.addEventListener("click", () => { location.href = "/api/auth/discord/start"; });
  return btn;
}

/** 画面の骨。`main` を空にして `gate` の体裁にする。 */
function openGate() {
  const main = document.querySelector("main");
  setPage("gate");
  clearChildren(main);
  setRailVisible(false);
  main.classList.add("gate");
  main.classList.remove("gate-guest");
  setEditable(false);
  return main;
}

export function showLoginOnly() {
  const main = openGate();
  main.appendChild(loginButton());
}

/**
 * ログイン無しで `/plan` を開いた人の画面。
 *
 * **公開されている作戦を出す。** 「公開」はそういう意味で、ここを閉じると
 * ログイン無しの人が辿れる作戦が1件も無くなる（URL を直接渡された場合しか
 * 入口が無い）。サーバは `sessions` と `visited` を空で返す——ゲストには
 * 保存された身元が無いので、返すものが無い。
 *
 * **ログインの導線はいちばん上に置く。** 一覧を先に出すと、書きたい人が
 * 下まで読んでから戻ることになる。
 *
 * **一覧が取れなくてもログインのボタンは残す**（取得の失敗で入口を失わない）。
 */
export async function showGuestGate() {
  const main = openGate();
  // 一覧を並べるので、中央寄せの1ボタンとは別の体裁にする（CSS 側で切り替え）。
  main.classList.add("gate-guest");

  const sheet = document.createElement("div");
  sheet.className = "sheet";
  main.appendChild(sheet);

  const intro = document.createElement("section");
  intro.className = "list-sec";
  intro.id = "guest-intro";
  const heading = document.createElement("h2");
  heading.textContent = "見るだけなら、このまま使えます";
  const lead = document.createElement("p");
  // **できることとできないことを1文で。** ここを読まずに盤面へ行った人が
  // 「道具が押せない」に出会うので、先に言っておく。
  lead.textContent =
    "下の公開されている作戦は、ログインしなくても開けます。"
    + "共有URLを渡されているなら、その URL をそのまま開いてください。"
    + "書き込むには Discord ログインが要ります。";
  intro.append(heading, lead, loginButton());
  sheet.appendChild(intro);

  let listed = [];
  try {
    listed = (await listSessions()).public ?? [];
  } catch (e) {
    if (e.status === undefined) { sayOffline(); return; }
    const err = document.createElement("p");
    err.className = "err";
    err.textContent = `公開されている作戦を取得できませんでした。${e.message}`;
    intro.appendChild(err);
    return;
  }

  // **0件の節は出さない**（空の見出しだけが並ぶ画面にしない。list.js と同じ約束）。
  if (listed.length) sheet.appendChild(renderPublicSection(listed));
  else {
    const none = document.createElement("p");
    none.id = "no-public";
    none.textContent = "いま公開されている作戦はありません。";
    intro.appendChild(none);
  }
}
