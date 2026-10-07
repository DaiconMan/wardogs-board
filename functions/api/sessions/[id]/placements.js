import { json, isFiniteNumber, blockedBy } from "../../../_lib/validate.js";
import { requireOrigin, requireUser, requireViewer } from "../../../_lib/guard.js";
// 作戦の行を取るのと「書いてよいか」の判定は同じ関数に入っている
// （functions/_lib/visibility.js の冒頭に理由）。ここに条件を書き写さない。
import { loadWritablePlan, loadWritableSession } from "../../../_lib/visibility.js";

const MAX_BATCH = 200;
const LABEL_MAX = 48;
const RANK_MAX = 9;   // 優先度は ①〜⑨。マーカーの中に1文字で描くので1桁に収める

/**
 * 座標の検証。POST（新規）と PATCH（移動）で同じ関数を通す。
 * 片方だけ緩いと「置けないのに動かせる」座標が生まれるので、経路を分けない。
 * 戻り値はエラー文（問題なければ null）。
 */
function coordError(x_m, y_m, map) {
  // 文字列・NaN・Infinity をここで落とす。JSON の NaN は null になって届く。
  if (!isFiniteNumber(x_m) || !isFiniteNumber(y_m)) return "座標が数値ではありません";
  if (x_m < 0 || y_m < 0 || x_m > map.width_m || y_m > map.height_m) {
    return "座標がマップの範囲外です";
  }
  return null;
}

/**
 * ラベルは任意。未指定・空文字・空白のみは「ラベル無し」として NULL にする。
 * 文字数は書記素ではなくコードポイントで数える（validText と同じ [...t].length）。
 */
function normalizeLabel(raw) {
  if (raw === undefined || raw === null) return { label: null };
  if (typeof raw !== "string") return { error: "ラベルの形式が不正です" };
  const t = raw.trim();
  if (!t) return { label: null };
  if ([...t].length > LABEL_MAX) return { error: `ラベルは${LABEL_MAX}文字までです` };
  return { label: t };
}

/**
 * 優先度は 1〜9 の整数か、順位なし（null）だけ。
 * 文字列の "3" を通すと DB に文字列が入って並べ替えが壊れるので、型から弾く。
 * Number.isInteger は true / 配列 / 3.5 もまとめて落とす。
 */
function normalizeRank(raw) {
  if (raw === null) return { rank: null };
  if (!Number.isInteger(raw) || raw < 1 || raw > RANK_MAX) {
    return { error: `優先度は1〜${RANK_MAX}の整数か、なし（null）です` };
  }
  return { rank: raw };
}

/**
 * 本文にそのキーが書かれているか。値が null でも「書かれている」と数える。
 * PATCH では「省略＝触らない」と「null＝消す」を区別する必要があるので、
 * `payload?.label` の真偽では判定できない。
 */
function hasKey(payload, key) {
  if (payload === null || typeof payload !== "object") return false;
  return Object.prototype.hasOwnProperty.call(payload, key);
}

// 読むだけならログインは要らない（`requireViewer`）。URL を知っている人が
// 盤面を見られるのに置いてあるものが見えないと、見ること自体が成り立たない。
// **書き込む3本（POST / PATCH / DELETE）は `requireUser` のまま**で、
// ゲストは公開設定の門（`loadWritablePlan`）へ届く前に 401 で落ちる。
export async function onRequestGet(context) {
  const auth = await requireViewer(context);
  if (auth.response) return auth.response;

  const { env, params } = context;
  const session = await env.DB.prepare("SELECT id FROM sessions WHERE id = ?")
    .bind(params.id).first();
  if (!session) return json({ error: "見つかりません" }, 404);

  const { results } = await env.DB.prepare(
    `SELECT id, item_id, x_m, y_m, rotation, label, rank, created_by, created_at
       FROM placements WHERE session_id = ? ORDER BY id ASC`
  ).bind(session.id).all();
  return json({ placements: results });
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
  const list = payload?.placements;
  if (!Array.isArray(list) || list.length === 0) {
    return json({ error: "配置がありません" }, 400);
  }
  if (list.length > MAX_BATCH) {
    return json({ error: `一度に送れるのは${MAX_BATCH}件までです` }, 400);
  }

  // 検証は全部ここで終わらせる。1件でも不正なら INSERT を一切しない。
  const seenUuids = new Set();
  const knownItems = new Map(); // item_id -> カタログに在るか
  const rows = [];
  for (const p of list) {
    if (typeof p?.client_uuid !== "string" || !p.client_uuid) {
      return json({ error: "client_uuid がありません" }, 400);
    }
    if (seenUuids.has(p.client_uuid)) {
      return json({ error: "client_uuid が重複しています" }, 400);
    }
    seenUuids.add(p.client_uuid);

    if (typeof p.item_id !== "string" || !p.item_id) {
      return json({ error: "item_id がありません" }, 400);
    }
    if (!knownItems.has(p.item_id)) {
      const item = await env.DB.prepare("SELECT id FROM catalog_items WHERE id = ?")
        .bind(p.item_id).first();
      knownItems.set(p.item_id, Boolean(item));
    }
    if (!knownItems.get(p.item_id)) {
      return json({ error: "item_id がカタログにありません" }, 400);
    }

    const coordBad = coordError(p.x_m, p.y_m, plan.map);
    if (coordBad) return json({ error: coordBad }, 400);

    // 省略（キー無し）だけを 0 とみなす。null は弾く: JSON では NaN も Infinity も
    // null になって届くので、null を 0 に丸めると壊れた向きを静かに 0 で保存してしまう。
    const rotation = p.rotation === undefined ? 0 : p.rotation;
    if (!isFiniteNumber(rotation) || rotation < 0 || rotation >= 360) {
      return json({ error: "向きは0以上360未満の度数です" }, 400);
    }

    const label = normalizeLabel(p.label);
    if (label.error) return json({ error: label.error }, 400);
    if (label.label && blockedBy(env, label.label)) {
      return json({ error: "使えない語が含まれています" }, 400);
    }

    // まだ1件も INSERT していない段階で、別プランの client_uuid 再利用を弾く。
    // INSERT ループの中でやると、途中で気づいた時点で手前の分だけ保存されてしまう。
    const existing = await env.DB.prepare(
      "SELECT session_id FROM placements WHERE client_uuid = ?"
    ).bind(p.client_uuid).first();
    if (existing && existing.session_id !== plan.session.id) {
      return json({ error: "client_uuid が別のプランで使用済みです" }, 409);
    }

    rows.push({
      client_uuid: p.client_uuid,
      item_id: p.item_id,
      x_m: p.x_m,
      y_m: p.y_m,
      rotation,
      label: label.label,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const ids = [];
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO placements
         (session_id, item_id, x_m, y_m, rotation, label, created_by, created_at, client_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(plan.session.id, r.item_id, r.x_m, r.y_m, r.rotation, r.label,
           auth.user.id, now, r.client_uuid).run();
    // 検証ループで別プラン利用は弾いてあるので、ここは必ず見つかるはず。
    // 念のため session_id で絞ったまま残し、見つからなければ 409 とする。
    const row = await env.DB.prepare(
      "SELECT id FROM placements WHERE client_uuid = ? AND session_id = ?"
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

/**
 * 置いたものを動かす・注記を書く・優先度を付ける。
 *
 * 置き直しのために「消して置く」を強いると、他人の配置を消す権限の話や
 * client_uuid の採番が絡んで事故りやすい。既にある行を更新する口を分けて持つ。
 *
 * 対象の指定は DELETE と同じくクエリの `?id=`。更新する値は本文で、
 * 書かれたキーだけを更新する（省略したキーは触らない）:
 *
 *   x_m + y_m  座標。片方だけは受け付けない（中途半端な移動を作らないため）
 *   label      注記。POST とまったく同じ経路（normalizeLabel + BLOCKED_WORDS）を通す
 *   rank       優先度 1〜9。null で順位なしに戻す
 *
 * 1つも書かれていなければ 400。権限は DELETE と同じ（置いた本人と admin だけ）で、
 * 注記や優先度でも緩めない。
 */
export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;
  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  const plan = await loadWritablePlan(env, params.id, auth.user);
  if (plan.response) return plan.response;

  const placementId = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(placementId)) return json({ error: "idが不正です" }, 400);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }

  // 「書かれたキーだけ更新する」ので、まずどれが来ているかを確定させる。
  // 座標は x_m / y_m のどちらか一方でも書かれていたら「座標を更新する意図」とみなし、
  // 両方そろって有効でなければ 400 にする。片方だけ黙って無視すると、
  // 画面では動いたのに DB は半分しか変わっていない状態が作れてしまう。
  const wantsCoord = hasKey(payload, "x_m") || hasKey(payload, "y_m");
  const wantsLabel = hasKey(payload, "label");
  const wantsRank = hasKey(payload, "rank");
  if (!wantsCoord && !wantsLabel && !wantsRank) {
    return json({ error: "更新する値がありません" }, 400);
  }

  // 検証は全部ここで終わらせてから UPDATE する（POST と同じ作法）。
  const sets = [];
  const binds = [];
  const changed = {};

  if (wantsCoord) {
    const coordBad = coordError(payload.x_m, payload.y_m, plan.map);
    if (coordBad) return json({ error: coordBad }, 400);
    sets.push("x_m = ?", "y_m = ?");
    binds.push(payload.x_m, payload.y_m);
    changed.x_m = payload.x_m;
    changed.y_m = payload.y_m;
  }

  if (wantsLabel) {
    const label = normalizeLabel(payload.label);
    if (label.error) return json({ error: label.error }, 400);
    if (label.label && blockedBy(env, label.label)) {
      return json({ error: "使えない語が含まれています" }, 400);
    }
    sets.push("label = ?");
    binds.push(label.label);
    changed.label = label.label;
  }

  if (wantsRank) {
    const rank = normalizeRank(payload.rank);
    if (rank.error) return json({ error: rank.error }, 400);
    sets.push("rank = ?");
    binds.push(rank.rank);
    changed.rank = rank.rank;
  }

  const row = await env.DB.prepare(
    "SELECT id, created_by FROM placements WHERE id = ? AND session_id = ?"
  ).bind(placementId, plan.session.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);

  if (row.created_by !== auth.user.id && auth.user.role !== "admin") {
    return json({ error: "他の人の配置は動かせません" }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`UPDATE placements SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, placementId).run();
  await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
    .bind(now, plan.session.id).run();

  return json({ ok: true, id: placementId, ...changed });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;
  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  // **消すのも書き込み。** 読専の作戦では、他人が置いた物も自分が置いた物も
  // 消せない（所有者判定の手前で断る）。
  const loaded = await loadWritableSession(env, params.id, auth.user);
  if (loaded.response) return loaded.response;

  const placementId = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(placementId)) return json({ error: "idが不正です" }, 400);

  const row = await env.DB.prepare(
    "SELECT id, created_by FROM placements WHERE id = ? AND session_id = ?"
  ).bind(placementId, loaded.session.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);

  if (row.created_by !== auth.user.id && auth.user.role !== "admin") {
    return json({ error: "他の人の配置は消せません" }, 403);
  }

  await env.DB.prepare("DELETE FROM placements WHERE id = ?").bind(placementId).run();
  return json({ ok: true });
}
