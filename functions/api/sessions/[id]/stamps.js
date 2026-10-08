// 作戦ごとのスタンプ（plan_stamps）と、スタンプの定義（stamps）。
//
// オーナーの要望（D-062）:
//   「四角とか、丸、などスタンプほしいですね」
//   「スタンプは、凸型の敵とか見方を示すものもあっていいし、自由に追加もいいと思います」
//   「軍用記号です」
//
// 仕様: docs/superpowers/specs/2026-10-08-stamps.md（第1段 ＝ 組み込みの一式）
//
// ── 定義（`stamps`）が同じ GET に乗っている理由 ────────────────
// スタンプは「どんなスタンプがあるか」（マップ静的ではなく全体で共通）と
// 「この作戦のどこに置いたか」の2つが要る。建造物は `/api/catalog` と
// `/api/sessions/:id/placements` に分かれているが、**スタンプは分けない。**
//
//   * 盤面を開くときの往復を増やしたくない（いまカタログ・配置・地名で3本ある）
//   * 定義は 25 行で、1行は 100 バイト弱。片方だけ取る用が無い
//
// だから `GET` は `{ stamps: [置いたもの], defs: [定義] }` を返す。
//
// 権限・冪等・検証は placements / callouts とまったく同じ作法に揃えてある
// （読むのは誰でも、直すのは本人と admin、client_uuid で冪等）。
import { json, isFiniteNumber, blockedBy } from "../../../_lib/validate.js";
import { requireOrigin, requireUser, requireViewer } from "../../../_lib/guard.js";
// 作戦の行を取るのと「書いてよいか」の判定は同じ関数に入っている
// （functions/_lib/visibility.js の冒頭に理由）。ここに条件を書き写さない。
import { loadWritablePlan, loadWritableSession } from "../../../_lib/visibility.js";

/** 注記の長さ。public/js/plan/stamps.js の NOTE_MAX_LEN と同じ値。 */
const NOTE_MAX = 48;

/**
 * 1作戦に置けるスタンプの上限。
 *
 * 地名（200件）より多くしてある。地名は 1km セルに1個弱の見立てだが、スタンプは
 * 「ここに敵の歩兵」「ここから攻める」を**同じセルに何個も置く**使い方になる。
 * 一方で無制限にすると GET の応答が無限に膨らむので、置き数の 1桁上で止める。
 */
const MAX_PER_PLAN = 400;

/**
 * 一度に送れる件数。UI は1操作で1件しか置かないが、将来の流し込み
 * （パターンのプリセット）に備えて少しだけ余裕を持たせる。
 * 上限そのもの（400）より小さくして、1回の POST で作戦を一杯にできないようにする。
 */
const MAX_BATCH = 50;

/**
 * 座標の検証。POST（新規）と PATCH（移動）で同じ関数を通す。
 * placements / callouts と同じく、範囲外は 400 にして縁へ丸めない
 * （余白を押しただけのスタンプがマップ内に置いたものと見分けられなくなる）。
 */
function coordError(x_m, y_m, map) {
  if (!isFiniteNumber(x_m) || !isFiniteNumber(y_m)) return "座標が数値ではありません";
  if (x_m < 0 || y_m < 0 || x_m > map.width_m || y_m > map.height_m) {
    return "座標がマップの範囲外です";
  }
  return null;
}

/**
 * 終点の検証。
 *
 * **`vector` は終点が必須、`point` は終点を持てない。** どちらも緩めると
 *   * 終点の無い矢印（向きが決まらない ＝ 画面に出せない）
 *   * 終点を持つ四角（描く側がどちらを信じるか決められない）
 * が静かに保存される。**定義の `draw_kind` が形を決める**ので、ここで突き合わせる。
 *
 * 戻り値は `{ x2_m, y2_m }` か `{ error }`。
 */
function endError(def, row, map) {
  const has = row.x2_m !== undefined && row.x2_m !== null
    && row.y2_m !== undefined && row.y2_m !== null;
  if (def.draw_kind === "vector") {
    if (!has) return { error: "向きを持つスタンプには終点（x2_m / y2_m）が必要です" };
    const bad = coordError(row.x2_m, row.y2_m, map);
    if (bad) return { error: bad };
    return { x2_m: row.x2_m, y2_m: row.y2_m };
  }
  if (has) return { error: "このスタンプは終点を持ちません" };
  return { x2_m: null, y2_m: null };
}

/**
 * 注記は任意。未指定・空文字・空白のみは「注記なし」として NULL にする
 * （placements の `label` と同じ作法）。
 */
function normalizeNote(raw) {
  if (raw === undefined || raw === null) return { note: null };
  if (typeof raw !== "string") return { error: "注記の形式が不正です" };
  const t = raw.trim();
  if (!t) return { note: null };
  if ([...t].length > NOTE_MAX) return { error: `注記は${NOTE_MAX}文字までです` };
  return { note: t };
}

/** 本文にそのキーが書かれているか。値が null でも「書かれている」と数える。 */
function hasKey(payload, key) {
  if (payload === null || typeof payload !== "object") return false;
  return Object.prototype.hasOwnProperty.call(payload, key);
}

/** スタンプの定義を全部引く。組み込み（id 1〜25）が先に来るよう id 昇順。 */
const loadDefs = (env) => env.DB.prepare(
  `SELECT id, label, shape, color, glyph, draw_kind, builtin, created_by
     FROM stamps ORDER BY id ASC`
).all();

/**
 * スタンプは読むだけなら誰でもよい（共有URLで開いた人に敵の配置が見えないと、
 * 「ここに装甲がいる」が伝わらない）。**ログインも要らない**（`requireViewer`）。
 *
 * 書き込む3本（POST / PATCH / DELETE）は `requireUser` のまま ＝ ゲストは
 * 公開設定の門へ届く前に 401 で落ちる。
 */
export async function onRequestGet(context) {
  const auth = await requireViewer(context);
  if (auth.response) return auth.response;

  const { env, params } = context;
  const session = await env.DB.prepare("SELECT id FROM sessions WHERE id = ?")
    .bind(params.id).first();
  if (!session) return json({ error: "見つかりません" }, 404);

  const [placed, defs] = await Promise.all([
    env.DB.prepare(
      `SELECT id, stamp_id, x_m, y_m, x2_m, y2_m, count, note, created_by, created_at
         FROM plan_stamps WHERE session_id = ? ORDER BY id ASC`
    ).bind(session.id).all(),
    loadDefs(env),
  ]);
  return json({ stamps: placed.results, defs: defs.results });
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
  const list = payload?.stamps;
  if (!Array.isArray(list) || list.length === 0) {
    return json({ error: "スタンプがありません" }, 400);
  }
  if (list.length > MAX_BATCH) {
    return json({ error: `一度に送れるのは${MAX_BATCH}件までです` }, 400);
  }

  // 検証は全部ここで終わらせる。1件でも不正なら INSERT を一切しない。
  const seenUuids = new Set();
  const knownDefs = new Map();   // stamp_id -> 定義の行（無ければ null）
  const rows = [];
  for (const s of list) {
    if (typeof s?.client_uuid !== "string" || !s.client_uuid) {
      return json({ error: "client_uuid がありません" }, 400);
    }
    if (seenUuids.has(s.client_uuid)) {
      return json({ error: "client_uuid が重複しています" }, 400);
    }
    seenUuids.add(s.client_uuid);

    // `stamp_id` は NOT NULL だが外部キー制約が無い（D1 既定で OFF）。
    // **在ることをここで確かめる。** 確かめないと、定義の無いスタンプが
    // 置かれて、画面には「何も出ないのに消せない行」として残る。
    if (!Number.isInteger(s.stamp_id) || s.stamp_id <= 0) {
      return json({ error: "stamp_id がありません" }, 400);
    }
    if (!knownDefs.has(s.stamp_id)) {
      const def = await env.DB.prepare("SELECT id, draw_kind FROM stamps WHERE id = ?")
        .bind(s.stamp_id).first();
      knownDefs.set(s.stamp_id, def ?? null);
    }
    const def = knownDefs.get(s.stamp_id);
    if (!def) return json({ error: "そのスタンプは存在しません" }, 400);

    const coordBad = coordError(s.x_m, s.y_m, plan.map);
    if (coordBad) return json({ error: coordBad }, 400);

    const end = endError(def, s, plan.map);
    if (end.error) return json({ error: end.error }, 400);

    const note = normalizeNote(s.note);
    if (note.error) return json({ error: note.error }, 400);
    if (note.note && blockedBy(env, note.note)) {
      return json({ error: "使えない語が含まれています" }, 400);
    }

    // まだ1件も INSERT していない段階で、別の作戦の client_uuid 再利用を弾く。
    const existing = await env.DB.prepare(
      "SELECT session_id FROM plan_stamps WHERE client_uuid = ?"
    ).bind(s.client_uuid).first();
    if (existing && existing.session_id !== plan.session.id) {
      return json({ error: "client_uuid が別のプランで使用済みです" }, 409);
    }

    rows.push({
      client_uuid: s.client_uuid,
      stamp_id: s.stamp_id,
      x_m: s.x_m,
      y_m: s.y_m,
      x2_m: end.x2_m,
      y2_m: end.y2_m,
      note: note.note,
    });
  }

  // 上限は「今ある数 ＋ 新しく増える数」で見る。再送（同じ client_uuid）は
  // 増えないので、既にある client_uuid はここから除いて数える。
  const known = await countKnown(env, plan.session.id, rows.map((r) => r.client_uuid));
  const current = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM plan_stamps WHERE session_id = ?"
  ).bind(plan.session.id).first();
  if (current.n + (rows.length - known) > MAX_PER_PLAN) {
    return json(
      { error: `スタンプは1つの作戦に${MAX_PER_PLAN}件までです。要らないものを消してください。` },
      400
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const ids = [];
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO plan_stamps
         (session_id, stamp_id, x_m, y_m, x2_m, y2_m, note, created_by, created_at, client_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      plan.session.id, r.stamp_id, r.x_m, r.y_m, r.x2_m, r.y2_m,
      r.note, auth.user.id, now, r.client_uuid
    ).run();
    const row = await env.DB.prepare(
      "SELECT id FROM plan_stamps WHERE client_uuid = ? AND session_id = ?"
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

/** 送られてきた client_uuid のうち、この作戦に既にある数。 */
async function countKnown(env, sessionId, uuids) {
  if (uuids.length === 0) return 0;
  const marks = uuids.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM plan_stamps
      WHERE session_id = ? AND client_uuid IN (${marks})`
  ).bind(sessionId, ...uuids).first();
  return row.n;
}

/**
 * 置いたスタンプを直す。対象は DELETE と同じくクエリの `?id=`。
 * 書かれたキーだけを更新する:
 *
 *   x_m + y_m      動かす。片方だけは受け付けない
 *   x2_m + y2_m    `vector` の終点も一緒に動かす（v1 は全体の平行移動だけ）
 *   note           注記。null で消す
 *
 * **`vector` を動かすときは始点と終点の両方を送ること。** 片方だけ動かすと、
 * 保存された向きが手元の絵と食い違う（端だけ動かす操作は第2段）。
 *
 * 権限は DELETE と同じ（置いた本人と admin だけ）。注記でも緩めない。
 */
export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;
  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  const plan = await loadWritablePlan(env, params.id, auth.user);
  if (plan.response) return plan.response;

  const stampId = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(stampId)) return json({ error: "idが不正です" }, 400);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }

  const wantsCoord = hasKey(payload, "x_m") || hasKey(payload, "y_m");
  const wantsEnd = hasKey(payload, "x2_m") || hasKey(payload, "y2_m");
  const wantsNote = hasKey(payload, "note");
  if (!wantsCoord && !wantsEnd && !wantsNote) {
    return json({ error: "更新する値がありません" }, 400);
  }

  // **行と定義を先に取る。** `vector` かどうかで終点の扱いが変わるので、
  // 検証の前に定義が要る（placements の PATCH が検証だけで済むのとの違い）。
  const row = await env.DB.prepare(
    `SELECT p.id, p.created_by, s.draw_kind
       FROM plan_stamps p LEFT JOIN stamps s ON s.id = p.stamp_id
      WHERE p.id = ? AND p.session_id = ?`
  ).bind(stampId, plan.session.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);

  if (row.created_by !== auth.user.id && auth.user.role !== "admin") {
    return json({ error: "他の人のスタンプは直せません" }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
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

  if (wantsEnd) {
    if (row.draw_kind !== "vector") {
      return json({ error: "このスタンプは終点を持ちません" }, 400);
    }
    const endBad = coordError(payload.x2_m, payload.y2_m, plan.map);
    if (endBad) return json({ error: endBad }, 400);
    sets.push("x2_m = ?", "y2_m = ?");
    binds.push(payload.x2_m, payload.y2_m);
    changed.x2_m = payload.x2_m;
    changed.y2_m = payload.y2_m;
  }

  // **`vector` の始点だけを動かすのは受けない。** 受けると保存された向きが
  // 手元の絵と食い違う（動かした結果が画面と違う、がいちばん分かりにくい）。
  if (row.draw_kind === "vector" && wantsCoord !== wantsEnd) {
    return json({ error: "向きを持つスタンプは始点と終点の両方を送ってください" }, 400);
  }

  if (wantsNote) {
    const note = normalizeNote(payload.note);
    if (note.error) return json({ error: note.error }, 400);
    if (note.note && blockedBy(env, note.note)) {
      return json({ error: "使えない語が含まれています" }, 400);
    }
    sets.push("note = ?");
    binds.push(note.note);
    changed.note = note.note;
  }

  await env.DB.prepare(`UPDATE plan_stamps SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, stampId).run();
  await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
    .bind(now, plan.session.id).run();

  return json({ ok: true, id: stampId, ...changed });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;
  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  // **消すのも書き込み。** 読専の作戦では、自分が置いたスタンプも消せない
  // （所有者判定の手前で断る）。
  const loaded = await loadWritableSession(env, params.id, auth.user);
  if (loaded.response) return loaded.response;

  const stampId = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(stampId)) return json({ error: "idが不正です" }, 400);

  const row = await env.DB.prepare(
    "SELECT id, created_by FROM plan_stamps WHERE id = ? AND session_id = ?"
  ).bind(stampId, loaded.session.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);

  if (row.created_by !== auth.user.id && auth.user.role !== "admin") {
    return json({ error: "他の人のスタンプは消せません" }, 403);
  }

  await env.DB.prepare("DELETE FROM plan_stamps WHERE id = ?").bind(stampId).run();
  return json({ ok: true });
}
