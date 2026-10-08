// 操作の台帳と、「戻す」「やり直す」の2つの山。**ここは何も import しない**
// （循環を作らない。DOM もサーバも触らないので vitest で時計も盤面も要らずに確かめられる）。
//
// EN: The ledger of operations plus the undo and redo stacks. This file imports
//     nothing and touches neither the DOM nor the server, so vitest can check it
//     without a board. Redo re-runs the creation path and pushes a *fresh* ledger
//     entry instead of rewriting the old entry's id — see below.
//
// ── 山が2つある理由 ──────────────────────────────────────────
// 線・配置・エリア・地名は**1本の台帳**（`done`）に操作した順で積む。戻すときは
// 末尾から種類を見て戻す。**戻した操作は捨てずに `undone` へ移す**ので、やり直せる。
// **新しい操作をしたら `undone` を捨てる**（分岐した履歴を持たない。普通の作法）。
//
// ── id が変わることへの答え ───────────────────────────────────
// 戻す ＝ サーバから DELETE、やり直す ＝ もう一度 POST なので、**新しい id が振られる。**
//
// **やり直しは「古い項目の id を書き換える」のではなく、「置く経路をもう一度通して、
// その結果を新しい項目として積む」形にしてある。** 配置・地名・エリアの台帳項目は
// オブジェクトの参照を持ち、`id` は POST の `.then()` が入れるので、作り直せば
// 新しい id が自然に入る。**id を書き換える工程そのものが無いので、書き忘れる場所も無い。**
// 観測できる挙動（やり直したあと、もう一度「戻す」が効く）は同じ。
//
// そのために積む関数が2本ある。**`record` は `undone` を捨て、`recordReplay` は捨てない。**
// やり直しで `record` を使うと、2件続けてやり直せなくなる。

/** 山が動いたことを知らせる先。ボタンの押せる・押せないを合わせるのに使う。 */
let watch = null;
export const onHistoryChange = (fn) => { watch = fn; };
function moved() {
  if (!watch) return;
  // **上乗せなので、ここで投げない。** 知らせられなくても台帳は動いている。
  try {
    watch();
  } catch {
    /* ボタンを塗り替えられなかっただけ */
  }
}

export const newHistory = () => ({ done: [], undone: [] });

/** 人がした新しい操作を積む。**やり直しの山は捨てる。** */
export function record(h, entry) {
  h.done.push(entry);
  h.undone.length = 0;
  moved();
  return entry;
}

/**
 * やり直しで作り直したものを積む。**やり直しの山は捨てない。**
 * 捨てると、2件続けてやり直したときに2件目が消える。
 */
export function recordReplay(h, entry) {
  h.done.push(entry);
  moved();
  return entry;
}

/** 戻す対象を取り出す。空なら undefined。 */
export function takeUndo(h) {
  const entry = h.done.pop();
  moved();
  return entry;
}

/** 戻せなかったときに、取り出した項目を元の位置（末尾）へ返す。 */
export function restoreDone(h, entry) {
  h.done.push(entry);
  moved();
  return entry;
}

/** 戻せた操作の写しを、やり直しの山へ積む。 */
export function pushUndone(h, snapshot) {
  h.undone.push(snapshot);
  moved();
  return snapshot;
}

/**
 * 画面から消えたものの項目を台帳から外す。
 *
 * **残すと、消えたものをもう一度消しにいく**（他の人が消した・保存が失敗した、など）。
 * 配置・地名・エリアを画面から外す所（`removePlacement` ほか）が呼ぶ。
 * 外した件数を返す。
 */
export function dropDone(h, match) {
  const i = h.done.findIndex(match);
  if (i === -1) return 0;
  h.done.splice(i, 1);
  moved();
  return 1;
}

/** やり直す対象を取り出す。空なら undefined。 */
export function takeRedo(h) {
  const snapshot = h.undone.pop();
  moved();
  return snapshot;
}

export const canUndo = (h) => h.done.length > 0;
export const canRedo = (h) => h.undone.length > 0;

/**
 * 戻すときに取る写し ＝ **やり直すために作り直す中身**。
 *
 * **値を複製する。参照では持たない。** 戻す ＝ 画面のオブジェクトが消えるので、
 * `p` や `row` への参照を山に積んでも、やり直すときに中身が読めない
 * （消したあとで誰かが同じオブジェクトを触っていれば値も変わっている）。
 *
 * やり直せない項目には null を返す。いまそれに当たるのは、
 * **中身を持たずに保存した線**（台帳に `{ path, saving }` だけで積まれたもの）で、
 * 戻すことはできてもやり直せない。呼び出し側は null を見たら山に積まない。
 */
export function snapshotOf(entry) {
  if (!entry) return null;

  if (entry.placement) {
    const p = entry.placement;
    return {
      kind: "placement",
      item_id: p.item_id,
      x_m: p.x_m,
      y_m: p.y_m,
      label: p.label ?? null,
      // 優先度は 1〜9 か「なし」。壊れた値をそのまま持ち回さない
      // （POST には乗らず PATCH で後から付けるので、ここで形を揃えておく）。
      rank: Number.isInteger(p.rank) ? p.rank : null,
    };
  }

  if (entry.callout) {
    const c = entry.callout;
    return { kind: "callout", name: c.name, x_m: c.x_m, y_m: c.y_m };
  }

  if (entry.area) {
    const a = entry.area;
    // **`op`（add / sub）を必ず持つ。** 落とすと「消した」をやり直したときに
    // 「塗った」になる（エリアは追記型の op ログなので、向きが意味を持つ）。
    return {
      kind: "area",
      areaKind: a.kind,
      op: a.op,
      cell_m: a.cell_m,
      rects: a.rects.map((r) => [...r]),
    };
  }

  if (entry.ink) {
    const i = entry.ink;
    return {
      kind: "ink",
      color: i.color,
      width: i.width,
      points: i.points.map((p) => ({ x_m: p.x_m, y_m: p.y_m })),
    };
  }

  return null;
}
