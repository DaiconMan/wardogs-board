// カタログ項目の見せ方と、配置のマーカー・射程リングの組み立て。
//
// EN: Catalogue item presentation, placement markers and range rings. Markers keep a
//     constant on-screen size (the footprint columns are all NULL and the map is 16 km
//     across, so a fixed size in metres would be invisible when zoomed out), and
//     shapes differ per kind rather than by colour alone. Range rings and FOB build
//     radii are the opposite: they are real dimensions, so they are drawn at true
//     scale in metres.
//
// 設計の要点（データの実情から決めている）:
//
//   * マーカーは「画面上で一定の大きさ」にする。`footprint_w_m` / `footprint_h_m` が
//     全項目 NULL で実寸が分からないうえ、マップは 16000m 四方なので、メートルで
//     固定サイズにすると全体表示では点にもならず見えない。よって形の座標は
//     CSS px で書き、app.js が viewBox から逆算した倍率で `scale()` して打ち消す。
//   * 形は種別ごとに変える（色だけで区別しない）。構造物＝四角、設置物＝三角、
//     車輌＝丸、試合の要素＝ピン。カタログに未知の kind が増えたときは角丸の四角にする。
//   * 射程リングと FOB の建築範囲は「実寸（メートル）」で描く。こちらは意味のある
//     寸法なので、ズームしても地図と同じ縮尺で伸縮しなければ嘘になる。
//
// 単位: このモジュールが受け取る座標は SVG ユーザー単位（= メートル、y だけ反転済み）。
// 変換は coords.js が持つ（ここでは呼ばない）。

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 種別の並び順と見出し。カタログの kind はこの4つ（schema.sql の catalog_items）。
 *
 * 「試合の要素」を先頭に置いているのは、パレットが先頭のグループだけ開いた状態で
 * 始まるため。開いた瞬間にドリル位置と HQ が見えることを優先する
 * （建造物より先に決まるのは「どこで何をするか」のほう）。
 */
export const KINDS = [
  { kind: "objective", label: "試合の要素" },
  { kind: "structure", label: "構造物" },
  { kind: "emplacement", label: "設置物" },
  { kind: "vehicle", label: "車輌" },
];

/** 試合の要素（作図用の記号）か。ゲームの測定値を持たない項目。 */
export const isObjective = (item) => item?.kind === "objective";

/**
 * 試合の要素の形とグリフ。
 *
 * 形は kind ではなく item_id で決める。catalog_items に列を足さないのは、
 * これがゲーム内の測定値ではなく、こちらの表示上の取り決めだから
 * （データではなく設計なので、DB ではなくコードに置く）。
 *
 * 色は既存トークンの名前だけを使う（新しい色は足さない）。割り当ての実体は
 * plan.html の `#placements .pm[data-item-id=...]` にある。
 */
export const OBJECTIVE_GLYPH = {
  mk_hotzone:   { glyph: "倍", color: "hot" },
  mk_drill:     { glyph: "D",  color: "hot" },
  mk_hq:        { glyph: "H",  color: "blue" },
  mk_spawn:     { glyph: "S",  color: "green" },
  mk_enemy_fob: { glyph: "F",  color: "red" },
  mk_defend:    { glyph: "守", color: "blue" },
  mk_attack:    { glyph: "攻", color: "hot" },
  mk_danger:    { glyph: "!",  color: "red" },
  mk_note:      { glyph: "＊", color: "muted" },
};

/**
 * 全角の字か（Latin-1 の外なら全角扱い）。ピンの頭に文字を収めるときの幅の判定に使う。
 * 記号は1文字と決めているので先頭の符号位置だけ見る。
 */
export const isWideGlyph = (glyph) => (glyph?.codePointAt(0) ?? 0) > 0xff;

/** 作図用の記号なら { glyph, color }、そうでなければ null。 */
export const objectiveGlyph = (itemId) =>
  (itemId && Object.hasOwn(OBJECTIVE_GLYPH, itemId)) ? OBJECTIVE_GLYPH[itemId] : null;

/**
 * 置いた直後に注記を書くことが前提の記号。
 *
 * ドリル位置や HQ は「そこに何があるか」を示す印なので、置いた時点で言いたいことは
 * 済んでいる。こちらの4つは逆で、記号そのものには「守る」「攻める」しか意味が無く、
 * 何をどう守るのかは書かないと伝わらない。置いた直後に注記の欄へ入れる。
 */
export const NOTE_ITEM_IDS = ["mk_note", "mk_defend", "mk_attack", "mk_danger"];
export const wantsNote = (itemId) => NOTE_ITEM_IDS.includes(itemId);

/**
 * 注記の上限。サーバ側（functions/api/sessions/[id]/placements.js の LABEL_MAX）と
 * 同じ値。ここを緩めると入力できるのに保存で 400 になる欄ができる。
 */
export const LABEL_MAX_LEN = 48;

/**
 * 優先度の選択肢。マーカーの中に1桁で描くので 1〜9（サーバの RANK_MAX と同じ）。
 */
export const RANK_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * 注記を全文で出す視野の広さ（メートル）。これより広いと省略する。
 *
 * 注記は選んでいなくても常時出す（「ここ守ろう」は見えていないと意味が無い）。
 * ただし 16km 四方を見渡しているときに全部を全文で出すと、地図が文字で埋まって
 * 地形が読めなくなる。広いときは頭だけ見せて「そこに何か書いてある」を伝え、
 * 寄ったら全文にする。
 */
export const NOTE_FULL_VIEW_M = 4000;
export const NOTE_SHORT_LEN = 6;

/**
 * 地図に出す注記の文字。注記が無ければ空文字（項目名を出すかは呼ぶ側の判断）。
 * 文字数はサーバの検証と同じくコードポイントで数える（絵文字を半分で切らない）。
 */
export function noteText(label, viewWidthM) {
  const t = typeof label === "string" ? label.trim() : "";
  if (!t) return "";
  const chars = [...t];
  if (viewWidthM <= NOTE_FULL_VIEW_M || chars.length <= NOTE_SHORT_LEN) return t;
  return `${chars.slice(0, NOTE_SHORT_LEN).join("")}…`;
}

/** マーカーの大きさ（CSS px）。中心から端まで。 */
export const MARKER_PX = 8;

export const FOB_ITEM_ID = "fob";

/**
 * FOB の建築範囲。
 *
 * 正方形であることはオーナーがゲーム内で確認済み（schema.sql の notes 参照）。
 * ただし一辺の長さは未確定で、出典にある「60m」が半径相当なのか一辺の半分なのかも
 * 分かっていない。ここでは「中心から ±60m（= 120m 四方）」を暫定で描き、
 * UI では必ず未確認であることを添える（FOB_RANGE_NOTE）。
 */
export const FOB_HALF_M = 60;
export const FOB_SIDE_M = FOB_HALF_M * 2;
export const FOB_RANGE_NOTE =
  `建築範囲は正方形（ゲーム内で確認済み）。一辺の長さは未確認のため、` +
  `中心から±${FOB_HALF_M}m（${FOB_SIDE_M}m四方）を暫定で描いています。`;

export const isFob = (item) => item?.id === FOB_ITEM_ID;

/**
 * ホットゾーン（半径 85m の円）。
 *
 * **これは作戦の核心である**（D-052）。中に入ると**人数が2倍に数えられる**ので、
 * 半径 85m の小さい円を押さえるだけで兵力が倍になる。しかも時間で動き、
 * ドリルリグで引き寄せられる。だから「どこに来たらどう動くか」「どこへ
 * 引き寄せるか」を事前に置いて比べる価値がある。
 *
 * **ゲームが出すものだが、ここに置かれるのはチームの想定。**
 * コントロールエリア（`map_zone_presets`）はマップ静的な実データなので
 * あちらには入れられない。1km マスの塗り（`session_areas`）も代わりにならない
 * （1マスは この円の約44倍の面積。tests/plan-hotzone.test.js がその比を押さえている）。
 *
 * 半径をカタログの列ではなくここに持つ理由は FOB_HALF_M と同じで、
 * **行ごとに変わらない1つの決め**だから。`catalog_items` に入れると
 * 「未検証」の出し所が2系統（バッジと注記）に分かれる。
 */
export const HOTZONE_ITEM_ID = "mk_hotzone";

/**
 * 半径。調査（docs/research/2026-09-29-zones-drills-data.md）の 85m。
 * オーナーの実機スクリーンショットでも、半径 500m のコントロールエリアを
 * 基準に測って直径およそ 160m（＝半径 80m）でほぼ一致した。
 * **ゲーム内で実測して確かめた値ではない**ので、UI では必ず未検証と添える。
 */
export const HOTZONE_RADIUS_M = 85;

export const isHotzone = (item) => item?.id === HOTZONE_ITEM_ID;

/** 円に添える札。**ただの円だと何の円か分からない**ので、効果そのものを書く。 */
export const HOTZONE_LABEL_TEXT = "人数×2";

/**
 * 札を出す視野の広さ（メートル）。これ**以下**のときだけ出す。
 *
 * エリアの種類名（広いときだけ出す）とは逆で、こちらは**寄ったときだけ**出す。
 * 16km 四方を見ているとき、この円は画面上で数 px しかないので、札だけが
 * 地図に浮いて何を指しているか分からなくなる（§8「地図の上に文字を撒かない」）。
 * 値は注記を全文にする境目（NOTE_FULL_VIEW_M）と同じにして、覚える数を増やさない。
 */
export const HOTZONE_LABEL_VIEW_M = NOTE_FULL_VIEW_M;
export const hotzoneLabelVisibleAt = (viewWidthM) =>
  Number.isFinite(viewWidthM) && viewWidthM > 0 && viewWidthM <= HOTZONE_LABEL_VIEW_M;

/**
 * 置いた直後に `#status` へ出す一言。
 * **効果（人数2倍）と、半径が未検証であることを同時に言う。**
 * 半径だけ言うと「その円を押さえると何が起きるか」が伝わらず、効果だけ言うと
 * 確定した寸法のように見える（D-026）。
 */
export const hotzoneNote = () =>
  `中に入ると人数が2倍に数えられます。半径 ${HOTZONE_RADIUS_M}m（未検証）。` +
  `ホットゾーンは時間で動き、ドリルリグで引き寄せられます。`;

/** 射程が分かっている項目か。0 や NULL は「分かっていない」扱い。 */
export const hasRange = (item) =>
  Number.isFinite(item?.range_max_m) && item.range_max_m > 0;

/** 最小射程（デッドゾーン）が分かっている項目か。 */
export const hasMinRange = (item) =>
  hasRange(item) && Number.isFinite(item.range_min_m) && item.range_min_m > 0;

/** 未検証の数値を確定値のように見せない。全項目 verified=0 の今は常に true。 */
export const isUnverified = (item) => !item || item.verified !== 1;

const fmtM = (n) => String(Math.round(n * 10) / 10);

/**
 * コストの短い表示。NULL は「不明」と書く（0 や空欄で誤魔化さない）。
 *
 * 試合の要素だけは空文字を返す。あちらはゲームが与える情報や判断を置く記号で、
 * コストという概念が無い。「不明」と書くと「調べれば分かる値がまだ無い」に
 * 見えてしまううえ、8項目ぶん意味の無い行が並ぶ。呼ぶ側は空なら行を出さない。
 */
export function costText(item) {
  if (isObjective(item)) return "";
  const cost = item?.cost_supplies;
  return Number.isFinite(cost) ? `物資 ${cost}` : "コスト不明";
}

/** 射程の短い表示。最小射程があれば「80–684m」の形にする。空文字の扱いは costText と同じ。 */
export function rangeText(item) {
  if (isObjective(item)) return "";
  if (!hasRange(item)) return "射程不明";
  if (hasMinRange(item)) return `射程 ${fmtM(item.range_min_m)}–${fmtM(item.range_max_m)}m`;
  return `射程 ${fmtM(item.range_max_m)}m`;
}

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 名前を出す位置（マーカーの中心からの CSS px）。 */
const LABEL_GAP_PX = MARKER_PX + 13;

/**
 * ピン（しずく型）の輪郭。中心を原点に、先が下を向く。
 *
 * 四角・三角・丸のどれとも違う形にすることで、「これは建てるものではなく、
 * 試合が与える情報や、こちらの判断だ」を形だけで示す。
 * 頭の丸の中にグリフ（D / H / 守 …）を入れるので、丸は大きめに取る。
 */
const PIN_HEAD_R = MARKER_PX * 0.78;
const PIN_HEAD_CY = -MARKER_PX * 0.22;
const round2 = (v) => Math.round(v * 100) / 100;

function pinPath() {
  const r = MARKER_PX;
  const rh = PIN_HEAD_R;
  const cy = PIN_HEAD_CY;
  const shoulder = round2(cy + rh * 0.62);
  return (
    `M 0 ${r}` +
    ` C ${round2(-r * 0.42)} ${round2(r * 0.22)} ${round2(-rh)} ${shoulder} ${round2(-rh)} ${round2(cy)}` +
    ` A ${round2(rh)} ${round2(rh)} 0 1 1 ${round2(rh)} ${round2(cy)}` +
    ` C ${round2(rh)} ${shoulder} ${round2(r * 0.42)} ${round2(r * 0.22)} 0 ${r}` +
    ` Z`
  );
}

/** 種別ごとの形。座標は CSS px（app.js が scale で実寸に落とす）。 */
function markerShape(kind, itemId, className) {
  const r = MARKER_PX;
  // 試合の要素はピン。形は kind ではなく item_id で決める（未知の item_id でも
  // kind が objective ならピンにして、建造物と取り違えないようにする）。
  if (kind === "objective" || objectiveGlyph(itemId)) {
    return el("path", { class: className, d: pinPath() });
  }
  if (kind === "emplacement") {
    return el("polygon", { class: className, points: `0,${-r} ${r},${r * 0.8} ${-r},${r * 0.8}` });
  }
  if (kind === "vehicle") {
    return el("circle", { class: className, cx: 0, cy: 0, r });
  }
  if (kind === "structure") {
    return el("rect", { class: className, x: -r, y: -r, width: r * 2, height: r * 2 });
  }
  // 未知の kind。四角とも三角とも丸とも見分けがつく角丸にしておく。
  return el("rect", { class: className, x: -r, y: -r, width: r * 2, height: r * 2, rx: r * 0.6 });
}

/**
 * 配置のマーカー。`uid` はページ内だけの通し番号で、保存前（id 未確定）でも
 * 当たり判定から配置を引けるようにするためのもの。保存できたら app.js が
 * `data-placement-id` も足す。
 *
 * 中身は4つ（`.pm-glyph` だけ試合の要素のときに増える）:
 *   * `.pm-halo`  … 同じ形を一回り太い線で下に敷く。背景がモノクロの航空写真
 *     なので、これが無いと細い枠線の図形が地形に埋もれて見つけられない。
 *   * `.pm-shape` … 本体。形（種別）と色（種別）の二重符号化。色だけに頼らない。
 *   * `.pm-glyph` … 試合の要素だけ。同じピンが8種類あるので、頭の中に
 *     1〜2文字（D / H / 守 …）を入れて色以外でも見分けられるようにする。
 *   * `.pm-label` … 項目名、または注記。項目名は常時出すと置いた数だけ文字が
 *     重なるのでホバーと選択のときだけ出すが、注記が書いてあるときはそちらを
 *     常時出す（表示の制御は CSS 側。setMarkerLabel が data-note を立てる）。
 *   * `.pm-rank-badge` … 優先度があるときだけ。中身は円と数字（setMarkerRank）。
 */
export function createMarker(placement, item) {
  const g = el("g", { class: "pm" });
  g.dataset.uid = String(placement.uid);
  g.dataset.kind = item?.kind ?? "unknown";
  g.dataset.itemId = placement.item_id;
  g.appendChild(markerShape(item?.kind, placement.item_id, "pm-halo"));
  g.appendChild(markerShape(item?.kind, placement.item_id, "pm-shape"));

  const mark = objectiveGlyph(placement.item_id);
  if (mark) {
    const glyph = el("text", {
      class: "pm-glyph",
      x: 0,
      y: round2(PIN_HEAD_CY),
      "text-anchor": "middle",
      "dominant-baseline": "central",
    });
    // 全角（守・攻・＊）は1文字の幅が字送りいっぱいあるので、そのままだと
    // 頭の丸からはみ出す。文字の大きさはトークン（--t-eyebrow）のまま、
    // 丸の内側に収まる幅へ詰める。半角（D・H・!）は詰めると間延びするので触らない。
    if (isWideGlyph(mark.glyph)) {
      glyph.setAttribute("textLength", String(round2(PIN_HEAD_R * 1.5)));
      glyph.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
    glyph.textContent = mark.glyph;
    g.appendChild(glyph);
  }

  const name = item ? item.name_ja : placement.item_id;
  const label = el("text", {
    class: "pm-label", x: 0, y: LABEL_GAP_PX, "text-anchor": "middle",
  });
  label.textContent = name;
  g.appendChild(label);

  const title = el("title", {});
  title.textContent = name;
  g.appendChild(title);
  return g;
}

/**
 * マーカーの文字を出し直す。
 *
 * 注記があればそれを出し（項目名より注記を優先。「ここ守ろう」は見えていないと
 * 意味が無いので CSS 側で常時表示にする）、無ければ従来どおり項目名を出して
 * ホバー・選択のときだけ見せる。視野の広さで全文と省略が変わるので、
 * ズーム・パンのたびに呼ばれる。同じ文字なら書き換えない（毎フレーム
 * textContent を代入すると、そのたびにテキストノードが作り直される）。
 *
 * `<title>`（マウスを乗せたときの吹き出しと読み上げ）は省略しない。
 * 地図が省略していても、指せば全文が読めるようにしておく。
 */
export function setMarkerLabel(marker, placement, item, viewWidthM) {
  const text = marker.querySelector(".pm-label");
  if (!text) return;
  const name = item ? item.name_ja : placement.item_id;
  const note = noteText(placement.label, viewWidthM);
  const shown = note || name;
  if (text.textContent !== shown) text.textContent = shown;
  if (note) marker.dataset.note = "true";
  else delete marker.dataset.note;

  const title = marker.querySelector("title");
  const full = placement.label ? `${name}｜${placement.label}` : name;
  if (title && title.textContent !== full) title.textContent = full;
}

/**
 * 優先度の数字。
 *
 * 形の中心には既にグリフ（D / H / 守 …）が入っていて、そこへ数字を重ねると
 * どちらも読めなくなる。両方を持つ配置はありうる（「守 の1番」など）ので、
 * 数字は形の右上に小さな円で貼る。位置は種別によらず同じにして、
 * 「数字はいつも右上」を一度覚えれば探さなくて済むようにする。
 *
 * 円の中心を形の外へ十分に離してあるのは、全角のグリフ（幅いっぱいの「守」）の
 * 右上の角と重ならない距離を取るため（実測で 6.2px 離れる。円の半径は 5.2px）。
 */
const RANK_R = round2(MARKER_PX * 0.65);
const RANK_C = round2(MARKER_PX * 1.25);

export function setMarkerRank(marker, rank) {
  marker.querySelector(".pm-rank-badge")?.remove();
  if (!Number.isInteger(rank)) return;

  const badge = el("g", { class: "pm-rank-badge" });
  badge.appendChild(el("circle", { class: "pm-rank-disc", cx: RANK_C, cy: -RANK_C, r: RANK_R }));
  const num = el("text", {
    class: "pm-rank",
    x: RANK_C,
    y: -RANK_C,
    "text-anchor": "middle",
    "dominant-baseline": "central",
  });
  num.textContent = String(rank);
  badge.appendChild(num);
  marker.appendChild(badge);
}

/**
 * マーカーを置き直す。`metersPerPx` は「画面1px が何メートルか」。
 * scale でそれを掛けることで、形の px 座標が画面上でそのままの大きさになる。
 */
export function setMarkerTransform(marker, at, metersPerPx) {
  marker.setAttribute("transform", `translate(${at.x} ${at.y}) scale(${metersPerPx})`);
}

/** 円を path で描く（塗りに穴を開けるため。fill-rule=evenodd と組で使う）。 */
const circlePath = (cx, cy, r) =>
  `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;

/**
 * 射程リングと FOB の建築範囲。すべて実寸（メートル）。
 * 描くものが何も無ければ null を返す（空の <g> を残さない）。
 *
 * リングは3つの要素でできている:
 *   * `.rng-band` … 届く範囲の半透明の塗り。最小射程があれば内側に穴を開ける。
 *   * `.rng-max`  … 最大射程の実線の円。
 *   * `.rng-min`  … 最小射程の破線の円（内側。ここには撃てない＝デッドゾーン）。
 */
export function createRange(placement, item, at) {
  const g = el("g", { class: "rng" });
  g.dataset.uid = String(placement.uid);
  g.dataset.itemId = placement.item_id;
  let drew = false;

  if (hasRange(item)) {
    const max = item.range_max_m;
    const min = hasMinRange(item) ? item.range_min_m : 0;
    const band = el("path", { class: "rng-band", "fill-rule": "evenodd" });
    band.setAttribute(
      "d",
      min
        ? `${circlePath(at.x, at.y, max)} ${circlePath(at.x, at.y, min)}`
        : circlePath(at.x, at.y, max)
    );
    g.appendChild(band);
    g.appendChild(el("circle", { class: "rng-max", cx: at.x, cy: at.y, r: max }));
    if (min) g.appendChild(el("circle", { class: "rng-min", cx: at.x, cy: at.y, r: min }));
    drew = true;
  }

  if (isFob(item)) {
    g.appendChild(el("rect", {
      class: "fob-range",
      x: at.x - FOB_HALF_M,
      y: at.y - FOB_HALF_M,
      width: FOB_SIDE_M,
      height: FOB_SIDE_M,
    }));
    const title = el("title", {});
    title.textContent = FOB_RANGE_NOTE;
    g.appendChild(title);
    drew = true;
  }

  return drew ? g : null;
}

/**
 * ホットゾーンの円。**実寸（メートル）**で、半径は 85m 固定。
 *
 * **コントロールエリアの円（`.zp`）と見間違えないことが、この見た目の要件。**
 * 区別は4つの軸で付ける（大きさだけに頼らない。寄れば画面上の大きさは同じになる）。
 *
 *   大きさ … 半径 85m（あちらは 500m）
 *   色     … `--hot`（あちらは無彩色）
 *   線     … 破線（あちらは実線。「動くもの・想定」であることを形でも示す）
 *   中心   … 掴めるピン（あちらは触れない十字）
 *
 * 中身は4つ:
 *   `.hz-face`  … ごく薄い面。「中か外か」が読めればよく、地形を消してはいけない
 *   `.hz-halo`  … 背景から浮かせる下敷き（マーカー・円・塔と同じ手）
 *   `.hz-ring`  … 破線の輪
 *   `.hz-label` … 「人数×2」。**別の <g> に入れて scale を当てる**（文字だけ画面固定）
 *
 * `at` は SVG ユーザー単位（= メートル、y だけ反転済み）。
 */
export function createHotzone(placement, at) {
  const g = el("g", { class: "hz" });
  g.dataset.uid = String(placement.uid);

  for (const cls of ["hz-face", "hz-halo", "hz-ring"]) {
    g.appendChild(el("circle", { class: cls, cx: at.x, cy: at.y, r: HOTZONE_RADIUS_M }));
  }

  // 札は円の上端から少し上。円そのものは実寸なので、ここだけ scale で画面固定に戻す
  // （CSS に font-size:12px と書くと 12 ユーザー単位 ＝ 12m になり、画面上では点になる）。
  const label = el("g", { class: "hz-label" });
  label.dataset.atX = String(at.x);
  label.dataset.atY = String(at.y - HOTZONE_RADIUS_M);
  const text = el("text", {
    class: "hz-name",
    x: 0,
    y: -HOTZONE_LABEL_GAP_PX,
    "text-anchor": "middle",
  });
  text.textContent = HOTZONE_LABEL_TEXT;
  label.appendChild(text);
  g.appendChild(label);
  return g;
}

/** 札を円の上端からどれだけ上に置くか（CSS px）。コントロールエリアの名前と同じ量。 */
const HOTZONE_LABEL_GAP_PX = 8;

/**
 * 札の位置と大きさを今の縮尺に合わせる。ズーム・パンのたびに呼ばれる。
 * `metersPerPx` は「画面1px が何メートルか」。
 */
export function setHotzoneLabelScale(hotzone, metersPerPx, viewWidthM) {
  const label = hotzone?.querySelector(".hz-label");
  if (!label) return;
  const { atX, atY } = label.dataset;
  label.setAttribute("transform", `translate(${atX} ${atY}) scale(${metersPerPx})`);
  // 広く見ているときは出さない（円が点になるので、札だけが地図に浮く）。
  if (hotzoneLabelVisibleAt(viewWidthM)) label.removeAttribute("hidden");
  else label.setAttribute("hidden", "");
}
