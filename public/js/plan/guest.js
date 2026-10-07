// ログイン無しで見る人（ゲスト）の身元と名前。**どちらの式もこのファイルだけ。**
//
// EN: Identity and display name for guests -- people looking at a plan without logging
//     in. Both formulas live only here; functions/_lib/guest.js re-exports them and
//     adds the request parsing. Copying them would let the presence list and the
//     cursor label disagree about the same person.
//
// 仕様: docs/superpowers/specs/2026-10-02-guest-viewers.md
//
// インクのコーデック（ink.js）と公開設定（visibility.js）と同じ作法で、
// **サーバと画面が同じ式を使う**。`functions/_lib/guest.js` はここを再 export して、
// リクエストから値を取り出す下請けだけを足す。**式を書き写さないこと。**
// 2箇所に分かれると「在室一覧では しずかなカワウソ なのにカーソルの札は
// ねむいアナグマ」になる（D-047 の色でまったく同じ失敗をしている）。
//
// ── ブラウザの指紋を取らない ────────────────────────────────────
//
// オーナーの原文は「ブラウザ固有の情報を取ってそれに紐づける形で」だが、
// **そうしない。** 理由3つ（仕様の §身元の作り方）:
//
//   1. 直前に個人データを最小化したばかりの方針と逆を向く
//      （UA・画面・canvas を集めると Discord ID より情報が増える）
//   2. 精度が低い。同機種・同ブラウザが衝突し、設定を変えると別人になる
//   3. 端末識別子の扱いは個人情報保護法・ePrivacy のどちらでも面倒な領域
//
// **代わりに、ブラウザ側で乱数を1つ作って localStorage に置くだけ。**
// 既存の作戦 id と同じ 128bit base64url。**こちらは何も「取って」いない。**
// 消せば別人になる。精度は確実。**サーバはこの値を一切保存しない。**
//
// ── この値は「権限」ではなく「札」 ───────────────────────────────
//
// **ゲストの身元は何の権限も与えない。** 誰でも何個でも作れるし、作ったところで
// できるのは「見る」だけ——それは URL を知っている人なら誰でもできること。
// だから秘密として扱う必要が無く、WebSocket のハンドシェイクでは
// クエリに載せてよい（ブラウザの WebSocket はヘッダを足せない）。
// **逆に言うと、ここを根拠に何かを許す実装を足してはいけない。**

/**
 * 身元の接頭辞。**必ず付ける。**
 *
 * Discord ID は数字だけの文字列なので、接頭辞があれば `created_by` や
 * `users.discord_id` と**取り違えようがない。** `anon:` が無い値をゲストとして
 * 受け入れると、`"9001"` を送った人が Discord ユーザー 9001 として部屋に入れる
 * （なりすましの入口）。判定は `isGuestId` 1つに集めてある。
 */
export const GUEST_PREFIX = "anon:";

/** localStorage に置く鍵。**置くのはこの1つだけ**（指紋の材料を貯める器にしない）。 */
export const GUEST_STORAGE_KEY = "wardogs.plan.guest";

/**
 * 身元を載せるヘッダ。**HTTP はこちら。**
 *
 * `api.js` が全ての API 呼び出しに付ける。ログイン済みでも付くが、
 * サーバは Cookie を先に見るので無視される（`_lib/guard.js` の `requireViewer`）。
 */
export const GUEST_HEADER = "x-wb-guest";

/**
 * 身元を載せるクエリ。**WebSocket はこちら。**
 *
 * ブラウザの `new WebSocket()` は**ヘッダを足せない**ので、
 * `/api/sessions/:id/ws` だけはクエリで渡すしかない。
 * クエリに載せて安全なのは、この値が何の権限も与えない札だから（上のヘッダ）。
 *
 * **名前の持ち主をここに置いてサーバと共有する。** 送る側と受ける側で
 * 文字列を書き写すと、片方を直したときに静かに「身元が届かない」になる
 * （＝全員ログイン画面に戻る）。
 */
export const GUEST_QUERY = "guest";

/** 身元の形。接頭辞 ＋ 128bit を base64url にした22文字。 */
const GUEST_ID_RE = /^anon:[A-Za-z0-9_-]{22}$/;

/**
 * 名前に使う形容詞。
 *
 * **一般名詞・一般形容詞だけ。** ゲームの用語・実在の人名・作品名を入れない
 * （権利の問題を自分で作らない）。既存の議論欄の「名無しの◯◯」と同じ気分に揃える。
 *
 * **色の名前を入れない。** 在室の粒とカーソルには別に色が付くので、
 * 「あおいカワウソ」が赤い点で出ると名前と見た目が食い違う
 * （`tests/plan-guest-id.test.js` が見張っている）。
 */
export const GUEST_ADJECTIVES = [
  "しずかな", "ねむい", "はやい", "のんびりな", "あかるい",
  "つよい", "やさしい", "かしこい", "おおきな", "ちいさな",
  "あたらしい", "まるい", "あまい", "つめたい", "あたたかい",
  "かるい", "きまじめな", "ゆかいな", "まぶしい", "しんちょうな",
];

/** 名前に使う動物。**実在の動物の一般名だけ。** */
export const GUEST_ANIMALS = [
  "カワウソ", "アナグマ", "イタチ", "キツネ", "タヌキ",
  "リス", "ウサギ", "ネズミ", "モグラ", "ハリネズミ",
  "シカ", "イノシシ", "クマ", "オオカミ", "ヤマネコ",
  "カピバラ", "ナマケモノ", "アルマジロ", "センザンコウ", "コウモリ",
  "フクロウ", "タカ", "ハト", "スズメ", "カラス",
  "ツバメ", "カモメ", "ペンギン", "アヒル", "ハクチョウ",
  "サギ", "カメ", "トカゲ", "カエル", "イモリ",
  "サンショウウオ", "クジラ", "イルカ", "アザラシ", "ラッコ",
];

/** `anon:` 付きの正しい形か。**ここを通らない値をゲストとして扱わないこと。** */
export const isGuestId = (value) =>
  typeof value === "string" && GUEST_ID_RE.test(value);

/** 新しい身元を1つ作る。作戦 id と同じ 128bit base64url。 */
export function newGuestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${GUEST_PREFIX}${b64}`;
}

/**
 * 文字列から 0〜`mod-1` を決定的に出す。`mul` を変えると別の列になる。
 *
 * `presence.js` の `colorSeed` と同じ素朴な多項式ハッシュ。**暗号ではない**
 * （衝突してよい。800通りのうち重なっても、在室一覧は色と「見るだけ」の印で
 * 区別が付く）。剰余を素数で取ってから割るのは、`mul` の周期が
 * 表の長さと噛み合って片方の語しか動かなくなるのを避けるため。
 */
function pick(text, mul, mod) {
  let h = 0;
  for (const ch of text) h = (h * mul + ch.charCodeAt(0)) % 100003;
  return h % mod;
}

/**
 * 身元から名前を決める。**同じブラウザならいつも同じ名前。**
 *
 * 形が違えば空文字（名前を作らない）。呼び出し側は `isGuestId` を通した値だけを
 * 渡すこと——ここで形を直して名前を返すと、`anon:` の無い値に名前が付く経路ができる。
 */
export function guestName(id) {
  if (!isGuestId(id)) return "";
  const seed = id.slice(GUEST_PREFIX.length);
  return GUEST_ADJECTIVES[pick(seed, 31, GUEST_ADJECTIVES.length)]
    + GUEST_ANIMALS[pick(seed, 131, GUEST_ANIMALS.length)];
}

/**
 * 身元から「人」を作る。形が違えば `null`（＝ゲストとして扱わない）。
 *
 * `guest: true` は**書き込みの門が見る旗**（`visibility.js` の `canWrite`）。
 * `role` は入れない。入れると「`role` を見る分岐」が増えるぶんだけ
 * ゲストに権限が付く余地ができる。
 */
export function guestUser(id) {
  if (!isGuestId(id)) return null;
  return { id, name: guestName(id), guest: true };
}

/**
 * このブラウザの身元を返す（無ければ作って覚える）。
 *
 * **覚えられなくても投げない。** プライベートモードや localStorage が塞がれた
 * 環境では毎回別人になるが、ゲストにできることは「見る」だけなので困らない。
 * 塞がれているからといって見られなくするほうが害が大きい。
 *
 * 入っている値が壊れていたら作り直す（手で書き換えられたとき）。
 */
export function ensureGuestId(store = globalThis.localStorage) {
  let stored = null;
  try {
    stored = store?.getItem(GUEST_STORAGE_KEY) ?? null;
  } catch {
    stored = null; // 読めないだけ。作って返す。
  }
  if (isGuestId(stored)) return stored;

  const id = newGuestId();
  try {
    store?.setItem(GUEST_STORAGE_KEY, id);
  } catch {
    /* 覚えないだけ。次に開くと別人になる */
  }
  return id;
}
