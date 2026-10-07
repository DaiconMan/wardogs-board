# Third-party notices / 第三者のデータとライセンス

このリポジトリは MIT License（`LICENSE`）で配布しています。
そのうえで、**他の人の著作物から取り込んだ数値が1件あります。**
MIT は「著作権表示とライセンス文を残すこと」が条件なので、このファイルを置いています。

This repository is distributed under the MIT License (see `LICENSE`).
It also contains **one set of numbers taken from someone else's work**.
The MIT License requires the copyright notice and the license text to be kept,
so they are reproduced here.

---

## apollyon-sys/wardogs-calculator (MIT)

`schema.sql` の **ドリルタワー 12 本**（`map_towers`）と
**陣営スポーン 9 件**（`map_spawns`）の座標は、次のリポジトリの `maps/*.json` に由来します。

The drill tower (`map_towers`, 12 rows) and faction spawn (`map_spawns`, 9 rows)
coordinates in `schema.sql` are derived from `maps/*.json` in:

- Repository: https://github.com/apollyon-sys/wardogs-calculator
- Files: `maps/bakurani.json` / `maps/ozeti.json` / `maps/zestafona.json`
- License: **MIT License, Copyright (c) 2026 Apollyon**
- Retrieved: 2026-09-29

**数値を足す・直すときは、この記載も一緒に維持してください。**
If you add to or correct those numbers, keep this notice with them.

### 使ってよいもの / 使ってはいけないもの — what is and is not reused

| | 扱い / treatment |
|---|---|
| `maps/*.json` の中の座標（`markers` / `polygons` / `bounds` / `tileBounds`） | **使っている。** MIT。この帰属表示が条件<br>**Used.** MIT; this attribution is the condition |
| 上流の `tiles.path` が指す CDN | **使っていない。** 上流が hotlink / proxy / scrape / mirror / bulk-download を明示的に禁じている<br>**Not used**, because the upstream explicitly forbids hotlinking, proxying, scraping, mirroring and bulk downloads |
| 他サイトが抽出したゲームデータ（エリアのプリセットなど） | **使っていない。** 自動抽出と再配布を禁じている利用規約があるため<br>**Not used**, because of terms of use that forbid automated extraction and redistribution |

### こちらで加えた変換 — transformations applied

原データそのままではありません。These are not the upstream values verbatim.

1. **Bakurani / Ozeti は 16320/16384 倍しています。**
   JSON の座標空間は3マップとも 0〜16,384m（`tileBounds` が `-0.03〜163.83`）ですが、
   実際の一辺は Bakurani / Ozeti が 16,320m、Zestafona が 16,384m です。
   Zestafona だけは倍率 1 で、JSON の値がそのまま入っています。
   *Bakurani and Ozeti are scaled by 16320/16384; Zestafona is unscaled.*
2. **小数第1位に丸めています。** 出典どうしの食い違いが 0.5〜6.5m あるので、
   それ以上の桁は意味を持ちません（`map_towers.accuracy_m` に食い違いの幅が入っています）。
   *Rounded to one decimal place; sources disagree by 0.5-6.5 m, and the spread is
   recorded in `map_towers.accuracy_m`.*
3. **色は取り込んでいません。** JSON の `#d86666` / `#82c596` / `#5fa8d3` は陣営の
   対応づけにだけ使い、値そのものは持ちません（このプロジェクトの色は
   `public/css/plan-base.css` のデザイントークンで決めます）。
   *Colours are not imported; they were used only to map rows to factions.*
4. **Ozeti の `valkyra` マーカーは使っていません。**
   JSON の Ozeti の `valkyra` マーカーは Bakurani とまったく同じ座標 `(11875, 7093)` で、
   同じ JSON 内の Valkyra の多角形・ベンダー群（13,300〜14,000m 付近）と数 km 食い違います。
   **上流の取り違えと判断し、スポーンは多角形のほうから取りました。**
   *The Ozeti `valkyra` marker duplicates the Bakurani one and contradicts the
   polygons in the same file by several kilometres, so the polygon was used instead.*

### ライセンス全文 — full license text

```
MIT License

Copyright (c) 2026 Apollyon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## マップ画像は入っていません — map images are not included

`public/map/` は**このリポジトリに含まれていません。**
ゲームのマップ画像はこちらの著作物ではなく、配る立場にありません。
用意のしかたは README を見てください。**無くても動きます。**

`public/map/` is **not part of this repository.** The game's map imagery is not
ours to redistribute. The README explains how to supply your own; the app works
without it.

---

## WARDOGS について — about the game

WARDOGS は Team17 / Bulkhead の著作物です。このプロジェクトはファンが作った
非公式の道具で、Team17・Bulkhead とは関係がありません。**ゲームには一切触れません**
（プロセスを読まない、ファイルを読まない、通信に割り込まない）。

WARDOGS is the property of Team17 / Bulkhead. This is an unofficial, fan-made
tool with no affiliation to either. **It does not touch the game** in any way:
it reads no process memory, no game files, and intercepts no traffic.
