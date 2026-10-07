import { json } from "../../../_lib/validate.js";
import { requireUser, requireOrigin } from "../../../_lib/guard.js";
// 作戦の行を取るのと「書いてよいか」の判定は同じ関数に入っている
// （functions/_lib/visibility.js の冒頭に理由）。ここに条件を書き写さない。
import { loadWritablePlan, loadWritableSession } from "../../../_lib/visibility.js";

/**
 * エリア塗り（自陣・敵陣・中立・最重要・危険予測）の書き込み口。
 *
 * **ここに入るのは全部「チームが手で塗る見立て」。** ゲームが決めるもの
 * （コントロールエリアの円・ホットゾーン）は `map_zone_presets` / `session_zone` が
 * 持つ実データで、手では描かない。名前が衝突していた `control` / `hot` は廃止した。
 *
 * 読みは `GET /api/sessions/{id}` が `areas` として返すので、ここには GET を置かない。
 * 初回描画に必要なものを1往復にまとめ、後から来る fetch が画面の状態を壊す事故を増やさない。
 *
 * 形は 1km セルの矩形集合（`rects`）で、1ジェスチャ = 1行の追記型。`op` が add / sub。
 * placements.js と同じく、検証は全部 INSERT の前で終わらせる（1件でも不正なら1行も入れない）。
 */

const MAX_BATCH = 200;       // placements.js と同値
const MAX_RECTS = 64;        // 1行（1ジェスチャ）に入れられる矩形の数
// 新しく塗れる種類。**`control` / `hot` は入れない。**
// ゲームが画面に出すもの（半径500mの円・半径85mの円）と同じ名前の手描きを
// 作れてしまうと、「コントロールエリア」がどちらを指すか決まらなくなる。
// 既存行の読み替えは GET 側（functions/api/sessions/[id].js の LEGACY_AREA_KINDS）。
const KINDS = new Set(["own", "enemy", "neutral", "key", "risk"]);
const OPS = new Set(["add", "sub"]);
// 刻みを細かくしたくなったときにスキーマを変えずに済ませるための逃げ道。
// 既定の 1000 はゲーム内グリッドと同じ 1km。
const CELL_SIZES = new Set([250, 500, 1000]);
const DEFAULT_CELL_M = 1000;

/**
 * セルの一辺を決める。未指定なら 1000。
 *
 * **マップの一辺はちょうどの km ではない**（Bakurani / Ozeti 16,320m、
 * Zestafona 16,384m。docs/research/2026-09-29-zones-drills-data.md §3.5）。
 * 1km で刻むと端に 320〜384m の余りが出るので、**丸ごと入るセルだけを数える**。
 * 余りの帯はどのセルにも属さない（塗れない）。
 *
 * 以前はここで「一辺を割り切れること」を要求していたが、マップの実寸が
 * 16,000m だという前提が誤りだったため、そのままだとどのマップも
 * どのセルサイズも通らなくなる（＝エリア塗りが全滅する）。
 *
 * 列・行の数え方は描画側（coords.js の makeCoords）と同じでなければならない。
 * ずれると、端のセルを塗ったときだけ 400 になる。
 *
 * 戻り値は { cell_m, cols, rows } か { error }。
 */
function resolveCell(raw, map) {
  const cell_m = raw === undefined ? DEFAULT_CELL_M : raw;
  if (!CELL_SIZES.has(cell_m)) {
    return { error: "セルの大きさが不正です" };
  }
  const cols = Math.floor(map.width_m / cell_m);
  const rows = Math.floor(map.height_m / cell_m);
  if (cols < 1 || rows < 1) {
    return { error: "セルの大きさがマップより大きいです" };
  }
  return { cell_m, cols, rows };
}

/**
 * 矩形の配列を検証する。問題があればエラー文、無ければ null。
 *
 * 範囲外は丸めない（インク・配置と同じ方針）。黙って縁に貼り付けると、
 * 送った側が見ている形と保存された形が食い違う。
 */
function rectsError(rects, cols, rows) {
  if (!Array.isArray(rects) || rects.length === 0) return "塗る範囲がありません";
  if (rects.length > MAX_RECTS) return `1回に塗れるのは${MAX_RECTS}区画までです`;

  let cells = 0;
  for (const r of rects) {
    if (!Array.isArray(r) || r.length !== 4) return "塗る範囲の形式が不正です";
    // 文字列の "0" や小数、JSON で null になった NaN / Infinity をここで落とす。
    if (!r.every((v) => Number.isInteger(v))) return "塗る範囲の形式が不正です";
    const [c0, r0, c1, r1] = r;
    // 逆転（c1 < c0）も正規化しない。送る側が押して引いた向きで並べ替えるべきで、
    // サーバが直すと「どちらの向きでも通る」ことに依存した実装を誘発する。
    if (c0 < 0 || r0 < 0 || c0 > c1 || r0 > r1 || c1 >= cols || r1 >= rows) {
      return "セルの範囲外です";
    }
    cells += (c1 - c0 + 1) * (r1 - r0 + 1);
  }
  // マップ全体より多いセルを1行に入れるのは、重なりの分だけ無駄に大きいということ。
  if (cells > cols * rows) return "塗る範囲が広すぎます";
  return null;
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
  const list = payload?.areas;
  if (!Array.isArray(list) || list.length === 0) {
    return json({ error: "エリアがありません" }, 400);
  }
  if (list.length > MAX_BATCH) {
    return json({ error: `一度に送れるのは${MAX_BATCH}件までです` }, 400);
  }

  // 検証は全部ここで終わらせる。1件でも不正なら INSERT を一切しない。
  const seenUuids = new Set();
  const rows = [];
  for (const a of list) {
    if (typeof a?.client_uuid !== "string" || !a.client_uuid) {
      return json({ error: "client_uuid がありません" }, 400);
    }
    if (seenUuids.has(a.client_uuid)) {
      return json({ error: "client_uuid が重複しています" }, 400);
    }
    seenUuids.add(a.client_uuid);

    if (!KINDS.has(a.kind)) return json({ error: "エリアの種類が不正です" }, 400);

    const op = a.op === undefined ? "add" : a.op;
    if (!OPS.has(op)) return json({ error: "エリアの操作が不正です" }, 400);

    const cell = resolveCell(a.cell_m, plan.map);
    if (cell.error) return json({ error: cell.error }, 400);

    const rectsBad = rectsError(a.rects, cell.cols, cell.rows);
    if (rectsBad) return json({ error: rectsBad }, 400);

    // まだ1件も INSERT していない段階で、別プランの client_uuid 再利用を弾く。
    // INSERT ループの中でやると、途中で気づいた時点で手前の分だけ保存されてしまう。
    const existing = await env.DB.prepare(
      "SELECT session_id FROM session_areas WHERE client_uuid = ?"
    ).bind(a.client_uuid).first();
    if (existing && existing.session_id !== plan.session.id) {
      return json({ error: "client_uuid が別のプランで使用済みです" }, 409);
    }

    rows.push({
      client_uuid: a.client_uuid,
      kind: a.kind,
      op,
      cell_m: cell.cell_m,
      rects: JSON.stringify(a.rects),
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const ids = [];
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO session_areas
         (session_id, kind, op, cell_m, rects, created_by, created_at, client_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(plan.session.id, r.kind, r.op, r.cell_m, r.rects,
           auth.user.id, now, r.client_uuid).run();
    // 検証ループで別プラン利用は弾いてあるので、ここは必ず見つかるはず。
    // 念のため session_id で絞ったまま残し、見つからなければ 409 とする。
    const row = await env.DB.prepare(
      "SELECT id FROM session_areas WHERE client_uuid = ? AND session_id = ?"
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
 * 1行消す。取り消し（元に戻す）はこれを最後の行に対して呼ぶだけで済む。
 * 権限は placements と同じで、塗った本人と admin だけ。
 */
export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;
  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  // **消すのも書き込み。** 読専の作戦では、自分が塗った行も消せない
  // （所有者判定の手前で断る）。
  const loaded = await loadWritableSession(env, params.id, auth.user);
  if (loaded.response) return loaded.response;

  // `?id=` の省略は Number(null) === 0 で整数判定を素通りしてしまうので、
  // 生の文字列の有無で先に落とす。
  const raw = new URL(request.url).searchParams.get("id");
  const areaId = Number(raw);
  if (raw === null || raw === "" || !Number.isInteger(areaId)) {
    return json({ error: "idが不正です" }, 400);
  }

  const row = await env.DB.prepare(
    "SELECT id, created_by FROM session_areas WHERE id = ? AND session_id = ?"
  ).bind(areaId, loaded.session.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);

  if (row.created_by !== auth.user.id && auth.user.role !== "admin") {
    return json({ error: "他の人のエリアは消せません" }, 403);
  }

  await env.DB.prepare("DELETE FROM session_areas WHERE id = ?").bind(areaId).run();
  return json({ ok: true });
}
