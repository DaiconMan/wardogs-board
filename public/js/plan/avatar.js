// Discord のアイコン（アバター）を名前の横に出すための小道具。
//
// 仕様: docs/superpowers/specs/2026-10-02-avatar-opt-in.md
//
// **保存は増やしていない。** `users.avatar` は Discord ログインの時点から
// 保存していて（`functions/api/auth/discord/callback.js`）、画面で1箇所も
// 使っていなかっただけ。列もスキーマも足していない。
//
// **運んでいるのは画像ではなく hash（32文字）。** URL に組み立てて初めて
// 画像になる。画像は**ブラウザが Discord の CDN から直接読む**
// （オーナー承認済み。中継しない）。閲覧者の IP が Discord に渡るが、
// 利用者は全員 Discord ユーザーなので許容する。
//
// ── 出せないときは色の丸に戻す ────────────────────────────────
//
// **アイコンに「置き換える」のではなく、色の丸の中身を埋める**
// （D-047 / D-068。色は「ペン＝カーソル＝在室の粒＝引いた線」を結ぶ識別子で、
// アイコンに差し替えるとその結びつきが切れる）。だから出せないときは
// **何もしないだけで色の丸が残る。** 出せないのは3通り:
//
//   1. **ゲスト**（`anon:` の人。D-072）… Discord の数字 ID を持たない
//   2. **`avatar` が NULL**（Discord の既定アイコンの人）
//   3. **画像の読み込みが失敗した**（消された hash / CDN が塞がれた環境）
//
// 1と2を弾くのが `avatarUrl()`、3を覚えておくのが下の2つの集合。

/** 要求する画像の一辺（px）。**3箇所で同じ値を使う**（URL が1本なら取得も1回で済む）。 */
export const AVATAR_SIZE = 64;

/** Discord の ID（雪片）。ゲストの `anon:…` はここで落ちる。 */
const SNOWFLAKE = /^[0-9]{1,20}$/;

/**
 * アバターの hash。32桁の小文字16進で、アニメーションのものは `a_` が付く。
 *
 * **形を見てから URL にする。** ここを緩めると、DB やセッションに入った値が
 * そのままブラウザの `<img src>` になる。
 */
const HASH = /^(a_)?[0-9a-f]{32}$/;

/**
 * アイコンの URL。出せないときは `null`（呼び出し側は色の丸のままにする）。
 */
export function avatarUrl(id, hash, size = AVATAR_SIZE) {
  const uid = String(id ?? "");
  if (!SNOWFLAKE.test(uid)) return null;
  if (typeof hash !== "string" || !HASH.test(hash)) return null;
  return `https://cdn.discordapp.com/avatars/${uid}/${hash}.png?size=${size}`;
}

/** 在室一覧の1人（`{ id, name, color, avatar? }`）から引く。 */
export const memberAvatarUrl = (member, size) => avatarUrl(member?.id, member?.avatar, size);

// 読み込みの結果。**3箇所（在室の粒・カーソル・一覧）で共用する。**
//
// 覚えないと、在室が更新されるたび・カーソルが動くたびに同じ 404 を取りに行き、
// そのたびに「アイコンが出かけて消える」ちらつきになる。読めたほうを覚えるのは、
// **SVG のカーソルを「読めてから」描くため**（下の `whenAvatarReady`）。
const broken = new Set();
const loaded = new Set();
const probing = new Map();

export const avatarBroken = (url) => (url ? broken.has(url) : false);
export const avatarLoaded = (url) => (url ? loaded.has(url) : false);
export const markAvatarBroken = (url) => { if (url) { broken.add(url); loaded.delete(url); } };
export const markAvatarLoaded = (url) => { if (url) loaded.add(url); };

/** 覚えたことを忘れる。テストのためだけにある。 */
export function forgetAvatars() {
  broken.clear();
  loaded.clear();
  probing.clear();
}

/**
 * 色の丸 `host` の中にアイコンを入れる（HTML 側 ＝ 在室の粒と一覧の作成者）。
 *
 * **失敗したら `<img>` ごと消える**ので、残るのは色の丸。
 * `alt` を空にしてあるのは、隣に必ず名前が出ているから（読み上げに同じことを
 * 2回言わせない）。壊れた画像のアイコンも出ない。
 *
 * 入れられなければ何もしない（＝色の丸のまま）。
 */
export function fillAvatar(host, url) {
  if (!host || !url || avatarBroken(url)) return null;
  const img = document.createElement("img");
  img.className = "avatar-img";
  img.alt = "";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.src = url;
  img.addEventListener("load", () => markAvatarLoaded(url), { once: true });
  img.addEventListener("error", () => {
    markAvatarBroken(url);
    img.remove();
  }, { once: true });
  host.appendChild(img);
  return img;
}

/**
 * 読めると分かってから `onReady()` を呼ぶ。**SVG のカーソル用。**
 *
 * **HTML の `<img>` と違って、SVG の `<image>` の `error` は当てにできない**
 * （ブラウザによって飛ばない）。読めない URL を `<image>` に入れると、
 * 色の輪の中身が空いたまま名前だけ右にずれた形で固まる——「壊れた画像を
 * 出さない」が守れない。
 *
 * そこで **HTML の `Image()` で先に1回試して**、読めたものだけ `<image>` にする。
 * 同じ URL は `loaded` / `broken` に覚えるので、2人目以降と在室の粒とで
 * 取得は1回しか起きない（ブラウザのキャッシュにも乗る）。
 *
 * 既に読めていれば**何もしない**（呼び出し側がその場で描ける）。
 */
export function whenAvatarReady(url, onReady) {
  if (!url || avatarBroken(url) || avatarLoaded(url)) return;
  if (probing.has(url)) {
    probing.get(url).push(onReady);
    return;
  }
  const waiting = [onReady];
  probing.set(url, waiting);
  const probe = new Image();
  probe.referrerPolicy = "no-referrer";
  probe.onload = () => {
    markAvatarLoaded(url);
    probing.delete(url);
    for (const fn of waiting) { try { fn(); } catch { /* 1人ぶん描けなかっただけ */ } }
  };
  probe.onerror = () => {
    markAvatarBroken(url);
    probing.delete(url);
  };
  probe.src = url;
}
