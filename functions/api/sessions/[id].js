import { json } from "../../_lib/validate.js";
import { requireOrigin, requireUser, requireViewer } from "../../_lib/guard.js";
import { decodePoints } from "../../_lib/ink.js";
import { isVisibility, normalizeVisibility } from "../../_lib/visibility.js";
import { defaultRadiusM, toApi } from "../../_lib/zones.js";

// **所有者チェックは置かない。** URL を知っている誰でも開ける。
// 公開設定（`visibility`）は「一覧に出るか」と「書き込めるか」を決めるもので、
// **閲覧は3つの状態すべてで同じ**（オーナーの要望「URLを知っている場合は
// その設定関係なく閲覧可能」）。
//
// **ログインも要らない**（`requireViewer`）。ゲストもここを通って盤面を読む。
// 非公開の作戦も含めて開けるのは、いまのログイン済みとまったく同じ扱い——
// 守っているのは「URL を知っていること」で、公開設定はそこを変えない。
export async function onRequestGet(context) {
  const auth = await requireViewer(context);
  if (auth.response) return auth.response;

  const { env, params } = context;
  const row = await env.DB.prepare(
    `SELECT id, map_id, title, created_by, created_at, updated_at, visibility
       FROM sessions WHERE id = ?`
  ).bind(params.id).first();
  if (!row) return json({ error: "見つかりません" }, 404);
  // 画面は「作成者か」と「どの状態か」の2つで出し方を決める。知らない値を
  // そのまま渡すと画面側でも丸める必要が出るので、ここで3つのどれかに揃える。
  const session = { ...row, visibility: normalizeVisibility(row.visibility) };

  const map = await env.DB.prepare(
    "SELECT id, name, width_m, height_m, y_axis_down, verified FROM maps WHERE id = ?"
  ).bind(session.map_id).first();

  // 盤面に要るものは**1回の batch でまとめて読む。**
  //
  // 種類が増えるたびに `await` を1本足していくと、そのぶん往復が増える。
  // ここは作戦を開くたびに必ず通る経路で、実測でそれが表に出た: コントロール
  // エリアのプリセットと選択を素朴に2本足したところ、訪問履歴のテストファイルが
  // 59秒 → 101秒になり、30秒の上限を超えて落ちた。
  //
  // どれも session.id か session.map_id だけに依存していて互いに独立なので、
  // 並べる順以外に決めることが無い。**種類を足すときはこの配列に足す**
  // （`await` を足さない）。
  const [inkRows, areaRows, towerRows, spawnRows, presetRows, chosenRows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, color, width, points, created_by, created_at
         FROM ink_strokes WHERE session_id = ? ORDER BY id ASC`
    ).bind(session.id),
    // エリア塗り（session_areas）。1ジェスチャ = 1行の追記型なので、
    // 描画側はこの順（id の昇順）に op を適用して現在のセル集合を得る。
    env.DB.prepare(
      `SELECT id, kind, op, cell_m, rects, created_by
         FROM session_areas WHERE session_id = ? ORDER BY id ASC`
    ).bind(session.id),
    // ドリルタワー（マップ固定の設備）。プランではなくマップに紐づくので
    // session_id では引かない。ここに相乗りさせているのは「作戦を開いた時点で
    // 見えている」必要があるため（後から別の fetch で足すと、開いた直後だけ
    // 盤面に無い状態ができる）。
    env.DB.prepare(
      `SELECT id, name, x_m, y_m, accuracy_m, verified
         FROM map_towers WHERE map_id = ? ORDER BY sort_order ASC, id ASC`
    ).bind(session.map_id),
    // 陣営スポーン（セーフゾーン）。こちらもマップ固定で、同じ理由でここに乗せる。
    env.DB.prepare(
      `SELECT id, faction, name, polygon, verified
         FROM map_spawns WHERE map_id = ? ORDER BY sort_order ASC, id ASC`
    ).bind(session.map_id),
    // コントロールエリアのプリセット（ゲームが決めた円）。タワーと同じくマップ静的。
    // 「どのパターンを想定するか」（下の session_zone）だけが作戦ごとの値で、**円の中に入って
    // いるタワーは持たない**。画面側が距離で出す（持つと二重管理になる。調査 §4.3）。
    env.DB.prepare(
      `SELECT id, map_id, key, name, tag, x_m, y_m, radius_m, weight,
              source, measured_at, patch, verified, sort_order, created_by
         FROM map_zone_presets WHERE map_id = ? ORDER BY sort_order ASC, id ASC`
    ).bind(session.map_id),
    env.DB.prepare(
      "SELECT preset_id FROM session_zone WHERE session_id = ?"
    ).bind(session.id),
  ]);

  // **ゲストの訪問は記録しない。** これが「ゲストを入れても安全」の根拠の半分で、
  // ゲストについて**新しく保存する個人データがゼロ**という性質そのもの
  // （`_lib/guest.js` のヘッダ）。ゲストは Durable Object の部屋の中にだけ存在する。
  // 「ゲストの訪問履歴があると便利」でここを緩めないこと。
  // そもそも返す先も無い（ゲストの一覧に `visited` は出さない）。
  if (!auth.user.guest) await recordVisit(env, session.id, auth.user.id);

  return json({
    session,
    map,
    strokes: parseStrokes(inkRows.results),
    areas: parseAreas(areaRows.results),
    towers: towerRows.results,
    spawns: spawnRows.results,
    zone_presets: presetRows.results.map(toApi),
    zone_preset_id: chosenRows.results[0]?.preset_id ?? null,
    // 半径の既定値の持ち主はサーバ（_lib/zones.js）。同じ数字を画面側に書かない。
    zone_default_radius_m: defaultRadiusM(session.map_id),
  });
}

/** Review Focus 4: 壊れた行が1つあってもマップ全体の描画を落とさない。 */
function parseStrokes(rows) {
  const strokes = [];
  for (const row of rows) {
    try {
      const encoded = JSON.parse(row.points);
      if (!Array.isArray(encoded) || encoded.length < 4) continue;
      strokes.push({
        id: row.id,
        color: row.color,
        width: row.width,
        points: decodePoints(encoded),
        created_by: row.created_by,
      });
    } catch {
      continue; // 壊れた行は読み飛ばす
    }
  }
  return strokes;
}

/**
 * 名前がゲームの用語と衝突していたので廃止した種類の読み替え表。
 *
 * ゲームは自分でコントロールエリア（半径500mの円）とホットゾーン（半径85m）を
 * 決めて画面に出す。手塗りに同じ名前があると、どちらの話か決まらないので
 * 種類ごと廃止した。**ただし既に塗ってある行は消さない。読むときだけ読み替える。**
 *
 *   control → key   「争奪する大事な所」という意図はそのまま「最重要」で読める
 *   hot     → risk  もともと予測として塗ったもの（ゲームの円とは別物）
 *
 * ここでやると **migration を流さなくても盤面に出て、流しても結果が変わらない**。
 * DB の値を書き換える必要が出たときも、この表を消すだけで済む。
 */
const LEGACY_AREA_KINDS = { control: "key", hot: "risk" };

/** エリアも同じ方針。壊れた行は読み飛ばして地図全体を落とさない。 */
function parseAreas(rows) {
  const areas = [];
  for (const row of rows) {
    try {
      const rects = JSON.parse(row.rects);
      if (!Array.isArray(rects) || rects.length === 0) continue;
      areas.push({
        id: row.id,
        kind: LEGACY_AREA_KINDS[row.kind] ?? row.kind,
        op: row.op,
        cell_m: row.cell_m,
        rects,
        created_by: row.created_by,
      });
    } catch {
      continue; // 壊れた行は読み飛ばす
    }
  }
  return areas;
}

// 訪問履歴を1文の upsert で残す。初回は first_seen_at と last_seen_at の両方、
// 2回目以降は last_seen_at だけを更新する。
//
// この関数は盤面を開くたびに必ず通る経路なので、次の2点を守ること。
//   * SELECT してから INSERT/UPDATE に分けない（往復が増える）。
//   * 失敗を握りつぶして呼び出し側に伝えない。履歴は付加機能であって、
//     ここで投げると盤面そのものが開けなくなる。ログにだけ残す。
async function recordVisit(env, sessionId, userId) {
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO session_visits (session_id, user_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, user_id)
       DO UPDATE SET last_seen_at = excluded.last_seen_at`
    ).bind(sessionId, userId, now, now).run();
  } catch (e) {
    console.error("session_visits の記録に失敗しました", e);
  }
}

/**
 * 作戦の公開設定を変える（`{ visibility }`）。
 *
 * **判定は DELETE と同じ**（作成者と admin だけ）。作戦ごとの持ち物についての
 * 操作なので、わざと同じ書き方に揃えてある。片方だけ緩めないこと。
 *
 * 書き込みそのものの可否（`_lib/visibility.js` の `canWrite`）は**ここでは使わない。**
 * 「読専で公開したあと、作成者が非公開に戻す」が通らなくなるため。
 * 公開設定の変更は盤面への書き込みではなく、作戦の持ち主の権限の話。
 *
 * 受けるキーは `visibility` 1つだけ。題名やマップを変える口はまだ無いので、
 * 「書かれたキーだけ更新する」形には**しない**（1つしかないのに分岐を作らない）。
 */
export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;

  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  const session = await env.DB.prepare(
    "SELECT id, created_by FROM sessions WHERE id = ?"
  ).bind(params.id).first();
  if (!session) return json({ error: "見つかりません" }, 404);

  if (session.created_by !== auth.user.id && auth.user.role !== "admin") {
    return json({ error: "他の人の作戦の公開設定は変えられません" }, 403);
  }

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }

  // 3つ以外は 400。**丸めない。** `normalizeVisibility` で private に倒すと、
  // 綴りを間違えた画面が「非公開になった」のに成功を受け取る。
  if (!isVisibility(payload?.visibility)) {
    return json({ error: "公開設定の指定が不正です" }, 400);
  }

  // 公開設定を変えるのも作戦をいじったことなので updated_at を進める。
  // 一覧（公開されている作戦）は updated_at の新しい順なので、公開した直後に
  // 相手の一覧の先頭へ出る。
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("UPDATE sessions SET visibility = ?, updated_at = ? WHERE id = ?")
    .bind(payload.visibility, now, session.id).run();

  return json({ ok: true, id: session.id, visibility: payload.visibility, updated_at: now });
}

// 削除は子テーブルを持つ。1つでも取りこぼすと孤児レコードが残るので、
// env.DB.batch() で一括して原子的に消す（途中失敗でセッションだけ消えて
// ink_strokes が残る、という半端な状態を避ける）。
//
// session_id を持つテーブルを増やしたら、必ずここにも足すこと。
// placements はこの定数が書かれた後に足されたため一覧から漏れていて、
// セッションを消しても配置の行が孤児として残り続けていた。
const CHILD_TABLES = [
  "ink_strokes", "placements", "session_markers", "plan_priorities", "plan_stamps", "events",
  "session_visits", "session_callouts", "session_areas", "session_zone",
];

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;

  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  const session = await env.DB.prepare(
    "SELECT id, created_by FROM sessions WHERE id = ?"
  ).bind(params.id).first();
  if (!session) return json({ error: "見つかりません" }, 404);

  if (session.created_by !== auth.user.id && auth.user.role !== "admin") {
    return json({ error: "他の人の作戦は消せません" }, 403);
  }

  const stmts = CHILD_TABLES.map((table) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE session_id = ?`).bind(session.id)
  );
  stmts.push(env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(session.id));
  await env.DB.batch(stmts);

  return json({ ok: true });
}
