// 変更通知を受けて盤面を取り直す、その**タイミングだけ**を決める。
//
// EN: Decides only *when* the board is re-fetched after a change notification. This
//     file imports nothing, so vitest can check it by advancing a fake clock. The
//     Durable Object sends nothing but {"t":"chg"} with no payload; the receiver calls
//     the existing GET, which keeps D1 the single source of truth.
//
// **ここは何も import しない。** 再取得そのもの（board/reload.js）は盤面を
// 作り直すので DOM が要るが、「いつ走らせるか」は引数だけで決まるようにしてある。
// そうすると vitest で時計を進めるだけで確かめられる（tests/plan-changes.test.js）。
//
// DO が送ってくるのは `{"t":"chg"}` だけで、中身は載っていない（DO が盤面の形を
// 知らずに済ませるため）。受け取った側が既存の GET を叩くので、**D1 が唯一の真実**
// のままになる。

/**
 * 受け取ってから取り直すまでの待ち時間（ms）。
 *
 * **束ねないと「1人が置く → 19人が同時に再取得」**で Workers の枠と D1 の
 * 行読み取りを無駄に食う（調査 §5.3）。束ねれば 1セッション100編集 × 20人で
 * 2,000 リクエスト程度（枠の2%）に収まる。
 */
export const CHANGE_DEBOUNCE_MS = 300;

/** 操作が終わるのを待つ間、様子を見に行く間隔（ms）。 */
export const BUSY_RETRY_MS = 200;

// 作戦の**下**にあるもの（ink / placements / areas / callouts / zone …）。
// `/api/sessions` と `/api/sessions/:id` そのものは含まない。
const SESSION_CHILD = /^\/api\/sessions\/[^/?#]+\/[^?#]+/;

/**
 * この API 呼び出しを他の人に知らせるか。
 *
 * **api.js の `call()` に1箇所だけフックする。** `call()` は全 API の唯一の
 * 出口なので、**これから足す機能も自動的に通知される。** 各呼び出し元に
 * 書いて回ると、必ず書き忘れが出る（オーナーが踏んだ「敵FOBを移動させても
 * 片方に反映されない」はまさにその形）。
 *
 * 外してあるもの:
 *   * GET … 何も変えていない
 *   * 失敗した書き込み … 何も変わっていない
 *   * `/api/sessions`（作る・一覧） … 盤面を開いている部屋の話ではない
 *   * `/api/sessions/:id` の DELETE … 知らせると、残っている人が
 *     404 になる URL を取りに行くだけになる
 */
export function notifies(path, method, ok) {
  if (!ok) return false;
  if (String(method ?? "GET").toUpperCase() === "GET") return false;
  return SESSION_CHILD.test(path);
}

/**
 * まとめ操作の間だけ、変更通知を束ねる門。**送る側（自分）の話。**
 *
 * 下の `createChanges` は**受ける側**の束ね（20人が同じ通知で同時に再取得するのを
 * 300ms デバウンスでまとめる）。こちらは**送る前**に止める。
 *
 * **要る理由はまとめて消す・まとめて動かすに専用の API が無いこと。**
 * DELETE も PATCH も1件ずつなので、20件消すと `api.js` の `call()` を20回通る。
 * 素朴に通すと `chg` が20通飛び、**相手は20回取り直す**（1回で足りる）。
 *
 * **深さで数える。** 真偽値1つにすると、まとめ操作の入れ子で内側が終わった時点で
 * 流れてしまい、外側の残りが2通目として飛ぶ。
 *
 * 置き場所がここなのは、**このファイルが何も import していない**ため
 * （デバウンスをここに置いたのと同じ理由）。`api.js` は `guest.js` 経由で
 * localStorage を触るので、DOM 無しで通数を数える試験ができない。
 *
 * @param send 1通送る関数。**投げても無視する**（知らせられなくても、
 *             消した・動かしたことそのものは済んでいる）
 */
export function createNotifyGate(send) {
  let depth = 0;
  let dirty = false;

  const emit = () => {
    try {
      send();
    } catch {
      /* 知らせられなかっただけ。呼び出し元には成功を返す */
    }
  };

  return {
    /** 知らせたい。まとめ操作の最中なら溜めるだけ。 */
    notify() {
      if (depth > 0) { dirty = true; return; }
      emit();
    },
    /**
     * まとめ操作。**終わってから1回だけ送る。**
     *
     * 中が投げても溜めたぶんは送ってから投げ直す（`finally`）。
     * 20件のうち5件まで通って落ちたなら、その5件は消えているので、
     * 知らせないと相手の画面に消えたものが残り続ける。
     */
    async batch(fn) {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
        if (depth === 0 && dirty) {
          dirty = false;
          emit();
        }
      }
    },
  };
}

/**
 * 変更通知のスケジューラ。
 *
 * @param reload 盤面を取り直す非同期関数。**失敗しても投げたままでよい**
 *               （ここで握りつぶす。手元の盤面はそのまま残り、次の通知か
 *               手動リロードで追いつく）
 * @param busy   いま作り直してはいけないか。ドラッグ中・描画中・入力中に
 *               盤面を作り直すと手元の操作が消える
 */
export function createChanges({ reload, busy = () => false, delay = CHANGE_DEBOUNCE_MS }) {
  let timer = null;
  let stopped = false;
  // 再取得が走っている間に来た通知。終わってからまとめて1回だけ走らせる。
  let again = false;
  let running = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const arm = (wait) => {
    if (stopped || timer !== null) return;
    timer = setTimeout(fire, wait);
  };

  async function fire() {
    timer = null;
    if (stopped) return;
    // ジェスチャが終わるまで保留。終わったら1回だけ走らせる。
    if (busy()) { arm(BUSY_RETRY_MS); return; }
    if (running) { again = true; return; }

    running = true;
    try {
      await reload();
    } catch {
      // **黙って諦める。** 再取得が落ちても手元の盤面はそのまま。
    } finally {
      running = false;
    }
    if (again && !stopped) {
      again = false;
      arm(delay);
    }
  }

  return {
    /** DO から `{"t":"chg"}` が来たとき。 */
    notify() {
      if (stopped) return;
      if (running) { again = true; return; }
      // 既に待っているならそのまま（遅らせ直さない）。20人が同時に受け取る
      // 通知を束ねるのが目的で、最後の1通に合わせて延ばす必要は無い。
      arm(delay);
    },
    /**
     * これから取り直すか、いま取り直している最中か。
     *
     * **他の人が運んでいた物の絵を、いつ本当の座標へ戻すかに使う**
     * （board/carry.js）。離した瞬間に戻すと、保存された値が届くまでの
     * 数百ミリ秒だけ**元の位置へ跳ね返って見える。** 取り直しが来ると
     * 分かっているなら、戻すのをその着地まで預ける。
     *
     * 「取り直しが来るか」を見るのであって、D1 の値を当てにはしない
     * （真実は D1 のまま。遅らせる判断にだけ使う）。
     */
    pending() {
      return !stopped && (timer !== null || running);
    },
    /** ページを離れるとき。**タイマーを1本も残さない。** */
    stop() {
      stopped = true;
      again = false;
      clear();
    },
  };
}
