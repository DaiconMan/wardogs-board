// BLOCKED_WORDS。起動時の環境で有効／無効が決まるため、設定あり（blocked）と
// 設定なし（base）の2インスタンスに対してテストする。
import { describe, it, expect } from "vitest";
import { postComment, ipGenerator } from "./helpers.js";

// BLOCKED_WORDS = "禁止語, BadWord ,,  spam  "
const nextIp = ipGenerator(3);

describe("BLOCKED_WORDS 設定あり", () => {
  // [18]
  it("該当語を含む本文は 400", async () => {
    const res = await postComment("blocked", { section: "general", body: "これは禁止語を含みます [18]" }, nextIp());
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  // [18] 大文字小文字を区別しない
  it("大文字小文字が違っても弾く", async () => {
    const lower = await postComment("blocked", { section: "general", body: "contains badword here [18]" }, nextIp());
    expect(lower.status).toBe(400);

    const upper = await postComment("blocked", { section: "general", body: "CONTAINS BADWORD HERE [18]" }, nextIp());
    expect(upper.status).toBe(400);
  });

  // [18] 各語は trim される / 空要素は無視される
  it("前後に空白がある語も trim して判定する", async () => {
    const res = await postComment("blocked", { section: "general", body: "this is spam [18]" }, nextIp());
    expect(res.status).toBe(400);
  });

  it("空要素があっても全部を弾いたりしない", async () => {
    const res = await postComment("blocked", { section: "general", body: "空要素は無視される [18]" }, nextIp());
    expect(res.status).toBe(201);
  });

  // [19]
  it("該当語を含まない本文は 201", async () => {
    const res = await postComment("blocked", { section: "general", body: "普通の作戦メモです [19]" }, nextIp());
    expect(res.status).toBe(201);
    expect(res.body.comment.body).toBe("普通の作戦メモです [19]");
  });
});

describe("BLOCKED_WORDS 未設定", () => {
  // [20]
  it("同じ語を含む本文でも 201（機能が無効であること）", async () => {
    const res = await postComment(
      "base",
      { section: "general", body: "これは禁止語と badword と spam を含みます [20]" },
      nextIp()
    );
    expect(res.status).toBe(201);
  });
});
