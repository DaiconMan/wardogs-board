// 共有カーソル（DO 側）の純粋なロジック。
//
// **見張っているのは課金の安全弁。** Phase R1 は同じ WebSocket に 10Hz の送信を
// 足すので、壊れると「請求」ではなく「1日枠を数分で溶かして全員のリアルタイムが
// 死ぬ」形で効く（調査 §2.4 / §2.5）。安全弁は2つある。
//
//   1. **ティッカーの継続判定** — 誰も動かしていない間はタイマーが1本も
//      残っていない状態に戻ること。`setInterval` / `setAlarm` を使うと
//      「タブ1枚で1日枠の83%」を踏む（調査 §2.4 の実例）
//   2. **レート超過の判定** — 受信は到達した時点で課金されるので、無視しても
//      枠は減る。止める方法は閉じることだけ
//
// どちらも画面には何も出ないので、テストが無いと静かに失われる。
// **e2e では確かめられない**（静止2分を Playwright で待てない）ので、ここで押さえる。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BROADCAST_GAP_MS,
  CHANGED,
  MAX_COORD,
  MAX_INK_POINTS,
  MAX_MESSAGE_LEN,
  RATE_MAX,
  RATE_WINDOW_MS,
  buildCursors,
  buildYou,
  connKey,
  cursorEntry,
  cursorSnapshot,
  dueToSend,
  parseCarry,
  parseCursor,
  parseInk,
  rateHit,
} from "../workers/room/src/cursors.js";

const ROOM_SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), "workers", "room", "src");

describe("parseCursor", () => {
  it("整数の座標をそのまま受ける", () => {
    expect(parseCursor({ t: "cur", x: 1234, y: 5678 })).toEqual([1234, 5678]);
  });

  it("原点を「座標なし」と取り違えない", () => {
    // 0 は falsy なので、素朴に書くと盤面の左上隅だけカーソルが消える。
    expect(parseCursor({ t: "cur", x: 0, y: 0 })).toEqual([0, 0]);
  });

  it("小数は丸める（1m 未満は誰にも見えない）", () => {
    expect(parseCursor({ t: "cur", x: 10.7, y: -3.2 })).toEqual([11, -3]);
  });

  it("座標が無ければ null（盤面から出た＝消してほしい）", () => {
    expect(parseCursor({ t: "cur" })).toBe(null);
  });

  it("数でなければ null", () => {
    expect(parseCursor({ t: "cur", x: "10", y: 20 })).toBe(null);
    expect(parseCursor({ t: "cur", x: null, y: 20 })).toBe(null);
    expect(parseCursor({ t: "cur", x: 10 })).toBe(null);
  });

  it("NaN / Infinity は null", () => {
    expect(parseCursor({ t: "cur", x: NaN, y: 0 })).toBe(null);
    expect(parseCursor({ t: "cur", x: Infinity, y: 0 })).toBe(null);
  });

  it("桁が異常な値は null（マップは最大 16,384m）", () => {
    expect(parseCursor({ t: "cur", x: MAX_COORD + 1, y: 0 })).toBe(null);
    expect(parseCursor({ t: "cur", x: 0, y: -MAX_COORD - 1 })).toBe(null);
    expect(parseCursor({ t: "cur", x: MAX_COORD, y: MAX_COORD })).toEqual([MAX_COORD, MAX_COORD]);
  });

  it("オブジェクトでなくても落ちない", () => {
    expect(parseCursor(null)).toBe(null);
    expect(parseCursor("cur")).toBe(null);
  });
});

// ── 運んでいる最中のもの（Phase R2a）──────────────────────────────
//
// **新しい種類の通を作らない。** ドラッグ中はすでに `cur` が 10Hz で飛んでいるので、
// そこに `d` を相乗りさせる（仕様 2026-10-02-r2-live-drag.md）。通数が増えないことが
// 課金の試算（調査 §2.4 の 18%）を守る唯一の条件なので、`d` は**省略可の項目**で
// あって、別の通にはしない。
//
// **DO は `d[0]` が何を指すのかを知らない。** "p" が配置で "c" が地名だと知ると、
// 盤面の形を知ることになる（`chg` に中身を載せないのと同じ理由）。1文字の英小文字
// という形だけを見るので、線やエリアを足すときに DO を直す必要がない。
describe("parseCarry", () => {
  it("種別・id・座標をそのまま受ける", () => {
    expect(parseCarry({ t: "cur", x: 1, y: 2, d: ["p", 123456, 8000, 4000] }))
      .toEqual(["p", 123456, 8000, 4000]);
  });

  it("地名でも同じ（種別を見分けていない）", () => {
    expect(parseCarry({ t: "cur", x: 1, y: 2, d: ["c", 7, -10, 20] }))
      .toEqual(["c", 7, -10, 20]);
  });

  // 「後から足せる形にする」（仕様）。線を足すときに DO を直さない。
  it("知らない1文字の種別も通す", () => {
    expect(parseCarry({ t: "cur", x: 1, y: 2, d: ["s", 7, 0, 0] })).toEqual(["s", 7, 0, 0]);
  });

  it("d が無ければ null（何も運んでいない）", () => {
    expect(parseCarry({ t: "cur", x: 1, y: 2 })).toBe(null);
  });

  it("小数の座標は丸める（カーソルと同じ 1m 精度）", () => {
    expect(parseCarry({ d: ["p", 1, 10.7, -3.2] })).toEqual(["p", 1, 11, -3]);
  });

  it("要素の数が違えば null", () => {
    expect(parseCarry({ d: ["p", 1, 2] })).toBe(null);
    expect(parseCarry({ d: ["p", 1, 2, 3, 4] })).toBe(null);
    expect(parseCarry({ d: [] })).toBe(null);
  });

  it("種別が1文字の英小文字でなければ null", () => {
    expect(parseCarry({ d: ["placement", 1, 2, 3] })).toBe(null);
    expect(parseCarry({ d: ["P", 1, 2, 3] })).toBe(null);
    expect(parseCarry({ d: ["", 1, 2, 3] })).toBe(null);
    expect(parseCarry({ d: [1, 1, 2, 3] })).toBe(null);
  });

  it("id は正の整数だけ", () => {
    expect(parseCarry({ d: ["p", 0, 2, 3] })).toBe(null);
    expect(parseCarry({ d: ["p", -1, 2, 3] })).toBe(null);
    expect(parseCarry({ d: ["p", 1.5, 2, 3] })).toBe(null);
    expect(parseCarry({ d: ["p", "1", 2, 3] })).toBe(null);
    expect(parseCarry({ d: ["p", NaN, 2, 3] })).toBe(null);
  });

  it("座標はカーソルと同じ網にかける", () => {
    expect(parseCarry({ d: ["p", 1, MAX_COORD + 1, 0] })).toBe(null);
    expect(parseCarry({ d: ["p", 1, 0, -MAX_COORD - 1] })).toBe(null);
    expect(parseCarry({ d: ["p", 1, NaN, 0] })).toBe(null);
    expect(parseCarry({ d: ["p", 1, "0", 0] })).toBe(null);
  });

  it("配列でなくても落ちない", () => {
    expect(parseCarry(null)).toBe(null);
    expect(parseCarry({ d: "p,1,2,3" })).toBe(null);
    expect(parseCarry({ d: { kind: "p" } })).toBe(null);
  });
});

// ── 引いている最中の線（Phase R2b）──────────────────────────────
//
// **`d`（運んでいる物）と同じ階層に `k` を足しただけ。** 新しい種類の通は作らない
// （引いている間はすでに `cur` が 10Hz で飛んでいる。仕様 2026-10-02-live-ink.md）。
//
// **DO は `k` の中身が何なのかを知らない。** 色が8色だとも、点が 0.1m 単位だとも
// 知らない（知ると盤面の形を知ることになる。`chg` に中身を載せないのと同じ理由）。
// **形だけ**を見る: 小さな整数が3つ、そのあとに整数の組。
describe("parseInk", () => {
  it("頭3つと点の組をそのまま受ける", () => {
    expect(parseInk({ t: "cur", x: 1, y: 2, k: [3, 2, 7, 100, 200, 5, 0] }))
      .toEqual([3, 2, 7, 100, 200, 5, 0]);
  });

  it("点が無くても通す（引いているが新しい点が無い、という合図）", () => {
    expect(parseInk({ k: [3, 2, 7] })).toEqual([3, 2, 7]);
  });

  it("k が無ければ null（何も引いていない）", () => {
    expect(parseInk({ t: "cur", x: 1, y: 2 })).toBe(null);
  });

  it("頭が足りなければ null", () => {
    expect(parseInk({ k: [] })).toBe(null);
    expect(parseInk({ k: [3] })).toBe(null);
    expect(parseInk({ k: [3, 2] })).toBe(null);
  });

  it("点が組になっていなければ null", () => {
    expect(parseInk({ k: [3, 2, 7, 100] })).toBe(null);
    expect(parseInk({ k: [3, 2, 7, 100, 200, 5] })).toBe(null);
  });

  it("整数でない値が混ざれば null", () => {
    expect(parseInk({ k: [3.5, 2, 7] })).toBe(null);
    expect(parseInk({ k: [3, 2, 7, 1.5, 0] })).toBe(null);
    expect(parseInk({ k: [3, 2, 7, NaN, 0] })).toBe(null);
    expect(parseInk({ k: [3, 2, 7, "1", 0] })).toBe(null);
    expect(parseInk({ k: [3, 2, 7, Infinity, 0] })).toBe(null);
  });

  // 桁が明らかに違う値だけを弾く緩い網（`parseCursor` の MAX_COORD と同じ作法）。
  // 点は 0.1m 単位の整数なので、網はメートルの10倍のところに置く。
  it("桁が異常な点は null", () => {
    expect(parseInk({ k: [3, 2, 7, MAX_COORD * 10 + 1, 0] })).toBe(null);
    expect(parseInk({ k: [3, 2, 7, 0, -MAX_COORD * 10 - 1] })).toBe(null);
    expect(parseInk({ k: [3, 2, 7, MAX_COORD * 10, 0] })).toEqual([3, 2, 7, MAX_COORD * 10, 0]);
  });

  // 頭の3つも緩い網にかける（負の太さや巨大な連番を素通しさせない）。
  it("頭の3つは小さな正の整数だけ", () => {
    expect(parseInk({ k: [0, 2, 7] })).toBe(null);
    expect(parseInk({ k: [3, 0, 7] })).toBe(null);
    expect(parseInk({ k: [3, 2, 0] })).toBe(null);
    expect(parseInk({ k: [-3, 2, 7] })).toBe(null);
    expect(parseInk({ k: [3, 2, 1e9] })).toBe(null);
  });

  // **DO の仕事を有限に保つ。** 1024 バイトの上限でも 200組ほどは入るので、
  // 中継する前に数を切っておく（上限そのものは下の `MAX_MESSAGE_LEN`）。
  it("点の数に上限がある", () => {
    const fill = (n) => [3, 2, 7, ...Array.from({ length: n * 2 }, () => 1)];
    expect(parseInk({ k: fill(MAX_INK_POINTS) })).not.toBe(null);
    expect(parseInk({ k: fill(MAX_INK_POINTS + 1) })).toBe(null);
  });

  it("配列でなくても落ちない", () => {
    expect(parseInk(null)).toBe(null);
    expect(parseInk({ k: "3,2,7" })).toBe(null);
    expect(parseInk({ k: { color: 3 } })).toBe(null);
  });
});

describe("cursorEntry", () => {
  it("何も運んでいなければ R1 と同じ3つ組", () => {
    expect(cursorEntry({ t: "cur", x: 10, y: 20 }, "111")).toEqual([10, 20, "111"]);
  });

  it("運んでいれば4つ目に足す（表の形を伸ばすだけ）", () => {
    expect(cursorEntry({ t: "cur", x: 10, y: 20, d: ["p", 5, 30, 40] }, "111"))
      .toEqual([10, 20, "111", ["p", 5, 30, 40]]);
  });

  // **壊れた `d` でカーソルそのものを落とさない。** 位置が分かることのほうが大事。
  it("d が壊れていてもカーソルは通す", () => {
    expect(cursorEntry({ t: "cur", x: 10, y: 20, d: ["p", 0] }, "111")).toEqual([10, 20, "111"]);
  });

  it("座標が無ければ null（盤面から出た＝カーソルも運んでいるものも消す）", () => {
    expect(cursorEntry({ t: "cur" }, "111")).toBe(null);
    expect(cursorEntry({ t: "cur", d: ["p", 5, 30, 40] }, "111")).toBe(null);
  });

  // 引いている最中の線は5つ目。**運んでいるものと同じ階層**に足しただけで、
  // 別の表も別の通も作っていない（切断・TTL で一緒に消えるのがこれで決まる）。
  it("引いている最中なら5つ目に足す", () => {
    expect(cursorEntry({ t: "cur", x: 10, y: 20, k: [3, 2, 7, 1, 2] }, "111"))
      .toEqual([10, 20, "111", null, [3, 2, 7, 1, 2]]);
  });

  it("運びながら引いていれば両方入る", () => {
    expect(cursorEntry(
      { t: "cur", x: 10, y: 20, d: ["p", 5, 30, 40], k: [3, 2, 7] }, "111"
    )).toEqual([10, 20, "111", ["p", 5, 30, 40], [3, 2, 7]]);
  });

  // **壊れた `k` でカーソルそのものを落とさない**（`d` と同じ作法）。
  it("k が壊れていてもカーソルは通す", () => {
    expect(cursorEntry({ t: "cur", x: 10, y: 20, k: [3, 2] }, "111")).toEqual([10, 20, "111"]);
  });

  it("引いていなければ R1 と同じ形のまま（4つ目を作らない）", () => {
    expect(cursorEntry({ t: "cur", x: 10, y: 20 }, "111")).toHaveLength(3);
  });

  // ── 書き込めない人の線は中継しない（D-072）─────────────────
  //
  // **ゲストは線を保存できない**（15経路すべて 401）。だから「引いている最中」も
  // 存在しえない。まともなクライアントは送ってこないが、`k` は**自分で組める**
  // （WebSocket に生の文字列を流すだけ）ので、**サーバで落とす。**
  //
  // 落とさないと、ログイン無しで誰でも**他人の盤面に線を描ける**
  // （保存はされないので消す手段が相手のリロードしか無い、という形で効く）。
  it("書き込めない人（ゲスト）の k は中継しない", () => {
    expect(cursorEntry({ t: "cur", x: 10, y: 20, k: [3, 2, 7, 1, 2] }, "anon:abc", false))
      .toEqual([10, 20, "anon:abc"]);
  });

  // **カーソルそのものは通す。** ゲストに許してあるのは「見ることと、
  // どこを見ているかを伝えること」で、そこは取り上げない（D-072）。
  it("ゲストのカーソルと運んでいるものは通す（線だけ落とす）", () => {
    expect(cursorEntry(
      { t: "cur", x: 10, y: 20, d: ["p", 5, 30, 40], k: [3, 2, 7] }, "anon:abc", false
    )).toEqual([10, 20, "anon:abc", ["p", 5, 30, 40]]);
  });

  it("既定（省略時）は今までどおり中継する", () => {
    expect(cursorEntry({ t: "cur", x: 10, y: 20, k: [3, 2, 7] }, "111"))
      .toEqual([10, 20, "111", null, [3, 2, 7]]);
  });

  // **判断を index.js の側に書き写さない。** `k` を削る処理を呼び出し側に
  // 書くと、書き込める／書けないの判定が2箇所になる。
  it("index.js は cursorEntry に許否を渡している（自分で k を削っていない）", () => {
    const code = readFileSync(join(ROOM_SRC, "index.js"), "utf8");
    expect(code).toMatch(/cursorEntry\(msg,\s*id,\s*[^)]+\)/);
    expect(code).not.toMatch(/delete\s+msg\.k/);
  });
});

// **カーソルの表は「人」ではなく「接続」でキーを持つ。**
// 2026-10-02 のオーナー報告「ピンは移動したら即時反映されるのですが、
// マウスカーソルは出ないですね」の原因がここだった。人でキーを持つと、
// 同じ人が2枚開いているときカーソルが1本しか存在せず、両方のタブが
// それを「自分のもの」として消す（`chg` は送信者のソケットだけ除くので
// 別タブに届く＝「ピンは出るがカーソルは出ない」になる）。
describe("cursorSnapshot", () => {
  const cursors = new Map([
    ["k1", [10, 20, "111"]],
    ["k2", [30, 40, "222"]],
  ]);

  it("つながっている接続だけを入れる", () => {
    expect(cursorSnapshot(cursors, new Set(["k1", "k2"]))).toEqual({
      k1: [10, 20, "111"],
      k2: [30, 40, "222"],
    });
  });

  // **close を取りこぼしても幽霊カーソルが残らない**（自己修復）。
  // 配信のたびに「今つながっている接続」で絞るので、表の掃除が漏れても画面には出ない。
  it("切れた接続は表に残っていても出さない", () => {
    expect(cursorSnapshot(cursors, new Set(["k1"]))).toEqual({ k1: [10, 20, "111"] });
  });

  // 同じ人の2枚目は別の鍵で入る（在室は1人のまま。数え方は変えていない）。
  it("同じ人の2接続は2本として入る", () => {
    const two = new Map([["k1", [1, 2, "111"]], ["k2", [3, 4, "111"]]]);
    expect(cursorSnapshot(two, new Set(["k1", "k2"]))).toEqual({
      k1: [1, 2, "111"],
      k2: [3, 4, "111"],
    });
  });

  it("誰もいなければ空（カーソルを消すためにこれを配る）", () => {
    expect(cursorSnapshot(cursors, new Set())).toEqual({});
  });

  // **運んでいる最中に切れたら、運んでいるものの印も一緒に消える。**
  // ここが漏れると、実際には動いていない盤面を全員が見ながら作戦を立てることになる
  // （カーソルが残るより害が大きい。仕様の受け入れ条件4）。
  it("切れた接続の「運んでいるもの」も出さない", () => {
    const carrying = new Map([["k1", [1, 2, "111", ["p", 9, 30, 40]]]]);
    expect(cursorSnapshot(carrying, new Set())).toEqual({});
  });

  it("運んでいるものは4つ目として素通しする", () => {
    const carrying = new Map([["k1", [1, 2, "111", ["p", 9, 30, 40]]]]);
    expect(cursorSnapshot(carrying, new Set(["k1"])))
      .toEqual({ k1: [1, 2, "111", ["p", 9, 30, 40]] });
  });
});

describe("buildCursors", () => {
  it("1本の文字列にする（受信者ごとに作り直さない）", () => {
    const s = buildCursors(new Map([["k1", [1, 2, "111"]]]), new Set(["k1"]));
    expect(JSON.parse(s)).toEqual({ t: "curs", c: { k1: [1, 2, "111"] } });
  });

  // 「あなたは誰か」を入れると 20人に配るのに 20回 stringify することになり、
  // 無料プランの CPU 10ms/呼び出しに当たる（調査 §5.8。R0 の buildWho と同じ理由）。
  // **自分の鍵は接続時に1通だけ別で渡す**（buildYou）ので、ここは全員同じ文字列。
  it("受信者ごとに変わる項目を持たない", () => {
    const s = buildCursors(new Map([["k1", [1, 2, "111"]]]), new Set(["k1"]));
    expect(Object.keys(JSON.parse(s)).sort()).toEqual(["c", "t"]);
  });

  it("空でも配る（これが「カーソルを消して」の合図）", () => {
    expect(buildCursors(new Map(), new Set())).toBe('{"t":"curs","c":{}}');
  });

  // **アイコン（アバター）を 10Hz の経路に載せない**（仕様の受け入れ条件7）。
  // 名前と色と同じで、受け取る側は所有者の Discord ID で在室一覧（`who`）を引く。
  // `buildCursors` は attachment を受け取らないので構造的に載りようがないが、
  // **ここに引数を1つ足したくなった人が落ちる**ように固定しておく。
  // 実際に飛ぶ通で確かめているのは e2e/plan-avatar.spec.js。
  it("値は [x, y, 所有者] の3つのまま（名前も色もアイコンも入れない）", () => {
    const s = buildCursors(new Map([["k1", [1, 2, "111"]]]), new Set(["k1"]));
    expect(JSON.parse(s).c.k1).toHaveLength(3);
    expect(buildCursors.length, "attachment を渡す引数を足していない").toBe(2);
  });

  // **運んでいる最中も新しい種類の通を作らない**（`curs` の値を伸ばすだけ）。
  it("運んでいるものは curs の値の4つ目に入る", () => {
    const s = buildCursors(
      new Map([["k1", [1, 2, "111", ["p", 9, 30, 40]]]]), new Set(["k1"])
    );
    expect(JSON.parse(s)).toEqual({ t: "curs", c: { k1: [1, 2, "111", ["p", 9, 30, 40]] } });
    expect(Object.keys(JSON.parse(s)).sort()).toEqual(["c", "t"]);
  });

  // いちばん長い `cur` が受信の上限に収まっていることを押さえる。
  it("運んでいるものを添えた cur が上限に収まる", () => {
    const worst = JSON.stringify({
      t: "cur", x: -MAX_COORD, y: -MAX_COORD, d: ["p", Number.MAX_SAFE_INTEGER, -MAX_COORD, -MAX_COORD],
    });
    expect(worst.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
  });

  // 引いている最中の線も `curs` の値を伸ばすだけ（5つ目）。
  it("引いている最中の線は curs の値の5つ目に入る", () => {
    const s = buildCursors(
      new Map([["k1", [1, 2, "111", null, [3, 2, 7, 10, 20]]]]), new Set(["k1"])
    );
    expect(JSON.parse(s)).toEqual({ t: "curs", c: { k1: [1, 2, "111", null, [3, 2, 7, 10, 20]] } });
    expect(Object.keys(JSON.parse(s)).sort()).toEqual(["c", "t"]);
  });
});

// ── 受信メッセージの長さの上限 ──────────────────────────────────
//
// **R0 から 256 バイトだったのを 1024 へ上げた**（引いている最中の点を載せるため）。
//
// **課金は「通の数」で決まり、バイト数では決まらない**（受信20通が1リクエスト。
// 調査 §2.4）。1通を太らせても請求は変わらないので、ここは安心して上げられる。
//
// **それでも壁は残す。** 壊れたクライアントが巨大な通を投げ続けるのを止める
// ためで、上限そのものが無くなると `JSON.parse` に無制限の文字列が渡る。
describe("受信メッセージの長さ", () => {
  it("上限は 1024 バイト", () => {
    expect(MAX_MESSAGE_LEN).toBe(1024);
  });

  // **数字を index.js に直接書かない。** 書くと、ここを変えたときに
  // 「クライアントは 1024 で組むのにサーバは 256 で捨てる」が起きる
  // （画面には「線が途中で止まる」としか出ない）。
  it("index.js はこの定数を使っている（数字を書き写していない）", () => {
    const code = readFileSync(join(ROOM_SRC, "index.js"), "utf8");
    expect(code).toMatch(/MAX_MESSAGE_LEN/);
    expect(code).not.toMatch(/message\.length\s*>\s*\d+/);
  });
});

describe("connKey / buildYou", () => {
  it("接続ごとに違う鍵になる", () => {
    const keys = new Set(Array.from({ length: 200 }, () => connKey()));
    expect(keys.size).toBe(200);
  });

  it("鍵は JSON にそのまま埋められる文字だけ（buildYou が素の連結）", () => {
    for (let i = 0; i < 50; i += 1) expect(connKey()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("自分の鍵を知らせる1通", () => {
    expect(JSON.parse(buildYou("deadbeef"))).toEqual({ t: "you", k: "deadbeef" });
  });
});

describe("CHANGED", () => {
  // DO は盤面の形を知らない。「何かが変わった」としか言わないので、
  // スキーマを変えても DO を直さずに済む（D1 が唯一の真実のまま）。
  it("中身を持たない1通", () => {
    expect(JSON.parse(CHANGED)).toEqual({ t: "chg" });
  });
});

// ── ティッカー（課金の安全弁 その1）──────────────────────────────
//
// **仕様書の擬似コード（`setTimeout(tick, 100)` の自己解除式）は採らなかった。**
// ハイバネーション対応の WebSocket しか持たない Durable Object は、
// メッセージの合間にメモリから落とされうる。落ちた時点で保留中のタイマーは消える。
// ローカルの workerd で実測したところ、4〜6回だけ発火して**永久に沈黙した**
// （「タイマーを張った」印が立ったままになり、以後カーソルが1本も流れない）。
// ループ全体を `state.waitUntil()` に預けても同じ所で止まった。
//
// 代わりに**配信を受信で駆動する**。タイマーを1本も作らないので、
// 「誰も動かしていない間はタイマーが残っていない」は構造的に成り立つ。
describe("配信の間隔", () => {
  const empty = new Set();

  it("クライアントの送信間隔（100ms）より少し短い", () => {
    // 同じ 100ms にすると、到着のゆらぎで「99ms だったので配らない」が起き、
    // 1人で動かしているときに 200ms の抜けができてカーソルが飛ぶ。
    expect(BROADCAST_GAP_MS).toBeLessThan(100);
    expect(BROADCAST_GAP_MS).toBeGreaterThan(0);
  });

  it("間隔が空いていれば配る", () => {
    expect(dueToSend({ lastAt: 1000, now: 1000 + BROADCAST_GAP_MS, senderId: "a", seen: empty }))
      .toBe(true);
  });

  it("続けざまには配らない（20人が同時に動いても配信は増えない）", () => {
    expect(dueToSend({ lastAt: 1000, now: 1000, senderId: "a", seen: empty })).toBe(false);
    expect(dueToSend({ lastAt: 1000, now: 1079, senderId: "a", seen: empty })).toBe(false);
  });

  it("消すときは窓もひと回りも無視して必ず配る（幽霊カーソルを残さない）", () => {
    expect(dueToSend({ lastAt: 1000, now: 1000, senderId: "a", seen: empty, force: true }))
      .toBe(true);
  });

  it("10Hz で送ってくる1人は1通も落とさない", () => {
    let last = 0;
    let sent = 0;
    const seen = new Set();
    for (let i = 1; i <= 100; i += 1) {
      const now = i * 100;
      if (dueToSend({ lastAt: last, now, senderId: "a", seen })) {
        sent += 1; last = now; seen.clear();
      } else {
        seen.add("a");
      }
    }
    expect(sent).toBe(100);
  });

  // **時計が止まっても配信が止まらないこと。** これが実測で踏んだ本体。
  // Worker の Date.now() は直前の I/O の時刻に貼り付いているので、
  // 「配らない → I/O が無い → 時計が進まない」で永久に配らなくなる。
  // 18人×10Hz のとき、DO は毎秒 106〜149 通を受けているのに配信が毎秒1回まで落ちた。
  describe("時計が1ミリ秒も進まない状況", () => {
    /** N人が順番に送ってくる状況を回して、何通に1回配るかを数える。 */
    const run = (movers, messages) => {
      const seen = new Set();
      let sent = 0;
      for (let i = 0; i < messages; i += 1) {
        const id = `u${i % movers}`;
        // now も lastAt も動かさない（＝時計が完全に止まっている）。
        if (dueToSend({ lastAt: 1000, now: 1000, senderId: id, seen })) {
          sent += 1; seen.clear();
        } else {
          seen.add(id);
        }
      }
      return sent;
    };

    // 時計が止まっているときの配信は「N+1 通に1回」になる（N人が一巡して、
    // 次の1通で重なりが出る）。1秒あたりでは 10N/(N+1) 回。
    it("1人が動かしているとき、2通に1回は配る（最低でも 5Hz）", () => {
      expect(run(1, 100)).toBe(50);
    });

    it("18人が動かしているとき、ひと回り（19通）に1回配る", () => {
      // 180通 = 18人 × 10Hz × 1秒 ぶん → 1秒あたり約 9.5 回。
      const sent = run(18, 180);
      expect(sent).toBeGreaterThanOrEqual(9);
      expect(sent).toBeLessThanOrEqual(10);
    });

    // **ここが効き目の本体。** 人数が増えても配信の回数が増えない
    // （＝人数ぶんの CPU を食わない）し、減りもしない（＝止まらない）。
    it("人数が増えても配信の回数は 10Hz 前後のまま", () => {
      const rates = [1, 2, 5, 10, 20].map((n) => run(n, n * 10));
      for (const [i, sent] of rates.entries()) {
        expect(sent, `${[1, 2, 5, 10, 20][i]}人`).toBeGreaterThanOrEqual(5);
        expect(sent, `${[1, 2, 5, 10, 20][i]}人`).toBeLessThanOrEqual(11);
      }
      // 人数が増えるほど 10 に近づく（悪化しない）。
      for (let i = 1; i < rates.length; i += 1) {
        expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]);
      }
    });
  });
});

// **これが「静止したら課金がゼロになる」ことの、いちばん強い試験。**
// 2分間の静止は e2e でも測れないが、**タイマーがソースに1つも無い**ことは
// ここで測れる。D-048 は R0 の出口条件2の間接証拠として
// 「setInterval / setAlarm / storage.* が1つも無い」を目視で確かめていた。
// R1 で 10Hz の送信を足すので、目視をやめて機械に見張らせる。
describe("DO にタイマーが1本も無い", () => {
  const sources = ["index.js", "cursors.js", "presence.js"];

  /** コメント（禁止理由の説明そのものが引っかかる）を落として、コードだけを見る。 */
  const codeOf = (name) =>
    readFileSync(join(ROOM_SRC, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

  it.each(sources)("%s に setInterval / setAlarm / setTimeout が無い", (name) => {
    const code = codeOf(name);
    expect(code).not.toMatch(/setInterval\s*\(/);
    expect(code).not.toMatch(/setTimeout\s*\(/);
    expect(code).not.toMatch(/setAlarm\s*\(/);
  });

  it("storage も使わない（行書き込みは課金対象）", () => {
    expect(codeOf("index.js")).not.toMatch(/\.storage\b/);
  });

  // `accept()` は繋がっている間ずっと実行時間が課金される（調査 §2.4）。
  // タブ1枚を24時間開いたままで1日枠の83%。
  it("acceptWebSocket だけを使う（ws.accept() は禁止）", () => {
    const code = codeOf("index.js");
    expect(code).toMatch(/acceptWebSocket\s*\(/);
    expect(code.replace(/acceptWebSocket/g, "")).not.toMatch(/\.accept\s*\(/);
  });
});

// ── レート超過（課金の安全弁 その2）────────────────────────────
//
// 受信は到達した時点で課金される（調査 §2.4「受信メッセージは 20:1」）ので、
// 無視しても枠は減る。**止める方法は閉じることだけ。**
describe("レート超過の判定", () => {
  it("直近1秒に 30通まで（正常な 10Hz の3倍の余裕）", () => {
    expect(RATE_MAX).toBe(30);
    expect(RATE_WINDOW_MS).toBe(1000);
  });

  it("10Hz を10秒流しても一度も超えない", () => {
    let times = [];
    for (let i = 0; i < 100; i += 1) {
      const r = rateHit(times, i * 100);
      expect(r.over).toBe(false);
      times = r.times;
    }
  });

  it("1秒に 31通で超える", () => {
    let times = [];
    let over = false;
    for (let i = 0; i < 31; i += 1) {
      const r = rateHit(times, 1000 + i);   // 31ms のあいだに31通
      times = r.times;
      over = r.over;
    }
    expect(over).toBe(true);
  });

  it("ちょうど 30通では超えない（境目）", () => {
    let times = [];
    let over = false;
    for (let i = 0; i < 30; i += 1) {
      const r = rateHit(times, 1000 + i);
      times = r.times;
      over = r.over;
    }
    expect(over).toBe(false);
  });

  it("窓から出た通は数えない（1秒空ければ元に戻る）", () => {
    let times = [];
    for (let i = 0; i < 30; i += 1) times = rateHit(times, 1000 + i).times;
    // 最後の1通（t = 1029）からちょうど1秒。30通とも窓の外に出る。
    const r = rateHit(times, 1029 + RATE_WINDOW_MS);
    expect(r.over).toBe(false);
    expect(r.times).toEqual([2029]);
  });

  // 1秒ごとに数え直す「固定窓」だと、境目の前後に寄せるだけで2倍が通る。
  // t=999 に 30通、t=1000 に 30通 ＝ **2ms のあいだに 60通**。
  // 固定窓はどちらの窓でも「30通」と数えて通してしまう。
  it("窓の境目に寄せても 2倍は通らない", () => {
    let times = [];
    let over = false;
    for (const at of [999, 1000]) {
      for (let i = 0; i < 30; i += 1) {
        const r = rateHit(times, at);
        times = r.times;
        over = over || r.over;
      }
    }
    expect(over).toBe(true);
  });

  // 暴走クライアントの記録でメモリを食わない（close するまでの数通ぶんで止まる）。
  it("記録が無制限に伸びない", () => {
    let times = [];
    for (let i = 0; i < 5000; i += 1) times = rateHit(times, 1000).times;
    expect(times.length).toBeLessThanOrEqual(RATE_MAX + 1);
  });
});
