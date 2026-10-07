// セッション Cookie の署名と検証。
// D1 にセッション表を持たず、HMAC-SHA256 で署名した Cookie だけで状態を持つ。
//
// EN: Signs and verifies the session cookie. There is no session table in D1: the
//     whole of the state is carried by a cookie signed with HMAC-SHA256.

export const SESSION_COOKIE = "wb_session";
export const STATE_COOKIE = "__Host-wb_state";
export const MAX_NAME_LEN = 32;

const enc = new TextEncoder();

const b64urlEncode = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (str) => {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signSession(payload, secret) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64urlEncode(await hmac(body, secret))}`;
}

export async function verifySession(token, secret, nowSec) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  try {
    const expected = await hmac(body, secret);
    if (!timingSafeEqual(b64urlDecode(sig), expected)) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (typeof payload?.e !== "number" || payload.e <= nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildSessionCookie(token, maxAgeSec) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function buildStateCookie(state) {
  return `${STATE_COOKIE}=${state}; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearStateCookie() {
  return `${STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}
