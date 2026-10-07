// Turnstile 検証。`TURNSTILE_SECRET` は起動時の環境で決まるため、成功用／失敗用の
// インスタンスを別ポートで立て、それぞれに対してテストする。
import { describe, it, expect } from "vitest";
import { postComment, ipGenerator } from "./helpers.js";

const nextIp = ipGenerator(2);

describe("Turnstile", () => {
  // [15]
  it("TURNSTILE_SECRET 設定あり + token 無しの POST は 403", async () => {
    const res = await postComment("turnstilePass", { section: "general", body: "token 無し [15]" }, nextIp());
    expect(res.status).toBe(403);
  });

  // [16]
  it("常に失敗するシークレットなら token を付けても 403", async () => {
    const res = await postComment(
      "turnstileFail",
      { section: "general", body: "常に失敗 [16]", token: "dummy-turnstile-token" },
      nextIp()
    );
    expect(res.status).toBe(403);
  });

  // [17]
  it("常に成功するシークレットなら token 付きで 201", async () => {
    const res = await postComment(
      "turnstilePass",
      { section: "general", body: "常に成功 [17]", token: "dummy-turnstile-token" },
      nextIp()
    );
    expect(res.status).toBe(201);
    expect(res.body.comment.body).toBe("常に成功 [17]");
  });
});
