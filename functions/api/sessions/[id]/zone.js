// 「この作戦が想定するコントロールエリア」を1つ結びつける。
//
// プリセットそのものはマップ静的（admin だけが作る）が、**どのパターンを想定して
// 立てた作戦か**は作戦ごとなので、作戦に紐づけて保存する。
// **試合の記録ではない**（D-046）。「Default のときはこう攻める」を事前に用意して
// おき、試合が始まったら該当する作戦を開く、という使い方のための列。
//
// 権限は作戦の編集と同じ（ログインしていれば誰でも）。配置やエリア塗りと同じ扱いにしてある
// — 作戦は共同編集するもので、盤面に物を置けるなら想定するパターンも選べるべき。
//
// 読みは `GET /api/sessions/{id}` の `zone_preset_id` に相乗りしている
// （初回描画に必要なものを1往復にまとめる）。ここには GET を置かない。
//
// 1作戦につき1つしか無いので追記型にしない。PUT で置き換える。
// `{ preset_id: null }` で「選んでいない」に戻る。

import { json } from "../../../_lib/validate.js";
import { requireUser, requireOrigin } from "../../../_lib/guard.js";
// 作戦の行を取るのと「書いてよいか」の判定は同じ関数に入っている
// （functions/_lib/visibility.js の冒頭に理由）。ここに条件を書き写さない。
import { loadWritableSession } from "../../../_lib/visibility.js";

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;
  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  const loaded = await loadWritableSession(env, params.id, auth.user);
  if (loaded.response) return loaded.response;
  const { session } = loaded;

  let body;
  try { body = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }

  const raw = body?.preset_id;
  if (raw === undefined) return json({ error: "preset_id がありません" }, 400);

  const now = Math.floor(Date.now() / 1000);

  if (raw === null) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM session_zone WHERE session_id = ?").bind(session.id),
      env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").bind(now, session.id),
    ]);
    return json({ preset_id: null });
  }

  if (typeof raw !== "string" || !raw) return json({ error: "preset_id が不正です" }, 400);

  const preset = await env.DB.prepare(
    "SELECT id, map_id FROM map_zone_presets WHERE id = ?"
  ).bind(raw).first();
  if (!preset) return json({ error: "見つかりません" }, 404);
  // マップ違いは 404 ではなく 400。「存在しない」のではなく「この作戦には合わない」。
  if (preset.map_id !== session.map_id) {
    return json({ error: "この作戦のマップのパターンではありません" }, 400);
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO session_zone (session_id, preset_id, chosen_by, chosen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id)
       DO UPDATE SET preset_id = excluded.preset_id,
                     chosen_by = excluded.chosen_by,
                     chosen_at = excluded.chosen_at`
    ).bind(session.id, preset.id, auth.user.id, now),
    env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").bind(now, session.id),
  ]);

  return json({ preset_id: preset.id });
}
