// 最小の WebSocket クライアント（RFC 6455 のうち必要な所だけ）。
//
// **なぜ自作するのか。** `ws` を devDependencies に足せば済むが、
//   * Node の `fetch`（undici）は `Upgrade` ヘッダを「invalid upgrade header」で拒否する（実測）
//   * ブラウザを立てずに20本の接続を張って負荷を測りたい（Phase R0 の出口条件1）
//   * 依存を増やさない（CLAUDE.md「フレームワークやビルド工程を足さない」の精神）
// の3つが重なる。テキストフレームと close/ping/pong だけ扱えれば足りるので短い。
//
// 使う所: tools/ws-load.mjs（負荷の実測）、tests/*.test.js（ハンドシェイクの検証）。
// 製品コードは使わない（ブラウザには WebSocket がある）。
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * 1本つなぐ。戻り値は { status, messages, closed, send, close, onMessage }。
 * 101 以外なら { status, body } を返して socket は持たない。
 */
export function connect(url, { headers = {}, timeoutMs = 20_000 } = {}) {
  const u = new URL(url);
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  const key = randomBytes(16).toString("base64");
  const expected = createHash("sha1").update(key + GUID).digest("base64");

  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)({
      host: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": key,
        ...headers,
      },
    });

    // 101 にならなかった場合（401 / 403 / 404 / 503 など）。
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });

    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        reject(new Error("Sec-WebSocket-Accept が一致しない"));
        return;
      }
      resolve(makeConnection(res, socket, head));
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`ハンドシェイクがタイムアウト: ${url}`)));
    req.end();
  });
}

function makeConnection(res, socket, head) {
  const messages = [];
  const listeners = [];
  const conn = {
    status: 101,
    messages,
    closed: null, // { code, reason } が入る
    onMessage: (fn) => listeners.push(fn),
    send: (text) => socket.write(encodeFrame(0x1, Buffer.from(text, "utf8"))),
    ping: () => socket.write(encodeFrame(0x9, Buffer.alloc(0))),
    close: (code = 1000) => {
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      try {
        socket.write(encodeFrame(0x8, body));
      } catch {
        /* 既に切れている */
      }
      socket.end();
    },
    destroy: () => socket.destroy(),
  };

  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = decodeFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.size);
      if (frame.opcode === 0x1) {
        const text = frame.payload.toString("utf8");
        messages.push(text);
        for (const fn of listeners) fn(text);
      } else if (frame.opcode === 0x8) {
        conn.closed = {
          code: frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005,
          reason: frame.payload.subarray(2).toString("utf8"),
        };
        socket.end();
      } else if (frame.opcode === 0x9) {
        socket.write(encodeFrame(0xa, frame.payload));
      }
    }
  });
  socket.on("close", () => {
    if (!conn.closed) conn.closed = { code: 1006, reason: "" };
  });
  socket.on("error", () => {
    if (!conn.closed) conn.closed = { code: 1006, reason: "" };
  });
  return conn;
}

/** クライアント → サーバのフレームは必ずマスクする。 */
function encodeFrame(opcode, payload) {
  const mask = randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) {
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

/** サーバ → クライアントのフレームはマスクされない。足りなければ null。 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
  return { opcode, payload, size: offset + len };
}

/** 条件が満たされるまで待つ小道具。 */
export async function waitFor(fn, { timeoutMs = 10_000, everyMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor がタイムアウトした");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
