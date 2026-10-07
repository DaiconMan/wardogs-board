// コントロールエリアのプリセット（ゲームが決めた円）まわりの計算。
//
// ここは通信を伴わない純関数だけを見る。守りたいのは3つ。
//   1. **ゲーム内座標（1単位 = 100m）とメートルの往復**で桁を間違えない
//   2. **円の中に入っているドリルタワーの判定**。とくに**縁ちょうど**の扱い
//   3. **「座標をマーク」の文字列**が、ゲームがチャットに流す形と同じであること
//
// 円とタワーの関係は「ゲームが決めたもの」で、人が選ぶものではない
// （docs/research/2026-09-29-zones-drills-data.md §2.3・§4.3）。
import { describe, it, expect } from "vitest";
import {
  ZONE_EDGE_INCLUSIVE, distanceM, gameToM, mToGame, markText,
  towerIdsInZone, towersInZone, zoneCountText,
} from "../public/js/plan/zones.js";

/** 中心 (1000, 1000)・半径 500m の円。以下のテストで使い回す。 */
const zone = { x_m: 1000, y_m: 1000, radius_m: 500 };

const tower = (id, x_m, y_m) => ({ id, name: id, x_m, y_m });

describe("ゲーム内座標とメートル", () => {
  it("ゲーム内の 75.07 は 7507m（1単位 = 100m）", () => {
    expect(gameToM(75.07)).toBeCloseTo(7507, 6);
    expect(mToGame(7507)).toBeCloseTo(75.07, 6);
  });

  it("往復しても値が変わらない", () => {
    for (const v of [0, 0.01, 70.47, 99.03, 163.84]) {
      expect(mToGame(gameToM(v))).toBeCloseTo(v, 6);
    }
  });
});

describe("distanceM", () => {
  it("3-4-5 の直角三角形", () => {
    expect(distanceM({ x_m: 0, y_m: 0 }, { x_m: 300, y_m: 400 })).toBe(500);
  });
});

describe("towersInZone（円の中のドリルタワー）", () => {
  it("中心にあるタワーは対象", () => {
    expect(towersInZone([tower("t1", 1000, 1000)], zone).map((t) => t.id)).toEqual(["t1"]);
  });

  it("半径より外のタワーは対象外", () => {
    expect(towersInZone([tower("t1", 1000, 1600)], zone)).toEqual([]);
  });

  // **境界の決め: 距離 = 半径ちょうどは「中」に数える（<=）。**
  // タワー座標の確度は 0.5〜6.5m あって（schema.sql の accuracy_m）、
  // 厳密な境界に意味が無い。どちらかに決め打つなら、目で見て円の縁に
  // 乗っているものを黙って落とさないほうが実害が小さい。
  it("縁ちょうど（距離 = 半径）は中に数える", () => {
    expect(ZONE_EDGE_INCLUSIVE).toBe(true);
    const onEdge = tower("edge", 1500, 1000);            // x に +500m ちょうど
    expect(distanceM(onEdge, zone)).toBe(500);
    expect(towersInZone([onEdge], zone).map((t) => t.id)).toEqual(["edge"]);
  });

  it("縁より 1m 外は対象外（境界の外側はきっちり落ちる）", () => {
    expect(towersInZone([tower("out", 1501, 1000)], zone)).toEqual([]);
  });

  it("斜めの縁ちょうど（3-4-5）も中に数える", () => {
    expect(towersInZone([tower("diag", 1300, 1400)], zone).map((t) => t.id)).toEqual(["diag"]);
  });

  it("並びは渡した順のまま（画面の並びが毎回変わらない）", () => {
    const list = [tower("a", 1000, 1000), tower("b", 900, 900), tower("c", 1100, 1050)];
    expect(towersInZone(list, zone).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("円が無ければ空（プリセットを選んでいない状態）", () => {
    expect(towersInZone([tower("a", 1000, 1000)], null)).toEqual([]);
  });

  it("半径が数値でなければ空（壊れた行で盤面を落とさない）", () => {
    expect(towersInZone([tower("a", 1000, 1000)], { x_m: 1000, y_m: 1000 })).toEqual([]);
  });

  it("towerIdsInZone は id の Set を返す（強調の付け外しに使う）", () => {
    const ids = towerIdsInZone([tower("a", 1000, 1000), tower("b", 1000, 2000)], zone);
    expect(ids instanceof Set).toBe(true);
    expect([...ids]).toEqual(["a"]);
  });
});

// 実データでの検算。調査 §2.3 は「Bakurani の Default は5本すべてが円内、
// Farmland は4本（TOWER 3 が 584m で外）、Lumberyard は3本」としている。
// **この数は幾何だけで再現できる**、が今回の設計の前提なので、ここで押さえる。
//
// 座標は schema.sql の map_towers（MIT の apollyon-sys/wardogs-calculator 由来、
// 左下原点・y 上）。**円の中心はここには書かない**（オーナーが入力するもので、
// wardogs.tools 側にしか無い値を写さない）。代わりに「中心をここに置けば
// 何本入るか」という形で、判定そのものだけを確かめる。
describe("実データでの検算（Bakurani の5本）", () => {
  const bakurani = [
    tower("bakurani-t1", 8020.5, 6957.7),
    tower("bakurani-t2", 7688.8, 6972.7),
    tower("bakurani-t3", 7688.8, 7315.3),
    tower("bakurani-t4", 8331.3, 7256.5),
    tower("bakurani-t5", 8189.9, 6814.3),
  ];

  it("5本の重心に半径500mの円を置くと、5本とも入る", () => {
    const cx = bakurani.reduce((s, t) => s + t.x_m, 0) / bakurani.length;
    const cy = bakurani.reduce((s, t) => s + t.y_m, 0) / bakurani.length;
    const hit = towersInZone(bakurani, { x_m: cx, y_m: cy, radius_m: 500 });
    expect(hit.length).toBe(5);
  });

  it("t1 を中心に半径300mだと、遠いものが落ちる（幾何で本数が変わる）", () => {
    const hit = towersInZone(bakurani, { x_m: 8020.5, y_m: 6957.7, radius_m: 300 });
    expect(hit.length).toBeLessThan(5);
    expect(hit.map((t) => t.id)).toContain("bakurani-t1");
  });
});

// ゲームには「座標をマーク」があり、チャットに `📍 x70.47, y99.03` と流れる
// （オーナーが実機で確認、2026-09-29）。Discord に貼ったときに
// ゲームから流れてきたものと同じ見た目になるよう、その形に寄せる。
describe("markText（座標をマークの文字列）", () => {
  it("ゲームがチャットに流すのと同じ形", () => {
    expect(markText({ x: 70.47, y: 99.03 })).toBe("📍 x70.47, y99.03");
  });

  it("小数は必ず2桁（桁が揃わないと目で比べられない）", () => {
    expect(markText({ x: 7, y: 100.5 })).toBe("📍 x7.00, y100.50");
  });

  it("実測値（Zestafona の Tower 3）でも同じ形", () => {
    expect(markText({ x: 70.01, y: 100.31 })).toBe("📍 x70.01, y100.31");
  });
});

describe("zoneCountText（対象タワーの本数）", () => {
  it("本数をそのまま言う", () => {
    expect(zoneCountText(5)).toBe("対象のドリルタワー 5本");
  });

  it("0本でも「無い」と分かる言い方にする", () => {
    expect(zoneCountText(0)).toBe("対象のドリルタワー なし");
  });
});
