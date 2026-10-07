// ドリルタワー（マップ固定の設備）の見せ方。
//
// EN: Drill tower presentation. Towers belong to the map, not to the team: the
//     positions are identical every match and arrive from GET /api/sessions/{id}.
//     Not the same object as the buildable drill rig in the catalogue.
//
// **これはゲームが持っている物であって、チームが置いた物ではない。**
// 位置は毎試合同じで、`GET /api/sessions/{id}` が `towers` として返す
// （マップ静的な map_towers テーブル。出典は MIT ライセンスのリポジトリ）。
// FOB に建てる「ドリルリグ」（catalog_items.drill_rig）とは別物
// （docs/research/2026-09-29-zones-drills-data.md §4.4）。
//
// 盤面には3種類の物が出るので、見た目の規則を明確に分ける:
//
//   置いた物（placements）… 塗りつぶした形（四角・三角・丸・ピン）＋種別の色。
//                            押せる・動かせる・消せる。
//   地名（callouts）      … 小さな点＋その右に文字。無彩色。押せる。
//   ドリルタワー（towers）… **線だけの塔の形。塗りつぶさない。無彩色。押せない。**
//                            地面に立っている物なので、座標は**塔の足元**。
//
// 「塗りつぶさない」「押せない」の2つが、置いた物との一番はっきりした違いになる。
// 触れないものは自分たちの持ち物ではない、が指でも分かる。
//
// 単位: このモジュールが受け取る座標は SVG ユーザー単位（= メートル、y だけ反転済み）。

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 塔の印の高さ（CSS px）。足元から先端まで。
 *
 * 実寸では描かない。タワーの物理的な大きさは未実測で、仮に 20m 四方だとしても
 * 16km 四方のマップでは全体表示で点にもならない。マーカー・地名と同じく
 * 画面上で一定の大きさにして、app.js が viewBox から逆算した倍率で打ち消す。
 */
export const TOWER_MARK_PX = 14;

/**
 * 名前を出す視野の広さ（メートル）。これ以下に寄ったときだけ出す。
 *
 * セル名（gutter.js の CELL_NAME_VIEW_M）・エリア名（areas.js の
 * AREA_NAME_VIEW_M）と同じ 2000m にする。「どこまで寄れば何が出るか」を
 * 1つ覚えれば済むようにするため。
 *
 * 地名の 4000m より寄りにしてあるのは、タワーが 600m 四方に 3〜5 本
 * 固まっているから（調査 §4.1）。4000m で名前を出すと必ず重なる。
 */
export const TOWER_NAME_VIEW_M = 2000;

/** その視野の広さで名前を出すか。盤面がまだ測れないときは出さない側に倒す。 */
export const towerNamesVisibleAt = (viewWidthM) =>
  Number.isFinite(viewWidthM) && viewWidthM > 0 && viewWidthM <= TOWER_NAME_VIEW_M;

/**
 * 読み上げと吹き出しの文。
 * ゲーム内では FOB に建てるドリルリグも "Drill" と呼ばれるので、
 * 名前だけでは区別が付かない。何であるかを必ず添える。
 */
export const towerTitle = (name) => `${name}（ドリルタワー・マップ固定）`;

// 塔の形（CSS px、足元の中心が原点）。脚2本・接地線・筋交い1本の線画。
// 三角形の「塗り」は設置物（emplacement）のマーカーが使っているので、
// こちらは**塗らない**ことで衝突を避ける。
const H = TOWER_MARK_PX;
const LEG_X = H * 0.45;      // 足元での脚の開き（片側）
const BASE_X = H * 0.52;     // 接地線の半分
const BRACE_Y = -H * 0.5;    // 筋交いの高さ
const BRACE_X = LEG_X * 0.5;

export const TOWER_PATH_D =
  `M ${-BASE_X} 0 H ${BASE_X}` +
  ` M ${-LEG_X} 0 L 0 ${-H} L ${LEG_X} 0` +
  ` M ${-BRACE_X} ${BRACE_Y} H ${BRACE_X}`;

/** 名前を置く位置（足元から下へ、CSS px）。 */
const NAME_GAP_PX = 11;

/**
 * 「その試合で戦う対象」の印（足元の塗りつぶした丸）の半径（CSS px）。
 *
 * 対象かどうかは**コントロールエリアの円の中に入っているか**だけで決まる
 * （調査 §2.3・§4.3）。色を濃くするだけだと、モノクロの航空写真の上では
 * 濃い灰色と灰色の差が読めないので、**形でも変える**。
 */
const LIVE_DOT_R = H * 0.16;

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * タワー 1 本。中身は4つ:
 *   * `.tw-halo` … 同じ形を一回り太い紙色の線で下に敷く。モノクロ航空写真に沈まない。
 *   * `.tw-mark` … 塔の線画。塗らない。
 *   * `.tw-name` … 足元の下に置く名前。寄ったときだけ出す。
 *   * `<title>`  … 読み上げ。何であるかを書く（名前だけだとドリルリグと紛れる）。
 */
export function createTower(tower) {
  const g = el("g", { class: "tw" });
  g.dataset.towerId = String(tower.id);
  g.appendChild(el("path", { class: "tw-halo", d: TOWER_PATH_D }));
  g.appendChild(el("path", { class: "tw-mark", d: TOWER_PATH_D }));
  // 対象のときだけ出る足元の丸（表示の制御は CSS の data-live）。
  g.appendChild(el("circle", { class: "tw-live", cx: 0, cy: 0, r: LIVE_DOT_R }));

  const name = el("text", {
    class: "tw-name",
    x: 0,
    y: NAME_GAP_PX,
    "text-anchor": "middle",
    "dominant-baseline": "hanging",
  });
  name.textContent = tower.name;
  g.appendChild(name);

  const title = el("title", {});
  title.textContent = towerTitle(tower.name);
  g.appendChild(title);
  return g;
}

/**
 * 置き直す。`metersPerPx` は「画面1px が何メートルか」。
 * マーカー・地名と同じで、形と文字の大きさは画面上で一定にする。
 */
export function setTowerTransform(node, at, metersPerPx) {
  node.setAttribute("transform", `translate(${at.x} ${at.y}) scale(${metersPerPx})`);
}

/**
 * 「その試合で戦う対象か」を印に反映する。
 *
 * 判定そのものはここではやらない（zones.js の towersInZone）。この関数は
 * 結果を DOM に写すだけ。判定と描画を1箇所に混ぜると、円を選び直したときに
 * 片方だけ更新される形の事故が出る。
 */
export function setTowerLive(node, live) {
  if (live) node.dataset.live = "1";
  else delete node.dataset.live;
}

/**
 * **その1本を盤面に出すか。**
 *
 * オーナー指摘（2026-10-01）:
 *   > どのプリセットを選んでも、全タワーが有効になっているように見えます。
 *   > 有効のものだけ表示でお願いしたいです
 *
 * 「円の中だけ強調」では、9パターンぶんの座標を入れた意味が画面に出ていなかった。
 * パターンが決まっているなら**その試合で戦わない塔は出さない。**
 *
 * ゲーム内では無効な塔も破線で出る（D-055 の調査）が、**ここはゲーム画面の
 * 再現ではなく作戦を練る場**なので、オーナーの指示どおり消す側に倒す。
 *
 * 判定はここではやらない（zones.js の towersInZone）。この関数は結果を DOM に
 * 写すだけ。`setTowerLive` と同じ約束。
 *
 * `hidden` を**属性で**付けるのは、SVG 要素に HTMLElement の `hidden`
 * プロパティが無いため（`#towers` の表示 on/off と同じやり方）。
 */
export function setTowerShown(node, shown) {
  if (shown) node.removeAttribute("hidden");
  else node.setAttribute("hidden", "");
}
