import { json, validText, blockedBy } from "../../_lib/validate.js";
import { requireOrigin, requireUser, requireViewer } from "../../_lib/guard.js";
import { VISIBILITIES } from "../../_lib/visibility.js";

/** 一覧に出る公開設定。**値の持ち主は `_lib/visibility.js` 1箇所。** */
const LISTED = VISIBILITIES.filter((v) => v !== "private");

const TITLE_MAX = 48;

function newSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const bad = requireOrigin(request);
  if (bad) return bad;

  const auth = await requireUser(context);
  if (auth.response) return auth.response;

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "JSONが不正です" }, 400); }

  const title = validText(payload.title, TITLE_MAX);
  if (!title) return json({ error: `題名は1〜${TITLE_MAX}文字です` }, 400);
  if (blockedBy(env, title)) return json({ error: "使えない語が含まれています" }, 400);

  const map = await env.DB.prepare("SELECT id FROM maps WHERE id = ?")
    .bind(String(payload.map_id || "")).first();
  if (!map) return json({ error: "マップの指定が不正です" }, 400);

  // 想定するパターン（コントロールエリアのプリセット）。**任意**。
  // D-046 の「作戦はマップ × パターンの単位で作る」から、作る時点で選べるように
  // してある。ここで受けるのは、作ってから PUT /zone を叩き直す形にすると
  // 「作戦はできたがパターンは付かなかった」という中途半端な状態を作れるため。
  // まだプリセットが1件も無いマップもあるので、省略できることが要件。
  const preset = await loadPreset(env, payload.preset_id, map.id);
  if (preset?.response) return preset.response;

  const now = Math.floor(Date.now() / 1000);
  const id = newSessionId();
  const writes = [
    env.DB.prepare(
      `INSERT INTO sessions (id, map_id, title, patch, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, map.id, title, null, auth.user.id, now, now),
  ];
  if (preset) {
    writes.push(env.DB.prepare(
      `INSERT INTO session_zone (session_id, preset_id, chosen_by, chosen_at)
       VALUES (?, ?, ?, ?)`
    ).bind(id, preset.id, auth.user.id, now));
  }
  await env.DB.batch(writes);

  return json({
    session: {
      id, map_id: map.id, title,
      created_by: auth.user.id, created_at: now,
      zone_preset_id: preset?.id ?? null,
    },
  }, 201);
}

/**
 * 作成時に受け取った `preset_id` を確かめる。
 *
 * 返り値の3通り:
 *   null                  … 指定が無い（パターンを決めずに作る）
 *   { id }                … このマップのプリセット
 *   { response }          … 断る（呼び出し側がそのまま返す）
 *
 * マップ違いを 404 ではなく 400 にしているのは
 * `PUT /api/sessions/{id}/zone` と同じ切り分け。「存在しない」のではなく
 * 「この作戦には合わない」なので、直し方が違う。
 */
async function loadPreset(env, raw, mapId) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return { response: json({ error: "preset_id が不正です" }, 400) };

  const preset = await env.DB.prepare(
    "SELECT id, map_id FROM map_zone_presets WHERE id = ?"
  ).bind(raw).first();
  if (!preset) return { response: json({ error: "見つかりません" }, 404) };
  if (preset.map_id !== mapId) {
    return { response: json({ error: "この作戦のマップのパターンではありません" }, 400) };
  }
  return { id: preset.id };
}

const LIST_LIMIT = 50;

// 訪問履歴の上限も自分の作戦と同じ 50 件にする。
// 試合ごとに作戦が増える使い方なので、上限が無いと一覧が際限なく伸びて
// レスポンスも画面も重くなる。50 は「自分の作戦一覧と同じ長さ」に揃えた値で、
// 1画面で選ぶ道具としてはこれ以上並べても使われない。
// 溢れた分は共有URLからもう一度開けば履歴の先頭に戻ってくるので、失われない。
const VISITED_LIMIT = 50;

// 一覧の行が「どのマップの、どのパターン向けか」を名乗るための列（D-046）。
// マップ名はもともと返していたので、足りていなかったのはパターンのほう。
//
// **並べ替えは画面側でやる**ので、順序の材料（`sort_order`）まで返す。
// SQL で並べ切らないのは、パターン未設定の作戦を「マップの中の末尾」に置きたく、
// それを ORDER BY で書くと NULL の扱いがマップごとに絡んで読めなくなるため。
// 総数は 9〜12 件で頭打ちなので（D-046）、この件数の並べ替えは画面側で足りる。
//
// どちらも LEFT JOIN。**パターン未設定の作戦を一覧から落とさない**ことが要。
// 既存の作戦は全部未設定なので、INNER にすると一覧が空になる。
//
// 作成者の `avatar`（アイコンの hash）も、既にある `LEFT JOIN users` から
// 1列足すだけで取れる。**保存は増やしていない**——`users.avatar` は Discord
// ログインの時点から入っていて、画面で1箇所も使っていなかっただけ。
// 返すのは hash で、画像でも URL でもない（組み立てるのはブラウザ。
// `public/js/plan/avatar.js`）。
const ZONE_COLUMNS = `z.preset_id AS zone_preset_id,
              p.key  AS zone_key,
              p.name AS zone_name,
              p.sort_order AS zone_sort`;
const ZONE_JOIN = `LEFT JOIN session_zone z ON z.session_id = s.id
         LEFT JOIN map_zone_presets p ON p.id = z.preset_id`;

// /plan?id= を失うと二度とたどり着けない問題への対応。
//
//   sessions … 自分が created_by の作戦。更新の新しい順。
//   visited  … 共有URLなどで開いた「他人の」作戦。最後に開いた新しい順。
//   public   … **公開されている他人の作戦**（`visibility` が public / public_edit）。
//              更新の新しい順。
//
// 3つを混ぜないのは、UI が「自分の」「開いたことがある」「公開されている」を
// 区別して出せる必要があるため。visited と public から自分の作戦を除くのは
// sessions と重複するため。
//
// **visited と public は互いに除かない。** 「公開されている」という事実自体が
// 情報（＝他の人も見ている前提で書ける）なので、一度開いた公開作戦は両方に出る。
// 画面側で重複を避けるかは実装者の判断（いまは pages/list.js が訪問済みを
// 公開の節から落としている）。
//
// 返すのは本人の訪問履歴だけ。作成者に「誰が見たか」を返す経路は作らない
// （schema.sql の session_visits に書いたプライバシー方針）。public に出る
// 他人の名前は作成者の表示名だけで、**公開するという操作はそれを見せることを
// 含んでいる**（誰の作戦か分からない行は開けない）。
// ゲスト（ログイン無しで見る人）にも**公開されている作戦の節だけ**返す。
// 「公開」とはそういう意味で、ここを閉じると /plan に来たログイン無しの人が
// 辿れる作戦が1件も無くなる（URL を直接渡された場合しか入口が無い）。
//
// **「自分の」と「開いたことがある」は返さない。**
// どちらも保存された身元を引く節で、ゲストには保存された身元が無い
// （`users` にも `session_visits` にも行が無い＝引くものが無い）。
// 空配列を返すのは、画面が3つの節の形を知っているから——キーを落とすと
// `pages/list.js` が `undefined.map` で落ちる。
export async function onRequestGet(context) {
  const auth = await requireViewer(context);
  if (auth.response) return auth.response;

  const { env } = context;
  if (auth.user.guest) return json({ sessions: [], visited: [], public: await listedFor(env, null) });

  const [mine, visited, shared] = await env.DB.batch([
    env.DB.prepare(
      `SELECT s.id, s.map_id, s.title, s.created_at, s.updated_at, s.visibility,
              m.name AS map_name,
              ${ZONE_COLUMNS}
         FROM sessions s
         JOIN maps m ON m.id = s.map_id
         ${ZONE_JOIN}
        WHERE s.created_by = ?
        ORDER BY s.updated_at DESC
        LIMIT ?`
    ).bind(auth.user.id, LIST_LIMIT),
    // sessions と JOIN するので、消し損ねた孤児の訪問記録は自然に落ちる。
    // users は LEFT JOIN。作成者の行が消えていても作戦自体は一覧から消さない。
    env.DB.prepare(
      `SELECT s.id, s.map_id, s.title, s.created_at, s.updated_at,
              m.name AS map_name, s.created_by, s.visibility,
              COALESCE(u.global_name, u.username) AS created_by_name,
              u.avatar AS created_by_avatar,
              v.first_seen_at, v.last_seen_at,
              ${ZONE_COLUMNS}
         FROM session_visits v
         JOIN sessions s ON s.id = v.session_id
         JOIN maps m ON m.id = s.map_id
         ${ZONE_JOIN}
         LEFT JOIN users u ON u.discord_id = s.created_by
        WHERE v.user_id = ? AND s.created_by <> ?
        ORDER BY v.last_seen_at DESC
        LIMIT ?`
    ).bind(auth.user.id, auth.user.id, VISITED_LIMIT),
    listedStatement(env, auth.user.id),
  ]);

  return json({
    sessions: mine.results,
    visited: visited.results,
    public: shared.results,
  });
}

/**
 * 「公開されている作戦」の1文。**ログイン済みとゲストで同じ SQL を使う。**
 *
 * 書き写して2つにすると、片方だけに条件を足した日に「ログイン済みには
 * 出ないのにゲストには出る作戦」ができる。**公開の範囲が身元で変わってはいけない。**
 *
 * `exclude` は一覧から外す作成者（自分の作戦は `sessions` の節と重複するので外す）。
 * ゲストには外す相手が無いので `null` を渡す——`created_by <> NULL` は
 * SQLite で常に NULL（＝1行も通らない）になるため、**条件ごと落とす**。
 *
 * 公開設定の値は `_lib/visibility.js` から来た `LISTED` だけを使う
 * （SQL に 'public' と直書きしない）。
 */
function listedStatement(env, exclude) {
  const placeholders = LISTED.map(() => "?").join(", ");
  const sql = `SELECT s.id, s.map_id, s.title, s.created_at, s.updated_at,
              m.name AS map_name, s.created_by, s.visibility,
              COALESCE(u.global_name, u.username) AS created_by_name,
              u.avatar AS created_by_avatar,
              ${ZONE_COLUMNS}
         FROM sessions s
         JOIN maps m ON m.id = s.map_id
         ${ZONE_JOIN}
         LEFT JOIN users u ON u.discord_id = s.created_by
        WHERE s.visibility IN (${placeholders})
          ${exclude === null ? "" : "AND s.created_by <> ?"}
        ORDER BY s.updated_at DESC
        LIMIT ?`;
  const binds = exclude === null
    ? [...LISTED, LIST_LIMIT]
    : [...LISTED, exclude, LIST_LIMIT];
  return env.DB.prepare(sql).bind(...binds);
}

/** ゲスト向け。節が1つしか無いので batch にしない。 */
async function listedFor(env, exclude) {
  const { results } = await listedStatement(env, exclude).all();
  return results;
}
