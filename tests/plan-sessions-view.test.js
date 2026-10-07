// 作戦の一覧（?id= 無しの /plan）に出す時刻の文言。DOM を触らない計算だけ。
//
// 一覧には2つのまとまりがある。
//   自分の作戦          … updated_at を「いつ更新したか」として出す
//   開いたことがある作戦 … last_seen_at を「いつ開いたか」として出す
// 同じ「3分前」でも指しているものが違うので、後者には「開いた」を付ける。
// 「たった今」だけは助詞が付かない（「たった今に開いた」は日本語にならない）。
import { describe, it, expect } from "vitest";

import { seenLabel, timeAgo } from "../public/js/plan/sessions.js";

/** いまを固定して、そこから n 秒前の unix 秒を作る。 */
const NOW = 1_800_000_000;
const ago = (sec) => NOW - sec;

describe("timeAgo", () => {
  it("60秒未満は「たった今」", () => {
    expect(timeAgo(ago(0), NOW)).toBe("たった今");
    expect(timeAgo(ago(59), NOW)).toBe("たった今");
  });

  it("分・時間・日で段を上げる", () => {
    expect(timeAgo(ago(60), NOW)).toBe("1分前");
    expect(timeAgo(ago(3599), NOW)).toBe("59分前");
    expect(timeAgo(ago(3600), NOW)).toBe("1時間前");
    expect(timeAgo(ago(86_399), NOW)).toBe("23時間前");
    expect(timeAgo(ago(86_400), NOW)).toBe("1日前");
    expect(timeAgo(ago(86_400 * 30), NOW)).toBe("30日前");
  });

  it("未来の時刻でも「マイナス3分前」を作らない", () => {
    expect(timeAgo(NOW + 5000, NOW)).toBe("たった今");
  });
});

describe("seenLabel", () => {
  // 「更新」と「開いた」を取り違えると、他人の作戦の行が
  // 「自分が更新した」ように読めてしまう。
  it("いつ開いたかであることを文言で示す", () => {
    expect(seenLabel(ago(60), NOW)).toBe("1分前に開いた");
    expect(seenLabel(ago(86_400 * 3), NOW)).toBe("3日前に開いた");
  });

  it("「たった今」には助詞を付けない", () => {
    expect(seenLabel(ago(3), NOW)).toBe("たった今開いた");
  });
});
