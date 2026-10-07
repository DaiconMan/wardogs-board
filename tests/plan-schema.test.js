// schema.sql が必要なテーブルをすべて作ることを確かめる。
//
// このテストは専用の persist ディレクトリを「毎回作り直してから」schema.sql を流す。
// 既存の状態に依存すると、手元にだけ残っていたディレクトリのおかげで通ってしまい、
// クリーンな環境（CI は .wrangler/ を持たない。.gitignore 対象）で初めて落ちる。
// pages dev は使わないので、他のテストのポートや persist 先とは干渉しない。
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const PERSIST = join(ROOT, ".wrangler", "schema-check");

const EXPECTED_TABLES = [
  "callouts", "comments", "events", "ink_strokes", "map_spawns", "map_towers", "maps",
  "plan_priorities", "plan_stamps", "presets", "session_areas", "session_callouts",
  "session_markers", "session_visits", "sessions", "stamps", "users", "zones",
];

/**
 * マップの実寸（メートル）。**3つとも違う値**なので、1つの定数にまとめない。
 *
 * 出典: docs/research/2026-09-29-zones-drills-data.md §3.5。
 * ネイティブのマップ画像のピクセル数 × worldUnitsPerPixel（UE のワールド単位 = cm）で、
 *   Bakurani  16,384px × 99.609375cm  = 16,320m
 *   Ozeti     32,768px × 49.8046875cm = 16,320m
 *   Zestafona 32,768px × 50cm         = 16,384m
 * `map-src/*.png` のピクセル寸法が外部データの nativeSizePx と完全一致することが根拠。
 */
const EXPECTED_MAP_M = {
  bakurani: 16320,
  ozeti: 16320,
  zestafona: 16384,
};

/** マップごとのドリルタワーの本数（同 §4.1〜4.2）。 */
const EXPECTED_TOWERS = { bakurani: 5, ozeti: 4, zestafona: 3 };

/**
 * ゲーム内で実測した1点（オーナー、2026-09-29）。
 * Zestafona の Tower 3 にカーソルを合わせたときのゲームの座標表示。
 * 左下原点・y 上向き・1単位 = 100m。ここが合っていれば、オーナーが
 * ゲーム画面で読んだ数字をそのままツールに打ち込める。
 */
const MEASURED_ZESTAFONA_T3 = { id: "zestafona-t3", x_m: 7001, y_m: 10031, tolerance_m: 25 };

/** wrangler d1 execute を実行して stdout を返す。 */
function d1(...args) {
  return execFileSync(
    process.execPath,
    [WRANGLER, "d1", "execute", "wardogs-blue", "--local", `--persist-to=${PERSIST}`, ...args],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }
  );
}

describe("schema.sql", () => {
  beforeAll(() => {
    rmSync(PERSIST, { recursive: true, force: true });
    d1("--file=schema.sql", "--yes");
  }, 90_000);

  it("必要なテーブルがすべて作られる", () => {
    const out = d1(
      "--command=SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
      "--json"
    );
    const names = JSON.parse(out)[0].results.map((r) => r.name);
    for (const t of EXPECTED_TABLES) {
      expect(names, `${t} が無い`).toContain(t);
    }
  });

  it("2回続けて流しても壊れない（冪等）", () => {
    d1("--file=schema.sql", "--yes");
    const out = d1(
      "--command=SELECT (SELECT COUNT(*) FROM maps) AS maps," +
        " (SELECT COUNT(*) FROM map_towers) AS towers," +
        " (SELECT COUNT(*) FROM map_spawns) AS spawns;",
      "--json"
    );
    // INSERT OR IGNORE は 2 回目で行を増やさない。
    expect(JSON.parse(out)[0].results[0]).toEqual({ maps: 3, towers: 12, spawns: 9 });
  }, 90_000);

  // 列の追加は schema.sql の CREATE TABLE 定義に書く（新規DB用・冪等のまま）。
  // 既存DB向けの ALTER TABLE は migrations/ に1回限りのファイルとして置く。
  // schema.sql に ALTER TABLE を書くと、上の冪等テストが2回目で落ちる。
  it("placements に rank 列がある（FOB の優先度 1〜9）", () => {
    const out = d1("--command=PRAGMA table_info(placements);", "--json");
    const cols = JSON.parse(out)[0].results.map((r) => r.name);
    expect(cols, "rank が無い").toContain("rank");
  });

  // 地名の実体はプランごと（session_callouts）。マップ静的な callouts は
  // 雛形（マスタ）としてだけ残し、地図に出るのはこちらの表の行だけにする。
  it("session_callouts が冪等・編集可能な形で作られる", () => {
    const out = d1("--command=PRAGMA table_info(session_callouts);", "--json");
    const cols = JSON.parse(out)[0].results.map((r) => r.name);
    for (const c of [
      "id", "session_id", "name", "x_m", "y_m",
      "created_by", "created_at", "updated_at", "client_uuid",
    ]) {
      expect(cols, `${c} が無い`).toContain(c);
    }
  });

  it("session_callouts の client_uuid が一意（再送しても増えない）", () => {
    const out = d1("--command=PRAGMA index_list(session_callouts);", "--json");
    const unique = JSON.parse(out)[0].results.filter((r) => r.unique === 1);
    expect(unique.length, "UNIQUE インデックスが無い").toBeGreaterThan(0);
  });

  // エリア塗りは 1ジェスチャ = 1行の追記型。取り消しが「最後の行を DELETE」で
  // 済むのは、op（add / sub）と client_uuid をこの表が持っているから。
  it("session_areas が追記型・冪等の形で作られる", () => {
    const out = d1("--command=PRAGMA table_info(session_areas);", "--json");
    const cols = JSON.parse(out)[0].results;
    const names = cols.map((r) => r.name);
    for (const c of [
      "id", "session_id", "kind", "op", "cell_m", "rects",
      "created_by", "created_at", "client_uuid",
    ]) {
      expect(names, `${c} が無い`).toContain(c);
    }
    const byName = Object.fromEntries(cols.map((r) => [r.name, r]));
    expect(byName.op.dflt_value, "op の既定は add").toBe("'add'");
    expect(Number(byName.cell_m.dflt_value), "cell_m の既定は 1km").toBe(1000);
  });

  it("session_areas の client_uuid が一意（再送しても増えない）", () => {
    const out = d1("--command=PRAGMA index_list(session_areas);", "--json");
    const unique = JSON.parse(out)[0].results.filter((r) => r.unique === 1);
    expect(unique.length, "UNIQUE インデックスが無い").toBeGreaterThan(0);
  });

  it("bakurani / ozeti / zestafona の3マップがすべて未検証で存在する", () => {
    const out = d1(
      "--command=SELECT id, verified FROM maps ORDER BY id;",
      "--json"
    );
    const rows = JSON.parse(out)[0].results;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.verified]));
    for (const id of ["bakurani", "ozeti", "zestafona"]) {
      expect(byId, `${id} が無い`).toHaveProperty(id);
      expect(byId[id], `${id} の verified`).toBe(0);
    }
  });

  // マップの一辺は**マップごとに違う**（16,320 / 16,320 / 16,384m）。
  // 以前ここに書いていた「3マップとも 16000」は、コミュニティサイト1件の
  // 「256 km²」と「対角 22.6km」から逆算した値で、誤りだった
  // （docs/research/2026-09-29-zones-drills-data.md §3.5）。
  it("マップの一辺が調査どおりで、マップごとに違う", () => {
    const out = d1("--command=SELECT id, width_m, height_m FROM maps ORDER BY id;", "--json");
    const rows = JSON.parse(out)[0].results;
    expect(rows.length).toBe(3);
    for (const m of rows) {
      expect(m.width_m, `${m.id} の width_m`).toBe(EXPECTED_MAP_M[m.id]);
      expect(m.height_m, `${m.id} の height_m`).toBe(EXPECTED_MAP_M[m.id]);
      // 回帰テスト: 2000 は Control Zone（毎試合ランダムに決まるサブ領域）の
      // サイズであってマップ全体ではない。この取り違えを二度と入れない。
      expect(m.width_m, `${m.id} に Control Zone のサイズが入っている`).not.toBe(2000);
      // 回帰テスト: 16000 は「256 km²」からの逆算で、2% 小さい。
      expect(m.width_m, `${m.id} が 16000 に戻っている`).not.toBe(16000);
    }
    // 「3つとも同じ」に戻ったら気づけるようにする（Zestafona だけ 64m 広い）。
    expect(new Set(rows.map((m) => m.width_m)).size, "3マップが同じ値になっている").toBe(2);
  });

  // ゲーム内の座標は左下が 0,0 で y は上に増える（オーナーがゲーム内で確認）。
  // 保存する y_m もその向きに揃えるので y_axis_down は 0。ここが 1 に戻ると、
  // 盤面に描くものが全部上下逆になる。
  it("y 軸は3マップとも「上向き」（y_axis_down = 0）", () => {
    const out = d1("--command=SELECT id, y_axis_down FROM maps ORDER BY id;", "--json");
    for (const m of JSON.parse(out)[0].results) {
      expect(m.y_axis_down, `${m.id} の y_axis_down`).toBe(0);
    }
  });

  it("寸法の出典と調査日が入っている（数値だけを置かない）", () => {
    const out = d1("--command=SELECT id, source, measured_at, patch FROM maps ORDER BY id;", "--json");
    for (const m of JSON.parse(out)[0].results) {
      expect(m.source, `${m.id} の source`).toBeTruthy();
      expect(m.source, `${m.id} の source に調査ドキュメントの参照が無い`)
        .toContain("2026-09-29-zones-drills-data.md");
      expect(m.measured_at, `${m.id} の measured_at`).toBe("2026-09-29");
      expect(m.patch, `${m.id} の patch`).toBeTruthy();
    }
  });

  // ── ドリルタワー（マップ固定の設備。プレイヤーが建てるドリルリグとは別物）──
  // zones（多角形）にも placements（プランごとの配置）にも入れず、専用の
  // マップ静的な表に持つ。位置は毎試合同じで、チームが置くものではない。
  it("map_towers が出典とライセンスを持つ形で作られる", () => {
    const out = d1("--command=PRAGMA table_info(map_towers);", "--json");
    const names = JSON.parse(out)[0].results.map((r) => r.name);
    for (const c of [
      "id", "map_id", "name", "x_m", "y_m",
      "accuracy_m", "source", "license", "measured_at", "patch", "verified",
    ]) {
      expect(names, `${c} が無い`).toContain(c);
    }
  });

  it("ドリルタワーが 12 本あり、マップごとの本数が合っている", () => {
    const out = d1(
      "--command=SELECT map_id, COUNT(*) AS n FROM map_towers GROUP BY map_id ORDER BY map_id;",
      "--json"
    );
    const rows = JSON.parse(out)[0].results;
    const byMap = Object.fromEntries(rows.map((r) => [r.map_id, r.n]));
    expect(byMap).toEqual(EXPECTED_TOWERS);
    expect(Object.values(byMap).reduce((a, b) => a + b, 0)).toBe(12);
  });

  it("ドリルタワーの座標がマップの中に収まっている", () => {
    const out = d1(
      `--command=SELECT t.id, t.x_m, t.y_m, m.width_m, m.height_m
                   FROM map_towers t JOIN maps m ON m.id = t.map_id;`,
      "--json"
    );
    const rows = JSON.parse(out)[0].results;
    expect(rows.length, "maps と結べないタワーがある").toBe(12);
    for (const t of rows) {
      expect(t.x_m, `${t.id} の x_m`).toBeGreaterThan(0);
      expect(t.x_m, `${t.id} の x_m`).toBeLessThan(t.width_m);
      expect(t.y_m, `${t.id} の y_m`).toBeGreaterThan(0);
      expect(t.y_m, `${t.id} の y_m`).toBeLessThan(t.height_m);
    }
  });

  // 座標の出所は MIT ライセンスのリポジトリ（apollyon-sys/wardogs-calculator）。
  // 利用規約が自動抽出と再配布を禁じている側の出典に依存していないことを、
  // 行そのものに書き残しておく（D-026 の「数値には出典を残す」の実装）。
  it("ドリルタワーの全行に出典・ライセンス・確度が入っている", () => {
    const out = d1(
      "--command=SELECT id, source, license, accuracy_m, verified FROM map_towers;",
      "--json"
    );
    for (const t of JSON.parse(out)[0].results) {
      expect(t.source, `${t.id} の source`).toBeTruthy();
      expect(t.license, `${t.id} の license に MIT の記載が無い`).toContain("MIT");
      expect(t.source, `${t.id} の source に取得元リポジトリが無い`)
        .toContain("apollyon-sys/wardogs-calculator");
      // 2つの独立した出典の食い違い（m）。Zestafona は 0.5m 以内で一致した。
      expect(t.accuracy_m, `${t.id} の accuracy_m`).toBeGreaterThan(0);
      // ゲーム内で実測したわけではないので、検証済みにはしない。
      expect(t.verified, `${t.id} の verified`).toBe(0);
    }
  });

  // ここが今回の座標系の要。ゲーム内の座標表示（左下原点・y 上向き・1単位100m）と
  // DB の値が同じ向きでなければ、オーナーがゲームで読んだ数字を打ち込めない。
  it("Zestafona の Tower 3 が、ゲーム内で読んだ座標と一致する", () => {
    const out = d1(
      `--command=SELECT id, x_m, y_m FROM map_towers WHERE id = '${MEASURED_ZESTAFONA_T3.id}';`,
      "--json"
    );
    const rows = JSON.parse(out)[0].results;
    expect(rows.length, `${MEASURED_ZESTAFONA_T3.id} が無い`).toBe(1);
    const t = rows[0];
    const { x_m, y_m, tolerance_m } = MEASURED_ZESTAFONA_T3;
    // ゲーム画面のカーソルで読んだ値なので、数十メートルの読み取り誤差はある。
    expect(Math.abs(t.x_m - x_m), `x のずれ（実測 ${x_m}m）`).toBeLessThan(tolerance_m);
    expect(Math.abs(t.y_m - y_m), `y のずれ（実測 ${y_m}m）`).toBeLessThan(tolerance_m);
    // 上下を取り違えると 16,384 - 10,031 = 6,353 付近の値になる。そこは通さない。
    expect(Math.abs(t.y_m - (16384 - y_m)), "y が上下逆に入っている").toBeGreaterThan(1000);
  });

  // ── 陣営スポーン（セーフゾーン）──
  it("map_spawns が 9 件（3マップ × 3陣営）作られる", () => {
    const out = d1(
      "--command=SELECT map_id, faction FROM map_spawns ORDER BY map_id, faction;",
      "--json"
    );
    const rows = JSON.parse(out)[0].results;
    expect(rows.length).toBe(9);
    for (const map of ["bakurani", "ozeti", "zestafona"]) {
      const f = rows.filter((r) => r.map_id === map).map((r) => r.faction);
      expect(f, `${map} の陣営`).toEqual(["lonestar", "manticore", "valkyra"]);
    }
  });

  // セーフゾーンは一辺およそ 480m の回転した正方形（調査 §3.1）。
  // 多角形が壊れていないこと・単位を取り違えていないことを、形そのもので見る。
  it("スポーンの多角形が一辺 480m ほどの四角で、マップの中にある", () => {
    const out = d1(
      `--command=SELECT s.id, s.polygon, s.source, s.license, m.width_m, m.height_m
                   FROM map_spawns s JOIN maps m ON m.id = s.map_id;`,
      "--json"
    );
    const rows = JSON.parse(out)[0].results;
    expect(rows.length, "maps と結べないスポーンがある").toBe(9);
    for (const s of rows) {
      const points = JSON.parse(s.polygon);
      expect(points.length, `${s.id} の頂点数`).toBe(4);
      for (const [x, y] of points) {
        expect(x, `${s.id} の x`).toBeGreaterThan(0);
        expect(x, `${s.id} の x`).toBeLessThan(s.width_m);
        expect(y, `${s.id} の y`).toBeGreaterThan(0);
        expect(y, `${s.id} の y`).toBeLessThan(s.height_m);
      }
      const side = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
      expect(side, `${s.id} の一辺`).toBeGreaterThan(460);
      expect(side, `${s.id} の一辺`).toBeLessThan(500);
      expect(s.license, `${s.id} の license`).toContain("MIT");
      expect(s.source, `${s.id} の source`).toContain("apollyon-sys/wardogs-calculator");
    }
  });

  // ── コントロールエリアのプリセット（ゲームが決めた円）──────────────
  // 本番 D1 にだけ手で入れていた分を schema.sql に移した。環境を作り直すと
  // 消える状態だったため。**値**を見るのはここ。API から読めることは
  // tests/plan-zones.test.js（あちらは件数を数えず、この表を期待値にする）。
  //
  // 件数は数えない。試合のスクリーンショットが届くたびに増えていく。
  it("Zestafona の Default プリセットが seed として入っている", () => {
    const out = d1(
      `--command=SELECT id, map_id, key, x_m, y_m, radius_m, verified, source, measured_at
                   FROM map_zone_presets;`,
      "--json"
    );
    const def = JSON.parse(out)[0].results.find((r) => r.id === "zestafona-default");
    expect(def, "zestafona-default が無い").toBeTruthy();
    expect(def.map_id).toBe("zestafona");
    expect(def.key, "作戦が指す識別子").toBe("Default");
    expect(def.radius_m, "半径").toBe(500);
    // 出典のない数値を置かない（maps / map_towers と同じ規約）。
    expect(def.source, "source が無い").toBeTruthy();
    expect(def.measured_at, "measured_at が無い").toBeTruthy();
    // ゲーム内で測ったのではなく、スクリーンショットから読み取った値なので
    // 未検証のまま。ここが 1 になったら、実測の根拠を source に書くこと。
    expect(def.verified, "verified").toBe(0);
  });

  // この座標を信じてよい根拠が「円の中にタワーが3本とも入る」こと。
  // Zestafona の Default は全タワー対象という調査結果と、これで整合する。
  // 中心が 1km ずれたり x と y を取り違えたりすると、ここで落ちる。
  it("Zestafona の Default の円に、3本のタワーが全部入る", () => {
    const out = d1(
      `--command=SELECT t.id, t.x_m, t.y_m, p.x_m AS cx, p.y_m AS cy, p.radius_m AS r
                   FROM map_towers t
                   JOIN map_zone_presets p ON p.id = 'zestafona-default'
                  WHERE t.map_id = 'zestafona';`,
      "--json"
    );
    const rows = JSON.parse(out)[0].results;
    expect(rows.length, "Zestafona のタワー本数").toBe(3);
    for (const t of rows) {
      const d = Math.hypot(t.x_m - t.cx, t.y_m - t.cy);
      expect(d, `${t.id} が円の外（中心から ${Math.round(d)}m）`).toBeLessThan(t.r);
    }
  });
});
