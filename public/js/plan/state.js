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
  //   線   … { path, saving: Promise<id> }
  //   配置 … { placement }
  // 線を { path, saving } の形にしてあるのは、保存が終わる前に取り消し・
  // 消しゴムが来ても「保存を待ってから消す」ができるようにするため。
  // 種類が混ざっているので、取り消しは末尾から順に見て種類ごとに戻す。
  mine: [],
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
  // 最後にポインタがあった地点（メートル）。`c` キーでのコピーがここを使う。
  lastPoint: null,
};

/** 動かせる・消せるのは置いた本人と管理者だけ（サーバ側の判定と同じ）。 */
export const canEdit = (p) => p.created_by === state.me?.user?.id || state.me?.user?.role === "admin";
