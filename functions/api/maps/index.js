import { json } from "../../_lib/validate.js";
import { requireViewer } from "../../_lib/guard.js";

export async function onRequestGet(context) {
  const auth = await requireViewer(context);
  if (auth.response) return auth.response;

  // **想定するパターンも一緒に返す。**
  //
  // 作戦の一覧は「マップ × パターン」の枠を、**空いている枠も含めて**並べる
  // （D-046。作戦は 9〜12 個作ったら終わりで、あとは何度も開くもの）。
  // 枠の総数はプリセットの件数で決まり、件数は今後も増減するので、
  // **画面側に 9 と書かない。**ここから降りてきた行数だけ枠を描く。
  //
  // マップごとに `/api/maps/{id}/zone-presets` を叩かないのは、一覧を開くたびに
  // マップの数だけ往復が増えるため。1回のクエリで足りる。
  //
  // 返すのは**枠の見出しに要る列だけ**（座標も半径も一覧では使わない）。
  // 盤面が使う全列は `/api/maps/{id}/zone-presets` の担当のまま。
  const [maps, presets] = await context.env.DB.batch([
    context.env.DB.prepare(
      `SELECT id, name, width_m, height_m, y_axis_down, verified, source, measured_at, patch
         FROM maps ORDER BY id ASC`
    ),
    context.env.DB.prepare(
      `SELECT id, map_id, key, name, sort_order
         FROM map_zone_presets ORDER BY map_id ASC, sort_order ASC, id ASC`
    ),
  ]);

  // 1件も無いマップは**空配列**にする（null や欠落にしない）。
  // 画面側で「枠が0個のマップ」を素直に書けるようにするため。
  const byMap = new Map(maps.results.map((m) => [m.id, []]));
  for (const p of presets.results) byMap.get(p.map_id)?.push(p);

  return json({
    maps: maps.results.map((m) => ({ ...m, presets: byMap.get(m.id) ?? [] })),
  });
}
