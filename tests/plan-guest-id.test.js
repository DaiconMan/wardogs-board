// ゲスト（ログイン無しで見る人）の身元と名前。**サーバを立てずに確かめる単体試験。**
//
// 仕様: docs/superpowers/specs/2026-10-02-guest-viewers.md
//
// ── ここが見張っている3つ ──────────────────────────────────────
//
// 1. **`anon:` の接頭辞が無い値をゲストとして受け入れない。**
//    Discord ID は数字の文字列なので、接頭辞があれば `created_by` と
//    取り違えようがない。接頭辞を見ない実装に戻すと、`"9001"` を送った人が
//    Discord ユーザー 9001 として部屋に入れる（なりすましの入口）。
//
// 2. **名前の生成の式が1箇所にしか無い。**
//    画面とサーバで式が分かれると「一覧では◯◯なのにカーソルは△△」になる
//    （D-047 の色で実際に起きた失敗）。だから `functions/_lib/guest.js` は
//    `public/js/plan/guest.js` を再 export するだけであることを**構造で**確かめる。
//
// 3. **名前に使う語が一般名詞だけ。** ゲームの用語・実在の人名・作品名を
//    入れると権利の問題を自分で作る。語数と重複が無いことも固定する。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  GUEST_ADJECTIVES,
  GUEST_ANIMALS,
  GUEST_PREFIX,
  GUEST_STORAGE_KEY,
  ensureGuestId,
  guestName,
  guestUser,
  isGuestId,
  newGuestId,
} from "../public/js/plan/guest.js";
import * as serverGuest from "../functions/_lib/guest.js";

describe("身元の形（anon: + 22文字）", () => {
  it("newGuestId は毎回ちがう値を返し、どれも isGuestId を通る", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const id = newGuestId();
      expect(isGuestId(id), id).toBe(true);
      expect(id.startsWith(GUEST_PREFIX)).toBe(true);
      // 既存の作戦 id と同じ作法（128bit を base64url。22文字）。
      expect(id.length).toBe(GUEST_PREFIX.length + 22);
      expect(seen.has(id), "乱数が重複した").toBe(false);
      seen.add(id);
    }
  });

  // **これが「なりすましの入口」の見張り。**
  it("接頭辞の無い値・形の違う値は受け付けない", () => {
    const bad = [
      "9001",                            // Discord ID そのもの
      "1234567890123456789",             // 本物に見える Discord ID
      "anon9001",                         // 区切りが無い
      "anon:",                            // 中身が無い
      "anon:short",                       // 短い
      `anon:${"a".repeat(23)}`,           // 長い
      `anon:${"a".repeat(21)}`,           // 1文字足りない
      `anon:${"a".repeat(21)}+`,          // base64url ではない文字
      `anon:${"a".repeat(21)}/`,
      `anon:${"a".repeat(21)}=`,
      ` anon:${"a".repeat(22)}`,          // 前後の空白
      `anon:${"a".repeat(22)} `,
      `ANON:${"a".repeat(22)}`,           // 大文字
      `admin:${"a".repeat(22)}`,
      "", null, undefined, 0, 1, {}, [], true, false,
      `anon:${"a".repeat(22)}\n`,
    ];
    for (const value of bad) {
      expect(isGuestId(value), `${JSON.stringify(value)} を受け入れてしまった`).toBe(false);
    }
  });

  it("guestUser は guest の旗と生成名を付けて返す。形が違えば null", () => {
    const id = newGuestId();
    const user = guestUser(id);
    expect(user).toEqual({ id, name: guestName(id), guest: true });
    expect(guestUser("9001"), "接頭辞が無い値から人を作ってはいけない").toBe(null);
    expect(guestUser(null)).toBe(null);
  });
});

describe("名前（形容詞 ＋ 動物）", () => {
  it("同じ id からは必ず同じ名前（リロードで変わらない）", () => {
    const id = newGuestId();
    const first = guestName(id);
    for (let i = 0; i < 50; i += 1) expect(guestName(id)).toBe(first);
    expect(first.length).toBeGreaterThan(1);
  });

  it("違う id では名前が散る（800通りを使い切っている）", () => {
    const names = new Set();
    for (let i = 0; i < 4000; i += 1) names.add(guestName(newGuestId()));
    // 20 × 40 = 800 通り。4000 回引いて 600 以上出れば、片方の語だけで
    // 決まっている（＝実質 20 通りか 40 通り）という事故は起きていない。
    expect(names.size).toBeGreaterThan(600);
  });

  it("語は形容詞20 × 動物40 で、重複が無い", () => {
    expect(GUEST_ADJECTIVES.length).toBe(20);
    expect(GUEST_ANIMALS.length).toBe(40);
    expect(new Set(GUEST_ADJECTIVES).size).toBe(20);
    expect(new Set(GUEST_ANIMALS).size).toBe(40);
    for (const word of [...GUEST_ADJECTIVES, ...GUEST_ANIMALS]) {
      expect(typeof word).toBe("string");
      expect(word.length).toBeGreaterThan(1);
    }
  });

  // **色を名指しする形容詞を入れない。** 在室の粒とカーソルには別に色が付くので、
  // 「あおいカワウソ」が赤い点で出ると、名前と見た目が食い違う。
  //
  // **部分一致では見ない。**「あかるい」は色ではないのに「あか」を含む
  // （実際にこの試験で引っ掛けた）。色を名指しする語そのものを列挙して照合する。
  it("色を名指しする形容詞が入っていない", () => {
    const colorWords = [
      "あかい", "あおい", "しろい", "くろい", "きいろい", "ちゃいろい",
      "みどりの", "むらさきの", "あかな", "あおな",
    ];
    for (const adj of GUEST_ADJECTIVES) {
      expect(colorWords, `形容詞「${adj}」が色を名指ししている`).not.toContain(adj);
    }
  });

  it("名前は形容詞＋動物の連結そのもの（余計な飾りを付けない）", () => {
    for (let i = 0; i < 100; i += 1) {
      const id = newGuestId();
      const name = guestName(id);
      const adj = GUEST_ADJECTIVES.find((a) => name.startsWith(a));
      expect(adj, `${name} の形容詞が表に無い`).toBeTruthy();
      expect(GUEST_ANIMALS, `${name} の動物が表に無い`).toContain(name.slice(adj.length));
    }
  });

  it("形が違う値から名前を作らない", () => {
    expect(guestName("9001")).toBe("");
    expect(guestName(null)).toBe("");
    expect(guestName("")).toBe("");
  });
});

describe("localStorage（置くのは乱数1つだけ）", () => {
  const fakeStore = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      size: () => map.size,
      keys: () => [...map.keys()],
    };
  };

  it("初回は作って覚える。2回目以降は同じ値（＝同じ名前）", () => {
    const store = fakeStore();
    const first = ensureGuestId(store);
    expect(isGuestId(first)).toBe(true);
    expect(store.getItem(GUEST_STORAGE_KEY)).toBe(first);
    for (let i = 0; i < 10; i += 1) expect(ensureGuestId(store)).toBe(first);
    // **置くのは1つだけ。** 指紋の材料を貯める器にしない。
    expect(store.keys()).toEqual([GUEST_STORAGE_KEY]);
  });

  it("消すと別人になる（仕様の受け入れ条件3の後半）", () => {
    const store = fakeStore();
    const before = ensureGuestId(store);
    store.removeItem(GUEST_STORAGE_KEY);
    const after = ensureGuestId(store);
    expect(after).not.toBe(before);
    expect(guestName(after)).toBeTruthy();
  });

  it("壊れた値が入っていたら作り直す（手で書き換えられたとき）", () => {
    const store = fakeStore();
    store.setItem(GUEST_STORAGE_KEY, "9001");
    const id = ensureGuestId(store);
    expect(isGuestId(id)).toBe(true);
    expect(store.getItem(GUEST_STORAGE_KEY)).toBe(id);
  });

  // プライベートモードや localStorage が塞がれた環境。**投げない。**
  it("localStorage が使えなくても身元は作れる（覚えないだけ）", () => {
    const broken = {
      getItem() { throw new Error("塞がれている"); },
      setItem() { throw new Error("塞がれている"); },
    };
    const id = ensureGuestId(broken);
    expect(isGuestId(id)).toBe(true);
    expect(ensureGuestId(undefined)).toSatisfy(isGuestId);
    expect(ensureGuestId(null)).toSatisfy(isGuestId);
  });
});

describe("式は1箇所だけ（D-047 の色と同じ失敗を繰り返さない）", () => {
  it("functions/_lib/guest.js は public/js/plan/guest.js と同じ関数を指す", () => {
    expect(serverGuest.guestName).toBe(guestName);
    expect(serverGuest.isGuestId).toBe(isGuestId);
    expect(serverGuest.guestUser).toBe(guestUser);
    expect(serverGuest.GUEST_PREFIX).toBe(GUEST_PREFIX);
  });

  // **語の表と式がサーバ側に書き写されていないこと。** 再 export だけなら
  // 語がソースに現れない。片方だけ直せる形に戻した人をここで止める。
  it("サーバ側のファイルに語の表が書き写されていない", () => {
    const src = readFileSync(new URL("../functions/_lib/guest.js", import.meta.url), "utf8");
    for (const word of [GUEST_ADJECTIVES[0], GUEST_ANIMALS[0], GUEST_ANIMALS.at(-1)]) {
      expect(src.includes(word), `語「${word}」がサーバ側にも書かれている`).toBe(false);
    }
  });
});
