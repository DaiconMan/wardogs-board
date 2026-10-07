// 画面の枠（ヘッダ・フッター・状態表示・道具の棚・畳んだメニュー）。
//
// 盤面でも一覧でもログイン前でも同じように出るものだけを置く。

import { footerEl, headerEl, mainEl, railEl, statusEl, toolsEl, viewMenu } from "./dom.js";
import { state } from "./state.js";

export function say(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "err" : "";
}

export function setEditable(on) {
  state.editable = on;
  for (const b of toolsEl.querySelectorAll("button")) b.disabled = !on;
  // <summary> は disabled を持てないので、棚ごと印を付けて CSS 側で止める。
  if (railEl) railEl.dataset.disabled = String(!on);
  if (!on) closeViewMenu();
}

/**
 * 「見るだけ」で公開された作戦を開いたとき。**書く道具だけ止めて、見る道具は残す。**
 *
 * `setEditable(false)` は棚のボタンを**全部**止める。あれは「API が不通」
 * ＝何もできない状態のためのもので、読専の作戦には強すぎる。
 * 読めるのに**拡大縮小も背景の切り替えもできない**のでは、「読むだけ」の
 * 読むほうが成り立たない（ホイールとドラッグは効き続けるが、それを知らない人には
 * 画面が壊れて見える）。
 *
 * `state.editable` は false のままにする。盤面の書き込み（pointer.js）と
 * 詳細パネルの欄（board/detail.js）はこの旗を見て止まる。
 */
export function setViewOnly() {
  setEditable(false);
  for (const b of toolsEl.querySelectorAll("#zoom button, #view-menu button")) {
    b.disabled = false;
  }
  // 「表示」のメニューを開けるように戻す（CSS が見るのは "true" だけ）。
  if (railEl) railEl.dataset.disabled = "false";
}

/**
 * 道具の棚を畳む。
 *
 * 押せない道具を 15 個並べても、できることは 1 つも増えない。
 * ログイン前と作戦の一覧では棚ごと消し、フッターには状態表示だけ残す
 * （通知の出口はどの画面でも同じ場所にする）。
 */
export function setRailVisible(on) {
  if (railEl) railEl.hidden = !on;
  updateRailOverflow();
}

/**
 * 狭い画面では棚が1段の横スクロールになる。**まだ続きがあることを見せる。**
 *
 * 実機（390px）で「建造物」が画面の端で半分だけ切れて「造物」と見えていた。
 * 半分切れたボタンは「続きがある」ではなく「壊れている」に見えるので、
 * 送れる向きを `data-overflow` に出し、CSS が端にぼかしを敷く。
 * 広い画面では棚が折り返すので、この値は常に "none" になる。
 */
/**
 * 浮いている枠が実際に何px あるかを CSS へ渡す。
 *
 * 盤面のページでは header / footer が `position:absolute` で**高さを取らない**
 * ので、浮かせたパネル・縮尺・座標は「枠がどこまで来ているか」を自分で知る
 * 手段が無い。測って `--chrome-top` / `--chrome-bottom` に書き戻す
 * （Clutchbase が `--bb-chrome` を実測して書き戻しているのと同じ手）。
 * 数値の持ち主はこの関数1箇所だけにする。
 *
 * **下は棚（#rail）の上端まで**で測る。フッターには状態表示も入るが、あれは
 * 出たり消えたりするので、そこまで含めると文が出るたびに座標表示が飛ぶ。
 */
export function measureChrome() {
  if (!mainEl) return;
  const top = headerEl ? headerEl.getBoundingClientRect().height : 0;
  const anchor = railEl && !railEl.hidden ? railEl : footerEl;
  const box = anchor ? anchor.getBoundingClientRect() : null;
  const bottom = box ? Math.max(0, innerHeight - box.top) : 0;
  mainEl.style.setProperty("--chrome-top", `${Math.round(top)}px`);
  mainEl.style.setProperty("--chrome-bottom", `${Math.round(bottom)}px`);
}

/** 枠の大きさが変わったら測り直す（在室が増える・状態表示が出る・窓が変わる）。 */
export function watchChrome() {
  measureChrome();
  if (typeof ResizeObserver !== "function") return;
  const ro = new ResizeObserver(() => measureChrome());
  if (headerEl) ro.observe(headerEl);
  if (footerEl) ro.observe(footerEl);
}

export function updateRailOverflow() {
  if (!railEl || railEl.hidden) return;
  const slack = railEl.scrollWidth - railEl.clientWidth;
  const left = railEl.scrollLeft > 1;
  const right = railEl.scrollLeft < slack - 1;
  railEl.dataset.overflow =
    left && right ? "both" : left ? "left" : right ? "right" : "none";
}

/** 盤面にいることをヘッダに出す（サイト名＋作戦名＋一覧へ戻る導線）。 */
export function showBackToList() {
  const link = document.getElementById("to-list");
  if (link) link.hidden = false;
  const brand = document.getElementById("brand");
  if (brand) brand.hidden = false;
}

// API が落ちてもページは壊さない。ヘッダとツールバーは残したまま編集だけ止める。
export function sayOffline() {
  say("接続できません。APIが未設定か、一時的な不調です。", true);
  setEditable(false);
}

/**
 * いまどの画面にいるかを body に出す。
 *
 * `board` のときだけ **地図が全面・枠は浮く**（plan.html の
 * `body[data-page="board"]`）。一覧とログイン前は読み物なので従来の3段のまま。
 * CSS 側が1つの属性だけを見れば済むようにしておく。
 */
export function setPage(page) {
  document.body.dataset.page = page;
}

/** 背景メニューを畳む。開いていないときは何もしない。 */
export function closeViewMenu() {
  if (viewMenu) viewMenu.open = false;
}

/**
 * 畳んだメニュー（<details class="menu">）の開け閉め。
 *
 * <details> は自分では閉じないので、外を押したときと Esc で畳む。
 * 開きっぱなしのパネルが地図を覆い続けるのを防ぐ。
 * 「表示」と「自分」の2枚が同じ作法で動く（開け方を2つ覚えさせない）。
 */
export function wireMenu(menu) {
  if (!menu) return;
  // 狭い画面では浮かせず、横スクロールする棚の続きとして開く（plan.html 参照）。
  // 開いた先が画面の外だと気づけないので、見える位置まで送る。
  menu.addEventListener("toggle", () => {
    if (!menu.open) return;
    // 同時に2枚開かない（どちらが効いているか分からなくなる）。
    for (const other of document.querySelectorAll("details.menu[open]")) {
      if (other !== menu) other.open = false;
    }
    menu.querySelector(".menu-body")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  document.addEventListener("pointerdown", (evt) => {
    if (!menu.open) return;
    if (evt.target instanceof Node && menu.contains(evt.target)) return;
    menu.open = false;
  });
  document.addEventListener("keydown", (evt) => {
    if (evt.key !== "Escape" || !menu.open) return;
    menu.open = false;
    // 閉じたあとフォーカスが宙に浮かないよう、開いたボタンへ戻す。
    menu.querySelector("summary")?.focus();
  });
}
