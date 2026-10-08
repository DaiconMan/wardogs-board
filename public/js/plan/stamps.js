// スタンプの見せ方。**ここは何も import しない**（DOM の組み立て以外の判断を持たない）。
//
// EN: Stamp presentation. Shape outlines, the grouping used by the drawer, and the SVG
//     builders. Point stamps keep a constant on-screen size (like placement markers);
//     vector stamps are drawn in map coordinates because their length and direction
//     are the information, but their stroke width and arrow head stay screen-sized.
//
// オーナーの要望（D-062）:
//   「四角とか、丸、などスタンプほしいですね」
//   「スタンプは、凸型の敵とか見方を示すものもあっていいし、自由に追加もいいと思います」
//   「軍用記号です」
//
// ── 3つの列で全部を表す（新しい列を足さない）────────────────────
//
//   shape      外形。square / circle / triangle / diamond / quatrefoil / arrow / line
//   glyph      外形の中に入れる1〜2文字（歩 / 装 / 砲 / 偵 / 工 / 補）。図形は持たない
//   color      デザイントークンのキー名（blue / red / hot / green / muted）
//   draw_kind  point（1点で置く）／ vector（始点と終点をドラッグで決める）
//
// ── 軍用記号について（守ること）─────────────────────────────
//
// **狙いは「見慣れた人に一目で伝わること」なので、記号を創作しない。**
// 外形は APP-6 / MIL-STD-2525 の枠そのまま:
//
//   味方 … square（四角）
//   敵   … diamond（菱形）
//   不明 … quatrefoil（四葉）  ← APP-6 の unknown の枠。**代用していない**
//
// **APP-6 から外れているのは中身（兵種）だけ。** APP-6 は兵種を図形
// （歩兵＝×、装甲＝楕円、砲兵＝塗り丸 …）で描くが、ここでは漢字1文字で置いている。
// 16px の枠に図形を入れると潰れて見分けられないのと、VC で声に出す語
// （「歩兵」「装甲」）と画面の字が一致するほうがこのチームには速いため。
// **これは独自**なので、棚の注記（`STAMP_NOTE`）に必ず書く。
//
// 単位: このモジュールが受け取る座標は SVG ユーザー単位（= メートル、y だけ反転済み）。

const SVG_NS = "http://www.w3.org/2000/svg";

/** スタンプの大きさ（CSS px）。中心から端まで。配置マーカー（8px）と同じ。 */
export const STAMP_PX = 8;

/**
 * 注記の長さ。サーバ側（functions/api/sessions/[id]/stamps.js の NOTE_MAX）と同じ値。
 * ここを緩めると入力できるのに保存で 400 になる欄ができる。
 */
export const NOTE_MAX_LEN = 48;

/** 1作戦に置ける上限。サーバの MAX_PER_PLAN と同じ値。 */
export const MAX_STAMPS_PER_PLAN = 400;

/**
 * 向きを持つスタンプとして受け付ける最短の長さ（CSS px）。
 *
 * これより短いドラッグは「押しただけ」と見なして置かない。短い矢印は向きが
 * 読めないうえ、押すたびに長さ0の線が増える（消す手間だけが残る）。
 * 判定を px でするのは、**ズームの倍率によらず「指が動いたか」で決めたい**ため。
 */
export const VECTOR_MIN_PX = 12;

/**
 * 棚のまとまり。**`stamps` に列を足さずに、持っている値から決める。**
 *
 *   向きを持つ印 … draw_kind === "vector"
 *   図形         … glyph が無い
 *   軍用記号     … glyph がある
 */
export const STAMP_GROUPS = [
  { group: "figure", label: "図形" },
  { group: "vector", label: "向きを持つ印" },
  { group: "military", label: "軍用記号" },
];

export function stampGroup(def) {
  if (def?.draw_kind === "vector") return "vector";
  return def?.glyph ? "military" : "figure";
}

/** 向きを持つスタンプか（始点と終点の2点を持つ）。 */
export const isVector = (def) => def?.draw_kind === "vector";

/**
 * 軍用記号の陣営。**外形から決める**（APP-6 の作法そのまま）。
 * 知らない外形には陣営が無い（null）。読み上げと `<title>` に使う。
 */
const FRAME_SIDE = { square: "味方", diamond: "敵", quatrefoil: "不明" };
export const stampSide = (def) => FRAME_SIDE[def?.shape] ?? null;

/**
 * 棚に出す注記。**APP-6 から外れている所をここで名乗る。**
 *
 * 軍用記号は「見慣れた人に一目で伝わること」が狙いなので、どこが本物の作法で
 * どこがこちらの決めごとかを、使う場所に書いておく必要がある。
 */
export const STAMP_NOTE =
  "外形は APP-6 の枠（四角＝味方／菱形＝敵／四葉＝不明）に合わせています。" +
  "ただし兵種は APP-6 の図形記号ではなく漢字1文字で置いています（こちらの独自の決めごとです）。" +
  "向きを持つ印は、マップをドラッグした向きが意味を持ちます。";

/**
 * 全角の字か（Latin-1 の外なら全角扱い）。外形の中に文字を収めるときの幅の判定。
 * placements.js の `isWideGlyph` と同じ判断（記号は1文字と決めている）。
 */
export const isWideGlyph = (glyph) => (glyph?.codePointAt(0) ?? 0) > 0xff;

const round2 = (v) => Math.round(v * 100) / 100;

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * 四葉（APP-6 の「不明」の枠）の輪郭。
 *
 * 一辺 2a の正方形の各辺を、半径 a の半円で外へ膨らませる。隣り合う半円は
 * 正方形の角で尖って出会うので、**4つの葉が見える**（これが四葉の形）。
 * 中心からの出幅は a + a = 2a なので、a = STAMP_PX / 2 で他の形と同じ大きさに揃う。
 *
 * **代用ではない。** 「描きにくいから丸や四角で代える」と、見慣れた人の読みが
 * 狂う（四角は味方、丸は図形の意味に既に使っている）。
 */
export function quatrefoilPath(r = STAMP_PX) {
  const a = round2(r / 2);
  const sweep = (x, y) => `A ${a} ${a} 0 0 1 ${x} ${y}`;
  return (
    `M ${-a} ${-a} ${sweep(a, -a)} ${sweep(a, a)} ${sweep(-a, a)} ${sweep(-a, -a)} Z`
  );
}

/**
 * 外形。座標は CSS px（盤面側が `scale()` で実寸に落とす）。
 *
 * 知らない外形は**角丸の四角**にする（placements.js の未知 kind と同じ作法）。
 * 黙って描かないと、置いたのに何も出ない行ができる。
 */
export function stampShape(shape, className, r = STAMP_PX) {
  if (shape === "circle") {
    return el("circle", { class: className, cx: 0, cy: 0, r });
  }
  if (shape === "triangle") {
    return el("polygon", { class: className, points: `0,${-r} ${r},${r * 0.8} ${-r},${r * 0.8}` });
  }
  if (shape === "diamond") {
    return el("polygon", { class: className, points: `0,${-r} ${r},0 0,${r} ${-r},0` });
  }
  if (shape === "quatrefoil") {
    return el("path", { class: className, d: quatrefoilPath(r) });
  }
  if (shape === "square") {
    // APP-6 の味方の枠は横長の長方形。正方形にすると、建造物のマーカー（同じ四角）と
    // 見分けがつかない。横 2r・縦 1.5r にして、枠としての形を残す。
    return el("rect", {
      class: className, x: -r, y: round2(-r * 0.75), width: r * 2, height: round2(r * 1.5),
    });
  }
  return el("rect", { class: className, x: -r, y: -r, width: r * 2, height: r * 2, rx: r * 0.6 });
}

/** 矢の先。終点に置いて、引いた向きへ回す。座標は CSS px。 */
const HEAD_LEN = STAMP_PX * 1.6;
const HEAD_HALF = STAMP_PX * 0.9;
const arrowHeadPoints = () =>
  `0,0 ${round2(-HEAD_LEN)},${round2(-HEAD_HALF)} ${round2(-HEAD_LEN)},${round2(HEAD_HALF)}`;

/** 注記を出す位置（中心からの CSS px）。配置マーカーと同じ作法。 */
const NOTE_GAP_PX = STAMP_PX + 13;

/**
 * 地図に出す注記の文字。注記が無ければ空文字。
 * placements.js の `noteText` と同じ約束（広く見ているときは頭だけ）。
 */
export const NOTE_FULL_VIEW_M = 4000;
export const NOTE_SHORT_LEN = 6;

export function stampNoteText(note, viewWidthM) {
  const t = typeof note === "string" ? note.trim() : "";
  if (!t) return "";
  const chars = [...t];
  if (viewWidthM <= NOTE_FULL_VIEW_M || chars.length <= NOTE_SHORT_LEN) return t;
  return `${chars.slice(0, NOTE_SHORT_LEN).join("")}…`;
}

/** 指したときの吹き出しと読み上げの文。**省略しない。** */
export function stampTitle(def, note) {
  const base = def ? def.label : "スタンプ";
  return note ? `${base}｜${note}` : base;
}

/**
 * 点のスタンプ1件。中身は4つ:
 *   `.st-halo`  … 同じ形を一回り太い紙色の線で下に敷く（航空写真の上で埋もれない）
 *   `.st-shape` … 本体。外形（陣営）＋ 塗り（陣営の色）
 *   `.st-glyph` … 軍用記号のときだけ。外形の中に兵種の1文字
 *   `.st-note`  … 注記。書いてあるときだけ常時出す（配置の注記と同じ作法）
 *
 * `uid` はページ内だけの通し番号で、保存前（id 未確定）でも当たり判定から引ける。
 */
export function createStamp(stamp, def) {
  const g = el("g", { class: "st" });
  g.dataset.uid = String(stamp.uid);
  g.dataset.shape = def?.shape ?? "unknown";
  g.dataset.color = def?.color ?? "muted";
  g.dataset.drawKind = def?.draw_kind ?? "point";

  if (isVector(def)) buildVector(g, def);
  else buildPoint(g, def);

  const note = el("text", {
    class: "st-note", x: 0, y: NOTE_GAP_PX, "text-anchor": "middle",
  });
  g.appendChild(note);

  const title = el("title", {});
  title.textContent = stampTitle(def, stamp.note);
  g.appendChild(title);
  return g;
}

function buildPoint(g, def) {
  g.appendChild(stampShape(def?.shape, "st-halo"));
  g.appendChild(stampShape(def?.shape, "st-shape"));
  if (!def?.glyph) return;
  const glyph = el("text", {
    class: "st-glyph", x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central",
  });
  // 全角1文字は字送りいっぱいの幅があるので、枠の内側へ詰める
  // （文字の大きさはトークンのまま。placements.js の pm-glyph と同じ手当て）。
  if (isWideGlyph(def.glyph)) {
    glyph.setAttribute("textLength", String(round2(STAMP_PX * 1.4)));
    glyph.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }
  glyph.textContent = def.glyph;
  g.appendChild(glyph);
}

/**
 * 向きを持つスタンプ。
 *
 * **線そのものはマップ座標で引く**（長さと向きが情報なので、地図と同じ縮尺で
 * 伸縮しないと嘘になる）。太さと矢の先だけ画面基準にする:
 *   線 … `vector-effect:non-scaling-stroke`（CSS）
 *   矢 … 終点に置いた `<g>` を `scale()` で戻す（`setStampTransform`）
 */
function buildVector(g, def) {
  g.appendChild(el("line", { class: "st-line-halo", x1: 0, y1: 0, x2: 0, y2: 0 }));
  g.appendChild(el("line", { class: "st-line", x1: 0, y1: 0, x2: 0, y2: 0 }));
  // 掴みどころ。細い線は指で掴めないので、太い透明な線を上に重ねる
  // （配置マーカーの当たり判定が形だけなのと同じ考え方）。
  g.appendChild(el("line", { class: "st-hit", x1: 0, y1: 0, x2: 0, y2: 0 }));
  if (def?.shape !== "arrow") return;
  const head = el("g", { class: "st-head" });
  head.appendChild(el("polygon", { class: "st-halo", points: arrowHeadPoints() }));
  head.appendChild(el("polygon", { class: "st-shape", points: arrowHeadPoints() }));
  g.appendChild(head);
}

/**
 * 点のスタンプを置き直す。`metersPerPx` は「画面1px が何メートルか」。
 * 配置マーカーと同じく、**ズームしても見た目の大きさが変わらない**（条件9）。
 */
export function setStampTransform(node, at, metersPerPx) {
  node.setAttribute("transform", `translate(${at.x} ${at.y}) scale(${metersPerPx})`);
}

/**
 * 向きを持つスタンプを置き直す。
 *
 * `<g>` 自身には変換を掛けない（線がマップ座標のままでいる）。
 * 矢の先だけ終点へ運んで、引いた向きへ回し、画面基準の大きさへ戻す。
 */
export function setVectorTransform(node, from, to, metersPerPx) {
  for (const sel of [".st-line-halo", ".st-line", ".st-hit"]) {
    const line = node.querySelector(sel);
    if (!line) continue;
    line.setAttribute("x1", from.x);
    line.setAttribute("y1", from.y);
    line.setAttribute("x2", to.x);
    line.setAttribute("y2", to.y);
  }
  const head = node.querySelector(".st-head");
  if (head) {
    const deg = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;
    head.setAttribute(
      "transform",
      `translate(${to.x} ${to.y}) rotate(${round2(deg)}) scale(${metersPerPx})`
    );
  }
  // 注記は線の真ん中に置く（端に置くと、どちらの端の話か読めない）。
  const note = node.querySelector(".st-note");
  if (note) {
    note.setAttribute(
      "transform",
      `translate(${(from.x + to.x) / 2} ${(from.y + to.y) / 2}) scale(${metersPerPx})`
    );
  }
}

/**
 * 注記の文字を出し直す。同じ文字なら書き換えない
 * （毎フレーム textContent を代入するとテキストノードが作り直される）。
 */
export function setStampNote(node, stamp, def, viewWidthM) {
  const text = node.querySelector(".st-note");
  if (text) {
    const shown = stampNoteText(stamp.note, viewWidthM);
    if (text.textContent !== shown) text.textContent = shown;
  }
  if (stamp.note) node.dataset.note = "true";
  else delete node.dataset.note;

  const title = node.querySelector("title");
  const full = stampTitle(def, stamp.note);
  if (title && title.textContent !== full) title.textContent = full;
}

/**
 * 棚に並べる順にまとまりごとへ仕分ける。**空のまとまりは返さない。**
 * 並びは `defs` の順（サーバが id 昇順で返す ＝ 組み込みが先）。
 */
export function groupStamps(defs) {
  const out = [];
  for (const { group, label } of STAMP_GROUPS) {
    const items = (defs ?? []).filter((d) => stampGroup(d) === group);
    if (items.length) out.push({ group, label, items });
  }
  return out;
}
