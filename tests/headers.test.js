// public/_headers の中身を「意味」で検証する。
//
// 背景（本番で起きた事故）:
//   HTML は既定で max-age=0, must-revalidate だが、JS は既定で max-age=14400。
//   そのため「新しい HTML ＋ 4時間古い JS」という組み合わせが成立し、
//   ボタンは見えるのに押しても動かない、という状態が最大4時間続いた。
//   public/js/ を触るデプロイのたびに再発するので、_headers で塞ぐ。
//
// 文字列の丸ごと比較はしない（コメントの文言を変えただけで落ちるテストにしない）。
// ルールをパースし、「このパスに実際に当たるヘッダ」を組み立てて確かめる。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, "public");

/**
 * Cloudflare Pages の `_headers` を読む。
 * インデントの無い行がパス（ルール）、インデントされた行がそのヘッダ。
 * `#` から始まる行はコメント。
 */
function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    current.headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return rules;
}

/** `/js/*` のようなパターンを URL パスに当てる（`*` は任意の文字列）。 */
function matches(pattern, path) {
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
  );
  return re.test(path);
}

/** _headers は上から順に、最初に当たったルールが効く。 */
function firstMatch(rules, path) {
  return rules.find((r) => matches(r.pattern, path)) ?? null;
}

/** Cache-Control を { maxAge, flags } に分解する。 */
function parseCacheControl(value) {
  const flags = new Set();
  let maxAge = null;
  for (const partRaw of String(value ?? "").split(",")) {
    const part = partRaw.trim().toLowerCase();
    if (!part) continue;
    const m = part.match(/^max-age\s*=\s*(\d+)$/);
    if (m) {
      maxAge = Number(m[1]);
      continue;
    }
    flags.add(part);
  }
  return { maxAge, flags };
}

/** public/ 以下のファイルを再帰で集める（リポジトリ相対ではなく URL パスで返す）。 */
function listPublicPaths(dir = PUBLIC) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listPublicPaths(full));
    else out.push("/" + relative(PUBLIC, full).split(/[\\/]/).join("/"));
  }
  return out;
}

const RULES = parseHeadersFile(readFileSync(join(PUBLIC, "_headers"), "utf8"));

/** そのパスの Cache-Control が「毎回サーバに確認する」指定になっているか。 */
function requiresRevalidation(path) {
  const rule = firstMatch(RULES, path);
  if (!rule) return { ok: false, why: `${path} に当たるルールが無い（既定の max-age=14400 が効く）` };
  const cc = parseCacheControl(rule.headers["cache-control"]);
  if (cc.flags.has("immutable")) return { ok: false, why: `${path} は immutable 扱いになっている` };
  if (cc.maxAge === null || cc.maxAge > 0) {
    return { ok: false, why: `${path} の max-age が ${cc.maxAge}（0 である必要がある）` };
  }
  if (!cc.flags.has("must-revalidate") && !cc.flags.has("no-cache")) {
    return { ok: false, why: `${path} に must-revalidate / no-cache が無い` };
  }
  return { ok: true, why: "" };
}

describe("public/_headers", () => {
  it("JS は毎回再検証させる（古い JS ＋ 新しい HTML の組み合わせを作らない）", () => {
    const r = requiresRevalidation("/js/plan/app.js");
    expect(r.why).toBe("");
    expect(r.ok).toBe(true);
  });

  it("public/ 配下の JS・CSS・JSON はすべて再検証の対象になっている", () => {
    const targets = listPublicPaths().filter((p) => /\.(js|mjs|css|json)$/i.test(p));
    expect(targets.length).toBeGreaterThan(0);
    const bad = targets.map(requiresRevalidation).filter((r) => !r.ok).map((r) => r.why);
    expect(bad).toEqual([]);
  });

  it("マップ画像の長期キャッシュ（immutable）は維持されている", () => {
    for (const path of [
      "/map/tiles/bakurani/0/0/0.webp",
      "/map/tiles/ozeti/3/2/1.webp",
      "/map/overview/bakurani.webp",
    ]) {
      const rule = firstMatch(RULES, path);
      expect(rule, `${path} に当たるルールが無い`).not.toBeNull();
      const cc = parseCacheControl(rule.headers["cache-control"]);
      expect(cc.flags.has("immutable"), `${path} の immutable`).toBe(true);
      expect(cc.maxAge, `${path} の max-age`).toBeGreaterThanOrEqual(31536000);
    }
  });

  it("JS 用のルールがマップ画像のルールを食っていない（順序の回帰）", () => {
    const jsRule = firstMatch(RULES, "/js/plan/app.js");
    expect(jsRule).not.toBeNull();
    expect(matches(jsRule.pattern, "/map/overview/bakurani.webp")).toBe(false);
    expect(matches(jsRule.pattern, "/map/tiles/bakurani/0/0/0.webp")).toBe(false);
  });
});
