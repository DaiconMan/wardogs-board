// ゲスト（ログイン無しで見る人）の身元を、リクエストから取り出す。
//
// EN: Extracts a guest's identity from the request. The format check and the name
//     generation live only in public/js/plan/guest.js and are re-exported from here.
//
// 仕様: docs/superpowers/specs/2026-10-02-guest-viewers.md
//
// ── 判定と名前の実体はここに無い ─────────────────────────────────
// 形の判定（`isGuestId`）と名前の生成（`guestName`）は
// `public/js/plan/guest.js` に1つだけ置き、ここから再 export する
// （インクのコーデックと公開設定と同じ作法。`_lib/ink.js` / `_lib/visibility.js`）。
// **語の表も式も書き写さないこと。** 書き写すと片方だけ直せる形になり、
// 「一覧では◯◯なのにカーソルの札は△△」が起きる（D-047 の色と同じ失敗）。
// `tests/plan-guest-id.test.js` が、このファイルに語が現れないことまで見ている。
//
// ── サーバはこの値を保存しない ───────────────────────────────────
// `users` にも `session_visits` にもゲストの行を作らない。ゲストは
// **Durable Object の部屋の中にだけ存在する**（在室と同じ寿命）。
// これが「ゲストを入れても安全」の根拠の半分で、**新しく保存する個人データがゼロ**。
// 「ゲストの訪問履歴があると便利」でここを崩すと、この設計の一番の価値が消える。

export * from "../../public/js/plan/guest.js";

import { GUEST_HEADER, GUEST_QUERY, guestUser } from "../../public/js/plan/guest.js";

/**
 * リクエストからゲストの「人」を作る。見つからない／形が違えば `null`。
 *
 * 見る順はヘッダ（`GUEST_HEADER`）→ クエリ（`GUEST_QUERY`）。
 * 両方を受けるのは WebSocket の都合（ブラウザの `new WebSocket()` は
 * ヘッダを足せない）で、**どちらから来ても扱いは同じ**——
 * 権限が無い札なので、経路で差を付ける意味が無い。
 * 形の判定は `isGuestId` の1箇所だけに任せる（`guestUser` が中で呼ぶ）。
 */
export function guestFrom(request) {
  const header = request.headers.get(GUEST_HEADER);
  const fromHeader = guestUser(header);
  if (fromHeader) return fromHeader;
  // ヘッダが無い／形が違うときだけクエリを見る。
  let query = null;
  try {
    query = new URL(request.url).searchParams.get(GUEST_QUERY);
  } catch {
    return null;
  }
  return guestUser(query);
}
