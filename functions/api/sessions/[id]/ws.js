// GET /api/sessions/{id}/ws — リアルタイム（在室一覧）の入口。
//
// **認証はここだけで行う。** 転送先の Durable Object（workers/room の PlanRoom）は
// Cookie を見ない。理由は2つ。
//   1. 認証を2箇所に書くと、片方だけ直したときに静かに緩む。
//      `requireViewer` は D1 の users 表（role / active）まで見るので、DO 側で
//      同じことをやると DO に D1 バインディングが要る（＝DO が状態を持ち始める）。
//   2. DO Worker には公開ルートを持たせない（`workers_dev = false`、ルート未設定）。
//      外から直接叩けないので、検証済みの値をヘッダで渡してよい。
//      **逆に言うと、DO Worker に公開ルートを付けた瞬間に認証が素通りになる。**
//      workers/room/wrangler.toml にルートを足さないこと。
//
// ROOM バインディングが無い環境（vitest の 8811-8814 / 8831）では 503 を返す。
// リアルタイムは上乗せであって前提ではない（調査 §5.3）。ここが 503 でも
// 盤面の読み書きは全部 HTTP で動く。
import { json } from "../../../_lib/validate.js";
import { requireOrigin, requireViewer } from "../../../_lib/guard.js";
import { encodeUser } from "../../../../workers/room/src/presence.js";

export async function onRequestGet(context) {
  const { request, env, params } = context;

  // WebSocket 以外は受けない。ブラウザで URL を直接開いたときに
  // 「何のページだろう」にならないよう、先に落として理由を返す。
  if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return json({ error: "WebSocket 専用の入口です" }, 400);
  }

  // Origin の検証を GET に付けているのは、これが「読み取り」ではなく
  // 部屋への参加（他人の画面に自分の名前が出る）だから。
  // ブラウザは WebSocket のハンドシェイクにも Origin を必ず付ける。
  const bad = requireOrigin(request);
  if (bad) return bad;

  // **ログインしていなくても部屋に入れる**（`requireViewer`）。見るのとカーソルが
  // ゲストにできること全部で、書き込みはここを通らない（HTTP の別ルート）。
  //
  // **ゲストの身元はクエリ（`?guest=anon:...`）で届く。** ブラウザの
  // `new WebSocket()` はヘッダを足せないため（`_lib/guest.js` の `GUEST_QUERY`）。
  // クエリに載せて安全なのは、あの値が何の権限も与えない札だからで、
  // **ここを根拠に何かを許す実装を足さないこと。**
  const auth = await requireViewer(context);
  if (auth.response) return auth.response;

  const session = await env.DB.prepare("SELECT id FROM sessions WHERE id = ?")
    .bind(params.id).first();
  if (!session) return json({ error: "見つかりません" }, 404);

  if (!env.ROOM) {
    return json({ error: "リアルタイム機能は無効です" }, 503);
  }

  // **部屋は作戦ごと。** idFromName に作戦 id を入れるだけで分かれる。
  // 接頭辞を付けてあるのは、後で別の種類の部屋（マップ単位など）を足したときに
  // 名前空間がぶつからないようにするため。
  const stub = env.ROOM.get(env.ROOM.idFromName(`plan:${session.id}`));

  // **元のリクエストを転送しない。** 新しく組み立てることで、クライアントが
  // x-wb-user を偽装して送ってきても DO に届かないことが構造的に保証される。
  //
  // 失敗（wardogs-room が動いていない / DO の無料枠を使い切った）は 503 に落とす。
  // ここで 500 にすると「サイトが壊れた」に見えるが、実際に起きているのは
  // 「上乗せの機能だけが使えない」なので、クライアントが黙って諦められる形にする。
  try {
    return await stub.fetch("https://room.invalid/join", {
      headers: {
        upgrade: "websocket",
        "x-wb-user": encodeUser(auth.user),
        "x-wb-room": session.id,
      },
    });
  } catch (e) {
    console.error("PlanRoom への転送に失敗しました", e);
    return json({ error: "リアルタイム機能に繋がりません" }, 503);
  }
}
