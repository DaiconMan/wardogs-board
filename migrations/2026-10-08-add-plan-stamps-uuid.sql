-- plan_stamps に client_uuid を足す（スタンプ 第1段）。
--
-- このリポジトリは「再送しても二重にならないこと」を client_uuid ＋ UNIQUE INDEX で
-- 担保している（D-028）。plan_stamps だけ列が無く、通信が怪しいときに同じスタンプが
-- 2つ置かれる形になっていた。
--
-- **`plan_stamps` も `stamps` も本番は0行**なので、索引を貼っても既存行とは衝突しない。
--
-- 索引を `(session_id, client_uuid)` にしてあるのは session_callouts と同じ作法。
-- client_uuid 単独にすると、別の作戦で同じ鍵を使われたときに「見つからない」ではなく
-- 「他人の作戦の行が返る」になる。
--
-- NULL は UNIQUE 索引で重複を許されるので、client_uuid を持たない行（将来、
-- 鍵なしで入った行）が複数あっても壊れない。
ALTER TABLE plan_stamps ADD COLUMN client_uuid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_stamps_uuid ON plan_stamps (session_id, client_uuid);
