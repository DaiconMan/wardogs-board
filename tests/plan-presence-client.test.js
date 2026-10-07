// 在室一覧のクライアント側（public/js/plan/presence.js）のうち、
// DOM も WebSocket も要らない部分。
//
// **見張っているのは課金事故の防止装置。** 再接続の上限・jitter・アイドル切断は
// 「無限リトライで一晩リクエストを投げ続ける」「タブ放置で実行時間枠を食う」を
// 防ぐためにあり（D-047 / 調査 §2.4・§5.5）、消えても画面上は何も変わらないので
// テストが無いと静かに失われる。
import { describe, expect, it } from "vitest";

import {
  FULL_NOTE,
  IDLE_MS,
  MAX_MEMBERS,
  MAX_RETRIES,
  backoffDelay,
  myColorName,
  shouldIdleDisconnect,
  sortMembers,
  wsUrl,
} from "../public/js/plan/presence.js";

describe("backoffDelay", () => {
  it("段を追うごとに伸びる", () => {
    const mid = (n) => backoffDelay(n, 0.5);
    expect(mid(1)).toBeLessThan(mid(2));
    expect(mid(2)).toBeLessThan(mid(3));
    expect(mid(3)).toBeLessThan(mid(4));
  });

  it("±30% の jitter が乗る（20人が同じ瞬間に繋ぎ直さない）", () => {
    expect(backoffDelay(1, 0)).toBe(350); // 500 * 0.7
    expect(backoffDelay(1, 1)).toBe(650); // 500 * 1.3
    expect(backoffDelay(1, 0.5)).toBe(500);
    expect(backoffDelay(1, 0)).not.toBe(backoffDelay(1, 1));
  });

  it("30秒（+jitter）で頭打ちになる", () => {
    for (const n of [7, 8, 20, 100]) {
      expect(backoffDelay(n, 1)).toBe(39_000); // 30,000 * 1.3
    }
  });

  it("再接続の上限がある（無限リトライにしない）", () => {
    expect(MAX_RETRIES).toBe(10);
    expect(Number.isFinite(MAX_RETRIES)).toBe(true);
  });
});

describe("shouldIdleDisconnect", () => {
  it("既定は10分", () => {
    expect(IDLE_MS).toBe(600_000);
  });

  it("10分経つまでは切らない", () => {
    const now = 1_000_000_000;
    expect(shouldIdleDisconnect(now - (IDLE_MS - 1), now)).toBe(false);
    expect(shouldIdleDisconnect(now, now)).toBe(false);
  });

  it("10分経ったら切る", () => {
    const now = 1_000_000_000;
    expect(shouldIdleDisconnect(now - IDLE_MS, now)).toBe(true);
    expect(shouldIdleDisconnect(now - IDLE_MS * 2, now)).toBe(true);
  });
});

describe("sortMembers", () => {
  it("名前で安定に並ぶ（サーバの順に意味が無いので画面がちらつかない）", () => {
    const a = sortMembers([
      { id: "2", name: "さとう", color: 1 },
      { id: "1", name: "あおき", color: 2 },
    ]);
    expect(a.map((m) => m.name)).toEqual(["あおき", "さとう"]);
    // 同じ入力を順番を変えて渡しても結果が同じ
    const b = sortMembers([
      { id: "1", name: "あおき", color: 2 },
      { id: "2", name: "さとう", color: 1 },
    ]);
    expect(b).toEqual(a);
  });

  it("同名なら ID で決まる", () => {
    const sorted = sortMembers([
      { id: "9", name: "同じ", color: 1 },
      { id: "1", name: "同じ", color: 2 },
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["1", "9"]);
  });

  it("元の配列を壊さない", () => {
    const input = [{ id: "2", name: "B" }, { id: "1", name: "A" }];
    sortMembers(input);
    expect(input.map((m) => m.id)).toEqual(["2", "1"]);
  });

  it("配列でなくても落ちない", () => {
    expect(sortMembers(undefined)).toEqual([]);
    expect(sortMembers(null)).toEqual([]);
  });
});

// **ペンの色とカーソルの色を揃えるためにある**（D-047 の未決事項、D-048 の残件）。
// ずれたままだと「他人の画面では緑のカーソル、自分の画面では青い線」になり、
// インクには名前が無いので**どの線が誰のか分からなくなる**。
describe("myColorName", () => {
  const members = [
    { id: "111", name: "あ", color: 0 },
    { id: "222", name: "い", color: 5 },
  ];

  it("自分の色を CSS の変数名にする（0 始まり → 1 始まり）", () => {
    expect(myColorName(members, "111")).toBe("cursor-1");
    expect(myColorName(members, "222")).toBe("cursor-6");
  });

  it("id は文字列でも数でも引ける", () => {
    // Discord ID は 18 桁の数字。どちらの型で持っていても同じ答えにする。
    expect(myColorName(members, 222)).toBe("cursor-6");
  });

  it("自分が一覧に居なければ null（仮の色のままにする）", () => {
    expect(myColorName(members, "999")).toBe(null);
  });

  it("色が壊れていれば null（無理に変えない）", () => {
    expect(myColorName([{ id: "1", color: null }], "1")).toBe(null);
    expect(myColorName([{ id: "1", color: "3" }], "1")).toBe(null);
  });

  it("範囲の外でも 8色のどれかに収める", () => {
    expect(myColorName([{ id: "1", color: 8 }], "1")).toBe("cursor-1");
    expect(myColorName([{ id: "1", color: -1 }], "1")).toBe("cursor-8");
  });

  it("一覧でなくても落ちない", () => {
    expect(myColorName(undefined, "1")).toBe(null);
    expect(myColorName([null], "1")).toBe(null);
  });
});

describe("wsUrl", () => {
  const at = (protocol, host) => ({ location: { protocol, host } });

  it("http は ws、https は wss", () => {
    expect(wsUrl("abc", at("http:", "127.0.0.1:8832")))
      .toBe("ws://127.0.0.1:8832/api/sessions/abc/ws");
    expect(wsUrl("abc", at("https:", "wardogs-board.pages.dev")))
      .toBe("wss://wardogs-board.pages.dev/api/sessions/abc/ws");
  });

  it("作戦 id をエスケープする", () => {
    expect(wsUrl("a/b?c", at("https:", "h")))
      .toBe("wss://h/api/sessions/a%2Fb%3Fc/ws");
  });

  // **ログイン無しで見る人（ゲスト）の身元はクエリで渡す。**
  // ブラウザの `new WebSocket()` はヘッダを足せないので、HTTP のように
  // `x-wb-guest` を付けられない（public/js/plan/guest.js の `GUEST_QUERY`）。
  it("ゲストの身元をクエリに載せる", () => {
    expect(wsUrl("abc", { guestId: "anon:AAAAAAAAAAAAAAAAAAAAAA", ...at("https:", "h") }))
      .toBe("wss://h/api/sessions/abc/ws?guest=anon%3AAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("ログイン済み（身元なし）ではクエリを付けない", () => {
    for (const guestId of [null, undefined, ""]) {
      expect(wsUrl("abc", { guestId, ...at("https:", "h") }))
        .toBe("wss://h/api/sessions/abc/ws");
    }
  });
});

// 満員で断られたときの文言。**数を文の中に書き込まない。**
// サーバ（workers/room/src/presence.js）が断る人数と画面の数が食い違うと、
// 「満員です（20人まで）」と出ているのに19人しか居ない、が起きる。
// 両方の MAX_MEMBERS が一致していることは tests/plan-cursor-budget.test.js。
describe("FULL_NOTE", () => {
  it("上限の人数をそのまま出す", () => {
    expect(FULL_NOTE).toBe(`満員です（${MAX_MEMBERS}人まで）`);
    expect(FULL_NOTE).toContain(String(MAX_MEMBERS));
  });
});
