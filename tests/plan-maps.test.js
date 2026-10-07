import { describe, it, expect, beforeAll } from "vitest";
import { startServers, stopServers, baseUrl, loginAs } from "./plan-helpers.js";

beforeAll(async () => {
  await startServers();
  return stopServers;
}, 120_000);

const url = (p) => `${baseUrl("plan")}${p}`;

describe("GET /api/maps", () => {
  it("未ログインなら 401", async () => {
    const r = await fetch(url("/api/maps"));
    expect(r.status).toBe(401);
  });

  // 正しい寸法そのもの（16,320 / 16,320 / 16,384m）は schema.sql の値なので、
  // tests/plan-schema.test.js が出典つきで見ている。ここで見るのは
  // 「API がその値をそのまま返すか」だけ。同じ数字を2箇所に書かない。
  it("ログイン済みならマップ一覧を返す", async () => {
    const { cookie } = await loginAs("2001", "mapuser");
    const r = await fetch(url("/api/maps"), { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.maps.map((m) => m.id)).toEqual(["bakurani", "ozeti", "zestafona"]);
    const bakurani = body.maps.find((m) => m.id === "bakurani");
    expect(bakurani.width_m).toBe(bakurani.height_m);   // どのマップも正方形
    // ゲーム内の座標は左下が 0,0 で y は上に増える（オーナー確認 2026-09-29）。
    // 保存する y_m も同じ向きなので 0。1 に戻ると盤面が上下逆になる。
    expect(bakurani.y_axis_down).toBe(0);
    // 回帰: 2000 は Control Zone のサイズ、16000 は「256 km²」からの逆算で
    // どちらもマップの一辺ではない（調査 §3.5）。
    expect(bakurani.width_m).not.toBe(2000);
    expect(bakurani.width_m).not.toBe(16000);
  });

  it("未検証の数値には verified=0 が付く", async () => {
    const { cookie } = await loginAs("2002", "mapuser2");
    const body = await (await fetch(url("/api/maps"), { headers: { cookie } })).json();
    expect(body.maps.find((m) => m.id === "bakurani").verified).toBe(0);
  });

  // 作戦の一覧は「マップ × パターンの枠」を**空いている枠も含めて**並べる（D-046）。
  // 枠の総数はプリセットの件数で決まり、件数は今後も増減する。
  // **画面側に 9 と書かない**ために、マップ一覧が自分のパターンを連れて返る。
  //
  // マップごとに別の往復（`/api/maps/{id}/zone-presets`）を足さないのは、
  // 一覧を開くたびにマップの数だけ往復が増えるため。1回で足りる。
  it("マップごとの想定するパターンも一緒に返る（一覧の枠を数えるため）", async () => {
    const { cookie } = await loginAs("2003", "mapuser3");
    const body = await (await fetch(url("/api/maps"), { headers: { cookie } })).json();

    for (const m of body.maps) {
      expect(Array.isArray(m.presets), `${m.id}.presets が配列でない`).toBe(true);
    }

    // schema.sql が入れてあるのは Zestafona の Default 1件だけ。
    // 本番にはオーナーが9件入れてあるが、**件数はここで固定しない**
    // （固定すると、パターンを増やすたびにテストが落ちる）。
    const zest = body.maps.find((m) => m.id === "zestafona");
    const seeded = zest.presets.find((p) => p.id === "zestafona-default");
    expect(seeded, "seed のパターンが無い").toBeTruthy();
    expect(seeded.name).toContain("Default");
    // 枠の見出しに使うので、名前と並び順が要る。
    expect(typeof seeded.sort_order).toBe("number");
    expect(seeded.key).toBe("Default");

    // 並びは sort_order の昇順（admin が付けた順。画面はこの順で枠を置く）。
    for (const m of body.maps) {
      const orders = m.presets.map((p) => p.sort_order);
      expect([...orders].sort((a, b) => a - b), `${m.id} の並び`).toEqual(orders);
    }

    // 1件も登録されていないマップは空配列（null や欠落にしない。
    // 画面側で「枠が0個のマップ」を素直に書けるようにするため）。
    expect(body.maps.find((m) => m.id === "bakurani").presets).toEqual([]);
  });
});
