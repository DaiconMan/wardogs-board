// コントロールエリアのプリセット（マップ固定の円）の入り口。
//
// **読みは全員、書きは admin だけ。**
// プリセットは1つのマップの全作戦に効くマップ静的データなので、
// 誰でも書き換えられると、ある人が直した円が他人の作戦の盤面を黙って変える。
// 同じ理由で map_towers / map_spawns にも書き込み口を作っていない。
//
// **座標はゲーム内座標（1単位 = 100m）で受け取る。** オーナーはゲーム画面に
// 出ている数字をそのまま打つ。メートルへの換算はサーバがやる（_lib/zones.js）。
//
// 出典: docs/research/2026-09-29-zones-drills-data.md §2.1・§3.1・§5.6 案4。

import { json } from "../../../_lib/validate.js";
import { requireOrigin, requireUser, requireViewer } from "../../../_lib/guard.js";
import {
  NAME_LIMIT, SOURCE_LIMIT, TAG_LIMIT,
  centreOf, defaultRadiusM, defaultSource, keyError, optionalText,
  presetId, radiusError, toApi, weightOf,
} from "../../../_lib/zones.js";

/** 入力した日（YYYY-MM-DD）。「いつ時点の値か」が無い行を作らないための既定。 */
const today = () => new Date().toISOString().slice(0, 10);

const loadMap = (env, id) =>
  env.DB.prepare("SELECT id, name, width_m, height_m FROM maps WHERE id = ?").bind(id).first();

const SELECT = `SELECT id, map_id, key, name, tag, x_m, y_m, radius_m, weight,
                       source, measured_at, patch, verified, sort_order, created_by
                  FROM map_zone_presets`;

async function listFor(env, mapId) {
  const { results } = await env.DB.prepare(
    `${SELECT} WHERE map_id = ? ORDER BY sort_order ASC, id ASC`
  ).bind(mapId).all();
  return results.map(toApi);
}

/** admin でなければ 403 を返す（null なら通ってよい）。 */
const adminOnly = (user) =>
  user.role === "admin" ? null : json({ error: "プリセットを変更できるのは管理者だけです" }, 403);

/** 書き込み系に共通の前処理。Origin → ログイン → admin → マップの順に確かめる。 */
async function prepareWrite(context) {
  const bad = requireOrigin(context.request);
  if (bad) return { response: bad };
  const auth = await requireUser(context);
  if (auth.response) return { response: auth.response };
  const denied = adminOnly(auth.user);
  if (denied) return { response: denied };
  const map = await loadMap(context.env, context.params.id);
  if (!map) return { response: json({ error: "見つかりません" }, 404) };
  return { user: auth.user, map };
}

// 読むだけならログインは要らない（`requireViewer`）。ゲストが開いた盤面にも
// コントロールエリアの円は出す。書き込む3本は `prepareWrite` の中で
// `requireUser` ＋ admin のまま（ゲストは admin になれない）。
export async function onRequestGet(context) {
  const auth = await requireViewer(context);
  if (auth.response) return auth.response;

  const map = await loadMap(context.env, context.params.id);
  if (!map) return json({ error: "見つかりません" }, 404);

  return json({
    presets: await listFor(context.env, map.id),
    // 既定の半径の持ち主はサーバ（_lib/zones.js）。同じ数字を画面側に書かない。
    default_radius_m: defaultRadiusM(map.id),
  });
}

export async function onRequestPost(context) {
  const ready = await prepareWrite(context);
  if (ready.response) return ready.response;
  const { user, map } = ready;
  const { env, request } = context;

  let body;
  try { body = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }

  const keyBad = keyError(body?.key);
  if (keyBad) return json({ error: keyBad }, 400);
  const key = body.key.trim();

  const centre = centreOf(body?.x, body?.y, map);
  if (centre.error) return json({ error: centre.error }, 400);

  // 半径は省略できる。省略したらマップごとの既定（500 / 550 / 500）。
  const radius_m = body?.radius_m === undefined || body?.radius_m === null
    ? defaultRadiusM(map.id)
    : body.radius_m;
  const radiusBad = radiusError(radius_m);
  if (radiusBad) return json({ error: radiusBad }, 400);

  const weight = weightOf(body?.weight);
  if (weight.error) return json({ error: weight.error }, 400);

  const name = optionalText(body?.name, NAME_LIMIT, "表示名");
  if (name.error) return json({ error: name.error }, 400);
  const tag = optionalText(body?.tag, TAG_LIMIT, "タグ");
  if (tag.error) return json({ error: tag.error }, 400);
  const source = optionalText(body?.source, SOURCE_LIMIT, "出典");
  if (source.error) return json({ error: source.error }, 400);
  const measured = optionalText(body?.measured_at, 10, "計測日");
  if (measured.error) return json({ error: measured.error }, 400);

  // ゲーム内で実測したか。この入力口は「オーナーがゲーム画面の数字を読んで打つ」
  // ためだけに作ってあるので既定は 1。他所から写した値を入れるときだけ 0 を明示する。
  let verified = 1;
  if (body?.verified !== undefined) {
    if (body.verified !== 0 && body.verified !== 1) {
      return json({ error: "verified は 0 か 1 です" }, 400);
    }
    verified = body.verified;
  }

  const id = presetId(map.id, key);
  const now = Math.floor(Date.now() / 1000);
  // 出典を書かなかったときは「オーナーが実機で計測」と残す。この入力口は
  // そのためだけに存在していて、他に値の入手経路が無い（調査 §5.3）。
  const sourceText = source.value ?? defaultSource(user.name, user.id);
  // 並びは入れた順。プリセットは3〜4個しか無いので、この1問い合わせは無視できる。
  const last = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) AS m FROM map_zone_presets WHERE map_id = ?"
  ).bind(map.id).first();

  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO map_zone_presets
       (id, map_id, key, name, tag, x_m, y_m, radius_m, weight,
        source, measured_at, verified, sort_order, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, map.id, key, name.value ?? key, tag.value,
    centre.x_m, centre.y_m, radius_m, weight.weight,
    sourceText, measured.value ?? today(), verified,
    (last?.m ?? 0) + 10, user.id, now, now
  ).run();

  if (!res.meta?.changes) {
    return json({ error: "同じ識別子のプリセットがすでにあります" }, 409);
  }

  const row = await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(id).first();
  return json({ preset: toApi(row) }, 201);
}

/** 本文にそのキーが書かれているか（null を「消す」として扱うため真偽では見ない）。 */
const hasKey = (body, key) =>
  body !== null && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, key);

export async function onRequestPatch(context) {
  const ready = await prepareWrite(context);
  if (ready.response) return ready.response;
  const { map } = ready;
  const { env, request } = context;

  const id = new URL(request.url).searchParams.get("preset_id");
  if (!id) return json({ error: "preset_id がありません" }, 400);

  const row = await env.DB.prepare(`${SELECT} WHERE id = ? AND map_id = ?`)
    .bind(id, map.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }

  // 中心は x と y の両方が揃っているときだけ動かす（片方だけだと斜めに飛ぶ）。
  let x_m = row.x_m;
  let y_m = row.y_m;
  if (hasKey(body, "x") || hasKey(body, "y")) {
    const centre = centreOf(
      hasKey(body, "x") ? body.x : row.x_m / 100,
      hasKey(body, "y") ? body.y : row.y_m / 100,
      map
    );
    if (centre.error) return json({ error: centre.error }, 400);
    x_m = centre.x_m;
    y_m = centre.y_m;
  }

  let radius_m = row.radius_m;
  if (hasKey(body, "radius_m")) {
    const bad = radiusError(body.radius_m);
    if (bad) return json({ error: bad }, 400);
    radius_m = body.radius_m;
  }

  let weight = row.weight;
  if (hasKey(body, "weight")) {
    const w = weightOf(body.weight);
    if (w.error) return json({ error: w.error }, 400);
    weight = w.weight;
  }

  const patchText = (field, max, what, fallback) => {
    if (!hasKey(body, field)) return { value: fallback };
    const t = optionalText(body[field], max, what);
    if (t.error) return t;
    return { value: t.value ?? fallback };
  };

  const name = patchText("name", NAME_LIMIT, "表示名", row.name);
  if (name.error) return json({ error: name.error }, 400);
  const tag = patchText("tag", TAG_LIMIT, "タグ", row.tag);
  if (tag.error) return json({ error: tag.error }, 400);
  const source = patchText("source", SOURCE_LIMIT, "出典", row.source);
  if (source.error) return json({ error: source.error }, 400);

  await env.DB.prepare(
    `UPDATE map_zone_presets
        SET name = ?, tag = ?, x_m = ?, y_m = ?, radius_m = ?, weight = ?,
            source = ?, updated_at = ?
      WHERE id = ?`
  ).bind(
    name.value, tag.value, x_m, y_m, radius_m, weight,
    source.value, Math.floor(Date.now() / 1000), id
  ).run();

  const after = await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(id).first();
  return json({ preset: toApi(after) });
}

export async function onRequestDelete(context) {
  const ready = await prepareWrite(context);
  if (ready.response) return ready.response;
  const { map } = ready;
  const { env, request } = context;

  const id = new URL(request.url).searchParams.get("preset_id");
  if (!id) return json({ error: "preset_id がありません" }, 400);

  const row = await env.DB.prepare("SELECT id FROM map_zone_presets WHERE id = ? AND map_id = ?")
    .bind(id, map.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);

  // 選んでいた作戦の行も一緒に消す。消えた id を指したままにすると、
  // 盤面が「選ばれているのに円が無い」状態になって説明できなくなる。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM session_zone WHERE preset_id = ?").bind(id),
    env.DB.prepare("DELETE FROM map_zone_presets WHERE id = ?").bind(id),
  ]);

  return json({ ok: true });
}
