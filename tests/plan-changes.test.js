// 変更通知（誰かが保存したら他の人が再取得する）のスケジューラ。
//
// **DOM も fetch も要らない形に切ってある。** 再取得そのもの（board/reload.js）は
// 盤面を作り直すので DOM が要るが、「いつ走らせるか」の判断はここだけで決まる。
//
// 守っているのは3つ。
//   1. **300ms デバウンス** — しないと「1人が置く → 19人が同時に再取得」で
//      Workers の枠と D1 の行読み取りを無駄に食う（調査 §5.3）
//   2. **操作中は遅らせる** — ドラッグ中・描画中に盤面を作り直すと手元の操作が消える
//   3. **失敗しても黙って諦める** — 再取得が落ちても手元の盤面はそのまま
import { describe, expect, it, vi } from "vitest";

import {
  CHANGE_DEBOUNCE_MS, createChanges, createNotifyGate, notifies,
} from "../public/js/plan/changes.js";

/** 既定の組み立て。`busy` は「いま作り直してはいけないか」。 */
function setup({ busy = () => false, reload = vi.fn(async () => {}) } = {}) {
  return { reload, changes: createChanges({ reload, busy }) };
}

describe("notifies", () => {
  // **api.js の call() に1箇所だけフックする。** call() は全 API の唯一の出口なので、
  // これから足す機能も自動的に通知される。各呼び出し元に書いて回ると必ず書き忘れが出る。
  it("作戦の下の書き込みは通知する", () => {
    expect(notifies("/api/sessions/abc/ink", "POST", true)).toBe(true);
    expect(notifies("/api/sessions/abc/placements?id=3", "PATCH", true)).toBe(true);
    expect(notifies("/api/sessions/abc/placements?id=3", "DELETE", true)).toBe(true);
    expect(notifies("/api/sessions/abc/areas", "POST", true)).toBe(true);
    expect(notifies("/api/sessions/abc/callouts", "POST", true)).toBe(true);
    expect(notifies("/api/sessions/abc/zone", "PUT", true)).toBe(true);
  });

  it("読み取りは通知しない", () => {
    expect(notifies("/api/sessions/abc/placements", "GET", true)).toBe(false);
    expect(notifies("/api/sessions/abc/placements", undefined, true)).toBe(false);
  });

  it("失敗した書き込みは通知しない（何も変わっていない）", () => {
    expect(notifies("/api/sessions/abc/ink", "POST", false)).toBe(false);
  });

  // 作戦そのものの作成・削除は「その部屋の盤面が変わった」ではない。
  // 削除で通知すると、残っている人が 404 になる URL を取りに行く。
  it("作戦そのものの作成・削除は通知しない", () => {
    expect(notifies("/api/sessions", "POST", true)).toBe(false);
    expect(notifies("/api/sessions/abc", "DELETE", true)).toBe(false);
  });

  it("作戦と関係ない API は通知しない", () => {
    expect(notifies("/api/auth/logout", "POST", true)).toBe(false);
    expect(notifies("/api/maps/bakurani/zone-presets", "POST", true)).toBe(false);
  });
});

describe("createChanges", () => {
  it("既定のデバウンスは 300ms", () => {
    expect(CHANGE_DEBOUNCE_MS).toBe(300);
  });

  it("通知から 300ms 後に1回だけ再取得する", async () => {
    vi.useFakeTimers();
    const { reload, changes } = setup();
    changes.notify();
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // 20人が一斉に受け取る通知を束ねるのが目的。
  it("短い間に何通来ても再取得は1回", async () => {
    vi.useFakeTimers();
    const { reload, changes } = setup();
    for (let i = 0; i < 20; i += 1) { changes.notify(); await vi.advanceTimersByTimeAsync(10); }
    await vi.advanceTimersByTimeAsync(300);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("間を空けて来た通知はそれぞれ再取得する", async () => {
    vi.useFakeTimers();
    const { reload, changes } = setup();
    changes.notify();
    await vi.advanceTimersByTimeAsync(400);
    changes.notify();
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  // **手元の操作を消さない。** ドラッグ中に盤面を作り直すと掴んでいたものが消える。
  it("操作中は待って、終わってから1回だけ走る", async () => {
    vi.useFakeTimers();
    let dragging = true;
    const { reload, changes } = setup({ busy: () => dragging });
    changes.notify();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reload).not.toHaveBeenCalled();
    dragging = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("操作中に何通来ても、終わったあとの再取得は1回", async () => {
    vi.useFakeTimers();
    let dragging = true;
    const { reload, changes } = setup({ busy: () => dragging });
    for (let i = 0; i < 10; i += 1) { changes.notify(); await vi.advanceTimersByTimeAsync(100); }
    dragging = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("再取得が失敗しても投げない（手元の盤面はそのまま）", async () => {
    vi.useFakeTimers();
    const reload = vi.fn(async () => { throw new Error("通信できません"); });
    const { changes } = setup({ reload });
    changes.notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(reload).toHaveBeenCalledTimes(1);
    // 失敗したあとでも次の通知は受け付ける
    changes.notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("再取得が走っている間に来た通知は、終わってからもう1回だけ走らせる", async () => {
    vi.useFakeTimers();
    let release;
    const reload = vi.fn(() => new Promise((r) => { release = r; }));
    const { changes } = setup({ reload });
    changes.notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(reload).toHaveBeenCalledTimes(1);
    // 走っている最中に3通
    changes.notify();
    changes.notify();
    changes.notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(reload).toHaveBeenCalledTimes(1);   // まだ重ねない
    release();
    await vi.advanceTimersByTimeAsync(300);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  // ── 「取り直しが来るか」（Phase R2a で足した）────────────────────
  //
  // **他の人が運んでいた物の絵を、いつ本当の座標へ戻すか**を決めるのに要る
  // （board/carry.js）。離した瞬間に戻すと、保存した値が届くまでの数百ミリ秒だけ
  // **元の位置へ跳ね返って見える。** 取り直しが来ると分かっているなら、
  // 戻すのをその着地まで遅らせる（D1 が唯一の真実、は変えない）。
  describe("pending", () => {
    it("何も来ていなければ false", () => {
      expect(setup().changes.pending()).toBe(false);
    });

    it("通知を受けてから取り直しが終わるまで true", async () => {
      vi.useFakeTimers();
      let release;
      const reload = vi.fn(() => new Promise((r) => { release = r; }));
      const { changes } = setup({ reload });
      changes.notify();
      expect(changes.pending()).toBe(true);        // 待っている
      await vi.advanceTimersByTimeAsync(300);
      expect(changes.pending()).toBe(true);        // 走っている
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(changes.pending()).toBe(false);
      vi.useRealTimers();
    });

    it("取り直しが失敗しても false に戻る（永久に預かったままにしない）", async () => {
      vi.useFakeTimers();
      const reload = vi.fn(async () => { throw new Error("通信できません"); });
      const { changes } = setup({ reload });
      changes.notify();
      await vi.advanceTimersByTimeAsync(300);
      expect(changes.pending()).toBe(false);
      vi.useRealTimers();
    });

    it("操作中で保留している間も true", async () => {
      vi.useFakeTimers();
      const { changes } = setup({ busy: () => true });
      changes.notify();
      await vi.advanceTimersByTimeAsync(1000);
      expect(changes.pending()).toBe(true);
      vi.useRealTimers();
    });

    it("stop のあとは false", async () => {
      vi.useFakeTimers();
      const { changes } = setup();
      changes.notify();
      changes.stop();
      expect(changes.pending()).toBe(false);
      vi.useRealTimers();
    });
  });

  it("stop のあとは何も走らない（ページを離れたあと）", async () => {
    vi.useFakeTimers();
    const { reload, changes } = setup();
    changes.notify();
    changes.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reload).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("操作中の待ちも stop で止まる（タイマーを残さない）", async () => {
    vi.useFakeTimers();
    const { reload, changes } = setup({ busy: () => true });
    changes.notify();
    await vi.advanceTimersByTimeAsync(1000);
    changes.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reload).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ── まとめ操作の間だけ通知を束ねる門 ──────────────────────────────
// **これは送る側（自分）の話。** 上の createChanges は受ける側（他の人）の話で、
// あちらのデバウンスは「20人が同じ通知を受けて同時に再取得する」のを束ねる。
//
// 門が要るのは、**まとめて消す・まとめて動かすに専用の API が無い**ため。
// DELETE も PATCH も1件ずつなので、20件消すと api.js の call() を20回通る。
// 素朴に通すと `chg` が20通飛び、相手は20回取り直す。
describe("createNotifyGate", () => {
  it("束ねていないときは、そのたびに送る", () => {
    const send = vi.fn();
    const gate = createNotifyGate(send);
    gate.notify();
    gate.notify();
    expect(send).toHaveBeenCalledTimes(2);
  });

  // 受け入れ条件11の土台。N件でも1回。
  it("まとめ操作の中では溜めて、終わってから1回だけ送る", async () => {
    const send = vi.fn();
    const gate = createNotifyGate(send);
    await gate.batch(() => {
      for (let i = 0; i < 20; i += 1) gate.notify();
      expect(send, "まとめ操作の最中は送らない").not.toHaveBeenCalled();
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("1件も通知が無かったまとめ操作では、何も送らない", async () => {
    const send = vi.fn();
    const gate = createNotifyGate(send);
    await gate.batch(() => {});
    expect(send).not.toHaveBeenCalled();
  });

  // 入れ子を深さで数える。浅い数え方（真偽値1つ）にすると、内側のまとめ操作が
  // 終わった時点で流れてしまい、外側の残りが2通目として飛ぶ。
  it("入れ子でも、いちばん外側が終わるまで送らない", async () => {
    const send = vi.fn();
    const gate = createNotifyGate(send);
    await gate.batch(async () => {
      gate.notify();
      await gate.batch(() => { gate.notify(); });
      expect(send, "内側が終わっただけでは送らない").not.toHaveBeenCalled();
      gate.notify();
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("まとめ操作が投げても、溜めたぶんは送られる（送ってから投げ直す）", async () => {
    const send = vi.fn();
    const gate = createNotifyGate(send);
    await expect(gate.batch(() => {
      gate.notify();
      throw new Error("途中で失敗");
    })).rejects.toThrow("途中で失敗");
    // **1件は消えている**（通った DELETE はサーバに効いている）ので、
    // 知らせないと相手の画面に消えたものが残る。
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("まとめ操作の戻り値をそのまま返す", async () => {
    const gate = createNotifyGate(vi.fn());
    expect(await gate.batch(() => 42)).toBe(42);
  });

  it("次のまとめ操作に前回の溜めを持ち越さない", async () => {
    const send = vi.fn();
    const gate = createNotifyGate(send);
    await gate.batch(() => { gate.notify(); });
    expect(send).toHaveBeenCalledTimes(1);
    await gate.batch(() => {});
    expect(send, "2回目は送るものが無い").toHaveBeenCalledTimes(1);
  });

  // 知らせられなくても、消した・動かしたことそのものは済んでいる。
  it("送る所が投げても、まとめ操作は失敗にしない", async () => {
    const send = vi.fn(() => { throw new Error("WebSocket が切れている"); });
    const gate = createNotifyGate(send);
    await expect(gate.batch(() => { gate.notify(); })).resolves.toBeUndefined();
    gate.notify();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
