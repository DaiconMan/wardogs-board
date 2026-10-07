import { json } from "../../../_lib/validate.js";
import { requireUser, requireOrigin } from "../../../_lib/guard.js";
import { validateEncoded } from "../../../_lib/ink.js";
// 作戦の行を取るのと「書いてよいか」の判定は同じ関数に入っている
// （functions/_lib/visibility.js の冒頭に理由）。ここに条件を書き写さない。
import { loadWritablePlan, loadWritableSession } from "../../../_lib/visibility.js";

const ALLOWED_WIDTHS = new Set([1, 2, 3]);
const MAX_BATCH = 200;

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;
  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  const plan = await loadWritablePlan(env, params.id, auth.user);
  if (plan.response) return plan.response;

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }
  const strokes = payload?.strokes;
  if (!Array.isArray(strokes) || strokes.length === 0) {
    return json({ error: "線がありません" }, 400);
  }
  if (strokes.length > MAX_BATCH) {
    return json({ error: `一度に送れるのは${MAX_BATCH}本までです` }, 400);
  }

  const seenUuids = new Set();
  for (const s of strokes) {
    if (typeof s?.client_uuid !== "string" || !s.client_uuid) {
      return json({ error: "client_uuid がありません" }, 400);
    }
    if (seenUuids.has(s.client_uuid)) {
      return json({ error: "client_uuid が重複しています" }, 400);
    }
    seenUuids.add(s.client_uuid);
    if (!ALLOWED_WIDTHS.has(s.width)) return json({ error: "太さの指定が不正です" }, 400);
    if (typeof s.color !== "string" || !/^cursor-[1-8]$/.test(s.color)) {
      return json({ error: "色の指定が不正です" }, 400);
    }
    const err = validateEncoded(s.points, plan.map);
    if (err) return json({ error: err }, 400);

    // まだ1件も INSERT していない段階で、別プランの client_uuid 再利用を弾く。
    // ここを INSERT ループの中でやると、バッチの途中で気づいた時点で
    // 手前の分だけ既に保存されてしまい、レスポンスと実データが食い違う。
    const existing = await env.DB.prepare(
      "SELECT session_id FROM ink_strokes WHERE client_uuid = ?"
    ).bind(s.client_uuid).first();
    if (existing && existing.session_id !== plan.session.id) {
      return json({ error: "client_uuid が別のプランで使用済みです" }, 409);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const ids = [];
  for (const s of strokes) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ink_strokes
         (session_id, color, width, points, created_by, created_at, client_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(plan.session.id, s.color, s.width, JSON.stringify(s.points),
           auth.user.id, now, s.client_uuid).run();
    // 検証ループで別プラン利用は弾いてあるので、ここは必ず見つかるはず。
    // 念のため session_id で絞ったまま残し、見つからなければ 409 とする。
    const row = await env.DB.prepare(
      "SELECT id FROM ink_strokes WHERE client_uuid = ? AND session_id = ?"
    ).bind(s.client_uuid, plan.session.id).first();
    if (!row) {
      return json({ error: "client_uuid が別のプランで使用済みです" }, 409);
    }
    ids.push(row.id);
  }

  await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
    .bind(now, plan.session.id).run();

  return json({ saved: ids.length, ids }, 201);
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;
  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  // **消すのも書き込み。** 読専の作戦では、自分が引いた線も消せない
  // （所有者判定の手前で断る）。
  const loaded = await loadWritableSession(env, params.id, auth.user);
  if (loaded.response) return loaded.response;

  const strokeId = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(strokeId)) return json({ error: "idが不正です" }, 400);

  const row = await env.DB.prepare(
    "SELECT id, created_by FROM ink_strokes WHERE id = ? AND session_id = ?"
  ).bind(strokeId, loaded.session.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);

  if (row.created_by !== auth.user.id && auth.user.role !== "admin") {
    return json({ error: "他の人の線は消せません" }, 403);
  }

  await env.DB.prepare("DELETE FROM ink_strokes WHERE id = ?").bind(strokeId).run();
  return json({ ok: true });
}
