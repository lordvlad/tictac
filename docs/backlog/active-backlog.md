---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
lastReviewed: "2026-09-30"
appliesTo:
  - "src/**"
  - "workers/**"
  - "wrangler.jsonc"
relatedDocs:
  - "docs/backlog/README.md"
  - "docs/backlog/completed.md"
  - "docs/plans/active-focus.md"
  - "docs/plans/roadmap.md"
  - "docs/architecture/deployment.md"
  - "docs/design/rfc/0002-region-sharded-durable-objects.md"
tags: ["backlog", "tasks", "active"]
---

# Active Backlog

**The specification of every open item** — why it is wanted, what changes, and how we will know
it is done. It is not ordered and says nothing about what happens next: that is the
[focus board](../plans/active-focus.md). Finished and rejected items move to the
[archive](./completed.md).

---

### [ITEM-045] Cloudflare Durable Object Deployment
**Type:** Infrastructure  
**Priority:** P3  
**Status:** In Progress — the referee runs for real and a whole match settles through it; a real `wrangler deploy` has not happened  
**Milestone:** Unscheduled — infrastructure, not a milestone deliverable  

#### Why
[RFC-0001 §7](../design/rfc/0001-referee-and-transports.md#7-deployment) named two hosting
options for a public referee and built neither: "a Durable Object per match, or one central
Postgres." A referee on a developer's own machine (`bun run serve:match`) is fine for
development but is not a *deployment* — nobody else's browser can reach it, and there is
nothing running when the developer's machine is off. This starts that work.

**GitHub Pages stays the default deployment path.** `.github/workflows/deploy.yml` still builds
and deploys the static client on every push to `main`, untouched by anything here. This item is
an *additional*, optional path for hosting a match server — the referee, not the game — and
does not replace or compete with it.

#### Change
1. **One Durable Object, not one per match.** `workers/MatchDurableObject.ts`, addressed by
   `env.MATCH.idFromName('singleton')` from `workers/index.ts` — a match server is one referee,
   the same reason `startGameServer` binds one port to one `Referee` today. A DO per match was
   the RFC's other phrasing of the idea; this deployment does not shard by match.
2. **The one DO serves both** a WebSocket upgrade and every other request (static assets, via
   `env.ASSETS.fetch(request)`, and `/api/…` via `apiHandler`), because that is what was asked
   for. `run_worker_first: true` in `wrangler.jsonc` makes sure every request reaches the
   Worker — and so the DO — rather than the assets layer answering some of them directly.
3. **A `Db` adapter over `ctx.storage.sql`** (`workers/DoSqliteDb.ts`). `Db.transaction<T>(fn:
   (tx: Db) => Promise<T>)` is async, built around `Bun.SQL`'s genuinely asynchronous wire
   protocol; `ctx.storage.sql` is synchronous, and its transaction primitive,
   `transactionSync`, requires a callback that is not `async` and contains no `await` at
   all — which `Db.transaction`'s callers (`migrate.ts`, `Rosters.settle`, …) are not. There is
   no way to satisfy both. This adapter keeps what a Durable Object's own request serialization
   (its input gates) already gives for free — two overlapping callers of `transaction` never
   interleave — and is honest about what it does not add on top: rollback on throw, the way the
   `Bun.SQL` adapter's genuine `sql.begin()` does. `migrate.ts`'s `apply()` is the one caller
   this matters for in practice; see `docs/architecture/deployment.md` §3 for the full
   reasoning and `Db.ts`'s own updated note.
4. **The real `Referee`, not a relay.** `MatchDurableObject` now runs the same `Referee`,
   `Persistence` (via a new `persistenceOverDb`, split out of `openPersistence`) and
   `apiHandler` that `startGameServer` runs behind `Bun.serve` — nothing about any of the three
   was Bun-specific once handed a `Db` and a transport. **A match socket does not hibernate**:
   `Referee` keeps a match's open state in memory with no durable backing, and hibernation
   evicts the whole object, so sockets are accepted with plain `server.accept()` rather than
   `ctx.acceptWebSocket()` — a deliberate reversal of this item's first pass, which hibernated
   every socket including a match's. The trade-off: an instance with an open match socket stays
   resident (the ordinary cost of any stateful connection) rather than being evicted between
   messages; static-asset and `/api/…` traffic never needed the exemption, since both are
   stateless replies against durable storage.
5. **Two files split for the sake of the isolated typecheck** (6, below): `src/server/db/Db.ts`
   used to import `SQL`'s type from `bun` for its one `Bun.SQL`-specific implementation, and
   `GameServer.ts` defined `socketTransport` beside `startGameServer`'s `Bun.serve` call.
   Importing `bun`'s types pulls in `@types/node`'s ambient `NodeJS` namespace, which conflicts
   with `@cloudflare/workers-types`' own the moment both are reachable from one TypeScript
   project — which wiring the real `Referee`/`apiHandler` into `workers/` now makes true
   transitively. `db/BunSqlDb.ts` (`openDb`, `openPersistence`) and `SocketTransport.ts`
   (`socketTransport`) are the `Bun`-specific halves, split out so `Db.ts` and the part of
   `GameServer.ts` that stays are free of them.
6. **Isolated typecheck**, `workers/tsconfig.json` (`@cloudflare/workers-types`, no DOM lib),
   excluded from the root `tsconfig.json`'s `include` and checked separately
   (`bun run typecheck:cf`, wired into `bun run lint`) — the same reasoning `src/game`/
   `src/hud` never importing `src/server/` already follows: two runtimes' global types
   (`Request`, `Response`, `WebSocket`, …) conflict if declared in one project.
7. **e2e test** (`tests/cloudflare.test.ts`) against a real local Workers runtime, mirroring
   `tests/server.test.ts`'s scenarios against the `Bun.serve` referee: a signed-in player trades
   a session for a socket, an unissued ticket is turned away, an anonymous socket is still
   welcome, and a non-JSON-RPC frame is dropped rather than crashing the connection (the
   `[ITEM-045]`-specific proof that the earlier relay is gone). Wrangler's newer programmatic
   harness, `createTestHarness`, was tried first and abandoned: its `dispatchFetch` never
   returns in this sandbox, even for a one-line worker with no Durable Object at all — a
   sandbox-specific tooling gap, not anything about this deployment. Spawning `wrangler dev`
   (via `bunx`, not a direct binary path — the latter reproducibly hung requests in this sandbox
   for reasons not fully understood) and talking to it over real HTTP/WebSocket sidesteps it,
   and is still wrangler's own local test facility, just the CLI rather than the library entry
   point. `afterAll` also `fuser -k`s the port: `wrangler dev` spawns a `workerd` child of its
   own that killing the spawned process alone does not reliably reach, discovered as several
   orphaned `workerd` processes accumulating across test runs and eventually starving the
   machine mid-session.
8. **A whole match, live, not a handful of moves.** `src/sim/WireMatch.ts` elevates `SimMatch` —
   already able to play a decisive match deterministically in milliseconds, both sides, headless
   — to optionally send that same command stream through two real `NetworkManager`s connected to
   a referee, instead of only applying it in memory. It is the reusable answer to "prove a whole
   match reaches settlement" without scripting one by hand or driving two browsers:
   `tests/refereed.test.ts` uses it against the in-process `Bun.serve` referee (and checks the
   referee's digest and stored log agree with the local sim bit for bit);
   `tests/cloudflare.test.ts` uses the identical function against the real `MatchDurableObject`
   through `wrangler dev`, proving its independent recomputation over `ctx.storage.sql` reaches
   the same decisive winner. One subtlety it exists to get right: two independent sockets give
   no ordering guarantee against each other the way one connection gives against itself, so
   commands are sent one at a time, each awaited until the other side's socket has received the
   referee's relay of it — over real network latency (`wrangler dev`, unlike in-process
   `Bun.serve`) firing them all at once raced the referee's own client registration and hung.

#### Affected Files
- `wrangler.jsonc`, `workers/index.ts`, `workers/MatchDurableObject.ts`, `workers/DoSqliteDb.ts`,
  `workers/tsconfig.json`
- `src/server/db/Db.ts` (reduced to the port), `src/server/db/BunSqlDb.ts` (new, the `Bun.SQL`
  adapter split out), `src/server/SocketTransport.ts` (new, split out of `GameServer.ts`),
  `src/server/Persistence.ts` (`persistenceOverDb` split out of `openPersistence`)
- `src/sim/WireMatch.ts` (new — a real referee, over the wire, driven by `SimMatch`'s own policy)
- `src/core/rng.ts`/`src/main.ts` (`resolveSeed` moved to `main.ts` — an unrelated fix this
  item's typecheck isolation surfaced: `rng.ts`'s only use of `window` was in a function `Db.ts`
  never needed, but every file `workers/` reaches gets typechecked under its own lib, and
  `window` does not exist there)
- `package.json` (`typecheck:cf`, `lint:code`, `cf:dev`, `cf:deploy`), `.gitignore` (`.wrangler`)
- `tests/cloudflare.test.ts`, `tests/refereed.test.ts` (both gained a whole-match-to-settlement
  test via `src/sim/WireMatch.ts`, new), `tests/determinism.test.ts` (updated for `resolveSeed`'s
  move), and the handful of files that imported `openDb`/`openPersistence` from `db/Db.ts`/
  `Persistence.ts` directly (now `db/BunSqlDb.ts`) — no behaviour change, only which file the
  same functions are imported from
- `docs/architecture/deployment.md`, `docs/design/rfc/0001-referee-and-transports.md` §7

#### Acceptance Criteria
- [x] `bun run cf:dev` serves the built client and accepts a WebSocket connection, through one
      Durable Object.
- [x] `workers/` typechecks in isolation (`bun run typecheck:cf`) without pulling DOM types into
      the main `tsconfig.json`, and without the main `tsconfig.json` pulling in
      `@cloudflare/workers-types`.
- [x] `tests/cloudflare.test.ts` runs a real local Workers runtime and passes in `bun test`,
      self-contained (builds `dist` itself rather than assuming a prior build step).
- [x] `.github/workflows/deploy.yml` (GitHub Pages) is untouched and remains the default
      deployment path.
- [x] A `Db` adapter over `ctx.storage.sql` (`workers/DoSqliteDb.ts`) — correct for `query`/
      `exec`, and for `transaction` in every case that does not throw partway through; does not
      roll back a partial failure the way the `Bun.SQL` adapter's `sql.begin()` does, stated
      plainly rather than pretended otherwise (see the deployment doc §3).
- [x] `Referee`/`Persistence`/`apiHandler` wired into `MatchDurableObject`, replacing the bare
      relay: migrations run against `ctx.storage.sql` on first boot, a passkey ceremony and a
      roster fetch work over real HTTP, and a signed-in socket, an anonymous one, and one with
      an invalid ticket are each treated the same way the `Bun.serve` referee treats them
      (`tests/cloudflare.test.ts`, mirroring `tests/server.test.ts`).
- [ ] A real `wrangler deploy` against an actual Cloudflare account, with a chosen domain and
      passkey relying-party configuration to match (`RelyingParty.origins` via
      `RELYING_PARTY_ID`/`RELYING_PARTY_ORIGINS`, already read by `MatchDurableObject` but unset
      by anything real).
- [x] A whole decisive match reaches settlement through this deployment end to end — via
      `src/sim/WireMatch.ts` rather than two real browsers (see Change point 8 below). What
      remains open, deliberately narrower than the earlier phrasing: this drives the match
      anonymously and checks the referee's own recomputation agreed all the way to a winner
      (`tests/cloudflare.test.ts`), not a *registered* match whose roster is checked afterward
      against a real `wrangler deploy` — that still wants the deploy above, and real accounts
      recruited on it.

---

### [ITEM-046] Region-Sharded Durable Objects
**Type:** Infrastructure
**Priority:** P3
**Status:** Backlog — a design only ([RFC-0002](../design/rfc/0002-region-sharded-durable-objects.md)); not started, and not startable yet (see Why)
**Milestone:** Unscheduled — gated on the shared world existing, which is not a milestone deliverable today

#### Why
`[ITEM-045]`'s single Durable Object is correct for the game that exists today and wrong for
the one the [GDD](../design/gdd/overview.md) describes: a persistent shared world with base
building, an economy and regional chat, where players are present continuously rather than for
the few minutes one match takes. A single Durable Object instance is one thread and cannot be
scaled up, only replaced, so that replacement is worth planning before load forces it.
RFC-0002 is that plan: shard by region of the shared world, not by match, with a region
splitting into two Durable Objects under load and players handed off between them as they
cross a boundary or as a split moves the boundary through them.

**This item cannot be started today.** It depends on the shared world itself — regions, a
coordinate space bigger than one battlefield, a reason a character keeps existing somewhere
between matches — none of which the current game has. It is filed now, at Backlog rather than
Ready, so the dependency is visible rather than the plan being reinvented later under pressure.

#### Change
See [RFC-0002](../design/rfc/0002-region-sharded-durable-objects.md) in full; summarised:
1. A region id replaces `workers/index.ts`'s fixed `env.MATCH.idFromName('singleton')`; a
   Workers KV directory maps region id to the Durable Object that currently owns it
   (RFC-0002 §6.3 — decided in favour of KV's eventual consistency over a directory Durable
   Object's extra hop on every request).
2. The shared world starts as one whole zone — exactly `[ITEM-045]`'s single instance, already —
   and fractures into more zones over time as load grows, woven into the game's own meta-story
   rather than shipped as invisible level geometry (RFC-0002 §2, §7). Crossing a zone boundary is
   a deliberate, designed act (a gate, a checkpoint), not a coordinate that can drift across an
   invisible line — which is also what rules out a player oscillating near a border and being
   handed off repeatedly (RFC-0002 §6.2).
3. The Durable Object currently holding a player is responsible for handing them off to the
   destination the moment a crossing happens (RFC-0002 §4) — not a directory, and not the
   destination reaching in to pull them over.
4. What transfers at a hand-off is presence — the open socket, faction/side, position, whatever
   the region simulation held about the player in memory — not the roster. `Persistence`
   (accounts, rosters, the match log) stays one logical store every region-owning instance can
   reach, per RFC-0001 §8.4's "one database, behind a portable port"; splitting *that* by region
   is explicitly rejected in RFC-0002 §4.
5. A zone facing too much load — measured by CPU time and by client latency read against what a
   player's real-world physical distance would predict, thresholds still to be tuned against
   real traffic (RFC-0002 §6.1) — spins up a second Durable Object owning a piece freshly cut
   from it, and moves players already there to whichever side now owns their location, preferably
   while they are offline rather than disrupting a connected session.
6. A match never spans two Durable Objects (RFC-0002 §4, §6.4); keeping combat from starting
   exactly on a zone boundary is left to world/narrative design, not engineering.

#### Affected Files
- `workers/index.ts` (routing, once there is a directory to route through)
- A new Workers KV namespace for the region directory (RFC-0002 §6.3)
- Whatever the shared world's own persistent-presence/position system turns out to be, once it
  exists — not yet a file in this repository

#### Acceptance Criteria
- [ ] The shared world exists as at least one zone with persistent player presence — tracked by
      whatever items eventually build it, not this one.
- [ ] A player's socket routes to the Durable Object currently owning their zone, through the
      Workers KV directory.
- [ ] Crossing a zone boundary (a deliberate, designed act, not continuous position tracking)
      hands a live session off without the player having to reconnect, verified by an automated
      test that plays a session across a scripted boundary.
- [ ] A zone under simulated load splits into two Durable Objects and players are moved to the
      half owning their location, preferably while offline, without disrupting a connected
      session or dropping every connection in the zone at once.
- [ ] `Persistence` remains reachable by every region-owning instance without being partitioned
      by region (RFC-0002 §4) — or, if that changes, the change is a deliberate edit to this
      item and RFC-0002, not a quiet divergence.
