import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs, execD1 } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;

describe("/api/auth/discord/start", () => {
  it("Discord の認可URLへ 302 で送り、state Cookie を立てる", async () => {
    const r = await fetch(url("/api/auth/discord/start"), { redirect: "manual" });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location"));
    expect(loc.origin + loc.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(loc.searchParams.get("client_id")).toBeTruthy();
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("scope")).toBe("identify");
    expect(loc.searchParams.get("redirect_uri")).toContain("/api/auth/discord/callback");
    const state = loc.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const setCookie = r.headers.get("set-cookie") || "";
    expect(setCookie).toContain("__Host-wb_state=");
    expect(setCookie).toContain(state);
    expect(setCookie).toContain("HttpOnly");
  });
});

describe("/api/auth/discord/callback の state 検証", () => {
  // Review Focus 1: state の欠落・不一致・期限切れ
  it("state Cookie が無ければ 400", async () => {
    const r = await fetch(url("/api/auth/discord/callback?code=x&state=abc"), { redirect: "manual" });
    expect(r.status).toBe(400);
  });

  it("state が一致しなければ 400", async () => {
    const r = await fetch(url("/api/auth/discord/callback?code=x&state=abc"), {
      redirect: "manual",
      headers: { cookie: "__Host-wb_state=different" },
    });
    expect(r.status).toBe(400);
  });

  it("code が無ければ 400", async () => {
    const r = await fetch(url("/api/auth/discord/callback?state=abc"), {
      redirect: "manual",
      headers: { cookie: "__Host-wb_state=abc" },
    });
    expect(r.status).toBe(400);
  });
});

describe("ログインとユーザー登録", () => {
  it("最初のユーザーが admin、2人目が member になる", async () => {
    const first = await loginAs("1001", "first");
    expect(first.res.status).toBe(302);
    expect(first.cookie).toBeTruthy();
    const me1 = await (await fetch(url("/api/me"), { headers: { cookie: first.cookie } })).json();
    expect(me1.user.role).toBe("admin");

    const second = await loginAs("1002", "second");
    const me2 = await (await fetch(url("/api/me"), { headers: { cookie: second.cookie } })).json();
    expect(me2.user.role).toBe("member");
  });

  // Review Focus 2: 同じユーザーが2回ログインしても行が増えない
  it("同じユーザーが再ログインしても行が二重にならず、ロールも変わらない", async () => {
    await loginAs("1001", "first");
    const again = await loginAs("1001", "first-renamed");
    const me = await (await fetch(url("/api/me"), { headers: { cookie: again.cookie } })).json();
    expect(me.user.role).toBe("admin");
    expect(me.user.name).toBe("first-renamed");

    const countRes = await fetch(url("/api/me/debug-count?discord_id=1001"), {
      headers: { cookie: again.cookie },
    });
    expect((await countRes.json()).count).toBe(1);
  });

  it("未ログインの /api/me は authenticated:false", async () => {
    const r = await fetch(url("/api/me"));
    expect(r.status).toBe(200);
    expect((await r.json()).authenticated).toBe(false);
  });

  it("ログアウトすると Cookie が失効する", async () => {
    const { cookie } = await loginAs("1003", "third");
    const out = await fetch(url("/api/auth/logout"), {
      method: "POST",
      headers: { cookie, origin: baseUrl("plan") },
    });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("ログアウトは Origin が違うと 403", async () => {
    const { cookie } = await loginAs("1004", "fourth");
    const out = await fetch(url("/api/auth/logout"), {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(out.status).toBe(403);
  });

  // 成功レスポンスは set-cookie を2本返す（state 失効 + セッション発行）。
  // ここを見ていないと clearStateCookie() を消しても気づけない。
  it("成功時は set-cookie が2本で、state が失効しセッションが立つ", async () => {
    const { res } = await loginAs("1005", "fifth");
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);

    const stateCookie = cookies.find((c) => c.startsWith("__Host-wb_state="));
    expect(stateCookie, "state Cookie が無い").toBeTruthy();
    expect(stateCookie).toContain("Max-Age=0");

    const sessionCookie = cookies.find((c) => c.startsWith("wb_session="));
    expect(sessionCookie, "セッション Cookie が無い").toBeTruthy();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Lax");
  });

  // セッション Cookie は30日有効な `r: role` を持つが、権限判定は必ず DB を引く。
  // 誰かが payload.r を信用したらこのテストが落ちる。
  it("Cookie が主張する role ではなく DB の role が使われる", async () => {
    const firstLogin = await loginAs("1008", "eighth");
    const before = await (await fetch(url("/api/me"), { headers: { cookie: firstLogin.cookie } })).json();
    expect(before.user.role).toBe("member");

    // DB で admin に上げて再ログイン → この Cookie は admin を主張する
    execD1("UPDATE users SET role = 'admin' WHERE discord_id = '1008'");
    const promoted = await loginAs("1008", "eighth");
    const asAdmin = await (await fetch(url("/api/me"), { headers: { cookie: promoted.cookie } })).json();
    expect(asAdmin.user.role).toBe("admin");

    // DB だけ member に戻す。Cookie は admin を主張したまま。
    execD1("UPDATE users SET role = 'member' WHERE discord_id = '1008'");
    const demoted = await (await fetch(url("/api/me"), { headers: { cookie: promoted.cookie } })).json();
    expect(demoted.user.role).toBe("member");
  });

  // active = 0 のユーザーに30日有効な Cookie を渡してはいけない。
  it("無効化されたユーザーの再ログインは 403 で、セッションを発行しない", async () => {
    const { cookie } = await loginAs("1007", "seventh");
    execD1("UPDATE users SET active = 0 WHERE discord_id = '1007'");

    const me = await (await fetch(url("/api/me"), { headers: { cookie } })).json();
    expect(me.authenticated).toBe(false);

    const state = "teststate-1007";
    const r = await fetch(
      url(`/api/auth/discord/callback?code=mock-1007-seventh&state=${state}`),
      { redirect: "manual", headers: { cookie: `__Host-wb_state=${state}` } }
    );
    expect(r.status).toBe(403);
    expect(r.headers.getSetCookie().some((c) => c.startsWith("wb_session="))).toBe(false);
  });
});
