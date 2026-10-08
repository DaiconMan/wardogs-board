// 共有カーソル（クライアント側）のうち DOM を触らない部分。
//
// **ここも課金の安全弁を含む。** 送信のスロットルと同値の抑制が消えると、
// クライアントが 10Hz を超えて送り始め、調査 §2.4 の見積もり（20人 × 10Hz で
// 1日枠の18%）が崩れる。サーバ側の `rateHit` は最後の砦であって、
// **普段その砦に当たらないようにしているのがここ。**
//
// 3秒 TTL は切断の取りこぼし対策。消えると「もう居ない人のカーソル」が
// 相手の画面に残り続ける。
import { describe, expect, it, vi } from "vitest";

import {
  CURSOR_SEND_MS,
  CURSOR_SETTLE_MS,
  CURSOR_TTL_MS,
  carryIn,
  carryOf,
  cursorColor,
  othersOnly,
  roundPoint,
  sameCarry,
  samePoint,
  settler,
  staleIds,
  throttle,
} from "../public/js/plan/cursors.js";

describe("roundPoint", () => {
  // マップは最大 16,384m。1m 精度で5桁に収まり、小数を送る意味がない
  // （1px が数メートルの縮尺で見ているので、1m 未満は誰にも見えない）。
  it("メートルを整数にする", () => {
    expect(roundPoint({ x_m: 1234.4, y_m: 5678.6 })).toEqual([1234, 5679]);
  });

  it("負の値も丸める（マップの外にポインタがあるとき）", () => {
    expect(roundPoint({ x_m: -0.4, y_m: -1.6 })).toEqual([-0, -2]);
  });
});

describe("samePoint", () => {
  // **静止しているときに 10Hz で同じ値を送らない。** 枠の節約。
  it("同じ整数なら true", () => {
    expect(samePoint([10, 20], [10, 20])).toBe(true);
  });

  it("片方でも違えば false", () => {
    expect(samePoint([10, 20], [10, 21])).toBe(false);
    expect(samePoint([10, 20], [11, 20])).toBe(false);
  });

  it("どちらかが無ければ false（送る）", () => {
    expect(samePoint(null, [1, 2])).toBe(false);
    expect(samePoint([1, 2], null)).toBe(false);
    expect(samePoint(null, null)).toBe(false);
  });
});

describe("throttle", () => {
  it("既定は 100ms（= 最大 10Hz）", () => {
    expect(CURSOR_SEND_MS).toBe(100);
  });

  it("先頭は即時に通す（動かした瞬間に相手へ出る）", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    throttle(fn, 100)(1);
    expect(fn.mock.calls).toEqual([[1]]);
    vi.useRealTimers();
  });

  it("窓の中の連打は1回にまとめ、**最後の値**を末尾で送る", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(1);                       // 即時
    for (let i = 2; i <= 9; i += 1) { vi.advanceTimersByTime(10); t(i); }
    expect(fn.mock.calls).toEqual([[1]]);
    vi.advanceTimersByTime(100);
    // 途中の値は捨てて、いちばん新しい位置だけを送る（古い位置に意味は無い）。
    expect(fn.mock.calls).toEqual([[1], [9]]);
    vi.useRealTimers();
  });

  it("1回だけ呼んだら末尾の余計な1回は出さない", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    throttle(fn, 100)(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("1秒間ずっと動かしても 10回を超えない（10Hz の上限）", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttle(fn, 100);
    // 60fps のポインタイベントを1秒ぶん
    for (let i = 0; i < 60; i += 1) { t(i); vi.advanceTimersByTime(1000 / 60); }
    vi.advanceTimersByTime(100);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(11);
    vi.useRealTimers();
  });

  it("cancel で末尾の1回を止める（ページを離れるとき）", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    t.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn.mock.calls).toEqual([[1]]);
    vi.useRealTimers();
  });

  // **間隔は関数でも渡せる。** 在室が増えると送信頻度を下げる（`cursorSendMs`）
  // ので、間隔は作ったときには決まらない。数を焼き付けると、人数が変わっても
  // 10Hz で送り続けて課金の枠を外れる（tests/plan-cursor-budget.test.js）。
  it("間隔に関数を渡すと、呼ぶたびに読み直す", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    let gap = 100;
    const t = throttle(fn, () => gap);
    t(1);                        // 即時
    vi.advanceTimersByTime(100);
    t(2);                        // 100ms 経ったので即時
    expect(fn.mock.calls).toEqual([[1], [2]]);
    // ここで間隔を広げる。次の1回は 250ms 待たされる。
    gap = 250;
    vi.advanceTimersByTime(100);
    t(3);
    expect(fn.mock.calls).toEqual([[1], [2]]);
    vi.advanceTimersByTime(150);
    expect(fn.mock.calls).toEqual([[1], [2], [3]]);
    vi.useRealTimers();
  });
});

// **サーバはタイマーを持たない**（ハイバネーションで消えるので持てない。
// workers/room/src/cursors.js のヘッダ）。そのぶん、最後の1通が配信の窓に
// 入らないと最終位置が配られず、相手の画面でカーソルが手前に止まる。
// 止まったあとに1通だけ送り直して確実に追いつかせるのが settler。
describe("settler", () => {
  it("止まってから 250ms で1通（在室10人までのとき）", () => {
    expect(CURSOR_SETTLE_MS).toBe(250);
  });

  // throttle と同じ理由（送信間隔が人数で変わるので、作ったときには決まらない）。
  it("待ち時間に関数を渡すと、呼ぶたびに読み直す", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    let wait = 250;
    const s = settler(fn, () => wait);
    s(1);
    vi.advanceTimersByTime(250);
    expect(fn.mock.calls).toEqual([[1]]);
    wait = 400;
    s(2);
    vi.advanceTimersByTime(250);
    expect(fn.mock.calls).toEqual([[1]]);
    vi.advanceTimersByTime(150);
    expect(fn.mock.calls).toEqual([[1], [2]]);
    vi.useRealTimers();
  });

  it("動いている間は送らない（最後の値だけ1回）", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const s = settler(fn, 250);
    for (let i = 1; i <= 10; i += 1) { s(i); vi.advanceTimersByTime(100); }
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(fn.mock.calls).toEqual([[10]]);
    vi.useRealTimers();
  });

  it("1ジェスチャにつき1通しか増えない（枠に効かない）", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const s = settler(fn, 250);
    for (let i = 0; i < 100; i += 1) { s(i); vi.advanceTimersByTime(10); }
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("cancel で止まる（盤面から出たとき・ページを離れるとき）", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const s = settler(fn, 250);
    s(1);
    s.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("staleIds", () => {
  it("3秒で消す（切断の取りこぼし対策）", () => {
    expect(CURSOR_TTL_MS).toBe(3000);
  });

  it("更新が途絶えた人だけを返す", () => {
    const seen = new Map([["a", 10_000], ["b", 7_001], ["c", 6_999]]);
    expect(staleIds(seen, 10_000).sort()).toEqual(["c"]);
  });

  // 境目は「ちょうど3秒で消える」。10Hz で来ているものを 3,000ms ぴったりで
  // 取りこぼすことは無いので、消える側に倒しておく。
  it("ちょうど 3秒で消える", () => {
    expect(staleIds(new Map([["a", 7_000]]), 10_000)).toEqual(["a"]);
    expect(staleIds(new Map([["a", 7_001]]), 10_000)).toEqual([]);
  });

  it("全員が新しければ空", () => {
    expect(staleIds(new Map([["a", 10_000]]), 10_000)).toEqual([]);
  });

  it("空の表でも落ちない", () => {
    expect(staleIds(new Map(), 10_000)).toEqual([]);
  });
});

describe("othersOnly", () => {
  // 自分のタブのカーソルは描かない（OS のポインタと二重になる）。
  // サーバは送信者を含む全員に同じ文字列を配る（受信者ごとに作ると
  // 20人で 20回 stringify する）ので、外すのはクライアントの仕事。
  //
  // **キーは接続の鍵**（`{"t":"you","k":...}` で接続時に1通だけ渡される）。
  it("自分の接続を外す", () => {
    expect(othersOnly({ aaa: [1, 2, "111"], bbb: [3, 4, "222"] }, "aaa"))
      .toEqual([["bbb", [3, 4, "222"]]]);
  });

  // **これが 2026-10-02 のオーナー報告の本体。**
  // 「ピンは移動したら即時反映されるのですが、マウスカーソルは出ないですね」
  // 人（Discord ID）で外していた頃は、同じ人の2枚目のタブのカーソルも
  // 「自分のもの」として消えていた。2枚開いている人はポインタを2つ持っている。
  it("同じ人の別タブは外さない", () => {
    const cursors = { aaa: [1, 2, "111"], bbb: [3, 4, "111"] };
    expect(othersOnly(cursors, "aaa")).toEqual([["bbb", [3, 4, "111"]]]);
    expect(othersOnly(cursors, "bbb")).toEqual([["aaa", [1, 2, "111"]]]);
  });

  it("自分が入っていなくても落ちない", () => {
    expect(othersOnly({ bbb: [3, 4, "222"] }, "aaa")).toEqual([["bbb", [3, 4, "222"]]]);
  });

  it("鍵を知らない（まだ届いていない）間は全部「他人」に見える", () => {
    // 描く側（board/cursor.js）が null のうちは1本も描かないので、
    // ここで消し込む必要は無い。外さないことだけを決めておく。
    expect(othersOnly({ aaa: [1, 2, "111"] }, null)).toEqual([["aaa", [1, 2, "111"]]]);
  });

  it("空でも落ちない", () => {
    expect(othersOnly({}, "aaa")).toEqual([]);
    expect(othersOnly(null, "aaa")).toEqual([]);
  });
});

describe("cursorColor", () => {
  // **ペンの色と同じ番号**（D-047 の未決事項。サーバの pickColor が決定的に割り当てる）。
  // 一覧の粒（presence.js）と同じ式でなければ「一覧では青なのにカーソルは緑」になる。
  it("0〜7 を --cursor-1〜8 に写す", () => {
    expect(cursorColor(0)).toBe("var(--cursor-1)");
    expect(cursorColor(7)).toBe("var(--cursor-8)");
  });

  it("範囲の外や壊れた値でも 8色のどれかになる", () => {
    expect(cursorColor(8)).toBe("var(--cursor-1)");
    expect(cursorColor(-1)).toBe("var(--cursor-8)");
    expect(cursorColor(undefined)).toBe("var(--cursor-1)");
    expect(cursorColor("3")).toBe("var(--cursor-1)");
  });
});

// ── 運んでいる最中のもの（Phase R2a）──────────────────────────────
//
// **ドラッグ中はすでに `cur` が 10Hz で飛んでいる**ので、そこに相乗りさせる。
// `carryOf` は「いま送る通に何を添えるか」を `state.drag` から決める純粋な関数で、
// ここが null を返す間は R1 とまったく同じ通が飛ぶ（＝通数が増えない）。
describe("carryOf", () => {
  const drag = (over) => ({
    kind: "placement", moved: true, p: { id: 42, x_m: 8000.4, y_m: 4000.6 }, ...over,
  });

  it("配置は \"p\"、座標は整数に丸める", () => {
    expect(carryOf(drag())).toEqual(["p", 42, 8000, 4001]);
  });

  it("地名は \"c\"", () => {
    expect(carryOf(drag({ kind: "callout" }))).toEqual(["c", 42, 8000, 4001]);
  });

  // **1文字増やしただけ。通数は増えていない**（`d` は既に飛んでいる `cur` の項目）。
  // 向きを持つスタンプも始点1組しか載せない（終点は受け取る側が同じだけずらす）。
  it("スタンプは \"s\"（載るのは始点だけ）", () => {
    expect(carryOf(drag({ kind: "stamp" }))).toEqual(["s", 42, 8000, 4001]);
    const vector = { id: 7, x_m: 100, y_m: 200, x2_m: 900, y2_m: 800 };
    expect(carryOf(drag({ kind: "stamp", p: vector })), "終点が通に乗っている")
      .toEqual(["s", 7, 100, 200]);
  });

  // **閾値を超えるまでは「掴んだだけ」。** 押しただけで相手の画面の物を
  // 動かし始めると、選ぶたびに盤面が揺れる。
  it("閾値を超えていなければ null（まだ動かしていない）", () => {
    expect(carryOf(drag({ moved: false }))).toBe(null);
  });

  it("掴んでいなければ null", () => {
    expect(carryOf(null)).toBe(null);
    expect(carryOf(undefined)).toBe(null);
  });

  // 置いた直後（保存の往復が終わる前）は、相手に指し示す id がまだ無い。
  // **送らないのが正しい。** `uid` は手元だけの番号なので相手には通じない。
  it("保存前（id が無い）は null", () => {
    expect(carryOf(drag({ p: { id: null, x_m: 1, y_m: 2 } }))).toBe(null);
  });

  it("知らない種類は null（勝手に1文字を作らない）", () => {
    expect(carryOf(drag({ kind: "stroke" }))).toBe(null);
  });
});

describe("sameCarry", () => {
  // 同じ値を送り直さないため（カーソルの `samePoint` と同じ役目）。
  it("同じ中身なら true", () => {
    expect(sameCarry(["p", 1, 2, 3], ["p", 1, 2, 3])).toBe(true);
  });

  it("どこかが違えば false", () => {
    expect(sameCarry(["p", 1, 2, 3], ["c", 1, 2, 3])).toBe(false);
    expect(sameCarry(["p", 1, 2, 3], ["p", 9, 2, 3])).toBe(false);
    expect(sameCarry(["p", 1, 2, 3], ["p", 1, 2, 4])).toBe(false);
  });

  // **「運ぶのをやめた」は値の変化として扱う。** ここが同値と見なされると、
  // 離した／中断したことが相手に届かず、物が動かされた位置に残る。
  it("片方だけ null なら false", () => {
    expect(sameCarry(null, ["p", 1, 2, 3])).toBe(false);
    expect(sameCarry(["p", 1, 2, 3], null)).toBe(false);
  });

  it("どちらも null なら true（何も運んでいない状態の続き）", () => {
    expect(sameCarry(null, null)).toBe(true);
  });
});

describe("carryIn", () => {
  it("カーソルの値の4つ目を取り出す", () => {
    expect(carryIn([1, 2, "111", ["p", 9, 30, 40]])).toEqual(["p", 9, 30, 40]);
  });

  it("運んでいなければ null", () => {
    expect(carryIn([1, 2, "111"])).toBe(null);
  });

  it("壊れていても落ちない（1通ぶん捨てるだけ）", () => {
    expect(carryIn(null)).toBe(null);
    expect(carryIn([1, 2, "111", "p"])).toBe(null);
    expect(carryIn([1, 2, "111", ["p", 9, 30]])).toBe(null);
    expect(carryIn([1, 2, "111", ["p", "9", 30, 40]])).toBe(null);
    expect(carryIn([1, 2, "111", [1, 9, 30, 40]])).toBe(null);
  });
});
