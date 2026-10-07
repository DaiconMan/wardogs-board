// /api/comments の統合テスト（base インスタンス: Turnstile なし / BLOCKED_WORDS なし）
import { describe, it, expect } from "vitest";
import { ADMIN_TOKEN } from "./config.js";
import { getComments, postComment, deleteComment, ipGenerator } from "./helpers.js";

const SERVER = "base";
const nextIp = ipGenerator(1);

describe("GET /api/comments", () => {
  // [1]
  it("200 で {comments: [...]} を返す", async () => {
    const { status, body } = await getComments(SERVER);
    expect(status).toBe(200);
    expect(Array.isArray(body.comments)).toBe(true);
  });
});

describe("POST /api/comments 正常系", () => {
  // [2]
  it("201 で comment に id / section / body / created_at が入る", async () => {
    const { status, body } = await postComment(
      SERVER,
      { section: "general", name: "投稿者1", body: "テスト投稿 [2]" },
      nextIp()
    );
    expect(status).toBe(201);
    expect(body.comment).toBeTruthy();
    expect(typeof body.comment.id).toBe("number");
    expect(body.comment.section).toBe("general");
    expect(body.comment.body).toBe("テスト投稿 [2]");
    expect(typeof body.comment.created_at).toBe("number");
  });

  // [3]
  // **「名無しの青」ではない。** チーム色に寄らない名前へ揃える改名の一部
  // （wardogs-blue → wardogs-board）。既定値を「青」に戻すと、どの陣営でも
  // 使える道具のはずのサイトで、投稿者が全員「青」を名乗ることになる。
  it("name 省略なら 名無し になる", async () => {
    const omitted = await postComment(SERVER, { section: "general", body: "name 省略 [3]" }, nextIp());
    expect(omitted.status).toBe(201);
    expect(omitted.body.comment.name).toBe("名無し");

    const empty = await postComment(SERVER, { section: "general", name: "", body: "name 空文字 [3]" }, nextIp());
    expect(empty.status).toBe(201);
    expect(empty.body.comment.name).toBe("名無し");

    const blank = await postComment(SERVER, { section: "general", name: "   ", body: "name 空白のみ [3]" }, nextIp());
    expect(blank.status).toBe(201);
    expect(blank.body.comment.name).toBe("名無し");
  });

  // [4]
  it("投稿後の GET 一覧にその投稿が含まれる", async () => {
    const marker = `一覧確認 [4] ${Date.now()}-${Math.random()}`;
    const posted = await postComment(SERVER, { section: "flow", body: marker }, nextIp());
    expect(posted.status).toBe(201);

    const { status, body } = await getComments(SERVER);
    expect(status).toBe(200);
    const found = body.comments.find((c) => c.id === posted.body.comment.id);
    expect(found).toBeTruthy();
    expect(found.body).toBe(marker);
    expect(found.section).toBe("flow");
  });

  // [10]
  it("同じ章のトップレベルコメントを指す parent_id は 201 で通る", async () => {
    const ip = nextIp();
    const parent = await postComment(SERVER, { section: "fob", body: "親 [10]" }, ip);
    expect(parent.status).toBe(201);

    const reply = await postComment(
      SERVER,
      { section: "fob", body: "返信 [10]", parent_id: parent.body.comment.id },
      ip
    );
    expect(reply.status).toBe(201);
    expect(reply.body.comment.parent_id).toBe(parent.body.comment.id);
  });
});

describe("POST /api/comments 異常系", () => {
  // [5]
  it("本文が空なら 400", async () => {
    const ip = nextIp();
    const missing = await postComment(SERVER, { section: "general" }, ip);
    expect(missing.status).toBe(400);

    const empty = await postComment(SERVER, { section: "general", body: "" }, ip);
    expect(empty.status).toBe(400);

    const blank = await postComment(SERVER, { section: "general", body: "   \n  " }, ip);
    expect(blank.status).toBe(400);
  });

  // [6]
  it("本文 1000 文字は 201、1001 文字は 400（境界）", async () => {
    const ok = await postComment(SERVER, { section: "general", body: "あ".repeat(1000) }, nextIp());
    expect(ok.status).toBe(201);
    expect(ok.body.comment.body.length).toBe(1000);

    const tooLong = await postComment(SERVER, { section: "general", body: "あ".repeat(1001) }, nextIp());
    expect(tooLong.status).toBe(400);
  });

  // [7]
  it("SECTIONS に無い章なら 400", async () => {
    const ip = nextIp();
    const nope = await postComment(SERVER, { section: "nope", body: "不正な章 [7]" }, ip);
    expect(nope.status).toBe(400);

    const missing = await postComment(SERVER, { body: "章なし [7]" }, ip);
    expect(missing.status).toBe(400);
  });

  // [8]
  it("parent_id が別の章のコメントを指すなら 400", async () => {
    const ip = nextIp();
    const parent = await postComment(SERVER, { section: "premise", body: "別章の親 [8]" }, ip);
    expect(parent.status).toBe(201);

    const reply = await postComment(
      SERVER,
      { section: "general", body: "章違いの返信 [8]", parent_id: parent.body.comment.id },
      ip
    );
    expect(reply.status).toBe(400);
  });

  // [9]
  it("parent_id がトップレベルでないコメント（返信）を指すなら 400", async () => {
    const ip = nextIp();
    const parent = await postComment(SERVER, { section: "build", body: "親 [9]" }, ip);
    expect(parent.status).toBe(201);

    const reply = await postComment(
      SERVER,
      { section: "build", body: "返信 [9]", parent_id: parent.body.comment.id },
      ip
    );
    expect(reply.status).toBe(201);
    expect(reply.body.comment.parent_id).toBe(parent.body.comment.id);

    const nested = await postComment(
      SERVER,
      { section: "build", body: "返信への返信 [9]", parent_id: reply.body.comment.id },
      ip
    );
    expect(nested.status).toBe(400);
  });
});

describe("レート制限", () => {
  // [11]
  it("同一 IP からの 6 件目が 429", async () => {
    const ip = nextIp();
    for (let i = 1; i <= 5; i += 1) {
      const res = await postComment(SERVER, { section: "open", body: `レート制限 [11] ${i}` }, ip);
      expect(res.status, `${i} 件目は成功するはず`).toBe(201);
    }
    const sixth = await postComment(SERVER, { section: "open", body: "レート制限 [11] 6" }, ip);
    expect(sixth.status).toBe(429);
  });
});

describe("DELETE /api/comments", () => {
  // [12]
  it("Authorization ヘッダ無しなら 401", async () => {
    const posted = await postComment(SERVER, { section: "recon", body: "削除対象 [12]" }, nextIp());
    expect(posted.status).toBe(201);

    const res = await deleteComment(SERVER, posted.body.comment.id);
    expect(res.status).toBe(401);
  });

  // [13]
  it("間違ったトークンなら 401", async () => {
    const posted = await postComment(SERVER, { section: "recon", body: "削除対象 [13]" }, nextIp());
    expect(posted.status).toBe(201);

    const res = await deleteComment(SERVER, posted.body.comment.id, "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  // [14]
  it("正しい ADMIN_TOKEN なら 200 で、その投稿への返信も一緒に消える", async () => {
    const ip = nextIp();
    const parent = await postComment(SERVER, { section: "attack", body: "親 [14]" }, ip);
    expect(parent.status).toBe(201);
    const reply = await postComment(
      SERVER,
      { section: "attack", body: "返信 [14]", parent_id: parent.body.comment.id },
      ip
    );
    expect(reply.status).toBe(201);

    const parentId = parent.body.comment.id;
    const replyId = reply.body.comment.id;

    const before = await getComments(SERVER);
    expect(before.body.comments.some((c) => c.id === parentId)).toBe(true);
    expect(before.body.comments.some((c) => c.id === replyId)).toBe(true);

    const res = await deleteComment(SERVER, parentId, `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const after = await getComments(SERVER);
    expect(after.body.comments.some((c) => c.id === parentId)).toBe(false);
    expect(after.body.comments.some((c) => c.id === replyId)).toBe(false);
  });
});
