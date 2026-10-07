// e2e/plan-helpers.js の `execD1` そのものを守るテスト。
//
// **なぜ UIテストの中に土台のテストがあるのか**（D-035 の続き）
// `execD1` は e2e の4ファイルが「管理者に上げる」「パターンを仕込む」ために使う土台で、
// CI では合計 35 回ほど呼ばれる。ここが重いと **UIテストの中身とは無関係に** CI が落ちる。
// 実際に vitest 側が落ちた。原因は `execD1` が呼び出しのたびに
// `wrangler d1 execute` を起動していたことで、1回あたり
//
//   node(wrangler) → miniflare → **workerd をもう1個**
//
// が立ち上がり、**稼働中の e2e サーバと同じ persist ディレクトリを2つ目の workerd が開く**。
// 1.3 秒かかり、その間 execFileSync がイベントループを止める。
//
// なので「形が合っている」だけでなく **「子プロセスを起こさない」こと自体**を固定する。
// vitest 側（tests/plan-execd1.test.js）と対になる一本で、見ている persist ディレクトリが
// 違う（e2e は .wrangler/e2e-plan-state）。**パスの解決はここでしか確かめられない。**
import { test, expect } from "@playwright/test";

import { createPlan, execD1, loginViaApi, planUrl } from "./plan-helpers.js";

/** 呼び出し側（plan-zones など）がやっているのと同じ読み方。 */
const parse = (out) => JSON.parse(out.slice(out.indexOf("[")));

test.describe("execD1 の出力の形", () => {
  test("先頭の [ から JSON 配列として読め、[0].results に行が入る", () => {
    expect(parse(execD1("SELECT 1 AS n, 'あ' AS s"))[0].results).toEqual([{ n: 1, s: "あ" }]);
  });

  test("複数文は文ごとに1要素返る", () => {
    const statements = parse(
      execD1("SELECT 1 AS n;SELECT 2 AS n;SELECT id FROM maps ORDER BY id;")
    );
    expect(statements.length, "3文なら3要素").toBe(3);
    expect(statements[0].results).toEqual([{ n: 1 }]);
    expect(statements[statements.length - 1].results.length).toBeGreaterThan(0);
  });

  test("文字列リテラルの中のセミコロンで文を割らない", () => {
    expect(parse(execD1("SELECT 'a;b' AS s"))[0].results).toEqual([{ s: "a;b" }]);
  });

  test("壊れた SQL は SQL 本文を載せた例外になる", () => {
    expect(() => execD1("SELECT * FROM 存在しない表")).toThrow(/存在しない表/);
  });
});

test.describe("稼働中の e2e サーバとの間でデータが見える", () => {
  // 行は「自分のユーザーが作った作戦」の中だけで足す・書き換える。
  // maps のような全員から見える表に足すと、枠の数を見ている
  // plan-patterns.spec.js などが実行順によって落ちる。
  test("サーバが書いた行を execD1 が読み、execD1 が書いた行をサーバが読む", async ({ context }) => {
    await loginViaApi(context, "9801", "execd1-both-ways");
    const id = await createPlan(context, "execD1 から見える作戦");

    const rows = parse(execD1(`SELECT title FROM sessions WHERE id = '${id}'`))[0].results;
    expect(rows, "サーバが書いた行が見える").toEqual([{ title: "execD1 から見える作戦" }]);

    execD1(`UPDATE sessions SET title = 'execD1 が書き換えた作戦' WHERE id = '${id}'`);
    const res = await context.request.get(planUrl(`/api/sessions/${id}`));
    expect(res.status()).toBe(200);
    expect((await res.json()).session.title, "execD1 が書いた行がサーバから見える").toBe(
      "execD1 が書き換えた作戦"
    );
  });
});

test.describe("execD1 は子プロセスを起こさない（D-035 を機械で守る）", () => {
  // `wrangler d1 execute` を起動していた頃は 1 回 1,300ms 前後だった（実測）。
  // SQLite のファイルを直接開く今は 1〜5ms で終わる。200ms は 2 桁の余裕がある閾値で、
  // 「また別プロセスを起こす実装に戻した」ときだけ落ちる。
  test("単純な SELECT は 200ms 以内に終わる", () => {
    execD1("SELECT 1"); // 初回のオープン分を除く
    const started = Date.now();
    execD1("SELECT COUNT(*) AS n FROM sessions");
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("20 回続けて呼んでも合計 2 秒以内（ループで回しても CI を壊さない）", () => {
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) execD1(`SELECT ${i} AS n`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
