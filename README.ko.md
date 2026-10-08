# WARDOGS 작전 플래너

[日本語](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md) · **한국어**

경기가 시작되기 전에 **지도를 가리키며 작전을 이야기하기 위한 화이트보드**입니다.

음성 채팅에서 "여기", "저쪽", "그쪽"이라고 말해도 상대방은 알아듣지 못합니다.
같은 지도를 모두의 화면에 띄워 놓고, 선을 긋고, 기호를 놓고, 남들도 보이는 커서로
가리키기 위한 도구입니다. 하는 일은 그것뿐입니다.

**게임은 전혀 건드리지 않습니다.** 프로세스 메모리를 읽지 않고, 게임 파일을 읽지 않고,
통신에 끼어들지 않고, 오버레이도 띄우지 않습니다. 그냥 평범한 웹 페이지입니다.
WARDOGS의 저작권은 Team17 / Bulkhead에 있으며, 이 프로젝트는 비공식 팬 제작물입니다.

Cloudflare Pages(무료 한도)에서 돌아가고, 데이터는 Pages Functions + D1(무료 한도)에
들어가며, 로그인은 Discord OAuth를 씁니다.

> **이 저장소에는 지도 이미지가 들어 있지 않습니다.** 우리 저작물이 아니라서 배포할
> 입장이 아닙니다. **없어도 동작합니다** — 보드 뒤에 그림이 없을 뿐, 좌표·격자·펜
> 선·기호·원은 전부 그대로입니다. 직접 준비하는 방법은 [아래](#지도-이미지를-직접-준비하기)에 있습니다.

---

## 할 수 있는 일

### 지도 위에 놓고 그리기

| | |
|---|---|
| **펜 선** | 자유 곡선, 굵기 3단계, 지우개, 되돌리기. 선은 0.1m 단위 정수로 양자화한 뒤 차분 부호화해서 저장합니다 |
| **기호** | 건조물·설치물·차량·경기 목표물. **종류마다 모양이 다릅니다**(사각·삼각·원·핀). 색만으로 구분하지 않습니다. 사거리 링과 FOB 건설 범위는 **실측 치수(미터)**로 그리므로, 확대해도 지도와 같은 축척으로 늘고 줄어듭니다 |
| **지명(콜아웃)** | "저 언덕", "공장", "북쪽 다리" — 팀이 입으로 실제로 부르는 이름을 작전별로 저장합니다 |
| **영역** | 1km 칸을 칠합니다(우리 쪽·적 쪽·중립·최우선·위험 예상). 집합 연산으로 더하고 뺍니다 |
| **컨트롤 에리어** | **게임이 정하는 원**(반지름 500m. **Ozeti만 550m**)의 프리셋. 팀의 판단과는 다른 종류의 것이므로 보기에도 확실히 구분해 두었습니다 |
| **핫존** | 반지름 85m, 인원 2배 |
| **드릴 타워 / 진영 스폰** | 지도에 고정. 매 경기 위치가 같으므로 내장 데이터에서 그대로 나옵니다 |

여기에 확대·이동, 1km 격자, A1–P16 칸 이름(보드 가장자리에 머리글로 표시),
게임 내 좌표 표시, 축척, 배경의 흑백 / 고대비 전환이 있습니다.

### 같은 화면을 함께 보기

| | |
|---|---|
| **커서 공유** | 다른 사람의 포인터가 **이름이 붙은 화살표**로 지도 위에 나옵니다. 주고받는 것은 **지도의 미터 좌표**이고 화면 픽셀이 아닙니다 — 각자의 확대율과 위치가 다르므로 픽셀을 보내면 상대 화면의 엉뚱한 곳을 가리킵니다 |
| **옮기는 중이 보입니다** | 누군가 기호를 끌면 움직이는 과정이 보입니다. 손을 뗀 뒤에 순간이동하는 게 아닙니다 |
| **긋는 중이 보입니다** | 선이 끌려 나오는 모습이 그대로 나옵니다 |
| **변경 알림** | 다른 사람이 놓고·옮기고·지우고·그린 것이 **새로고침 없이** 나타납니다 |
| **접속자 목록** | 지금 이 작전을 열어 둔 사람이 이름·아이콘·색으로 표시됩니다 |
| **동시 50명** | 한 작전에 동시에 들어갈 수 있는 인원은 50명. 51번째는 "정원이 찼습니다"로 막힙니다 |

### 누구에게 보여줄지

**설정이 바꾸는 것은 "목록에 나오는가"와 "쓸 수 있는가" 두 가지뿐이고,
열람은 세 상태 모두 같습니다.** 작전을 지키는 것은 URL을 아는지 여부입니다.

| 설정 | 목록에 나오는가 | URL을 아는 사람의 열람 | 쓸 수 있는 사람 |
|---|---|---|---|
| `private`(기본값) | **안 나옴** | 가능, **게스트도** | **로그인한 사람이면 누구나** |
| `public` | 나옴 | 가능, 게스트도 | **만든 사람과 admin만** |
| `public_edit` | 나옴 | 가능, 게스트도 | **로그인한 사람이면 누구나** |

**`private`는 "비밀"이 아니라 "목록에 내지 않음"입니다.** URL을 아는 사람은 열 수 있고,
로그인했다면 쓸 수도 있습니다. 팀이 비공개 작전의 URL을 돌려 함께 편집하고 있으므로,
여기를 잠그면 공개 설정을 추가한 것만으로 기존 사용 방식이 깨집니다.
**숨기고 싶은 정보를 두는 곳이 아닙니다.**

**게스트 열람**은 로그인하지 않고 작전을 볼 수 있게 하는 장치입니다.
게스트에게도 두 단어짜리 이름이 자동으로 붙고 커서도 나옵니다.
다만 **어떤 설정에서도 쓰기는 전혀 할 수 없습니다.**
목록에 나오는 것은 `public` / `public_edit`뿐이지만,
**URL을 받으면 `private`도 열 수 있습니다.**

남이 놓은 것은 지울 수 없습니다. **다만 admin은 지울 수 있습니다.**

자동으로 붙는 게스트 이름은 **일본어로 고정**되어 있습니다(로케일별 전환은 없습니다).

---

## 만들면서 세운 생각

- **경기별 기록이 아니라 패턴별 준비.** "그때 무엇을 했는지"를 남기기 위한 것이 아니라,
  "Default일 때는 이렇게 밀고 간다"를 **미리 마련해 두기** 위한 것입니다.
- **판단을 위치에 묶습니다.** "여기는 도로로만 들어갈 수 있어서 따기 어렵다"는 말은
  그 장소에 붙어 있어야 합니다. 따로 문서를 만들 일이 아닙니다.
- **실시간은 덧붙인 것이고 전제가 아닙니다.** WebSocket이 끝까지 연결되지 않아도
  보드의 모든 기능은 평범한 HTTP로 동작합니다.
- **무료 한도를 벗어나지 않습니다.** 유료 플랜을 전제로 한 것이 하나도 없습니다.
  Durable Object 안에 타이머가 한 개도 없고, `state.acceptWebSocket()`만 쓰며,
  클라이언트의 전송 빈도를 접속 인원에 따라 낮춰 방 전체 합계가 초당 200통을
  넘지 않게 합니다.
- **빌드 공정이 없습니다.** HTML과 ES 모듈을 그대로 내보냅니다. 번들러도,
  트랜스파일러도, 프레임워크도 없습니다. `npm ci`는 테스트(vitest / Playwright)와
  wrangler를 위한 것뿐입니다.

---

## 구성

```
public/plan.html            작전 플래너 페이지(**마크업뿐. `<style>`은 없습니다**)
public/index.html           /plan으로 보내는 리다이렉트뿐(12줄)
public/_redirects           / -> /plan(302)
public/_headers             캐시 설정(JS와 CSS는 매번 재검증, 이미지는 1년 immutable)
public/css/                 스타일시트 6개(**:root의 디자인 토큰은 plan-base.css**)
public/js/plan/             브라우저 쪽 ES 모듈 25개
  app.js                      화면 조립과 조작 처리. 여기서 나머지를 호출합니다
  state.js / dom.js / util.js 공유 상태 / 요소 조회 / 작은 도구
  api.js                      fetch 래퍼
  coords.js                   좌표 변환(게임 내 <-> 미터 <-> SVG)과 칸 이름
  viewport.js / render.js     확대·이동·축척 / SVG 조립
  chrome.js                   떠 있는 틀의 실측을 --chrome-top/bottom에 되돌려 씁니다
  ink.js                      펜 선의 양자화와 부호화(서버와 공유)
  placements.js               기호와 사거리 링
  areas.js / zones.js         1km 칸의 집합 연산 / 게임이 정하는 원
  towers.js / spawns.js       지도 고정 드릴 타워 / 진영 스폰
  callouts.js / gutter.js     지명 / 보드 가장자리의 칸 이름 머리글
  sessions.js                 작전 목록 표시용 순수 함수
  visibility.js               공개 설정의 판정(**서버와 공유. 판정의 실체는 여기 하나**)
  guest.js                    로그인하지 않은 사람의 열람(이름 자동 부여)
  avatar.js                   Discord 아이콘(색 고리를 남기고 그 안에 넣습니다)
  choice.js                   한 개 선택 필드(<select>는 쓰지 않습니다. design-system §16)
  presence.js                 접속자 목록의 WebSocket
  cursors.js / changes.js     커서·운반·실시간 펜 선 송수신 / 변경 알림을 받는 타이밍
  board/                      보드 부품 18개(그리기, 포인터, 실시간 펜 선, 배경 지도 등)
  pages/                      gate.js(로그인 입구) / list.js(작전 목록과 생성)

functions/_lib/             공통부 7개(session / guard / validate / ink / zones /
                            guest / visibility)
functions/api/sessions/     작전 CRUD와 그 아래의
                            ink / placements / areas / callouts / zone / ws
functions/api/auth/         discord/start·discord/callback·logout
functions/api/me/           /api/me(로그인 상태·게스트 이름·방문 이력)
functions/api/catalog.js    건조물 카탈로그
functions/api/maps/         지도 목록 / {id}/zone-presets(GET/POST/PATCH/DELETE)

workers/room/               공유 커서를 중계하는 Durable Object용, Pages와는 별개인 Worker
  src/index.js                PlanRoom 본체(접속 관리, 커서 중계)
  src/presence.js             접속 관리의 순수 로직
  src/cursors.js              커서의 전송 제한·직렬화의 순수 로직

schema.sql                  D1 테이블 정의. **멱등**(CREATE TABLE IF NOT EXISTS 23개 /
                            CREATE INDEX IF NOT EXISTS 20개 / INSERT OR IGNORE 11개뿐)
migrations/                 이미 있는 DB에 한 번만 흘리는 차분 SQL 4개(새로 만들면 불필요)
wrangler.toml               Pages 설정(**자기 값을 넣어야 하는 곳이 두 군데**)
tools/                      운용·검증 스크립트 6개
  dev.mjs                     npm run dev(room 8787과 pages 8788을 함께 띄웁니다)
  build-map-assets.sh         지도 이미지에서 overview와 타일을 만듭니다
  do-usage.mjs                Durable Objects 사용량을 1분 단위로 읽습니다
  ws-min.mjs                  최소한의 WebSocket 클라이언트(테스트가 씁니다)
  ws-load.mjs                 접속을 유지해 무료 범위 소비를 실측합니다
  ws-fanout.mjs               설계 상한(초당 200통)을 흘려 중계를 측정합니다
tests/                      vitest(*.test.js 47개). **전부 통합 테스트는 아닙니다**
                            (coords / ink-codec / zones-geom / cursor-budget /
                            room-* 등은 서버를 띄우지 않고 동작합니다)
e2e/                        Playwright(*.spec.js 24개. npm run test:ui가 돌리는 것은
                            shots.spec.js를 뺀 23개)
testlib/d1-direct.js        tests/와 e2e/가 공유하는 D1 직접 열기
docs/design-system.md       화면의 형. **UI를 건드린다면 읽어 주세요**
LICENSE                     MIT
THIRD-PARTY-NOTICES.md      외부 데이터의 출처와 라이선스
```

### 일부러 넣지 않은 것

| | 이유 |
|---|---|
| **`public/map/`**(4,000장이 넘는 이미지) | **우리 저작물이 아니고, 배포할 입장이 아닙니다** |
| **배포용 workflow** | fork한 사람이 첫 push에서 곧바로 Cloudflare 배포를 시도하고, secrets가 없어서 실패하고, 영문 모를 빨간 X만 남는 형태로 만들고 싶지 않았습니다. CI는 **테스트만** 돌립니다(`.github/workflows/test.yml`) |
| **결정 기록·조사 기록·명세서** | 상류의 내부 문서입니다. 주석 안에 `docs/research/...`나 `docs/superpowers/specs/...`를 가리키는 참조가 남아 있지만, **그 파일들은 이 저장소에 없습니다.** 참조를 지우면 어떤 결정이 어디서 왔는지 추적할 수 없게 되므로 남겨 두었습니다 |
| **`tests/naming.test.js`** | 상류 저장소의 이름 변경만 고정하는 테스트입니다 |

---

## 코드의 언어에 대하여

**주석은 일본어입니다.** 다만 **주요 파일의 맨 앞 주석 블록에는 영어 요약을 함께**
적어 두었습니다(`// EN:`으로 시작하는 줄). 함수 안쪽의 줄 주석은 일본어 그대로입니다.

```js
// 盤面の見えている範囲（= SVG の viewBox）の計算。DOM は一切触らない。
//
// EN: Pure computation of the visible region of the board (the SVG viewBox); touches
//     no DOM. Zooming moves the viewBox itself instead of applying a transform scale,
//     ...
```

영어를 함께 적어야 하는 파일 목록은 `tests/en-headers.test.js`가 들고 있어서,
**영어가 빠지면 테스트가 떨어집니다.** 새로 주요 모듈을 추가할 때는 그 목록에도
넣어 주세요.

식별자(변수명·함수명·API 경로)는 모두 영어입니다. 화면에 나오는 문구와
데이터베이스 `source` 열의 내용은 일본어입니다.

---

## 직접 세우기

필요한 것:

- **Node.js 22 이상**(wrangler 4.x의 요구사항. Node 20에서는 아예 뜨지 않습니다)
- **Cloudflare 계정**(무료 플랜으로 충분합니다)
- **Discord 애플리케이션**(OAuth 로그인용)

```bash
git clone https://github.com/DaiconMan/wardogs-board.git
cd wardogs-board
npm ci
```

### 1. D1 만들기

```bash
npx wrangler login
npx wrangler d1 create wardogs-blue      # 이름은 아무거나
```

출력에 `database_id` UUID가 나옵니다. **`wrangler.toml`에 붙여 넣으세요.**

```toml
[[d1_databases]]
binding = "DB"
database_name = "wardogs-blue"              # 위에서 붙인 이름
database_id = "PUT-YOUR-OWN-DATABASE-ID-HERE"   # <- 여기
```

그다음 테이블을 만듭니다. `schema.sql`은 `CREATE TABLE IF NOT EXISTS`와
`INSERT OR IGNORE`만으로 쓰여 있어서 **몇 번 흘려도 결과가 같습니다.**

```bash
npx wrangler d1 execute wardogs-blue --local  --file=schema.sql   # 로컬
npx wrangler d1 execute wardogs-blue --remote --file=schema.sql   # 운영
```

### 2. Discord 애플리케이션 만들기

[Discord Developer Portal](https://discord.com/developers/applications)에서
New Application을 누르고 OAuth2로 들어갑니다.

**Redirect URI를 등록합니다.** `redirect_uri`는 실제로 요청된 호스트명에서
조립되므로, **쓸 도메인마다 전부 등록해야 합니다.** 등록하지 않은 도메인에서 열면
Discord 쪽에서 `Invalid OAuth2 redirect_uri`가 납니다.

```
https://<당신의 Pages 프로젝트>.pages.dev/api/auth/discord/callback
https://<당신의 커스텀 도메인>/api/auth/discord/callback
http://127.0.0.1:8788/api/auth/discord/callback      # 로컬에서 시험한다면
```

요청하는 scope는 **`identify`뿐**입니다(사용자 ID·표시 이름·아이콘).
메일 주소도, 서버 목록도 받지 않습니다. "Public client"는 끈 채로 두고
Client Secret을 씁니다.

**Application ID(= Client ID)를 `wrangler.toml`에 붙여 넣으세요.**
이것은 **공개 값**입니다. 브라우저의 리다이렉트 URL에 나타나므로 숨길 의미가 없습니다.

```toml
[vars]
DISCORD_CLIENT_ID = "PUT-YOUR-OWN-DISCORD-CLIENT-ID-HERE"   # <- 여기
```

### 3. Durable Object의 Worker(`wardogs-room`) 배포

**Pages 프로젝트 안에는 Durable Object를 정의할 수 없습니다**
("You cannot create and deploy a Durable Object within a Pages project.").
그래서 실체는 별개의 Worker에 있고, Pages 쪽은 `wrangler.toml`의
`script_name = "wardogs-room"`으로 빌려 씁니다.

```bash
npx wrangler deploy --config workers/room/wrangler.toml
```

**이 순서에 의미가 있습니다.** Pages를 먼저 내보내면, 아직 없는 클래스를 가리키는
바인딩이 될 수 있습니다. `npm run deploy`는 room 다음 pages 순서이므로
평소에는 그쪽을 쓰세요.

> **`wardogs-room`에 공개 라우트를 붙이지 마세요.** 세션 Cookie를 검증하는 것은
> Pages Function(`functions/api/sessions/[id]/ws.js`)뿐이라서, 공개 라우트가 생기면
> 인증이 그냥 통과됩니다. 저장소에는 `workers_dev = false`에 라우트 미설정 상태로
> 들어 있습니다.

### 4. Pages 프로젝트를 만들어 내보내기

```bash
npx wrangler pages project create wardogs-board --production-branch main
npm run deploy      # room 먼저, 그다음 pages
```

D1 바인딩은 `wrangler.toml`의 `[[d1_databases]]`에서 자동으로 반영되며,
Pages 쪽에서 손으로 설정할 필요가 없습니다(wrangler 4.142.0에서 확인).

### 5. Secrets 넣기

```bash
npx wrangler pages secret put DISCORD_CLIENT_SECRET --project-name wardogs-board
npx wrangler pages secret put SESSION_SECRET        --project-name wardogs-board
```

| 이름 | 쓰는 곳 | 없으면 |
|---|---|---|
| `DISCORD_CLIENT_SECRET` | OAuth 토큰 교환 | 아무도 로그인할 수 없습니다 |
| `SESSION_SECRET` | 세션 Cookie의 서명 키(HMAC-SHA256). **아무 랜덤 문자열**이면 됩니다 | 아무도 로그인할 수 없습니다 |
| `ADMIN_TOKEN` | 예전 댓글란의 글 삭제에 쓰던 것. **이제 이걸 읽는 코드가 없습니다** | 영향 없음(읽는 코드가 없음) |
| `BLOCKED_WORDS` | 작전 제목·배치 메모·지명의 금지어(쉼표 구분, 선택) | 비활성 |

**D1에 세션 테이블은 없습니다.** 모든 상태를 HMAC-SHA256으로 서명한 Cookie
하나가 들고 있습니다(`functions/_lib/session.js`).

### 6. 커스텀 도메인(선택)

Cloudflare Pages의 Custom domains에 추가하고, DNS에 서브도메인에서
`<프로젝트>.pages.dev`로 가는 CNAME(proxied)을 만듭니다.
**도메인을 늘렸으면 Discord의 Redirect URI에도 추가하세요.**

---

## 지도 이미지를 직접 준비하기

`public/map/`은 계속 비워 둬도 동작합니다. 배경에 지도가 나오지 않을 뿐,
좌표·격자·칸 이름·펜 선·기호·영역·원은 전부 그대로입니다
(`public/js/plan/board/basemap.js`가 이미지가 404면 아무것도 그리지 않고 넘어갑니다).

배경을 띄우고 싶다면 둘 곳은 두 군데입니다.

```
public/map/overview/<map>.webp              2048px짜리 한 장(전체 보기용)
public/map/tiles/<map>/<z>/<y>/<x>.webp     512px 타일(z는 0–5, y가 x보다 먼저)
```

`<map>`은 `maps` 테이블의 `id`입니다(기본은 `bakurani` / `ozeti` / `zestafona`).
타일은 **정사각형·2의 거듭제곱 격자**를 전제로 합니다. z의 타일 한 장은
`<한 변>/2^z` 미터 사방이고, 원점은 지도의 왼쪽 위입니다.
다른 모양의 지도에서는 overview만 표시됩니다.

거대한 원본 이미지에서 이 구조를 만드는 스크립트를 넣어 두었습니다.
libvips의 스트리밍 처리를 쓰기 때문에, 32768²(4.3GB) 이미지라도 메모리 최고점은
400MB 정도로 끝납니다.

```bash
# vips(libvips) 필요
# map-src/<map>.png 에 원본을 둔 다음
tools/build-map-assets.sh all
```

**이미지를 어떻게 구하는지는 각자 해결해 주세요.** 이 저장소는 한 장도 배포하지
않습니다.

`.gitignore`는 **`public/map/` 자체도 무시합니다.** 이미지가 우리 저작물이 아닌
데다, 4,000장이 넘는 타일은 실수로 push 하고 싶은 것이 아니기 때문입니다.
자기 이미지를 커밋하기로 했다면 `.gitignore`의 `public/map/` 줄**과**
`tests/no-account-identifiers.test.js`의 대응하는 검사
("public/map/ 를 추적하지 않는다")를 지워 주세요.

---

## 로컬에서 돌리기

```bash
npx wrangler d1 execute wardogs-blue --local --file=schema.sql
cp .dev.vars.example .dev.vars        # DISCORD_CLIENT_SECRET과 SESSION_SECRET을 적습니다
npm run dev                           # room(8787)과 pages(8788)를 함께 띄웁니다
```

브라우저로 여는 쪽은 **http://127.0.0.1:8788** 입니다. Ctrl-C로 둘 다 멈춥니다.

`npm run dev`가 프로세스를 두 개 띄우는 것은, 실시간 쪽 실체가 별개의 Worker에
있기 때문입니다. 시작 로그에
`env.ROOM (PlanRoom, defined in wardogs-room) ... [connected]`가 나오면 붙은 것입니다.
`[not connected]`일 때는 `/api/sessions/:id/ws`가 503을 돌려줍니다
(= 접속자 목록과 커서만 안 나오고, 나머지는 전부 동작합니다).

---

## 테스트

```bash
npm test        # vitest(*.test.js 47개 파일)
npm run test:ui # Playwright UI 테스트(23개 파일. shots.spec.js는 제외)
npm run shots   # 눈으로 확인하는 스크린샷을 shots/에 다시 생성(git 관리 밖)
```

**`npm test`가 전부 통합 테스트는 아닙니다.** `plan-coords` / `plan-ink-codec` /
`plan-zones-geom` / `plan-cursor-budget` / `room-cursors` / `room-presence` /
`en-headers` / `no-account-identifiers` / `no-comments-api`는 서버를 띄우지 않고 동작합니다.

**둘 다 로컬의 `wrangler pages dev` / `wrangler dev`만 상대합니다.**
밖으로 나가는 통신은 `npm ci`와 `npx playwright install`의 다운로드뿐입니다.

**지도 이미지가 없어도 테스트는 전부 통과합니다.** 배경을 다루는 테스트는
`#basemap`의 `href` 속성을 보고, `**/map/**`을 전부 떨어뜨렸을 때 보드가 멀쩡한지를
봅니다. 즉 **속성과 실패 시의 거동**입니다. 실제 이미지를 읽는 테스트는 없습니다.

### 동시에 띄울 때의 포트

`wrangler pages dev`를 여러 개 띄울 때는 `--port`만이 아니라
**`--inspector-port`와 `--persist-to`도 인스턴스마다 나눠 주세요.**

- `--inspector-port`: `--port`를 바꿔도 inspector는 기본 9229에 고정이라 충돌합니다
- `--persist-to`: D1의 영속화 위치. 공유하면 동시 쓰기가 락을 다퉈서
  `D1_ERROR` -> 500이 됩니다

| 용도 | 포트 | inspector | persist-to |
|---|---|---|---|
| vitest(/plan) | 8831 | 9331 | `.wrangler/plan-state` |
| e2e(/plan) | 8832 | 9332 | `.wrangler/e2e-plan-state` |
| e2e(room / Durable Object) | 8833 | 9333 | `.wrangler/e2e-room-state` |
| `npm run dev`(room) | 8787 | 9787 | `.wrangler/dev-room-state` |
| `npm run dev`(pages) | 8788 | 9788 | `.wrangler/dev-pages-state` |

vitest에는 `globalSetup`이 없습니다. 서버가 필요한 파일이 `beforeAll`에서
스스로 띄우고 스스로 멈춥니다.

**`WRANGLER_REGISTRY_PATH`도 나눕니다.** wrangler는 돌고 있는 Worker를
**기계당 하나뿐인 레지스트리**(기본 `~/.config/.wrangler/registry`)에 등록하고,
`script_name`이 붙은 Durable Object 바인딩을 거기서 해결합니다. 기본값 그대로면
`npm run dev`로 `wardogs-room`을 띄운 채 `npm test`를 돌렸을 때
**ROOM이 없어야 할 테스트 서버에 ROOM이 붙습니다** —
`/api/sessions/:id/ws`가 503이어야 하는 자리에서 101을 돌려줍니다.

지난 실행의 잔해가 포트를 잡고 있으면 치우고 다시 돌리세요.

```bash
pkill -f "wrangler pages dev"; pkill -f "workers/room"; pkill workerd
```

**같은 작업 사본에서 Playwright를 동시에 두 개 돌리지 마세요.**
고정 포트와 persist 디렉터리를 서로 빼앗아 가짜 실패가 쏟아집니다.

---

## 무료 한도를 벗어나지 않기

Durable Objects에서 의미 있는 양으로 소모되는 한도는 **하루 수신 요청 10만 건**
하나뿐이고, **수신 WebSocket 메시지 20통이 1요청**입니다. 즉 효력이 있는 것은
"방 전체가 초당 몇 통 보내는지"이며 인원수 자체가 아닙니다. 그래서 클라이언트가
**접속 인원을 보고 전송 빈도를 낮춰** 합계를 초당 200통에 맞춥니다.

| 접속 인원 | 1인당 전송 빈도 | 합계 |
|---|---|---|
| 10명까지 | 10Hz | 초당 100통 |
| 25명까지 | 6Hz | 초당 150통 |
| 50명까지 | 4Hz | 초당 200통 |

30분짜리 작전 한 번이 초당 200통 × 1,800초 ÷ 20 = **18,000 요청 = 하루 한도의 18%**
입니다. 소박하게 50명 × 10Hz로 하면 **45%**로 뜁니다.
`tests/plan-cursor-budget.test.js`가 이 불변식(1명부터 상한까지,
인원 × 빈도 ≤ 초당 200통)을 고정하고 있습니다. **빈도를 올리면 떨어집니다.**

그 밖에 지키고 있는 것:

- `[[migrations]]`는 **`new_sqlite_classes`**. `new_classes`로 쓰면 key-value 백엔드가
  선택되고, 그것은 Workers **유료 플랜 전용**입니다(= 무료 한도 밖)
- **`state.acceptWebSocket()`만** 씁니다. `accept()`는 연결이 살아 있는 동안 계속
  실행 시간이 과금되어서, 탭 하나를 방치하면 하루 실행 시간 한도의 83%를 먹습니다
- **Durable Object에 타이머를 한 개도 만들지 않습니다**(`setInterval` / `setAlarm` /
  `setTimeout` 전부). 하트비트는 `setWebSocketAutoResponse("p" -> "o")`로,
  하이버네이션을 깨우지 않습니다. 커서의 팬아웃은 **수신으로 구동**합니다.
  `tests/room-cursors.test.js`가 소스를 감시하고 있어서 타이머를 넣으면 떨어집니다
- 클라이언트의 커서 전송은 **스로틀을 걸고, 같은 좌표는 다시 보내지 않습니다.**
  `document.hidden` 동안에는 보내지 않습니다
- 클라이언트는 jitter를 붙인 백오프로 최대 10회까지 재접속하고,
  10분간 조작이 없으면 스스로 끊습니다

무료 플랜은 한도를 넘어도 **과금되지 않고**, 그 종류의 조작이 에러로 멈출 뿐입니다.
일일 한도는 **00:00 UTC에 초기화**됩니다(월 단위가 아닙니다).

사용량을 실측하는 도구가 둘 있습니다.

```bash
# WebSocket을 열어 유지만 합니다(사람을 모으지 않고 접속 수를 만들 수 있습니다)
node tools/ws-load.mjs --base https://example.com --plan <작전ID> --cookie "$COOKIE" \
  --clients 20 --minutes 30

# 분 단위 실수를 GraphQL API에서 직접 읽습니다(정지 중에 과금이 늘지 않았는지 확인)
#   CLOUDFLARE_API_TOKEN(Account Analytics Read)과 CLOUDFLARE_ACCOUNT_ID 필요
#   DO_NAMESPACE_ID 필요(DO 네임스페이스 id. 구하는 법은 tools/do-usage.mjs 맨 앞에)
node tools/do-usage.mjs --minutes 10
```

---

## 남겨 둔 것(`comments` 테이블)

이 프로젝트의 출발점은 **장마다 익명 댓글란이 붙은 정적 페이지**였고,
이름(`wardogs-board`)에 남아 있는 것은 그쪽입니다. 지금은 `/`가 `/plan`으로
302 하며(`public/_redirects`), **댓글 API도 함께 접었습니다.**

UI가 사라진 뒤에도 서버만 계속 사람 확인 토큰을 요구하고 있어서,
**위젯은 없는데 토큰은 요구하는** 상태 — 즉 글을 올릴 경로가 구조적으로
존재하지 않는 상태였습니다. 그래서 API까지 함께 접었습니다.

**D1의 `comments` 테이블과 그 안의 행은 그대로 남아 있습니다.** 읽고 쓰는 경로가
없을 뿐, 지난 발언은 지워지지 않았습니다. `schema.sql`에서 빼면 스키마를 새로
흘리는 환경에서는 "없었던 일"이 되므로 테이블 정의는 그대로 두었습니다.
지난 글들은 IP를 **해시**해서 저장했었지만(`IP_SALT` 사용), 지금은 새로 해시할
코드 자체가 없습니다(이미 저장된 행을 설명하기 위해 남겨 둔 한 줄입니다).

되살린다면 `comments` 테이블은 그대로 쓸 수 있습니다. 다만 API와 UI와
사람 확인을 **한꺼번에** 다시 만들어야 합니다.

`tests/no-comments-api.test.js`가 이 모양을 지키고 있습니다
(댓글 API가 없는지, 사람 확인 위젯에 대한 참조가 없는지, `comments` 테이블은
남아 있는지).

---

## 라이선스와 출처

- 이 저장소의 코드는 **MIT License**(`LICENSE`)입니다
- **`schema.sql`의 드릴 타워 12기와 진영 스폰 9건의 좌표는
  [apollyon-sys/wardogs-calculator](https://github.com/apollyon-sys/wardogs-calculator)
  (MIT, Copyright (c) 2026 Apollyon)에서 왔습니다.**
  MIT는 저작권 표시를 남기는 것이 조건이므로, 전문과 우리가 가한 변환을
  **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**에 두었습니다.
  **수치를 더하거나 고칠 때는 그 기재도 함께 유지해 주세요.**
- **지도 이미지는 들어 있지 않습니다**(우리 저작물이 아닙니다)
- WARDOGS의 저작권은 Team17 / Bulkhead에 있습니다. 이 프로젝트는 비공식
  팬 제작물이며 두 회사와 관계가 없습니다
