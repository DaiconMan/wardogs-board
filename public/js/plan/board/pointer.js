// 盤面のポインタとキーボード。**「押したのか動かしたのか」の判定はここ1箇所。**
//
// パン・ドラッグでの移動・ピンチ・ホイール、そしてスペース / c / Esc。

import { patchCallout, patchPlacement } from "../api.js";
import { measureChrome, say, updateRailOverflow } from "../chrome.js";
import { carryOf } from "../cursors.js";
import { board, readoutEl } from "../dom.js";
import { DEFAULT_MODE, canEdit, state } from "../state.js";
import { clamp, movedBeyond, tapSlop } from "../util.js";
import { beginPaint, cancelPaint, clearZoneKind, endPaint, paintMove } from "./area.js";
import { moveCalloutTo, placeCalloutAt, selectCallout, setCalloutMode } from "./callout.js";
import { takeCarry } from "./carry.js";
import { sendCarry } from "./cursor.js";
import { refreshDetail } from "./detail.js";
import { clearPick } from "./drawers.js";
import { moveMarkerTo, placeAt, selectPlacement } from "./place.js";
import {
  beginStroke, cancelStroke, eraseAt, extendStroke, finishStroke, setMode,
} from "./tools.js";
import {
  copyMarkAt, gestureTo, insideMap, movePinch, pointerToMeters, readoutPaint, setView,
  startPinch, stopAnim, updateReadout, userAt, viewCentreM,
} from "./view.js";

/**
 * **何の上で押しても必ずパンになる操作**: 中ボタン、スペースキー押しながら。
 *
 * 「移動」の道具はここに入れない。移動でも**置いてあるものは押せば選べる**
 * 必要があるため（既定の道具が移動になったので、ここを混ぜると
 * 配置と地名がまったく選べなくなる）。道具としての移動は、
 * 当たり判定を外れた所に来てから効く。
 */
const forcesPan = (evt) => evt.button === 1 || state.spaceHeld;

/**
 * パンを始める。
 *
 * `deferred` のときは、閾値（TAP_SLOP_PX）を超えるまで実際には動かさない。
 * 超えずに離したら `tap` を呼ぶ＝クリック扱いにする。移動ツールやスペース
 * キーのように「パンすると分かって始めた操作」は遅らせない（反応が鈍る）。
 */
function beginPan(evt, { deferred = false, tap = null } = {}) {
  state.pan = {
    anchor: userAt(evt.clientX, evt.clientY),
    start: { x: evt.clientX, y: evt.clientY },
    slop: tapSlop(evt.pointerType),
    moved: !deferred,
    tap,
  };
  if (!deferred) board.dataset.panning = "true";
  board.setPointerCapture(evt.pointerId);
}

/**
 * 盤面でドラッグして動かせるものの、種類ごとの差分。
 *
 * ドラッグの本体（閾値の判定・楽観更新・断られたら元へ戻す）は1つにまとめ、
 * 「どう描き直すか」「どこへ保存するか」「断られたとき何と言うか」だけを分ける。
 * 分岐を endDrag の中に散らすと、配置だけ直して地名を直し忘れる形の事故が出る。
 */
const DRAGGABLE = {
  placement: {
    move: (p, at) => moveMarkerTo(p, at),
    save: (id, at) => patchPlacement(state.plan.session.id, id, at),
    denied: "他の人の配置は動かせません。動かせるのは置いた本人と管理者だけです。",
    failed: (message) => `動かせませんでした。${message}`,
    outside: "マップの外です。マップの上へ動かしてください。",
    moved: "動かしました。",
  },
  callout: {
    move: (c, at) => moveCalloutTo(c, at),
    save: (id, at) => patchCallout(state.plan.session.id, id, at),
    denied: "他の人の地名は動かせません。動かせるのは置いた本人と管理者だけです。",
    failed: (message) => `地名を動かせませんでした。${message}`,
    outside: "マップの外です。マップの上へ動かしてください。",
    moved: "地名を動かしました。",
  },
};

/** 置いたマーカー・地名をドラッグして動かし始める。 */
function beginDrag(evt, p, kind = "placement") {
  // 他の人が運んでいる最中の物を掴んだ。**手元の操作が勝つ**（仕様 §4）。
  takeCarry(p);
  state.drag = {
    p,
    kind,
    from: { x_m: p.x_m, y_m: p.y_m },
    start: { x: evt.clientX, y: evt.clientY },
    slop: tapSlop(evt.pointerType),
    moved: false,
  };
  board.setPointerCapture(evt.pointerId);
}

function dragMarker(evt) {
  const d = state.drag;
  if (!d.moved) {
    if (!movedBeyond(d.start, evt, d.slop)) return;
    d.moved = true;
    board.dataset.dragging = "true";
  }
  DRAGGABLE[d.kind].move(d.p, pointerToMeters(evt));
  // **運んでいる様子を相手の画面にも出す。** ここは値を置くだけで、
  // 送るのは既に 10Hz で飛んでいるカーソルの通（board/cursor.js の `push`）。
  // 通を1つも増やさないのが Phase R2a の設計の肝。
  sendCarry(carryOf(d));
}

/** 動かしかけを元に戻す（2本目の指が触れたとき、pointercancel）。 */
function cancelDrag() {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  delete board.dataset.dragging;
  // **中断したことを必ず相手へ届ける。** 届かないと、相手の画面では物が
  // 動かされた位置に残ったまま（実際には動いていない盤面を見ることになる）。
  sendCarry(null);
  if (!d.moved) return;
  DRAGGABLE[d.kind].move(d.p, d.from);
  refreshDetail(d.p);
}

/**
 * ドラッグを離したときの確定。楽観更新なので、断られたら元の位置へ戻す。
 * マップの外へ落としたぶんは送らずに戻す（置くときと同じ扱い。縁に丸めると
 * 余白へ落としただけの配置がマップ内のものと見分けられなくなる）。
 */
async function endDrag(d) {
  delete board.dataset.dragging;
  if (!d.moved) return;   // 押しただけ。選ぶのは pointerdown で済んでいる

  try {
    await commitDrag(d);
  } finally {
    // **運んでいる印を外すのは、保存が片付いてから**（成功でも失敗でも）。
    //
    // 離した瞬間に外すと、相手の画面では
    //   「元の位置へ跳ね返る → `chg` → 再取得 → 新しい位置へ飛ぶ」
    // が見える（再取得の着地は実測 400ms 前後）。保存が終わってから外せば、
    // 相手には `chg` が先に届いているので跳ね返りが出ない。
    // 受け取る側も、取り直しが来るなら戻すのを着地まで預ける（board/carry.js）。
    sendCarry(null);
  }
}

/**
 * ドラッグの確定そのもの。失敗はすべて中で受けて画面に出す（ここは投げない）。
 * `endDrag` の `finally` は、それでも何か漏れたときに運んでいる印を外すための保険。
 */
async function commitDrag(d) {
  const kind = DRAGGABLE[d.kind];
  const p = d.p;
  const at = { x_m: p.x_m, y_m: p.y_m };
  if (!insideMap(at)) {
    kind.move(p, d.from);
    refreshDetail(p);
    say(kind.outside);
    return;
  }

  let id;
  try {
    id = p.id ?? (await p.saving);
  } catch {
    return;   // 保存自体が失敗していた。もう画面に無い
  }

  try {
    await kind.save(id, at);
    refreshDetail(p);
    say(kind.moved);
  } catch (e) {
    kind.move(p, d.from);
    refreshDetail(p);
    say(e.status === 403 ? kind.denied : kind.failed(e.message), true);
  }
}

export function wireBoard() {
  board.addEventListener("pointerdown", (evt) => {
    if (!state.view) return;   // マップが読めていない（API 不通）
    state.pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    stopAnim();

    // 2本目が触れたら見る操作に切り替える。引きかけの線は保存せず捨てる
    // （2本指は「見たい」であって「引きたい」ではない）。
    if (state.pointers.size === 2) {
      cancelStroke();
      cancelDrag();
      cancelPaint();
      state.pan = null;
      delete board.dataset.panning;
      startPinch();
      return;
    }
    if (state.pointers.size > 2) return;

    if (forcesPan(evt)) { beginPan(evt); return; }

    // 編集できない間（読み込み中・API 不通）は押しても選べるものが無い。
    // 「移動」のときだけパンする。
    if (!state.editable) { if (state.mode === "pan") beginPan(evt); return; }

    // 置いてあるマーカーを押したときは、道具に関係なく「選ぶ」。詳細を見るのに
    // いちいち道具を持ち替えさせない。射程リングは #ranges 側で当たり判定を
    // 外してあるので、広い円が盤面を覆っても線は引ける。
    const hit = evt.target instanceof Element
      ? evt.target.closest("#placements [data-uid]") : null;
    if (hit) {
      const uid = Number(hit.dataset.uid);
      const p = state.placements.find((x) => x.uid === uid) ?? null;
      selectPlacement(p);
      // 自分の配置はそのままドラッグで動かせる（不具合2）。動かせない配置の
      // 上で始まったドラッグは、盤面の他の場所と同じくパンにする（掴んだのに
      // 何も起きないより、マップが動くほうが分かりやすい）。
      if (p && canEdit(p)) beginDrag(evt, p);
      else beginPan(evt, { deferred: true });
      return;
    }

    // 地名も配置と同じ扱い。押せば選べて、自分のものならドラッグで動かせる。
    const coHit = evt.target instanceof Element
      ? evt.target.closest("#callouts [data-uid]") : null;
    if (coHit) {
      const uid = Number(coHit.dataset.uid);
      const c = state.callouts.find((x) => x.uid === uid) ?? null;
      selectCallout(c);
      if (c && canEdit(c)) beginDrag(evt, c, "callout");
      else beginPan(evt, { deferred: true });
      return;
    }

    // 「移動」の道具。**置いてあるものの当たり判定を外れた所**でだけパンになる
    // （上の2つを通り抜けてきた ＝ 何も置かれていない地面を押した）。
    if (state.mode === "pan") { beginPan(evt); return; }

    // エリアは押した瞬間からプレビューを出す（離す前に結果を見せる）。
    // ここでパンの準備をしないので、この状態のドラッグはパンにならない。
    if (state.mode === "zone" && state.zoneKind) { beginPaint(evt); return; }

    // 置くのは「押しただけ」のとき。動かしたらパンになる（不具合1）。
    // どちらかは離すまで決まらないので、パンの準備をして離すときに決める。
    if (state.mode === "place") {
      const { clientX, clientY } = evt;
      beginPan(evt, { deferred: true, tap: () => placeAt({ clientX, clientY }) });
      return;
    }

    if (state.mode === "callout") {
      const { clientX, clientY } = evt;
      beginPan(evt, { deferred: true, tap: () => placeCalloutAt({ clientX, clientY }) });
      return;
    }

    if (state.mode === "eraser") { eraseAt(evt); return; }
    // マップ外から引き始めたときは捕捉もしない（以降の move を拾わない）。
    if (!beginStroke(evt)) return;
    board.setPointerCapture(evt.pointerId);
  });

  board.addEventListener("pointermove", (evt) => {
    if (state.pointers.has(evt.pointerId)) {
      state.pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    }
    if (state.pinch) { movePinch(); return; }
    updateReadout(evt);
    if (state.drag) { dragMarker(evt); return; }
    if (state.paint) { paintMove(evt); return; }
    if (state.pan) {
      // 閾値を超えるまでは動かさない。超えた時点でクリック扱いを取り下げる。
      if (!state.pan.moved) {
        if (!movedBeyond(state.pan.start, evt, state.pan.slop)) return;
        state.pan.moved = true;
        state.pan.tap = null;
        board.dataset.panning = "true";
      }
      gestureTo(state.pan.anchor, { x: evt.clientX, y: evt.clientY }, 1);
      return;
    }
    if (state.drawing) extendStroke(evt);
  });

  const end = (evt, canceled) => {
    state.pointers.delete(evt.pointerId);
    if (state.pinch && state.pointers.size < 2) state.pinch = null;
    if (state.drag) {
      if (canceled) cancelDrag();
      else { const d = state.drag; state.drag = null; endDrag(d); }
    }
    if (state.paint) {
      const p = state.paint;
      state.paint = null;
      // プレビューは確定の有無にかかわらず片付ける（結果は塗りのほうに出る）。
      p.rect.remove();
      if (readoutPaint) readoutPaint.textContent = "";
      if (!canceled) endPaint(p, evt);
    }
    if (state.pan) {
      const { tap, moved } = state.pan;
      state.pan = null;
      delete board.dataset.panning;
      // 閾値を超えずに離した＝クリック。中断（pointercancel）では実行しない。
      if (!canceled && !moved && tap) tap();
    }
    if (state.drawing) finishStroke();
  };
  board.addEventListener("pointerup", (evt) => end(evt, false));
  board.addEventListener("pointercancel", (evt) => end(evt, true));
  board.addEventListener("pointerleave", () => { readoutEl.hidden = true; });

  // 右クリック（指なら長押し）でその地点の座標をコピーする。
  // 読むだけの操作なので、編集できない状態（他人の作戦を見ているとき等）でも通す。
  board.addEventListener("contextmenu", (evt) => {
    if (!state.coords) return;
    evt.preventDefault();
    // 先に座標表示を今の位置に合わせる。**見えている値とコピーする値を
    // 必ず同じにする**ため（棚の高さが変わって盤面が数px 伸び縮みすると、
    // 同じ画面座標が別のメートルを指す。実測で 1px ≒ 27m ずれた）。
    updateReadout(evt);
    copyMarkAt(pointerToMeters(evt));
  });

  // ホイールはカーソルの下を軸にズーム（GoogleMap と同じ）。
  // touch-action:none なのでページは動かないが、ブラウザのズームは止める。
  board.addEventListener("wheel", (evt) => {
    if (!state.view) return;
    evt.preventDefault();
    stopAnim();
    // deltaMode は行（1）・ページ（2）のこともある。px に均してから使う。
    const raw = evt.deltaY * (evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? 400 : 1);
    const factor = Math.exp(clamp(raw, -400, 400) * 0.0018);
    gestureTo(userAt(evt.clientX, evt.clientY), { x: evt.clientX, y: evt.clientY }, factor);
  }, { passive: false });

  // 盤面の実寸が変わると、マーカーの見た目の大きさとガターの位置が変わる。
  // 縮尺も「画面1px が何メートルか」で決まるので、一緒に出し直す。
  addEventListener("resize", () => {
    if (!state.view) return;
    // **viewBox の縦横比は盤面の縦横比**なので、窓の形が変わったら作り直す。
    // 真ん中に見えているものは真ん中のままにする（横幅はそのまま）。
    const cx = state.view.x + state.view.w / 2;
    const cy = state.view.y + state.view.h / 2;
    const w = state.view.w;
    setView({ x: cx - w / 2, y: cy - state.view.h / 2, w, h: state.view.h });
    updateRailOverflow();
    measureChrome();
  });
}

// スペースキーを押している間はツールに関係なくパン。
// ボタンやフォームにフォーカスがあるときは奪わない（スペースは「押す」操作）。
export function wireKeys() {
  const onControl = (t) => t instanceof Element && t.closest("button, a, input, select, textarea");
  addEventListener("keydown", (evt) => {
    if (evt.code !== "Space" || evt.repeat || onControl(evt.target)) return;
    evt.preventDefault();
    state.spaceHeld = true;
    board.dataset.grab = "true";
  });
  const release = () => { state.spaceHeld = false; delete board.dataset.grab; };
  addEventListener("keyup", (evt) => { if (evt.code === "Space") release(); });
  addEventListener("blur", release);

  // `c` で座標をコピー（右クリックと同じこと）。キーボードだけでも届くようにする。
  // Ctrl/Cmd+C は普通のコピーなので横取りしない。欄に文字を打っている間も無視する。
  addEventListener("keydown", (evt) => {
    if (evt.key !== "c" && evt.key !== "C") return;
    if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.repeat) return;
    if (onControl(evt.target) || !state.coords) return;
    evt.preventDefault();
    copyMarkAt(state.lastPoint ?? viewCentreM());
  });

  // Esc でパレットの選択を外して既定の道具に戻す。選んだ項目を外す手段が
  // 「同じ項目をもう一度押す」しか無く、パレットを閉じたあとでは
  // 配置モードから抜けられなかった（オーナー報告の不具合3）。
  // 地名を置く道具も同じ Esc で抜ける（抜け方を道具ごとに変えない）。
  addEventListener("keydown", (evt) => {
    if (evt.key !== "Escape") return;
    if (state.mode === "callout") {
      setCalloutMode(false);
      say("地名を置くのをやめました。移動に戻ります。");
      return;
    }
    if (state.mode === "zone") {
      clearZoneKind();
      setMode(DEFAULT_MODE);
      say("エリアの選択を外しました。移動に戻ります。");
      return;
    }
    if (state.pick === null) return;
    clearPick();
    setMode(DEFAULT_MODE);
    say("選択を外しました。移動に戻ります。");
  });
}
