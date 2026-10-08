---
title: "Active Kanban Focus: M5 The Shared World"
id: "PLAN-ACTIVE-FOCUS"
type: "plan"
status: "active"
lastReviewed: "2026-10-08"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/active-backlog.md"
  - "docs/backlog/completed.md"
  - "docs/plans/roadmap.md"
  - "docs/architecture/deployment.md"
tags: ["kanban", "active", "focus", "m5"]
---

# Active Kanban Focus: M5 The Shared World

**What is in flight, what gets pulled next and in what order, and what finished work left
open.** One line per item, no specifications: each item's why, change and acceptance
criteria are in the [active backlog](../backlog/active-backlog.md), and finished items are in
the [archive](../backlog/completed.md).

## Focus & Theme
M1 (headless foundation), M2 (tactical depth), M3 (reconnaissance & morale) and M4 (competitive
meta & campaign) are all complete; fatigue and medical-bay downtime (`[ITEM-039]`) closed M4 on
2026-09-30. `[ITEM-045]` (Cloudflare Durable Object deployment) closed on 2026-10-01 — see the
[archive](../backlog/completed.md). Retreat (`[ITEM-051]`, `[ITEM-052]`) closed on 2026-10-02;
React HUD & menus (`[ITEM-055]`) closed on 2026-10-04.
M5 — The Shared World ([roadmap](roadmap.md)) is under way: a squad that is somewhere on a real
planet map and travels in real time, over one socket per window. `[ITEM-050]` was split into
slices on 2026-10-07. Closed on 2026-10-07: one connection per window (`[ITEM-060]`) and the
z0–8 planet basemap (`[ITEM-061]`). Closed on 2026-10-08: the travel maths (`[ITEM-062]`), the
squads table with its starts (`[ITEM-063]`), orders with the travel scheduler (`[ITEM-064]`), the
map screen (`[ITEM-065]`), the decisions encounters need (`[ITEM-066]`, GDD-WORLD §5.4) and
signing in from the GitHub Pages client (`[ITEM-068]`). **M5's definition of done is met in
production** (build `b677bcc`): a passkey registered on `https://lordvlad.github.io` opens the
map on the deployed Worker.
On 2026-10-09 the map's closer zooms were built (`[ITEM-067]`: tiles to z14 pulled from the planet
the first time they are looked at). The fights met on the road
([GDD-WORLD](../design/gdd/world-and-travel.md) §5) are what comes next, as `[ITEM-048]`.

**How the client reaches its server.** One address, `MATCH_SERVER_URL` in `src/config.ts` (the
Cloudflare Worker); the menu has no address to type. A page served from this machine may add
`?server=ws://…` to use a server of its own (`matchServerFor`); on any other host the parameter is
ignored.

---
## 📋 Ready — pull in this order
1. `[ITEM-048]` Wild alien encounters on the road — the server opens the fight, an AI seat plays
   the aliens and any absent player, a join window for an online one (GDD-WORLD §5.4).

## 🧊 Backlog — not yet queued
- `[ITEM-053]` Player encounters on the road — after `[ITEM-064]` and `[ITEM-048]`; offline
  squads engageable, on trial.
- `[ITEM-046]` Region-sharded Durable Objects — depends on the shared world having load to
  shard.
- `[ITEM-047]` Uncap the roster (bench grows with bases/vehicles, squad cap set per combat) —
  depends on the base/vehicle economy and a scenario/mission system, neither built.
- `[ITEM-054]` Capture and rescue — an idea; the left-behind of a retreat are lost until then.

## ⚠️ Left open by finished work
- **ITEM-068**: Firefox does not support related origins, so a Firefox player cannot sign in from
  the GitHub Pages client — only on the Worker's own origin. Safari and Edge are untested.
- **Production holds test accounts**: `LiveCheck`, `SquadCheck`, `PagesCheck` and `ZoomCheck`, each with a
  roster and a squad. `LiveCheck` is kept on purpose, to exercise the first-ask squad placement
  (`squad/get`) of a player who registered before migration 7 — its session was revoked, so it
  needs a fresh sign-in. The others can go; there is no request to delete an account, so it
  means editing the Durable Object's storage.
- **ITEM-063**: a squad's start near the *reported* location (rather than the Stuttgart fallback)
  has not been seen on production: the machine used was itself in Stuttgart. The draw is covered
  by tests with a place on the socket.
- **ITEM-065**: the map screen has no automated test (the controller and map need a DOM and
  WebGL); it was checked in Chromium, locally and on Pages. The code under it is covered by the
  `Travel`, `Journeys` and `ServerConnection` tests. Safari is untested.
- **ITEM-064 / ITEM-059**: protocol 6's keyed-resume path (`Sessions.resume6`, `resumeOf6`,
  `Upgrade.url`, the gate branch and the protocol-6 branch of `Lobby.replace`; the list is in
  `Session.ts`) is kept for one release so a match in progress finishes across the deploy; delete
  it when `OLDEST_SERVED_PROTOCOL` reaches 7 — it is still 6.
- **ITEM-045 / ITEM-063**: on the Durable Object, `Db.transaction` does not roll back when its
  body throws (`workers/DoSqliteDb.ts`; Cloudflare's synchronous transaction cannot wrap an
  `await`ing body). A migration that fails partway leaves its rows for a human to fix, and so
  could a registration that fails after its player row (player, roster and squad are one
  transaction). Not seen in practice.
- **ITEM-061 / ITEM-067**: the old Stuttgart-only `world.pmtiles` is still in the `map-tiles` R2
  bucket, unserved and now redundant; delete it.
- **ITEM-067**: on-demand tiles depend on `build.protomaps.com` keeping the dated build
  `20261007` (and being willing to be read by range from a Worker; its terms for this were not
  found, only that the builds are free to use). If it is removed, new areas stop being built
  (the map falls back to stretched z8) until `MAP_SOURCE_URL`, the archive and the key prefix
  move to a newer build together. Nothing evicts built tiles: storage is what has been looked at
  (about $2 a month if everything were). The Bun server has no on-demand path (the map stretches
  its z8 archive).
- **ITEM-063**: `squads` is one row per player *for now* (`squads_player`); captives, alien squads
  and a player with several squads widen it, and `[ITEM-048]`/`[ITEM-053]` lean on that.
- **ITEM-066** (decisions, built in `[ITEM-048]`): `Rosters.rest` is unchanged until bases exist
  (`[ITEM-047]`), so travel heals nothing; and an encounter's party is "the first `SQUAD_SIZE`
  fit members by slot" until a travelling party can be chosen — a placeholder rule, with nobody
  fit meaning the encounter is passed by. Also: a 60 s join window and no taking a fight back
  from the AI mid-match are design calls, not forced ones — revisit once they can be played. A
  fight a deploy interrupts is witnessed, not refereed to the end.
- **ITEM-051 / ITEM-052**: a referee settling a *registered* retreat into `roster` through the
  socket is not tested end to end (settlement is tested at the function the referee calls, and
  `Rosters` is unchanged). The live AI opponent stays on `stand`; which order an AI squad fights
  to is `[ITEM-048]`'s to choose. Retreat is available from turn one and a fresh, unseen squad
  gets away 95% of the time — by design (avoiding a fight costs only time), to be revisited if it
  plays as too cheap.
- **ITEM-019**: the sweep's policy neither sneaks nor throws stones, so the balance sweep does
  not measure stealth.
- **ITEM-033**: every predisposition is a net gain. Whether one should cost something is an
  open design question.
- **ITEM-034**: the policy never throws smoke, and throws an incendiary only when it has no
  shot. The sweep barely measures fire and smoke.
- **ITEM-017**: the policy walks through shut doors but never shuts, unlocks or forces one; keys
  open every lock (where a key comes from is a campaign question).
- **ITEM-004**: Strength and Intelligence barely grow in the sweep: the stock plan carries no
  plate, knife or kit, and the policy never uses an item even when a sweep flag hands it one.
  (Growth is no longer lost: `ITEM-012` keeps it.)
- **ITEM-036**: the policy never treats a bleed, and bleeding costs a side only 3–4 HP a match
  in the sweep's short fights; it tilts the mirror ~1.7 points toward Blue and cuts draws.
- **ITEM-012**: a dead character's slot stayed empty until `[ITEM-037]`, which fills it with a
  free server-rolled recruit — no cost and no pool, since no economy exists to price either
  yet.
- **ITEM-024 / ITEM-034**: nobody has played peer-to-peer (broker and data channel) in two live
  browsers since the transport cutover; agreement there is covered by the network, digest and
  rewind tests only. The refereed online path, end screen included, was played in two Chromium
  windows under `[ITEM-060]`.
- **ITEM-040**: a knife shares the punch clip with fists by decision, not by accident — the
  source pack has no thrust. Working a door turns the unit for the eye only (`targetYaw`): the
  rules' `heading`, which decides attacks from behind, is deliberately left where it was, so a
  soldier who opens a door still has the back the rules gave it.
- **ITEM-010**: the balance sweep's policy never picks a role, so it plays every match as
  Rifleman — unrestricted, no trait — and measures none of the three specialisations.

---

## Definition of Done for M5 — met, in production
1. A signed-in player sees their squad on a real planet map near where they registered
   (`ITEM-061`, `ITEM-063`, `ITEM-065`).
2. They send it travelling, close the tab, and find it where the clock says (`ITEM-062`,
   `ITEM-064`, `ITEM-065`).
3. One socket per window carries everything the client says to its match server (`ITEM-060`).
4. All of it works from the GitHub Pages client as well as the Worker's own origin
   (`ITEM-068`): a passkey registered at `lordvlad.github.io`, and its map open, were seen on
   `b677bcc`. Firefox is the exception (below).

## Definition of Done for M4 — met
1. A squad's composition is a decision with consequences beyond its kit (`ITEM-010`).
2. A unit that survives a match is worth more than one that did not (`ITEM-004`, `ITEM-012`,
   `ITEM-038`).
3. ~~Holding fire is a tactic (`ITEM-011`).~~ Done.
4. Every rule change is measured with `bun run balance` before and after, and every change
   that should *not* move the rules proves it with an identical report.

All four held before `[ITEM-039]` too — it was accepted into the milestone's scope after this
list was written (split out of `[ITEM-038]` on 2026-09-26), not because the definition demanded
it, and it is the last thing M4 named.
