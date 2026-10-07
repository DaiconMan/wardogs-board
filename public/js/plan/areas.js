// エリア塗り（自陣・敵陣・中立・最重要・危険予測）の計算と描画。
//
// EN: Area painting (own / enemy / neutral / key / predicted-danger): computation and
//     drawing. Everything here is a judgement the team paints by hand. The circles the
//     game itself decides are real data and live in zones.js instead.
//
// **ここにあるのは全部「チームが手で塗る見立て」である。**
// ゲームが決めるもの（コントロールエリアの円＝半径500m、ホットゾーン＝半径85m）は
// 実データで、`map_zone_presets` / `session_zone` が持ち `#zone-preset` が円として
// 描く。手では描かない。以前はこちらにも「コントロールエリア」「ホットゾーン」と
// いう種類があり、**見た目が違うのに名前が同じ**という状態だった
// （shots/28-zone-vs-areas-*.png）。Discord で喋ったときどちらの話か決まらないので、
// 種類の名前をチームの語彙（最重要・危険予測）に貼り替えてある。
//
// 設計の要点（設計書 §3-A-1 / DECISIONS D-030）:
//
//   * 形は**ゲーム内と同じ 1km グリッドのセル集合**として持つ。多角形にしない。
//     1ジェスチャで広い面が塗れて、格子に揃うので必ず整って見え、A1〜P16 の
//     セル名という**既にチームが喋っている語彙**とそのまま一致する。
//   * データは**1ジェスチャ = 1行の追記型**（`op` が add / sub）。インク・配置と
//     同じ作法なので、取り消し・権限・冪等の仕組みをそのまま使える。
//     画面側は **id の昇順に op を適用**して現在の集合を得る。
//   * 256セル × 5種しかないので、行が増減したら毎回フル再計算でよい
//     （ズーム・パンでは呼ばない）。
//
// 単位: このモジュールが受け取る座標は SVG ユーザー単位（= メートル、y だけ反転済み）。
// 行（row）は**常に画面の上が 0**（サーバの `rects` も同じ数え方）。
// 保存の都合であって、**人に見せる行番号は下が 1**（coords.js の cellName が
// 総行数から引いて反転する）。ここを保存側まで反転させると、既に保存してある
// 塗りの意味が変わってしまうので、変換は表示の1箇所だけに閉じてある。

/**
 * 種類は5つ。前半3つが**勢力圏**（誰の土地と見るか）、後半2つが**チームの判断**
 * （そこをどう扱うか）。上限は6種で、5つに留めてあるのは、色を新しく足さずに
 * **色とパターンの二重符号化**を保てる組み合わせがここまでだから
 * （残っているトークンはどれも別の意味に使われている）。
 *
 * 色は `plan.html` の `--area-*` が既存トークンへ割り当てる。ここには持たない
 * （見た目の割り当ては CSS 側 1 箇所にまとめる）。
 *
 *   own     自陣       --blue  ベタ塗り
 *   enemy   敵陣       --red   斜線     （D-030 決定6）
 *   neutral 中立       --muted 塗らない・破線
 *   key     最重要     --green 点描     オーナーの言葉「最重要エリア」。優先して
 *                                       取る／守る所。軍用図の key terrain にあたる
 *   risk    危険予測   --hot   格子     撃ち合いになりそう・近づくと危ない所。
 *                                       `--hot` は「未確認・未検証」の色で、
 *                                       **これが予測であって事実でない**ことと合う
 */
export const AREA_KINDS = [
  { kind: "own", label: "自陣" },
  { kind: "enemy", label: "敵陣" },
  { kind: "neutral", label: "中立" },
  { kind: "key", label: "最重要" },
  { kind: "risk", label: "危険予測" },
];

/** 表示名。未知の種類が来ても黙って隠さず、生の値を出す。 */
export const areaLabel = (kind) =>
  AREA_KINDS.find((k) => k.kind === kind)?.label ?? kind ?? "不明";

/**
 * 塗りパターンの一辺（CSS px）。
 *
 * SVG の `<pattern>` は画面固定にならないので、`applyView()` が
 * `width` / `height` を `PATTERN_PX * metersPerPx()` に書き換える
 * （マーカーの `scale` と同じ手口）。寄っても斜線の間隔が変わらない。
 */
export const PATTERN_PX = 8;

/** 種類名の文字の大きさ（CSS px）。こちらも画面固定にする。 */
export const AREA_NAME_PX = 13;

/**
 * 種類名を地図に出す視野の広さ（メートル）。これ**より広い**ときだけ出す。
 *
 * 寄って見ているときは何のエリアかは色とパターンで分かっていて、文字は邪魔に
 * なるだけ。セル名を地図の上に出す境目（gutter.js の 2000m）と同じ値にして、
 * 「どこまで寄れば何が出るか」を覚え直さずに済むようにする。
 */
export const AREA_NAME_VIEW_M = 2000;

/** セル番号は行優先。`grid` は `{ cols, rows, cellM }`。 */
export const cellIndex = (col, row, grid) => row * grid.cols + col;

/** 集合にそのセルが入っているか（1セルのトグルが add か sub かをこれで決める）。 */
export const hasCell = (sets, kind, col, row, grid) =>
  sets.get(kind)?.has(cellIndex(col, row, grid)) ?? false;

/** 行を適用する順番。まだ id の無い行（自分が今塗ったぶん）は必ず最後。 */
const orderOf = (row) => (Number.isInteger(row?.id) ? row.id : Number.MAX_SAFE_INTEGER);

/**
 * 行の一覧から、種類ごとのセル集合を作る。
 *
 * `list` はサーバから来た行と、自分が今塗った行（id はまだ null）が混ざっていてよい。
 * **id の昇順**に走査して `op` が `add` なら和、`sub` なら差を取る。
 *
 * 壊れた行は読み飛ばす（`strokes` と同じ方針。1行のせいで地図全体を落とさない）。
 * `cell_m` がこのグリッドと違う行も、1km の格子に載せられないので読み飛ばす
 * （UI は 1000 しか作らないので、これは将来の刻み変更に対する防波堤）。
 */
export function buildAreaSets(list, grid) {
  const sets = new Map(AREA_KINDS.map((k) => [k.kind, new Set()]));
  const ordered = [...(list ?? [])].sort((a, b) => orderOf(a) - orderOf(b));
  for (const row of ordered) {
    const set = sets.get(row?.kind);
    if (!set) continue;                                   // 未知の種類
    if ((row.cell_m ?? grid.cellM) !== grid.cellM) continue;
    if (!Array.isArray(row.rects)) continue;
    const sub = row.op === "sub";
    for (const rect of row.rects) {
      if (!Array.isArray(rect) || rect.length !== 4) continue;
      if (!rect.every((v) => Number.isInteger(v))) continue;
      const [c0, r0, c1, r1] = rect;
      // 盤の外へはみ出したぶんは切り落とす（サーバは 400 で弾くので通常は来ない）。
      for (let r = Math.max(0, r0); r <= Math.min(grid.rows - 1, r1); r += 1) {
        for (let c = Math.max(0, c0); c <= Math.min(grid.cols - 1, c1); c += 1) {
          const i = cellIndex(c, r, grid);
          if (sub) set.delete(i);
          else set.add(i);
        }
      }
    }
  }
  return sets;
}

/** セル番号 → そのセルの左上（SVG ユーザー単位）。 */
const cellOrigin = (i, grid) => ({
  x: (i % grid.cols) * grid.cellM,
  y: Math.floor(i / grid.cols) * grid.cellM,
});

/**
 * 集合の全セルを1本の path にまとめた `d`。
 * セルごとに `M…h…v…h…Z` の部分パスを並べる（矩形を 256 個の要素にしない）。
 */
export function fillPathData(set, grid) {
  const s = grid.cellM;
  const out = [];
  for (const i of [...set].sort((a, b) => a - b)) {
    const { x, y } = cellOrigin(i, grid);
    out.push(`M ${x} ${y} h ${s} v ${s} h ${-s} Z`);
  }
  return out.join(" ");
}

/**
 * **外周だけ**の `d`。集合の各セルについて、隣に仲間がいない辺だけを引く。
 *
 * 全セルを縁取ると格子が二重に見えて、1km グリッドとエリアの境目が読めなくなる。
 * 太さは `vector-effect:non-scaling-stroke` で画面固定にする（CSS 側）。
 */
export function edgePathData(set, grid) {
  const s = grid.cellM;
  const out = [];
  const inside = (col, row) =>
    col >= 0 && row >= 0 && col < grid.cols && row < grid.rows &&
    set.has(cellIndex(col, row, grid));

  for (const i of [...set].sort((a, b) => a - b)) {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    const { x, y } = cellOrigin(i, grid);
    if (!inside(col, row - 1)) out.push(`M ${x} ${y} L ${x + s} ${y}`);
    if (!inside(col, row + 1)) out.push(`M ${x} ${y + s} L ${x + s} ${y + s}`);
    if (!inside(col - 1, row)) out.push(`M ${x} ${y} L ${x} ${y + s}`);
    if (!inside(col + 1, row)) out.push(`M ${x + s} ${y} L ${x + s} ${y + s}`);
  }
  return out.join(" ");
}

/**
 * 種類名を置く位置。集合の重心に**いちばん近いセルの中心**を返す。
 *
 * 重心そのものに置かないのは、L 字や飛び地では重心が集合の外に落ちて、
 * 何も塗っていない所に名前が浮くため。空の集合では null。
 */
export function labelAnchor(set, grid) {
  if (set.size === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const i of set) {
    sx += (i % grid.cols) + 0.5;
    sy += Math.floor(i / grid.cols) + 0.5;
  }
  const cx = sx / set.size;
  const cy = sy / set.size;

  let best = null;
  let bestD = Infinity;
  for (const i of [...set].sort((a, b) => a - b)) {
    const dx = (i % grid.cols) + 0.5 - cx;
    const dy = Math.floor(i / grid.cols) + 0.5 - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  const { x, y } = cellOrigin(best, grid);
  return { x: x + grid.cellM / 2, y: y + grid.cellM / 2 };
}

/** 塗ってある種類だけの件数。パネルの集計と、読み上げに使う。 */
export function areaCounts(sets) {
  const out = [];
  for (const { kind, label } of AREA_KINDS) {
    const cells = sets.get(kind)?.size ?? 0;
    if (cells > 0) out.push({ kind, label, cells });
  }
  return out;
}

/** 「自陣 12マス ／ 敵陣 8マス」。何も無いときも黙らない。 */
export function countText(sets) {
  const counts = areaCounts(sets);
  if (counts.length === 0) return "まだ塗っていません";
  return counts.map((c) => `${c.label} ${c.cells}マス`).join(" ／ ");
}

/**
 * SVG 座標からセルを引く。盤の外は null（丸めない）。
 * 右端・下端はぴったりの値でも最後のセルに入れる（縁を押して外扱いにしない）。
 */
export function cellAtSvg({ x, y }, grid) {
  if (x < 0 || y < 0 || x > grid.cols * grid.cellM || y > grid.rows * grid.cellM) return null;
  const col = Math.min(grid.cols - 1, Math.floor(x / grid.cellM));
  const row = Math.min(grid.rows - 1, Math.floor(y / grid.cellM));
  return { col, row };
}

/** 押した所と離した所から、向きによらない `[c0,r0,c1,r1]` を作る。 */
export const normalizeRect = (a, b) => [
  Math.min(a.col, b.col), Math.min(a.row, b.row),
  Math.max(a.col, b.col), Math.max(a.row, b.row),
];

/** 矩形の大きさ。 */
export function rectSize([c0, r0, c1, r1]) {
  const w = c1 - c0 + 1;
  const h = r1 - r0 + 1;
  return { w, h, cells: w * h };
}

/** ドラッグ中に出す「3×2 = 6マス」。何マス塗ろうとしているかを離す前に見せる。 */
export function rectText(rect) {
  const { w, h, cells } = rectSize(rect);
  return `${w}×${h} = ${cells}マス`;
}
