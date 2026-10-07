-- placements に rank（取得の優先度 1〜9、NULL は順位なし）を足す。
--
-- 新規DB には schema.sql の CREATE TABLE placements の定義に rank が入っているので、
-- このファイルを流す必要は無い。既に placements を作ってある DB にだけ1回流す。
-- 手順と流すタイミングは migrations/README.md を参照。
--
-- NULL 許容列の追加なので既存データは書き換わらない。2回流すと
-- "duplicate column name: rank" で失敗する（＝既に当たっている印）。
ALTER TABLE placements ADD COLUMN rank INTEGER;
