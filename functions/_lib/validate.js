// 入力検証。JSON から来る値は型が保証されないので、すべてここで潰す。
//
// EN: Input validation. Values arriving as JSON carry no type guarantee, so every one
//     of them is narrowed here.

export const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });

export function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function validText(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || [...t].length > max) return null;
  return t;
}

export function blockedWords(env) {
  return String(env.BLOCKED_WORDS || "")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
}

export function blockedBy(env, ...texts) {
  const words = blockedWords(env);
  if (!words.length) return false;
  return texts.some((t) => {
    if (typeof t !== "string") return false;
    const lowered = t.toLowerCase();
    return words.some((w) => lowered.includes(w));
  });
}
