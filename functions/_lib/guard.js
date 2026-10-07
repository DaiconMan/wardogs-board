// リクエストからユーザーを解決し、権限と Origin を検証する。
//
// EN: Resolves the user from the request and validates permission and Origin. There
//     are two entry points and confusing them opens a hole: requireUser for write
//     routes, which never lets an anonymous caller through, and requireViewer for read
//     routes, which admits logged-in users and guests.
//
// **入口は2つある。間違えると穴になる。**
//
//   requireUser   … 書き込むルート。**ログインしていない人は絶対に通さない。**
//   requireViewer … 読み取りのルート。ログイン済み ＋ ゲスト（ログイン無しで見る人）
//
// 書き込みのルートを `requireViewer` に替えないこと。1本間違えると
// **身元の無い書き込みが通る。** 公開設定の門（`_lib/visibility.js` の `canWrite`）は
// この後ろにあるので、ゲストはそこへ届く前に落ちるのが正しい形。
// 念のため `canWrite` 自身もゲストを false に倒してあるが、**あれは二重の防御**で、
// 第一の防御はここで `requireUser` を選ぶこと。

import { json } from "./validate.js";
import { guestFrom } from "./guest.js";
import { SESSION_COOKIE, readCookie, verifySession } from "./session.js";

export function requireOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return json({ error: "Origin がありません" }, 403);
  if (origin !== new URL(request.url).origin) {
    return json({ error: "Origin が一致しません" }, 403);
  }
  return null;
}

/**
 * Cookie からログイン中の人を解決する。**3通りを呼び出し側に見分けさせる。**
 *
 *   `{ user }`      … ログインしている
 *   `{ response }`  … 403。**利用が停止されている**（Cookie は正しい）
 *   `{ none: true }`… ログインしていない（Cookie が無い／切れた／行が無い）
 *
 * **403 を `none` に混ぜないこと。** 混ぜると、止めた人がゲストに降りてきて
 * 「利用停止」が「見るだけにした」に静かに変わる。
 */
async function resolveLogin({ request, env }) {
  const token = readCookie(request, SESSION_COOKIE);
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = token ? await verifySession(token, env.SESSION_SECRET, nowSec) : null;
  if (!payload) return { none: true };

  const row = await env.DB.prepare(
    "SELECT discord_id, role, active FROM users WHERE discord_id = ?"
  ).bind(payload.u).first();

  if (!row) return { none: true };
  if (!row.active) return { response: json({ error: "利用が停止されています" }, 403) };

  return { user: { id: row.discord_id, name: payload.n, avatar: payload.a, role: row.role } };
}

const needLogin = () => ({ response: json({ error: "ログインが必要です" }, 401) });

// 戻り値は { user } か { response }。呼び出し側は response があればそれを返す。
export async function requireUser(context) {
  const got = await resolveLogin(context);
  return got.none ? needLogin() : got;
}

/**
 * **読み取りのルート用。** ログイン済みなら `requireUser` と同じ結果、
 * ログインしていなければゲストとして通す。どちらでもなければ 401。
 *
 * ゲストの `user` は `{ id: "anon:<22文字>", name: "<生成名>", guest: true }`。
 *
 *   * **`anon:` の接頭辞が必ず付く**（`_lib/guest.js` の `isGuestId` が強制）。
 *     Discord ID は数字の文字列なので、`created_by` と取り違えようがない。
 *   * `role` は入っていない。入れると「`role` を見る分岐」のぶんだけ
 *     ゲストに権限が付く余地ができる。
 *   * **サーバはこの id を保存しない。** `users` にも `session_visits` にも
 *     行を作らない（作る経路は `_lib/guest.js` のヘッダに書いた理由で潰してある）。
 *
 * **ログインが先。** ゲストのヘッダを添えて来ても、Cookie が通ればその人として扱う
 * （そうしないと、ログイン済みの人が自分のヘッダで匿名化できてしまう）。
 */
export async function requireViewer(context) {
  const got = await resolveLogin(context);
  if (!got.none) return got;
  const guest = guestFrom(context.request);
  return guest ? { user: guest } : needLogin();
}
