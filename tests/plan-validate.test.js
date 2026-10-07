import { describe, it, expect } from "vitest";
import { isFiniteNumber, validText, blockedBy } from "../functions/_lib/validate.js";
import { requireOrigin } from "../functions/_lib/guard.js";

describe("isFiniteNumber", () => {
  // Review Focus 3: JSON から来る値は型が保証されない
  it("有限の数値だけ true", () => {
    for (const ok of [0, -1, 1.5, 1e6]) expect(isFiniteNumber(ok)).toBe(true);
    for (const ng of [NaN, Infinity, -Infinity, "1", null, undefined, {}, []]) {
      expect(isFiniteNumber(ng), String(ng)).toBe(false);
    }
  });
});

describe("validText", () => {
  it("trim した結果を返す", () => expect(validText("  あ  ", 10)).toBe("あ"));
  it("空・空白のみは null", () => {
    expect(validText("", 10)).toBeNull();
    expect(validText("   ", 10)).toBeNull();
  });
  it("上限ちょうどは通り、1文字超は null", () => {
    expect(validText("あ".repeat(10), 10)).toBe("あ".repeat(10));
    expect(validText("あ".repeat(11), 10)).toBeNull();
  });
  it("文字列以外は null", () => {
    for (const ng of [null, undefined, 1, {}]) expect(validText(ng, 10)).toBeNull();
  });
});

describe("blockedBy", () => {
  it("BLOCKED_WORDS 未設定なら常に false", () => {
    expect(blockedBy({}, "なんでも")).toBe(false);
  });
  it("大文字小文字を区別せず、前後の空白を無視する", () => {
    const env = { BLOCKED_WORDS: " BadWord , 禁止語 ,, " };
    expect(blockedBy(env, "これは badword です")).toBe(true);
    expect(blockedBy(env, "禁止語を含む")).toBe(true);
    expect(blockedBy(env, "問題ない文")).toBe(false);
  });
  it("複数の引数のどれかが該当すれば true", () => {
    const env = { BLOCKED_WORDS: "ng" };
    expect(blockedBy(env, "ok", null, "NG")).toBe(true);
  });
});

describe("requireOrigin", () => {
  const make = (origin) =>
    new Request("https://wardogs.daiconman.jp/api/x", {
      method: "POST",
      headers: origin ? { origin } : {},
    });

  it("同一オリジンなら null（通過）", () => {
    expect(requireOrigin(make("https://wardogs.daiconman.jp"))).toBeNull();
  });
  it("別オリジンなら 403", () => {
    expect(requireOrigin(make("https://evil.example")).status).toBe(403);
  });
  it("Origin ヘッダが無ければ 403", () => {
    expect(requireOrigin(make(null)).status).toBe(403);
  });
});
