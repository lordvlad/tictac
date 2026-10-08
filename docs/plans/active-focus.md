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
slices on 2026-10-07; one connection per window (`[ITEM-060]`) and the z0–8 planet basemap
(`[ITEM-061]`) closed on 2026-10-07, the travel maths (`[ITEM-062]`) and the squads table with its starts (`[ITEM-063]`) and
orders with the travel scheduler (`[ITEM-064]`) and the map screen (`[ITEM-065]`) on
2026-10-08. The fights
met on the road
([GDD-WORLD](../design/gdd/world-and-travel.md)) come after it.

---
## 📋 Ready — pull in this order
1. `[ITEM-048]` Wild alien encounters on the road — the server opens the fight, an AI seat plays
   the aliens and any absent player, a join window for an online one (GDD-WORLD §5.4).

## 🧊 Backlog — not yet queued
- `[ITEM-053]` Player encounters on the road — after `[ITEM-064]` and `[ITEM-048]`; offline
  squads engageable, on trial.
- `[ITEM-067]` Closer zooms on demand — deferred: high-zoom tiles built the first time an area
  is looked at.
- `[ITEM-046]` Region-sharded Durable Objects — depends on the shared world having load to
  shard.
- `[ITEM-047]` Uncap the roster (bench grows with bases/vehicles, squad cap set per combat) —
  depends on the base/vehicle economy and a scenario/mission system, neither built.
- `[ITEM-054]` Capture and rescue — an idea; the left-behind of a retreat are lost until then.

## ⚠️ Left open by finished work
- **ITEM-065**: nobody can sign in from the GitHub Pages client, so the map opens only on the
  Worker's own origin: passkeys are bound to `workers.dev`, and WebAuthn refuses them to a
  `github.io` page. WebAuthn's related origins (`/.well-known/webauthn` on the Worker listing the
  Pages origin) would lift that in browsers that support it.
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
- **ITEM-004**: Strength and Intelligence barely grow in the sweep because the policy carries no
  plate, swings no knife and uses no kit. (Growth is no longer lost: `ITEM-012` keeps it.)
- **ITEM-036**: the policy never treats a bleed, and bleeding costs a side only 3–4 HP a match
  in the sweep's short fights; it tilts the mirror ~1.7 points toward Blue and cuts draws.
- **ITEM-012**: a dead character's slot stayed empty until `[ITEM-037]`, which fills it with a
  free server-rolled recruit — no cost and no pool, since no economy exists to price either
  yet. Durable Objects would still need one more `Db` adapter; none is written.
- **ITEM-038**: a bug caught in its own testing — `derive(sheet).maxHp` ignores a character's
  own maxHp trait (Juggernaut's +25); fixed with `maxHpOf`, which every roster ceiling now uses
  instead. Fatigue and medical-bay downtime split to `[ITEM-039]`, which shipped on 2026-09-30.
- **ITEM-004 / ITEM-014 / ITEM-017 / ITEM-024 / ITEM-034**: nobody has played peer-to-peer in two
  live browsers since the transport cutover (the online end screen included). Agreement is
  covered by the network, digest and rewind tests only.
- **ITEM-040**: a knife shares the punch clip with fists by decision, not by accident — the
  source pack has no thrust. Working a door turns the unit for the eye only (`targetYaw`): the
  rules' `heading`, which decides attacks from behind, is deliberately left where it was, so a
  soldier who opens a door still has the back the rules gave it.
- **ITEM-010**: the balance sweep's policy never picks a role, so it plays every match as
  Rifleman — unrestricted, no trait — and measures none of the three specialisations.

---

## Definition of Done for M5 — met (on the Worker's origin; see ITEM-065 above for Pages)
1. A signed-in player sees their squad on a real planet map near where they registered
   (`ITEM-061`, `ITEM-063`, `ITEM-065`).
2. They send it travelling, close the tab, and find it where the clock says (`ITEM-062`,
   `ITEM-064`, `ITEM-065`).
3. One socket per window carries everything the client says to its match server (`ITEM-060`).

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
