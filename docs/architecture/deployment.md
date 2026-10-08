---
title: "Deployment: GitHub Pages and the Planted Cloudflare Durable Object"
id: "ARCH-DEPLOYMENT"
type: "architecture"
status: "active"
lastReviewed: "2026-10-08"
appliesTo:
  - ".github/workflows/deploy.yml"
  - "wrangler.jsonc"
  - "scripts/wrangler.ts"
  - "scripts/build-bundle.ts"
  - "src/version.ts"
  - "workers/**"
  - "src/server/GameServer.ts"
  - "src/server/SocketTransport.ts"
  - "src/server/db/Db.ts"
  - "src/server/db/BunSqlDb.ts"
  - "src/server/Persistence.ts"
  - "src/server/Lobby.ts"
  - "src/server/Session.ts"
  - "src/server/RoomStore.ts"
  - "src/sim/WireMatch.ts"
  - "src/server/Tiles.ts"
  - "src/server/RelatedOrigins.ts"
  - "scripts/build-planet-tiles.ts"
  - "scripts/copy-public.mjs"
  - "public/map/**"
relatedDocs:
  - "docs/design/rfc/0001-referee-and-transports.md"
  - "docs/design/rfc/0002-region-sharded-durable-objects.md"
  - "docs/architecture/persistence.md"
  - "docs/architecture/networking.md"
  - "docs/backlog/active-backlog.md"
tags: ["deployment", "cloudflare", "durable-objects", "github-pages", "wrangler", "r2", "map-tiles"]
---

# Deployment: GitHub Pages and the Cloudflare Durable Object

There are two deployment paths in this repository, and they answer two different questions.
**Where does the game live** is answered by GitHub Pages, unconditionally, on every push. **Where
does a match server live**, if anyone wants one, has two answers now — `bun run serve:match` on a
developer's own machine, not reachable by anyone else's browser; or a single Cloudflare Durable
Object running the same real referee, deployed for real at
`https://tictac-match-server.waldemar-reusch.workers.dev` (`[ITEM-045]`). This document covers
both.

---

## 1. The Default: GitHub Pages

`.github/workflows/deploy.yml` builds the static client (`bun run build`) and deploys `dist/` to
GitHub Pages on every push to `main`. This is unconditional and untouched by anything in this
document — a repository clone that never looks at `wrangler.jsonc` or `workers/` still gets a
playable game, local and peer-to-peer matches included, because neither needs a server.

## 2. The Optional Path: A Match Server on Cloudflare

[RFC-0001 §7](../design/rfc/0001-referee-and-transports.md#7-deployment) named two hosting
options for a public referee and built neither: "a Durable Object per match, or one central
Postgres." `[ITEM-045]` starts on the first, because a Durable Object's per-instance storage and
per-instance billing fit a referee's own shape — one match server, one place its state lives —
better than a Postgres instance answering every match server that exists.

### 2.1 One Durable Object, not one per match

Despite the RFC's phrasing, this deployment runs **one** `MatchDurableObject` instance, not one
per match — and that one instance hosts every room:

```
workers/index.ts (Worker)
  ├── /tiles/{z}/{x}/{y}.mvt  ── answered here from R2 (§6), never reaching the object
  ├── /.well-known/webauthn  ── answered here from the RELYING_PARTY_* vars (§4)
  └── env.MATCH.idFromName(MATCH_SERVER)  ── always the same id ('singleton', src/server/Owner.ts)
        └── workers/MatchDurableObject.ts (the one instance)
              ├── fetch(): a WebSocket upgrade (→ Sessions → Lobby → a Room),
              │            or env.ASSETS.fetch(request)
              ├── alarm(): the travel schedule's one alarm (ARCH-WORLD §3)
              └── ctx.storage.sql, behind workers/DoSqliteDb.ts (the Db adapter)
```

A match server is one lobby of rooms (`src/server/Lobby.ts`, `docs/architecture/networking.md`
§8), the same reason `startGameServer` (`src/server/GameServer.ts`) binds one port to one
`Lobby` today: the rules that span rooms — one match per player, one live window per player —
need one place that sees every room. Sharding by match would mean the Durable Objects namespace
stops being "the match server" and starts being "a match," which is a bigger, different design
than what is planted here, and would need those two rules enforced across instances.

This is a deliberate first stage, not a ceiling this deployment is meant to live under forever:
a single Durable Object is one thread, and cannot be scaled up, only replaced.
[RFC-0002](../design/rfc/0002-region-sharded-durable-objects.md) is the plan for what replaces
it — sharding by *region* of the game's shared world rather than by match — once that world
exists and the player base needs more than one instance. Nothing about that plan is built; it
is written down so the single instance here stays easy to retire rather than becoming an
assumption other code quietly depends on: the Worker addresses the instance through
`MATCH_SERVER`, and squad requests go through `ownerOf(squad)` (`src/server/Owner.ts`,
[ARCH-WORLD §4](world.md)), the two lookups a split replaces.

**The object's one alarm is the travel schedule's** ([ARCH-WORLD §3](world.md)): set with
`ctx.storage.setAlarm` for the earliest moment any squad has due, never more than an hour ahead,
and cleared when nothing is. The alarm is kept in storage, so it wakes an evicted instance; the
constructor restores rooms and rebuilds the schedule from `squads` before `alarm()` or any request
runs.

### 2.2 The single instance serves both websocket and static assets

`wrangler.jsonc`'s `assets` block sets `run_worker_first: true`, so **every** request reaches
the Worker rather than the assets layer answering some of them directly. The Worker answers map
tiles itself (§6), so a map pan neither wakes the Durable Object nor queues behind its sockets,
and forwards everything else to the object. `MatchDurableObject.fetch` branches: a `WebSocket`
upgrade is handed to `Sessions` (§2.3); anything else is handed to `env.ASSETS.fetch(request)`,
which is bound through from the Worker's own `env` (Durable Object constructors receive the same
`env` a Worker does). There is no HTTP API: a window asks everything over its socket
([ARCH-NETWORKING §8](networking.md)). This is a deliberate design
choice for a small deployment with one Worker and one object, not a general pattern —
Cloudflare's own convention is for the assets layer to answer static requests without ever
reaching a Worker, and this deployment opts out of that specifically because the item asked for
one Durable Object that does both.

### 2.3 A real referee, not a relay — rooms that survive the instance, and why a socket does not hibernate

`MatchDurableObject` runs the same `Lobby`, `Sessions` and `Persistence` (via
`persistenceOverDb`) that `startGameServer` runs behind `Bun.serve`. Nothing about any of the
three was Bun-specific once handed a `Db` (`workers/DoSqliteDb.ts`, §3) and a transport with
`send`/`close` (`socketTransport`, `src/server/SocketTransport.ts` — split out of
`GameServer.ts` for the same isolation reason as §4's typecheck). A WebSocket upgrade is
accepted and attached with `Sessions.attach(transport, { url, place })` exactly as
`GameServer.ts`'s `websocket.open` handler does, with nothing checked at the upgrade: who the
socket is, and what it wants, it says over the socket. `place` is read off `request.cf`, which
the Worker's `stub.fetch(request)` carries through, so registration can record where a new
player connected from.

**Rooms are durable.** Every room writes itself to `ctx.storage.sql` as it changes — opened,
joined, started, its squads verified, judged or only witnessed, ended — through the same
ordered write chain its match log goes through (`RoomStore`,
[ARCH-PERSISTENCE §3](persistence.md)). The constructor runs `Lobby.restore()` inside
`blockConcurrencyWhile`, so no request reaches the object before every room it held is held
again: each seat with no socket in it and a fresh grace period, each playing room's referee
rebuilt by refighting its log. A deploy, a runtime restart or an eviction therefore costs a
room nothing. To the windows in it, it is a dropped connection: each reconnects, signs in again
with its stored token, re-enters its own seat with the key its `Seated` gave it, restates what it
had said if the match had not begun, and plays on — the opponent sees a short stall. A window
that does not come back within the grace period ends its room exactly as a dropped one always
did ([ARCH-NETWORKING §8](networking.md)).

**A socket still does not hibernate.** This class's first pass accepted sockets with
`ctx.acceptWebSocket`, the hibernatable API. Hibernation evicts the *whole object* between
messages, and the live parts of a room — its sockets, its `MatchHost`, the grace timer on a
dropped seat — are in memory; restoring them on every message would be refighting every match
per frame. Sockets are accepted with plain `server.accept()` instead: as long as any socket is
open, the runtime keeps this instance resident, the ordinary cost of any stateful connection.
Once every socket closes nothing pins the instance, and an eviction then is simply a restart the
next request pays for. Static-asset traffic never needed the exemption, since it is a
stateless reply.

**A rolling update.** `wrangler deploy` replaces the Worker and restarts the object under the
new build while browsers keep running the previous bundle. The new server admits its own protocol
at any build, and the protocol before (`OLDEST_SERVED_PROTOCOL`, never below 6) only for a keyed
resume named in the socket's url; each room keeps the build it was opened under, so:

- the windows of a match in progress reconnect to it on the previous bundle and finish it — a
  seat is taken back by a page on the *room's* build, not the server's;
- opening, joining or watching anything takes the server's own build; a stale page is refused
  that room with a `409` telling it to reload (§2.4), and still reads the lobby; a current page
  cannot join or watch a room of the previous build (*That match was started on another version
  of TicTac, and only its own players can finish it.*);
- a room of the previous build still waiting for an opponent is let go on restore, since no page
  can join it any more;
- the new server keeps refereeing the previous build's rooms, but cannot tell a foul from a
  rules change in them: the first disagreement stops it judging that room instead of aborting
  it — the match is relayed and recorded to its end, and kept on nobody's roster.

A deploy that changes nothing about the rules therefore finishes every match in progress
judged and kept, as if nothing had happened.

### 2.4 The Worker is stamped with the build id of the bundle it serves

The referee is not a bystander to the version gate. Under
[ADR-0004](../design/adr/0004-full-knowledge-lockstep.md) it recomputes every intent itself, so
`src/version.ts` applies to it exactly as it applies to a peer: it states its own build, and
refuses to open, join or watch anything for a client whose build differs — a `409` on
`room/enter`, the socket left open (a seat taken back answers to its room's build instead, §2.3).
That makes "which commit is this Worker?" a
*gameplay* fact, not a diagnostic.

`BUILD_ID` reaches a bundle through a build-time `--define`, and the client and the Worker are
built by two different tools: `scripts/build-bundle.ts` (`Bun.build`) produces `dist/`, while
wrangler runs its own esbuild over `workers/index.ts`. Wrangler knows nothing about the first
one's define, so a plain `wrangler deploy` shipped a referee whose `BUILD_ID` had fallen back to
`dev` while the bundle beside it in `dist/` carried a commit. The deployment then refused every
client it had just served, with the two symptoms that look unrelated and are the same bug:
hosting a match dropped straight back to the start menu (the `abort` arrived before there was a
controller to show it), and joining one failed with whatever the socket said as it closed.

So the id travels between the two builds as a file:

```
scripts/build-bundle.ts  ── --define __BUILD_ID__  ──▶ dist/chunk-….js   (the client)
        └── writes dist/build-id.txt
                  └── scripts/wrangler.ts reads it
                        ── --define __BUILD_ID__  ──▶ the Worker          (the referee)
```

`scripts/wrangler.ts` is a prefix, not a command of its own: everything after it is handed to
wrangler untouched, and `cf:dev`/`cf:deploy` both go through it. The file rather than a second
`git rev-parse` because what has to match is *the client in `dist/`*, which a HEAD that moved
between the two steps would no longer describe.

Both halves of a refusal name their machine — `Build mismatch: the match server is running
build a1b2c3d, this page is running build e4f5g6h.` — because the reader is the client being
turned away and the remedy differs: a stale tab reloads, a mis-stamped server redeploys
(`VersionVoices` in `src/version.ts`).

## 3. The `Db` adapter: `workers/DoSqliteDb.ts`

`src/server/db/Db.ts` is an async port:

```ts
transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
```

built around `Bun.SQL`'s genuinely asynchronous wire protocol — a real network round trip for
Postgres, and for SQLite a promise that resolves once Bun's own binding has run the statement.
Every caller (`src/server/db/migrate.ts`'s `apply`, `Rosters.settle`, …) writes a multi-statement
transaction the way that invites: `await tx.exec(a); await tx.exec(b); await tx.query\`…\``.

A Durable Object's SQLite storage, `ctx.storage.sql`, is **synchronous** — `sql.exec()` runs and
returns immediately, no promise involved — and its own explicit-transaction primitive,
`ctx.storage.transactionSync(callback)`, requires that `callback` **not** be `async` and contain
**no** `await` at all. Cloudflare's own documentation is explicit about this: the callback "must
complete synchronously... it should not be declared `async` nor otherwise return a Promise."

Wrapping the synchronous engine in `async` functions to satisfy `Db`'s shape typechecks and is
not, on its own, wrong — `query`/`exec` do exactly this, and are entirely correct: an `async
function` with a synchronous body still runs that body immediately when called, so the actual
SQLite work happens at the same moment it always did. `transaction` is where the shape stops
being enough. The *caller*'s `await tx.exec(a)` yields to the microtask queue before continuing
to `tx.exec(b)`, regardless of how quickly `exec` itself resolved — so calling `fn` from inside
`transactionSync` would have the closure return, and the runtime consider the transaction
committed, after only `fn`'s *first* statement had genuinely run; every statement after `fn`'s
first `await` would execute later, outside the boundary it was meant to be part of.
`ctx.storage.transaction()` (the async variant) does not help either: its `txn` argument exposes
the key-value API (`put`/`get`/`delete`/`list`), not `sql.exec`, because Cloudflare's own
guidance for the SQL case is that a request's natural serialization — one Durable Object
instance processes one request at a time — already makes a sequence of `sql.exec()` calls with
no other I/O in between atomic *against concurrent requests*, without an explicit transaction
wrapper.

`dbOverSqlStorage`'s `transaction` therefore does the honest thing rather than the clever one:
`return fn(self)`, no special wrapping. What this keeps is real — two overlapping callers of
`transaction` never interleave, because nothing about this adapter's work ever actually awaits
genuine I/O, and the object's own input gates serialize requests regardless. What it does **not**
keep is rollback on throw: if `fn` throws after its second statement has already run, that
statement stays written, where the `Bun.SQL` adapter's genuine `sql.begin()` would have rolled
it back. `migrate.ts`'s `apply()` is the one caller this matters for in practice — a migration
that fails partway on this adapter needs a human to notice and fix the row it left behind, the
same way a `down` migration would have needed one to write and run it. This is a real,
documented gap, not a silent one: it is the price of running the same `migrate.ts`/`Rosters.ts`
code unmodified over an engine whose transaction primitive cannot run the code either of those
files is written in.

### 3.1 Splitting the port from the `Bun.SQL` adapter

`src/server/db/Db.ts` used to import `SQL`'s type from `'bun'` for its one `Bun.SQL`-specific
implementation (`openDb`/`wrap`). Doing so pulls in `@types/bun`, which pulls in `@types/node`'s
ambient `NodeJS` namespace — which redeclares `crypto`/`BufferSource` in a way that conflicts
with `@cloudflare/workers-types`' own the moment both are reachable from one TypeScript project.
Wiring the real referee into `workers/` made that true transitively (`Session.ts` →
`Persistence.ts`/`Rosters.ts`/`Accounts.ts` → `Db.ts`), so the Bun-specific half moved to
`src/server/db/BunSqlDb.ts` (`openDb`, and `openPersistence`, which also needed `openDb`),
leaving `Db.ts` itself — the port: `Dialect`, `SqlValue`, the `Db` interface, `dialectOf` — free
of any engine's own import. `GameServer.ts`'s `socketTransport` moved to
`src/server/SocketTransport.ts` for the identical reason: it shared a file with `startGameServer`,
which calls `Bun.serve` directly, and importing `socketTransport` alone still pulled the whole
file's `Bun` reference along with it. Neither split changes behaviour; both only change which
file the same functions are imported from.

## 4. Tooling

- **`bun run cf:dev`** — builds the client and runs `wrangler dev` locally, through
  `scripts/wrangler.ts` (§2.4).
- **`bun run cf:deploy`** — builds the client and runs `wrangler deploy`, through the same
  wrapper, so the referee is stamped with the build id of the `dist/` it ships beside. Deployed
  for real
  (`[ITEM-045]`): `https://tictac-match-server.waldemar-reusch.workers.dev`, on the account's
  default `*.workers.dev` subdomain rather than a custom domain — nothing in this item asked
  for one, and `wrangler deploy` assigns `*.workers.dev` for free the moment a Worker exists.
  `wrangler.jsonc`'s `vars` sets `RELYING_PARTY_ID` to that exact host (a `*.workers.dev`
  subdomain is on the public suffix list, so the relying party id has to be the full host, not
  just `workers.dev`) and `RELYING_PARTY_ORIGINS` to that host's origin plus
  `https://lordvlad.github.io` (an origin, no path). The second origin is what lets the GitHub
  Pages client sign in at all (`[ITEM-068]`): a browser refuses a relying party id that is not
  a registrable suffix of the page's host, unless the id's host lists the page's origin at
  `GET /.well-known/webauthn` — WebAuthn Related Origin Requests. `workers/index.ts` answers
  that path itself, before the Durable Object, with `{"origins": [...]}` built from
  `RELYING_PARTY_ORIGINS` (`src/server/RelatedOrigins.ts`; ARCH-PERSISTENCE §4). Chrome/Edge
  128+ and Safari 18 honour it; Firefox does not yet, so a Firefox player on GitHub Pages still
  cannot sign in, only one on the Worker's own origin. `MatchDurableObject` falls back to
  `LOCAL_RELYING_PARTY` only when these vars are unset, which is correct for local development
  and nothing else. Credentials (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) live in a
  git-ignored `.env`, sourced into the shell before running this command — never committed, and
  not read by anything else in the repo.
- **`bun run typecheck:cf`** (wired into `bun run lint`) — `workers/tsconfig.json` typechecks
  `workers/` in isolation, with `@cloudflare/workers-types` and no DOM lib. It is excluded from
  the root `tsconfig.json`'s `include` for the same reason `src/game`/`src/hud` never import
  `src/server/`: two runtimes' global types (`Request`, `Response`, `WebSocket`, …) conflict if
  declared in one TypeScript project.
- **`.wrangler/`** (local dev state: Durable Object storage, the assets manifest cache) and
  **`worker-configuration.d.ts`** (generated binding types) are both git-ignored, the same way
  `dist/` and `node_modules/` are — regenerated, never committed.

## 5. Testing: `tests/cloudflare.test.ts`

Runs a real local Workers runtime and drives it over real HTTP and WebSocket connections — not a
mock of one. Wrangler ships a newer programmatic API for exactly this, `createTestHarness`
(`import { createTestHarness } from 'wrangler'`), and it was tried first; its `dispatchFetch`
never returned in this project's sandbox, reproduced even with a one-line worker that had no
Durable Object, no assets binding and no dependency on anything in this repository — a
sandbox-specific tooling gap, not a fact about this deployment. The test instead spawns
`wrangler dev` as a child process on a fixed port and talks to it with ordinary `fetch` and
`WebSocket`, which is still wrangler's own local test facility, just reached through the CLI
rather than the library entry point. It builds `dist` itself in `beforeAll` rather than
assuming a prior build step, since CI runs `bun test` before `bun run build`.

It spawns `wrangler dev` **through `scripts/wrangler.ts`**, the same wrapper `cf:deploy` uses,
and then speaks the build id in `dist/build-id.txt` from its clients (`MY_VERSION.build`, put
back in `afterAll`). That pairing is the point. An earlier version of this file ran wrangler
directly and drove it from a test process whose own `BUILD_ID` was the `dev` fallback — which
is exactly what the unstamped Worker reported, so the two agreed and the suite went green
against a deployment no browser could play on (§2.4). Now the Worker carries the commit and so
do the clients, so losing the define fails every test here that enters a room rather than none
of them, and one test asserts the refusal directly: `room/enter` from a page on another build is
a `409` naming both hashes — the server's build is the bundle's — and the socket stays open.

`wrangler dev` spawns a `workerd` child of its own; `afterAll` killing only the process this
test spawned did not reliably reach it, discovered as several orphaned `workerd` processes
accumulating across test runs — one pegged at full CPU — and eventually making every subsequent
`wrangler dev` in the same session time out on its very first request despite printing "Ready".
`afterAll` now also `fuser -k`s the port directly, rather than trying to pattern-match a command
line across an unknown process tree shape.

What it proves, concretely — mirroring `tests/server.test.ts`'s scenarios against the `Bun.serve`
referee: a plain request serves the built client through the Durable Object (not around it);
`/.well-known/webauthn` lists every configured relying-party origin as JSON; a
passkey registered over RPC on one socket signs in another with its token, and that socket reads
the roster (`roster/list`) and its squad near Stuttgart (`squad/get`; `wrangler dev` reports no
location), with nothing over HTTP; a squad sent two metres arrives by the object's own storage
alarm, read back from the stored route; a token nobody issued is a `401` error and
the socket stays open; an anonymous socket is still welcome; and a frame that is not JSON-RPC is
silently dropped rather than crashing the connection or being relayed — the specific
behaviour that distinguishes the current, real referee from this deployment's first-pass bare
relay. Past a single relayed frame, `src/sim/WireMatch.ts` elevates `SimMatch` — already able to
play a whole decisive match deterministically, both sides, in milliseconds — to send that exact
command stream through two real `NetworkManager`s connected to this deployment instead of only
applying it in memory: a `tests/cloudflare.test.ts` scenario drives a full match this way and
confirms the Durable Object's own independent recomputation, over `ctx.storage.sql`, reaches the
same decisive winner — the proof that needed two real browsers before, now had without either.

`ITEM-045` repeated these checks against the real deploy, not only `wrangler dev` — a real
passkey registration and socket (over the HTTP API of the time) against
`https://tictac-match-server.waldemar-reusch.workers.dev`, and a whole decisive match driven
through it anonymously by `src/sim/WireMatch.ts` with no abort (which, at the time, said less
than it looked: see §2.4). What remains open: the match
above is anonymous; a *registered* match, whose roster is checked afterward via `roster/list`,
needs `SimMatch` or its wire harness to deploy a squad sourced from a real
roster's exact rows rather than its own freshly-rolled sheets (`Room.verifyRosters` checks
for an exact match) — not built, and a different piece of work than making the deploy itself
real. See the open acceptance criteria on [`ITEM-045`](../backlog/active-backlog.md).

## 6. Map Tiles: a Low-Zoom Planet From R2

The world map (GDD-WORLD §1) is the real Earth, drawn by MapLibre from vector tiles at
`/tiles/{z}/{x}/{y}.mvt` (`[ITEM-061]`). They are static content: no game state, no account, the
same bytes for everyone.

### 6.1 The archive

One PMTiles archive holds every tile: **the whole planet at zooms 0–8** (countries, regions,
large towns), cut from Protomaps' daily OpenStreetMap build `20261007` — 557,631,269 bytes,
87,381 tiles, gzip-compressed MVT, basemap schema v4. Hosting the planet at every zoom would be
138.7 GB; past z8 MapLibre overzooms the last level, and closer zooms built on demand are
`ITEM-067`.

It is produced and uploaded by **`bun scripts/build-planet-tiles.ts`** (`--build=<date>`,
`--maxzoom=<n>`, `--pmtiles=<path to the go-pmtiles CLI>`):

1. `pmtiles extract https://build.protomaps.com/<date>.pmtiles <out> --maxzoom=<n>` reads the
   planet by range requests, so only the extract itself is downloaded (z0–8: ~13 s).
2. The script checks the result's own header: the whole planet, z0 to the cap.
3. It streams the file to the R2 bucket **`map-tiles`** through R2's S3 API (Bun's `S3Client`,
   16 MB parts, retried per part), with the `R2_S3_API`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`
   credentials from `.env`, and compares the stored size with the file's. `wrangler r2 object
   put` is not used: it does not take objects this large.

The object is **`map-tiles/planet-z8-20261007.pmtiles`** (etag
`cd0825df637d5778e8c3e7ddc1ba6b73-34`, a 34-part upload). The key names what it holds, and the
script refuses to overwrite a different object under it: a new build or cap is a new key, and
switching to it is a change to `MAP_TILES_KEY` in `wrangler.jsonc`, not to code. The bucket
still holds the Stuttgart-only `world.pmtiles` (z0–14 of lon 8.9–9.5, lat 48.55–49.0), which
nothing serves; it stays until `ITEM-067` decides whether its pipeline wants it.

### 6.2 Serving it

`src/server/Tiles.ts` is one handler for both hosts over a PMTiles `Source`:

- **The Worker** binds the bucket as `MAP_TILES` (`wrangler.jsonc`'s `r2_buckets`) and answers
  `/tiles/…` in `workers/index.ts`, **before** `env.MATCH.get(…)`: a map pan fires dozens of
  tile requests, and none of them should wake the Durable Object or queue behind its sockets.
  The handler lives per isolate, so the archive's header and directories are read once and a
  warm tile is one R2 range read. Its cache keeps resolved values, not shared promises, because
  a Worker may not await I/O another request started.
- **The Bun server** reads a local archive through `blobSource(Bun.file(path))`
  (`bun run serve:match --tiles=<archive.pmtiles>`); without `--tiles` it has no tile route.

A tile is sent **as stored**: gzip bytes with `Content-Encoding: gzip`, never inflated and
deflated again (the Worker needs `encodeBody: 'manual'` for that, or it would gzip the gzip).
Every tile response — `200`, or `204` for a tile the archive does not have, including every
tile past z8 — carries `Access-Control-Allow-Origin: *`, because the client on GitHub Pages
reads tiles from the match server's origin; this is the only CORS the deployment has. `OPTIONS`
is answered for any origin; `/tiles/` paths that are not a tile are `404`, and a tile outside
the world (`x` or `y` ≥ 2^z) is `400`.

Tiles are `Cache-Control: public, max-age=604800`. The URL does not name the archive, so a
swapped archive reaches a browser that cached the old one within a week. Cloudflare's Cache API
is not used: it only works on Workers behind a custom domain, and this one is on
`*.workers.dev` (§4); with a custom domain it is the next step for hot tiles.

The R2 `Source` is a port of the reference's (`no-way-home`'s `r2-pmtiles-source.ts`) with
its abort handling fixed — it checked the signal only after fetching and buffering the whole
range. Now an aborted request skips the read and an abort during one cancels the body. It
also reads with the archive's etag as a precondition, so a key overwritten under a warm isolate
is re-read rather than mixed with the old archive's directories.

`wrangler dev` simulates `MAP_TILES` locally and empty, so tiles there are an error until the
bucket is seeded (`wrangler r2 object put map-tiles/<key> --local --file=…`) or the binding is
marked `"remote": true` in a local copy of the config, which reads the real bucket with the
account's credentials.

### 6.3 Glyphs and sprites

The map style (Protomaps' `dark` flavour, from `@protomaps/basemaps`) needs font glyphs and an
icon sprite. The reference loaded both from `protomaps.github.io`; here they are static assets
of the client, so the map contacts no third-party origin at runtime:

- `public/map/fonts/{fontstack}/{range}.pbf` — the four fontstacks the style references: Noto
  Sans Regular, Medium and Italic, and Noto Sans Devanagari Regular v1 (Indian and Nepalese
  place names). 11.5 MB in the repository. Most of the Devanagari stack's 256 ranges are
  symlinks to Noto Sans Regular's; `scripts/copy-public.mjs` copies them as files, so `dist/`
  carries 17.7 MB of glyphs. A browser fetches only the ranges its labels use; CJK ideographs,
  kana and hangul are drawn from local fonts by MapLibre and never fetched. `OFL.txt` is the
  fonts' licence.
- `public/map/sprites/dark{,@2x}.{json,png}` — 52 KB, from `basemaps-assets` `sprites/v4`
  (derived from the MIT-licensed tangrams icons).

A style points at them as `glyphs: <client origin>/map/fonts/{fontstack}/{range}.pbf` and
`sprite: <client origin>/map/sprites/dark` — the client's own origin, whichever host served it,
since static assets carry no CORS — and at the tiles of the match server it is connected to.
Verified with a bare MapLibre page served from a different origin than `wrangler dev`: the whole
planet at z1, Stuttgart at z8.5 and northern India at z6.5 (Devanagari labels) rendered with no
failed request and no origin contacted besides the page's own and the tile server.
