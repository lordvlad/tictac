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
  - "src/server/db/Db.ts"
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
              ├── fetch(): a WebSocket upgrade, or env.ASSETS.fetch(request)
              ├── webSocketMessage(): relay (planted; not the referee — see 2.3)
              └── ctx.storage.sql: where a Db adapter will live (not written yet)
```

A match server is one referee, the same reason `startGameServer` (`src/server/GameServer.ts`)
binds one port to one `Referee` today. Sharding by match would mean the Durable Objects
namespace stops being "the referee" and starts being "a match," which is a bigger, different
design than what is planted here.

### 2.2 The single instance serves both websocket and static assets

`wrangler.jsonc`'s `assets` block sets `run_worker_first: true`, so **every** request reaches
the Worker — and so the Durable Object — rather than the assets layer answering some of them
directly. `MatchDurableObject.fetch` then branches once: a `WebSocket` upgrade is accepted and
held; anything else is handed to `env.ASSETS.fetch(request)`, which is bound through from the
Worker's own `env` (Durable Object constructors receive the same `env` a Worker does). This is a
deliberate design choice for a small deployment with one Worker and one object, not a general
pattern — Cloudflare's own convention is for the assets layer to answer static requests without
ever reaching a Worker, and this deployment opts out of that specifically because the item asked
for one Durable Object that does both.

Sockets are accepted with `ctx.acceptWebSocket`, the hibernatable API, not `server.accept()`:
the runtime may evict the object between messages and wake it again on the next one, which is
the cost model a Durable Object is for. `webSocketMessage`/`webSocketClose`/`webSocketError` are
called on the class exactly as if the object had never gone away, and the constructor rebuilds
its in-memory `sockets` set from `ctx.getWebSockets()` rather than assuming it starts empty.

### 2.3 What it does with a message today: a relay, not a referee

`webSocketMessage` broadcasts the frame it received to every *other* socket this instance holds,
unexamined. This proves the wiring — a socket opens, stays open, and two sockets on the same
instance can reach each other — and nothing more. `Referee` never runs inside it yet.

`GameServer.socketTransport` (`src/server/GameServer.ts`) is already portable enough to fill
this in: it needs nothing beyond an object with `send(data: string)` and `close()`, which a
Cloudflare `WebSocket` already has. `Referee`, `apiHandler` and `Persistence` are plain
TypeScript behind the `Db` port and are equally portable **in principle**. What blocks moving
them in is narrower and specific — §3.

## 3. Why the referee has not moved in: `Db` and `ctx.storage.sql`

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

Wrapping the synchronous engine in `async` functions to satisfy `Db`'s shape would typecheck and
be wrong. An `async function exec()` with a synchronous body still runs that body immediately
when called — but the *caller*'s `await tx.exec(a)` still yields to the microtask queue before
continuing to `tx.exec(b)`, regardless of how quickly `exec` itself resolved. Passed to
`transactionSync`, that means the closure returns (and the runtime considers the transaction
committed) after only the *first* statement has genuinely run inside it; every statement after
the first `await` in a multi-statement transaction would execute later, outside the transaction
boundary it was meant to be part of. `ctx.storage.transaction()` (the async variant) does not
help either: its `txn` argument exposes the key-value API (`put`/`get`/`delete`/`list`), not
`sql.exec`, because Cloudflare's own guidance for the SQL case is that a request's natural
serialization — one Durable Object instance processes one request at a time — already makes a
sequence of `sql.exec()` calls with no other I/O in between atomic *against concurrent requests*,
without an explicit transaction wrapper. What that guidance does not give back is **rollback on
throw**, which `migrate.ts`'s `apply()` genuinely depends on: a DDL statement succeeding and the
`schema_migrations` insert failing must not leave a half-applied schema behind.

Writing a `Db` adapter over `ctx.storage.sql` that is honest about this trade-off — rather than
one that merely satisfies the type checker — is the next piece of work, not this one. Until it
exists, `MatchDurableObject` keeps its bare relay.

## 4. Tooling

- **`bun run cf:dev`** — builds the client and runs `wrangler dev` locally.
- **`bun run cf:deploy`** — builds the client and runs `wrangler deploy`. Requires a Cloudflare
  account and `wrangler login` (or `CLOUDFLARE_API_TOKEN`); nothing here configures one, and no
  deploy has been run against a real account yet.
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
rather than the library entry point. It builds `dist` itself in `beforeAll` rather than assuming
a prior build step, since CI runs `bun test` before `bun run build`.

What it proves, concretely: a plain request serves the built client through the Durable Object
(not around it); two WebSocket clients connected to the one instance relay a frame to each
other; a lone socket with nobody to relay to does not throw. It does not exercise a referee,
persistence, or a real deploy — see §3 and the open acceptance criteria on
[`ITEM-045`](../backlog/active-backlog.md).
