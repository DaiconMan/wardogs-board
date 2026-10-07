// Discord のアイコン（アバター）を名前の横に出すための、DOM を触らない部分。
//
// 仕様: docs/superpowers/specs/2026-10-02-avatar-opt-in.md
//
// **ここが守っているのは「出せないときは色の丸に戻る」の入口。**
// 画面の3箇所（在室の粒 / カーソルのラベル / 一覧の作成者）は、
// どれも `avatarUrl()` が `null` を返したら今までどおりの色の丸で描く。
// つまり**ゲストと、アバターが無い人を弾くのはこの1関数**で、
// ここが緩むと `https://cdn.discordapp.com/avatars/anon:…/null.png` のような
// URL が3箇所から同時に飛ぶ。
import { beforeEach, describe, expect, it } from "vitest";

import {
  AVATAR_SIZE,
  avatarBroken,
  avatarLoaded,
  avatarUrl,
  forgetAvatars,
  markAvatarBroken,
  markAvatarLoaded,
  memberAvatarUrl,
} from "../public/js/plan/avatar.js";

const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("avatarUrl", () => {
  it("Discord の CDN の URL を組み立てる（中継しない）", () => {
    expect(avatarUrl("100000000000000001", HASH))
      .toBe(`https://cdn.discordapp.com/avatars/100000000000000001/${HASH}.png?size=${AVATAR_SIZE}`);
  });

  it("アニメーションの hash（a_ 付き）も通す", () => {
    expect(avatarUrl("9001", `a_${HASH}`)).toContain(`/a_${HASH}.png`);
  });

  // **ゲストにはアバターが無い**（D-072）。id が `anon:` で始まるので、
  // Discord の数字 ID かどうかを見るだけで弾ける。
  it("ゲスト（anon: の人）は null", () => {
    expect(avatarUrl("anon:AAAAAAAAAAAAAAAAAAAAAA", HASH)).toBe(null);
  });

  // Discord の既定アイコンの人は `users.avatar` が NULL。
  it("hash が無ければ null", () => {
    for (const hash of [null, undefined, "", 0, {}, "null", "undefined"]) {
      expect(avatarUrl("9001", hash), JSON.stringify(hash)).toBe(null);
    }
  });

  it("hash の形が違えば null（DB に変な値が入っていても URL を作らない）", () => {
    for (const hash of [HASH.slice(0, 31), `${HASH}0`, HASH.toUpperCase(), "../../x", `b_${HASH}`]) {
      expect(avatarUrl("9001", hash), hash).toBe(null);
    }
  });

  it("id が数字でなければ null", () => {
    for (const id of ["", null, "9001/x", "../9001", "nine"]) {
      expect(avatarUrl(id, HASH), JSON.stringify(id)).toBe(null);
    }
  });

  it("size は呼び出し側が選べる", () => {
    expect(avatarUrl("9001", HASH, 16)).toContain("?size=16");
  });
});

describe("memberAvatarUrl", () => {
  it("在室一覧の1人からそのまま引ける", () => {
    expect(memberAvatarUrl({ id: "9001", name: "A", color: 1, avatar: HASH }))
      .toContain(`/9001/${HASH}.png`);
  });

  it("avatar を持たない人（ゲスト・既定アイコン）は null", () => {
    expect(memberAvatarUrl({ id: "9001", name: "A", color: 1 })).toBe(null);
    expect(memberAvatarUrl({ id: "anon:AAAAAAAAAAAAAAAAAAAAAA", name: "G", color: 2 })).toBe(null);
    expect(memberAvatarUrl(null)).toBe(null);
    expect(memberAvatarUrl(undefined)).toBe(null);
  });
});

// **読み込みに失敗した URL を覚えておく。** 覚えないと、在室が更新される
// たび・カーソルが動くたびに同じ 404 を取りに行き、そのたびに
// 「アイコンが出かけて消える」ちらつきになる。
describe("読み込みの結果を覚える", () => {
  beforeEach(() => forgetAvatars());

  it("初めて見る URL はどちらでもない", () => {
    const url = avatarUrl("9001", HASH);
    expect(avatarBroken(url)).toBe(false);
    expect(avatarLoaded(url)).toBe(false);
  });

  it("壊れたと分かった URL は二度と出さない", () => {
    const url = avatarUrl("9001", HASH);
    markAvatarBroken(url);
    expect(avatarBroken(url)).toBe(true);
    expect(avatarLoaded(url)).toBe(false);
  });

  it("読めた URL は覚える（3箇所で共用する）", () => {
    const url = avatarUrl("9001", HASH);
    markAvatarLoaded(url);
    expect(avatarLoaded(url)).toBe(true);
    expect(avatarBroken(url)).toBe(false);
  });

  it("null を覚えない（出せない人を「壊れた」に混ぜない）", () => {
    markAvatarBroken(null);
    markAvatarLoaded(null);
    expect(avatarBroken(null)).toBe(false);
    expect(avatarLoaded(null)).toBe(false);
  });
});
