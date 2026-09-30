---
title: "Deployment: GitHub Pages and the Planted Cloudflare Durable Object"
id: "ARCH-DEPLOYMENT"
type: "architecture"
status: "active"
lastReviewed: "2026-09-30"
appliesTo:
  - ".github/workflows/deploy.yml"
  - "wrangler.jsonc"
  - "workers/**"
  - "src/server/GameServer.ts"
  - "src/server/SocketTransport.ts"
  - "src/server/db/Db.ts"
  - "src/server/db/BunSqlDb.ts"
  - "src/server/Persistence.ts"
relatedDocs:
  - "docs/design/rfc/0001-referee-and-transports.md"
  - "docs/architecture/persistence.md"
  - "docs/architecture/networking.md"
  - "docs/backlog/active-backlog.md"
tags: ["deployment", "cloudflare", "durable-objects", "github-pages", "wrangler"]
---

# Deployment: GitHub Pages and the Planted Cloudflare Durable Object

There are two deployment paths in this repository, and they answer two different questions.
**Where does the game live** is answered by GitHub Pages, unconditionally, on every push. **Where
does a match server live**, if anyone wants one, is still open — `bun run serve:match` on a
developer's own machine is the only answer that exists today, and it is not reachable by anyone
else's browser. This document covers both, and the second one only as far as it has been
planted (`[ITEM-045]`).

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

- **`bun run cf:dev`** — builds the client and runs `wrangler dev` locally.
- **`bun run cf:deploy`** — builds the client and runs `wrangler deploy`. Requires a Cloudflare
  account and `wrangler login` (or `CLOUDFLARE_API_TOKEN`); nothing here configures one, and no
  deploy has been run against a real account yet. A real deploy also needs
  `RELYING_PARTY_ID`/`RELYING_PARTY_ORIGINS` set (`wrangler.jsonc`'s `vars`, or `wrangler
  secret`) to whatever domain is chosen — `MatchDurableObject` reads them, falling back to
  `LOCAL_RELYING_PARTY` when unset, which is only correct for local development.
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
`wrangler dev` (via `bunx`) as a child process on a fixed port and talks to it with ordinary
`fetch` and `WebSocket`, which is still wrangler's own local test facility, just reached through
the CLI rather than the library entry point. It builds `dist` itself in `beforeAll` rather than
assuming a prior build step, since CI runs `bun test` before `bun run build`.

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
relay. It does not yet drive a whole match to settlement through this deployment, or exercise a
real `wrangler deploy` — see the open acceptance criteria on
[`ITEM-045`](../backlog/active-backlog.md).
