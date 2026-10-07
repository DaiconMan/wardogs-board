// PlanRoom（Durable Object）の純粋なロジック。
//
// ここは workerd を立てずに確かめられる部分だけを見る。WebSocket の実挙動は
// e2e（e2e/plan-presence.spec.js）と Pages Function 側の統合テスト
// （tests/plan-ws.test.js）が持つ。
import { describe, expect, it } from "vitest";

import {
  MAX_MEMBERS,
  PALETTE_SIZE,
  buildWho,
  colorSeed,
  decodeUser,
  encodeUser,
  guestToEvict,
  pickColor,
  rosterOf,
} from "../workers/room/src/presence.js";

describe("colorSeed", () => {
  it("同じ Discord ID なら常に同じ値になる", () => {
    expect(colorSeed("1234567890")).toBe(colorSeed("1234567890"));
  });

  it("0〜7 に収まる", () => {
    for (const id of ["1", "42", "9001", "100000000000000001", "あ"]) {
      const seed = colorSeed(id);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(PALETTE_SIZE);
    }
  });

  // app.js の pickColor() と同じ式でなければ、接続者一覧の色と
  // 自分のペンの色が食い違う。式を変えるときは両方を同時に変える。
  it("app.js の pickColor と同じ式（(h*31+c) % 8 をループ内で取る）", () => {
    const reference = (id) => {
      let h = 0;
      for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % PALETTE_SIZE;
      return h;
    };
    for (const id of ["9001", "9002", "9003", "100000000000000001"]) {
      expect(colorSeed(id)).toBe(reference(id));
    }
  });
});

describe("pickColor", () => {
  it("空いていれば hash そのままの色になる", () => {
    const id = "9001";
    expect(pickColor(id, [])).toBe(colorSeed(id));
  });

  it("既に同じ人がいればその色を引き継ぐ（再接続で色が変わらない）", () => {
    const id = "9001";
    const seed = colorSeed(id);
    const taken = [{ u: id, c: (seed + 3) % PALETTE_SIZE }];
    expect(pickColor(id, taken)).toBe((seed + 3) % PALETTE_SIZE);
  });

  it("色がぶつかったら空きスロットへずらす", () => {
    const id = "9001";
    const seed = colorSeed(id);
    const taken = [{ u: "other", c: seed }];
    expect(pickColor(id, taken)).toBe((seed + 1) % PALETTE_SIZE);
  });

  it("連続して埋まっていても空きを探す", () => {
    const id = "9001";
    const seed = colorSeed(id);
    const taken = [
      { u: "a", c: seed },
      { u: "b", c: (seed + 1) % PALETTE_SIZE },
      { u: "c", c: (seed + 2) % PALETTE_SIZE },
    ];
    expect(pickColor(id, taken)).toBe((seed + 3) % PALETTE_SIZE);
  });

  it("全色埋まったら hash の色に戻す（名前ラベルで区別する）", () => {
    const id = "9001";
    const seed = colorSeed(id);
    const taken = Array.from({ length: PALETTE_SIZE }, (_, i) => ({ u: `x${i}`, c: i }));
    expect(pickColor(id, taken)).toBe(seed);
  });
});

describe("encodeUser / decodeUser", () => {
  it("往復しても中身が変わらない", () => {
    const user = { id: "9001", name: "タカハシ", role: "member" };
    expect(decodeUser(encodeUser(user))).toEqual(user);
  });

  it("非ASCIIの名前でもヘッダに載る形（ASCIIのみ）になる", () => {
    const encoded = encodeUser({ id: "9001", name: "日本語の名前", role: "member" });
    // eslint-disable-next-line no-control-regex
    expect(/^[A-Za-z0-9_-]+$/.test(encoded)).toBe(true);
  });

  it("壊れた値は null（DO 側で 403 にする）", () => {
    expect(decodeUser("")).toBe(null);
    expect(decodeUser(null)).toBe(null);
    expect(decodeUser("!!!not-base64!!!")).toBe(null);
    expect(decodeUser(encodeUser({ name: "名前だけ" }))).toBe(null);
  });

  it("名前は32文字で切る（session.js の MAX_NAME_LEN と同じ）", () => {
    const long = "あ".repeat(80);
    const back = decodeUser(encodeUser({ id: "9001", name: long, role: "member" }));
    expect(back.name.length).toBe(32);
  });
});

describe("rosterOf", () => {
  it("同じ人が2タブ開いていても1人として数える", () => {
    const roster = rosterOf([
      { u: "9001", n: "A", c: 1 },
      { u: "9001", n: "A", c: 1 },
      { u: "9002", n: "B", c: 2 },
    ]);
    expect(roster.map((m) => m.id)).toEqual(["9001", "9002"]);
  });

  // 渡された順をそのまま保つ（純粋関数として入力を歪めない）。
  // getWebSockets() の順に意味は無いので、表示の並びはクライアントが決める。
  it("渡された配列の順を変えない", () => {
    const roster = rosterOf([
      { u: "9002", n: "B", c: 2 },
      { u: "9001", n: "A", c: 1 },
    ]);
    expect(roster.map((m) => m.id)).toEqual(["9002", "9001"]);
  });

  it("壊れた attachment は無視する", () => {
    const roster = rosterOf([null, undefined, {}, { u: "9001", n: "A", c: 1 }]);
    expect(roster.map((m) => m.id)).toEqual(["9001"]);
  });
});

describe("buildWho", () => {
  it("在室者の一覧を返す", () => {
    const msg = JSON.parse(buildWho([{ u: "9001", n: "A", c: 1 }, { u: "9002", n: "B", c: 2 }]));
    expect(msg.t).toBe("who");
    expect(msg.members).toEqual([
      { id: "9001", name: "A", color: 1 },
      { id: "9002", name: "B", color: 2 },
    ]);
  });

  // **「あなたは誰か」を入れない。** 入れると受信者ごとに別の文字列になり、
  // 20人に配るのに 20回 JSON.stringify することになる（O(N^2)。調査 §5.8 が禁じている）。
  // クライアントは /api/me で自分の Discord ID を知っているので members から自分を引ける。
  it("受信者によらず同じ文字列になる（人数分 stringify しない）", () => {
    const attachments = [{ u: "9001", n: "A", c: 1 }, { u: "9002", n: "B", c: 2 }];
    expect(buildWho(attachments)).toBe(buildWho(attachments));
    expect(JSON.parse(buildWho(attachments))).not.toHaveProperty("me");
  });

  it("誰もいなければ空の一覧", () => {
    expect(JSON.parse(buildWho([]))).toEqual({ t: "who", members: [] });
  });
});

describe("MAX_MEMBERS", () => {
  // D-047 の未決事項をまず 20 で確定させ、のちに 50 へ上げた
  // （オーナー判断: 1チーム33人。ゲームをしながら作戦を立てるわけではないので
  // 50人まで許容する）。**上げても課金の総量は変わらない。** クライアントが
  // 在室の人数に応じて送信頻度を下げ、人数 × 頻度 ≤ 200通/秒 を保つ
  // （`public/js/plan/cursors.js` の `CURSOR_RATE_TIERS`。不変条件を固定して
  // いるのは tests/plan-cursor-budget.test.js）。
  //
  // **ここを上げるときは必ずあちらの表も見ること。** 表が上限に届いていない
  // ことは plan-cursor-budget.test.js が落ちて教える。
  it("50（想定人数の上限）", () => {
    expect(MAX_MEMBERS).toBe(50);
  });
});

// ── ゲスト（ログイン無しで見る人）────────────────────────────────
//
// 仕様: docs/superpowers/specs/2026-10-02-guest-viewers.md
//
// ゲストは**部屋の中にだけ存在する**（D1 に行を作らない）。だから在室と
// カーソルの扱いはログイン済みと同じにするが、**書けない人だと周りに分かる印**を
// 付ける。印が無いと「返事をしない人」に見えて、VC で呼びかけ続けることになる。

describe("encodeUser / decodeUser — ゲストの旗", () => {
  it("guest を往復させられる", () => {
    const user = { id: "anon:AAAAAAAAAAAAAAAAAAAAAA", name: "しずかなカワウソ", guest: true };
    const back = decodeUser(encodeUser(user));
    expect(back.id).toBe(user.id);
    expect(back.name).toBe(user.name);
    expect(back.guest).toBe(true);
  });

  // **ログイン済みの通に `guest` を足さない**（条件8。既存の形を変えない）。
  it("ログイン済みには guest の鍵が出ない", () => {
    const user = { id: "9001", name: "A", role: "member" };
    expect(decodeUser(encodeUser(user))).toEqual(user);
    expect(JSON.parse(atob(encodeUser(user).replace(/-/g, "+").replace(/_/g, "/"))))
      .not.toHaveProperty("guest");
  });

  // ヘッダは Pages Function が組み立てるので外から触れないが、**形が
  // 違えば落とす**という作法はここも同じ（真と偽以外を信じない）。
  it("guest が真でなければ旗は立たない", () => {
    for (const value of ["", 0, null, "false"]) {
      const encoded = btoa(JSON.stringify({ id: "9001", name: "A", guest: value }))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(decodeUser(encoded).guest, JSON.stringify(value)).toBeFalsy();
    }
  });
});

describe("rosterOf / buildWho — ゲストの印", () => {
  it("ゲストには guest: true が付く", () => {
    const roster = rosterOf([
      { u: "9001", n: "A", c: 1 },
      { u: "anon:AAAAAAAAAAAAAAAAAAAAAA", n: "ねむいアナグマ", c: 2, g: 1 },
    ]);
    expect(roster[0].guest, "ログイン済みに印が付いた").toBeUndefined();
    expect(roster[1].guest).toBe(true);
  });

  it("ゲストも人として数える（席は同じ1つ）", () => {
    const roster = rosterOf([
      { u: "anon:AAAAAAAAAAAAAAAAAAAAAA", n: "G", c: 0, g: 1 },
      { u: "anon:AAAAAAAAAAAAAAAAAAAAAA", n: "G", c: 0, g: 1 },
    ]);
    expect(roster.length, "同じゲストの2タブ目を2人に数えた").toBe(1);
  });

  it("ゲストが居なければ通の形は今までどおり", () => {
    const msg = JSON.parse(buildWho([{ u: "9001", n: "A", c: 1 }]));
    expect(msg.members).toEqual([{ id: "9001", name: "A", color: 1 }]);
  });
});

describe("guestToEvict — 満員のときログイン済みを優先する", () => {
  const member = (u) => ({ u, n: u, c: 0 });
  const guest = (u) => ({ u, n: u, c: 0, g: 1 });

  // **これが無いと、URL が漏れた作戦の部屋を塞げる。**
  // ゲストは誰でも何個でも身元を作れるので、席を全部取られるとチームが入れない。
  it("ゲストが居れば、その id を返す", () => {
    expect(guestToEvict([member("9001"), guest("anon:A"), member("9002")])).toBe("anon:A");
  });

  it("いちばん先に見つかったゲスト1人だけを返す", () => {
    expect(guestToEvict([guest("anon:A"), guest("anon:B")])).toBe("anon:A");
  });

  it("ゲストが居なければ null（ログイン済みは押し出さない）", () => {
    expect(guestToEvict([member("9001"), member("9002")])).toBe(null);
    expect(guestToEvict([])).toBe(null);
    expect(guestToEvict(null)).toBe(null);
  });

  it("壊れた attachment と満員の印（u を持たない）は選ばない", () => {
    expect(guestToEvict([null, {}, { full: true }, { g: 1 }])).toBe(null);
    expect(guestToEvict([null, { g: 1 }, guest("anon:A")])).toBe("anon:A");
  });
});

// ── アイコン（アバター）─────────────────────────────────────────
//
// 仕様: docs/superpowers/specs/2026-10-02-avatar-opt-in.md
//
// **運ぶのは画像ではなく hash（32文字）。** 画像はブラウザが Discord の CDN から
// 直接読む。経路は名前・色とまったく同じ
// （ws.js が `encodeUser` → DO の attachment → `buildWho` → クライアント）で、
// **`curs`（10Hz）には1バイトも足さない**（room-cursors.test.js が見張る）。

const AVATAR = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("encodeUser / decodeUser — アイコンの hash", () => {
  it("hash を往復させられる", () => {
    const user = { id: "9001", name: "タカハシ", role: "member", avatar: AVATAR };
    expect(decodeUser(encodeUser(user))).toEqual(user);
  });

  // **アイコンの無い人の通の形を変えない**（ゲストの旗と同じ作法）。
  // 変えると「ログイン済みの挙動は何も変わっていない」が言えなくなる。
  it("hash が無ければ鍵ごと出ない", () => {
    for (const avatar of [null, undefined, ""]) {
      const user = { id: "9001", name: "A", role: "member", avatar };
      expect(decodeUser(encodeUser(user)), JSON.stringify(avatar))
        .toEqual({ id: "9001", name: "A", role: "member" });
      expect(JSON.parse(atob(encodeUser(user).replace(/-/g, "+").replace(/_/g, "/"))))
        .not.toHaveProperty("a");
    }
  });

  it("アニメーションの hash（a_ 付き）も通る", () => {
    expect(decodeUser(encodeUser({ id: "9001", name: "A", avatar: `a_${AVATAR}` })).avatar)
      .toBe(`a_${AVATAR}`);
  });

  // ヘッダは Pages Function が組み立てるので外から触れないが、**形が違えば
  // 落とす**という作法はゲストの旗と同じ。ここを緩めると、作った URL が
  // そのままブラウザの `<img src>` になる。
  it("hash の形が違えば捨てる（URL を組み立てさせない）", () => {
    for (const bad of [AVATAR.slice(0, 31), `${AVATAR}0`, "../../x", 123, true, { a: 1 }]) {
      const encoded = btoa(JSON.stringify({ id: "9001", name: "A", a: bad }))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(decodeUser(encoded).avatar, JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("rosterOf / buildWho — アイコンの hash", () => {
  it("attachment の a が members の avatar として出る", () => {
    const roster = rosterOf([{ u: "9001", n: "A", c: 1, a: AVATAR }]);
    expect(roster[0]).toEqual({ id: "9001", name: "A", color: 1, avatar: AVATAR });
  });

  // アイコンの有無で粒の形が変わらないこと（ゲストとログイン済みが混ざる
  // 一覧で、片方だけ鍵が欠けても画面が壊れない形にしてある）。
  it("アイコンの無い人には鍵が付かない（今までどおりの形）", () => {
    const roster = rosterOf([
      { u: "9001", n: "A", c: 1 },
      { u: "anon:AAAAAAAAAAAAAAAAAAAAAA", n: "G", c: 2, g: 1 },
    ]);
    expect(roster[0]).toEqual({ id: "9001", name: "A", color: 1 });
    expect(roster[1]).toEqual({ id: "anon:AAAAAAAAAAAAAAAAAAAAAA", name: "G", color: 2, guest: true });
  });

  // **1本の文字列を全員に送る形を崩さない**（D-068）。
  it("配る文字列は受信者によらず1本のまま", () => {
    const attachments = [
      { u: "9001", n: "A", c: 1, a: AVATAR },
      { u: "anon:AAAAAAAAAAAAAAAAAAAAAA", n: "G", c: 2, g: 1 },
    ];
    expect(buildWho(attachments)).toBe(buildWho(attachments));
    expect(JSON.parse(buildWho(attachments)).members[0].avatar).toBe(AVATAR);
  });

  it("hash の形が違う attachment は avatar を出さない", () => {
    expect(rosterOf([{ u: "9001", n: "A", c: 1, a: "こわれた" }])[0])
      .toEqual({ id: "9001", name: "A", color: 1 });
  });
});
