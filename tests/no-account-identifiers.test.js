// アカウント固有の識別子と個人情報が、公開するツリーに入っていないことを見張る。
//
// **なぜテストにするのか。** このリポジトリは公開版で、内部の作業リポジトリから
// 中身を持ってきている。内部側には本物の `database_id` や Durable Object の
// 名前空間 ID が入っていて、**そちらをうっかりコピーしてくると気付けない**
// （動くので、テストもレビューも通ってしまう）。目で見張るのは無理なので機械にやらせる。
//
// 見張り方は「禁止文字列の一覧」ではない。**一覧を作ると、その一覧そのものが
// 秘密を書き写したものになる。** そこで**形**で見る。
//
//   1. プレースホルダのままであること（`wrangler.toml` / `tools/do-usage.mjs`）
//   2. UUID や 32桁の16進が、許可した場所の外に現れないこと
//   3. メールアドレスが1件も無いこと
//   4. `.dev.vars` / `.wrangler/` / env ファイルが追跡されていないこと
//
// EN: Guards the public tree against account-specific identifiers and personal
//     information. The contents are lifted from a private working repository that
//     does hold a real D1 `database_id` and a real Durable Object namespace id, and
//     copying one of those across would not break anything — so nothing would catch
//     it. This test therefore checks *shapes*, not a denylist: a denylist would
//     itself be a transcription of the secrets. It asserts the placeholders are
//     still placeholders, that no UUID or 32-hex literal appears outside an explicit
//     allowlist, that no e-mail address appears at all, and that no `.dev.vars`,
//     `.wrangler/` or env file is tracked.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * git が追跡しているテキストファイルの一覧。
 *
 * **`git ls-files` で引く理由。** 走査の対象を「公開されるもの」に正確に合わせたい。
 * `find` だと `node_modules/` や `.wrangler/` や作業中の `.dev.vars` を拾ってしまい、
 * 落ちたときに**本当の漏れなのか手元のゴミなのか分からない**。
 * git が知らないファイルは push されないので、見張る必要も無い。
 */
const trackedFiles = () => {
  const out = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
};

/** バイナリと、依存の固定ファイル（他人のハッシュが大量に入る）は除く。 */
const SKIP = [
  /^package-lock\.json$/,
  /\.(png|jpe?g|webp|gif|ico|woff2?|ttf|zip|pdf)$/i,
];

const textFiles = () => trackedFiles().filter((f) => !SKIP.some((re) => re.test(f)));

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

describe("公開ツリーにアカウント固有の識別子が無い", () => {
  // ── 1. プレースホルダのまま ────────────────────────────────
  //
  // **本物を貼ったら落ちる。** 自分の環境で動かすために貼るのは正しいが、
  // それを**この公開リポジトリへ push し返すのは間違い**。そこで止める。

  it("wrangler.toml の database_id がプレースホルダ", () => {
    expect(read("wrangler.toml"))
      .toMatch(/^database_id = "PUT-YOUR-OWN-DATABASE-ID-HERE"$/m);
  });

  it("wrangler.toml の DISCORD_CLIENT_ID がプレースホルダ", () => {
    expect(read("wrangler.toml"))
      .toMatch(/^DISCORD_CLIENT_ID = "PUT-YOUR-OWN-DISCORD-CLIENT-ID-HERE"$/m);
  });

  it("tools/do-usage.mjs の名前空間 ID がプレースホルダ", () => {
    expect(read("tools/do-usage.mjs")).toMatch(/"PUT-YOUR-OWN-NAMESPACE-ID-HERE"/);
  });

  // ── 2. UUID / 32桁の16進 ───────────────────────────────────
  //
  // Cloudflare の識別子はこの2つの形しかない。
  //   database_id / account_id … UUID（8-4-4-4-12）
  //   DO の名前空間 ID          … 32桁の16進
  //
  // **テストの作り物まで禁止すると使い物にならない**ので、場所で許す。
  // 許可する側を増やすときは、**そこに本物を書かないこと**が条件。

  /** UUID を書いてよいファイル。いまは1件も無い。 */
  const UUID_ALLOW = [];

  /** 32桁の16進を書いてよいファイル（アバターの hash など、テストの作り物）。 */
  const HEX32_ALLOW = [
    /^tests\//,
    /^e2e\//,
  ];

  // **小文字だけを見る。** Cloudflare が返す識別子は小文字の16進で、大文字は来ない。
  // 一方で大文字の UUID には**公開の定数**がある
  // （`tools/ws-min.mjs` の `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` は
  //  RFC 6455 が決めた WebSocket ハンドシェイクの magic GUID で、秘密ではない）。
  // 大文字まで拾うと、ファイル単位で除外する羽目になって網が粗くなる。
  it("UUID の形の文字列が1件も無い", () => {
    const re = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
    const hits = textFiles()
      .filter((f) => !UUID_ALLOW.some((a) => a.test(f)))
      .filter((f) => re.test(read(f)));
    expect(hits, `UUID が入っている: ${hits.join(", ")}`).toEqual([]);
  });

  it("32桁の16進が、許可した場所の外に無い", () => {
    const re = /\b[0-9a-f]{32}\b/;
    const hits = textFiles()
      .filter((f) => !HEX32_ALLOW.some((a) => a.test(f)))
      .filter((f) => re.test(read(f)));
    expect(hits, `32桁の16進が入っている: ${hits.join(", ")}`).toEqual([]);
  });

  // ── 3. メールアドレス ──────────────────────────────────────
  //
  // **1件も要らない。** 連絡先は GitHub の issue で足りる。
  // 「これは公開のアドレスだから」で1件通すと、次の1件を断る理由が無くなる。

  it("メールアドレスが1件も無い", () => {
    const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    const hits = textFiles().filter((f) => re.test(read(f)));
    expect(hits, `メールアドレスが入っている: ${hits.join(", ")}`).toEqual([]);
  });

  // ── 4. 追跡してはいけないファイル ──────────────────────────
  //
  // `.gitignore` に書いてあっても、**一度 `git add -f` された物は追跡が続く。**
  // 無視の設定ではなく、**追跡の実態**を見る。

  it(".dev.vars / .wrangler/ / env ファイルを追跡していない", () => {
    const bad = [/(^|\/)\.dev\.vars$/, /(^|\/)\.wrangler\//, /(^|\/)\.env($|\.)/, /(^|\/)env$/];
    const hits = trackedFiles().filter((f) => bad.some((re) => re.test(f)));
    expect(hits, `追跡してはいけないファイル: ${hits.join(", ")}`).toEqual([]);
  });

  // ── 5. マップ画像 ─────────────────────────────────────────
  //
  // **こちらの著作物ではないので配らない**（THIRD-PARTY-NOTICES.md）。
  // 自分の環境で `public/map/` を置くのは正しいが、**追跡させない。**

  it("public/map/ を追跡していない", () => {
    const hits = trackedFiles().filter((f) => f.startsWith("public/map/"));
    expect(hits.length, `マップ画像が ${hits.length} 件追跡されている`).toBe(0);
  });

  // ── 6. 自分のサイトを指す URL ──────────────────────────────
  //
  // **オーナーの個人ドメインを名乗らない。** whois から氏名に辿れるので、
  // 公開するツリーに1箇所でも残ると**そこから辿られる**。
  // もとは Discord を叩く User-Agent がそれを名乗っていて、
  // **fork した人が他人のホスト名を名乗って Discord にアクセスする**形だった。
  //
  // 見張り方は 1〜5 と同じく**形**で見る。禁止するホスト名を書くと、
  // **このテストそのものがそのホスト名を公開してしまう**ので、逆から書く:
  // **「自分のサイトを指している URL は `*.pages.dev` でなければならない」。**
  //
  // 「自分のサイトを指している」の判定は**ホスト名が `wardogs.` か
  // `wardogs-` で始まること**。外部の出典サイト（`wardogshub.gg` など）は
  // 区切りが無いので引っかからない。

  it("自分のサイトを指す URL は pages.dev だけ", () => {
    const URL_RE = /\bhttps?:\/\/([A-Za-z0-9._-]+)/g;
    const bad = [];
    for (const f of textFiles()) {
      for (const [, host] of read(f).matchAll(URL_RE)) {
        if (!/^wardogs[.-]/.test(host)) continue;
        if (host.endsWith(".pages.dev")) continue;
        bad.push(`${f}: ${host}`);
      }
    }
    expect([...new Set(bad)], `pages.dev 以外のホストを名乗っている: ${bad.join(", ")}`)
      .toEqual([]);
  });

  it("Discord を叩く User-Agent が pages.dev を名乗る", () => {
    // Discord API は Cloudflare の背後にあり UA が必須（callback.js の先頭コメント）。
    // **fork してそのまま動かしても他人を名乗らない**ことが条件。
    const ua = /^const UA = "([^"]+)";$/m
      .exec(read("functions/api/auth/discord/callback.js"));
    expect(ua, "callback.js の UA 定数が見つからない").not.toBeNull();
    expect(ua[1]).toMatch(/\(\+https:\/\/[A-Za-z0-9-]+\.pages\.dev\)$/);
  });
});
