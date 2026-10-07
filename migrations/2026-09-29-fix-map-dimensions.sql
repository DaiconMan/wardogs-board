-- マップの一辺と y 軸の向きを訂正する。
--   一辺: 16,000m → 16,320 / 16,320 / 16,384m
--   y 軸: y_axis_down 1 → 0（ゲームは左下が 0,0 で y は上に増える）
--
-- なぜ必要か:
--   schema.sql の maps は `INSERT OR IGNORE` なので、**既にある行は書き換わらない**。
--   本番の D1 には 16000 のまま残るため、この UPDATE を1回だけ流す必要がある。
--
-- 何が誤りだったか（docs/research/2026-09-29-zones-drills-data.md §3.5）:
--   16,000m はコミュニティサイト1件の「256 km²」「対角 22.6 km」からの逆算値。
--   実際はネイティブのマップ画像のピクセル数 × worldUnitsPerPixel（UE単位 = cm）で
--     Bakurani  16,384px × 99.609375cm  = 16,320m
--     Ozeti     32,768px × 49.8046875cm = 16,320m
--     Zestafona 32,768px × 50cm         = 16,384m
--   **2% ずれている**（16km 端で 320〜384m）。
--
-- y 軸の向き（オーナーがゲーム内で確認、2026-09-29）:
--   ゲーム内座標は**左下が 0,0 ／ x は右 ／ y は上**に増える。1単位 = 100m。
--   裏取り: Zestafona の Tower 3 にカーソルを合わせると x70.01 y100.31 と出る。
--   MIT データ（apollyon-sys/wardogs-calculator）の値は (7017.3, 10017.2) で、
--   16m / 14m の差で一致する。**この引き算は高さが 16,384m のときだけ成立する**ので、
--   寸法の訂正そのものの裏付けにもなっている。
--   よって y_m はゲームと同じ向きで持ち、上下の反転は描画のときだけ行う
--   （SVG は上が 0。coords.js の flip = !y_axis_down）。
--
-- 既存データへの影響（**2種類ある。どちらもこの migration では直さない**）:
--   1. 寸法: 既存の座標は「16,000m 四方」を前提にメートルで入っている。
--      寸法だけを広げると、既存の点は地図に対して 2% ぶんずれて見える。
--   2. y 軸: y_axis_down を 0 にすると、既存の y_m の**意味が上下逆になる**。
--      既存の点（placements / ink_strokes / session_callouts / callouts）は
--      上下が反転した位置に描かれる。`y_m_new = 高さ - y_m_old` で直せるが、
--      **変換するかどうかは PM の判断**なので、ここではやらない。
--      session_areas の rects は SVG の行番号で持っているので影響を受けない
--      （見た目の位置は変わらない。行の**呼び名**だけが下から数える形に変わる）。
--
-- 流し方は migrations/README.md を参照。**実行は PM の判断を仰いでから。**
UPDATE maps SET
  width_m     = 16320.0,
  height_m    = 16320.0,
  y_axis_down = 0,
  source      = 'ネイティブ画像 16,384px × worldUnitsPerPixel 99.609375cm = 16,320m（worldBoundsMin の X 幅 1,632,000cm と一致）。文章側も「Bakurani is a 16.32 km square」。docs/research/2026-09-29-zones-drills-data.md §3.5。ゲーム内未実測',
  measured_at = '2026-09-29',
  patch       = 'CL-499480'
WHERE id = 'bakurani';

UPDATE maps SET
  width_m     = 16320.0,
  height_m    = 16320.0,
  y_axis_down = 0,
  source      = 'ネイティブ画像 32,768px × worldUnitsPerPixel 49.8046875cm = 16,320m。docs/research/2026-09-29-zones-drills-data.md §3.5。ゲーム内未実測',
  measured_at = '2026-09-29',
  patch       = 'CL-499480'
WHERE id = 'ozeti';

UPDATE maps SET
  width_m     = 16384.0,
  height_m    = 16384.0,
  y_axis_down = 0,
  source      = 'ネイティブ画像 32,768px × worldUnitsPerPixel 50cm = 16,384m（worldBoundsMin [-819200,-819200] = ±8,192m とちょうど一致）。文章側も「Zestafona runs 16.4 km on a side」。docs/research/2026-09-29-zones-drills-data.md §3.5。ゲーム内未実測',
  measured_at = '2026-09-29',
  patch       = 'CL-499480'
WHERE id = 'zestafona';
