# WARDOGS 战术板

[日本語](README.md) · [English](README.en.md) · **简体中文** · [한국어](README.ko.md)

一块**开局之前对着地图讲战术用的白板**。

语音里说"这儿""那边""往那头"，对方根本听不懂。这个工具把同一张地图摆到所有人屏幕上，
让你画线、放标记、用别人也看得见的光标去指。它只干这一件事。

**它完全不碰游戏。** 不读进程内存，不读游戏文件，不拦截通信，也不做覆盖层。
它就是一个普通的网页。WARDOGS 的版权属于 Team17 / Bulkhead，本项目是非官方的爱好者作品。

跑在 Cloudflare Pages（免费额度）上，数据存在 Pages Functions + D1（免费额度），
登录走 Discord OAuth。

> **本仓库不含地图图片。** 那不是我们的作品，没有分发的立场。
> **没有图片也能跑** —— 只是棋盘背后空着，坐标、网格、笔迹、标记、圆圈全都照常工作。
> 自备方法见[下文](#自己准备地图图片)。

---

## 能做什么

### 往地图上放东西

| | |
|---|---|
| **笔迹** | 自由手绘，三种粗细，橡皮，撤销。笔画量化到 0.1m 的整数后做差分编码再保存 |
| **标记** | 建筑、设置物、车辆、对局目标。**形状按类别区分**（方、三角、圆、针），不只靠颜色。射程圈和 FOB 建造范围按**真实尺寸（米）**绘制，所以缩放时跟地图同比例伸缩 |
| **地名（callout）** | "那个山包""工厂""北边的桥" —— 队里嘴上真会这么叫的名字，按战术方案各自保存 |
| **区域** | 涂 1km 格子（我方／敌方／中立／最重要／预判危险），可用集合运算加减 |
| **控制区** | **游戏自己定的圆**（半径 500m）的预设。和队里自己的判断在视觉上刻意分得很开，因为它们是两回事 |
| **热区** | 半径 85m，人数两倍 |
| **钻井塔／阵营出生点** | 固定在地图上。每局位置都一样，所以直接由内置数据画出 |

另外还有缩放与平移、1km 网格、A1–P16 格名（显示在棋盘边缘）、
游戏内坐标读数、比例尺，以及背景的单色／高对比度切换。

### 一起看同一块板

| | |
|---|---|
| **共享光标** | 别人的指针会以**带名字的箭头**出现在地图上。线上传的是**地图的米制坐标**，不是屏幕像素 —— 每个人的缩放和平移都不一样，传像素只会指到对方屏幕上另一个地方 |
| **拖动过程看得见** | 别人拖标记时你看到的是它在移动，不是松手后忽然跳过去 |
| **画线过程看得见** | 笔画会随着线被拉出来而逐渐出现 |
| **变更通知** | 别人放的、移的、删的、画的东西**不用刷新**就会出现 |
| **在场名单** | 此刻还有谁打开着这份方案，带名字、头像和颜色 |
| **同时 50 人** | 一份方案最多 50 人同时进。第 51 个会被"房间已满"挡回去 |

### 给谁看

| 设置 | 出现在列表 | 谁能看 | 谁能改 |
|---|---|---|---|
| `private` | 只有自己 | 只有自己 | 只有自己 |
| `public` | 出现 | 任何人，**包括未登录的访客** | 只有作者 |
| `public_edit` | 出现 | 任何人，含访客 | **任何已登录的人** |

**访客浏览**让人不登录也能看 `public` / `public_edit` 的方案。
访客会自动拿到一个两词的名字（类似"安静的水獭"），光标也会显示，但不能写入。
即便是 `public_edit`，**谁也删不掉别人放的东西。**

---

## 背后的想法

- **按套路做准备，而不是按场次做记录。** 它不是用来写"那局我们干了什么"的，
  而是用来**事先备好**"碰上 Default 就这么打"。
- **把判断绑在位置上。** "这个点只能从公路进，不好拿"——这句话应该贴在那个地方，
  而不是另开一份文档。
- **实时是加分项，不是前提。** WebSocket 一直连不上，棋盘的全部功能也能走普通 HTTP。
- **不出免费额度。** 这里没有任何以付费方案为前提的东西：
  Durable Object 里一个定时器都没有，只用 `state.acceptWebSocket()`，
  客户端发送频率随在场人数下降，使整房总量不超过 200 条/秒。
- **没有构建步骤。** HTML 和 ES 模块原样发出 —— 没有打包器、没有转译器、没有框架。
  `npm ci` 只是为了测试（vitest / Playwright）和 wrangler。

---

## 目录结构

```
public/plan.html            战术板页面（标记与 CSS；设计 token 在 :root）
public/index.html           只做一件事：跳转到 /plan
public/_redirects           / -> /plan（302）
public/_headers             缓存设置（JS 每次重新校验，图片一年 immutable）
public/css/                 样式表（6 个文件）
public/js/plan/             浏览器端的 ES 模块
  app.js                      组装画面并处理操作，从这里调用其余模块
  coords.js                   坐标换算（游戏内 <-> 米 <-> SVG）与格名
  viewport.js / render.js     缩放・平移・比例尺／SVG 的组装
  ink.js                      笔画的量化与编码（与服务端共用）
  placements.js               标记与射程圈
  areas.js / zones.js         1km 格的集合运算／游戏自己定的圆
  towers.js / spawns.js       地图固定的钻井塔／阵营出生点
  callouts.js / gutter.js     地名／棋盘边缘的格名标题
  cursors.js / changes.js     光标收发／变更通知的处理时机
  board/                      棋盘部件（绘制、指针、实时笔迹、背景地图等）
  pages/                      各画面的组装（方案列表、登录入口）

functions/_lib/             公共部分（认证、输入校验、笔迹编解码、圆的几何）
functions/api/sessions/     方案的 CRUD，及其下的 ink / placements / areas / callouts / zone
functions/api/auth/discord/ Discord OAuth
functions/api/catalog.js    建筑目录
functions/api/maps/         地图列表／控制区预设
functions/api/comments.js   按章节的匿名留言（见"保留下来的部分"）

workers/room/               中继共享光标的 Durable Object 专用 Worker（与 Pages 分开）
  src/index.js                PlanRoom 本体（在场管理、光标中继）
  src/presence.js             在场管理的纯逻辑
  src/cursors.js              光标限流与串行化的纯逻辑

schema.sql                  D1 的表定义（只有 CREATE TABLE IF NOT EXISTS，幂等）
migrations/                 给已有数据库补差分的一次性 SQL（新建的话不需要）
wrangler.toml               Pages 配置（**有两处要填自己的值**）
tools/                      运维与验证脚本（开发服务器、地图切片、用量实测）
tests/                      vitest 集成测试（会起本地 wrangler 再去打它）
e2e/                        Playwright UI 测试
testlib/d1-direct.js        tests/ 与 e2e/ 共用的 D1 直接打开
docs/design-system.md       画面的型。**要动 UI 请先读这个**
```

### 故意没有放进来的东西

| | 原因 |
|---|---|
| **`public/map/`**（4,000 多张图片） | **不是我们的作品，没有分发的立场** |
| **部署用的 workflow** | 不希望 fork 的人第一次 push 就去尝试部署到 Cloudflare、因为没有 secrets 而失败、留下一个莫名的红叉。CI**只跑测试**（`.github/workflows/test.yml`） |
| **决策记录、调研记录、规格书** | 上游的内部文档。注释里仍有指向 `docs/research/...` 和 `docs/superpowers/specs/...` 的引用，**但这些文件不在本仓库里**。删掉引用就查不到某个决定的来由，所以保留了 |
| **`tests/naming.test.js`** | 它只是固定上游仓库改名这件事 |

---

## 关于代码里的语言

**注释是日文的。** 不过**主要文件开头的注释块里并列了英文摘要**（以 `// EN:` 开头的行）。
函数体里的行内注释仍然是日文。

```js
// 盤面の見えている範囲（= SVG の viewBox）の計算。DOM は一切触らない。
//
// EN: Pure computation of the visible region of the board (the SVG viewBox); touches
//     no DOM. Zooming moves the viewBox itself instead of applying a transform scale,
//     ...
```

需要并列英文的文件清单放在 `tests/en-headers.test.js` 里，
**英文掉了测试就会红。** 新增主要模块时请一并加进那个清单。

标识符（变量名、函数名、API 路径）全部是英文。界面上显示的文案，
以及数据库里 `source` 列的内容是日文。

---

## 自己搭一套

需要：

- **Node.js 22 以上**（wrangler 4.x 的要求。Node 20 根本起不来）
- **Cloudflare 账号**（免费方案就够）
- **一个 Discord 应用**，用于 OAuth 登录

```bash
git clone https://github.com/DaiconMan/wardogs-board.git
cd wardogs-board
npm ci
```

### 1. 建 D1 数据库

```bash
npx wrangler login
npx wrangler d1 create wardogs-blue      # 名字随便取
```

输出里会有一个 `database_id`（UUID）。**把它贴进 `wrangler.toml`。**

```toml
[[d1_databases]]
binding = "DB"
database_name = "wardogs-blue"              # 上面取的名字
database_id = "PUT-YOUR-OWN-DATABASE-ID-HERE"   # <- 这里
```

然后建表。`schema.sql` 里只有 `CREATE TABLE IF NOT EXISTS` 和 `INSERT OR IGNORE`，
所以**反复执行结果都一样。**

```bash
npx wrangler d1 execute wardogs-blue --local  --file=schema.sql   # 本地
npx wrangler d1 execute wardogs-blue --remote --file=schema.sql   # 线上
```

### 2. 建 Discord 应用

在 [Discord Developer Portal](https://discord.com/developers/applications)
点 New Application，然后进 OAuth2。

**登记 Redirect URI。** `redirect_uri` 是按实际被访问的主机名拼出来的，
所以**你打算用的每个域名都要单独登记一条。** 在没登记的域名上打开，
Discord 那边会直接给你 `Invalid OAuth2 redirect_uri`。

```
https://<你的 Pages 项目>.pages.dev/api/auth/discord/callback
https://<你的自定义域名>/api/auth/discord/callback
http://127.0.0.1:8788/api/auth/discord/callback      # 本地调试用
```

申请的 scope 只有 **`identify`**（用户 ID、显示名、头像）。
不取邮箱，也不取服务器列表。"Public client" 保持关闭，使用 Client Secret。

**把 Application ID（即 Client ID）贴进 `wrangler.toml`。**
它是**公开值** —— 会出现在浏览器的跳转 URL 里，藏也没意义。

```toml
[vars]
DISCORD_CLIENT_ID = "PUT-YOUR-OWN-DISCORD-CLIENT-ID-HERE"   # <- 这里
```

### 3. 部署 Durable Object 的 Worker（`wardogs-room`）

**Pages 项目里没法定义 Durable Object**
（"You cannot create and deploy a Durable Object within a Pages project."）。
所以它住在另一个 Worker 里，Pages 这边通过 `wrangler.toml` 的
`script_name = "wardogs-room"` 借用。

```bash
npx wrangler deploy --config workers/room/wrangler.toml
```

**顺序是有讲究的。** 先发 Pages，绑定可能指向一个还不存在的类。
`npm run deploy` 的顺序是 room 再 pages，平常用它就好。

> **不要给 `wardogs-room` 配公开路由。** 校验会话 Cookie 的只有 Pages Function
> （`functions/api/sessions/[id]/ws.js`），一旦有公开路由，认证就被整个绕过了。
> 仓库里是 `workers_dev = false` 且没有配置任何 route。

### 4. 建 Pages 项目并发布

```bash
npx wrangler pages project create wardogs-board --production-branch main
npm run deploy      # 先 room，再 pages
```

D1 的 binding 会从 `wrangler.toml` 的 `[[d1_databases]]` 自动生效，
Pages 那边不用手工配（用 wrangler 4.142.0 确认过）。

### 5. 设置 secrets

```bash
npx wrangler pages secret put DISCORD_CLIENT_SECRET --project-name wardogs-board
npx wrangler pages secret put SESSION_SECRET        --project-name wardogs-board
```

| 名称 | 用途 | 缺了会怎样 |
|---|---|---|
| `DISCORD_CLIENT_SECRET` | OAuth 的 token 交换 | 谁都登不进来 |
| `SESSION_SECRET` | 会话 Cookie 的签名密钥（HMAC-SHA256）。**随便一串随机字符**即可 | 谁都登不进来 |
| `ADMIN_TOKEN` | 删留言（可选） | 删除入口不出现 |
| `TURNSTILE_SECRET` | 留言的人机校验（可选） | 不做人机校验也能用（只有每 IP 每 10 分钟 5 条的限制） |
| `IP_SALT` | 留言 IP 哈希的盐（可选） | 用默认值 |
| `BLOCKED_WORDS` | 留言的屏蔽词（逗号分隔，可选） | 不启用 |

**D1 里没有会话表。** 全部状态都由一枚 HMAC-SHA256 签名的 Cookie 携带
（`functions/_lib/session.js`）。

### 6. 自定义域名（可选）

在 Cloudflare Pages 的 Custom domains 里添加，并在 DNS 里建一条
从子域名指向 `<项目>.pages.dev` 的 CNAME（开启代理）。
**每加一个域名，都要去 Discord 补一条 redirect URI。**

---

## 自己准备地图图片

`public/map/` 可以一直空着。那样只是棋盘背后没有图，
坐标、网格、格名、笔迹、标记、区域、圆圈都不受影响
（图片 404 时 `public/js/plan/board/basemap.js` 就什么都不画）。

要放背景的话，有两个位置：

```
public/map/overview/<map>.webp              一张 2048px 的整图（全局视图用）
public/map/tiles/<map>/<z>/<y>/<x>.webp     512px 的瓦片（z 为 0–5，y 在 x 前面）
```

`<map>` 是 `maps` 表里的 `id`（默认是 `bakurani` / `ozeti` / `zestafona`）。
瓦片假定**正方形、二的幂次网格**：z 层的一张瓦片覆盖 `<边长>/2^z` 米见方，
原点在地图左上角。其他形状的地图只会显示 overview。

仓库里带了一个把超大原图切成这个结构的脚本。它用 libvips 的流式处理，
所以就算是 32768²（4.3GB）的图，内存峰值也只有 400MB 左右。

```bash
# 需要 vips（libvips）
# 先把原图放到 map-src/<map>.png
tools/build-map-assets.sh all
```

**图片怎么来，请你自己解决。** 本仓库一张都不分发。

`.gitignore` 连 **`public/map/` 本身也一并忽略** —— 图片不是我们的作品，
而且 4,000 多张瓦片也不是你会想顺手 push 上去的东西。
要是你决定提交自己的图片，请把 `.gitignore` 里 `public/map/` 那一行删掉，
**并且**删掉 `tests/no-account-identifiers.test.js` 里对应的那条检查
（"public/map/ 没有被追踪"）。

---

## 本地运行

```bash
npx wrangler d1 execute wardogs-blue --local --file=schema.sql
cp .dev.vars.example .dev.vars        # 填上 DISCORD_CLIENT_SECRET 和 SESSION_SECRET
npm run dev                           # 同时起 room（8787）和 pages（8788）
```

浏览器开 **http://127.0.0.1:8788**。Ctrl-C 一起停掉。

`npm run dev` 起两个进程，是因为实时那一半住在另一个 Worker 里。
启动日志里出现
`env.ROOM (PlanRoom, defined in wardogs-room) ... [connected]` 就说明接上了。
显示 `[not connected]` 时 `/api/sessions/:id/ws` 会返回 503 ——
在场名单和光标不出现，其余功能全都正常。

---

## 测试

```bash
npm test        # vitest 集成测试
npm run test:ui # Playwright UI 测试
```

**两者都只打本地的 `wrangler pages dev` / `wrangler dev`。** 出网的只有两件事：

- `npm ci` 和 `npx playwright install` 的下载
- Turnstile 那个测试会往 `challenges.cloudflare.com` 发 POST，
  用的是 Cloudflare 官方的测试密钥（`1x00000000000000000000AA` 恒成功，
  `2x0000000000000000000000000000000AA` 恒失败）

**没有地图图片，整套测试也全过。** 涉及背景的测试看的是 `#basemap` 的 `href` 属性，
以及"把 `**/map/**` 全部中断掉，棋盘是否照常"——也就是**属性和失败时的行为**。
没有任何测试真的去加载图片。

### 同时起多个时的端口

要起多个 `wrangler pages dev` 的话，除了 `--port`，
**`--inspector-port` 和 `--persist-to` 也要每个实例分开。**

- `--inspector-port`：只改 `--port` 的话 inspector 还钉在默认的 9229 上，会撞
- `--persist-to`：D1 的持久化位置。共用会让并发写去抢锁，变成 `D1_ERROR` -> 500

| 用途 | 端口 | inspector | persist-to |
|---|---|---|---|
| vitest（留言，4 种配置） | 8811-8814 | 9311-9314 | `.wrangler/test-state` |
| vitest（/plan） | 8831 | 9331 | `.wrangler/plan-state` |
| e2e（/plan） | 8832 | 9332 | `.wrangler/e2e-plan-state` |
| e2e（room / Durable Object） | 8833 | 9333 | `.wrangler/e2e-room-state` |
| `npm run dev`（room） | 8787 | 9787 | `.wrangler/dev-room-state` |
| `npm run dev`（pages） | 8788 | 9788 | `.wrangler/dev-pages-state` |

**`WRANGLER_REGISTRY_PATH` 也要分开。** wrangler 会把正在运行的 Worker 登记到
一个**每台机器只有一份**的注册表里（默认 `~/.config/.wrangler/registry`），
并从那里解析带 `script_name` 的 Durable Object 绑定。保持默认的话，
`npm run dev` 开着 `wardogs-room` 的同时跑 `npm test`，
**本该没有 ROOM 的测试服务器会真的连上 ROOM** ——
`/api/sessions/:id/ws` 在应该返回 503 的地方返回了 101。

上次的残留占着端口的话，清掉再重跑。

```bash
pkill -f "wrangler pages dev"; pkill -f "workers/room"; pkill workerd
```

**绝对不要在同一个工作副本上同时跑两套 Playwright。**
它们会抢固定端口和 persist 目录，然后一大片假失败。

---

## 不出免费额度

Durable Objects 这边真正会被明显消耗的额度只有**每天 10 万次入站请求**，
而且**入站 WebSocket 消息 20 条算 1 次请求**。所以起决定作用的是
"整个房间每秒发多少条"，不是人数本身。因此客户端会**随在场人数下调发送频率**，
把总量压在 200 条/秒。

| 在场人数 | 每人发送频率 | 合计 |
|---|---|---|
| 10 人以内 | 10Hz | 100 条/秒 |
| 25 人以内 | 6Hz | 150 条/秒 |
| 50 人以内 | 4Hz | 200 条/秒 |

一次 30 分钟的作战会议是 200/秒 × 1,800 秒 ÷ 20 = **18,000 次请求，即一天额度的 18%。**
要是天真地按 50 人 × 10Hz，会飙到 **45%**。
`tests/plan-cursor-budget.test.js` 固定了这个不变式（从 1 人到上限，人数 × 频率 ≤ 200 条/秒）。
**把频率调高，这个测试就会红。**

其他在守的规矩：

- `[[migrations]]` 用 **`new_sqlite_classes`**。写 `new_classes` 会选中 key-value 后端，
  那是**仅付费方案**可用的（＝出了免费额度）
- **只用 `state.acceptWebSocket()`。** `accept()` 在连接存续期间一直按墙钟时间计费，
  一个忘关的标签页就能吃掉一天计算额度的 83%
- **Durable Object 里一个定时器都不建**（`setInterval` / `setAlarm` / `setTimeout` 都不行）。
  心跳用 `setWebSocketAutoResponse("p" -> "o")`，它不会打断休眠；
  光标的扇出**由收到的消息驱动**。`tests/room-cursors.test.js` 盯着源码，
  一加定时器就红
- 客户端的光标发送**做节流，且坐标没变就不重发**。`document.hidden` 期间不发
- 客户端重连用带 jitter 的退避、上限 10 次，无操作 10 分钟后自己断开

免费方案超额**不会扣钱**，只是那一类操作开始报错。日额度在 **00:00 UTC 重置**（不是按月）。

有两个实测用量的工具：

```bash
# 只建立并保持 WebSocket（不用叫人来也能造出连接数）
node tools/ws-load.mjs --base https://example.com --plan <方案ID> --cookie "$COOKIE" \
  --clients 20 --minutes 30

# 直接从 GraphQL API 按分钟读实数（静止时计费有没有在涨）
#   需要 CLOUDFLARE_API_TOKEN（Account Analytics Read）和 CLOUDFLARE_ACCOUNT_ID
#   需要 DO_NAMESPACE_ID（DO 命名空间的 id，取法见 tools/do-usage.mjs 开头）
node tools/do-usage.mjs --minutes 10
```

---

## 保留下来的部分（留言区）

这个项目最初是**每一章下面带匿名留言区的静态页面**，名字 `wardogs-board` 就是从那儿来的。
现在 `/` 会 302 到 `/plan`（`public/_redirects`），
但留言的 API（`/api/comments`）和相应的表都还在。

- 限制值：`functions/api/comments.js` 开头的常量（正文 1000 字、名字 24 字、每 IP 每 10 分钟 5 条）
- 人机校验：Cloudflare Turnstile。没设 `TURNSTILE_SECRET` 就不做校验照常跑
- IP 以**哈希**保存（带 `IP_SALT`）。原始 IP 不入库

---

## 许可与出处

- 本仓库的代码采用 **MIT License**（`LICENSE`）
- **`schema.sql` 里 12 座钻井塔和 9 个阵营出生点的坐标，来自
  [apollyon-sys/wardogs-calculator](https://github.com/apollyon-sys/wardogs-calculator)
  （MIT, Copyright (c) 2026 Apollyon）。**
  MIT 要求保留版权声明，所以全文以及我们所做的换算都放在
  **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**。
  **增补或修正这些数值时，请把那份记载一并维护下去。**
- **不含地图图片**（那不是我们的作品）
- WARDOGS 的版权属于 Team17 / Bulkhead。本项目是非官方的爱好者作品，与两家公司无关
