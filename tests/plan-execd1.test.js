// tests/plan-helpers.js の execD1 そのものを守るテスト。
//
// **なぜテストが要るのか**（D-035 の続き）
// execD1 は 8 つのテストファイルが「DB を直接見る／直接書く」ために使う土台で、
// ここが重いと CI が落ちる。実際に落ちた。原因は execD1 が呼び出しのたびに
// `npx wrangler d1 execute` を起動していたことで、1回あたり
//
//   npm exec → sh → wrangler(node) → miniflare(node) → **workerd をもう1個**
//
// の 4〜5 プロセスが立ち上がり、**稼働中の dev サーバと同じ persist ディレクトリを
// 2つ目の workerd が開く**。1.3 秒かかり、その間 execFileSync がイベントループを
// 止める。plan-areas.test.js はこれを 21 回やっていた。
//
// なので「形が合っている」だけでなく **「子プロセスを起こさない」こと自体**を
// テストで固定する。D-035 の規約（execD1 をループで回さない）を人の注意力ではなく
// 機械で守るための一本。
import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs, execD1 } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;
const ORIGIN = baseUrl("plan");

/** 呼び出し側（plan-areas など）がやっているのと同じ読み方。 */
const parse = (out) => JSON.parse(out.slice(out.indexOf("[")));

describe("execD1 の出力の形", () => {
  it("先頭の [ から JSON 配列として読め、[0].results に行が入る", () => {
    const rows = parse(execD1("SELECT 1 AS n, 'あ' AS s"))[0].results;
    expect(rows).toEqual([{ n: 1, s: "あ" }]);
  });

  it("複数文は文ごとに1要素返る（plan-zones は末尾の要素を見ている）", () => {
    const statements = parse(
      execD1(
        "SELECT 1 AS n;" +
          "SELECT 2 AS n;" +
          "SELECT id FROM maps ORDER BY id;"
      )
    );
    expect(statements.length, "3文なら3要素").toBe(3);
    expect(statements[0].results).toEqual([{ n: 1 }]);
    expect(statements[statements.length - 1].results.length).toBeGreaterThan(0);
  });

  it("文字列リテラルの中のセミコロンで文を割らない", () => {
    const rows = parse(execD1("SELECT 'a;b' AS s"))[0].results;
    expect(rows).toEqual([{ s: "a;b" }]);
  });

  it("書き込み文も1要素返る（results は空）", () => {
    const statements = parse(
      execD1(
        `INSERT OR IGNORE INTO maps (id, name, width_m, height_m, verified, created_at)
         VALUES ('execd1test', 'execD1 のテスト', 1000, 1000, 0, 1000)`
      )
    );
    expect(statements.length).toBe(1);
    expect(statements[0].results).toEqual([]);
  });

  it("壊れた SQL は SQL 本文を載せた例外になる", () => {
    expect(() => execD1("SELECT * FROM 存在しない表")).toThrow(/存在しない表/);
  });
});

describe("稼働中の dev サーバとの間でデータが見える", () => {
  it("execD1 で入れた行をサーバが読む", async () => {
    execD1(
      `INSERT OR IGNORE INTO maps (id, name, width_m, height_m, verified, created_at)
       VALUES ('execd1seen', 'サーバから見えるか', 2000, 2000, 0, 1000)`
    );
    const { cookie } = await loginAs("8901", "execd1reader");
    const r = await fetch(url("/api/maps"), { headers: { cookie } });
    expect(r.status).toBe(200);
    expect((await r.json()).maps.map((m) => m.id)).toContain("execd1seen");
  });

  it("サーバが書いた行を execD1 が読む", async () => {
    const { cookie } = await loginAs("8902", "execd1writer");
    const created = await fetch(url("/api/sessions"), {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ map_id: "bakurani", title: "execD1 から見える作戦" }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()).session;

    const rows = parse(execD1(`SELECT title FROM sessions WHERE id = '${id}'`))[0].results;
    expect(rows).toEqual([{ title: "execD1 から見える作戦" }]);
  });
});

describe("execD1 は子プロセスを起こさない（D-035 を機械で守る）", () => {
  // `npx wrangler d1 execute` を起動していた頃は 1 回 1,300ms 前後だった（実測）。
  // SQLite のファイルを直接開く今は 1〜5ms で終わる。200ms は 2 桁の余裕がある閾値で、
  // 「また別プロセスを起こす実装に戻した」ときだけ落ちる。
  it("単純な SELECT は 200ms 以内に終わる", () => {
    execD1("SELECT 1"); // 初回のオープン分を除く
    const started = Date.now();
    execD1("SELECT COUNT(*) AS n FROM sessions");
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("20 回続けて呼んでも合計 2 秒以内（ループで回しても CI を壊さない）", () => {
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) execD1(`SELECT ${i} AS n`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
