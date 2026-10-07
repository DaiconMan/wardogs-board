// 作戦の公開設定。**判定の実体はこの1ファイルだけ。**
//
// EN: Plan visibility. This file is the only implementation of the rule;
//     functions/_lib/visibility.js re-exports it and adds the database lookup. Do not
//     copy the rule -- two copies drift into "the button is enabled but the server
//     answers 403", or worse, "only the server is lax".
//
// 仕様: docs/superpowers/specs/2026-10-02-plan-visibility.md
//
// インクのコーデック（public/js/plan/ink.js）と同じ作法で、**サーバと画面が
// 同じ判定を使う**。`functions/_lib/visibility.js` はここを再 export して、
// DB から行を読む下請け（`loadWritablePlan`）だけを足す。
// **判定をあちらに書き写さないこと。** 2箇所に分かれると、片方だけ直したときに
// 「画面では押せるのにサーバが 403」か、もっと悪い「サーバだけ緩い」が起きる。
//
// ── 3つの状態 ───────────────────────────────────────────────
//
//   private（既定） 一覧に出ない。**URL を知っている人は閲覧も書き込みもできる**
//   public          一覧に出る。閲覧だけ（作成者と admin 以外は書き込めない）
//   public_edit     一覧に出る。閲覧も書き込みもできる
//
// **`private` を「URL を知っていても書き込めない」にしないこと。**
// チームは非公開の作戦の URL を配って共同編集している。そこを締めると、
// 公開設定を足しただけで既存の使い方が壊れる。`public` の読専は
// 「公開したから荒らされたくない」への答えであって、非公開の共同編集を
// 禁じるものではない。
//
// **閲覧はどの状態でも同じ。** ログインしていて URL を知っていれば開ける
// （オーナーの要望「URLを知っている場合はその設定関係なく閲覧可能」）。
// 公開設定が変えるのは「一覧に出るか」と「書き込めるか」の2つだけ。

/** 受け付ける値。**この3つだけ。** API はこれ以外を 400 で弾く。 */
export const VISIBILITIES = ["private", "public", "public_edit"];

export const DEFAULT_VISIBILITY = "private";

/**
 * DB や API から来た値を3つのどれかに丸める。
 *
 * **知らない値・欠落は `private`。** 締まるほうに倒さないのが肝で、
 * 将来値を増やし損ねた日に既存の共同編集が全部 403 になる事故を避ける。
 * `private` は「一覧に出ない・URL を知っていれば書ける」＝従来の挙動なので、
 * 分からないときにここへ倒すのがいちばん害が小さい。
 */
export function normalizeVisibility(raw) {
  return VISIBILITIES.includes(raw) ? raw : DEFAULT_VISIBILITY;
}

/** API が受け取った値として妥当か（`PATCH` の検査用。**丸めない**）。 */
export const isVisibility = (raw) => VISIBILITIES.includes(raw);

/** 一覧（公開されている作戦の群）に出るか。 */
export const isListed = (raw) => normalizeVisibility(raw) !== "private";

/**
 * この人はこの作戦に書き込んでよいか。**書き込みの判定はこの関数1つだけ。**
 *
 * @param {{created_by: string, visibility?: string}} session `sessions` の行
 * @param {{id: string, role?: string, guest?: boolean}} user
 *        サーバなら `auth.user`、画面なら `me.user`
 *
 * 締めるのは `public` のときだけ。`private` と `public_edit` は
 * **ログインしている人なら誰でも書ける**（従来どおり）。
 *
 * **ゲスト（ログイン無しで見る人）はどの状態でも書けない。**
 * `public_edit` の「誰でも書ける」は「ログインしている人なら誰でも」の意味で、
 * 身元の無い人は入らない（仕様 2026-10-02-guest-viewers.md の受け入れ条件4）。
 *
 * **ただしこれは二重の防御。** 第一の防御は、書き込むルートが
 * `requireViewer` ではなく `requireUser` を使うこと（`_lib/guard.js`）。
 * あちらを通ればゲストはここへ届かない。ここで false にしてあるのは、
 * 将来うっかり読み取り側の関数を書き込みルートに使った人を止めるため——
 * 書き込みの判定が1箇所に集まっているなら、最後の砦もそこに置く。
 *
 * 「自分が置いたものだけ動かせる」という所有者判定は**別の層**で、そのまま残る。
 * public_edit でも他人の配置は消せない。
 */
export function canWrite(session, user) {
  if (!session || !user) return false;
  if (user.guest) return false;
  if (normalizeVisibility(session.visibility) !== "public") return true;
  return session.created_by === user.id || user.role === "admin";
}

/**
 * 断る文。**理由を書く。** 「権限がありません」だけだと、書けない原因が
 * 公開設定なのか所有者判定なのか区別できない。サーバの 403 の本文と、
 * 画面の札の説明に同じ文を使う。
 */
export const WRITE_DENIED =
  "この作戦は「見るだけ」で公開されています。書き込めるのは作った人だけです。";

/**
 * ゲスト（ログイン無しで見る人）に出す、書けない理由。
 *
 * **`WRITE_DENIED` と別の文にする。** 書けない理由が「公開設定」なのか
 * 「ログインしていない」なのかで**直し方が違う**ので、同じ文で済ませると
 * 片方の人が何をすればいいか分からなくなる。
 *
 * 文言はオーナーの告知文の1行と揃えてある
 * （「見るだけならログイン不要。書き込むにはDiscordログインが要ります。」）。
 */
export const GUEST_VIEW_ONLY =
  "見ているだけです。書き込むには Discord ログインが要ります。";

/** 畳んだ「自分」のメニューの中に出す、いまの状態。`◯◯ でログイン中` の対。 */
export const GUEST_WHO = "ログインしていません（見るだけ）";

// ── ここから下は画面の文言 ─────────────────────────────────
// サーバもこのファイルを読むが使わない（ink.js の `toSmoothPath` と同じ扱い）。
//
// **状態ではなく結果で書く。** 「public」「限定公開」のような状態の名前では、
// 選んだあと何が起きるかが分からない。

/**
 * 1択の欄（`.choice`）に並べる札。**並び順は「狭い → 広い」。**
 *
 *   value … API に送る値
 *   text  … 札に出す文字（結果で書く）
 *   short … 畳んだボタンに出す値（`.menu-value`）。summary 1語ぶん
 *   note  … 選んだあと何が起きるかを1文で
 */
export const VISIBILITY_CHOICES = [
  {
    value: "private",
    text: "自分とURLを知っている人だけ",
    short: "なし",
    note: "一覧には出ません。URL を渡した人は、これまでどおり一緒に書き込めます。",
  },
  {
    value: "public",
    text: "一覧に出す（見るだけ）",
    short: "見るだけ",
    note: "ログインしている人の一覧に出ます。開いた人は読むだけで、書き込めるのはあなただけです。",
  },
  {
    value: "public_edit",
    text: "一覧に出す（書き込みも許す）",
    short: "書き込みも",
    note: "ログインしている人の一覧に出ます。開いた人は一緒に書き込めます。",
  },
];

const choiceOf = (raw) => {
  const v = normalizeVisibility(raw);
  return VISIBILITY_CHOICES.find((c) => c.value === v);
};

/** 畳んだボタンに出す値。 */
export const visibilityShort = (raw) => choiceOf(raw).short;

/** 選んだあと何が起きるか。 */
export const visibilityNote = (raw) => choiceOf(raw).note;
