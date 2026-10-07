// テスト用の小さな API クライアント。
import { baseUrl } from "./config.js";

/**
 * テストごとにユニークな `cf-connecting-ip` を作る。
 * `ip_hash` が変わるのでレート制限（10分5件）のバケットが分離され、
 * テスト間の干渉が起きない。`fileId` はテストファイルごとに別の値を使う。
 */
export function ipGenerator(fileId) {
  let n = 0;
  return () => {
    n += 1;
    return `10.${fileId}.${(n >> 8) & 0xff}.${n & 0xff}`;
  };
}

async function request(server, path, init = {}) {
  const res = await fetch(baseUrl(server) + path, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text };
  }
  return { status: res.status, body };
}

export const getComments = (server) => request(server, "/api/comments");

export function postComment(server, payload, ip) {
  return request(server, "/api/comments", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(payload),
  });
}

export function deleteComment(server, id, authHeader) {
  const headers = {};
  if (authHeader !== undefined) headers.authorization = authHeader;
  return request(server, `/api/comments?id=${id}`, { method: "DELETE", headers });
}
