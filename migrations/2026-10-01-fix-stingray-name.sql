-- `stingray` の名前と notes を訂正する（`スティングレイ（対空）` は誤り）。
--
-- 調査: docs/research/2026-10-01-fuel-and-aa.md §3.1
--   日本語Wikiの攻撃設備表は用途を「ヴァンガード CIWS = 対空 / タロン 9K-SAM = 対空 /
--   スティングレイ = UAV」と分けている。英語の出典も
--   「remote-controlled, long-range UAV with an explosive payload」で一致し、
--   「飛行中のヘリには事実上当たらない（ドローンが遅すぎて追いつけない）」とある。
--   つまり**対空兵器ではなく、手で飛ばす対装甲の FPV 自爆ドローンの発射台**。
--
-- **名前に「対空」と書いてあると、ヘリに撃てると読める。** 作戦を練るときに
-- 対空の手当てをこれで済ませたと勘違いしうるので、名前の誤りとして直す。
--
-- `schema.sql` の `INSERT OR IGNORE` は**既にある行を書き換えない**ので、
-- `schema.sql` を流し直しても本番の名前は直らない。だからこの UPDATE が要る
-- （`migrations/README.md`「列を足さない UPDATE の migration もある」）。
--
-- **到達距離 約3km は射程の列に入れない。** 単一出典でゲーム内未確認なので、
-- 実線の円を描ける値として持つと「ここは安全」と断言することになる（D-056）。
-- notes の文章として残すだけにする。
--
-- `WHERE id = 'stingray'` の1行だけ。2回流しても結果は同じ（冪等）。
UPDATE catalog_items
   SET name_ja = 'スティングレイ（自爆ドローン）',
       notes   = '対空ではない（2026-10-01 訂正。以前は「スティングレイ（対空）」と入れていた）。手で飛ばす FPV 自爆ドローンの発射台で、狙うのは車輌。日本語Wikiの攻撃設備表の用途欄が「UAV」で、対空は CIWS と SAM だけ。飛行中のヘリには追いつけないという記述もある。信号が届くのは約3km という記述があるが単一出典でゲーム内未確認のため射程には入れていない。名称は要確認',
       source  = 'コストは Clutchbase と wardogsbuilder.com の値が一致。ただしゲーム内未確認。用途は wikiwiki.jp/wardogs/攻撃設備（用途欄「UAV」）と allthings.how の Stingray 解説が一致。寸法・射程・建築時間は未実測'
 WHERE id = 'stingray';
