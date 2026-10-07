#!/usr/bin/env bash
#
# 巨大マップ PNG (16384^2 / 32768^2, 8bit RGBA) から Web 配信用の画像を作る。
#
#   map-src/<map>.png ─┬─> map-out/overview/<map>.webp  (2048px の1枚画像)
#                      │    └─> public/map/overview/<map>.webp
#                      └─> map-out/normalized/<map>.v   (16384px に正規化)
#                           └─> public/map/tiles/<map>/<z>/<y>/<x>.webp
#
# libvips のストリーミング処理を使うので、32768^2 = 4.3GB の画像でも
# ピークメモリは 400MB 程度で済む（全体をメモリに載せない）。
# 中間生成物は map-out/ 配下（.gitignore 済み）。配信物だけ public/map/ に置く。
#
# 3 枚とも同じゲーム内 16,000m x 16,000m を表すが元解像度が違うので、
# タイル化の前に 16384px へ正規化して、全マップを最大ズーム z=5・32x32 格子に揃える。
# 16000m / 16384px = 0.98 m/px。ゲーム公式が「1 メートル毎ピクセルで個々の建物が見える」
# として挙げている水準で、作戦プランナーには十分。
#
# 使い方:
#   tools/build-map-assets.sh alpha      [map...]  アルファチャンネルの実態を調べる
#   tools/build-map-assets.sh overview   [map...]  2048px の1枚画像を作る
#   tools/build-map-assets.sh verify     [map...]  overview を元画像と突き合わせる
#   tools/build-map-assets.sh publish    [map...]  overview を public/map/ へ配置する
#   tools/build-map-assets.sh normalize  [map...]  タイル化の入力を 16384px に揃える
#   tools/build-map-assets.sh tiles      [map...]  タイルピラミッドを作る
#   tools/build-map-assets.sh tileverify [map...]  タイルの枚数・原点・格子を検証する
#   tools/build-map-assets.sh all        [map...]  上を順に全部
#
# どのサブコマンドも冪等。再実行すれば同じ結果になる。
# map を省略すると 3 枚すべてが対象。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${SRC_DIR:-$ROOT/map-src}"
OUT_DIR="${OUT_DIR:-$ROOT/map-out}"

ALL_MAPS=(bakurani ozeti zestafona)

# 出力の一辺。3 枚とも同じゲーム内 16,000m x 16,000m を表すので、
# 元解像度が違っても overview は同じ 2048px に揃える。
OVERVIEW_SIZE="${OVERVIEW_SIZE:-2048}"
OVERVIEW_Q="${OVERVIEW_Q:-82}"
OVERVIEW_MAX_BYTES="${OVERVIEW_MAX_BYTES:-2000000}"

# タイル化の入力を揃える一辺。512 x 2^5 = 16384 なので最大ズームは z=5。
NORM_SIZE="${NORM_SIZE:-16384}"
TILE_SIZE="${TILE_SIZE:-512}"
TILE_Q="${TILE_Q:-80}"

# Pages から配信するので public/ の下に置く。ここだけが git 管理対象。
PUBLIC_MAP="${PUBLIC_MAP:-$ROOT/public/map}"

# 空きメモリを他のプロセスと分け合うので、vips のスレッド数は控えめにする。
export VIPS_CONCURRENCY="${VIPS_CONCURRENCY:-3}"

die() { echo "エラー: $*" >&2; exit 1; }

command -v vips >/dev/null && command -v vipsheader >/dev/null || die "vips / vipsheader が見つからない"

# 引数からマップ名の配列を組み立てる
resolve_maps() {
  if [ "$#" -eq 0 ]; then
    printf '%s\n' "${ALL_MAPS[@]}"
    return
  fi
  for m in "$@"; do
    [ -f "$SRC_DIR/$m.png" ] || die "$SRC_DIR/$m.png が無い"
    echo "$m"
  done
}

src_of()   { echo "$SRC_DIR/$1.png"; }
width_of() { vipsheader -f width "$(src_of "$1")"; }

# --------------------------------------------------------------------------
# alpha: アルファが本当に使われているかを 1 パスのヒストグラムで確かめる。
# 全画素が 255 なら不透明なので、WebP からアルファを落としてよい。
# --------------------------------------------------------------------------
cmd_alpha() {
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  for m in $(resolve_maps "$@"); do
    local bands; bands="$(vipsheader -f bands "$(src_of "$m")")"
    if [ "$bands" -lt 4 ]; then
      echo "$m: $bands バンド（アルファ無し）"
      continue
    fi
    vips hist_find "$(src_of "$m")" "$tmp/h.v"
    vips extract_band "$tmp/h.v" "$tmp/a.v" 3
    vips copy "$tmp/a.v" "$tmp/a.csv"
    python3 - "$tmp/a.csv" "$m" <<'PY'
import sys
counts = [int(float(x)) for x in open(sys.argv[1]).read().split()]
used = [(v, n) for v, n in enumerate(counts) if n]
total = sum(counts)
if used == [(255, total)]:
    print(f"{sys.argv[2]}: 全 {total:,} 画素が alpha=255（完全不透明 → アルファは落としてよい）")
else:
    print(f"{sys.argv[2]}: 透明部分あり。alpha の分布 = {used[:8]}{' ...' if len(used) > 8 else ''}")
PY
  done
}

# --------------------------------------------------------------------------
# overview: 2048x2048 の 1 枚画像。背景表示とズーム・パンの土台。
# vips thumbnail が縮小カーネル（既定 lanczos3）を掛けてくれるので、
# 単純間引きのジャギーは出ない。
# --------------------------------------------------------------------------
cmd_overview() {
  mkdir -p "$OUT_DIR/overview"
  for m in $(resolve_maps "$@"); do
    local src out q size
    src="$(src_of "$m")"; out="$OUT_DIR/overview/$m.webp"; q="$OVERVIEW_Q"
    while :; do
      vips thumbnail "$src" "$out[Q=$q,strip]" "$OVERVIEW_SIZE"
      size="$(stat -c%s "$out")"
      if [ "$size" -le "$OVERVIEW_MAX_BYTES" ] || [ "$q" -le 40 ]; then break; fi
      q=$((q - 8))
      echo "$m: $size B は上限超え。Q=$q で作り直す"
    done
    # 全画素不透明なら libwebp がアルファ面を落とすので、bands は 3 になるはず
    echo "$m: $out  $(numfmt --to=iec --suffix=B "$size")  Q=$q  $(vipsheader -f bands "$out") バンド  $(vipsheader -f width "$out")x$(vipsheader -f height "$out")"
  done
}

# --------------------------------------------------------------------------
# verify: 「作った」で終わらせないための突き合わせ。
#   1. vips shrink で元画像の厳密なブロック平均を作る（これが正解の基準）
#   2. 生成した WebP との差分の平均・最大を出す
#   3. 四隅と中央の画素を並べて表示する
# 上下左右の反転や原点ずれがあれば、四隅の値と平均差が跳ね上がって分かる。
# --------------------------------------------------------------------------
cmd_verify() {
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  for m in $(resolve_maps "$@"); do
    local out w f last mid
    out="$OUT_DIR/overview/$m.webp"
    [ -f "$out" ] || die "$out が無い。先に overview を実行する"
    w="$(width_of "$m")"; f=$((w / OVERVIEW_SIZE))
    last=$((OVERVIEW_SIZE - 1)); mid=$((OVERVIEW_SIZE / 2))

    vips shrink "$(src_of "$m")" "$tmp/avg.v" "$f" "$f"        # 厳密なブロック平均
    vips extract_band "$tmp/avg.v" "$tmp/avg3.v" 0 --n 3
    vips subtract "$tmp/avg3.v" "$out" "$tmp/d.v"
    vips abs "$tmp/d.v" "$tmp/da.v"
    echo "=== $m  元 ${w}px → ${OVERVIEW_SIZE}px (1/$f) ==="
    echo "  |ブロック平均 - 生成WebP|  平均差 $(vips avg "$tmp/da.v")  最大差 $(vips max "$tmp/da.v")"
    printf "  %-6s %-11s %-22s %s\n" "位置" "座標" "元のブロック平均(RGB)" "生成WebP(RGB)"
    for p in "0 0 左上" "$last 0 右上" "$mid $mid 中央" "0 $last 左下" "$last $last 右下"; do
      set -- $p
      printf "  %-6s (%4s,%4s) %-22s %s\n" "$3" "$1" "$2" \
        "$(vips getpoint "$tmp/avg3.v" "$1" "$2" | tr '\n' ' ')" \
        "$(vips getpoint "$out" "$1" "$2" | tr '\n' ' ')"
    done
    rm -f "$tmp/avg.v" "$tmp/avg3.v" "$tmp/d.v" "$tmp/da.v"
  done
}

# --------------------------------------------------------------------------
# publish: overview を public/map/ へ配置する。Pages から配信するため、
# これだけは git にコミットする（3 枚で約 3.8MB）。
# --------------------------------------------------------------------------
cmd_publish() {
  mkdir -p "$PUBLIC_MAP/overview"
  for m in $(resolve_maps "$@"); do
    local src="$OUT_DIR/overview/$m.webp"
    [ -f "$src" ] || die "$src が無い。先に overview を実行する"
    cp -f "$src" "$PUBLIC_MAP/overview/$m.webp"
    echo "$m: $PUBLIC_MAP/overview/$m.webp  $(numfmt --to=iec --suffix=B "$(stat -c%s "$src")")"
  done
}

# --------------------------------------------------------------------------
# normalize: タイル化の入力を NORM_SIZE に揃える。
# 32768px の 2 枚は 16384px へ縮小し、vips 生形式 (.v) で置いておく。
# .v は無圧縮 + mmap 可能なので、続く dzsave が巨大な PNG を再デコードせずに済む。
# 既に正しい寸法で存在すれば作り直さない（冪等かつ再実行が速い）。
# --------------------------------------------------------------------------
norm_input_of() {
  local m="$1"
  if [ "$(width_of "$m")" -eq "$NORM_SIZE" ]; then
    src_of "$m"                       # 元から 16384px。そのまま使う
  else
    echo "$OUT_DIR/normalized/$m.v"
  fi
}

cmd_normalize() {
  mkdir -p "$OUT_DIR/normalized"
  for m in $(resolve_maps "$@"); do
    local w target
    w="$(width_of "$m")"
    if [ "$w" -eq "$NORM_SIZE" ]; then
      echo "$m: 元から ${NORM_SIZE}px。正規化は不要"
      continue
    fi
    target="$OUT_DIR/normalized/$m.v"
    if [ -f "$target" ] && [ "$(vipsheader -f width "$target" 2>/dev/null)" = "$NORM_SIZE" ]; then
      echo "$m: $target は生成済み。再利用する"
      continue
    fi
    rm -f "$target"
    vips thumbnail "$(src_of "$m")" "$target" "$NORM_SIZE"
    echo "$m: ${w}px -> $(vipsheader -f width "$target")px  $target  $(numfmt --to=iec --suffix=B "$(stat -c%s "$target")")"
  done
}

# --------------------------------------------------------------------------
# tiles: Google Maps 方式のタイルピラミッド。
# 出力先を毎回作り直すので、再実行しても古いタイルが残らない（冪等）。
# --------------------------------------------------------------------------
cmd_tiles() {
  for m in $(resolve_maps "$@"); do
    local input dir
    input="$(norm_input_of "$m")"
    [ -e "$input" ] || die "$input が無い。先に normalize を実行する"
    dir="$PUBLIC_MAP/tiles/$m"
    rm -rf "$dir"
    mkdir -p "$PUBLIC_MAP/tiles"
    vips dzsave "$input" "$dir" \
      --layout google --tile-size "$TILE_SIZE" --suffix ".webp[Q=$TILE_Q,strip]"
    # libvips 8.15 の dzsave --layout google は、出力先ではなくその「親」に
    # vips-properties.xml を書く。マップ 3 枚が同じ 1 ファイルを上書きし合ううえ、
    # 生成時刻が埋め込まれるので再実行のたびに差分が出る。
    # google レイアウトの配信は <z>/<y>/<x>.webp を直接引くだけでこれを読まないので消す。
    rm -f "$PUBLIC_MAP/tiles/vips-properties.xml" "$dir/vips-properties.xml"
    echo "$m: $dir  $(find "$dir" -type f | wc -l) ファイル  $(du -sh "$dir" | cut -f1)"
  done
}

# --------------------------------------------------------------------------
# tileverify: 「作った」で終わらせないための検証。
#   1. 実際のディレクトリ構造（<z>/<y>/<x> の順序）を実物から読む
#   2. ズームレベルごとの枚数と格子の大きさ
#   3. 原点合わせ: 最大ズームの隅のタイルを、正規化入力の同じ位置の切り出しと比較する
#      わざと隣のタイルとも比較し、差が桁違いに大きいことで検証自体が効いていると示す
# --------------------------------------------------------------------------
tile_diff() {  # <タイル> <入力> <x> <y> <tmp> -> 平均絶対差
  local tile="$1" input="$2" x="$3" y="$4" tmp="$5"
  vips crop "$input" "$tmp/c.v" "$x" "$y" "$TILE_SIZE" "$TILE_SIZE"
  vips extract_band "$tmp/c.v" "$tmp/c3.v" 0 --n 3
  vips extract_band "$tile" "$tmp/t3.v" 0 --n 3
  vips subtract "$tmp/c3.v" "$tmp/t3.v" "$tmp/d.v"
  vips abs "$tmp/d.v" "$tmp/da.v"
  vips avg "$tmp/da.v"
  rm -f "$tmp/c.v" "$tmp/c3.v" "$tmp/t3.v" "$tmp/d.v" "$tmp/da.v"
}

cmd_tileverify() {
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  for m in $(resolve_maps "$@"); do
    local dir input maxz far total_files total_bytes
    dir="$PUBLIC_MAP/tiles/$m"; input="$(norm_input_of "$m")"
    [ -d "$dir" ] || die "$dir が無い。先に tiles を実行する"

    echo "=== $m ==="
    echo "  実際のパス例: $(find "$dir" -name '*.webp' | sort | sed -n '1p' | sed "s|$dir/||")"
    echo "  タイル以外のファイル: $(find "$dir" -type f ! -name '*.webp' -printf '%f ' || true)"

    maxz="$(find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -n | tail -1)"
    printf "  %-3s %-8s %-9s %s\n" "z" "枚数" "格子" "バイト"
    total_files=0; total_bytes=0
    for z in $(find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -n); do
      local n b rows cols
      n="$(find "$dir/$z" -name '*.webp' | wc -l)"
      b="$(du -sb "$dir/$z" | cut -f1)"
      rows="$(find "$dir/$z" -mindepth 1 -maxdepth 1 -type d | wc -l)"
      cols="$(find "$dir/$z/$(find "$dir/$z" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | head -1)" -name '*.webp' | wc -l)"
      printf "  %-3s %-8s %-9s %s\n" "$z" "$n" "${rows}x${cols}" "$(numfmt --to=iec --suffix=B "$b")"
      total_files=$((total_files + n)); total_bytes=$((total_bytes + b))
    done
    echo "  合計 $total_files 枚 / $(numfmt --to=iec --suffix=B "$total_bytes") ($total_bytes B)"

    # 原点合わせ。far = 最大ズームの最終インデックス
    far=$(( NORM_SIZE / TILE_SIZE - 1 ))
    local off=$(( NORM_SIZE - TILE_SIZE ))
    echo "  原点照合 (最大ズーム z=$maxz, 入力 ${NORM_SIZE}px):"
    echo "    左上   $maxz/0/0        vs 入力(0,0)          平均差 $(tile_diff "$dir/$maxz/0/0.webp" "$input" 0 0 "$tmp")"
    echo "    右下   $maxz/$far/$far  vs 入力($off,$off)  平均差 $(tile_diff "$dir/$maxz/$far/$far.webp" "$input" "$off" "$off" "$tmp")"
    echo "    右上   $maxz/0/$far     vs 入力($off,0)     平均差 $(tile_diff "$dir/$maxz/0/$far.webp" "$input" "$off" 0 "$tmp")"
    echo "    [対照] $maxz/0/0        vs 入力($TILE_SIZE,0) 平均差 $(tile_diff "$dir/$maxz/0/0.webp" "$input" "$TILE_SIZE" 0 "$tmp") <- 大きいのが正常"
  done
}

cmd="${1:-}"; shift || true
case "$cmd" in
  alpha)      cmd_alpha "$@" ;;
  overview)   cmd_overview "$@" ;;
  verify)     cmd_verify "$@" ;;
  publish)    cmd_publish "$@" ;;
  normalize)  cmd_normalize "$@" ;;
  tiles)      cmd_tiles "$@" ;;
  tileverify) cmd_tileverify "$@" ;;
  all)        cmd_alpha "$@"; cmd_overview "$@"; cmd_verify "$@"; cmd_publish "$@"
              cmd_normalize "$@"; cmd_tiles "$@"; cmd_tileverify "$@" ;;
  *)        awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' \
              "${BASH_SOURCE[0]}" >&2; exit 1 ;;
esac
