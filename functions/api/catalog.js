import { json } from "../_lib/validate.js";
import { requireViewer } from "../_lib/guard.js";

export async function onRequestGet(context) {
  const auth = await requireViewer(context);
  if (auth.response) return auth.response;

  // verified / source / notes も一緒に返す。数値は現時点で全項目 NULL なので、
  // UI 側が「未実測」と「何が分かっていないか」を出せないと誤読される。
  const { results } = await context.env.DB.prepare(
    `SELECT id, kind, name_ja, name_en,
            footprint_w_m, footprint_h_m, height_m,
            range_min_m, range_max_m, cost_supplies, build_seconds, crew,
            notes, source, measured_at, patch, verified, sort_order
       FROM catalog_items
      ORDER BY sort_order ASC, id ASC`
  ).all();
  return json({ items: results });
}
