# WARDOGS Battle Planner

[日本語](README.md) · **English** · [简体中文](README.zh-CN.md) · [한국어](README.ko.md)

A shared whiteboard for **talking over a map before the match starts**.

"Here", "over there", "that side" mean nothing on voice chat. This opens the same map on
everybody's screen so you can draw a line, drop a marker, and point at things with a
cursor the others can see. That is all it is for.

**It does not touch the game.** No process memory, no game files, no traffic
interception, no overlay. It is an ordinary web page. WARDOGS belongs to
Team17 / Bulkhead; this is an unofficial fan project.

It runs on Cloudflare Pages (free tier), stores data in Pages Functions + D1 (free
tier), and signs people in with Discord OAuth.

> **The map imagery is not in this repository.** It is not ours to redistribute.
> **The app works without it** — you get a board with no picture behind it, while
> coordinates, the grid, ink, markers and zones all behave exactly as before.
> See [Supplying your own map imagery](#supplying-your-own-map-imagery).

---

## What it does

### Put things on the map

| | |
|---|---|
| **Ink** | Freehand pen, three widths, eraser, undo. Strokes are quantised to 0.1 m integers and delta-encoded before storage |
| **Markers** | Structures, emplacements, vehicles and match objectives. The shape differs per kind (square, triangle, circle, pin) rather than the colour alone. Range rings and FOB build radii are drawn **at true scale in metres**, so they grow and shrink with the map as you zoom |
| **Callouts** | "that hill", "the factory", "the north bridge" — the names your team actually says out loud, stored per plan |
| **Areas** | Paint 1 km cells (ours / theirs / neutral / key / expected trouble) with set operations to add and subtract |
| **Control areas** | The circles **the game itself decides** (500 m radius; **550 m on Ozeti**), as presets. Visually kept well apart from the team's own guesses, because they are a different kind of thing |
| **Hot zones** | 85 m radius, double headcount |
| **Drill towers / faction spawns** | Fixed to the map. The positions are identical every match, so they come straight out of the bundled data |

Plus zoom and pan, a 1 km grid, A1-P16 cell names (as headings in the board margin),
in-game coordinate readout, a scale bar, and a monochrome / high-contrast toggle for
the background.

### Look at it together

| | |
|---|---|
| **Shared cursors** | Everyone else's pointer appears on the map as a **named arrow**. What travels over the wire is **map coordinates in metres**, not screen pixels — everybody is zoomed and panned differently, so pixels would point at the wrong place on the other screen |
| **Drags are visible while they happen** | When somebody drags a marker you see it moving, not teleporting on release |
| **Ink is visible while it is drawn** | The stroke appears as the line is being pulled |
| **Change notifications** | Anything placed, moved, deleted or drawn by somebody else shows up **without a reload** |
| **Presence** | Who else has this plan open right now, by name, avatar and colour |
| **Up to 50 at once** | Fifty people per plan. The fifty-first is turned away with "the room is full" |

### Who gets to see it

**The setting only changes two things: whether the plan is listed, and who can
edit it. Viewing is the same in all three states** — what guards a plan is knowing
its URL.

| Setting | Listed | Can view (with the URL) | Can edit |
|---|---|---|---|
| `private` (default) | **no** | anyone, **including guests** | **anyone who is logged in** |
| `public` | yes | anyone, including guests | **the author and admins** |
| `public_edit` | yes | anyone, including guests | **anyone who is logged in** |

**`private` means "not listed", not "secret".** Anyone with the URL can open it,
and anyone logged in can write to it. Teams pass the URL of a private plan around
and edit it together, so locking that down would break the existing workflow just
by adding a visibility setting. **It is not a place for anything you need hidden.**

**Guest viewing** lets people open a plan without logging in. Guests get an
automatic two-word name and their cursor shows up too, but they **cannot write
at all**, under any setting. Only `public` / `public_edit` plans appear in the
list, but **a guest handed the URL can open a `private` plan as well.**

Nobody can delete anybody else's markers — **except admins, who can.**

The generated guest names are **Japanese only** (there is no per-locale wording).

---

## The ideas behind it

- **Preparation per pattern, not a record per match.** This is not for writing down what
  happened; it is for having "when it's Default, we push like this" **ready in advance**.
- **Attach the judgement to the place.** "This one is hard to take because the only
  approach is the road" belongs *on* that spot, not in a separate document.
- **Real time is an addition, not a prerequisite.** Every feature of the board works
  over plain HTTP if the WebSocket never connects.
- **Stay inside the free tier.** Nothing here assumes a paid plan: no timers anywhere in
  the Durable Object, `state.acceptWebSocket()` only, and a client-side send rate that
  drops as the room fills so the room total never passes 200 messages/second.
- **No build step.** HTML and ES modules are served as they are — no bundler, no
  transpiler, no framework. `npm ci` exists for the tests (vitest / Playwright) and
  wrangler, nothing else.

---

## Layout

```
public/plan.html            the planner page (**markup only; there is no <style> block**)
public/index.html           a redirect to /plan and nothing else (12 lines)
public/_redirects           / -> /plan (302)
public/_headers             caching (JS and CSS revalidate every time; images are immutable for a year)
public/css/                 the stylesheets, 6 files (**the :root design tokens live in plan-base.css**)
public/js/plan/             the browser-side ES modules, 25 files
  app.js                      assembles the screen and handles interaction; calls the rest
  state.js / dom.js / util.js shared state / element lookup / small helpers
  api.js                      the fetch wrapper
  coords.js                   coordinate conversion (in-game <-> metres <-> SVG) and cell names
  viewport.js / render.js     zoom, pan and scale / SVG construction
  chrome.js                   measures the floating frame into --chrome-top/bottom
  ink.js                      stroke quantisation and encoding (shared with the server)
  placements.js               markers and range rings
  areas.js / zones.js         1 km cell set operations / the circles the game decides
  towers.js / spawns.js       map-fixed drill towers / faction spawns
  callouts.js / gutter.js     place names / cell-name headings in the board margin
  sessions.js                 pure functions for rendering the plan list
  visibility.js               the visibility rule (**shared with the server; this is the one copy**)
  guest.js                    viewing without logging in (automatic name assignment)
  avatar.js                   Discord avatars (placed inside the colour ring, not replacing it)
  choice.js                   single-choice fields (no <select>; design-system §16)
  presence.js                 the presence WebSocket
  cursors.js / changes.js     cursors, carry and live ink / how change notifications are handled
  board/                      board parts, 18 files (drawing, pointer, live ink, background map, ...)
  pages/                      gate.js (login gate) / list.js (the plan list and creation)

functions/_lib/             shared code, 7 files (session / guard / validate / ink / zones /
                            guest / visibility)
functions/api/sessions/     plan CRUD and, beneath it,
                            ink / placements / areas / callouts / zone / ws
functions/api/auth/         discord/start, discord/callback, logout
functions/api/me/           /api/me (login state, guest name, visit history)
functions/api/catalog.js    the structure catalogue
functions/api/maps/         map list / {id}/zone-presets (GET/POST/PATCH/DELETE)

workers/room/               a separate Worker (not Pages) for the cursor-relay Durable Object
  src/index.js                PlanRoom itself (presence, cursor relay)
  src/presence.js             pure presence logic
  src/cursors.js              pure rate-limiting and serialisation logic for cursors

schema.sql                  D1 table definitions. **Idempotent** (23 CREATE TABLE IF NOT EXISTS,
                            20 CREATE INDEX IF NOT EXISTS, 11 INSERT OR IGNORE, nothing else)
migrations/                 4 one-shot deltas for databases that already exist (not needed for a fresh one)
wrangler.toml               Pages configuration (**two values you must fill in yourself**)
tools/                      6 operational scripts
  dev.mjs                     npm run dev (brings up room on 8787 and pages on 8788)
  build-map-assets.sh         builds the overview and tiles from a map image
  do-usage.mjs                reads Durable Objects usage minute by minute
  ws-min.mjs                  a minimal WebSocket client (the tests use it)
  ws-load.mjs                 holds connections open to measure free-tier consumption
  ws-fanout.mjs               pushes the design ceiling (200 msg/s) to measure fan-out
tests/                      vitest (47 *.test.js files). **Not all of them are integration tests**
                            (coords, ink-codec, zones-geom, cursor-budget, room-* and others
                            run without a server)
e2e/                        Playwright (24 *.spec.js files; npm run test:ui runs the 23 that
                            are left once shots.spec.js is excluded)
testlib/d1-direct.js        the direct D1 open shared by tests/ and e2e/
docs/design-system.md       the shape of the screen. **Read this before touching the UI**
LICENSE                     MIT
THIRD-PARTY-NOTICES.md      sources and licences for external data
```

### What is deliberately absent

| | Why |
|---|---|
| **`public/map/`** (4,000+ image tiles) | **Not our work. Not ours to hand out** |
| **A deploy workflow** | A fork should not try to deploy to Cloudflare on its first push, fail for want of secrets, and leave a confusing red X. CI runs **tests only** (`.github/workflows/test.yml`) |
| **Decision log, research notes, specs** | Upstream internal documents. Some comments still point at `docs/research/...` and `docs/superpowers/specs/...`; **those files are not in this repository.** The references were left in place because removing them would erase where a decision came from |
| **`tests/naming.test.js`** | It only pins a rename in the upstream repository |

---

## A note on the language of the code

**The comments are in Japanese.** The **leading comment block of each major file also
carries an English summary**, on lines beginning `// EN:`. Comments inside the body of a
function stay Japanese.

```js
// 盤面の見えている範囲（= SVG の viewBox）の計算。DOM は一切触らない。
//
// EN: Pure computation of the visible region of the board (the SVG viewBox); touches
//     no DOM. Zooming moves the viewBox itself instead of applying a transform scale,
//     ...
```

The list of files that must carry one lives in `tests/en-headers.test.js`, so
**dropping the English breaks the build.** Add new major modules to that list.

Identifiers — variables, functions, API paths — are all English. User-facing strings and
the `source` column in the database are Japanese.

---

## Running your own copy

You need:

- **Node.js 22 or newer** (wrangler 4.x requires it; it will not start on Node 20)
- **A Cloudflare account** (the free plan is enough)
- **A Discord application** for OAuth sign-in

```bash
git clone https://github.com/DaiconMan/wardogs-board.git
cd wardogs-board
npm ci
```

### 1. Create the D1 database

```bash
npx wrangler login
npx wrangler d1 create wardogs-blue      # any name you like
```

The output includes a `database_id` UUID. **Paste it into `wrangler.toml`.**

```toml
[[d1_databases]]
binding = "DB"
database_name = "wardogs-blue"              # whatever you named it above
database_id = "PUT-YOUR-OWN-DATABASE-ID-HERE"   # <- here
```

Then create the tables. `schema.sql` contains only `CREATE TABLE IF NOT EXISTS` and
`INSERT OR IGNORE`, so **running it repeatedly changes nothing.**

```bash
npx wrangler d1 execute wardogs-blue --local  --file=schema.sql   # local
npx wrangler d1 execute wardogs-blue --remote --file=schema.sql   # production
```

### 2. Create the Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications):
New Application, then OAuth2.

**Register the redirect URIs.** The `redirect_uri` is built from the host that was
actually requested, so **every domain you intend to use needs its own entry.** Opening
the site on a domain you did not register gets you `Invalid OAuth2 redirect_uri` from
Discord.

```
https://<your-pages-project>.pages.dev/api/auth/discord/callback
https://<your-custom-domain>/api/auth/discord/callback
http://127.0.0.1:8788/api/auth/discord/callback      # for local development
```

The only scope requested is **`identify`** — user id, display name and avatar. No
e-mail address, no guild list. "Public client" stays off; the Client Secret is used.

**Paste the Application ID (the Client ID) into `wrangler.toml`.** It is a **public
value**: it appears in the redirect URL in the browser, so there is nothing to hide.

```toml
[vars]
DISCORD_CLIENT_ID = "PUT-YOUR-OWN-DISCORD-CLIENT-ID-HERE"   # <- here
```

### 3. Deploy the Durable Object Worker (`wardogs-room`)

**A Durable Object cannot be defined inside a Pages project** ("You cannot create and
deploy a Durable Object within a Pages project."). So it lives in a separate Worker,
and the Pages side borrows it through `script_name = "wardogs-room"` in `wrangler.toml`.

```bash
npx wrangler deploy --config workers/room/wrangler.toml
```

**The order matters.** Deploying Pages first can leave a binding pointing at a class
that does not exist yet. `npm run deploy` does room, then pages — normally use that.

> **Do not give `wardogs-room` a public route.** The only thing verifying the session
> cookie is the Pages Function (`functions/api/sessions/[id]/ws.js`), so a public route
> would let callers bypass authentication entirely. It ships with
> `workers_dev = false` and no routes configured.

### 4. Create the Pages project and deploy

```bash
npx wrangler pages project create wardogs-board --production-branch main
npm run deploy      # room first, then pages
```

The D1 binding is picked up from `[[d1_databases]]` in `wrangler.toml`; no manual
configuration is needed on the Pages side (verified with wrangler 4.142.0).

### 5. Set the secrets

```bash
npx wrangler pages secret put DISCORD_CLIENT_SECRET --project-name wardogs-board
npx wrangler pages secret put SESSION_SECRET        --project-name wardogs-board
```

| Name | Used for | If missing |
|---|---|---|
| `DISCORD_CLIENT_SECRET` | the OAuth token exchange | nobody can sign in |
| `SESSION_SECRET` | signing the session cookie (HMAC-SHA256). **Any random string** will do | nobody can sign in |
| `BLOCKED_WORDS` | comma-separated word filter for plan titles, placement notes and callouts (optional) | disabled |

**These two are the only ones you need.** There used to be secrets for the comment
threads as well (`ADMIN_TOKEN` for deleting posts, plus two keys for the human
check), but the threads were retired and no code reads them any more, so they were
deleted. **Only the comment-thread keys went away; the sign-in path is untouched.**

**There is no session table in D1.** All of the state is carried by a cookie signed
with HMAC-SHA256 (`functions/_lib/session.js`).

### 6. A custom domain (optional)

Add it under Custom domains in Cloudflare Pages, and create a proxied CNAME from your
subdomain to `<project>.pages.dev`. **Every domain you add also needs a Discord
redirect URI.**

---

## Supplying your own map imagery

`public/map/` can stay empty. You simply get no picture behind the board; coordinates,
the grid, cell names, ink, markers, areas and circles are all unaffected
(`public/js/plan/board/basemap.js` draws nothing when the image 404s).

If you do want a background, there are two places to put files:

```
public/map/overview/<map>.webp              a single 2048px image (for the zoomed-out view)
public/map/tiles/<map>/<z>/<y>/<x>.webp     512px tiles (z is 0-5; y comes before x)
```

`<map>` is the `id` in the `maps` table (`bakurani` / `ozeti` / `zestafona` by
default). Tiles assume a **square, power-of-two grid**: one tile at zoom z covers
`<side>/2^z` metres square, with the origin at the top-left of the map. For maps of any
other shape only the overview is shown.

There is a script for turning a huge source image into that layout. It uses libvips
streaming, so even a 32768² (4.3 GB) image peaks at around 400 MB of memory.

```bash
# requires vips (libvips)
# put your source at map-src/<map>.png first
tools/build-map-assets.sh all
```

**Obtaining the imagery is up to you.** This repository distributes none of it.

`.gitignore` also excludes **`public/map/` itself** — the images are not ours to
redistribute, and 4,000+ tiles is not something you want to push by accident. If you
decide to commit your own, remove the `public/map/` line from `.gitignore` **and** the
matching check in `tests/no-account-identifiers.test.js` ("public/map/ is not tracked").

---

## Running it locally

```bash
npx wrangler d1 execute wardogs-blue --local --file=schema.sql
cp .dev.vars.example .dev.vars        # fill in DISCORD_CLIENT_SECRET and SESSION_SECRET
npm run dev                           # starts both room (8787) and pages (8788)
```

Open **http://127.0.0.1:8788**. Ctrl-C stops both.

`npm run dev` starts two processes because the real-time half lives in a separate
Worker. If the startup log says
`env.ROOM (PlanRoom, defined in wardogs-room) ... [connected]` you are wired up.
`[not connected]` means `/api/sessions/:id/ws` will answer 503 — presence and cursors
go missing and everything else keeps working.

---

## Tests

```bash
npm test        # vitest (47 *.test.js files)
npm run test:ui # Playwright UI tests (23 files; shots.spec.js is excluded)
npm run shots   # regenerates the eyeball-check screenshots into shots/ (not in git)
```

**`npm test` is not all integration tests.** `plan-coords`, `plan-ink-codec`,
`plan-zones-geom`, `plan-cursor-budget`, `room-cursors`, `room-presence`,
`en-headers`, `no-account-identifiers` and `no-comments-api` run without starting a server.

**Both of them talk only to a local `wrangler pages dev` / `wrangler dev`.** The only
things that reach the network are the downloads for `npm ci` and
`npx playwright install`.

**The whole suite passes with no map imagery.** The tests that concern the background
check the `href` attribute on `#basemap`, and check that aborting every `**/map/**`
request leaves the board intact — that is, **attributes and failure behaviour.** No test
loads an actual image.

### Ports, when you run several at once

If you start more than one `wrangler pages dev`, give each instance its own
**`--inspector-port` and `--persist-to`** as well as its own `--port`.

- `--inspector-port`: changing `--port` leaves the inspector pinned at 9229, so it collides
- `--persist-to`: where D1 persists. Sharing it means concurrent writes fight over the
  lock and you get `D1_ERROR` -> 500

| Purpose | port | inspector | persist-to |
|---|---|---|---|
| vitest (/plan) | 8831 | 9331 | `.wrangler/plan-state` |
| e2e (/plan) | 8832 | 9332 | `.wrangler/e2e-plan-state` |
| e2e (room / Durable Object) | 8833 | 9333 | `.wrangler/e2e-room-state` |
| `npm run dev` (room) | 8787 | 9787 | `.wrangler/dev-room-state` |
| `npm run dev` (pages) | 8788 | 9788 | `.wrangler/dev-pages-state` |

vitest has no `globalSetup`. Files that need a server start one themselves
in `beforeAll` and stop it themselves.

**`WRANGLER_REGISTRY_PATH` needs separating too.** wrangler registers running Workers in
a registry there is only **one of per machine** (`~/.config/.wrangler/registry` by
default) and resolves `script_name` Durable Object bindings from it. Left at the
default, running `npm test` while `npm run dev` has `wardogs-room` up means
**the test server gets a working ROOM binding it is supposed to be without** —
`/api/sessions/:id/ws` answers 101 where 503 is expected.

If a previous run left ports occupied, clear them and try again.

```bash
pkill -f "wrangler pages dev"; pkill -f "workers/room"; pkill workerd
```

**Never run two Playwright suites against the same checkout at the same time.** They
fight over fixed ports and persist directories, and you get a flood of false failures.

---

## Staying inside the free tier

The only Durable Objects quota this consumes in a meaningful amount is **100,000
incoming requests per day**, and **20 incoming WebSocket messages count as one
request**. So what matters is how many messages per second the whole room sends, not how
many people are in it. The client therefore **lowers its send rate as the room fills**,
keeping the total at 200 messages/second.

| People present | Send rate each | Total |
|---|---|---|
| up to 10 | 10 Hz | 100 msg/s |
| up to 25 | 6 Hz | 150 msg/s |
| up to 50 | 4 Hz | 200 msg/s |

A single 30-minute planning session is 200/s x 1,800 s / 20 = **18,000 requests, 18% of
a day's quota.** A naive 50 x 10 Hz would be **45%**.
`tests/plan-cursor-budget.test.js` pins the invariant (from one person to the cap,
people x rate <= 200 msg/s). **Raising a rate breaks that test.**

Other rules being kept:

- `[[migrations]]` uses **`new_sqlite_classes`**. Writing `new_classes` selects the
  key-value backend, which is **paid-plan only** — i.e. outside the free tier
- **`state.acceptWebSocket()` only.** `accept()` bills wall-clock time for as long as the
  socket is open; one forgotten tab eats 83% of a day's compute allowance
- **No timers anywhere in the Durable Object** (`setInterval`, `setAlarm`,
  `setTimeout` — none of them). The heartbeat is
  `setWebSocketAutoResponse("p" -> "o")`, which does not break hibernation, and cursor
  fan-out is **driven by the incoming message.** `tests/room-cursors.test.js` watches the
  source and fails if a timer appears
- Client cursor sending is **throttled, and identical coordinates are not resent.**
  Nothing is sent while `document.hidden`
- Clients reconnect with jittered backoff capped at 10 attempts, and disconnect
  themselves after 10 idle minutes

On the free plan, exceeding a quota is **not billed** — that class of operation simply
starts failing. Daily quotas reset at **00:00 UTC** (not monthly).

Two tools for measuring actual usage:

```bash
# open and hold WebSockets, so you can create connection counts without gathering people
node tools/ws-load.mjs --base https://example.com --plan <plan-id> --cookie "$COOKIE" \
  --clients 20 --minutes 30

# read per-minute figures straight from the GraphQL API (did billing grow while idle?)
#   needs CLOUDFLARE_API_TOKEN (Account Analytics Read) and CLOUDFLARE_ACCOUNT_ID
#   needs DO_NAMESPACE_ID (the Durable Object namespace id; tools/do-usage.mjs says how to find it)
node tools/do-usage.mjs --minutes 10
```

---

## What is still here (the `comments` table)

This project started life as **a static page with an anonymous comment thread under each
chapter**, which is where the name `wardogs-board` comes from. `/` now 302s to `/plan`
(`public/_redirects`), and **the comment API has been retired too.**

Even after the UI disappeared, the server kept requiring a human-check token — the
widget was gone but the token was still demanded, so there was no longer any path by
which a post could actually reach the API. That is why the API itself was removed.

**The `comments` table and its rows are still in D1.** There is simply no path left to
read or write them; past posts have not been deleted. Dropping the table from
`schema.sql` would make it vanish from any environment that applies the schema from
scratch, so the table definition stays. Past posts had their IP address stored
**hashed** (with `IP_SALT`); nothing hashes new IPs anymore, since nothing stores new
IPs — this note only describes the rows already on disk.

If this ever comes back, the `comments` table can be reused as is, but the API, the UI
and the human check would all need to be rebuilt **together**.

`tests/no-comments-api.test.js` watches for this shape: no comment API, no reference to
a human-check widget anywhere, and the `comments` table still present.

---

## Licence and attribution

- The code in this repository is under the **MIT License** (`LICENSE`)
- **The 12 drill tower and 9 faction spawn coordinates in `schema.sql` are derived from
  [apollyon-sys/wardogs-calculator](https://github.com/apollyon-sys/wardogs-calculator)
  (MIT, Copyright (c) 2026 Apollyon).** The MIT License requires the copyright notice to
  be kept, so the full text — along with the transformations applied — is in
  **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**. **If you add to or correct those
  numbers, keep that notice with them.**
- **The map imagery is not included** (it is not ours)
- WARDOGS belongs to Team17 / Bulkhead. This is an unofficial fan project with no
  affiliation to either
