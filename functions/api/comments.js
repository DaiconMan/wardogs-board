// /api/comments — Cloudflare Pages Functions + D1
//
// 環境（Pages の Settings → Bindings / Variables）
//   DB                D1 バインディング（必須）
//   TURNSTILE_SECRET  Turnstile のシークレット（任意。未設定なら人間確認をスキップ）
//   ADMIN_TOKEN       削除用トークン（任意。未設定なら削除不可）
//   IP_SALT           IPハッシュ用の任意文字列（任意）
//   BLOCKED_WORDS     投稿を弾く語のカンマ区切り（任意。未設定なら無効）

const SECTIONS = new Set([
  "premise", "flow", "fob", "build", "infantry", "pushed", "attack",
  "recon", "counter-recon", "open", "general",
]);
const MAX_NAME = 24;
const MAX_BODY = 1000;
const RATE_WINDOW_SEC = 600; // 10分
const RATE_MAX = 5;          // 10分あたりの投稿数（IPごと）
const LIST_LIMIT = 2000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// BLOCKED_WORDS（カンマ区切り）を小文字の語リストにする。未設定なら空 = 無効。
// 各語は trim し、空要素は無視する。
function blockedWords(env) {
  return String(env.BLOCKED_WORDS || "")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 一覧
export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: "DB binding がありません" }, 500);
  const { results } = await env.DB.prepare(
    `SELECT id, section, parent_id, name, body, created_at
       FROM comments ORDER BY id ASC LIMIT ?`
  ).bind(LIST_LIMIT).all();
  return json({ comments: results });
}

// 投稿
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "DB binding がありません" }, 500);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }

  const section = String(payload.section || "");
  // **既定の名前に陣営を入れない。** かつては陣営色が付いていたが、どの陣営でも
  // 使える道具になったので、名乗らなかった人が片方の陣営を名乗る形にしない
  // （改名 wardogs-blue → wardogs-board の一部。tests/naming.test.js が見張る）。
  // **既に保存されている古い既定名は書き換えない**（過去の発言なので）。
  const name = String(payload.name || "").trim().slice(0, MAX_NAME) || "名無し";
  const body = String(payload.body || "").replace(/\r\n/g, "\n").trim();
  const parentId = payload.parent_id == null ? null : Number(payload.parent_id);

  if (!SECTIONS.has(section)) return json({ error: "章の指定が不正です" }, 400);
  if (!body) return json({ error: "本文を入力してください" }, 400);
  if (body.length > MAX_BODY) return json({ error: `本文は${MAX_BODY}文字までです` }, 400);
  if (/https?:\/\/\S+.*https?:\/\/\S+.*https?:\/\/\S+/s.test(body)) return json({ error: "URLは2つまでにしてください" }, 400);
  const blocked = blockedWords(env);
  if (blocked.length) {
    const lowered = body.toLowerCase();
    if (blocked.some((w) => lowered.includes(w))) return json({ error: "投稿できない語が含まれています" }, 400);
  }
  if (parentId !== null && !Number.isInteger(parentId)) return json({ error: "返信先が不正です" }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";

  // Turnstile
  if (env.TURNSTILE_SECRET) {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", String(payload.token || ""));
    form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const v = await r.json().catch(() => ({}));
    if (!v.success) return json({ error: "人間確認に失敗しました" }, 403);
  }

  // 既定の salt が `"wardogs-blue"` なのは歴史的な理由だが、**変えてはいけない。**
  // IP_SALT が未設定の環境ではこの文字列がそのままハッシュに効くので、
  // 変えると既存の `comments.ip_hash` と突き合わなくなり、下のレート制限が
  // 「全員が初回」として素通りする。プロジェクト名の改名（wardogs-board）とは無関係。
  // tests/naming.test.js がこの行を固定している。
  const ipHash = await sha256(ip + "|" + (env.IP_SALT || "wardogs-blue"));
  const now = Math.floor(Date.now() / 1000);

  // レート制限
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM comments WHERE ip_hash = ? AND created_at > ?`
  ).bind(ipHash, now - RATE_WINDOW_SEC).first();
  if (recent && recent.n >= RATE_MAX) return json({ error: "投稿が多すぎます" }, 429);

  // 返信先は同じ章のトップレベルに限る（1段まで）
  if (parentId !== null) {
    const parent = await env.DB.prepare(
      `SELECT id FROM comments WHERE id = ? AND section = ? AND parent_id IS NULL`
    ).bind(parentId, section).first();
    if (!parent) return json({ error: "返信先が見つかりません" }, 400);
  }

  const inserted = await env.DB.prepare(
    `INSERT INTO comments (section, parent_id, name, body, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id, section, parent_id, name, body, created_at`
  ).bind(section, parentId, name, body, ipHash, now).first();

  return json({ comment: inserted }, 201);
}

// 削除（管理用）: DELETE /api/comments?id=123  Authorization: Bearer <ADMIN_TOKEN>
export async function onRequestDelete({ request, env }) {
  if (!env.DB) return json({ error: "DB binding がありません" }, 500);
  if (!env.ADMIN_TOKEN) return json({ error: "削除は無効です" }, 403);
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "認証エラー" }, 401);

  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id)) return json({ error: "idが不正です" }, 400);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM comments WHERE parent_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

export async function onRequest({ request }) {
  // 上記以外のメソッド
  return json({ error: `${request.method} は使えません` }, 405);
}
