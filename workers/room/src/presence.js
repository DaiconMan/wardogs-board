// 在室（presence）の純粋なロジック。
//
// EN: Pure presence logic. No state is kept here, which means vitest can check it
//     without starting workerd, and PlanRoom can get by with "the WebSocket
//     attachment is the only memory" -- no membership table in memory or in storage.
//
// **ここには状態を置かない。** 引数だけで答えが決まる関数の集まりにしてある理由は2つ。
//   1. workerd を立てずに vitest で確かめられる（tests/room-presence.test.js）。
//   2. PlanRoom 側が「WebSocket の attachment が唯一の記憶」で済むようになる。
//      DO はメモリにもストレージにも在室表を持たない（D-047: チャットを作らないので
//      DO は状態を一切持たない純粋な中継役）。ハイバネーションから起き直しても、
//      state.getWebSockets() の attachment を読み直すだけで一覧が復元する。

// 色の数。plan.html の `--cursor-1` 〜 `--cursor-8` に対応する（0 始まりなので +1 して使う）。
export const PALETTE_SIZE = 8;

// 1つの作戦に同時に入れる人数。D-047 の未決事項をまず 20 で確定させ、
// のちに 50 へ上げた（オーナー判断: 1チーム33人。ゲームをしながら作戦を
// 立てるわけではないので 50人まで許容する）。
//
// **上げても DO のリクエスト枠の消費は変わらない。** 枠を決めるのは
// 受信の通数（受信20通 = 1リクエスト。調査 §2.4）で、クライアントが在室の
// 人数に応じて送信頻度を下げ、**人数 × 頻度 ≤ 200通/秒**を保っている
// （`public/js/plan/cursors.js` の `CURSOR_RATE_TIERS`。
// 20人 × 10Hz も 50人 × 4Hz も 200通/秒 ＝ 30分で1日枠の 18%）。
//
// **ここを上げるときは必ずあちらの表も見ること。** 表が上限に届いていない
// ことは `tests/plan-cursor-budget.test.js` が落ちて教える。
// サーバ側は何も変えていない（配信は課金対象外なので、段を決めるのは
// 在室の人数を知っているクライアントの仕事）。
export const MAX_MEMBERS = 50;

// 名前の長さ。functions/_lib/session.js の MAX_NAME_LEN と同じ値にしてある。
const MAX_NAME_LEN = 32;

/**
 * Discord のアバターの hash。32桁の小文字16進で、アニメーションは `a_` 付き。
 *
 * **運ぶのは画像ではなく hash。** URL に組み立てるのはブラウザで、
 * 画像は Discord の CDN から直接読む（こちらは画像を一度も受け取らない）。
 *
 * **形を見てから通す。** ここを緩めた値は、そのままブラウザの `<img src>` に
 * なる。`public/js/plan/avatar.js` の `HASH` と同じ式（片方を変えるなら両方）。
 */
const AVATAR_HASH = /^(a_)?[0-9a-f]{32}$/;
const validAvatar = (v) => (typeof v === "string" && AVATAR_HASH.test(v) ? v : null);

/**
 * Discord ID から色の番号（0〜7）を出す。
 *
 * **式は public/js/plan/app.js の pickColor() と同一でなければならない。**
 * あちらは自分のペンの色（`--me`）を決めていて、こちらは接続者一覧に出る色を決める。
 * 式がずれると「一覧では青なのにペンは緑」になる。片方を変えるときは両方変える
 * （tests/room-presence.test.js がこの一致を見張っている）。
 */
export function colorSeed(discordId) {
  let h = 0;
  for (const ch of String(discordId)) h = (h * 31 + ch.charCodeAt(0)) % PALETTE_SIZE;
  return h;
}

/**
 * 部屋の中で使う色を決める。`taken` は既にいる人の attachment の配列。
 *
 * 決め方の順序（調査 §5.6 の「決定的な割り当て」）:
 *   1. 同じ人が既にいれば、その色を引き継ぐ
 *      → 再接続やタブ2枚目で色が変わらない。ペンの色＝カーソル色なので、
 *        変わると「さっき引いた線」と「これから引く線」の色が違ってしまう
 *   2. hash の色が空いていればそれ
 *   3. 埋まっていれば昇順に空きを探す
 *   4. 8色すべて埋まっていたら hash の色に戻す（色相は重なる。名前ラベルで区別する）
 */
export function pickColor(discordId, taken) {
  const id = String(discordId);
  const list = Array.isArray(taken) ? taken : [];
  const mine = list.find((m) => m && String(m.u) === id);
  if (mine && Number.isInteger(mine.c)) return ((mine.c % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;

  const seed = colorSeed(id);
  const used = new Set(list.filter((m) => m && Number.isInteger(m.c)).map((m) => m.c));
  for (let i = 0; i < PALETTE_SIZE; i += 1) {
    const c = (seed + i) % PALETTE_SIZE;
    if (!used.has(c)) return c;
  }
  return seed;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64urlEncode = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (str) => {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/**
 * 検証済みのユーザーを1つのヘッダ値に詰める。
 *
 * **HTTP ヘッダは ISO-8859-1 しか通らない。** Discord の表示名は日本語がありうるので
 * 生のままヘッダに入れると落ちる。base64url にして ASCII だけにする。
 * これは暗号ではない（署名でもない）。**中身を信用してよいのは、DO Worker が
 * 外から直接叩けない場所に置いてあるからで、値そのものに根拠は無い。**
 */
export function encodeUser(user) {
  const payload = {
    id: String(user?.id ?? ""),
    name: String(user?.name ?? ""),
    role: String(user?.role ?? "member"),
  };
  // **ゲストのときだけ鍵を足す。** 常に入れると、ログイン済みの通の形が
  // 変わる（`tests/room-presence.test.js` が往復で見張っている）。
  // 増やさないほうが「ログイン済みの挙動は何も変わっていない」が言い切れる。
  if (user?.guest === true) payload.guest = true;
  // **アイコンの hash も、持っている人のときだけ。** ゲストと、Discord の
  // 既定アイコンの人には鍵ごと出ない（32文字なので、attachment の
  // 16,384 バイト上限に対しては誤差）。
  const avatar = validAvatar(user?.avatar);
  if (avatar) payload.a = avatar;
  return b64urlEncode(enc.encode(JSON.stringify(payload)));
}

/** encodeUser の逆。形が違えば null（呼び出し側は 403 にする）。 */
export function decodeUser(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const obj = JSON.parse(dec.decode(b64urlDecode(value)));
    if (typeof obj?.id !== "string" || !obj.id) return null;
    if (typeof obj?.name !== "string") return null;
    const user = {
      id: obj.id,
      name: obj.name.slice(0, MAX_NAME_LEN),
      role: typeof obj.role === "string" && obj.role ? obj.role : "member",
    };
    // **真だけを信じる。** `"false"` や 1 を「ゲストである」と読むと、
    // 旗の意味が「真偽」から「それっぽい値」に広がる。
    if (obj.guest === true) user.guest = true;
    // 形が違う hash は**鍵ごと落とす**（旗と同じ作法。それっぽい値を通さない）。
    const avatar = validAvatar(obj.a);
    if (avatar) user.avatar = avatar;
    return user;
  } catch {
    return null;
  }
}

/**
 * 満員のときに押し出すゲストの id。**ゲストが居なければ `null`。**
 *
 * **ゲストは誰でも何個でも身元を作れる。** これが無いと、URL が漏れた作戦の
 * 部屋をゲストで埋めてチームを入れなくできる（仕様の受け入れ条件7）。
 * **満員でログイン済みの人が来たら、ゲストを1人押し出して入れる。**
 *
 * 押し出すのは**いちばん先に見つかった1人**で、`getWebSockets()` の順に従う。
 * この順に意味は無いが（`rosterOf` のコメント）、**誰を押し出すかに意味を
 * 持たせる必要も無い**ので、ここで並べ替えない。「古い人から」にすると
 * 接続時刻を attachment に持つことになり、持たない設計（D-047）を崩す。
 *
 * 返すのは**人の id**（接続の鍵ではない）。席は人の数で数えるので、
 * 1席空けるには**その人の接続を全部**閉じる必要がある（呼び出し側の仕事）。
 *
 * `u` を持たない attachment は選ばない（満員の印が付いた閉じかけの socket と、
 * 壊れた attachment。どちらも在室に数えられていないので押し出す意味が無い）。
 */
export function guestToEvict(attachments) {
  for (const a of Array.isArray(attachments) ? attachments : []) {
    if (a && a.g && typeof a.u === "string" && a.u) return a.u;
  }
  return null;
}

/**
 * attachment の配列を「人」の一覧にする。
 *
 * 同じ人が2タブ開いていても1人。並び順は渡された配列の順をそのまま保つ。
 *
 * **ここで並べ替えないが、この順に意味は無い。** 呼び出し側が渡すのは
 * `state.getWebSockets()` の順で、これは入室順である保証がない（ローカルで実測:
 * 2人目が先に来ることがある）。表示の並びはクライアント側で決める
 * （presence.js の描画が名前＋ID で安定に並べる）。ここを並べ替えないのは
 * 純粋関数として入力を歪めないためで、「入室順に見せる」意図ではない。
 */
export function rosterOf(attachments) {
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(attachments) ? attachments : []) {
    if (!a || typeof a.u !== "string" || !a.u) continue;
    if (seen.has(a.u)) continue;
    seen.add(a.u);
    const member = {
      id: a.u,
      name: typeof a.n === "string" ? a.n : "",
      color: Number.isInteger(a.c) ? a.c : 0,
    };
    // **ゲストと分かる印。** 書き込めない人だと周りに分かるようにする
    // （印が無いと「返事をしない人」に見えて、VC で呼びかけ続けることになる）。
    // **ゲストのときだけ鍵を足す**ので、ゲストが居ない部屋の通は今までと同じ形。
    if (a.g) member.guest = true;
    // **アイコンの hash。名前と色とまったく同じ運び方にしてある**
    // （`curs` には載せない。あちらは 10Hz で流れる。受け取る側は
    // カーソルの所有者 ID でこの一覧を引く）。持っていない人には鍵が付かない。
    const avatar = validAvatar(a.a);
    if (avatar) member.avatar = avatar;
    out.push(member);
  }
  return out;
}

/**
 * 在室の通知（サーバ → クライアント）を1本の文字列にする。
 *
 * **受信者ごとに内容を変えない。** 「あなたは誰か」を入れると 20人に配るのに
 * 20回 stringify することになり、無料プランの CPU 10ms/呼び出しに近づく（調査 §5.8）。
 * クライアントは /api/me で自分の Discord ID を知っているので、members から自分を引ける。
 */
export function buildWho(attachments) {
  return JSON.stringify({ t: "who", members: rosterOf(attachments) });
}
