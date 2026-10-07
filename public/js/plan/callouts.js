// 地名（コールアウト）の見せ方。
//
// EN: Callout (place name) presentation. These are the nicknames a team actually says
//     out loud. Callouts are stored per plan, and are drawn as a small achromatic dot
//     plus text so they never read as placements.
//
// 「あの丘」「工場」「北の橋」といった、チームが Discord でそのまま喋る呼び名を
// 地図に置く。**実体はプランごと**（session_callouts）で、試合ごとに注目する
// 場所が変わるぶん、作戦によって呼び名を変えたり要らない地名を消したりできる。
//
// 配置（placements）とは別物なので、見た目もはっきり分ける:
//
//   置いた物（placements）… 形（四角・三角・丸・ピン）＋種別の色。「ここに建てる」
//   地名（callouts）      … **小さな点＋その脇に文字**。無彩色。「ここはこう呼ぶ」
//
// ピンや四角にしないのは、地名が「置いた物」ではなく「地図に元からある情報」だから。
// GoogleMap で地名がピンではなく文字で書かれているのと同じ理屈で、文字そのものを
// 地図に置く。
//
// 単位: このモジュールが受け取る座標は SVG ユーザー単位（= メートル、y だけ反転済み）。

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 名前の長さ。サーバ側（functions/api/sessions/[id]/callouts.js の NAME_MAX）と
 * schema.sql のコメントと同じ 24 文字。ここを緩めると入力できるのに 400 になる。
 */
export const NAME_MAX_LEN = 24;

/**
 * 1プランに置ける地名の上限。サーバ側の MAX_PER_PLAN と同じ値。
 *
 * 200 にした理由: マップは 16km 四方（1km セルが 256 個）なので、200 件は
 * おおよそ 1 セルに 1 個弱にあたる。丘・工場・橋・交差点を一通り名付けても
 * 届く数でありながら、名前を出す広さ（下の CALLOUT_NAME_VIEW_M = 4km 四方）で
 * 画面に出るのは平均 12〜13 件に収まる。無制限にすると 16km 四方が文字で
 * 埋まって地形が読めなくなる（D-030 §4-1 で「セル名 256 個が常時出ているのが
 * 本命の問題」と分析したのと同じ失敗になる）。
 */
export const MAX_CALLOUTS_PER_PLAN = 200;

/**
 * 名前を出す視野の広さ（メートル）。これより広く見ているときは点だけにする。
 *
 * 4000m は 100m の補助線が出始めるのと同じ広さ（app.js の FINE_VISIBLE_W_M）。
 * 「細かい情報が出る寄り具合」を1つに揃えておくと、どこまで寄れば何が見えるかを
 * 覚え直さずに済む。選んでいるものとカーソルの下だけは、広くても名前を出す
 * （CSS 側。何を選んでいるか分からなくなるのを防ぐ）。
 */
export const CALLOUT_NAME_VIEW_M = 4000;

/** 点の大きさと、名前を置く位置（中心からの CSS px）。 */
export const CALLOUT_DOT_PX = 3.5;
const NAME_GAP_PX = CALLOUT_DOT_PX + 5;

/**
 * 入力された名前を整える。サーバの normalizeName と同じ作法。
 * 通らない値（空・空白だけ・長すぎ・文字列でない）は null を返す。
 * 文字数は書記素ではなくコードポイントで数える（絵文字を半分で切らない）。
 */
export function normalizeCalloutName(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  if ([...t].length > NAME_MAX_LEN) return null;
  return t;
}

/** その視野の広さで名前を出すか。盤面がまだ測れないときは出さない側に倒す。 */
export const namesVisibleAt = (viewWidthM) =>
  Number.isFinite(viewWidthM) && viewWidthM > 0 && viewWidthM <= CALLOUT_NAME_VIEW_M;

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * 地名 1 件。中身は4つ:
 *   * `.co-halo` … 点の下に敷く紙色の輪。モノクロの航空写真の上で点が沈まない。
 *   * `.co-dot`  … 小さな点。ここが「その地点」。
 *   * `.co-name` … 点の右に置く名前。四角い枠も吹き出しも付けない
 *     （枠を付けると「置いた物」に見える）。読めるよう紙色で縁取るだけにする。
 *   * `<title>`  … 指したときの吹き出しと読み上げ。省略しない。
 *
 * `uid` はページ内だけの通し番号。保存前（id 未確定）でも当たり判定から引ける。
 */
export function createCallout(callout) {
  const g = el("g", { class: "co" });
  g.dataset.uid = String(callout.uid);
  g.appendChild(el("circle", { class: "co-halo", cx: 0, cy: 0, r: CALLOUT_DOT_PX }));
  g.appendChild(el("circle", { class: "co-dot", cx: 0, cy: 0, r: CALLOUT_DOT_PX }));

  const name = el("text", {
    class: "co-name",
    x: NAME_GAP_PX,
    y: 0,
    "text-anchor": "start",
    "dominant-baseline": "central",
  });
  name.textContent = callout.name;
  g.appendChild(name);

  const title = el("title", {});
  title.textContent = callout.name;
  g.appendChild(title);
  return g;
}

/** 名前を出し直す。同じ文字なら書き換えない（テキストノードを作り直さない）。 */
export function setCalloutName(node, name) {
  const text = node.querySelector(".co-name");
  if (text && text.textContent !== name) text.textContent = name;
  const title = node.querySelector("title");
  if (title && title.textContent !== name) title.textContent = name;
}

/**
 * 地名を置き直す。`metersPerPx` は「画面1px が何メートルか」。
 * マーカーと同じく、点と文字の大きさは画面上で一定にする
 * （実寸を持たない記号なので、地図と一緒に伸縮させると全体表示で消える）。
 */
export function setCalloutTransform(node, at, metersPerPx) {
  node.setAttribute("transform", `translate(${at.x} ${at.y}) scale(${metersPerPx})`);
}
