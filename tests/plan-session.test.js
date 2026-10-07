import { describe, it, expect } from "vitest";
import {
  signSession, verifySession, buildSessionCookie, clearSessionCookie,
  readCookie, SESSION_COOKIE, MAX_NAME_LEN,
} from "../functions/_lib/session.js";

const SECRET = "test-session-secret-abcdefghijklmnop";
const NOW = 1_800_000_000;
const payload = { u: "123", n: "青の人", a: "abc", r: "admin", e: NOW + 100 };

describe("signSession / verifySession", () => {
  it("署名したものを検証して元のペイロードが戻る", async () => {
    const t = await signSession(payload, SECRET);
    expect(await verifySession(t, SECRET, NOW)).toEqual(payload);
  });

  it("署名を改ざんすると null", async () => {
    const t = await signSession(payload, SECRET);
    const [body] = t.split(".");
    expect(await verifySession(`${body}.AAAA`, SECRET, NOW)).toBeNull();
  });

  it("別のペイロードの署名を流用すると null", async () => {
    const t1 = await signSession(payload, SECRET);
    const t2 = await signSession({ ...payload, u: "999" }, SECRET);
    const [body1] = t1.split(".");
    const [, sig2] = t2.split(".");
    expect(await verifySession(`${body1}.${sig2}`, SECRET, NOW)).toBeNull();
  });

  it("鍵が違うと null", async () => {
    const t = await signSession(payload, SECRET);
    expect(await verifySession(t, "another-secret", NOW)).toBeNull();
  });

  it("期限切れは null", async () => {
    const t = await signSession(payload, SECRET);
    expect(await verifySession(t, SECRET, NOW + 101)).toBeNull();
  });

  it("形式が不正なものは null（例外を投げない）", async () => {
    for (const bad of ["", "a", "a.b.c", "....", "%%%.%%%"]) {
      expect(await verifySession(bad, SECRET, NOW)).toBeNull();
    }
  });

  // Review Focus 5: 表示名が長いと Cookie が 4KB を超えてブラウザに黙って捨てられる
  it("長い表示名でも Cookie が 4096 バイトを超えない", async () => {
    const t = await signSession({ ...payload, n: "あ".repeat(MAX_NAME_LEN) }, SECRET);
    const cookie = buildSessionCookie(t, 2592000);
    expect(new TextEncoder().encode(cookie).length).toBeLessThan(4096);
  });
});

describe("Cookie の組み立てと読み取り", () => {
  it("必要な属性がすべて付く", () => {
    const c = buildSessionCookie("tok", 60);
    expect(c).toContain(`${SESSION_COOKIE}=tok`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=60");
  });

  it("失効用 Cookie は Max-Age=0", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  it("Cookie ヘッダから値を取り出せる", () => {
    const req = new Request("https://x.test/", {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=abc.def; last=2` },
    });
    expect(readCookie(req, SESSION_COOKIE)).toBe("abc.def");
    expect(readCookie(req, "nope")).toBeNull();
  });

  it("Cookie ヘッダが無ければ null", () => {
    expect(readCookie(new Request("https://x.test/"), SESSION_COOKIE)).toBeNull();
  });
});
