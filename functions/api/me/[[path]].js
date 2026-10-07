import { guestFrom } from "../../_lib/guest.js";
import { SESSION_COOKIE, readCookie, verifySession } from "../../_lib/session.js";
import { json } from "../../_lib/validate.js";

/**
 * ログインしていないときの返事。
 *
 * **`authenticated` の意味は変えない**（＝ Discord でログインしているか）。
 * ゲスト（ログイン無しで見る人）は `authenticated: false` のまま、
 * `user` に生成名つきの身元が入る。画面はこれで右上の名前を出す。
 *
 * **名前をここで返すのが肝。** 生成の式は `public/js/plan/guest.js` 1箇所に
 * あり、画面はそれを呼ばずにサーバの答えを使う。こうすると「在室一覧では◯◯
 * なのに右上は△△」が構造的に起きない（在室の名前も同じ式から来る）。
 */
function notAuthenticated(request) {
  const guest = guestFrom(request);
  return json(guest ? { authenticated: false, user: guest } : { authenticated: false });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // テスト専用。ALLOW_DEBUG が立っているときだけ有効。本番では未設定。
  if (url.pathname.endsWith("/debug-count") && env.ALLOW_DEBUG === "1") {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE discord_id = ?"
    ).bind(url.searchParams.get("discord_id")).first();
    return json({ count: row?.count ?? 0 });
  }

  const token = readCookie(request, SESSION_COOKIE);
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = token ? await verifySession(token, env.SESSION_SECRET, nowSec) : null;
  if (!payload) return notAuthenticated(request);

  const row = await env.DB.prepare(
    "SELECT role, active FROM users WHERE discord_id = ?"
  ).bind(payload.u).first();
  if (!row) return notAuthenticated(request);
  // **利用を止められた人をゲストに降ろさない。** 降ろすと `_lib/guard.js` の
  // `requireViewer` が 403 を返し続けるのに、画面だけが「見られるつもり」になる
  // （右上に生成名が出て、盤面の取得が全部 403）。あちらと揃えて、
  // ここでは身元を付けずに返す。Cookie を捨てればゲストになれるが、
  // それは「身元の無い人」と同じ状態なので、止めている意味は失われない。
  if (!row.active) return json({ authenticated: false });

  return json({
    authenticated: true,
    user: { id: payload.u, name: payload.n, avatar: payload.a, role: row.role },
  });
}
