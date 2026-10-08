// 主要ファイルの先頭コメントに英語の要約が併記されていることを固定する。
//
// **なぜテストにするのか。** リポジトリを公開したので、コメントが日本語だけだと
// 「読めないから読まない」で終わる。かといって全部を英語にすると、普段読む側
// （日本語の話者）の密度が落ちる。決めた形は「**日本語を消さずに、主要ファイルの
// 先頭ブロックにだけ英語を足す**」。
//
// この形は放っておくと崩れる（新しいモジュールを足した人が英語を書かない、
// あるいは先頭ブロックを書き直したときに英語だけ落とす）。だから機械に見張らせる。
//
// 見張るのは3つだけ。
//   1. 対象ファイルに `// EN:` の行があること
//   2. それが**先頭のコメント塊の中**にあること（ファイル末尾に足して逃げられない）
//   3. 日本語が消えていないこと（置き換えではなく併記）
//
// EN: Pins the rule that the leading comment block of each major file carries an
//     English summary alongside the Japanese one. The repository is public, so a
//     Japanese-only header means English readers stop at the first line; but
//     translating everything wholesale would thin out the prose for the people who
//     read it daily. The agreed shape is "keep the Japanese, add English to the
//     leading block of the major files only", and this test is what keeps that
//     shape from eroding.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 英語の併記を要求するファイル。
 *
 * **「全部」ではない。** 行中のコメントや小さな下請け（util.js / choice.js など）は
 * 対象外で、ここに挙げたのは「初めて読む人が最初に開くファイル」だけ。
 * 増やすのは構わないが、**減らすときは理由を書くこと。**
 */
const FILES = [
  // /plan のモジュール
  "public/js/plan/app.js",
  "public/js/plan/api.js",
  "public/js/plan/coords.js",
  "public/js/plan/viewport.js",
  "public/js/plan/render.js",
  "public/js/plan/ink.js",
  "public/js/plan/placements.js",
  "public/js/plan/areas.js",
  "public/js/plan/zones.js",
  "public/js/plan/towers.js",
  "public/js/plan/spawns.js",
  "public/js/plan/callouts.js",
  "public/js/plan/gutter.js",
  "public/js/plan/sessions.js",
  "public/js/plan/cursors.js",
  "public/js/plan/changes.js",
  "public/js/plan/history.js",
  "public/js/plan/marquee.js",
  "public/js/plan/state.js",
  "public/js/plan/dom.js",
  "public/js/plan/visibility.js",
  "public/js/plan/guest.js",
  "public/js/plan/board/basemap.js",
  "public/js/plan/board/cursor.js",
  "public/js/plan/board/history.js",
  "public/js/plan/board/marquee.js",
  "public/js/plan/board/reload.js",
  // Durable Object の Worker
  "workers/room/src/index.js",
  "workers/room/src/presence.js",
  "workers/room/src/cursors.js",
  // Pages Functions の共通部分
  "functions/_lib/guard.js",
  "functions/_lib/guest.js",
  "functions/_lib/ink.js",
  "functions/_lib/session.js",
  "functions/_lib/validate.js",
  "functions/_lib/visibility.js",
  "functions/_lib/zones.js",
];

/** ファイル先頭の連続した行コメント（`//`）だけを取り出す。 */
const leadingComment = (src) => {
  const out = [];
  for (const line of src.split("\n")) {
    if (line.startsWith("//")) out.push(line);
    else if (line === "" && out.length === 0) continue;  // 先頭の空行は読み飛ばす
    else break;
  }
  return out.join("\n");
};

describe("主要ファイルの先頭コメントに英語を併記している", () => {
  it.each(FILES)("%s", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const head = leadingComment(src);

    // 2: 先頭のコメント塊の中にあること（末尾に付け足して逃げられない）
    expect(head, `${rel}: 先頭のコメント塊に「// EN:」が無い`).toMatch(/^\/\/ EN: /m);

    // 3: 日本語が消えていないこと。ひらがな・カタカナ・漢字のどれかが残っていればよい
    expect(head, `${rel}: 先頭のコメントから日本語が消えている`)
      .toMatch(/[぀-ヿ一-鿿]/);

    // 続きの行は `//     ` で字下げして、日本語の段落と混ざらないようにする
    const after = head.split(/^\/\/ EN: .*$/m)[1] ?? "";
    for (const line of after.split("\n").slice(1)) {
      if (line === "//" || !line.startsWith("//")) break;
      expect(line, `${rel}: EN の続き行は「//     」で字下げする`).toMatch(/^\/\/ {5}\S/);
    }
  });
});
