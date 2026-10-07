import {
  STATE_COOKIE, MAX_NAME_LEN, readCookie, signSession,
  buildSessionCookie, clearStateCookie,
} from "../../../_lib/session.js";
import { json } from "../../../_lib/validate.js";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30日
const UA = "WardogsBluePlanner/0.1 (+https://wardogs.daiconman.jp)";

// Discord API は Cloudflare の背後にあり、既定の UA だと 403 error code 1010 で弾かれる。
//
// DISCORD_API_BASE が "mock" のときはテスト用の固定応答を返すが、これは
// 「code を自分で組み立てれば任意の Discord ID でログインできる」経路なので、
// ALLOW_DEBUG との AND にして多層防御にする。本番の wrangler.toml には
// どちらの変数も入れない（片方が事故で入っても mock は開かない）。
async function exchangeAndFetchUser(env, code, redirectUri, params) {
  if (env.DISCORD_API_BASE === "mock" && env.ALLOW_DEBUG === "1") {
    const m = /^mock-([^-]+)-(.*)$/.exec(code);
    if (!m) return null;
    // **アイコンの hash もテストから渡せるようにしてある。**
    // `code` に混ぜず別のクエリにしたのは、`mock-<id>-<名前>` の `<名前>` が
    // `-` を含みうるため（混ぜると名前の一部を hash と読み違える）。
    // ここは mock + ALLOW_DEBUG の内側で、本番の経路からは読まない。
    return {
      id: m[1],
      username: decodeURIComponent(m[2]),
      avatar: params?.get("avatar") || null,
    };
  }

  const base = env.DISCORD_API_BASE || "https://discord.com/api/v10";
  const basic = btoa(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`);
  const tokenRes = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": UA,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) return null;
  const { access_token: accessToken } = await tokenRes.json();
  if (!accessToken) return null;

  const meRes = await fetch(`${base}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}`, "user-agent": UA },
  });
  if (!meRes.ok) return null;
  return await meRes.json();
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = readCookie(request, STATE_COOKIE);

  if (!code || !state || !cookieState || state !== cookieState) {
    return json({ error: "認証の状態が一致しません。最初からやり直してください" }, 400, {
      "set-cookie": clearStateCookie(),
    });
  }

  const profile = await exchangeAndFetchUser(
    env, code, `${url.origin}/api/auth/discord/callback`, url.searchParams
  );
  if (!profile?.id) {
    return json({ error: "Discord との通信に失敗しました" }, 400, {
      "set-cookie": clearStateCookie(),
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const displayName = [...String(profile.global_name || profile.username || "名無し")]
    .slice(0, MAX_NAME_LEN).join("");

  // 最初のユーザーだけ admin。2回目以降のログインでロールは変えない。
  const existing = await env.DB.prepare(
    "SELECT role, active FROM users WHERE discord_id = ?"
  ).bind(profile.id).first();

  // 無効化されたユーザーにはセッションを発行しない。
  // /api/me でも弾くが、30日有効な Cookie を渡してしまう前に止める。
  if (existing && !existing.active) {
    return json({ error: "利用が停止されています" }, 403, {
      "set-cookie": clearStateCookie(),
    });
  }

  let role = existing?.role;
  if (!role) {
    // 「users が空なら admin」の判定を INSERT と同じ1文に入れて原子的にする。
    // COUNT(*) と INSERT が別文だと、未登録の2人が同時に来たとき双方が
    // 「空だ」と判断して admin が2人生まれる。
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users
         (discord_id, username, global_name, avatar, role, active, first_login_at, last_login_at)
       SELECT ?, ?, ?, ?,
              CASE WHEN NOT EXISTS (SELECT 1 FROM users) THEN 'admin' ELSE 'member' END,
              1, ?, ?`
    ).bind(profile.id, profile.username || displayName, profile.global_name || null,
           profile.avatar || null, now, now).run();
    // 確定値を DB から読み直す。これでセッションの role が必ず DB と一致する。
    const after = await env.DB.prepare(
      "SELECT role FROM users WHERE discord_id = ?"
    ).bind(profile.id).first();
    role = after.role;
  } else {
    await env.DB.prepare(
      `UPDATE users SET username = ?, global_name = ?, avatar = ?, last_login_at = ?
         WHERE discord_id = ?`
    ).bind(profile.username || displayName, profile.global_name || null,
           profile.avatar || null, now, profile.id).run();
  }

  const token = await signSession(
    { u: profile.id, n: displayName, a: profile.avatar || null, r: role, e: now + SESSION_MAX_AGE },
    env.SESSION_SECRET
  );

  return new Response(null, {
    status: 302,
    headers: [
      ["location", "/plan"],
      ["set-cookie", clearStateCookie()],
      ["set-cookie", buildSessionCookie(token, SESSION_MAX_AGE)],
      ["cache-control", "no-store"],
    ],
  });
}
