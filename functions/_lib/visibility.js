// 作戦の公開設定の判定と、**書き込む前に作戦の行を取る下請け。**
//
// EN: Plan visibility checks, plus the helper that loads the plan row before a write.
//     The rule itself lives in public/js/plan/visibility.js and is re-exported here.
//
// 仕様: docs/superpowers/specs/2026-10-02-plan-visibility.md
//
// ── 判定の実体はここに無い ───────────────────────────────────
// `canWrite` / `normalizeVisibility` / 3つの値は `public/js/plan/visibility.js`
// に1つだけ置き、ここから再 export する（インクのコーデックと同じ作法。
// `functions/_lib/ink.js` を参照）。**判定を書き写さないこと。**
// 2箇所に分かれると、片方だけ直したときに「画面では押せるのにサーバが 403」か、
// もっと悪い「サーバだけ緩い」が起きる。
//
// ── なぜ「行を読む」と「判定する」を同じ関数にするか ─────────────
// 書き込む経路は placements / ink / areas / callouts / zone の5つ（メソッドで
// 数えると10本以上）ある。各ルートに条件を書いて回ると、**1つ書き忘れた経路から
// だけ書き込める穴が残り、気づかれないまま残る。**
//
// だから作戦の行を手に入れる唯一の口をこの2関数にして、**書き込むルートは
// ここを通らないと作戦の行を持てない**形にする。新しい書き込み口を足す人は
// 必ず `loadWritablePlan` か `loadWritableSession` を呼ぶことになる。
//
// `tests/plan-visibility.test.js` が5経路を総当たりで見張っている。

export * from "../../public/js/plan/visibility.js";

import { canWrite, WRITE_DENIED } from "../../public/js/plan/visibility.js";
import { json } from "./validate.js";

const notFound = () => json({ error: "見つかりません" }, 404);

/**
 * 書き込む前に作戦の行を取り、公開設定で断るかを決める。
 *
 * 戻り値は `{ session }` か `{ response }`。呼び出し側は
 * `if (loaded.response) return loaded.response;` だけ書く（`requireUser` と同じ作法）。
 *
 * **404（存在しない）を 403 より先に返す。** 順序を逆にすると、読専の作戦に
 * 向けた当て推量の id が「403 ＝ その id は在る」として漏れる。
 */
export async function loadWritableSession(env, sessionId, user) {
  const session = await env.DB.prepare(
    "SELECT id, map_id, created_by, visibility FROM sessions WHERE id = ?"
  ).bind(sessionId).first();
  if (!session) return { response: notFound() };
  if (!canWrite(session, user)) return { response: json({ error: WRITE_DENIED }, 403) };
  return { session };
}

/**
 * 同じことを、座標の検証に要るマップの行まで添えて行う。
 *
 * 各ルートが持っていた `loadPlan()` の置き換え。**マップの行が無ければ 404。**
 * 範囲の検証ができない状態で座標を受けると、マップの外の点が静かに保存される。
 */
export async function loadWritablePlan(env, sessionId, user) {
  const loaded = await loadWritableSession(env, sessionId, user);
  if (loaded.response) return loaded;
  const map = await env.DB.prepare(
    "SELECT width_m, height_m FROM maps WHERE id = ?"
  ).bind(loaded.session.map_id).first();
  if (!map) return { response: notFound() };
  return { session: loaded.session, map };
}
