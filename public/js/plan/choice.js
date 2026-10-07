// 1択の欄。`<select>` の置き換え。
//
// ── なぜ `<select>` をやめたか ────────────────────────────────
// **選択肢の一覧（ポップアップ）はブラウザ／OS が描くので、こちらの CSS が
// 一切届かない。** オーナーの実機（Windows Chrome, 1439x862）で、
// 「想定するパターン」を開くと**薄いグレー地に薄いグレー文字**になり、
// 選択中の1件以外が読めなかった（2026-10-01 報告。スクリーンショット確認済み）。
//
// `:root` に `color-scheme:dark` を入れてあったが**効いていなかった**。
// `option` に色を直接指定する手は残っていたが、
//   * `color-scheme` が効かない環境で `option` の配色だけが効くとは言い切れない
//   * 直したとしても**確かめる手段が無い**
// の2点で採らない。2点目が決め手。`npm run shots` は Linux のヘッドレス
// Chrome なので、**この不具合はそもそも写らない**。写らないものを
// 「直した」と報告できない。
//
// ── 代わりに何にしたか ──────────────────────────────────────
// **選択肢を畳まない。** 1択の群れ（ARIA の radiogroup）として並べて出す。
// ポップアップが存在しないので:
//   * どの OS でも**同じ見た目**になる（描くのは全部こちらの CSS）
//   * `npm run shots` に**写る**。見た目の回帰を機械で押さえられる
//   * 選ぶのに1手（押す）で済む（開く → 選ぶ の2手が1手になる）
//
// 選択肢の数は最大10個（配置の優先度 なし/1〜9）。並べても畳むより場所を
// 食わない範囲に収まっている。**何十件も並ぶ欄には使わない。**
//
// ── キーボードとスクリーンリーダー ──────────────────────────
// `<select>` から落とさないことが条件。radiogroup の約束に合わせる。
//   * **Tab の止まり先はグループ全体で1つ**（選ばれている札。無ければ先頭）
//   * ← ↑ → ↓ で隣に移り、**移った先がその場で選ばれる**（radiogroup の作法）
//   * Home / End で両端
//   * Space / Enter は `<button>` が自分で click に変える
// `role="radio"` と `aria-checked` を出すので、読み上げは
// 「ラジオボタン 3の2 Farmland 選択済み」のように言える。

/** 選択肢の札を全部集める（並び順は DOM 順）。 */
const radios = (el) => [...el.querySelectorAll('[role="radio"]')];

/**
 * 1択の欄を作る。
 *
 * @param {object}      opts
 * @param {Element}    [opts.el]         既にある要素を使う（plan.html に置いてある欄）。
 *                                       省略すると `<div>` を作る。
 * @param {string}     [opts.id]         要素の id（`el` を渡したときは触らない）。
 * @param {string}     [opts.labelledBy] 見出しの要素の id（`aria-labelledby`）。
 * @param {string}     [opts.label]      `labelledBy` が無いときの `aria-label`。
 * @param {Function}   [opts.onChange]   **人が選んだときだけ**呼ばれる。値を1つ渡す。
 *                                       プログラムから `value` を入れたときは呼ばない
 *                                       （`<select>` の `change` と同じ約束）。
 */
export function createChoice({ el, id, labelledBy, label, onChange } = {}) {
  const root = el ?? document.createElement("div");
  if (id && !el) root.id = id;
  root.classList.add("choice");
  root.setAttribute("role", "radiogroup");
  if (labelledBy) root.setAttribute("aria-labelledby", labelledBy);
  else if (label) root.setAttribute("aria-label", label);

  let value = "";
  let disabled = false;

  /**
   * `aria-checked` と Tab の止まり先を貼り直す。
   *
   * **Tab の止まり先は必ず1つ。** 何も選ばれていないときは先頭に置く
   * （0個だと Tab でグループに入れなくなり、キーボードだけでは操作できない）。
   */
  const paint = () => {
    const list = radios(root);
    const at = list.findIndex((b) => b.dataset.value === value);
    list.forEach((b, i) => {
      const on = i === at;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = (at === -1 ? i === 0 : on) ? 0 : -1;
    });
  };

  /** 値を変える。`byUser` のときだけ onChange を呼ぶ。 */
  const choose = (next, byUser) => {
    if (next === value) return;
    value = next;
    paint();
    if (byUser) onChange?.(value);
  };

  /**
   * 選択肢を入れ替える。
   *
   * `next` が選択肢に無ければ**先頭を選ぶ**。`<select>` が中身を入れ替えた
   * ときに先頭が選ばれるのと同じ。この欄の先頭は必ず「選んでいない」側の札
   * （`value: ""`）なので、消えたものを選んだままにならない。
   *
   * @param {Array<{value:string, text:string, title?:string}>} list
   * @param {string} [next] 入れ替えたあとに選んでおく値。
   */
  const setOptions = (list, next = value) => {
    root.textContent = "";
    for (const o of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.value = o.value;
      b.textContent = o.text;
      if (o.title) b.title = o.title;
      b.disabled = disabled;
      // 押した札にフォーカスを移してから選ぶ。マウスで選んだあとに矢印キーを
      // 使ったとき、どこから動くのかが分かるようにするため。
      b.addEventListener("click", () => {
        b.focus();
        choose(b.dataset.value, true);
      });
      root.appendChild(b);
    }
    value = list.some((o) => o.value === next) ? next : (list[0]?.value ?? "");
    paint();
  };

  /** まとめて止める／戻す。`<select>` の `disabled` と同じ使い方。 */
  const setDisabled = (on) => {
    disabled = on;
    // Playwright の `toBeDisabled()` と読み上げの両方がこれを見る。
    if (on) root.setAttribute("aria-disabled", "true");
    else root.removeAttribute("aria-disabled");
    for (const b of radios(root)) b.disabled = on;
  };

  // ← ↑ → ↓ / Home / End。**移った先をその場で選ぶ**のが radiogroup の作法で、
  // `<select>` を閉じたまま矢印キーで値を変えるのと同じ操作感になる。
  root.addEventListener("keydown", (evt) => {
    if (disabled || evt.altKey || evt.ctrlKey || evt.metaKey) return;
    const list = radios(root);
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement);
    let to;
    if (evt.key === "ArrowDown" || evt.key === "ArrowRight") to = (at + 1) % list.length;
    else if (evt.key === "ArrowUp" || evt.key === "ArrowLeft") to = (at - 1 + list.length) % list.length;
    else if (evt.key === "Home") to = 0;
    else if (evt.key === "End") to = list.length - 1;
    else return;
    // 盤面はキー1文字を道具の切り替えに使っている。欄の中の矢印キーを
    // そちらに流さない。
    evt.preventDefault();
    evt.stopPropagation();
    list[to].focus();
    choose(list[to].dataset.value, true);
  });

  return {
    el: root,
    get value() { return value; },
    /** プログラムからの代入。選択肢に無い値を入れると「何も選ばれていない」になる。 */
    set value(next) {
      const has = radios(root).some((b) => b.dataset.value === next);
      value = has ? next : "";
      paint();
    },
    get disabled() { return disabled; },
    setOptions,
    setDisabled,
    /** 選ばれている札（無ければ先頭）にフォーカスを移す。 */
    focus() {
      const list = radios(root);
      (list.find((b) => b.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
    },
  };
}
