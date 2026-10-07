// 陣営スポーン（セーフゾーン）の見せ方。
//
// EN: Faction spawn (safe zone) presentation. Like drill towers these belong to the
//     map. Three factions, each roughly a 480 m rotated square, so they are drawn as
//     polygons at true scale in metres rather than as screen-fixed points.
//
// ドリルタワーと同じく**マップが持っている物**で、チームが置いた物ではない。
// 3陣営（Lonestar / Manticore / Valkyra）の基地で、**一辺およそ 480m の
// 回転した正方形**（調査 §3.1・§3.3）。形があるので点ではなく多角形で描く。
//
// タワー（画面固定の大きさ）と違い、**こちらは実寸（メートル）で描く。**
// 480m は地図の上で意味のある大きさなので、ズームで伸縮しなければ嘘になる
// （射程リングと同じ考え方）。
//
// 単位: このモジュールが受け取る座標は SVG ユーザー単位（= メートル、y だけ反転済み）。

const SVG_NS = "http://www.w3.org/2000/svg";

/** 陣営の表示名。DB にも持っているが、行が壊れていても名前だけは出せるようにする。 */
export const FACTION_LABELS = {
  lonestar: "ローンスター",
  manticore: "マンティコア",
  valkyra: "ヴァルキラ",
};

/** 色を持つのは CSS 側（既存トークンへの割り当て）。ここは名前だけ扱う。 */
export const factionLabel = (faction) => FACTION_LABELS[faction] ?? faction ?? "不明";

/**
 * 多角形の重心（頂点の平均）。名前を置く位置に使う。
 * 4点の凸な正方形なので、頂点の平均で十分に中心へ来る。
 */
export function centroid(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/**
 * 保存されている多角形（JSON 文字列でも配列でも受ける）を
 * `[{x_m, y_m}, ...]` に正す。壊れていれば null（その1件を描かないだけにする）。
 */
export function parsePolygon(raw) {
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(list) || list.length < 3) return null;
  const out = [];
  for (const p of list) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [x_m, y_m] = p;
    if (!Number.isFinite(x_m) || !Number.isFinite(y_m)) return null;
    out.push({ x_m, y_m });
  }
  return out;
}

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * スポーン 1 件。`toSvg` はメートル → SVG ユーザー単位（coords.js）。
 * 中身は3つ: 下敷きの輪郭・本体の多角形・中心の陣営名。
 * 名前だけは画面固定の大きさにするので、別の <g> に入れて scale を当てる。
 */
export function createSpawn(spawn, toSvg) {
  const points = parsePolygon(spawn.polygon);
  if (!points) return null;

  const g = el("g", { class: "sp" });
  g.dataset.faction = spawn.faction;
  g.dataset.spawnId = String(spawn.id);

  const d = points.map((p) => {
    const s = toSvg(p);
    return `${s.x} ${s.y}`;
  }).join(" L ");
  const path = `M ${d} Z`;
  g.appendChild(el("path", { class: "sp-halo", d: path }));
  g.appendChild(el("path", { class: "sp-shape", d: path }));

  const at = centroid(points.map(toSvg));
  const label = el("g", { class: "sp-label" });
  label.setAttribute("transform", `translate(${at.x} ${at.y})`);
  const text = el("text", {
    class: "sp-name",
    x: 0,
    y: 0,
    "text-anchor": "middle",
    "dominant-baseline": "central",
  });
  text.textContent = spawn.name || factionLabel(spawn.faction);
  label.appendChild(text);
  g.appendChild(label);

  const title = el("title", {});
  title.textContent = `${text.textContent}（陣営スポーン・マップ固定）`;
  g.appendChild(title);
  return g;
}

/**
 * 陣営名の大きさを画面基準に戻す。多角形そのものは実寸なので触らない
 * （文字だけがズームで巨大化するのを防ぐ）。
 */
export function setSpawnLabelScale(node, metersPerPx) {
  const label = node.querySelector(".sp-label");
  if (!label) return;
  const t = label.getAttribute("transform").match(/translate\(([-\d.]+) ([-\d.]+)\)/);
  if (!t) return;
  label.setAttribute("transform", `translate(${t[1]} ${t[2]}) scale(${metersPerPx})`);
}
