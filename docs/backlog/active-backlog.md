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
**Status:** In Progress — a single DO is planted (assets, a socket, a relay); the referee has not moved in  
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
   `env.ASSETS.fetch(request)`), because that is what was asked for. `run_worker_first: true`
   in `wrangler.jsonc` makes sure every request reaches the Worker — and so the DO — rather than
   the assets layer answering some of them directly.
3. **Hibernatable sockets** (`ctx.acceptWebSocket`), not `server.accept()`: the runtime may
   evict the object between messages, which is the cost model a Durable Object is for for.
4. **What it does with a message today is a bare relay** — broadcast to every other socket this
   instance holds, unexamined — not the referee. `wrangler`'s dev/deploy tooling installed and
   working is the deliverable of *this* pass; the referee moving in is the next one, blocked on
   5.
5. **Not done: a `Db` adapter over `ctx.storage.sql`.** `Db.transaction<T>(fn: (tx: Db) =>
   Promise<T>)` is async, built around `Bun.SQL`'s genuinely asynchronous wire protocol.
   `ctx.storage.sql` is synchronous, and its transaction primitive, `transactionSync`, requires
   a callback that is not `async` and contains no `await` — which `Db.transaction`'s callers
   (`migrate.ts`, `Rosters.settle`, …) are not. Wrapping the sync engine in `async` functions to
   satisfy `Db`'s shape would typecheck and silently misbehave: everything after the first
   `await` inside a multi-statement transaction would run *after* `transactionSync`'s callback
   had already returned, outside the transaction it was meant to be in. `Referee`,
   `GameServer.socketTransport` and `apiHandler` are otherwise portable as they stand —
   `socketTransport` needs nothing beyond `send`/`close`, which a Cloudflare `WebSocket`
   already has — so this one adapter is the entire remaining gap between the relay planted here
   and a real refereed match running inside it.
6. **Isolated typecheck**, `workers/tsconfig.json` (`@cloudflare/workers-types`, no DOM lib),
   excluded from the root `tsconfig.json`'s `include` and checked separately
   (`bun run typecheck:cf`, wired into `bun run lint`) — the same reasoning `src/game`/
   `src/hud` never importing `src/server/` already follows: two runtimes' global types
   (`Request`, `Response`, `WebSocket`, …) conflict if declared in one project.
7. **e2e test** (`tests/cloudflare.test.ts`) against a real local Workers runtime. Wrangler's
   newer programmatic harness, `createTestHarness`, was tried first and abandoned: its
   `dispatchFetch` never returns in this sandbox, even for a one-line worker with no Durable
   Object at all — a sandbox-specific tooling gap, not anything about this deployment. Spawning
   `wrangler dev` directly and talking to it over real HTTP/WebSocket sidesteps it, and is
   still wrangler's own local test facility, just the CLI rather than the library entry point.

#### Affected Files
- `wrangler.jsonc`, `workers/index.ts`, `workers/MatchDurableObject.ts`, `workers/tsconfig.json`
- `package.json` (`typecheck:cf`, `lint:code`, `cf:dev`, `cf:deploy`), `.gitignore` (`.wrangler`)
- `tests/cloudflare.test.ts`
- `docs/architecture/deployment.md` (new), `docs/design/rfc/0001-referee-and-transports.md` §7

#### Acceptance Criteria
- [x] `bun run cf:dev` serves the built client and accepts a WebSocket connection, through one
      Durable Object.
- [x] Two WebSocket clients connected to that one instance can relay a frame to each other.
- [x] `workers/` typechecks in isolation (`bun run typecheck:cf`) without pulling DOM types into
      the main `tsconfig.json`, and without the main `tsconfig.json` pulling in
      `@cloudflare/workers-types`.
- [x] `tests/cloudflare.test.ts` runs a real local Workers runtime and passes in `bun test`,
      self-contained (builds `dist` itself rather than assuming a prior build step).
- [x] `.github/workflows/deploy.yml` (GitHub Pages) is untouched and remains the default
      deployment path.
- [ ] A `Db` adapter over `ctx.storage.sql` that honours `Db.transaction`'s async contract
      correctly (not merely typechecks against it).
- [ ] `Referee`/`GameServer`'s `socketTransport` wired into `MatchDurableObject`, replacing the
      bare relay, once the adapter above exists.
- [ ] A real `wrangler deploy` against an actual Cloudflare account, with a chosen domain and
      passkey relying-party configuration to match (`RelyingParty.origins`).
