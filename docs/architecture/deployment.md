---
title: "Deployment: GitHub Pages and the Planted Cloudflare Durable Object"
id: "ARCH-DEPLOYMENT"
type: "architecture"
status: "active"
lastReviewed: "2026-09-30"
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
  - "src/sim/WireMatch.ts"
relatedDocs:
  - "docs/design/rfc/0001-referee-and-transports.md"
  - "docs/design/rfc/0002-region-sharded-durable-objects.md"
  - "docs/architecture/persistence.md"
  - "docs/architecture/networking.md"
  - "docs/backlog/active-backlog.md"
tags: ["deployment", "cloudflare", "durable-objects", "github-pages", "wrangler"]
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
per match:

```
workers/index.ts (Worker)
  └── env.MATCH.idFromName('singleton')  ── always the same id
        └── workers/MatchDurableObject.ts (the one instance)
              ├── fetch(): a WebSocket upgrade (→ Referee), /api/… (→ apiHandler),
              │            or env.ASSETS.fetch(request)
              └── ctx.storage.sql, behind workers/DoSqliteDb.ts (the Db adapter)
```

A match server is one referee, the same reason `startGameServer` (`src/server/GameServer.ts`)
binds one port to one `Referee` today. Sharding by match would mean the Durable Objects
namespace stops being "the referee" and starts being "a match," which is a bigger, different
design than what is planted here.

This is a deliberate first stage, not a ceiling this deployment is meant to live under forever:
a single Durable Object is one thread, and cannot be scaled up, only replaced.
[RFC-0002](../design/rfc/0002-region-sharded-durable-objects.md) is the plan for what replaces
it — sharding by *region* of the game's shared world rather than by match — once that world
exists and the player base needs more than one instance. Nothing about that plan is built; it
is written down so the single instance here stays easy to retire rather than becoming an
assumption other code quietly depends on.

### 2.2 The single instance serves both websocket and static assets

`wrangler.jsonc`'s `assets` block sets `run_worker_first: true`, so **every** request reaches
the Worker — and so the Durable Object — rather than the assets layer answering some of them
directly. `MatchDurableObject.fetch` branches: a `WebSocket` upgrade is checked for a ticket and
handed to the referee (§2.3); an `/api/…` path is handed to `apiHandler`; anything else is
handed to `env.ASSETS.fetch(request)`, which is bound through from the Worker's own `env`
(Durable Object constructors receive the same `env` a Worker does). This is a deliberate design
choice for a small deployment with one Worker and one object, not a general pattern —
Cloudflare's own convention is for the assets layer to answer static requests without ever
reaching a Worker, and this deployment opts out of that specifically because the item asked for
one Durable Object that does both.

### 2.3 A real referee, not a relay — and why a match socket does not hibernate

`MatchDurableObject` runs the same `Referee`, `Persistence` (via `persistenceOverDb`) and
`apiHandler` that `startGameServer` runs behind `Bun.serve`. Nothing about any of the three was
Bun-specific once handed a `Db` (`workers/DoSqliteDb.ts`, §3) and a transport with `send`/
`close` (`socketTransport`, `src/server/SocketTransport.ts` — split out of `GameServer.ts` for
the same isolation reason as §4's typecheck). A WebSocket upgrade reads its ticket, redeems it
through the same `Accounts.redeemTicket` the Bun-hosted referee uses, and attaches to `Referee`
exactly as `GameServer.ts`'s `websocket.open` handler does.

This class's first pass accepted sockets with `ctx.acceptWebSocket`, the hibernatable API, on
the reasoning that the runtime evicting an idle object between messages is the cost model a
Durable Object is for. That was wrong for *this* socket specifically: `Referee` keeps a match's
open state — `this.clients`, `this.host`, `this.sides` — in memory, with no durable backing, and
hibernation evicts the *whole object*. There is nothing this class could deserialize a live
`MatchHost` back out of on the next message, so a hibernated match's referee would simply forget
it was refereeing anything. Sockets are accepted with plain `server.accept()` instead: as long
as a match socket is open, the runtime keeps this instance resident rather than evicting it, the
ordinary cost of any stateful connection. Once every socket closes, nothing pins the instance
and it can be evicted like any other idle Durable Object — static-asset and `/api/…` traffic
never needed the hibernation exemption, since both are stateless replies against durable
storage answered without ever touching `Referee`'s in-memory state.

### 2.4 The Worker is stamped with the build id of the bundle it serves

The referee is not a bystander to the version gate. Under
[ADR-0004](../design/adr/0004-full-knowledge-lockstep.md) it recomputes every intent itself, so
`src/version.ts` applies to it exactly as it applies to a peer: it states its own build, and
refuses any client whose build differs. That makes "which commit is this Worker?" a
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
Wiring the real `Referee`/`apiHandler` into `workers/` made that true transitively (`Api.ts` →
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
  `wrangler.jsonc`'s `vars` sets `RELYING_PARTY_ID`/`RELYING_PARTY_ORIGINS` to that exact host
  (a `*.workers.dev` subdomain is on the public suffix list, so the relying party id has to be
  the full host, not just `workers.dev`); `MatchDurableObject` falls back to
  `LOCAL_RELYING_PARTY` only when they are unset, which is correct for local development and
  nothing else. Credentials (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) live in a
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
do the clients, so losing the define fails every socket test here rather than none of them,
and one test asserts the refusal text directly: the server's build is the bundle's, and both
hashes are named.

`wrangler dev` spawns a `workerd` child of its own; `afterAll` killing only the process this
test spawned did not reliably reach it, discovered as several orphaned `workerd` processes
accumulating across test runs — one pegged at full CPU — and eventually making every subsequent
`wrangler dev` in the same session time out on its very first request despite printing "Ready".
`afterAll` now also `fuser -k`s the port directly, rather than trying to pattern-match a command
line across an unknown process tree shape.

What it proves, concretely — mirroring `tests/server.test.ts`'s scenarios against the `Bun.serve`
referee: a plain request serves the built client through the Durable Object (not around it); a
signed-in player trades a session for a socket; a socket with an unissued ticket is turned away
with the same 401 and message; an anonymous socket is still welcome; and a frame that is not
JSON-RPC is silently dropped rather than crashing the connection or being relayed — the specific
behaviour that distinguishes the current, real referee from this deployment's first-pass bare
relay. Past a single relayed frame, `src/sim/WireMatch.ts` elevates `SimMatch` — already able to
play a whole decisive match deterministically, both sides, in milliseconds — to send that exact
command stream through two real `NetworkManager`s connected to this deployment instead of only
applying it in memory: a `tests/cloudflare.test.ts` scenario drives a full match this way and
confirms the Durable Object's own independent recomputation, over `ctx.storage.sql`, reaches the
same decisive winner — the proof that needed two real browsers before, now had without either.

All of the above was repeated against the real deploy, not only `wrangler dev` — a real passkey
registration, ticket and socket against
`https://tictac-match-server.waldemar-reusch.workers.dev`, and a whole decisive match driven
through it anonymously by `src/sim/WireMatch.ts` with no abort (which, at the time, said less
than it looked: see §2.4). What remains open: the match
above is anonymous; a *registered* match, whose roster is checked afterward via `GET
/api/roster`, needs `SimMatch` or its wire harness to deploy a squad sourced from a real
roster's exact rows rather than its own freshly-rolled sheets (`Referee.verifyRosters` checks
for an exact match) — not built, and a different piece of work than making the deploy itself
real. See the open acceptance criteria on [`ITEM-045`](../backlog/active-backlog.md).
