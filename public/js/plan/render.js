// SVG 要素の組み立て。DOM を触るのはここと app.js だけにする。
//
// EN: Builds the SVG elements. Only this file and app.js are allowed to touch the DOM.

import { toSmoothPath } from "./ink.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 保存済みのストロークを描く。
 *
 * 色は `style` 経由で `var(--cursor-N)` を当てる。プレゼンテーション属性
 * （`stroke="var(--x)"`）に custom property を書くのはブラウザ依存なので、
 * 確実に解決されるインラインスタイルにしている。
 */
export function applyStrokeStyle(path, { color, width }) {
  path.setAttribute("fill", "none");
  path.setAttribute("stroke-width", String(width * 2));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  path.style.setProperty("stroke", `var(--${color})`);
  return path;
}

export function createStrokePath({ color, width }) {
  return applyStrokeStyle(document.createElementNS(SVG_NS, "path"), { color, width });
}

export function renderStroke(stroke, coords) {
  const path = createStrokePath(stroke);
  path.setAttribute("d", toSmoothPath(stroke.points.map((p) => coords.toSvg(p))));
  path.dataset.strokeId = String(stroke.id ?? "");
  path.dataset.owner = stroke.created_by ?? "";
  return path;
}

export function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
