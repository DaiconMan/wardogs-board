// プランごとの地名（session_callouts）。
//
// 「あの丘」「工場」「北の橋」といった、Discord でそのまま喋る呼び名を地図に置く。
// 実体はプランごとで、ここで直してもマップ静的なマスタ（callouts）は変わらない。
//
// 権限・冪等・検証は placements とまったく同じ作法に揃えてある。地名は地図の
// 読み方そのものを決めるので、むしろ慎重に倒す（読むのは誰でも、直すのは本人と admin）。
import { json, isFiniteNumber, blockedBy } from "../../../_lib/validate.js";
import { requireOrigin, requireUser, requireViewer } from "../../../_lib/guard.js";
// 作戦の行を取るのと「書いてよいか」の判定は同じ関数に入っている
// （functions/_lib/visibility.js の冒頭に理由）。ここに条件を書き写さない。
import { loadWritablePlan, loadWritableSession } from "../../../_lib/visibility.js";

/** 名前の長さ。schema.sql のコメントと public/js/plan/callouts.js と同じ値。 */
const NAME_MAX = 24;

/**
 * 1プランに置ける地名の上限。
 *
 * マップは 16km 四方（1km セルが 256 個）なので、200 件はおおよそ 1 セルに 1 個弱。
 * 丘・工場・橋・交差点を一通り名付けても届く数でありながら、名前を出す寄り具合
 * （4km 四方）で画面に出るのは平均 12〜13 件に収まる。上限を置かないと
 * 16km 四方が文字で埋まって地形が読めなくなるうえ、GET の応答も無制限に膨らむ。
 */
const MAX_PER_PLAN = 200;

/**
 * 一度に送れる件数。UI は1クリックで1件しか置かないが、マスタからの流し込みが
 * 複数件をまとめて送る。上限そのもの（200）より小さくして、1回の POST で
 * プランを一杯にできないようにしておく。
 */
const MAX_BATCH = 50;

/**
 * 座標の検証。POST（新規）と PATCH（移動）で同じ関数を通す。
 * placements と同じく、範囲外は 400 にして縁へ丸めない
 * （余白を押しただけの地名がマップ内に置いたものと見分けられなくなる）。
 */
function coordError(x_m, y_m, map) {
  if (!isFiniteNumber(x_m) || !isFiniteNumber(y_m)) return "座標が数値ではありません";
  if (x_m < 0 || y_m < 0 || x_m > map.width_m || y_m > map.height_m) {
    return "座標がマップの範囲外です";
  }
  return null;
}

/**
 * 名前は必須。`name` は NOT NULL なので、空白だけの「無名の点」を作らせない。
 * 文字数は書記素ではなくコードポイントで数える（validText と同じ [...t].length）。
 */
function normalizeName(raw) {
  if (typeof raw !== "string") return { error: "地名を入力してください" };
  const t = raw.trim();
  if (!t) return { error: "地名を入力してください" };
  if ([...t].length > NAME_MAX) return { error: `地名は${NAME_MAX}文字までです` };
  return { name: t };
}

/** 本文にそのキーが書かれているか。値が null でも「書かれている」と数える。 */
function hasKey(payload, key) {
  if (payload === null || typeof payload !== "object") return false;
  return Object.prototype.hasOwnProperty.call(payload, key);
}

/**
 * 地名は読むだけなら誰でもよい（共有URLで開いた人が呼び名を読めないと、
 * 「あの丘に集合」が通じない）。**ログインも要らない**（`requireViewer`）。
 *
 * 書き込む3本（POST / PATCH / DELETE）は `requireUser` のまま。
 */
export async function onRequestGet(context) {
  const auth = await requireViewer(context);
  if (auth.response) return auth.response;

  const { env, params } = context;
  const session = await env.DB.prepare("SELECT id FROM sessions WHERE id = ?")
    .bind(params.id).first();
  if (!session) return json({ error: "見つかりません" }, 404);

  const { results } = await env.DB.prepare(
    `SELECT id, name, x_m, y_m, created_by, created_at, updated_at
       FROM session_callouts WHERE session_id = ? ORDER BY id ASC`
  ).bind(session.id).all();
  return json({ callouts: results });
}

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
  const list = payload?.callouts;
  if (!Array.isArray(list) || list.length === 0) {
    return json({ error: "地名がありません" }, 400);
  }
  if (list.length > MAX_BATCH) {
    return json({ error: `一度に送れるのは${MAX_BATCH}件までです` }, 400);
  }

  // 検証は全部ここで終わらせる。1件でも不正なら INSERT を一切しない。
  const seenUuids = new Set();
  const rows = [];
  for (const c of list) {
    if (typeof c?.client_uuid !== "string" || !c.client_uuid) {
      return json({ error: "client_uuid がありません" }, 400);
    }
    if (seenUuids.has(c.client_uuid)) {
      return json({ error: "client_uuid が重複しています" }, 400);
    }
    seenUuids.add(c.client_uuid);

    const name = normalizeName(c.name);
    if (name.error) return json({ error: name.error }, 400);
    if (blockedBy(env, name.name)) {
      return json({ error: "使えない語が含まれています" }, 400);
    }

    const coordBad = coordError(c.x_m, c.y_m, plan.map);
    if (coordBad) return json({ error: coordBad }, 400);

    // まだ1件も INSERT していない段階で、別プランの client_uuid 再利用を弾く。
    const existing = await env.DB.prepare(
      "SELECT session_id FROM session_callouts WHERE client_uuid = ?"
    ).bind(c.client_uuid).first();
    if (existing && existing.session_id !== plan.session.id) {
      return json({ error: "client_uuid が別のプランで使用済みです" }, 409);
    }

    rows.push({ client_uuid: c.client_uuid, name: name.name, x_m: c.x_m, y_m: c.y_m });
  }

  // 上限は「今ある数 ＋ 新しく増える数」で見る。再送（同じ client_uuid）は
  // 増えないので、既にある client_uuid はここから除いて数える。
  const known = await countKnown(env, plan.session.id, rows.map((r) => r.client_uuid));
  const current = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM session_callouts WHERE session_id = ?"
  ).bind(plan.session.id).first();
  if (current.n + (rows.length - known) > MAX_PER_PLAN) {
    return json(
      { error: `地名は1つの作戦に${MAX_PER_PLAN}件までです。要らないものを消してください。` },
      400
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const ids = [];
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO session_callouts
         (session_id, name, x_m, y_m, created_by, created_at, updated_at, client_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(plan.session.id, r.name, r.x_m, r.y_m, auth.user.id, now, now, r.client_uuid).run();
    const row = await env.DB.prepare(
      "SELECT id FROM session_callouts WHERE client_uuid = ? AND session_id = ?"
    ).bind(r.client_uuid, plan.session.id).first();
    if (!row) {
      return json({ error: "client_uuid が別のプランで使用済みです" }, 409);
    }
    ids.push(row.id);
  }

  await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
    .bind(now, plan.session.id).run();

  return json({ saved: ids.length, ids }, 201);
}

/** 送られてきた client_uuid のうち、このプランに既にある数。 */
async function countKnown(env, sessionId, uuids) {
  if (uuids.length === 0) return 0;
  const marks = uuids.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM session_callouts
      WHERE session_id = ? AND client_uuid IN (${marks})`
  ).bind(sessionId, ...uuids).first();
  return row.n;
}

/**
 * 地名を直す（改名・移動）。対象は DELETE と同じくクエリの `?id=`。
 * 書かれたキーだけを更新する:
 *
 *   name       改名。POST とまったく同じ経路（normalizeName + BLOCKED_WORDS）を通す
 *   x_m + y_m  動かす。片方だけは受け付けない（中途半端な移動を作らない）
 *
 * 権限は DELETE と同じ（置いた本人と admin だけ）。改名でも緩めない。
 */
export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;
  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  const plan = await loadWritablePlan(env, params.id, auth.user);
  if (plan.response) return plan.response;

  const calloutId = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(calloutId)) return json({ error: "idが不正です" }, 400);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }

  const wantsCoord = hasKey(payload, "x_m") || hasKey(payload, "y_m");
  const wantsName = hasKey(payload, "name");
  if (!wantsCoord && !wantsName) return json({ error: "更新する値がありません" }, 400);

  // 検証は全部ここで終わらせてから UPDATE する（POST と同じ作法）。
  const now = Math.floor(Date.now() / 1000);
  const sets = ["updated_at = ?"];
  const binds = [now];
  const changed = {};

  if (wantsName) {
    const name = normalizeName(payload.name);
    if (name.error) return json({ error: name.error }, 400);
    if (blockedBy(env, name.name)) {
      return json({ error: "使えない語が含まれています" }, 400);
    }
    sets.push("name = ?");
    binds.push(name.name);
    changed.name = name.name;
  }

  if (wantsCoord) {
    const coordBad = coordError(payload.x_m, payload.y_m, plan.map);
    if (coordBad) return json({ error: coordBad }, 400);
    sets.push("x_m = ?", "y_m = ?");
    binds.push(payload.x_m, payload.y_m);
    changed.x_m = payload.x_m;
    changed.y_m = payload.y_m;
  }

  const row = await env.DB.prepare(
    "SELECT id, created_by FROM session_callouts WHERE id = ? AND session_id = ?"
  ).bind(calloutId, plan.session.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);

  if (row.created_by !== auth.user.id && auth.user.role !== "admin") {
    return json({ error: "他の人の地名は直せません" }, 403);
  }

  await env.DB.prepare(`UPDATE session_callouts SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, calloutId).run();
  await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
    .bind(now, plan.session.id).run();

  return json({ ok: true, id: calloutId, updated_at: now, ...changed });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;
  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  // **消すのも書き込み。** 読専の作戦では、自分が置いた地名も消せない
  // （所有者判定の手前で断る）。
  const loaded = await loadWritableSession(env, params.id, auth.user);
  if (loaded.response) return loaded.response;

  const calloutId = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(calloutId)) return json({ error: "idが不正です" }, 400);

  const row = await env.DB.prepare(
    "SELECT id, created_by FROM session_callouts WHERE id = ? AND session_id = ?"
  ).bind(calloutId, loaded.session.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);

  if (row.created_by !== auth.user.id && auth.user.role !== "admin") {
    return json({ error: "他の人の地名は消せません" }, 403);
  }

  await env.DB.prepare("DELETE FROM session_callouts WHERE id = ?").bind(calloutId).run();
  return json({ ok: true });
}
