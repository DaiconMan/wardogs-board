// 議論欄（作戦ノート時代の匿名コメント欄）を畳んだことを固定するテスト。
//
// 何があったか。`/` の配信を止めて `public/index.html` をリダイレクタにした時点で、
// 投稿フォームも人間確認のウィジェットも画面から消えた。それでもサーバ側の
// `POST /api/comments` は人間確認の secret が設定されている限りトークンを要求するので、
// **ウィジェットが無いのにトークンを要求する**＝投稿する経路が構造的に存在しない、
// という状態が残っていた（本番で 403 を実測）。だから API ごと畳んだ。
//
// **`comments` テーブルと行は残す。** 読み書きする経路が無いだけで、消えてはいない。
// `schema.sql` から落とすと、次にスキーマを流したときに「無かったこと」になる。
// その意図が伝わるよう、テーブルの直前のコメントもここで見張る。
//
// なぜテストにするのか。この手の「畳んだはずのもの」は、
//   * 死んだ下請け（人間確認の検証、専用のテストサーバ構成）が置き去りになる
//   * README や開発ガイドに「投稿できます」という古い説明が残る
//   * 使われていない secret が本番に残り続ける
// という形で静かに戻ってくる。形で見張るのがいちばん安い。
//
// EN: Pins the retirement of the discussion board (the anonymous comment form from
//     the days when `/` served the strategy notes). Once `/` became a redirector the
//     form and its human-verification widget disappeared from every page, yet the
//     server still demanded a verification token, so posting was structurally
//     impossible (measured as 403 in production). The API is therefore gone.
//     The `comments` table and its rows stay: only the read/write path is gone, the
//     data is not. Dropping it from `schema.sql` would erase it on the next apply,
//     so the explanatory comment above the table is pinned here too.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

/**
 * git が追跡しているテキストファイル。`find` ではなく `git ls-files` で引く理由は
 * tests/naming.test.js と同じ（`node_modules/` や手元の作業ファイルを拾わない）。
 * **子プロセスは1テストファイルで1回だけ**（D-066）。
 */
const textFiles = () =>
  execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0")
    .filter(Boolean)
    .filter((f) => !/^package-lock\.json$|\.(png|jpe?g|webp|gif|ico|woff2?|ttf|zip|pdf)$/i.test(f));

/**
 * 走査から外すもの。
 *
 *   * `DECISIONS.md` と `docs/` … 決定記録・調査記録・検証記録。「いつ何を決めて
 *     何を実測したか」の履歴なので、過去の記述を現在形に書き換えない。
 *   * このテスト自身 … 下の正規表現が自分の本文に当たる。探している語を
 *     ファイル内に書けなくなると説明が書けないので、パスで外す。
 */
const SELF = "tests/no-comments-api.test.js";
const ALLOW = [/^DECISIONS\.md$/, /^docs\//, new RegExp(`^${SELF.replace(/\./g, "\\.")}$`)];

const scanned = () => textFiles().filter((f) => !ALLOW.some((a) => a.test(f)));
const hits = (re) => scanned().filter((f) => re.test(read(f)));

/** 実際に動くコードの置き場所。ここに参照が残っていたら、それは呼び出しか経路。 */
const CODE = /^(functions|public|workers|tools|testlib|tests|e2e)\//;

/**
 * 行コメント（`//`）とブロックコメントの行を落とす。
 *
 * **「文字列が1度も現れない」では強すぎる。** 畳んだ経緯を説明する文には
 * `/api/comments` と書くのが自然で、それを禁じると説明が書けなくなる。
 * 見たいのは「**呼んでいるか**」なので、コメントを除いた本文だけを見る。
 */
const stripComments = (src) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n");

describe("議論欄は畳んである", () => {
  it("functions/api/comments.js が無い", () => {
    expect(existsSync(join(ROOT, "functions", "api", "comments.js"))).toBe(false);
  });

  it("どのコードも /api/comments を呼んでいない", () => {
    const found = scanned()
      .filter((f) => CODE.test(f))
      .filter((f) => /\/api\/comments/.test(stripComments(read(f))));
    expect(found, `議論欄の API への参照が残っている: ${found.join(", ")}`).toEqual([]);
  });

  it("人間確認（Cloudflare のウィジェット）への参照が1つも無い", () => {
    // `Turnstile` という語を直接書くと自分に当たるので、組み立てて使う。
    // 大文字小文字を問わず、`*_SECRET` / `*_SITE_KEY` / ウィジェットの class 名を
    // まとめて捕まえる。
    const found = hits(new RegExp(["turn", "stile"].join(""), "i"));
    expect(found, `人間確認の参照が残っている: ${found.join(", ")}`).toEqual([]);
  });

  it("専用のテストサーバ構成（8811-8814）が無い", () => {
    for (const f of ["tests/config.js", "tests/helpers.js", "tests/global-setup.js"]) {
      expect(existsSync(join(ROOT, f)), f).toBe(false);
    }
    // 設定として生きていないこと（コメントで言及するのは構わない）。
    expect(read("vitest.config.js")).not.toMatch(/^\s*globalSetup\s*:/m);
  });
});

describe("comments テーブルは残してある", () => {
  it("schema.sql がテーブルと索引を作り続ける", () => {
    const sql = read("schema.sql");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS comments\b/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_comments_section\b/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_comments_ip\b/);
  });

  it("残している理由がテーブルの直前のコメントに書いてある", () => {
    // 「なぜ使われていないテーブルがあるのか」を次の人が自力で分かる形にする。
    // 文面そのものは比べない（言い換えで落ちるテストにしない）。見るのは
    // 「CREATE TABLE の直前に `--` のコメント塊があり、読み書きの経路が
    // もう無いことに触れている」ことだけ。
    const sql = read("schema.sql");
    const before = sql.slice(0, sql.indexOf("CREATE TABLE IF NOT EXISTS comments"));
    const block = before.split("\n").reverse();
    const lead = [];
    for (const line of block) {
      if (line.startsWith("--")) lead.unshift(line);
      else if (line.trim() === "" && lead.length === 0) continue;
      else break;
    }
    const text = lead.join("\n");
    expect(text, "comments テーブルの直前にコメントが無い").not.toBe("");
    expect(text).toMatch(/作戦ノート/);
    expect(text).toMatch(/経路/);
  });
});
