// **課金の不変条件を1枚にまとめた試験。**
//
// 同時接続の上限を 20 → 50 に上げた（オーナー判断。1チーム33人で、ゲームを
// しながら作戦を立てるわけではないので 50 人まで許容する）。
//
// **ここで守っているのは「人数 × 送信頻度 ≤ 200通/秒」の一点だけ。**
// Durable Objects で枠を意味のある量で消費するのは**受信リクエスト 10万/日**で、
// **受信20通が1リクエスト**（調査 §2.4）。つまり 200通/秒 を超えなければ、
// 何人入っても1日の消費は変わらない。
//
//   いまの上限  50人 × 4Hz  = 200通/秒 ＝ 30分で 18,000 req ＝ 1日枠の 18%
//   前の上限    20人 × 10Hz = 200通/秒 ＝ 同じ
//
// **素朴に 50人 × 10Hz にすると 45% まで跳ね上がる。** そうなっていないことを
// ここが固定する。`CURSOR_RATE_TIERS` の表を触る人が、課金の前提を知らずに
// 頻度だけ上げられないようにするのが目的。
//
// 配信（ファンアウト）は課金対象外なので、サーバ側には何も足していない
// （段を決めるのはクライアント。在室一覧で人数を知っている）。
import { describe, expect, it } from "vitest";

import {
  CURSOR_BUDGET_MEASURED_PER_SEC,
  CURSOR_BUDGET_PER_SEC,
  CURSOR_RATE_TIERS,
  CURSOR_SEND_MS,
  cursorSendMs,
  cursorSettleMs,
} from "../public/js/plan/cursors.js";
import { MAX_MEMBERS as CLIENT_MAX_MEMBERS } from "../public/js/plan/presence.js";
import { MAX_MEMBERS as SERVER_MAX_MEMBERS } from "../workers/room/src/presence.js";

/** 実際に飛ぶ頻度。段の `hz` ではなく、**間隔から逆算した値**で確かめる。 */
const actualHz = (members) => 1000 / cursorSendMs(members);

describe("人数 × 送信頻度 ≤ 200通/秒（DO の受信リクエストの枠）", () => {
  it("枠は 200通/秒（20人 × 10Hz のときと同じ量）", () => {
    expect(CURSOR_BUDGET_PER_SEC).toBe(200);
  });

  // **これが本体。** 段の境目だけでなく 1人から上限まで全部見る。
  // 境目だけ見ていると、段を1つ足したときに間の人数が抜ける。
  it("1人から上限まで、どの人数でも枠を超えない", () => {
    for (let n = 1; n <= SERVER_MAX_MEMBERS; n += 1) {
      expect(n * actualHz(n), `${n}人`).toBeLessThanOrEqual(CURSOR_BUDGET_PER_SEC);
    }
  });

  it("表のどの段も、その段の上限人数で枠を超えない", () => {
    for (const tier of CURSOR_RATE_TIERS) {
      expect(tier.members * tier.hz, `${tier.members}人 × ${tier.hz}Hz`)
        .toBeLessThanOrEqual(CURSOR_BUDGET_PER_SEC);
    }
  });

  // 表が在室の上限より手前で終わっていると、最後の段が「それ以上」の受け皿に
  // なる。受け皿の段で枠を超えていないことは上の試験が見ているが、
  // **表のほうを上限に追いつかせておく**（読む人が段を数えれば分かる形にする）。
  it("表の最後の段が在室の上限まで届いている", () => {
    expect(CURSOR_RATE_TIERS.at(-1).members).toBeGreaterThanOrEqual(SERVER_MAX_MEMBERS);
  });

  // **枠は「試算」ではなく「本番で流して確かめた量」までしか上げてはいけない。**
  //
  // 200通/秒 は長いあいだ試算だけの数で、e2e も調査も**毎秒50通までしか
  // 流していなかった**（`e2e/plan-cursors.spec.js` の20接続は意図的にそこで止めてある）。
  // 告知で「50人まで」と書く直前に本番で実測して、初めて裏が付いた
  // （`CURSOR_BUDGET_MEASURED_PER_SEC` のコメントに結果）。
  //
  // ここが守るのは「次に枠を上げる人は、上げた量を本番で流してから上げる」の一点。
  // 試算だけで 500通/秒 に戻すと、このテストが落ちる。
  it("枠は本番で実測済みの量を超えない", () => {
    expect(CURSOR_BUDGET_PER_SEC).toBeLessThanOrEqual(CURSOR_BUDGET_MEASURED_PER_SEC);
  });

  it("人数が増えても頻度は上がらない（段は下るだけ）", () => {
    for (let n = 2; n <= SERVER_MAX_MEMBERS + 10; n += 1) {
      expect(cursorSendMs(n), `${n}人`).toBeGreaterThanOrEqual(cursorSendMs(n - 1));
    }
  });
});

describe("cursorSendMs", () => {
  // オーナーに示した表そのもの。
  //   〜10人  10Hz（いまと同じ）
  //   〜25人   6Hz
  //   〜50人   4Hz
  it("段ごとの間隔", () => {
    expect(cursorSendMs(1)).toBe(100);
    expect(cursorSendMs(10)).toBe(100);
    expect(cursorSendMs(11)).toBe(167);
    expect(cursorSendMs(25)).toBe(167);
    expect(cursorSendMs(26)).toBe(250);
    expect(cursorSendMs(50)).toBe(250);
  });

  it("上限を超える人数が来ても最後の段のまま（頻度を戻さない）", () => {
    expect(cursorSendMs(51)).toBe(250);
    expect(cursorSendMs(1000)).toBe(250);
  });

  // 在室が1通も届いていない間（0人）は、いままでと同じ 10Hz で始める。
  // **壊れた値でも頻度を上げない**のが大事なので、既定は一番速い段ではなく
  // 「表の先頭」である点をはっきりさせておく（先頭が一番速い段なので同じだが、
  // 表を並べ替えたときにここが落ちる）。
  it("在室が分からないうちは先頭の段", () => {
    expect(cursorSendMs(0)).toBe(CURSOR_SEND_MS);
    expect(cursorSendMs(undefined)).toBe(CURSOR_SEND_MS);
    expect(cursorSendMs(NaN)).toBe(CURSOR_SEND_MS);
    expect(cursorSendMs(-5)).toBe(CURSOR_SEND_MS);
  });
});

describe("cursorSettleMs", () => {
  // 止まったあとの1通（../cursors.js の `settler`）は、**間引きの末尾の1通より
  // 後に出なければ意味が無い。** 間隔を 250ms に下げたのに 250ms 固定のままだと
  // 2つが同時に走り、同じ位置を2回送ることになる（1ジェスチャに1通の原則が崩れる）。
  it("送信間隔より必ず長い", () => {
    for (const n of [1, 10, 11, 25, 26, 50, 500]) {
      expect(cursorSettleMs(n), `${n}人`).toBeGreaterThan(cursorSendMs(n));
    }
  });

  it("10人までは今までと同じ 250ms", () => {
    expect(cursorSettleMs(1)).toBe(250);
    expect(cursorSettleMs(10)).toBe(250);
  });
});

describe("在室の上限", () => {
  // サーバ（DO）が断り、クライアントが「満員です（50人まで）」と出す。
  // **数が食い違うと、断られた理由が画面の文言と合わなくなる。**
  // クライアントは DO の定数を import できない（別の Worker で、ブラウザには
  // 配信されない）ので、両方に書いて一致をここで見張る。
  it("クライアントとサーバで同じ値", () => {
    expect(CLIENT_MAX_MEMBERS).toBe(SERVER_MAX_MEMBERS);
  });

  it("50人（1チーム33人 + 見学の余地）", () => {
    expect(SERVER_MAX_MEMBERS).toBe(50);
  });
});
