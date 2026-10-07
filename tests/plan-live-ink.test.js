// 線を引いている最中を見せる（ライブ描画）のうち、DOM を触らない部分。
//
// **ここで守っているのは「1通が上限を超えない」の一点。**
// `cur` に点が乗るので、R1 から 256 バイトだった受信の上限を 1024 へ上げた
// （課金は通の数で決まり、バイト数では決まらない。調査 §2.4 の「受信20通＝1
// リクエスト」）。**上げても壊れたクライアントを止める壁は残す**ので、
// 速く引かれて1通に収まらないときは**クライアントが点を間引く。**
//
// 間引きが消えると、速く引いた瞬間に 1024 を超えて **DO がその通を黙って捨てる**
// （＝線が途中で止まる）。画面には何も出ないので、テストが無いと静かに失われる。
//
// 符号化は `ink.js` の既存の作法をそのまま使う（量子化 0.1m・差分符号化が
// サーバと共用で既にある）。**新しい符号化を作らない。**
import { describe, expect, it } from "vitest";

import {
  INK_CHUNK_BUDGET, inkChunk, inkIn, penColorIndex,
} from "../public/js/plan/cursors.js";
import { QUANTUM, decodePoints } from "../public/js/plan/ink.js";
import { MAX_COORD, MAX_INK_POINTS, MAX_MESSAGE_LEN } from "../workers/room/src/cursors.js";

const pt = (x_m, y_m) => ({ x_m, y_m });

/** まっすぐ伸びる n 点（間隔 gap メートル）。 */
const line = (n, gap = 1) => Array.from({ length: n }, (_, i) => pt(i * gap, i * gap));

/** いちばん長い `cur`（運びながら引く・座標も桁いっぱい）の全長。 */
const worstMessage = (k) => JSON.stringify({
  t: "cur",
  x: -MAX_COORD,
  y: -MAX_COORD,
  d: ["p", Number.MAX_SAFE_INTEGER, -MAX_COORD, -MAX_COORD],
  k,
}).length;

describe("penColorIndex", () => {
  // ペンの色は `state.color`（"cursor-1"〜"cursor-8"）。通には番号だけ載せる
  // （文字列をそのまま送ると1通に12バイト足すことになる）。
  it("ペンの色の名前から番号を取る", () => {
    expect(penColorIndex("cursor-1")).toBe(1);
    expect(penColorIndex("cursor-8")).toBe(8);
  });

  // **壊れた値でも必ず 1〜8 のどれかにする**（cursorColor と同じ作法）。
  // 色が決まらないことで線が出ないほうが困る。
  it("知らない値は 1 に倒す", () => {
    expect(penColorIndex("")).toBe(1);
    expect(penColorIndex(null)).toBe(1);
    expect(penColorIndex("ink")).toBe(1);
    expect(penColorIndex("cursor-9")).toBe(1);
    expect(penColorIndex("cursor-0")).toBe(1);
  });
});

describe("inkChunk", () => {
  const ink = { color: 3, width: 2, serial: 7 };

  it("色・太さ・連番のあとに、ink.js の符号化で点を並べる", () => {
    const { k } = inkChunk({ ...ink, points: [pt(10, 20), pt(10.5, 20)] });
    // 先頭3つが頭。残りは encodePoints（最初の組だけ絶対値、あとは差分）。
    expect(k.slice(0, 3)).toEqual([3, 2, 7]);
    expect(k.slice(3)).toEqual([100, 200, 5, 0]);
  });

  it("量子化は ink.js と同じ 0.1m（丸めも Math.round）", () => {
    const { k } = inkChunk({ ...ink, points: [pt(12.34, -0.06)] });
    expect(k.slice(3)).toEqual([123, -1]);
    expect(decodePoints(k.slice(3))[0].x_m).toBeCloseTo(123 * QUANTUM, 10);
  });

  // **「引いているが新しい点は無い」**を送れること。離してから保存が片付くまでの
  // あいだ、相手の画面の線を消させないために要る（この窓で `k` を落とすと
  // 「引き終わった」と読まれて一時的な線が消える）。
  it("新しい点が無ければ頭だけ（まだ引いている、という合図）", () => {
    expect(inkChunk({ ...ink, points: [] }).k).toEqual([3, 2, 7]);
  });

  it("点が入っても長さは必ず奇数（頭3つ + 組）", () => {
    for (const n of [0, 1, 2, 5, 50]) {
      expect(inkChunk({ ...ink, points: line(n) }).k.length % 2, `${n}点`).toBe(1);
    }
  });

  // ── 間引き（上限を超えさせない）────────────────────────────
  it("上限に収まるぶんはそのまま全部入る", () => {
    const { k, kept } = inkChunk({ ...ink, points: line(20) });
    expect(kept).toBe(20);
    expect(JSON.stringify(k).length).toBeLessThanOrEqual(INK_CHUNK_BUDGET);
  });

  it("速く引かれて入り切らないときは点を間引く", () => {
    const points = line(2000, 7);
    const { k, kept } = inkChunk({ ...ink, points });
    expect(kept).toBeLessThan(points.length);
    expect(JSON.stringify(k).length).toBeLessThanOrEqual(INK_CHUNK_BUDGET);
  });

  // **末尾は必ず残す。** 落とすと、相手の画面の線がペンの先に届かない
  // （次の通の絶対座標で飛んで繋がるが、1通ぶん遅れて見える）。
  it("間引いても最後の点は落とさない", () => {
    const points = line(2000, 7);
    const { k } = inkChunk({ ...ink, points });
    const decoded = decodePoints(k.slice(3));
    const last = decoded[decoded.length - 1];
    expect(last.x_m).toBeCloseTo(Math.round(points.at(-1).x_m / QUANTUM) * QUANTUM, 10);
  });

  // **どんな入れ方でも上限を超えない。** マップの端から端へ飛ぶ点
  // （差分が最大になる＝1組あたりの桁が最大になる）でも同じ。
  it("桁が最大の点を大量に入れても上限を超えない", () => {
    const zigzag = Array.from({ length: 3000 }, (_, i) => (
      i % 2 === 0 ? pt(0, 0) : pt(MAX_COORD, MAX_COORD)
    ));
    const { k } = inkChunk({ ...ink, points: zigzag });
    expect(JSON.stringify(k).length).toBeLessThanOrEqual(INK_CHUNK_BUDGET);
  });

  // **ここが「上限 1024」と「間引きの枠」を繋いでいる一点。**
  // 枠は `cur` の他の項目（座標・運んでいる物）ぶんを残した残りでなければ、
  // 運びながら引いたときだけ 1024 を超える。
  it("枠いっぱいの k を載せた、いちばん長い cur が上限に収まる", () => {
    // 間引きの結果がちょうど枠に届くとは限らないので、**枠そのもので最悪を測る。**
    const k = [8, 3, 999];
    while (JSON.stringify(k).length + 16 <= INK_CHUNK_BUDGET) k.push(-999_999, 999_999);
    expect(JSON.stringify(k).length).toBeGreaterThan(INK_CHUNK_BUDGET - 20);
    expect(worstMessage(k)).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
  });

  it("間引いた結果も枠に収まる（実際に流れるのはこちら）", () => {
    const { k } = inkChunk({ ...ink, points: line(2000, 7) });
    expect(worstMessage(k)).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
  });

  // **DO は点の数にも網を張っている**（`MAX_INK_POINTS`）。長さの上限とは別の網で、
  // 超えると `parseInk` が null に倒れて**その通の `k` が黙って捨てられる**
  // （画面には「線が途中で止まる」としか出ない）。
  //
  // 枠（バイト）と網（個数）は**別の単位**なので、片方だけ動かすと食い違う。
  // いちばん詰まる形は1組4文字（`0,0,`）なので、枠から入りうる最大の個数を
  // そこから出して、網の内側にあることを押さえる。
  it("枠いっぱいに詰め込んでも、DO の点数の網を超えない", () => {
    // 頭3つと括弧で10文字弱。残りを最小の1組（4文字）で埋めたときの個数。
    const densest = Math.ceil((INK_CHUNK_BUDGET - JSON.stringify([8, 3, 999]).length) / 4);
    expect(densest).toBeLessThanOrEqual(MAX_INK_POINTS);
    // 実際に 0 ばかりの点を詰めても、枠と網の両方に収まる。
    const points = Array.from({ length: MAX_INK_POINTS * 4 }, () => pt(0, 0));
    const { k, kept } = inkChunk({ color: 8, width: 3, serial: 999, points });
    expect(JSON.stringify(k).length).toBeLessThanOrEqual(INK_CHUNK_BUDGET);
    expect(kept).toBeLessThanOrEqual(MAX_INK_POINTS);
  });

  it("枠を狭めれば入る点が減る（枠を読んでいることの確認）", () => {
    const points = line(400, 3);
    const wide = inkChunk({ ...ink, points }).kept;
    const narrow = inkChunk({ ...ink, points }, 120).kept;
    expect(narrow).toBeLessThan(wide);
    expect(JSON.stringify(inkChunk({ ...ink, points }, 120).k).length)
      .toBeLessThanOrEqual(120);
  });
});

// 受け取る側の検査。DO も見ているが（`parseInk`）、**ここを通った値はそのまま
// 盤面に線を引く**ので、信じる前にもう一度形を見る（`carryIn` と同じ作法）。
describe("inkIn", () => {
  const entry = (k) => [10, 20, "111", null, k];

  it("色・太さ・連番と、メートルに戻した点を返す", () => {
    const got = inkIn(entry([3, 2, 7, 100, 200, 5, 0]));
    expect(got.color).toBe(3);
    expect(got.width).toBe(2);
    expect(got.serial).toBe(7);
    expect(got.points).toEqual([pt(10, 20), pt(10.5, 20)]);
  });

  it("点が無くても通す（まだ引いている、という合図）", () => {
    expect(inkIn(entry([3, 2, 7]))).toEqual({ color: 3, width: 2, serial: 7, points: [] });
  });

  it("運んでいるものが同じ通に乗っていても読める", () => {
    const got = inkIn([10, 20, "111", ["p", 5, 30, 40], [1, 1, 1, 0, 0]]);
    expect(got.serial).toBe(1);
  });

  it("k が無ければ null（何も引いていない）", () => {
    expect(inkIn([10, 20, "111"])).toBe(null);
    expect(inkIn([10, 20, "111", ["p", 5, 30, 40]])).toBe(null);
  });

  it("形が違えば null", () => {
    expect(inkIn(entry([3, 2]))).toBe(null);          // 頭が足りない
    expect(inkIn(entry([3, 2, 7, 100]))).toBe(null);  // 組になっていない
    expect(inkIn(entry("3,2,7"))).toBe(null);
    expect(inkIn(entry(null))).toBe(null);
    expect(inkIn(null)).toBe(null);
    expect(inkIn("cur")).toBe(null);
  });

  it("整数でない値が混ざれば null", () => {
    expect(inkIn(entry([3.5, 2, 7]))).toBe(null);
    expect(inkIn(entry([3, 2, 7, 1.5, 0]))).toBe(null);
    expect(inkIn(entry([3, 2, 7, NaN, 0]))).toBe(null);
    expect(inkIn(entry([3, 2, 7, "1", 0]))).toBe(null);
    expect(inkIn(entry([3, 2, 7, Infinity, 0]))).toBe(null);
  });

  // 色と太さは**こちらで必ず枠に収める**（var(--cursor-N) と線の太さに直に入る）。
  it("色と太さは枠に収めて返す", () => {
    expect(inkIn(entry([99, 99, 1])).color).toBe(1);
    expect(inkIn(entry([0, 0, 1])).color).toBe(1);
    expect(inkIn(entry([3, 99, 1])).width).toBe(3);
    expect(inkIn(entry([3, 0, 1])).width).toBe(1);
  });
});
