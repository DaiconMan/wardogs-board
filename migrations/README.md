# migrations/ — 既存 DB に1回だけ流す差分 SQL

> EN: One-shot `ALTER` / `UPDATE` scripts for databases that already exist.
> `schema.sql` is idempotent and is what you run on a **new** database;
> the files here are what you run **once** on an existing one. If you are setting
> up a fresh copy of this project you only need `schema.sql` — skip this directory.

**新しく立てるだけなら、このディレクトリは要りません。** `schema.sql` を1回流せば
最新の形になります。ここにあるのは「**すでにデータが入っている DB** を後から追いつかせる」
ためのファイルです。

## `schema.sql` との違い

| | `schema.sql` | `migrations/*.sql` |
|---|---|---|
| 対象 | **新しく作る DB**（ローカルのテスト DB を含む） | **既に作ってある DB** |
| 何度流せるか | **何度でも**（冪等）。`CREATE TABLE IF NOT EXISTS` と `INSERT OR IGNORE` だけで書く | **1回だけ**。2回目はエラーになる |
| 誰がいつ流すか | テストが毎回自動で流す（`tests/plan-helpers.js` / `tests/plan-schema.test.js`）。新しい環境を作るときも流す | 人が手で、1回だけ |

`tests/plan-schema.test.js` が「`schema.sql` を2回続けて流しても壊れない」を検証しています。
SQLite には `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` が無いので、
**`schema.sql` に `ALTER TABLE` を書くと2回目で必ず落ちます。**

## だから列を足すときは必ず2箇所を直す

1. `schema.sql` の `CREATE TABLE ...` の**定義そのもの**に列を足す（新規 DB 用）
2. `migrations/<日付>-<内容>.sql` に `ALTER TABLE ... ADD COLUMN ...` を書く（既存 DB 用）

片方だけだと、新規 DB と既存 DB の形が食い違います。
新しいテーブルを足すだけなら `CREATE TABLE IF NOT EXISTS` を `schema.sql` に書けば済むので、
migration は要りません。

## 流し方

コマンドの `wardogs-blue` は **D1 のデータベース名**です（`wrangler.toml` の
`database_name`）。自分の名前に読み替えてください。

```bash
# まずローカル
npx wrangler d1 execute wardogs-blue --local --file=migrations/2026-09-28-add-placement-rank.sql

# 本番。事前にバックアップを取ること
npx wrangler d1 export  wardogs-blue --remote --output=backup-$(date +%F).sql
npx wrangler d1 execute wardogs-blue --remote --file=migrations/2026-09-28-add-placement-rank.sql
```

**スキーマに触る変更は、デプロイより先に適用してください。** 順序を逆にすると
「機能が出ない」ではなく「**既存機能が 500 で落ちる**」形で壊れます
（表を読むコードが `no such table: ...` を出す）。

既に当たっている migration をもう一度流すと `duplicate column name: ...` のような
エラーで止まります。これは「既に適用済み」の印なので、無理に通そうとしないこと。

## 一覧

| ファイル | 内容 |
|---|---|
| `2026-09-28-add-placement-rank.sql` | `placements.rank`（取得の優先度 1〜9）を追加 |
| `2026-09-29-add-callout-updated-at.sql` | `callouts.updated_at`（地名マスタの更新時刻）を追加 |
| `2026-09-29-fix-map-dimensions.sql` | `maps` の一辺を 16,000m → 16,320 / 16,320 / 16,384m に訂正（出典・調査日も更新） |
| `2026-10-02-add-session-visibility.sql` | `sessions.visibility`（作戦ごとの公開設定 private / public / public_edit）と `(visibility, updated_at DESC)` の索引を追加 |

### 列を足さない UPDATE の migration もある

`2026-09-29-fix-map-dimensions.sql` は `ALTER TABLE` ではなく `UPDATE` で、
**同じ行の値が誤っていた**ケースです。`schema.sql` の `INSERT OR IGNORE` は
**既にある行を書き換えない**ので、`schema.sql` を流し直しても既存の値は直りません。
値の訂正は必ずこちらの migration にも書きます（2箇所を直すのは列追加と同じ）。

この migration は `UPDATE` なので、2回流しても結果は同じ（冪等）です。
ただし**座標データは変換しません**。既存の `placements` / `ink_strokes` /
`session_callouts` / `session_areas` はメートルで入っているため、寸法だけを 2% 広げると
既存の点は地図に対してわずかに北西へ寄って見えます。変換するかどうかは、
**自分のデータを見てから決めてください**（このスクリプトは勝手に書き換えません）。
