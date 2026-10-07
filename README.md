# WARDOGS 作戦プランナー

**日本語** · [English](README.en.md) · [简体中文](README.zh-CN.md) · [한국어](README.ko.md)

試合が始まる前に、**地図を指しながら作戦を話すためのホワイトボード**です。

Discord の通話で「ここ」「そっち」と言っても相手には伝わりません。同じ地図を同じ画面で開いて、
線を引き、記号を置き、カーソルで指す。それだけのための道具です。

**ゲームには一切触れません。** プロセスのメモリを読みません。ゲームのファイルを読みません。
通信に割り込みません。オーバーレイも出しません。ただのブラウザのページです。
WARDOGS は Team17 / Bulkhead の著作物で、これは非公式のファンメイドです。

Cloudflare Pages（無料枠）で動き、データは Pages Functions + D1（無料枠）に入ります。
ログインは Discord の OAuth です。

> **マップ画像はこのリポジトリに入っていません。** こちらの著作物ではないので配れません。
> **無くても動きます**（背景が無い盤面になるだけで、座標・グリッド・線・記号は全部そのまま）。
> 用意のしかたは[下](#マップ画像を自分で用意する)に書いてあります。

---

## できること

### 地図の上に置く・描く

| | |
|---|---|
| **線** | ペンで引く。太さ3段階、消しゴム、取り消し。0.1m 単位に量子化して差分符号化で保存する |
| **記号** | 建造物・設置物・車輌・試合の要素を置く。種別ごとに形が違う（四角・三角・丸・ピン）。射程リングと FOB の建築範囲は**実寸（メートル）**で描くので、ズームしても地図と同じ縮尺で伸縮する |
| **地名（コールアウト）** | 「あの丘」「工場」「北の橋」。チームが通話でそのまま喋る呼び名を、作戦ごとに置く |
| **エリア** | 1km マスを塗る（自陣・敵陣・中立・最重要・危険予測）。集合演算で足し引きする |
| **コントロールエリア** | **ゲームが決める円**（半径500m。**Ozeti だけ 550m**）のプリセット。チームの見立てとは別物として、見た目もはっきり分けてある |
| **ホットゾーン** | 半径85m、人数2倍の円 |
| **ドリルタワー / 陣営スポーン** | マップ固定。毎試合同じ位置なので、こちらが持っているデータから勝手に出る |

ズームとパン、1km グリッド、A1〜P16 のセル名（盤面の縁に見出しが出る）、
ゲーム内座標の表示、縮尺、背景のモノクロ／高コントラスト切り替え。

### 同じ画面を一緒に見る

| | |
|---|---|
| **カーソル共有** | 他の人のポインタが**名前つきの矢印**で地図の上に出る。やり取りするのは**マップのメートル座標**で、画面 px ではない（各自のズームとパンが違うので、px を送ると相手の画面の別の場所を指す） |
| **運んでいる最中が見える** | 記号をドラッグしている「途中」が相手の画面でも動く。離してから飛ぶのではない |
| **引いている最中が見える** | ペンの線が引かれていく様子がそのまま出る |
| **変更通知** | 誰かが置いた・動かした・消した・描いたものが、**リロードせずに**出る |
| **在室一覧** | 同じ作戦を今開いている人が、名前とアイコンと色で出る |
| **同時50人** | 1つの作戦に同時に入れるのは50人。51人目は「満員です」で断られる |

### 誰に見せるか

**変えるのは「一覧に出るか」と「書けるか」の2つだけで、閲覧の可否は変わりません。**
守っているのは「URL を知っていること」です。

| 設定 | 一覧に出るか | URL を知っている人の閲覧 | 書けるか |
|---|---|---|---|
| `private`（既定） | **出ない** | できる（**ゲストも**） | **ログインしている人なら誰でも** |
| `public` | 出る | できる（ゲストも） | **作った人と admin だけ** |
| `public_edit` | 出る | できる（ゲストも） | **ログインしている人なら誰でも** |

**`private` は「秘密」ではなく「一覧に出さない」です。** URL を知っている人は開けて、
ログインしていれば書き込めます。チームが非公開の作戦の URL を配って共同編集しているので、
ここを締めると公開設定を足しただけで既存の使い方が壊れます。
**隠したい情報を置く場所ではありません。**

**ゲスト閲覧**は、ログインせずに作戦を見られる仕組みです。
ゲストにも名前が自動で付き（「しずかなカワウソ」のような2語の名前。**日本語で固定**）、
カーソルも出ます。ただし**書き込みは一切できません**（どの設定でも）。
一覧に出るのは `public` / `public_edit` だけですが、**URL を渡されれば `private` も開けます。**

他人の置いたものは消せません。**ただし admin は消せます。**

---

## 作っている考え方

- **試合ごとの記録ではなく、パターンごとの準備。**
  「あのとき何をしたか」を残すためのものではなく、「Default のときはこう攻める」を
  **事前に用意しておく**ためのものです。
- **位置に紐づけて判断を書く。** 「ここは道路経由だから取りづらい」を、その場所に置く。
- **リアルタイムは上乗せであって前提ではない。**
  WebSocket が繋がらなくても、盤面の全機能が HTTP で動きます。
- **無料枠から出ない。** 有料プランを前提にした機能を入れていません
  （Durable Objects にタイマーを1本も作らない、`state.acceptWebSocket()` だけを使う、
  カーソルの送信頻度を在室人数で下げて合計 200通/秒 を超えさせない、など）。
- **ビルド工程が無い。** HTML と ES モジュールをそのまま配ります。
  バンドラもトランスパイラもフレームワークもありません。`npm ci` は
  テスト（vitest / Playwright）と wrangler のためだけです。

---

## 中身

```
public/plan.html            作戦プランナーのページ（**マークアップだけ。<style> は無い**）
public/index.html           /plan へのリダイレクトだけ（12行）
public/_redirects           / → /plan（302）
public/_headers             キャッシュ設定（JS と CSS は毎回再検証。画像は1年 immutable）
public/css/                 画面の CSS 6ファイル（**:root のデザイントークンは plan-base.css**）
public/js/plan/             ブラウザ側の ES モジュール 25本
  app.js                      画面の組み立てと操作（ここから各モジュールを呼ぶ）
  state.js / dom.js / util.js 共有する状態／要素の引き当て／小道具
  api.js                      fetch のラッパ
  coords.js                   座標変換（ゲーム内座標 ↔ メートル ↔ SVG）とセル名
  viewport.js / render.js     ズーム・パン・縮尺／SVG の組み立て
  chrome.js                   浮いた枠の実寸を測って --chrome-top/bottom に書き戻す
  ink.js                      手書きの量子化・符号化（サーバと共用する）
  placements.js               記号と射程リング
  areas.js / zones.js         1km マスの集合演算／ゲームが決める円
  towers.js / spawns.js       マップ固定のドリルタワー／陣営スポーン
  callouts.js / gutter.js     地名／盤面の縁のセル名見出し
  sessions.js                 作戦一覧の表示用の純関数
  visibility.js               公開設定の判定（**サーバと共用する。判定の実体はここ**）
  guest.js                    ログインしていない人の閲覧（名前の自動割り当て）
  avatar.js                   Discord のアイコン（色の輪の中身に入れる）
  choice.js                   1択の欄（<select> は使わない。design-system §16）
  presence.js                 在室一覧の WebSocket
  cursors.js / changes.js     カーソル・運搬・ライブ描画の送受信／変更通知の受け方
  board/                      盤面の部品 18本（描画・ポインタ・ライブ描画・背景地図ほか）
  pages/                      gate.js（ログインの入口）/ list.js（作戦の一覧と作成）

functions/_lib/             共通 7本（session / guard / validate / ink / zones /
                            guest / visibility）
functions/api/sessions/     /api/sessions と、その下の
                            ink / placements / areas / callouts / zone / ws
functions/api/auth/         discord/start・discord/callback・logout
functions/api/me/           /api/me（ログイン状態・ゲスト名・訪問履歴）
functions/api/catalog.js    建造物カタログ
functions/api/maps/         マップ一覧／{id}/zone-presets（GET/POST/PATCH/DELETE）
functions/api/comments.js   章ごとの匿名コメント欄（下の「残してあるもの」）

workers/room/               共有カーソルを中継する Durable Object 用の、Pages とは別の Worker
  src/index.js                PlanRoom 本体（在室管理・カーソル中継）
  src/presence.js             在室管理の純粋ロジック
  src/cursors.js              カーソルのレート制御・直列化の純粋ロジック

schema.sql                  D1 のテーブル定義。**冪等**（CREATE TABLE IF NOT EXISTS 23 /
                            CREATE INDEX IF NOT EXISTS 20 / INSERT OR IGNORE 11 だけ）
migrations/                 既にある DB に1回だけ流す差分 SQL 4本（新規なら不要）
wrangler.toml               Pages 設定（**自分の値を入れる場所が2つある**）
tools/                      運用・検証スクリプト6本
  dev.mjs                     npm run dev（room 8787 と pages 8788 を同時に立てる）
  build-map-assets.sh         マップ画像から overview とタイルを作る
  do-usage.mjs                Durable Objects の使用量を1分刻みで読む
  ws-min.mjs                  最小の WebSocket クライアント（テストが使う）
  ws-load.mjs                 接続を維持して無料枠の消費を実測する
  ws-fanout.mjs               設計上限（毎秒200通）を流して配信を測る
tests/                      vitest（*.test.js 47ファイル）。**全部が統合テストではない**
                            （coords / ink-codec / zones-geom / cursor-budget /
                            room-* などはサーバを立てずに動く）
e2e/                        Playwright（*.spec.js 24ファイル。npm run test:ui が走らせるのは
                            shots.spec.js を除いた 23ファイル）
testlib/d1-direct.js        tests/ と e2e/ が共用する D1 の直接オープン
docs/design-system.md       画面の型。**UI を触るなら読んでください**
LICENSE                     MIT
THIRD-PARTY-NOTICES.md      外部データの出典とライセンス
```

### このリポジトリに入っていないもの

| | 理由 |
|---|---|
| **`public/map/`**（マップ画像 4,000枚超） | **こちらの著作物ではない。配る立場にない** |
| **デプロイの workflow** | fork した人が最初の push でいきなり Cloudflare へのデプロイを試みて、secrets が無くて落ちる形にしたくない。CI は**テストだけ**（`.github/workflows/test.yml`） |
| **開発の決定記録・調査記録・仕様書** | 上流の内部文書。コメントの中に `docs/research/...` や `docs/superpowers/specs/...` への参照が残っていますが、**このリポジトリには入っていません**（消すとコメントの由来が辿れなくなるので残してあります） |
| **`tests/naming.test.js`** | 上流のリポジトリ改名を固定するだけのテスト |

---

## コードの言葉について

**コメントは日本語です。** 主要なファイルの**先頭のコメントブロックには英語を併記**して
あります（`// EN:` で始まる行）。行の中のコメントは日本語のままです。

```js
// 盤面の見えている範囲（= SVG の viewBox）の計算。DOM は一切触らない。
//
// EN: Pure computation of the visible region of the board (the SVG viewBox); touches
//     no DOM. Zooming moves the viewBox itself instead of applying a transform scale,
//     ...
```

対象のファイルは `tests/en-headers.test.js` が一覧で持っていて、
**英語が落ちたらテストが落ちます。** 新しく主要なモジュールを足すときは、
そこに追加してください。

識別子（変数名・関数名・API のパス）はすべて英語です。
画面に出る文字列と、データベースに入る `source` の列は日本語です。

---

## 自分で立てる

必要なもの:

- **Node.js 22 以上**（wrangler 4.x が要求します。Node 20 では起動しません）
- **Cloudflare アカウント**（無料プランで足ります）
- **Discord のアプリケーション**（OAuth のログインに使います）

```bash
git clone https://github.com/DaiconMan/wardogs-board.git
cd wardogs-board
npm ci
```

### 1. D1 を作る

```bash
npx wrangler login
npx wrangler d1 create wardogs-blue      # 名前は好きなものでよい
```

出力に `database_id` の UUID が出ます。**`wrangler.toml` に貼ってください。**

```toml
[[d1_databases]]
binding = "DB"
database_name = "wardogs-blue"              # 上で付けた名前
database_id = "PUT-YOUR-OWN-DATABASE-ID-HERE"   # ← ここ
```

テーブルを作ります。`schema.sql` は `CREATE TABLE IF NOT EXISTS` と
`CREATE INDEX IF NOT EXISTS` と `INSERT OR IGNORE` だけで書いてあるので、
**何度流しても結果が変わりません**（`ALTER TABLE` は1つも入れていません。
入れると2回目で必ず落ちます)。

```bash
npx wrangler d1 execute wardogs-blue --local  --file=schema.sql   # ローカル用
npx wrangler d1 execute wardogs-blue --remote --file=schema.sql   # 本番用
```

### 2. Discord のアプリケーションを作る

[Discord Developer Portal](https://discord.com/developers/applications) で
New Application → OAuth2。

**Redirect URI を登録します。** `redirect_uri` はアクセスされたホスト名から組み立てるので、
**使うドメインぶん全部登録する必要があります。** 片方しか登録していないドメインで開くと、
Discord 側で `Invalid OAuth2 redirect_uri` になります。

```
https://<あなたの Pages プロジェクト>.pages.dev/api/auth/discord/callback
https://<独自ドメイン>/api/auth/discord/callback
http://127.0.0.1:8788/api/auth/discord/callback      # ローカルで試すなら
```

要求するスコープは **`identify` だけ**です（ユーザーID・表示名・アイコンのみ。
メールアドレスもサーバー一覧も取りません）。「公開クライアント」は OFF のまま、
Client Secret を使う構成です。

**Application ID（= Client ID）を `wrangler.toml` に貼ってください。**
これは**公開値**です（ブラウザのリダイレクト先 URL に現れるので隠す意味がありません）。

```toml
[vars]
DISCORD_CLIENT_ID = "PUT-YOUR-OWN-DISCORD-CLIENT-ID-HERE"   # ← ここ
```

### 3. Durable Object の Worker（`wardogs-room`）を出す

**Pages プロジェクトの中に Durable Object は定義できません**
（"You cannot create and deploy a Durable Object within a Pages project."）。
なので実体は別の Worker にあり、Pages 側は `wrangler.toml` の
`script_name = "wardogs-room"` で借りています。

```bash
npx wrangler deploy --config workers/room/wrangler.toml
```

**この順序に意味があります。** Pages を先に出すと、まだ存在しないクラスを指す
バインディングになりえます。`npm run deploy` は room → pages の順に出すので、
通常はそちらを使ってください。

> **`wardogs-room` に公開ルートを付けないこと。** Cookie を検証しているのは
> Pages Function（`functions/api/sessions/[id]/ws.js`）だけなので、公開ルートができると
> 認証が素通りになります（`workers_dev = false` ＋ ルート未設定のままにしてあります）。

### 4. Pages プロジェクトを作って出す

```bash
npx wrangler pages project create wardogs-board --production-branch main
npm run deploy      # room → pages の順に出す
```

D1 の binding は `wrangler.toml` の `[[d1_databases]]` から自動的に反映され、
Pages 側での手動設定は不要です（wrangler 4.142.0 で確認）。

### 5. Secrets を入れる

```bash
npx wrangler pages secret put DISCORD_CLIENT_SECRET --project-name wardogs-board
npx wrangler pages secret put SESSION_SECRET        --project-name wardogs-board
```

| 名前 | 何に使うか | 無いとどうなるか |
|---|---|---|
| `DISCORD_CLIENT_SECRET` | OAuth のトークン交換 | ログインできない |
| `SESSION_SECRET` | セッション Cookie の署名鍵（HMAC-SHA256）。**任意のランダム文字列**でよい | ログインできない |
| `ADMIN_TOKEN` | コメント欄の削除（任意） | 削除機能が出ない |
| `TURNSTILE_SECRET` | コメント欄の人間確認（任意） | 人間確認なしで動く（IPごと10分5件の制限のみ） |
| `IP_SALT` | コメント欄の IP ハッシュの塩（任意） | 既定値が使われる |
| `BLOCKED_WORDS` | コメント欄の NG ワード（カンマ区切り、任意） | 無効 |

**セッションの表は D1 に持ちません。** HMAC-SHA256 で署名した Cookie だけで
状態を持っています（`functions/_lib/session.js`）。

### 6. 独自ドメイン（任意）

Cloudflare Pages の Custom domains に追加し、DNS に CNAME
`<サブドメイン>` → `<プロジェクト>.pages.dev`（proxied）を作ります。
**ドメインを増やしたら、Discord の Redirect URI にも足してください。**

---

## マップ画像を自分で用意する

`public/map/` は空のままでも動きます。背景に地図が出ないだけで、
座標・グリッド・セル名・線・記号・エリア・円は全部そのままです
（`public/js/plan/board/basemap.js` が、画像が 404 なら何も描かずに済ませます）。

背景を出したい場合、置く場所は2つです。

```
public/map/overview/<map>.webp              2048px の1枚画像（全体表示用）
public/map/tiles/<map>/<z>/<y>/<x>.webp     512px のタイル（z は 0〜5、y が先で x が後）
```

`<map>` は `maps` テーブルの `id`（既定では `bakurani` / `ozeti` / `zestafona`）です。
タイルは**正方形・2のべき乗の格子**を前提にしています。z のタイル1枚は
`<一辺>/2^z` メートル四方で、原点はマップの左上です。
違う形のマップでは overview だけで表示されます。

巨大な元画像からこの形を作るスクリプトを置いてあります
（libvips のストリーミング処理を使うので、32768² = 4.3GB の画像でもピークメモリは
400MB 程度で済みます）。

```bash
# 要: vips（libvips）
# map-src/<map>.png を置いてから
tools/build-map-assets.sh all
```

**画像の入手は自分で解決してください。** このリポジトリは何も配りません。

`.gitignore` は **`public/map/` も無視します。** 画像はこちらの著作物ではなく、
4,000枚超をうっかり push したいものでもないからです。自分の画像をコミットすると
決めたなら、`.gitignore` の `public/map/` の行**と**
`tests/no-account-identifiers.test.js` の対応する検査（「`public/map/` を追跡していない」）
を消してください。

---

## ローカルで動かす

```bash
npx wrangler d1 execute wardogs-blue --local --file=schema.sql
cp .dev.vars.example .dev.vars        # DISCORD_CLIENT_SECRET と SESSION_SECRET を書く
npm run dev                           # room（8787）と pages（8788）を両方立てる
```

ブラウザで開くのは **http://127.0.0.1:8788** です。Ctrl-C で両方まとめて止まります。

`npm run dev` が2プロセス立てるのは、リアルタイムの実体が別の Worker
（`wardogs-room`）にあるからです。起動ログに
`env.ROOM (PlanRoom, defined in wardogs-room) ... [connected]` が出れば繋がっています。
`[not connected]` のときは `/api/sessions/:id/ws` が 503 を返します
（＝在室一覧とカーソルだけが出ない。他は全部動く）。

---

## テスト

```bash
npm test        # vitest（*.test.js 47ファイル）
npm run test:ui # Playwright の UIテスト（23ファイル。shots.spec.js は除く）
npm run shots   # 目視確認用のスクリーンショットを shots/ に再生成（git 管理外）
```

**`npm test` は全部が統合テストではありません。** `plan-coords` / `plan-ink-codec` /
`plan-zones-geom` / `plan-cursor-budget` / `room-cursors` / `room-presence` /
`en-headers` / `no-account-identifiers` はサーバを立てずに動く単体テストです。

**どちらもローカルの `wrangler pages dev` / `wrangler dev` を相手にします。**
外に出る通信は2つだけです。

- `npm ci` と `npx playwright install` のダウンロード
- Turnstile のテストが `challenges.cloudflare.com` へ POST する
  （Cloudflare 公式のテスト用キー。`1x00000000000000000000AA` は常に成功、
  `2x0000000000000000000000000000000AA` は常に失敗）

**マップ画像が無くてもテストは全部通ります。** 画像に触るテストは
「`#basemap` の `href` 属性が `/map/overview/<map>.webp` になっているか」
「`**/map/**` を全部落としても盤面が壊れないか」のように、
**属性と失敗時の挙動**を見ていて、画像そのものを読み込みません。

### 同時に立てるときのポート

複数の `wrangler pages dev` を同時に立てる場合は、`--port` だけでなく
**`--inspector-port` と `--persist-to` も全部インスタンスごとに分けてください。**

- `--inspector-port`: `--port` を変えても inspector は既定 9229 のまま固定なので、衝突します
- `--persist-to`: D1 の永続化先。共有すると同時書き込みでロック競合が起き、`D1_ERROR` → 500 になります

| 用途 | ポート | inspector | persist-to |
|---|---|---|---|
| vitest（コメント欄、設定別に4つ） | 8811-8814 | 9311-9314 | `.wrangler/test-state` |
| vitest（/plan） | 8831 | 9331 | `.wrangler/plan-state` |
| e2e（/plan） | 8832 | 9332 | `.wrangler/e2e-plan-state` |
| e2e（room / Durable Object） | 8833 | 9333 | `.wrangler/e2e-room-state` |
| `npm run dev`（room） | 8787 | 9787 | `.wrangler/dev-room-state` |
| `npm run dev`（pages） | 8788 | 9788 | `.wrangler/dev-pages-state` |

**`WRANGLER_REGISTRY_PATH` も分けます。** wrangler は起動中の Worker を
**機械ごとに1つしかないレジストリ**（既定 `~/.config/.wrangler/registry`）に登録し、
`script_name` 付きの Durable Object バインディングをそこから解決します。
既定のままだと、`npm run dev` で `wardogs-room` を動かしたまま `npm test` を走らせると、
**ROOM が無いはずのテストサーバに ROOM が繋がります**
（`/api/sessions/:id/ws` が 503 のはずの所で 101 を返す）。

残骸でポートが埋まっていたら片付けてから再実行してください。

```bash
pkill -f "wrangler pages dev"; pkill -f "workers/room"; pkill workerd
```

**Playwright を同じリポジトリで同時に2つ走らせないこと。** 固定ポートと persist
ディレクトリを奪い合い、大量に偽陽性で落ちます。

---

## 無料枠から出ないための決まり

Durable Objects で枠を意味のある量で使うのは **受信リクエスト 10万/日**だけで、
**受信20通が1リクエスト**です。つまり効くのは「部屋の全員が毎秒何通送るか」で、
人数そのものではありません。そこでクライアントが**在室の人数を見て送信頻度を下げ**、
合計を 200通/秒 に収めます。

| 在室 | 1人あたりの送信頻度 | 合計 |
|---|---|---|
| 〜10人 | 10Hz | 100通/秒 |
| 〜25人 | 6Hz | 150通/秒 |
| 〜50人 | 4Hz | 200通/秒 |

30分の作戦1回で 200通/秒 × 1,800秒 ÷ 20 = **18,000 リクエスト ＝ 1日枠の 18%**。
**素朴に 50人 × 10Hz にすると 45%** に跳ねます。
`tests/plan-cursor-budget.test.js` がこの不変条件（1人から上限まで、
人数 × 頻度 ≤ 200通/秒）を固定しています。**頻度を上げると落ちます。**

ほかに守っていること:

- `[[migrations]]` は **`new_sqlite_classes`**。`new_classes` と書くと key-value backend
  になり、それは Workers **有料プラン専用**です（＝無料枠から出る）
- **`state.acceptWebSocket()` だけ**を使う。`accept()` はつながっている間ずっと
  実行時間が課金され、タブ1枚を放置すると1日の実行時間枠の 83% を食います
- **DO にタイマーを1本も作らない**（`setInterval` / `setAlarm` / `setTimeout` のどれも）。
  ハートビートは `setWebSocketAutoResponse("p" → "o")`（ハイバネーションを解かない）。
  カーソルの配信は**受信で駆動**します。`tests/room-cursors.test.js` がソースを
  見張っていて、タイマーを足すと落ちます
- クライアントのカーソル送信は**スロットル＋同じ座標は送らない**。
  `document.hidden` の間は送らない
- クライアントは再接続に jitter 付きバックオフ＋上限10回、無操作10分で自分から切断

無料プランは枠を超えても**課金されず、その種類の操作がエラーで止まる**だけです。
日次の枠は **00:00 UTC にリセット**されます（月次ではありません）。

使用量を実測する道具が2つあります。

```bash
# WebSocket を張って維持するだけ（人を集めずに接続数を作る）
node tools/ws-load.mjs --base https://example.com --plan <作戦ID> --cookie "$COOKIE" \
  --clients 20 --minutes 30

# 1分刻みの実数を GraphQL API から読む（静止中に課金が増えていないかの確認）
#   要: CLOUDFLARE_API_TOKEN（Account Analytics Read）/ CLOUDFLARE_ACCOUNT_ID
#   要: DO_NAMESPACE_ID（DO 名前空間の ID。取り方は tools/do-usage.mjs の先頭）
node tools/do-usage.mjs --minutes 10
```

---

## 残してあるもの（コメント欄）

このプロジェクトの出発点は**章ごとに匿名コメント欄が付いた静的ページ**で、
名前（`wardogs-board`）に残っているのはそれです。`/` の配信は止めて `/plan` へ
302 で送っていますが（`public/_redirects`）、コメント欄の API（`/api/comments`）と
テーブルはそのまま残してあります。

**UI はもうどのページにもありません。** `/` の配信を止めたときに一緒に無くなったので、
**残っているのはサーバ側だけ**です（API を直接叩く形になります）。
使うなら、どこかのページに投稿フォームと Turnstile のウィジェットを自分で足してください。

- 章は11個（`functions/api/comments.js` の `SECTIONS`）。足すならここに id を入れる
- 制限値: 同ファイル冒頭の定数（本文1000文字、名前24文字、IPごと10分5件、
  一覧は1回2000件まで、本文に URL は2つまで）
- 人間確認: Cloudflare Turnstile。**`TURNSTILE_SECRET` を設定すると `POST` は
  トークンを要求します。** ウィジェットが無いまま設定すると、投稿が全部 403 になります
  （サイトキーの埋め込みとシークレットの登録はセットで）。未設定なら人間確認なしで動く
- 削除: `DELETE /api/comments?id=<投稿ID>` に `Authorization: Bearer <ADMIN_TOKEN>`
- IP は**ハッシュ化**して保存します（`IP_SALT` 付き）。生の IP は保存しません

---

## ライセンスと出典

- このリポジトリのコードは **MIT License**（`LICENSE`）
- **`schema.sql` のドリルタワー 12 本と陣営スポーン 9 件の座標は
  [apollyon-sys/wardogs-calculator](https://github.com/apollyon-sys/wardogs-calculator)
  （MIT, Copyright (c) 2026 Apollyon）に由来します。**
  MIT は著作権表示を残すことが条件なので、全文と加えた変換を
  **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)** に置いてあります。
  **数値を足す・直すときは、その記載も一緒に維持してください。**
- **マップ画像は入っていません**（こちらの著作物ではない）
- WARDOGS は Team17 / Bulkhead の著作物です。これは非公式のファンメイドで、
  両社とは関係がありません
