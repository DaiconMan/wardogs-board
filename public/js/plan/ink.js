// インクのストロークを 0.1m 単位の整数に量子化し、差分符号化する。
// クライアントとサーバで同じ結果になる必要があるので、浮動小数の丸めは Math.round に統一する。
//
// EN: Quantises ink strokes to 0.1 m integers and delta-encodes them. The client and
//     the server have to agree bit for bit, so all float rounding goes through
//     Math.round. This file is the single implementation; functions/_lib/ink.js only
//     re-exports it.
//
// この実体は public/js/plan/ink.js に1つだけ置く。functions/_lib/ink.js は
// このファイルを再 export するだけで、ロジックは複製しない
// （量子化・符号化はクライアントとサーバで完全に一致していなければならないため）。

export const QUANTUM = 0.1;
export const MAX_POINTS = 10000;
const DEFAULT_EPSILON_M = 0.15;

function perpendicularDistance(p, a, b) {
  const dx = b.x_m - a.x_m;
  const dy = b.y_m - a.y_m;
  if (dx === 0 && dy === 0) return Math.hypot(p.x_m - a.x_m, p.y_m - a.y_m);
  const t = ((p.x_m - a.x_m) * dx + (p.y_m - a.y_m) * dy) / (dx * dx + dy * dy);
  const cx = a.x_m + t * dx;
  const cy = a.y_m + t * dy;
  return Math.hypot(p.x_m - cx, p.y_m - cy);
}

export function simplify(points, epsilonM = DEFAULT_EPSILON_M) {
  if (points.length <= 2) return points.slice();
  let maxDist = -1;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist <= epsilonM) return [first, last];
  const left = simplify(points.slice(0, index + 1), epsilonM);
  const right = simplify(points.slice(index), epsilonM);
  return left.slice(0, -1).concat(right);
}

export function encodePoints(points) {
  const out = [];
  let prevX = 0;
  let prevY = 0;
  points.forEach((p, i) => {
    const qx = Math.round(p.x_m / QUANTUM);
    const qy = Math.round(p.y_m / QUANTUM);
    out.push(i === 0 ? qx : qx - prevX, i === 0 ? qy : qy - prevY);
    prevX = qx;
    prevY = qy;
  });
  return out;
}

export function decodePoints(encoded) {
  const out = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < encoded.length; i += 2) {
    x = i === 0 ? encoded[0] : x + encoded[i];
    y = i === 0 ? encoded[1] : y + encoded[i + 1];
    out.push({ x_m: x * QUANTUM, y_m: y * QUANTUM });
  }
  return out;
}

export function validateEncoded(encoded, map) {
  if (!Array.isArray(encoded)) return "座標の形式が不正です";
  if (encoded.length % 2 !== 0) return "座標の個数が不正です";
  const count = encoded.length / 2;
  if (count < 2) return "線には2点以上が必要です";
  if (count > MAX_POINTS) return `点が多すぎます（${MAX_POINTS}点まで）`;
  for (const v of encoded) {
    if (typeof v !== "number" || !Number.isInteger(v)) return "座標が整数ではありません";
  }
  const maxX = Math.round(map.width_m / QUANTUM);
  const maxY = Math.round(map.height_m / QUANTUM);
  let x = 0;
  let y = 0;
  for (let i = 0; i < encoded.length; i += 2) {
    x = i === 0 ? encoded[0] : x + encoded[i];
    y = i === 0 ? encoded[1] : y + encoded[i + 1];
    if (x < 0 || y < 0 || x > maxX || y > maxY) return "座標がマップの範囲外です";
  }
  return null;
}

// 描画専用。保存する座標は平滑化しない（元の点を間引いたものを保存する）。
export function toSmoothPath(svgPoints) {
  if (svgPoints.length === 0) return "";
  if (svgPoints.length === 1) {
    const p = svgPoints[0];
    return `M ${p.x} ${p.y} L ${p.x} ${p.y}`;
  }
  const d = [`M ${svgPoints[0].x} ${svgPoints[0].y}`];
  for (let i = 0; i < svgPoints.length - 1; i += 1) {
    const p0 = svgPoints[i - 1] || svgPoints[i];
    const p1 = svgPoints[i];
    const p2 = svgPoints[i + 1];
    const p3 = svgPoints[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`);
  }
  return d.join(" ");
}
