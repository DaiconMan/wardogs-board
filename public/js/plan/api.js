// /plan が叩く API の薄いラッパ。
// 失敗は必ず例外にして、呼び出し側が「マップは残したまま編集だけ止める」判断を
// できるようにする（静かに空データを返すと、線が消えたのか通信が死んだのか
// 区別できなくなる）。
//
// EN: A thin wrapper around the HTTP API that /plan calls. Every failure is raised as
//     an exception so the caller can choose to keep the map on screen and stop only
//     editing. Quietly returning empty data would make a dead network
//     indistinguishable from erased ink.

import { createNotifyGate, notifies } from "./changes.js";
import { GUEST_HEADER, ensureGuestId } from "./guest.js";

const jsonHeaders = { "content-type": "application/json" };

/**
 * ログイン無しで見る人（ゲスト）の身元を、**全ての呼び出しに添える。**
 *
 * **ログイン済みでも添える。** サーバは Cookie を先に見るので無視されるし
 * （`_lib/guard.js` の `requireViewer`）、分岐を作らないほうが安全——
 * 「ログインしているか」を画面側で判断して付け外しすると、判断を間違えた
 * 経路だけがログイン画面に飛ぶ。副作用として**ログアウトしても同じ名前に戻る**。
 *
 * 添える先は1箇所（`call()`）だけ。これが全 API の唯一の出口なので、
 * **これから足す読み取りも自動的にゲストで通る**（`onChanged` と同じ理由）。
 */
const guestHeader = () => ({ [GUEST_HEADER]: ensureGuestId() });

/**
 * 「保存した」を他の人へ知らせる先。app.js が繋ぐ（繋がなければ何もしない）。
 *
 * **`call()` に1箇所だけフックする。** これが全 API の唯一の出口なので、
 * **これから足す機能も自動的に通知される。** 各呼び出し元に書いて回ると
 * 必ず書き忘れが出る（オーナーが踏んだ「敵FOBを移動させても片方に
 * 反映されない」はまさにその形）。
 */
let changed = null;
export const onChanged = (fn) => { changed = fn; };

/**
 * まとめ操作（まとめて消す・まとめて動かす・やり直し1回）の間、通知を束ねる門。
 *
 * **まとめて消す API は無い。** DELETE も PATCH も1件ずつなので、20件消すと
 * 下の `call()` を20回通る。素朴に通すと `chg` が20通飛び、**相手は20回取り直す。**
 * 門をくぐらせれば、終わってから1回だけ飛ぶ。
 *
 * **`changed` を直に呼ばず、必ずこの門を通す**（フックは今までどおり1箇所のまま）。
 * 中身と理由は changes.js の `createNotifyGate`。
 */
const gate = createNotifyGate(() => { if (changed) changed(); });

/**
 * この中で起きた書き込みの通知を1回にまとめる。戻り値は `fn` の戻り値。
 *
 * 中が投げても、それまでに通った書き込みのぶんは1回送ってから投げ直す
 * （通った DELETE はサーバに効いているので、知らせないと相手の画面に残る）。
 */
export const batchCalls = (fn) => gate.batch(fn);

async function call(path, options = {}) {
  const res = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { ...(options.headers ?? {}), ...guestHeader() },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  // **上乗せなので、ここで投げない。** 知らせられなくても保存は済んでいる
  // （投げないことの面倒は門が見る。changes.js の `createNotifyGate`）。
  if (notifies(path, options.method, true)) gate.notify();
  return body;
}

export const getMe = () => call("/api/me");
export const getMaps = () => call("/api/maps");
export const getPlan = (id) => call(`/api/sessions/${encodeURIComponent(id)}`);
// 作戦は「マップ × パターン」の単位で作る（D-046）。パターン（`presetId`）は
// **任意**。プリセットが1件も無いマップがあるので、無い状態でも作れないといけない。
export const createSession = (mapId, title, presetId = null) =>
  call("/api/sessions", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ map_id: mapId, title, preset_id: presetId }),
  });
export const listSessions = () => call("/api/sessions");
export const deleteSession = (id) =>
  call(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
// 公開設定（private / public / public_edit）。**作成者と admin だけ**がサーバに
// 通る（画面も作成者にしか欄を出さないが、判定の持ち主はサーバ）。
export const patchVisibility = (id, visibility) =>
  call(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ visibility }),
  });
export const logout = () => call("/api/auth/logout", { method: "POST" });
export const postInk = (id, strokes) =>
  call(`/api/sessions/${encodeURIComponent(id)}/ink`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ strokes }),
  });
export const deleteInk = (id, strokeId) =>
  call(`/api/sessions/${encodeURIComponent(id)}/ink?id=${strokeId}`, { method: "DELETE" });

// 建造物・設置物・車輌のカタログと、マップ上への配置。
// カタログは全員同じ内容だが、寸法やコストが未検証のまま更新されうるので
// no-store（call の既定）のまま毎回取り直す。
export const getCatalog = () => call("/api/catalog");
export const getPlacements = (id) =>
  call(`/api/sessions/${encodeURIComponent(id)}/placements`);
export const postPlacements = (id, placements) =>
  call(`/api/sessions/${encodeURIComponent(id)}/placements`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ placements }),
  });
// 置いたものを更新する（消して置き直させない）。書いたキーだけが変わる:
//   { x_m, y_m } 動かす（片方だけは受け付けない）
//   { label }    注記。null で消す
//   { rank }     優先度 1〜9。null で「なし」に戻す
export const patchPlacement = (id, placementId, patch) =>
  call(`/api/sessions/${encodeURIComponent(id)}/placements?id=${placementId}`, {
    method: "PATCH", headers: jsonHeaders, body: JSON.stringify(patch),
  });
export const deletePlacement = (id, placementId) =>
  call(`/api/sessions/${encodeURIComponent(id)}/placements?id=${placementId}`, {
    method: "DELETE",
  });

// エリア塗り（自陣・敵陣・中立・最重要・危険予測）。**チームが手で塗る見立て**で、
// ゲームが決める円（下の zone preset）とは別物。
// 読みは getPlan の `areas` に相乗りしているので、ここには GET が無い
// （初回描画に必要なものを1往復にまとめる）。
// 書きは「1ジェスチャ = 1行」の追記型で、取り消しはその行を消すだけ。
const areaPath = (id) => `/api/sessions/${encodeURIComponent(id)}/areas`;
export const postAreas = (id, areas) =>
  call(areaPath(id), {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ areas }),
  });
export const deleteArea = (id, areaId) =>
  call(`${areaPath(id)}?id=${areaId}`, { method: "DELETE" });

// コントロールエリアのプリセット（ゲームが決めた円）。
// **マップ静的**なので /api/maps の下。書けるのは admin だけ（サーバ側で判定）。
// 座標は**ゲーム内座標（1単位 = 100m）**でやり取りする。メートルに直すのはサーバ。
const presetPath = (mapId) => `/api/maps/${encodeURIComponent(mapId)}/zone-presets`;
export const getZonePresets = (mapId) => call(presetPath(mapId));
export const postZonePreset = (mapId, preset) =>
  call(presetPath(mapId), {
    method: "POST", headers: jsonHeaders, body: JSON.stringify(preset),
  });
export const patchZonePreset = (mapId, presetId, patch) =>
  call(`${presetPath(mapId)}?preset_id=${encodeURIComponent(presetId)}`, {
    method: "PATCH", headers: jsonHeaders, body: JSON.stringify(patch),
  });
export const deleteZonePreset = (mapId, presetId) =>
  call(`${presetPath(mapId)}?preset_id=${encodeURIComponent(presetId)}`, { method: "DELETE" });

// 「どのパターンを想定するか」は作戦ごと。読みは getPlan の zone_preset_id に相乗り。
// 1作戦に1つしか無いので追記型にせず PUT で置き換える（null で選択を外す）。
export const putSessionZone = (id, presetId) =>
  call(`/api/sessions/${encodeURIComponent(id)}/zone`, {
    method: "PUT", headers: jsonHeaders, body: JSON.stringify({ preset_id: presetId }),
  });

// 地名（コールアウト）。実体はプランごとなので、配置と同じ /api/sessions/:id の下にある。
// マップ静的なマスタ（callouts テーブル）は別物で、ここからは触らない。
const calloutPath = (id) => `/api/sessions/${encodeURIComponent(id)}/callouts`;
export const getCallouts = (id) => call(calloutPath(id));
export const postCallouts = (id, callouts) =>
  call(calloutPath(id), {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ callouts }),
  });
// 書いたキーだけが変わる: { name } 改名 / { x_m, y_m } 移動（片方だけは不可）
export const patchCallout = (id, calloutId, patch) =>
  call(`${calloutPath(id)}?id=${calloutId}`, {
    method: "PATCH", headers: jsonHeaders, body: JSON.stringify(patch),
  });
export const deleteCallout = (id, calloutId) =>
  call(`${calloutPath(id)}?id=${calloutId}`, { method: "DELETE" });
