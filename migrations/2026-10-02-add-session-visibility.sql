-- 既存 DB 用。sessions に visibility（作戦ごとの公開設定）を足す。
--
-- 仕様: docs/superpowers/specs/2026-10-02-plan-visibility.md
--
--   private（既定） 一覧に出ない。**URL を知っている人は閲覧も書き込みもできる**
--   public          一覧に出る。閲覧だけ（作成者と admin 以外は書き込めない）
--   public_edit     一覧に出る。閲覧も書き込みもできる
--
-- **既存の行はすべて private になる**（NOT NULL + DEFAULT なので ALTER の時点で
-- 全行に 'private' が入る）。private は従来の挙動そのままなので、この migration
-- だけでは誰の使い方も変わらない。
--
-- `CHECK` は付けない（SQLite の ALTER では付けられない）。検査はアプリ側
-- （functions/_lib/visibility.js）で行う。schema.sql の CREATE TABLE 側にも
-- 同じ列と索引を足してある（新規 DB 用。片方だけだと形が食い違う）。
--
-- **push より先に本番へ流すこと**（D-036）。順序を逆にすると
-- `GET /api/sessions` が `no such column: visibility` で 500 になり、
-- 「新機能が出ない」ではなく**作戦の一覧そのものが開けなくなる**。
--
-- 2回流すと `duplicate column name: visibility` で止まる。それは適用済みの印。
ALTER TABLE sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';

-- 公開されている作戦を更新の新しい順に引く用（一覧の3つ目の群）。
-- CREATE INDEX IF NOT EXISTS なので2回流しても落ちない。
CREATE INDEX IF NOT EXISTS idx_sessions_public
  ON sessions (visibility, updated_at DESC);
