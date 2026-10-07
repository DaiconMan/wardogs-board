// コントロールエリア（ゲームが決めた円）と、管理者だけの入力口。

import { deleteZonePreset, patchZonePreset, postZonePreset, putSessionZone } from "../api.js";
import { createChoice } from "../choice.js";
import { say } from "../chrome.js";
import { SVG_NS, zoneAdminEl, zonePresetInfo, zonePresetLayer, zpInputs } from "../dom.js";
import { HOTZONE_ITEM_ID } from "../placements.js";
import { clearChildren } from "../render.js";
import { state } from "../state.js";
import { setTowerLive, setTowerShown } from "../towers.js";
import {
  gameToM, towerIdsInZone, towersInZone, zoneCountText, zoneLabel, zoneSummary,
} from "../zones.js";
import { pickItem } from "./drawers.js";
import { metersPerPx } from "./view.js";

// ── コントロールエリア（ゲームが決めた円）──────────────────
// マップごとに 3〜4 個の固定プリセットがあり、試合開始時に1個が選ばれる。
// **選ばれた円の中に入っているドリルタワーが、その試合で戦う対象**（調査 §2.3）。
//
// ここで持つのは「どのプリセットを選んだか」だけ。対象のタワーは持たない
// （持つと二重管理になり、必ず食い違う。調査 §4.3）。円を選び直すたびに
// zones.js の towersInZone() で出し直す。3〜5点 × 1円なので毎回でよい。
//
// **チームが塗るエリア（#areas）とは別物**で、見た目もはっきり分けてある
// （実寸の円 vs 1km マス、線 vs パターン、無彩色 vs 種別色。plan.html 参照）。

/**
 * plan.html に置いてある器（`div.choice`）に1択の欄を被せる。
 *
 * 器が無い場合（別のページを開いたとき）は null を返す。呼び出し側は
 * `?.` で触る。`<select>` のときに `document.getElementById` が null を
 * 返しうるのと同じ扱い方を保つ。
 */
function createChoiceOn(id, onChange) {
  const el = document.getElementById(id);
  return el ? createChoice({ el, onChange }) : null;
}

/**
 * 「想定するパターン」と「直す対象」の1択の欄。
 *
 * **`<select>` は使わない**（choice.js の冒頭。実機で選択肢が読めなかった）。
 * 器は plan.html にあるので、そこへ `createChoice` を被せる。
 */
const zonePresetChoice = createChoiceOn("zone-preset-select", (v) => chooseZone(v));
const zpTargetChoice = createChoiceOn("zp-target", (v) => {
  fillZoneForm(state.zonePresets.find((p) => p.id === v) ?? null);
});

/** 円の名前を、円の上端からどれだけ上に置くか（CSS px）。 */
const ZONE_NAME_GAP_PX = 8;

/** 今選ばれているプリセット（無ければ null）。 */
const chosenZone = () =>
  state.zonePresets.find((p) => p.id === state.zonePresetId) ?? null;

/**
 * 盤面に出す円を1つ作る。`preview` のときは破線（まだ保存していない）。
 * 中身は面・ハロー・輪・中心の十字・名前の5つ。
 */
function createZoneCircle(zone, { preview = false } = {}) {
  const at = state.coords.toSvg(zone);
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", preview ? "zp zp-preview" : "zp");

  const circle = (cls) => {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("class", cls);
    c.setAttribute("cx", at.x);
    c.setAttribute("cy", at.y);
    c.setAttribute("r", zone.radius_m);
    return c;
  };
  g.appendChild(circle("zp-face"));
  g.appendChild(circle("zp-halo"));
  g.appendChild(circle("zp-ring"));

  // 中心の十字。**オーナーが打った1点が合っているか**を目で確かめるための印。
  // 腕の長さは半径の 12%（半径 500m なら 60m）。実寸なので円との比が
  // 寄っても引いても変わらない。極端に小さい円でも見える下限だけ置く。
  const cross = document.createElementNS(SVG_NS, "path");
  cross.setAttribute("class", "zp-centre");
  const arm = Math.max(30, zone.radius_m * 0.12);
  cross.setAttribute(
    "d",
    `M ${at.x - arm} ${at.y} H ${at.x + arm} M ${at.x} ${at.y - arm} V ${at.y + arm}`
  );
  g.appendChild(cross);

  // 名前だけは画面固定の大きさにする（円そのものは実寸）。
  // **別の <g> に入れて scale を当てる**のは、陣営スポーンの陣営名と同じ手口。
  // SVG のテキストに CSS で `font-size:12px` と書くと 12**ユーザー単位**（= 12m）に
  // なってしまい、寄っても引いても地図に対して同じ大きさ ＝ 画面上では点になる。
  // <g> ごと metersPerPx 倍すれば、CSS の px がそのまま画面の px になる。
  const label = document.createElementNS(SVG_NS, "g");
  label.setAttribute("class", "zp-label");
  label.dataset.atX = String(at.x);
  label.dataset.atY = String(at.y - zone.radius_m);
  const name = document.createElementNS(SVG_NS, "text");
  name.setAttribute("class", "zp-name");
  name.setAttribute("x", 0);
  name.setAttribute("y", -ZONE_NAME_GAP_PX);
  name.setAttribute("text-anchor", "middle");
  name.textContent = zone.name ?? "";
  label.appendChild(name);
  g.appendChild(label);
  return g;
}

/** 選んでいる円とプレビューを描き直し、タワーの強調とパネルの文言も合わせる。 */
function renderZonePreset() {
  if (!zonePresetLayer || !state.coords) return;
  clearChildren(zonePresetLayer);

  const zone = chosenZone();
  if (zone) zonePresetLayer.appendChild(createZoneCircle(zone));
  if (state.zonePreview) {
    zonePresetLayer.appendChild(createZoneCircle(state.zonePreview, { preview: true }));
  }

  // **パターンを選んでいるときは、円の中のタワーだけを出す。**
  // オーナー指摘（2026-10-01）: 「どのプリセットを選んでも、全タワーが有効に
  // なっているように見えます。有効のものだけ表示でお願いしたいです」。
  // 選んでいない間は**全部出す**（どれが対象かが決まらないので、隠す根拠が無い）。
  //
  // 見るのは**選んで保存してある円**だけ。入力中のプレビューでは動かさない
  // （保存前の数字で塔を消すと、打ち間違いが確定した事実のように見える）。
  const live = towerIdsInZone(state.towers, zone);
  for (const t of state.towers) {
    if (!t.node) continue;
    const inZone = live.has(t.id);
    setTowerLive(t.node, inZone);
    setTowerShown(t.node, zone ? inZone : true);
  }

  updateZoneScale();
  updateZoneInfo();
}

/** 円の名前だけ画面基準の大きさに戻す（円そのものは実寸なのでそのまま）。 */
export function updateZoneScale() {
  if (!zonePresetLayer || !state.view) return;
  const mpp = metersPerPx() || state.view.w / 900;
  for (const label of zonePresetLayer.querySelectorAll(".zp-label")) {
    const { atX, atY } = label.dataset;
    label.setAttribute("transform", `translate(${atX} ${atY}) scale(${mpp})`);
  }
}

/**
 * フッターの「円とマス」に「まだパターンを選んでいない」印を出す。
 *
 * 引き出しを開けないと分からない状態を、開ける前に見せるためのもの
 * （オーナー報告: 「円を出すのに導線が長すぎます」）。
 * **選べるものがあるときだけ**出す。1件も登録されていないマップで印を出すと、
 * 押しても選択肢が無く、直しようのない催促になる。
 */
function updateZoneCue() {
  const btn = document.getElementById("toggle-zones");
  if (!btn) return;
  const unset = state.zonePresets.length > 0 && !state.zonePresetId;
  if (unset) {
    btn.dataset.unset = "true";
    // **状態だけで終わらせない。**押すとどうなるかまで書く
    // （オーナー指摘「決めていないもよくわからんので直して」と同じ型の文言）。
    btn.title = "想定するパターンをまだ選んでいません。押して選ぶと、対象のドリルタワーだけが残ります。";
  } else {
    delete btn.dataset.unset;
    btn.removeAttribute("title");
  }
}

/** パネルの1行（今の円は何で、対象のタワーは何本か）。 */
function updateZoneInfo() {
  updateZoneCue();
  if (!zonePresetInfo) return;
  if (state.zonePresets.length === 0) {
    zonePresetInfo.textContent = state.me?.user?.role === "admin"
      ? "パターンがまだ登録されていません。下の「円を登録・修正する」から入れてください。"
      : "パターンがまだ登録されていません。管理者が登録すると選べるようになります。";
    return;
  }
  const zone = chosenZone();
  if (!zone) {
    // **「全部出しています」まで書く。** パターンを選ぶと円外のタワーが消える
    // 作りにしたので、選んでいない状態の画面が「12本あるマップ」ではなく
    // 「まだ絞っていない状態」だと読めないといけない。
    // 状態だけを述べて結果を書かない文言にしない（オーナー指摘の
    // 「決めていないもよくわからん」と同じ型）。
    zonePresetInfo.textContent =
      `登録されているパターンは${state.zonePresets.length}件。まだ選んでいません`
      + `（どれが対象か決まらないので、ドリルタワーは全部出しています）。`;
    return;
  }
  zonePresetInfo.textContent = zoneSummary(zone, towersInZone(state.towers, zone).length);
}

/** 「想定するパターン」の選択肢を作り直す。 */
function fillZoneSelects() {
  if (!zonePresetChoice) return;
  const options = (first) => [
    first,
    ...state.zonePresets.map((p) => ({ value: p.id, text: zoneLabel(p) })),
  ];
  // 先頭の札は**押すと何が起きるか**を書く。旧文言は `選んでいない` で、
  // 状態を述べるだけだったので「押したら何が変わるのか」が読めなかった
  // （オーナー指摘の `（決めていない）` と同じ型の文言）。
  zonePresetChoice.setOptions(
    options({ value: "", text: "選ばない（円を消す）" }),
    state.zonePresetId ?? ""
  );
  zpTargetChoice?.setOptions(
    options({ value: "", text: "新しく作る" }),
    zpTargetChoice.value
  );
}

/** 円の表示 on/off。エリアと同じく、切り替えはパネルの中（フッターは増やさない）。 */
function setZonePresetVisible(on) {
  state.showZonePreset = on;
  if (on) zonePresetLayer?.removeAttribute("hidden");
  else zonePresetLayer?.setAttribute("hidden", "");
  document.getElementById("toggle-zone-preset")?.setAttribute("aria-pressed", String(on));
}

/** 「想定するパターン」を選ぶ。楽観更新で、断られたら元に戻す（配置・地名と同じ作法）。 */
async function chooseZone(presetId) {
  const before = state.zonePresetId;
  state.zonePresetId = presetId || null;
  if (state.zonePresetId && !state.showZonePreset) setZonePresetVisible(true);
  // 保存した直後など、選び直しが画面の操作以外から来ることもある。
  // 欄の見た目を state に合わせておかないと「円は出ているのに未選択」に見える。
  if (zonePresetChoice) zonePresetChoice.value = state.zonePresetId ?? "";
  renderZonePreset();
  try {
    await putSessionZone(state.plan.session.id, state.zonePresetId);
  } catch (e) {
    state.zonePresetId = before;
    fillZoneSelects();
    renderZonePreset();
    say(`円を選べませんでした。${e.message}`, true);
    return;
  }
  const zone = chosenZone();
  say(zone
    ? `${zoneLabel(zone)} を選びました。${zoneCountText(towersInZone(state.towers, zone).length)}。`
    : "想定するパターンの選択を外しました。");
}

// ── 管理者だけの入力口 ──────────────────────────────────
// **ゲーム画面を見ながら座標2つを打てば円が1つできる**、を成立させるための一画。
// 打った瞬間に破線の円が出るので、保存する前に位置を目で確かめられる。

/** 欄の数値を読む。空なら null（「書いていない」）、数値でなければ NaN。 */
const zpNumber = (el) => {
  const raw = el?.value?.trim() ?? "";
  return raw === "" ? null : Number(raw);
};

/**
 * 入力中の値から破線の円を作り直す。
 *
 * **破線は「まだ保存していない」の印。** だから出すのは次の両方を満たすときだけ:
 *   * x と y が揃っている（円が置けない値では出しようがない）
 *   * 直している対象と値が違う（保存済みと同じなら実線の円がもう出ている。
 *     同じ場所に実線と破線を重ねると「2つある」ように見える）
 */
function updateZonePreview() {
  const x = zpNumber(zpInputs.x);
  const y = zpNumber(zpInputs.y);
  const radius = zpNumber(zpInputs.radius);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    state.zonePreview = null;
    renderZonePreset();
    return;
  }
  const zone = {
    x_m: gameToM(x),
    y_m: gameToM(y),
    radius_m: Number.isFinite(radius) && radius > 0 ? radius : state.zoneDefaultRadiusM,
    name: zpInputs.key?.value.trim() || "（入力中）",
  };
  const target = state.zonePresets.find((p) => p.id === (zpTargetChoice?.value || ""));
  const same = target
    && Math.abs(target.x_m - zone.x_m) < 0.5
    && Math.abs(target.y_m - zone.y_m) < 0.5
    && Math.abs(target.radius_m - zone.radius_m) < 0.5;
  state.zonePreview = same ? null : zone;
  renderZonePreset();
}

/** 編集対象を選び直したときに、欄をその値で埋める（新規なら空にする）。 */
function fillZoneForm(preset) {
  const set = (el, v) => { if (el) el.value = v ?? ""; };
  set(zpInputs.key, preset?.key ?? "");
  set(zpInputs.x, preset ? preset.x.toFixed(2) : "");
  set(zpInputs.y, preset ? preset.y.toFixed(2) : "");
  // **半径はマップごとの既定を自動で入れる。**変えたい人だけが上書きする。
  set(zpInputs.radius, String(preset?.radius_m ?? state.zoneDefaultRadiusM));
  set(zpInputs.weight, preset?.weight ?? "");
  set(zpInputs.tag, preset?.tag ?? "");
  // 識別子は id の一部なので、作ったあとは変えられない（別物になってしまう）。
  if (zpInputs.key) zpInputs.key.disabled = !!preset;
  const del = document.getElementById("zp-delete");
  if (del) del.hidden = !preset;
  updateZonePreview();
}

/**
 * 保存と削除の間だけボタンを止める。
 *
 * 押してから応答が返るまで実測で 0.3〜0.5 秒ある。その間にもう一度押せると
 * **同じ識別子で2回 POST が飛んで、2回目が 409 で弾かれる**（実測で踏んだ）。
 * 押した本人には「保存できなかった」と出るだけなので、原因が分からない。
 */
let zoneBusy = false;
function setZoneBusy(on) {
  zoneBusy = on;
  for (const id of ["zp-save", "zp-delete"]) {
    const b = document.getElementById(id);
    if (b) b.disabled = on;
  }
}

/** 保存（新規なら POST、対象を選んでいれば PATCH）。 */
async function saveZonePreset() {
  if (zoneBusy) return;
  const targetId = zpTargetChoice?.value || "";
  const x = zpNumber(zpInputs.x);
  const y = zpNumber(zpInputs.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    say("中心の x と y を入れてください（ゲーム画面の数字のまま。1 = 100m）。", true);
    return;
  }
  const radius = zpNumber(zpInputs.radius);
  const weight = zpNumber(zpInputs.weight);
  if (weight !== null && !Number.isFinite(weight)) {
    say("重みは数値で入れてください（分からなければ空のままで構いません）。", true);
    return;
  }
  const body = {
    x, y,
    radius_m: Number.isFinite(radius) ? radius : undefined,
    weight: weight === null ? undefined : weight,
    tag: zpInputs.tag?.value.trim() || undefined,
  };

  const key = zpInputs.key?.value.trim() ?? "";
  if (!targetId && !key) {
    say("円の名前を入れてください（Default / Farmland など）。", true);
    return;
  }

  const mapId = state.plan.map.id;
  let saved;
  setZoneBusy(true);
  try {
    saved = targetId
      ? (await patchZonePreset(mapId, targetId, body)).preset
      : (await postZonePreset(mapId, { key, ...body })).preset;
  } catch (e) {
    say(`円を保存できませんでした。${e.message}`, true);
    return;
  } finally {
    setZoneBusy(false);
  }

  const at = state.zonePresets.findIndex((p) => p.id === saved.id);
  if (at >= 0) state.zonePresets[at] = saved;
  else state.zonePresets.push(saved);

  // 保存したものをそのまま「想定するパターン」にする。位置を確かめるために入れたので、
  // 保存した直後に実線で出ているのが自然（もう一度選び直させない）。
  //
  // **順番が効く。** 選択肢を先に作り直さないと、`select.value = saved.id` が
  // 「まだ無い値」への代入になって空に落ちる。空のまま fillZoneForm を呼ぶと
  // 「直している対象が無い＝未保存」と判定され、保存した円の上に破線が残る。
  fillZoneSelects();
  if (zpTargetChoice) zpTargetChoice.value = saved.id;
  fillZoneForm(saved);
  await chooseZone(saved.id);
  say(`${zoneLabel(saved)} を保存しました。${zoneCountText(towersInZone(state.towers, saved).length)}。`);
}

/** 消す。選んでいた円ならサーバ側でも選択が外れるので、手元も外す。 */
async function removeZonePreset() {
  const targetId = zpTargetChoice?.value || "";
  if (!targetId || zoneBusy) return;
  setZoneBusy(true);
  try {
    await deleteZonePreset(state.plan.map.id, targetId);
  } catch (e) {
    say(`円を消せませんでした。${e.message}`, true);
    return;
  } finally {
    setZoneBusy(false);
  }
  state.zonePresets = state.zonePresets.filter((p) => p.id !== targetId);
  if (state.zonePresetId === targetId) state.zonePresetId = null;
  if (zpTargetChoice) zpTargetChoice.value = "";
  fillZoneForm(null);
  fillZoneSelects();
  renderZonePreset();
  say("円を消しました。");
}

export function wireZonePreset() {
  if (!zonePresetChoice) return;
  // 札を押したときの行き先は createChoice の onChange で繋いである
  // （`zonePresetChoice` / `zpTargetChoice` の宣言のところ）。
  document.getElementById("toggle-zone-preset")
    ?.addEventListener("click", () => setZonePresetVisible(!state.showZonePreset));
  for (const el of Object.values(zpInputs)) {
    el?.addEventListener("input", updateZonePreview);
  }
  // ホットゾーンを置く道具。実体はパレットと同じ「配置を選ぶ」で、ここは
  // **円を探す人のための入り口**（D-049。引き出し1手 → ボタン1手 → 盤面を押す）。
  document.getElementById("place-hotzone")
    ?.addEventListener("click", () => pickItem(HOTZONE_ITEM_ID));
  document.getElementById("zp-save")?.addEventListener("click", saveZonePreset);
  document.getElementById("zp-delete")?.addEventListener("click", removeZonePreset);
  // 入力欄を畳んだらプレビューも消す（見えない欄の値で円が出ていると混乱する）。
  zoneAdminEl?.addEventListener("toggle", () => {
    if (zoneAdminEl.open) updateZonePreview();
    else { state.zonePreview = null; renderZonePreset(); }
  });
}

/** 盤面を読み込んだあとの初期化。プリセットが無くても画面は成立する。 */
export function initZonePreset(plan) {
  state.zonePresets = Array.isArray(plan.zone_presets) ? plan.zone_presets : [];
  state.zonePresetId = plan.zone_preset_id ?? null;
  state.zoneDefaultRadiusM = plan.zone_default_radius_m ?? 500;
  // 登録できるのは admin だけ。出せない道具を見せない（押せない棚は作らない）。
  if (zoneAdminEl) zoneAdminEl.hidden = state.me?.user?.role !== "admin";
  fillZoneSelects();
  fillZoneForm(null);
  setZonePresetVisible(state.showZonePreset);
  renderZonePreset();
}
