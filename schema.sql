-- D1 schema: npx wrangler d1 execute wardogs-blue --remote --file=schema.sql
--
-- `wardogs-blue` は D1 のデータベース名。Pages プロジェクトとリポジトリは
-- `wardogs-board` に改名したが、D1 だけは改名の手段が無いので旧名のまま。
-- ここを直すと存在しない DB を指す（README の「名前について」）。
-- ===== 議論欄（作戦ノート時代のもの。読み書きする経路はもう無い）=====
--
-- **残してあるのは、消す理由が無いから。** `/` で作戦ノートを配信していたころの
-- 章ごとの匿名コメントがここに入る。`/` の配信を止めて `public/index.html` を
-- リダイレクタにした時点で投稿フォームも人間確認のウィジェットも画面から消え、
-- そのあと `functions/api/comments.js` も畳んだ。**いまこのテーブルを読む
-- コードも書くコードも1行も無い。**
--
-- それでも DROP しない。過去の発言は読めなくなっただけで、消えてはいない。
-- **ここを `schema.sql` から外すと、次にスキーマを流した環境で「無かったこと」に
-- なる。** 議論欄の画面を戻すなら、このテーブルがそのまま使える。
--
-- 畳んだことは tests/no-comments-api.test.js が見張っている（このコメントも含む）。
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  section    TEXT    NOT NULL,
  parent_id  INTEGER,
  name       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  ip_hash    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_section ON comments (section, id);
CREATE INDEX IF NOT EXISTS idx_comments_ip      ON comments (ip_hash, created_at);

-- ===== 認証・ユーザー =====
CREATE TABLE IF NOT EXISTS users (
  discord_id    TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL,
  global_name   TEXT,
  avatar        TEXT,
  role          TEXT    NOT NULL DEFAULT 'member',  -- admin / member
  active        INTEGER NOT NULL DEFAULT 1,         -- 0 で無効化
  first_login_at INTEGER NOT NULL,
  last_login_at  INTEGER NOT NULL
);

-- ===== マップ（静的） =====
CREATE TABLE IF NOT EXISTS maps (
  id           TEXT    PRIMARY KEY,          -- bakurani / ozeti / zestafona
  name         TEXT    NOT NULL,
  width_m      REAL    NOT NULL,
  height_m     REAL    NOT NULL,
  -- 保存している y_m が「下向き」か。
  -- ゲーム内の座標は**左下が 0,0 で y は上に増える**（オーナーがゲーム内で確認、
  -- 2026-09-29）。このプロジェクトの y_m はゲームと同じ向きで持つので 0。
  -- 上下の反転は描画のときだけ（SVG は上が 0）。coords.js の flip がやる。
  y_axis_down  INTEGER NOT NULL DEFAULT 0,
  source       TEXT,                         -- 数値の出典
  measured_at  TEXT,                         -- 測定日 (YYYY-MM-DD)
  patch        TEXT,
  verified     INTEGER NOT NULL DEFAULT 0,   -- 0 なら UI に「未検証」を出す
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS zones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id      TEXT    NOT NULL,
  name        TEXT    NOT NULL,              -- コールアウト
  kind        TEXT    NOT NULL,              -- objective / landmark / tower
  polygon     TEXT    NOT NULL,              -- JSON [[x_m,y_m], ...]
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zones_map ON zones (map_id, id);

-- ===== スタンプ定義（ユーザーが追加できる） =====
--
-- **3つの列（shape / glyph / color）で、図形も軍用記号も凸型も表す。**
-- 外形が陣営、中身が兵種（APP-6 の作法）。新しい列は足さない。
--
--   shape      外形。circle / square / triangle / diamond / quatrefoil / arrow / line
--   glyph      外形の中に入れる1〜2文字（歩 / 装 / 砲 …）。図形には入れない
--   color      デザイントークンのキー名（blue / red / hot / green / muted）
--   draw_kind  point（1点で置く）/ vector（始点と終点をドラッグで決める）
--
-- **`shape` と `draw_kind` に CHECK は付けない。** SQLite の ALTER では後から
-- 付けられないので、新規 DB だけに制約が付いて本番と形が食い違う（sessions.visibility
-- と同じ理由）。知らない形は画面側が角丸の四角に倒す（public/js/plan/stamps.js）。
CREATE TABLE IF NOT EXISTS stamps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT    NOT NULL,
  shape       TEXT    NOT NULL,   -- circle / square / triangle / diamond / quatrefoil / arrow / line
  color       TEXT    NOT NULL,   -- デザイントークンのキー名
  glyph       TEXT,               -- 1〜2文字 または 絵文字1つ
  draw_kind   TEXT    NOT NULL,   -- point / vector
  builtin     INTEGER NOT NULL DEFAULT 0,  -- 1 は削除不可
  created_by  TEXT,                        -- builtin は NULL
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stamps_creator ON stamps (created_by);
-- 追加した時点で全員に見える（承認フローなし）。1ユーザー20件までの上限は API 側で検査する。
-- 組み込み（builtin = 1）の名前は重複させない。**下の種まきが冪等であることの
-- 二重の担保**（種まき自体は id を明示した INSERT OR IGNORE なので主キーで弾かれる）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_stamps_builtin_label
  ON stamps (label) WHERE builtin = 1;

-- ===== 組み込みのスタンプ（builtin = 1）=====
--
-- **id を明示した `INSERT OR IGNORE`** なので、何度流しても増えない（主キーで弾かれる）。
-- AUTOINCREMENT は sqlite_sequence の最大値から続くので、あとから利用者が
-- 作るスタンプ（第2段）は 26 以降になる。
--
-- ── 軍用記号について（守ること）──────────────────────────────
-- **狙いは「見慣れた人に一目で伝わること」なので、記号を創作しない。**
-- 外形は APP-6 / MIL-STD-2525 の枠そのまま:
--
--   味方 … square（四角）      hostile でない側の枠
--   敵   … diamond（菱形）
--   不明 … quatrefoil（四葉）  ← APP-6 の unknown の枠。**代用していない**
--
-- **APP-6 から外れているのは中身（兵種）だけ。** APP-6 は兵種を図形
-- （歩兵＝×、装甲＝楕円、砲兵＝塗り丸 …）で描くが、ここでは漢字1文字で置いている。
-- 16px の枠に図形を入れると潰れて見分けられないのと、VC で声に出す語
-- （「歩兵」「装甲」）と画面の字が一致するほうがこのチームには速いため。
-- **これは独自**なので、UI の注記（#stamppanel の .note）に必ず書く。
--
-- 色は既存のデザイントークンの配り直しだけで済ませる（新しい色を足さない）。
-- 味方＝blue / 敵＝red / 不明＝hot。APP-6 の黄（unknown）に当たるトークンが
-- 無いので、暖色の hot を回している。
INSERT OR IGNORE INTO stamps (id, label, shape, color, glyph, draw_kind, builtin, created_by, created_at) VALUES
  -- 図形（場所を指す・範囲を囲う）。無彩色にして「陣営の記号ではない」を形と色で示す。
  ( 1, '四角',         'square',     'muted', NULL, 'point',  1, NULL, 1791417600),
  ( 2, '丸',           'circle',     'muted', NULL, 'point',  1, NULL, 1791417600),
  ( 3, '三角',         'triangle',   'muted', NULL, 'point',  1, NULL, 1791417600),
  -- 向きを持つ印（オーナーの言う「凸型の敵／味方を示すもの」）。陣営の色で置き分ける。
  ( 4, '矢印（味方）', 'arrow',      'blue',  NULL, 'vector', 1, NULL, 1791417600),
  ( 5, '矢印（敵）',   'arrow',      'red',   NULL, 'vector', 1, NULL, 1791417600),
  ( 6, '線（味方）',   'line',       'blue',  NULL, 'vector', 1, NULL, 1791417600),
  ( 7, '線（敵）',     'line',       'red',   NULL, 'vector', 1, NULL, 1791417600),
  -- 軍用記号・味方（四角 × 青）
  ( 8, '味方 歩兵',    'square',     'blue',  '歩', 'point',  1, NULL, 1791417600),
  ( 9, '味方 装甲',    'square',     'blue',  '装', 'point',  1, NULL, 1791417600),
  (10, '味方 砲兵',    'square',     'blue',  '砲', 'point',  1, NULL, 1791417600),
  (11, '味方 偵察',    'square',     'blue',  '偵', 'point',  1, NULL, 1791417600),
  (12, '味方 工兵',    'square',     'blue',  '工', 'point',  1, NULL, 1791417600),
  (13, '味方 補給',    'square',     'blue',  '補', 'point',  1, NULL, 1791417600),
  -- 軍用記号・敵（菱形 × 赤）
  (14, '敵 歩兵',      'diamond',    'red',   '歩', 'point',  1, NULL, 1791417600),
  (15, '敵 装甲',      'diamond',    'red',   '装', 'point',  1, NULL, 1791417600),
  (16, '敵 砲兵',      'diamond',    'red',   '砲', 'point',  1, NULL, 1791417600),
  (17, '敵 偵察',      'diamond',    'red',   '偵', 'point',  1, NULL, 1791417600),
  (18, '敵 工兵',      'diamond',    'red',   '工', 'point',  1, NULL, 1791417600),
  (19, '敵 補給',      'diamond',    'red',   '補', 'point',  1, NULL, 1791417600),
  -- 軍用記号・不明（四葉 × 暖色）
  (20, '不明 歩兵',    'quatrefoil', 'hot',   '歩', 'point',  1, NULL, 1791417600),
  (21, '不明 装甲',    'quatrefoil', 'hot',   '装', 'point',  1, NULL, 1791417600),
  (22, '不明 砲兵',    'quatrefoil', 'hot',   '砲', 'point',  1, NULL, 1791417600),
  (23, '不明 偵察',    'quatrefoil', 'hot',   '偵', 'point',  1, NULL, 1791417600),
  (24, '不明 工兵',    'quatrefoil', 'hot',   '工', 'point',  1, NULL, 1791417600),
  (25, '不明 補給',    'quatrefoil', 'hot',   '補', 'point',  1, NULL, 1791417600);

-- ===== プリセット初期配置 =====
CREATE TABLE IF NOT EXISTS presets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id      TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  payload     TEXT    NOT NULL,   -- JSON: markers と active_zones の配置
  use_count   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presets_map ON presets (map_id, use_count DESC);

-- ===== 試合セッション =====
-- visibility（公開設定）の3つの値と、それぞれの意味:
--
--   private（既定） 一覧に出ない。**URL を知っている人は閲覧も書き込みもできる**
--   public          一覧に出る。閲覧だけ（作成者と admin 以外は書き込めない）
--   public_edit     一覧に出る。閲覧も書き込みもできる
--
-- **`private` を「URL を知っていても書き込めない」にしないこと。** チームは
-- 非公開の作戦の URL を配って共同編集している。そこを締めると、公開設定を
-- 足しただけで既存の使い方が壊れる。`public` の読専は「公開したから荒らされたく
-- ない」への答えであって、非公開の共同編集を禁じるものではない。
--
-- `CHECK` は付けない（SQLite の ALTER では後から付けられないので、新規 DB だけに
-- 制約が付いて本番と形が食い違う）。検査はアプリ側（functions/_lib/visibility.js）。
-- **知らない値は private として読む。** 締まるほうに倒すと、値を増やし損ねた日に
-- 既存の共同編集が全部 403 になる。
--
-- 既存 DB 用の ALTER は migrations/2026-10-02-add-session-visibility.sql。
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,   -- 22文字の推測不能ID（128bit base64url）
  map_id      TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  patch       TEXT,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  visibility  TEXT    NOT NULL DEFAULT 'private'
);
-- 公開されている作戦を更新の新しい順に引く用（一覧の3つ目の群）。
-- 読み出しはこの向きしか無い。行数が少ないうちは効かないが、
-- `visibility` で絞って `updated_at` で並べるのが唯一の使い方なので先に置く。
CREATE INDEX IF NOT EXISTS idx_sessions_public
  ON sessions (visibility, updated_at DESC);

-- 誰がどの作戦を開いたか。共有URLで開いた他人の作戦に、URL を無くしたあとでも
-- 辿り着けるようにするための履歴。GET /api/sessions/{id} が成功したときに upsert する。
--
-- プライバシー方針（守ること）:
--   * この表は「本人が自分の履歴を見る」ためだけに読む。
--   * 作成者に「誰が自分の作戦を見たか」を見せる API は作らない。
--     つまり session_id で引いて user_id を返す経路は作らない。
--   * 一覧に出す他人の名前は「その作戦を作った人」の表示名だけ。これは
--     共有URLを配った時点で既に相手に渡っている情報なので、新たな開示にならない。
CREATE TABLE IF NOT EXISTS session_visits (
  session_id    TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);
-- 本人の履歴を新しい順に引く用。読み出しはこの向きしか無い。
CREATE INDEX IF NOT EXISTS idx_visits_user ON session_visits (user_id, last_seen_at DESC);

-- 試合ごとの可変配置（ドリル / HQ / スポーン / アクティブゾーン）。時刻を持たない
CREATE TABLE IF NOT EXISTS session_markers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,   -- drill / hq / spawn / active_zone
  zone_id     INTEGER,            -- active_zone のとき
  x_m         REAL,               -- 座標マーカーのとき
  y_m         REAL,
  label       TEXT
);
CREATE INDEX IF NOT EXISTS idx_markers_session ON session_markers (session_id, id);

-- ===== プラン（時刻なし） =====
-- plan_priorities は zone_id が NOT NULL で zones の行を指す設計。zones を1件も
-- 定義していない現状では使えないので、配置ごとの優先度は placements.rank で持つ。
-- この表は zones（ゲーム固定のエリア定義）を作ったときの器として残してある。
CREATE TABLE IF NOT EXISTS plan_priorities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  zone_id     INTEGER NOT NULL,
  rank        INTEGER NOT NULL,
  reason      TEXT                 -- 任意。スタンプで足りるなら空でよい
);
CREATE INDEX IF NOT EXISTS idx_plan_pri_session ON plan_priorities (session_id, rank);

CREATE TABLE IF NOT EXISTS plan_stamps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  stamp_id    INTEGER NOT NULL,
  x_m         REAL    NOT NULL,    -- point / vector の始点
  y_m         REAL    NOT NULL,
  x2_m        REAL,                -- vector の終点
  y2_m        REAL,
  count       INTEGER,             -- 「敵多い」のように数を持つもの（列はあるが v1 では使わない）
  note        TEXT,                -- 任意
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  -- 再送しても二重にならないための鍵（D-028）。配置・地名・線・エリアと同じ作法。
  -- 既存 DB 用の ALTER は migrations/2026-10-08-add-plan-stamps-uuid.sql。
  client_uuid TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_stamps_session ON plan_stamps (session_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_stamps_uuid ON plan_stamps (session_id, client_uuid);

-- ===== カスタムコールアウト（自分たちの呼び名） =====
-- 地名は2層になっている。
--
--   session_callouts … プランごとの実体。**地図に出るのはこちらだけ。**
--                      試合ごとに注目する場所が変わるので、同じマップでも作戦に
--                      よって呼び名を変えたり要らない地名を消したりできる。
--   callouts         … マップ静的な雛形（マスタ）。直接は地図に出ない。
--                      プランへ流し込む元。良い呼び名ができたら書き戻す。
--
-- 分けてあるのは「プラン側でいくら直してもマスタが汚れない」ようにするため。
-- 1つの表に混ぜると、あるプランでの改名が全プランに波及する。
CREATE TABLE IF NOT EXISTS callouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id      TEXT    NOT NULL,
  name        TEXT    NOT NULL,   -- 24文字まで
  x_m         REAL    NOT NULL,
  y_m         REAL    NOT NULL,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER            -- 編集を許すため。古い行は NULL
);
CREATE INDEX IF NOT EXISTS idx_callouts_map ON callouts (map_id, id);

-- プランごとの地名。権限・冪等・検証は placements とまったく同じ作法にする
-- （client_uuid で再送を吸収し、編集と削除は置いた本人と admin だけ）。
CREATE TABLE IF NOT EXISTS session_callouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  name        TEXT    NOT NULL,   -- 24文字まで
  x_m         REAL    NOT NULL,
  y_m         REAL    NOT NULL,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  client_uuid TEXT    NOT NULL    -- 再送の冪等キー
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_callouts_uuid
  ON session_callouts (client_uuid);
CREATE INDEX IF NOT EXISTS idx_session_callouts_session
  ON session_callouts (session_id, id);

-- ===== ホワイトボードのインク（手書きストローク） =====
CREATE TABLE IF NOT EXISTS ink_strokes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  color       TEXT    NOT NULL,   -- 作者のカーソル色トークン名
  width       INTEGER NOT NULL,   -- 1 / 2 / 3 の3段階
  points      TEXT    NOT NULL,   -- 0.1m 単位の整数に量子化し差分符号化した座標列
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  client_uuid TEXT    NOT NULL    -- 再送の冪等キー
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ink_uuid ON ink_strokes (client_uuid);
CREATE INDEX IF NOT EXISTS idx_ink_session ON ink_strokes (session_id, id);

-- ===== 試合ごとのエリア（チームが手で塗る見立て）=====
-- ゲーム内と同じ 1km グリッドのセル集合として持つ。1ジェスチャ = 1行の追記型で、
-- 描画側が id の昇順に op を適用して現在の集合を得る（ink_strokes と同じ作法）。
-- 追記型にしてあるのは、取り消し・権限・冪等をインクや配置と同じ仕組みで扱うため。
-- 「最後の行を DELETE する」だけで取り消しになるので、前の状態を持つ必要がない。
--
-- **ここに入るのは全部チームの判断。** ゲームが決めるもの（コントロールエリア＝
-- 半径500mの円、ホットゾーン＝半径85m）は map_zone_presets / session_zone が持つ
-- 実データで、手では描かない。以前ここに control / hot という種類があったが、
-- 見た目が違うのに名前が同じで紛らわしかったため廃止した。
-- 既存行は消さず、GET 側が control → key / hot → risk に読み替える
-- （functions/api/sessions/[id].js の LEGACY_AREA_KINDS）。
CREATE TABLE IF NOT EXISTS session_areas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,   -- own / enemy / neutral / key（最重要）/ risk（危険予測）
                                  -- 廃止: control / hot（ゲームの用語と衝突）
  op          TEXT    NOT NULL DEFAULT 'add',   -- add / sub
  cell_m      REAL    NOT NULL DEFAULT 1000,    -- セルの一辺（m）。既定はゲーム内グリッドと同じ 1km
  rects       TEXT    NOT NULL,   -- JSON [[c0,r0,c1,r1], ...] 0始まりの列・行。両端を含む閉区間
                                  -- 行は SVG 座標で数える（常に上が row 0。coords.js の cellName と同じ）
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  client_uuid TEXT    NOT NULL    -- 再送の冪等キー
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_areas_uuid    ON session_areas (client_uuid);
CREATE INDEX        IF NOT EXISTS idx_areas_session ON session_areas (session_id, id);

-- ===== イベント（時刻あり。戦況記録モードが書く。第1弾では読むだけ） =====
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    NOT NULL,
  stamp_id     INTEGER NOT NULL,
  x_m          REAL    NOT NULL,
  y_m          REAL    NOT NULL,
  x2_m         REAL,
  y2_m         REAL,
  match_sec    INTEGER,            -- 試合開始からの経過秒。手動で開始を押す方式
  note         TEXT,
  created_by   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  client_uuid  TEXT    NOT NULL    -- オフライン再送の冪等キー
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uuid ON events (client_uuid);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, match_sec);

-- ===== マップデータ（Bakurani / Ozeti / Zestafona） =====
-- マップの一辺は**3つとも違う**。Bakurani 16,320m / Ozeti 16,320m / Zestafona 16,384m。
--
-- 以前入れていた 16000 は誤り（2% 小さい）。コミュニティサイト1件の「256 km²」と
-- 「対角 22.6 km」から逆算した値で、対角の記載のほうが概算だった。
-- さらに前の 2000x2000 は Control Zone（毎試合ランダムに決まるサブ領域）の
-- サイズをマップ全体と取り違えたもの。どちらも二度と戻さない。
--
-- 正しい値の出どころ（docs/research/2026-09-29-zones-drills-data.md §3.5）:
--   ネイティブのマップ画像のピクセル数 × worldUnitsPerPixel（UE のワールド単位 = cm）
--     Bakurani  16,384px × 99.609375cm  = 1,632,000cm = 16,320m
--     Ozeti     32,768px × 49.8046875cm = 1,632,000cm = 16,320m
--     Zestafona 32,768px × 50cm         =   819,200cm × 2 = 16,384m
--   このリポジトリの map-src/*.png のピクセル寸法（16384 / 32768 / 32768）が
--   外部データの nativeSizePx と完全一致するので、同じピクセル空間だと確認できている。
--
-- 1km グリッド（A1〜P16）との関係: 一辺がちょうどの km ではないので、
-- 16 列 × 1,000m = 16,000m のあとに 320〜384m の余りが出る。
-- セルは「丸ごと入るぶんだけ」数える（coords.js / areas.js と揃えてある）。
-- ゲーム内のグリッドが 1km 刻みなのか 16 分割なのかは未確認（調査 §7.1 Z-2）。
--
-- 地域設定（maps に notes 列が無いのでここに残す）:
--   Bakurani = Kolchia地域 / Ozeti = 西欧 / Zestafona = 北米戦域
--   ゲーム内名は Kavkazi / Europe / NorthAmerica（調査 §3.4）
--
-- ゲーム内座標は1単位 = 100m（MetaForge の座標表示より。オーナー確認、2026-09-27）。
--
-- verified は 0 のまま。ゲームデータ由来の数値だが、ゲーム内で実測していない。
INSERT OR IGNORE INTO maps (id, name, width_m, height_m, y_axis_down, source, measured_at, patch, verified, created_at)
VALUES ('bakurani', 'Bakurani', 16320.0, 16320.0, 0,
        'ネイティブ画像 16,384px × worldUnitsPerPixel 99.609375cm = 16,320m（worldBoundsMin の X 幅 1,632,000cm と一致）。文章側も「Bakurani is a 16.32 km square」。docs/research/2026-09-29-zones-drills-data.md §3.5。ゲーム内未実測',
        '2026-09-29', 'CL-499480', 0,
        strftime('%s','now'));

INSERT OR IGNORE INTO maps (id, name, width_m, height_m, y_axis_down, source, measured_at, patch, verified, created_at)
VALUES ('ozeti', 'Ozeti', 16320.0, 16320.0, 0,
        'ネイティブ画像 32,768px × worldUnitsPerPixel 49.8046875cm = 16,320m。docs/research/2026-09-29-zones-drills-data.md §3.5。ゲーム内未実測',
        '2026-09-29', 'CL-499480', 0,
        strftime('%s','now'));

INSERT OR IGNORE INTO maps (id, name, width_m, height_m, y_axis_down, source, measured_at, patch, verified, created_at)
VALUES ('zestafona', 'Zestafona', 16384.0, 16384.0, 0,
        'ネイティブ画像 32,768px × worldUnitsPerPixel 50cm = 16,384m（worldBoundsMin [-819200,-819200] = ±8,192m とちょうど一致）。文章側も「Zestafona runs 16.4 km on a side」。docs/research/2026-09-29-zones-drills-data.md §3.5。ゲーム内未実測',
        '2026-09-29', 'CL-499480', 0,
        strftime('%s','now'));

-- ===== ドリルタワー（マップ固定の設備） =====
-- **プレイヤーが FOB に建てる「ドリルリグ」（catalog_items.drill_rig）とは別物。**
-- こちらはマップに最初からある構造物で、位置は毎試合同じ。占拠するとコードが1桁
-- 分かり、全桁そろえるとホットゾーンをそのタワーへ引ける（調査 §4.4）。
-- チームが置くものではないので placements には入れない。多角形でもないので
-- zones（polygon 前提）にも入れない。マップに紐づく静的な点として独立に持つ。
--
-- 「その試合で戦うのはどれか」はここに持たない。コントロールエリアの円の中に
-- 入っているかどうかで決まる（幾何で導出できる）ので、持つと二重管理になる（調査 §4.3）。
--
-- 座標の向き: **ゲームと同じ（左下が 0,0 ／ y は上に増える）。**
-- 元の JSON もこの向きで持っている（`coordinateMetersPerUnit: 100`）。
-- 裏取り: Zestafona の Tower 3 をゲーム内でカーソルで読むと x70.01 y100.31
-- （= 7,001m, 10,031m）で、下の値 (7017.3, 10017.2) と 16m / 14m で一致した。
-- この一致は高さ 16,384m のときだけ成立するので、寸法の訂正の裏付けでもある。
--
-- 出典とライセンス（このプロジェクトは数値の出所を必ず残す）:
--   https://github.com/apollyon-sys/wardogs-calculator の maps/*.json（MIT）。
--   ライセンス全文と帰属は docs/licensing/apollyon-wardogs-calculator.md に置いてある。
--   同じ座標が wardogs.tools 側の抽出データにもあり、両者は独立に一致した
--   （Bakurani 4.7m 以内 / Ozeti 6.5m 以内 / Zestafona 0.5m 以内）。
--   その一致幅を accuracy_m に入れてある（小さいほど確か）。
--   ※ wardogs.tools は利用規約が自動抽出と再配布を禁じているため、
--     そちらにしか無いデータ（エリアのプリセットなど）はこの表に入れない。
--   ※ JSON の `tiles.path`（assets.wardogs-artillery.com）への直リンクは
--     上流が明示的に禁じている。使わないこと。
CREATE TABLE IF NOT EXISTS map_towers (
  id          TEXT    PRIMARY KEY,          -- bakurani-t1 など（座標を直しても変わらない）
  map_id      TEXT    NOT NULL,
  name        TEXT    NOT NULL,             -- 出典の表記のまま
  x_m         REAL    NOT NULL,             -- 左下原点・x 右・y 上（maps.y_axis_down = 0）
  y_m         REAL    NOT NULL,
  accuracy_m  REAL,                         -- 2つの独立した出典の食い違い（m）
  source      TEXT    NOT NULL,             -- 数値の出典
  license     TEXT,                         -- その出典のライセンス
  measured_at TEXT,                         -- 調査日 (YYYY-MM-DD)
  patch       TEXT,
  verified    INTEGER NOT NULL DEFAULT 0,   -- ゲーム内で実測したら 1
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_towers_map ON map_towers (map_id, sort_order);

INSERT OR IGNORE INTO map_towers
  (id, map_id, name, x_m, y_m, accuracy_m, source, license, measured_at, patch, verified, sort_order, created_at)
VALUES
  ('bakurani-t1', 'bakurani', 'Tower 1', 8020.5, 6957.7, 4.7,
   'apollyon-sys/wardogs-calculator の maps/bakurani.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 10, strftime('%s','now')),
  ('bakurani-t2', 'bakurani', 'Tower 2', 7688.8, 6972.7, 4.7,
   'apollyon-sys/wardogs-calculator の maps/bakurani.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 20, strftime('%s','now')),
  ('bakurani-t3', 'bakurani', 'Tower 3', 7688.8, 7315.3, 4.7,
   'apollyon-sys/wardogs-calculator の maps/bakurani.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 30, strftime('%s','now')),
  ('bakurani-t4', 'bakurani', 'Tower 4', 8331.3, 7256.5, 4.7,
   'apollyon-sys/wardogs-calculator の maps/bakurani.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 40, strftime('%s','now')),
  ('bakurani-t5', 'bakurani', 'Tower 5', 8189.9, 6814.3, 4.7,
   'apollyon-sys/wardogs-calculator の maps/bakurani.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 50, strftime('%s','now')),
  ('ozeti-t1', 'ozeti', 'Tower 1', 9542.6, 6257.5, 6.5,
   'apollyon-sys/wardogs-calculator の maps/ozeti.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 10, strftime('%s','now')),
  ('ozeti-t2', 'ozeti', 'Tower 2', 9997.8, 5899.9, 6.5,
   'apollyon-sys/wardogs-calculator の maps/ozeti.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 20, strftime('%s','now')),
  ('ozeti-t3', 'ozeti', 'Tower 3', 10408.2, 6346.1, 6.5,
   'apollyon-sys/wardogs-calculator の maps/ozeti.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 30, strftime('%s','now')),
  ('ozeti-t4', 'ozeti', 'Tower 4', 10022.7, 6737.6, 6.5,
   'apollyon-sys/wardogs-calculator の maps/ozeti.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 40, strftime('%s','now')),
  ('zestafona-t1', 'zestafona', 'Tower 1', 6860.0, 10415.3, 0.5,
   'apollyon-sys/wardogs-calculator の maps/zestafona.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 10, strftime('%s','now')),
  ('zestafona-t2', 'zestafona', 'Tower 2', 7289.2, 10507.1, 0.5,
   'apollyon-sys/wardogs-calculator の maps/zestafona.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 20, strftime('%s','now')),
  ('zestafona-t3', 'zestafona', 'Tower 3', 7017.3, 10017.2, 0.5,
   'オーナーがゲーム内でこのタワーにカーソルを合わせ x70.01 y100.31（7,001m, 10,031m）を実測。差 16m / 14m で一致（2026-09-29）。apollyon-sys/wardogs-calculator の maps/zestafona.json（MIT, Copyright (c) 2026 Apollyon）の markers[icon=tower]。docs/licensing/apollyon-wardogs-calculator.md 参照。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 30, strftime('%s','now'));

-- ===== 陣営スポーン（セーフゾーン。マップ固定） =====
-- 3陣営（Lonestar / Manticore / Valkyra）の基地。**一辺およそ 480m の回転した正方形**で、
-- コントロールエリアからは 3〜5km 離れている（調査 §3.1・§3.3）。
-- 形が四角なので点ではなく多角形で持つ。
--
-- 自陣・敵陣の手塗り（session_areas の own / enemy）とは別物。あちらは
-- 「今日はこの辺を自陣と考える」という**チームの判断**で、こちらは**マップの事実**。
--
-- 色は既存のデザイントークンへの割り当てで表す（plan.html 側）。
-- 出典 JSON の #d86666 / #82c596 / #5fa8d3 をそのまま入れない
-- （色の直値を DB に入れると、ダークモードや配色の変更に追従できなくなる）。
CREATE TABLE IF NOT EXISTS map_spawns (
  id          TEXT    PRIMARY KEY,          -- bakurani-lonestar など
  map_id      TEXT    NOT NULL,
  faction     TEXT    NOT NULL,             -- lonestar / manticore / valkyra
  name        TEXT    NOT NULL,             -- 表示名（日本語）
  polygon     TEXT    NOT NULL,             -- JSON [[x_m,y_m], ...]（左下原点・y 上）
  source      TEXT    NOT NULL,
  license     TEXT,
  measured_at TEXT,
  patch       TEXT,
  verified    INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_spawns_map ON map_spawns (map_id, sort_order);

INSERT OR IGNORE INTO map_spawns
  (id, map_id, faction, name, polygon, source, license, measured_at, patch, verified, sort_order, created_at)
VALUES
  ('bakurani-valkyra', 'bakurani', 'valkyra', 'ヴァルキラ', '[[11704.1,7347.2],[12074.6,7043.4],[11771.8,6672.8],[11400.3,6976.6]]',
   'apollyon-sys/wardogs-calculator の maps/bakurani.json（MIT, Copyright (c) 2026 Apollyon）の polygons。陣営は色（valkyra #d86666 / manticore #82c596 / lonestar #5fa8d3）で対応づけ、同 JSON の陣営マーカーが多角形の中にあることで確かめた。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。4点の一辺は約480mで、調査 §3.1 の「セーフゾーンは一辺 480m の回転した正方形」と一致する。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 30, strftime('%s','now')),
  ('bakurani-manticore', 'bakurani', 'manticore', 'マンティコア', '[[3852.9,7956.8],[4322.1,7854.2],[4218.5,7386.0],[3750.3,7488.6]]',
   'apollyon-sys/wardogs-calculator の maps/bakurani.json（MIT, Copyright (c) 2026 Apollyon）の polygons。陣営は色（valkyra #d86666 / manticore #82c596 / lonestar #5fa8d3）で対応づけ、同 JSON の陣営マーカーが多角形の中にあることで確かめた。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。4点の一辺は約480mで、調査 §3.1 の「セーフゾーンは一辺 480m の回転した正方形」と一致する。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 20, strftime('%s','now')),
  ('bakurani-lonestar', 'bakurani', 'lonestar', 'ローンスター', '[[8275.5,3513.2],[8737.7,3636.7],[8862.2,3173.6],[8399.1,3050.0]]',
   'apollyon-sys/wardogs-calculator の maps/bakurani.json（MIT, Copyright (c) 2026 Apollyon）の polygons。陣営は色（valkyra #d86666 / manticore #82c596 / lonestar #5fa8d3）で対応づけ、同 JSON の陣営マーカーが多角形の中にあることで確かめた。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。4点の一辺は約480mで、調査 §3.1 の「セーフゾーンは一辺 480m の回転した正方形」と一致する。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 10, strftime('%s','now')),
  ('ozeti-valkyra', 'ozeti', 'valkyra', 'ヴァルキラ', '[[13345.7,6824.2],[13803.9,6964.7],[13944.3,6506.5],[13486.1,6366.0]]',
   'apollyon-sys/wardogs-calculator の maps/ozeti.json（MIT, Copyright (c) 2026 Apollyon）の polygons。陣営は色（valkyra #d86666 / manticore #82c596 / lonestar #5fa8d3）で対応づけ、同 JSON の陣営マーカーが多角形の中にあることで確かめた。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。4点の一辺は約480mで、調査 §3.1 の「セーフゾーンは一辺 480m の回転した正方形」と一致する。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 30, strftime('%s','now')),
  ('ozeti-manticore', 'ozeti', 'manticore', 'マンティコア', '[[6895.0,9049.5],[7280.4,8763.6],[6994.6,8379.1],[6610.1,8665.0]]',
   'apollyon-sys/wardogs-calculator の maps/ozeti.json（MIT, Copyright (c) 2026 Apollyon）の polygons。陣営は色（valkyra #d86666 / manticore #82c596 / lonestar #5fa8d3）で対応づけ、同 JSON の陣営マーカーが多角形の中にあることで確かめた。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。4点の一辺は約480mで、調査 §3.1 の「セーフゾーンは一辺 480m の回転した正方形」と一致する。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 20, strftime('%s','now')),
  ('ozeti-lonestar', 'ozeti', 'lonestar', 'ローンスター', '[[8120.2,3389.7],[8599.3,3389.7],[8599.3,2909.6],[8121.2,2910.6]]',
   'apollyon-sys/wardogs-calculator の maps/ozeti.json（MIT, Copyright (c) 2026 Apollyon）の polygons。陣営は色（valkyra #d86666 / manticore #82c596 / lonestar #5fa8d3）で対応づけ、同 JSON の陣営マーカーが多角形の中にあることで確かめた。同 JSON の座標空間は3マップとも 0〜16,384m なので、実寸 16,320m に合わせて 16320/16384 倍している（調査 §4.1）。4点の一辺は約480mで、調査 §3.1 の「セーフゾーンは一辺 480m の回転した正方形」と一致する。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 10, strftime('%s','now')),
  ('zestafona-valkyra', 'zestafona', 'valkyra', 'ヴァルキラ', '[[4027.2,12188.0],[3570.1,12335.5],[3717.5,12792.6],[4174.6,12645.2]]',
   'apollyon-sys/wardogs-calculator の maps/zestafona.json（MIT, Copyright (c) 2026 Apollyon）の polygons。陣営は色（valkyra #d86666 / manticore #82c596 / lonestar #5fa8d3）で対応づけ、同 JSON の陣営マーカーが多角形の中にあることで確かめた。4点の一辺は約480mで、調査 §3.1 の「セーフゾーンは一辺 480m の回転した正方形」と一致する。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 30, strftime('%s','now')),
  ('zestafona-manticore', 'zestafona', 'manticore', 'マンティコア', '[[10330.1,11170.6],[10190.8,11631.0],[10651.2,11768.6],[10788.9,11309.9]]',
   'apollyon-sys/wardogs-calculator の maps/zestafona.json（MIT, Copyright (c) 2026 Apollyon）の polygons。陣営は色（valkyra #d86666 / manticore #82c596 / lonestar #5fa8d3）で対応づけ、同 JSON の陣営マーカーが多角形の中にあることで確かめた。4点の一辺は約480mで、調査 §3.1 の「セーフゾーンは一辺 480m の回転した正方形」と一致する。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 20, strftime('%s','now')),
  ('zestafona-lonestar', 'zestafona', 'lonestar', 'ローンスター', '[[6512.6,6481.5],[6630.6,6946.8],[7095.9,6827.2],[6977.9,6361.9]]',
   'apollyon-sys/wardogs-calculator の maps/zestafona.json（MIT, Copyright (c) 2026 Apollyon）の polygons。陣営は色（valkyra #d86666 / manticore #82c596 / lonestar #5fa8d3）で対応づけ、同 JSON の陣営マーカーが多角形の中にあることで確かめた。4点の一辺は約480mで、調査 §3.1 の「セーフゾーンは一辺 480m の回転した正方形」と一致する。ゲーム内未実測',
   'MIT (apollyon-sys/wardogs-calculator)', '2026-09-29', 'CL-499480', 0, 10, strftime('%s','now'));

-- ===== コントロールエリアのプリセット（マップ固定の円） =====
-- **ゲームが決めた円であって、チームが塗った面ではない。**
-- マップごとに名前つきの円が 3〜4 個定義されていて（ゲーム内のゲームプレイタグは
-- `ZoneAlternator.<Map>.<Name>.Circle`）、試合開始時に重みつきランダムで1個が選ばれる。
-- 選ばれた円は試合中動かない。**その円の中に入っているドリルタワーが対象になる**
-- （docs/research/2026-09-29-zones-drills-data.md §2.1・§2.3・§4.3）。
--
-- 既存の zones テーブルは使わない（polygon 前提で、円に合わない）。消しもしない。
-- session_areas（1km マスの手塗り）とも別物。あちらはチームの判断、こちらはゲームの事実。
--
-- **行は最初から1つも入れない。**
-- 中心座標が取れるのは利用規約で自動抽出と再配布を禁じているサイト1件だけなので
-- （調査 §5.3）、**オーナーがゲーム画面の数字を見て自分で入力したものだけ**を持つ
-- （§5.6 案4）。ここに値を書き足すときは、必ず source に誰がどう得た値かを残すこと。
--
-- 半径はマップごとの既定（Bakurani 500m / Ozeti 550m / Zestafona 500m。調査 §3.1）を
-- サーバが自動で入れる。既定値の持ち主は functions/_lib/zones.js の1箇所だけ。
--
-- 座標の向きは map_towers と同じ（メートル、左下原点、x 右・y 上。maps.y_axis_down = 0）。
-- 入力はゲーム内座標（1単位 = 100m）で受け取り、API がメートルに直して保存する。
CREATE TABLE IF NOT EXISTS map_zone_presets (
  id          TEXT    PRIMARY KEY,          -- bakurani-default（map_id と key から作る）
  map_id      TEXT    NOT NULL,
  key         TEXT    NOT NULL,             -- Default / Farmland / Lumberyard …
  name        TEXT    NOT NULL,             -- 表示名（日本語可）。省略時は key と同じ
  tag         TEXT,                         -- ZoneAlternator.Bakurani.Default.Circle
  x_m         REAL    NOT NULL,             -- 円の中心
  y_m         REAL    NOT NULL,
  radius_m    REAL    NOT NULL,
  weight      REAL,                         -- 抽選の重み。0 は「定義はあるが出ない」
  source      TEXT    NOT NULL,             -- 誰がどう入れた値か（必須）
  license     TEXT,
  measured_at TEXT,                         -- 入力・計測した日 (YYYY-MM-DD)
  patch       TEXT,
  verified    INTEGER NOT NULL DEFAULT 0,   -- ゲーム画面の数字を読んで入れたら 1
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_by  TEXT,                         -- 入れた人の discord_id
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_presets_key ON map_zone_presets (map_id, key);
CREATE INDEX IF NOT EXISTS idx_zone_presets_map ON map_zone_presets (map_id, sort_order, id);

-- オーナーの実機スクリーンショットから読み取ったぶん。
-- **wardogs.tools のデータは使っていない**（規約が自動抽出と再配布を禁じているため。
-- docs/licensing/2026-09-29-wardogs-tools-permission-request.md 参照）。
-- 残りのプリセットは、試合でそのパターンが出たときにスクリーンショットを撮って足す。
INSERT OR IGNORE INTO map_zone_presets
  (id, map_id, key, name, tag, x_m, y_m, radius_m, weight,
   source, license, measured_at, patch, verified, sort_order, created_by, created_at, updated_at)
VALUES
  ('zestafona-default', 'zestafona', 'Default', 'Default（全タワー）', NULL,
   6985.0, 10204.0, 500.0, NULL,
   'オーナーの実機スクリーンショット（2026-09-29 の試合動画 62秒地点）から算出。十字カーソルの表示値 x75.07 y98.71 を基準に、円の直径 475px = 1000m の縮尺で中心を測った。誤差の見込み ±50m。円内のタワーが3本（Tower1 245m / Tower2 429m / Tower3 190m）となり、Zestafona の Default が全タワー対象という調査結果と整合する',
   NULL, '2026-09-29', 'CL-499480', 0, 10, NULL,
   strftime('%s','now'), strftime('%s','now'));

-- ===== 作戦が選んでいるプリセット（試合ごとに変わる） =====
-- 作戦ごとに1つだけなので 1 行 1 作戦（session_id が主キー）。
-- sessions に列を足さないのは、この schema.sql が CREATE TABLE IF NOT EXISTS だけで
-- 出来ていて ALTER を持たないため（既存の本番テーブルには列が増えない）。
--
-- preset_id は map_zone_presets.id を指すが、外部キー制約は張らない
-- （他のテーブルと同じ作法）。代わりに、プリセットを消す API がこの行も一緒に消す。
-- 作戦を消すときは functions/api/sessions/[id].js の CHILD_TABLES が消す。
CREATE TABLE IF NOT EXISTS session_zone (
  session_id TEXT    PRIMARY KEY,
  preset_id  TEXT    NOT NULL,
  chosen_by  TEXT    NOT NULL,
  chosen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_zone_preset ON session_zone (preset_id);

-- ===== 建造物とビークルのカタログ =====
-- 寸法・射程・コストはすべて未実測なので verified で管理する。
-- （ゲームアセットが AES 暗号化されていて抽出できない。D-020）
CREATE TABLE IF NOT EXISTS catalog_items (
  id            TEXT    PRIMARY KEY,
  kind          TEXT    NOT NULL,      -- structure / emplacement / vehicle
  name_ja       TEXT    NOT NULL,
  name_en       TEXT,
  footprint_w_m REAL, footprint_h_m REAL, height_m REAL,
  range_min_m   REAL, range_max_m REAL,
  cost_supplies INTEGER,
  build_seconds REAL,
  crew          INTEGER,
  notes         TEXT,
  source        TEXT,
  measured_at   TEXT,
  patch         TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_kind ON catalog_items (kind, sort_order);

CREATE TABLE IF NOT EXISTS placements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  item_id     TEXT    NOT NULL,
  x_m         REAL    NOT NULL,
  y_m         REAL    NOT NULL,
  rotation    REAL    NOT NULL DEFAULT 0,
  label       TEXT,
  rank        INTEGER,            -- 取得の優先度 1〜9。NULL は順位なし
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  client_uuid TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_placements_uuid ON placements (client_uuid);
CREATE INDEX IF NOT EXISTS idx_placements_session ON placements (session_id, id);

-- ===== カタログの初期データ =====
-- 入れる数値は cost_supplies だけ。寸法・射程・建築時間・乗員はオーナーが
-- ゲーム内で実測してから入れる。INSERT の列リストにその4種を書いていないのは、
-- うっかり推測値を混ぜられないようにするため。
--
-- cost_supplies の扱い（docs/research/2026-09-27-wardogs-game-data.md 2.1節）:
--   Clutchbase と wardogsbuilder.com が全項目で食い違い、比がほぼ 4/3 に揃っている
--   （Clutchbase 121 / wardogsbuilder 91、1801 / 1351、61 / 46、69 / 52 …）。
--   片方が機械的な計算値の可能性が高く、どちらが実機の値かは判定できない。
--   **オーナーの判断で「大きいほう」= Clutchbase 側の値を暫定採用した。**
--   verified は 0 のままで、ゲーム内の建築メニューで確認したら上げる。
--   Talon 9K-SAM（801 / 60）と Vanguard CIWS（1201 / 90）だけは比が約13倍で、
--   どちらかが桁を誤っているため NULL のままにした。
--   出典に記載が無い項目も NULL のまま（推測で埋めない）。
--   ビークルの価格は supplies ではなく現金（$）なので cost_supplies には入れない。
--
-- 数値を入れない理由（コスト以外）:
--   * 寸法: セル単位の表はあるが 1セル = 1.2m か 1.5m かが出典間で矛盾（25%違う）。
--   * FOB の建築範囲: 正方形であることはオーナーがゲーム内で確認した。ただし
--     一辺の長さは未確認（「60m」が一辺の半分なのか別の値なのかも未確定）。
--   * 建築時間: 「ドリルリグ 約2分」が唯一の記述だが単一出典で条件も不明。
--
-- 名称: 英語名は2サイト以上で一致したものだけを載せた（確度C）。
-- 日本語名はこちらで付けた訳で、そもそも日本語ローカライズの有無すら未確認。
-- よって全行の notes に「名称は要確認」を入れてある。
--
-- 以前このファイルに入れていた `ammo_crate`（弾薬箱）/ `supply_depot`（補給所）/
-- `cannon_l52`（L52 を設置物として登録）/ `hmg_nest` / `at_gun` は、調査の結果
-- 該当する buildable が確認できなかったので削除した。L52 Cannon は自走砲 SPH-2 の
-- 搭載砲塔なので vehicle 側の `sph_2` に寄せてある。
-- 既にこのカタログを流した DB があれば、その5行は手動で DELETE する必要がある
-- （INSERT OR IGNORE は既存行を消さない）。
INSERT OR IGNORE INTO catalog_items
  (id, kind, name_ja, name_en, cost_supplies, notes, source, measured_at, patch, verified, sort_order, created_at)
VALUES
  ('fob', 'structure', 'FOB（前線作戦基地）', 'FOB', 30,
   '建築範囲は正方形（オーナーがゲーム内で確認、2026-09-27）。「80 Hesco blocks on a side, centred on the FOB」という記述と整合する。ただし一辺の長さは未確認で、「60m」が一辺の半分なのか別の値なのかも未確定。高さ上限15mの記載も実機未確認。名称は要確認',
   'コストは Clutchbase のみの記載（単一出典）。ゲーム内未確認。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 10, strftime('%s','now')),
  ('recon_tent', 'structure', '偵察テント', 'Recon Tent', 5,
   'FOB の建築範囲外に建てられる4種のうちの1つ。名称は要確認',
   'コストは Clutchbase と wardogsbuilder.com の値が一致。ただしゲーム内未確認。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 20, strftime('%s','now')),
  ('barbed_wire', 'structure', '鉄条網', 'Barbed Wire', 7,
   'FOB の建築範囲外に建てられる4種のうちの1つ。名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 30, strftime('%s','now')),
  ('sandbag_wall', 'structure', '土嚢壁', 'Sandbag Wall', 13,
   'FOB の建築範囲外に建てられる4種のうちの1つ。名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 40, strftime('%s','now')),
  ('hedgehog', 'structure', '対戦車障害', 'Hedgehog', 19,
   'Tank Trap とも呼ばれる。FOB の建築範囲外に建てられる4種のうちの1つ。名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 50, strftime('%s','now')),
  ('bremer_wall', 'structure', 'ブレマーウォール', 'Bremer Wall', 13,
   'コンクリート製のバリケード。綴りがサイト間で Bremer / Bremmer と不一致（現実の用語は Bremer wall）。名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 60, strftime('%s','now')),
  ('hesco_block_small', 'structure', '小型HESCOブロック', 'Hesco Block (Small)', 13,
   '名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 70, strftime('%s','now')),
  ('hesco_block_large', 'structure', '大型HESCOブロック', 'Hesco Block (Large)', 19,
   '名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 80, strftime('%s','now')),
  ('hesco_wall', 'structure', 'HESCOウォール', 'Hesco Wall', 61,
   '大型ブロック4個相当を一括で置くもの（wardogsbuilder は Hesco Wall (Quad) と表記）。個別に4個置くより安いとされる。名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 90, strftime('%s','now')),
  ('door', 'structure', 'ドア', 'Door', 19,
   '名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 100, strftime('%s','now')),
  ('gate', 'structure', 'ゲート', 'Gate', 69,
   '名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 110, strftime('%s','now')),
  ('bunker', 'structure', 'バンカー', 'Bunker', 81,
   '名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 120, strftime('%s','now')),
  ('bunker_floor', 'structure', 'バンカー床', 'Bunker Floor', 10,
   '名称は要確認',
   'コストは Clutchbase のみの記載（単一出典）。ゲーム内未確認。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 130, strftime('%s','now')),
  ('bunker_roof', 'structure', 'バンカー屋根', 'Bunker Roof', 10,
   '名称は要確認',
   'コストは Clutchbase のみの記載（単一出典）。ゲーム内未確認。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 140, strftime('%s','now')),
  ('recon_tower', 'structure', '観測塔', 'Recon Tower', 81,
   '安価な Recon Tent（偵察テント）とは別物。名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 150, strftime('%s','now')),
  ('indirect_fire_shelter', 'structure', '間接砲火シェルター', 'Indirect Fire Shelter', 81,
   '名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 160, strftime('%s','now')),
  ('builders_radio', 'structure', 'ビルダーズレディオ', 'Builder''s Radio', 17,
   '名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 170, strftime('%s','now')),
  ('loudspeaker', 'structure', '拡声器', 'Loudspeaker', 81,
   '名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 180, strftime('%s','now')),
  ('refuel_station', 'structure', '燃料補給所', 'Refuel Station', 161,
   '燃料専用。MetaForge の Bakurani マップに `Fuel Refill` が3箇所ある（オーナー確認、2026-09-27）。建造物 Refuel Station とマップ固定の Fuel Refill が同一のものかは未確認。物資（supplies）の保持は FOB 本体の機能で、汎用の「補給所」という建造物は確認できなかった。名称は要確認',
   'コストは Clutchbase のみの記載（単一出典）。ゲーム内未確認。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 190, strftime('%s','now')),
  ('repair_station', 'structure', '修理所', 'Repair Station', 161,
   '名称は要確認',
   'コストは Clutchbase のみの記載（単一出典）。ゲーム内未確認。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 200, strftime('%s','now')),
  ('drill_rig', 'structure', 'ドリルリグ', 'Drill Rig', 1801,
   '稼働中は Build Supply と Fuel を消費し続ける（レートは不明）。建築時間「約2分」という記述が1件あるが単一出典で条件も不明なため採用しない。コストは 901 / 1351 / 1801 の3説があり、大きいほうの 1801 を暫定採用した。名称は要確認',
   'コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 210, strftime('%s','now')),
  ('hotzone_magnet', 'structure', 'ホットゾーンマグネット', 'Buildable Hotzone Magnet', NULL,
   '出典に名前の言及があるだけで詳細不明。存在そのものも要確認。名称は要確認',
   '言及のみの単一出典。コストの記載なし。数値は未実測',
   NULL, NULL, 0, 220, strftime('%s','now')),
  ('stingray', 'emplacement', 'スティングレイ（対空）', 'Stingray', 121,
   '対空。名称は要確認',
   'コストは Clutchbase と wardogsbuilder.com の値が一致。ただしゲーム内未確認。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 310, strftime('%s','now')),
  ('talon_9k_sam', 'emplacement', 'Talon 9K-SAM（対空ミサイル）', 'Talon 9K-SAM', NULL,
   '対空。コストは Clutchbase 801 / wardogsbuilder 60 で約13倍も違い、どちらかが桁を誤っている。4/3 の比で説明できない唯一の組なので、大きいほうを採る方針からも外して NULL のままにした。名称は要確認',
   'コストは出典間で約13倍食い違うため不採用。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 320, strftime('%s','now')),
  ('vanguard_ciws', 'emplacement', 'Vanguard CIWS（近接防御火器）', 'Vanguard CIWS', NULL,
   '対空。コストは Clutchbase 1201 / wardogsbuilder 90 で約13倍も違い、どちらかが桁を誤っている。4/3 の比で説明できない唯一の組なので、大きいほうを採る方針からも外して NULL のままにした。名称は要確認',
   'コストは出典間で約13倍食い違うため不採用。寸法・射程・建築時間は未実測',
   NULL, NULL, 0, 330, strftime('%s','now')),
  ('bobcat', 'vehicle', 'Bobcat', 'Bobcat', NULL,
   '小型四輪車。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 400, strftime('%s','now')),
  ('dune_buggy', 'vehicle', 'Dune Buggy', 'Dune Buggy', NULL,
   '名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 410, strftime('%s','now')),
  ('kodiak', 'vehicle', 'Kodiak', 'Kodiak', NULL,
   'サイズを問わずクレートを積める。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 420, strftime('%s','now')),
  ('kodiak_pickup', 'vehicle', 'Kodiak Pickup', 'Kodiak Pickup', NULL,
   '名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 430, strftime('%s','now')),
  ('kodiak_m249', 'vehicle', 'Kodiak [M249]', 'Kodiak M249', NULL,
   '名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 440, strftime('%s','now')),
  ('humvee', 'vehicle', 'Humvee', 'Humvee', NULL,
   '名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 450, strftime('%s','now')),
  ('humvee_m249', 'vehicle', 'Humvee [M249]', 'Humvee M249', NULL,
   '名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 460, strftime('%s','now')),
  ('humvee_minigun', 'vehicle', 'Humvee [Minigun]', 'Humvee Minigun', NULL,
   '名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 470, strftime('%s','now')),
  ('ural', 'vehicle', 'Ural', 'Ural', NULL,
   'パレット単位で supplies を輸送できる（作戦上の主力補給車）。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 480, strftime('%s','now')),
  ('ural_defender', 'vehicle', 'Ural Defender', 'Ural Defender', NULL,
   '名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 490, strftime('%s','now')),
  ('ural_defender_m249', 'vehicle', 'Ural Defender [M249]', 'Ural Defender M249', NULL,
   '名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 500, strftime('%s','now')),
  ('m113_apc_sv', 'vehicle', 'M113 APC SV', 'M113 APC SV', NULL,
   '装甲兵員輸送車。Dexerto の一覧にのみ記載（単一出典）で、存在そのものも要確認。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 510, strftime('%s','now')),
  ('flakpanzer_gepard', 'vehicle', 'Flakpanzer Gepard', 'Flakpanzer Gepard', NULL,
   '対空自走砲。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 520, strftime('%s','now')),
  ('l2a6', 'vehicle', 'L2A6（戦車）', 'L2A6', NULL,
   '名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 540, strftime('%s','now')),
  ('havoc', 'vehicle', 'Havoc', 'Havoc', NULL,
   '名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 550, strftime('%s','now')),
  ('mh6', 'vehicle', 'MH-6 Littlebird', 'MH-6', NULL,
   'ヘリ。小型クレートのみ積める。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 560, strftime('%s','now')),
  ('ah6m', 'vehicle', 'AH-6M [Miniguns]', 'AH-6M', NULL,
   'ヘリ。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 570, strftime('%s','now')),
  ('ah6r', 'vehicle', 'AH-6R [Rockets]', 'AH-6R', NULL,
   'ヘリ。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 580, strftime('%s','now')),
  ('uh1y', 'vehicle', 'UH-1Y', 'UH-1Y', NULL,
   'ヘリ。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 590, strftime('%s','now')),
  ('uh1y_miniguns', 'vehicle', 'UH-1Y [Miniguns]', 'UH-1Y Miniguns', NULL,
   'ヘリ。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 600, strftime('%s','now')),
  ('z20_lakota', 'vehicle', 'Z20 Lakota', 'Z20 Lakota', NULL,
   'ヘリ。パレット単位で supplies を輸送できる（空路の補給線が成立する）。Dexerto と Shacknews の記載のみ。名称は要確認',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。数値は未実測',
   NULL, NULL, 0, 610, strftime('%s','now'));

-- ===== 射程データ（MetaForge Artillery Tool, Gunner sight モード） =====
-- 出典: https://metaforge.app/wardogs/map/bakurani （オーナーがスクリーンショットで確認、2026-09-27）。
-- L81 Mortar と L52 Cannon の最小/最大射程のみ。他の項目は依然として未実測なので触れていない。
-- 上の一括 INSERT から mortar_l81 / sph_2 の2行を分離し、この2行だけ列リストに
-- range_min_m / range_max_m を加えている（一括 INSERT は列リストを全行共通にする必要があるため）。
-- L52 Cannon は建造物ではなく自走砲 SPH-2 の搭載砲塔（上のコメント・D-020参照）なので、
-- 射程データは sph_2（vehicle）側に持たせる。verified はどちらも 0 のまま
-- （MetaForge の表示値であり、ゲーム内で撃って実測したわけではない）。
INSERT OR IGNORE INTO catalog_items
  (id, kind, name_ja, name_en, cost_supplies, range_min_m, range_max_m, notes, source, measured_at, patch, verified, sort_order, created_at)
VALUES
  ('mortar_l81', 'emplacement', 'L81 迫撃砲', 'L81 Mortar', 121, 80, 684,
   'FOB の建築範囲内に建てる buildable。射程は MetaForge Artillery Tool の値が入っている（ゲーム内で撃って実測したわけではない）。必要人数は未実測。設置後に移動・回収できるかも未確認。名称は要確認。口径 120×800mm。短射程の間接射撃。リロードでFOBのAmmo suppliesを砲弾に変換。装甲3000 hull HP / 装甲ゾーン1 / 40mmで30発。Support ロール',
   '名称は複数サイトで一致（MetaForge にも /buildables/l81-mortar がある）。コストは Clutchbase 側の値（大きいほう）を暫定採用。wardogsbuilder.com 側とは 4/3 の比で食い違っており、どちらが実機か未確認。オーナーがゲーム内の建築メニューで確認予定。寸法・建築時間は未実測。射程は MetaForge Artillery Tool（Gunner sight）より（2026-09-27 オーナー確認）。装甲値は MetaForge のゲーム内ダメージテーブル由来（build CL-499480）。いずれもゲーム内未実測',
   NULL, NULL, 0, 300, strftime('%s','now')),
  ('sph_2', 'vehicle', 'SPH-2（自走砲）', 'SPH-2', NULL, 600, 2600,
   'L52 Cannon（L52 カノン砲）はこの車両の搭載砲塔で、設置物として建てられるものではない。射程は MetaForge Artillery Tool の値が入っている（ゲーム内で撃って実測したわけではない）。名称は要確認。搭載砲は L52 Cannon、155mm HE Shell',
   '名称はベータ期の記事（GameWatcher 2026-08-29）ほか。ロースターがサイト間で 20〜23 台と不一致。価格は supplies ではなく現金（$）なので cost_supplies には入れない。射程以外の数値（乗員・装甲・速度など）は未実測。射程は MetaForge Artillery Tool（Gunner sight）より（2026-09-27 オーナー確認）。ゲーム内未実測',
   NULL, NULL, 0, 530, strftime('%s','now'));

-- ===== 試合の要素（kind = objective） =====
-- ドリル位置・HQ・スポーン・敵FOB と、判断を書き込むための記号。
-- 新テーブルも新 API も作らず、catalog_items に行を足すだけで既存の placements API
-- （置く・動かす・消す・取り消す・権限・冪等）にそのまま相乗りさせる。
--
-- verified は 1。他の項目と逆に見えるが、これらは出典のある測定値ではなく
-- こちらが作図のために定義した記号なので、「未検証（＝実測すれば確定する）」という
-- 状態そのものが存在しない。0 にすると UI が「未検証」バッジを出して、
-- ゲーム内の数値を調べれば直るものだと誤読させてしまう。
-- 同じ理由で source は NULL（出典が無いのではなく、出典という概念が当てはまらない）。
--
-- コスト・射程・寸法はすべて NULL。建てるものではないので費用も射程も無い。
-- **ホットゾーンの半径 85m もここには入れない。** 行ごとに変わらない1つの決めなので
-- コード側（public/js/plan/placements.js の HOTZONE_RADIUS_M）が持つ。カタログの
-- 列に入れると「未検証」の出し所がバッジと注記の2系統に分かれる。
-- sort_order は 0〜8。既存の最小が 10（fob）なので、パレットでは必ず先頭に並ぶ。
-- **ホットゾーンだけ 0** なのは、これが作戦の核心（入ると人数が2倍。D-052）で、
-- 試合の要素の中でも最初に置くものだから。既存の 1〜8 は動かさない
-- （INSERT OR IGNORE は既存行を書き換えないので、並べ替えには UPDATE の
-- migration が要る。順番のために本番データを書き換える理由にはならない）。
INSERT OR IGNORE INTO catalog_items
  (id, kind, name_ja, notes, verified, sort_order, created_at)
VALUES
  ('mk_hotzone',   'objective', 'ホットゾーン（人数2倍）',
   '作図用の記号。ゲーム内の数値ではありません。中に入ると人数が2倍に数えられます（オーナーがゲーム内で確認、2026-10-01）。盤面には半径85mの円で描きますが、その85mは調査値で、ゲーム内で実測して確かめた数値ではありません（実機スクリーンショットからの実測は半径およそ80m）。ホットゾーンは時間で動き、大型ハンマーで作れるドリルリグで引き寄せられるため、ここに置くのはチームの想定です',
   1, 0, strftime('%s','now')),
  ('mk_drill',     'objective', 'ドリル位置',       '作図用の記号。ゲーム内の数値ではありません', 1, 1, strftime('%s','now')),
  ('mk_hq',        'objective', 'HQ',               '作図用の記号。ゲーム内の数値ではありません', 1, 2, strftime('%s','now')),
  ('mk_spawn',     'objective', 'スポーン',         '作図用の記号。ゲーム内の数値ではありません', 1, 3, strftime('%s','now')),
  ('mk_enemy_fob', 'objective', '敵FOB（推定）',    '作図用の記号。ゲーム内の数値ではありません', 1, 4, strftime('%s','now')),
  ('mk_defend',    'objective', 'ここ守ろう',       '作図用の記号。ゲーム内の数値ではありません', 1, 5, strftime('%s','now')),
  ('mk_attack',    'objective', 'ここから攻める',   '作図用の記号。ゲーム内の数値ではありません', 1, 6, strftime('%s','now')),
  ('mk_danger',    'objective', '危険・見られてる', '作図用の記号。ゲーム内の数値ではありません', 1, 7, strftime('%s','now')),
  ('mk_note',      'objective', 'メモ',             '作図用の記号。ゲーム内の数値ではありません', 1, 8, strftime('%s','now'));
