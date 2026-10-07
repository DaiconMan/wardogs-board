// 稼働中の `wrangler pages dev` が使っているローカル D1 の SQLite ファイルを、
// **子プロセスを立てずに**直接開いて SQL を流す。vitest（tests/）と Playwright（e2e/）の
// 両方のヘルパーがここを使う。
//
// **`wrangler d1 execute` を起動しないこと**（D-035 と、それを踏み抜いた CI の実例）。
// あの経路は 1 回ごとに npm exec → wrangler → miniflare → **2つ目の workerd** を立て、
// 1.3 秒かかる。その間 execFileSync がイベントループを止めるうえ、稼働中の dev サーバと
// 同じ persist ディレクトリを別の workerd が開く。CI では dev サーバがリクエスト処理中に
// 接続を切る形（UND_ERR_SOCKET）で落ちた。直接オープンなら 1 回 1〜5ms で子プロセスも増えない。
//
// 同じ実装を tests/ と e2e/ に 2 つ置くと、片方だけが古い書き方に戻る。1 本にまとめて、
// tests/plan-execd1.test.js と e2e/plan-execd1.spec.js の両方から同じものを見張る。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * miniflare がローカル D1 を置く SQLite ファイルを探す。
 * `<persist>/v3/d1/miniflare-D1DatabaseObject/<ハッシュ>.sqlite` という名前で、
 * 同じディレクトリに miniflare 自身の metadata.sqlite が並ぶので、そちらは外す。
 * ハッシュ名は miniflare の内部仕様なので、名前を組み立てずに実物を探す。
 *
 * @param {string} persistDir `--persist-to` に渡したディレクトリ。
 *   **呼ぶ側の cwd に依存しない絶対パスで渡すこと**（Playwright のテストは
 *   リポジトリ直下以外から起動されうる）。
 */
export function findD1File(persistDir) {
  const dir = join(persistDir, "v3", "d1", "miniflare-D1DatabaseObject");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    throw new Error(`${dir} を読めませんでした（サーバが起動しているか確認する）: ${e.message}`);
  }
  const found = entries.filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (found.length !== 1) {
    throw new Error(`${dir} の D1 ファイルを1つに特定できませんでした: ${JSON.stringify(found)}`);
  }
  return join(dir, found[0]);
}

/**
 * SQL を文ごとに分ける。クォート（'' のエスケープ込み）・識別子・コメントの
 * 中のセミコロンでは切らない。テストが書く程度の SQL が対象。
 */
export function splitStatements(sql) {
  const out = [];
  let buf = "";
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      // クォートの終わりまで（'' / "" / `` は中身のエスケープ）そのまま写す
      let j = i + 1;
      for (; j < sql.length; j += 1) {
        if (sql[j] !== c) continue;
        if (sql[j + 1] === c) { j += 1; continue; }
        break;
      }
      buf += sql.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      buf += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      buf += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * `persistDir` の D1 へ直接 SQL を流す。
 *
 * 稼働中のサーバと同じ SQLite ファイルを開くが、WAL なので読み書きは互いに見える
 * （tests/plan-execd1.test.js と e2e/plan-execd1.spec.js で両方向を実測している）。
 *
 * 戻り値は wrangler の `--json` と同じ「文ごとに1要素の配列」の文字列。
 * 呼び出し側が `out.slice(out.indexOf("["))` で読む書き方をそのまま使えるようにしてある。
 */
export function execD1In(persistDir, sql) {
  const db = new DatabaseSync(findD1File(persistDir));
  try {
    // 稼働中の dev サーバが書き込み中でも、少し待てば通る。
    db.exec("PRAGMA busy_timeout = 10000");
    const statements = splitStatements(sql).map((statement) => ({
      results: db.prepare(statement).all(),
      success: true,
      meta: {},
    }));
    return JSON.stringify(statements, null, 2);
  } catch (e) {
    throw new Error(`D1 の実行に失敗しました: ${sql}\n--- 原因 ---\n${e.message}`);
  } finally {
    db.close();
  }
}
