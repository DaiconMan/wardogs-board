// 画面がいま何を持っているか。**ここは何も import しない**（循環を作らない）。
//
// EN: What the screen is currently holding. This file imports nothing, so it cannot
//     take part in a cycle. The defaults for a freshly opened board live here too,
//     since they are the initial value of state itself.
//
// 開いた直後の既定値もここに置く。state の初期値そのものなので、
// 持ち主を別のファイルにすると「初期値だけ別の所にある」状態になる。

/**
 * 開いた直後の道具、そして道具を外したときに戻る先。
 *
 * **「移動」。** 地図を見るつもりのドラッグが線になってはいけない
 * （オーナー報告: 「初期設定がペンだと、スクロールしようとして書いてしまう」）。
 * 地図の道具の既定は動かすことで、描くときに道具を選ぶ。
 */
export const DEFAULT_MODE = "pan";

/** 背景地図の既定。モノクロ（インクが地形に埋もれないため）。 */
export const BASEMAP_DEFAULT = "mono";

export const state = {
  me: null,
  plan: null,
  coords: null,
  color: "cursor-1",
  width: 2,
  // **覚えない**（背景の見せ方やパレットの開閉と違って localStorage に残さない）。
  // 間違いの重さが左右で違う。移動で始めて損するのはボタン1回ぶんだが、
  // ペンで始めると、見るだけのつもりの操作が線として保存されてしまう。
  mode: DEFAULT_MODE,
  drawing: null,     // { points: [{x_m,y_m}], path: SVGPathElement }
  // このセッションで自分がやった操作を、やった順に持つ（取り消しの台帳）。
  //   線   … { path, saving: Promise<id>, ink: { color, width, points } }
  //   配置 … { placement }
  //   地名 … { callout }
  //   エリア … { area }
  //   スタンプ … { stamp }
  // 線を { path, saving } の形にしてあるのは、保存が終わる前に取り消し・
  // 消しゴムが来ても「保存を待ってから消す」ができるようにするため。
  // 種類が混ざっているので、取り消しは末尾から順に見て種類ごとに戻す。
  //
  // **`ink` は「やり直す」ために要る中身**（色・太さ・点の列）。配置・地名・エリアは
  // オブジェクト自身が中身を持っているが、線は `postInk()` に渡したら捨てていた。
  mine: [],
  // 戻した操作の**写し**を積む山（やり直しの山）。中身は history.js の `snapshotOf`。
  // **参照ではなく値**（戻す ＝ 画面のオブジェクトが消えるので、参照では作り直せない）。
  // 新しい操作をしたら捨てる（分岐した履歴を持たない）。
  undone: [],
  // まとめ操作（まとめて消す・動かす）が走っている最中か。
  // **盤面の取り直しを止めるために要る**（board/reload.js の `boardBusy`）。
  // 指を離したあとに N 回の PATCH / DELETE が流れる間はポインタが触れていないので、
  // これが無いと他の人の `chg` が着地して、まだ保存していない座標が古い値へ戻る。
  bulk: false,
  editable: false,
  // 見えている範囲（メートル）。null の間は盤面の操作を全部受け付けない。
  view: null,
  // 画面に触れているポインタ。2本になったらピンチに切り替える。
  pointers: new Map(),
  // { anchor, start, slop, moved, tap } ドラッグでパン中。moved が false の間は
  // まだ「押しただけ」かもしれない状態で、閾値を超えずに離したら tap を呼ぶ。
  pan: null,
  // { p, kind, from, start, slop, moved } 置いたマーカーをドラッグ中。
  drag: null,
  // いま自分が運んでいるもの（`["p"|"c", id, x, y]`）。他の人の画面で絵だけ動かす印で、
  // **カーソルの通に相乗りして飛ぶ**（cursors.js の `carryOf` / board/cursor.js）。
  //
  // `drag` と別に持つのは、**離したあと保存が片付くまで残す**ため。先に外すと、
  // 相手の画面で「元の位置へ跳ね返ってから新しい位置へ飛ぶ」のが見える。
  carry: null,
  pinch: null,       // { anchor: {x,y}, dist: number } 2本指で操作中
  spaceHeld: false,
  anim: null,        // requestAnimationFrame の id
  basemap: BASEMAP_DEFAULT,
  // ── 建造物・設置物・車輌 ──
  catalog: new Map(),  // item_id -> カタログ項目
  // 画面に出ている配置。{ uid, id, item_id, x_m, y_m, created_by, marker, range, saving }
  placements: [],
  pick: null,        // パレットで選んでいる item_id（配置モードのときだけ入る）
  selected: null,    // 詳細を出している配置（state.placements の要素）
  showRanges: true,
  // ── 地名（この作戦の中だけの呼び名）──
  // { uid, id, name, x_m, y_m, created_by, node, saving }
  callouts: [],
  selectedCallout: null,  // 詳細を出している地名（state.callouts の要素）
  showCallouts: true,
  // ── スタンプ（図形・向きを持つ印・軍用記号）──
  // 定義（どんなスタンプがあるか。全体で共通）と、この作戦に置いたもの。
  // どちらも `GET /api/sessions/:id/stamps` の1往復で降りてくる。
  stampDefs: [],      // { id, label, shape, color, glyph, draw_kind, builtin }
  stampDefById: new Map(),
  // { uid, id, stamp_id, x_m, y_m, x2_m, y2_m, note, created_by, node, saving }
  // 向きを持つものは `x2_m` / `y2_m` を持つ（点のものは null）。
  stamps: [],
  stampPick: null,    // 棚で選んでいる定義の id（スタンプの道具のときだけ入る）
  selectedStamp: null, // 詳細を出しているスタンプ（state.stamps の要素）
  showStamps: true,
  // { def, from, to, node, start, slop } 向きを持つスタンプを引いている最中。
  // エリアの `paint` と範囲選択の `band` と同じ形（引いている最中の持ち方を増やさない）。
  stampDraw: null,
  // ── ドリルタワー（マップ固定の設備。チームが置いた物ではない）──
  // 盤面の取得に相乗りして降りてくる。編集しないので id で引き直す必要が無く、
  // 画面の <g> を作ったら以後は位置の付け替えだけ。
  towers: [],
  showTowers: true,
  // ── 陣営スポーン（セーフゾーン。こちらもマップ固定）──
  spawns: [],
  showSpawns: true,
  // ── コントロールエリア（ゲームが決めた円）──
  // プリセットはマップ静的（admin だけが作る）。「どのパターンを想定するか」だけが作戦ごと。
  // **円の中のタワーは持たない。**毎回 towersInZone() で出す（調査 §4.3）。
  zonePresets: [],
  zonePresetId: null,
  zoneDefaultRadiusM: 500,
  showZonePreset: true,
  // 管理者が入力中の、まだ保存していない円（破線で出す）。{ x_m, y_m, radius_m, name }
  zonePreview: null,
  // ── エリア（1km セルの塗り）──
  // サーバから来た行と、自分が今塗った行（id はまだ null）が同じ列に混ざる。
  // id の昇順に op（add / sub）を適用して areaSets を作り直す（areas.js）。
  areas: [],
  areaSets: new Map(),
  zoneKind: null,    // 選んでいるエリアの種類。state.pick（建造物）とは排他
  zoneErase: false,  // 「消しゴム」を選んでいる＝塗るのではなく消す
  showAreas: true,
  // { from, to, rect, start, slop } 塗っている最中（プレビューを出している）
  paint: null,
  // ── 範囲選択（「選択」の道具）────────────────────────────────
  // **対象は配置と地名だけ**（線は消しゴム、エリアは塗りの取り消しがある）。
  // { from, to, rect, start, slop } 枠を引いている最中（プレビューを出している）。
  // エリアの `paint` と同じ形にしてある（引いている最中の持ち方を2通り作らない）。
  band: null,
  // 枠で選んだもの。`{ items, mine }` で、`items` には**他人のものも入る**
  // （枠に入ったことは見せる。ただし操作は `mine` にしか効かない）。
  // 詳細パネルは件数の内訳をここから出す。
  picked: null,
  // { items, from: [{x_m,y_m}…], start, slop, moved } まとめて運んでいる最中。
  // 1個のドラッグ（`drag`）とは別に持つ。**運んでいる最中を相手に流さない**
  // （D-069 の仕組みは1個を前提にしていて、複数を載せると通が太る。v1 の割り切り）。
  bandDrag: null,
  // 最後にポインタがあった地点（メートル）。`c` キーでのコピーがここを使う。
  lastPoint: null,
};

/** 動かせる・消せるのは置いた本人と管理者だけ（サーバ側の判定と同じ）。 */
export const canEdit = (p) => p.created_by === state.me?.user?.id || state.me?.user?.role === "admin";

/**
 * 「戻す」「やり直す」の2つの山を1つの形で渡す（history.js の関数が受ける形）。
 *
 * **毎回包み直すが、中の配列は本物**なので、積む・捨てるはそのまま state に効く。
 * 山の持ち主を state.js のまま据え置けるので、history.js は何も import せずに済む。
 */
export const history = () => ({ done: state.mine, undone: state.undone });

/**
 * 範囲選択で選んでいた列から1件外す。**消えたものを掴み続けないため。**
 *
 * 呼ぶのは「画面から配置・地名を外す所」（`removePlacement` / `removeCallout`）。
 * 外した結果1件も残らなければ選択そのものを解く（0件の選択を抱えない）。
 *
 * ここに置いてあるのは、**消す側（place.js / callout.js）が範囲選択の実装を
 * import せずに済ませるため**。盤面の持ち物の後片付けなので state の受け持ち。
 */
export function dropPicked(o) {
  const sel = state.picked;
  if (!sel) return;
  for (const list of [sel.items, sel.mine]) {
    const i = list.indexOf(o);
    if (i !== -1) list.splice(i, 1);
  }
  if (sel.items.length === 0) state.picked = null;
}
