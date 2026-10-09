---
title: "Multi-Milestone Capability Roadmap"
id: "PLAN-ROADMAP"
type: "plan"
status: "active"
lastReviewed: "2026-10-07"
appliesTo:
  - "docs/plans/**"
relatedDocs:
  - "docs/backlog/active-backlog.md"
  - "docs/plans/active-focus.md"
  - "docs/architecture/deployment.md"
tags: ["roadmap", "milestones", "capabilities"]
---

# Multi-Milestone Capability Roadmap

Milestones are ordered strictly by architectural dependency:

```mermaid
graph TD
    M1[Milestone 1: Headless Foundation & ECS Split] --> M2[Milestone 2: Tactical Depth]
    M2 --> M3[Milestone 3: Reconnaissance & Morale]
    M3 --> M4[Milestone 4: Competitive Meta & Campaign]
    M4 --> M5[Milestone 5: The Shared World]
```

---

## Milestone Sequence

### Milestone 1: Headless Foundation & ECS Split
**Status:** Complete  
**Focus:** Complete separation of game rules from rendering.
- Done: `[ITEM-001]` narrow ports, `[ITEM-002]` balance harness, `[ITEM-003]` data units vs view
  units, `[ITEM-030]` one engine for sweep and play, `[ITEM-031]` one command applier.
- Canvas stubs stay in the suites that draw textures; removing them was tried and struck (see
  `ITEM-003` in the archive).

---

### Milestone 2: Tactical Depth
**Status:** Complete  
**Focus:** Mechanical stakes during combat.
- Done: `[ITEM-005]` wounds, `[ITEM-006]` weapon rails and worn kit, `[ITEM-013]`/`[ITEM-015]`/
  `[ITEM-016]` attributes at work, `[ITEM-018]` melee, `[ITEM-020]`–`[ITEM-023]` full-knowledge
  lockstep, `[ITEM-032]` projectile hit model, `[ITEM-034]` tile properties, fire and smoke.
- Done last: `[ITEM-017]` doors, locks and keys (2026-09-25).
- After-match progression (`[ITEM-004]`) moved to M4, where its payoff (a roster that keeps it) is.

---

### Milestone 3: Reconnaissance & Morale
**Status:** Complete  
**Focus:** Information asymmetry and battlefield control.
- Done: `[ITEM-007]` intel fog, `[ITEM-008]` suppression, `[ITEM-009]` exhaustion, `[ITEM-029]`
  covered-ground AI, `[ITEM-019]` noise and awareness, `[ITEM-014]` morale, `[ITEM-033]`
  character.

---

### Milestone 4: Competitive Meta & Campaign
**Status:** Complete  
**Focus:** High-level tactics, team composition, and long-term roster persistence.
- Done: `[ITEM-011]` overwatch, `[ITEM-024]` transport port, `[ITEM-025]` referee, `[ITEM-004]`
  after-match progression and the end screen, `[ITEM-012]` roster persistence, `[ITEM-028]`
  schema drift guard, `[ITEM-038]` lasting wounds (HP, healing, combat log), `[ITEM-010]`
  roles, `[ITEM-037]` recruit refill, `[ITEM-041]` short-handed deployment, `[ITEM-043]` one
  deployment record per soldier, `[ITEM-042]` the bench (a roster of six, pick who deploys),
  `[ITEM-044]` a live match sending its own squad's id and fatigue (`Squads.deploymentsOf`
  had dropped both), `[ITEM-039]` fatigue and medical-bay downtime.
- Done last: `[ITEM-039]` (2026-09-30), the last item this milestone named.

---

### Milestone 5: The Shared World
**Status:** Complete  
**Focus:** A squad that is somewhere on the real Earth, and travels there in real time.
- Goal: everything the GDD calls the shared world ([GDD-WORLD](../design/gdd/world-and-travel.md))
  rests on a squad having a position. M5 gives it one, on a real planet map, with travel on the
  wall clock — and first makes one socket per window carry everything the client says to its
  match server, so the map has a push channel.
- Items: `[ITEM-060]` one connection per window (the API over JSON-RPC), `[ITEM-061]` a
  low-zoom planet served from R2, `[ITEM-062]` travel maths in the headless core, `[ITEM-063]`
  a squad's position and start, `[ITEM-064]` orders, pace and the travel scheduler,
  `[ITEM-065]` the map screen, then `[ITEM-066]` the decisions encounters need (a design task;
  unblocks `[ITEM-048]`), and `[ITEM-068]` signing in from the GitHub Pages client (found on the
  way: passkeys are bound to the Worker's domain). Split from `[ITEM-050]` on 2026-10-07.
- Done: `[ITEM-060]` and `[ITEM-061]` (2026-10-07), `[ITEM-062]`–`[ITEM-066]` and `[ITEM-068]`
  (2026-10-08). M5's definition of done is met, in production, from both the Worker's own origin
  and the GitHub Pages client. Unscheduled and built afterwards: `[ITEM-067]` closer zooms on
  demand and `[ITEM-048]` wild alien encounters on the road (both 2026-10-09).
- **Definition of done:** a signed-in player sees their squad on a real planet map near where
  they registered, sends it travelling, closes the tab, and finds it where the clock says; one
  socket per window.
---

### Unscheduled: Infrastructure
Cross-cutting work that is not a milestone deliverable — nothing in the mermaid dependency
chain above depends on it, and no milestone's Definition of Done names it.
- Completed (2026-10-01): `[ITEM-045]` Cloudflare Durable Object deployment — a single DO runs
  the real referee (`Lobby`, `Sessions`, `Persistence`) over its own `Db` adapter, deployed
  for real at `https://tictac-match-server.waldemar-reusch.workers.dev`, alongside the existing
  Bun process as an additional hosting option for a match server. GitHub Pages remains the
  default way the client itself deploys either way. See
  [ARCH-DEPLOYMENT](../architecture/deployment.md) and the [archive](../backlog/completed.md).
- Backlog, not yet startable: `[ITEM-046]` Region-sharded Durable Objects — the plan
  ([RFC-0002](../design/rfc/0002-region-sharded-durable-objects.md)) for replacing `[ITEM-045]`'s
  single instance once the shared world exists and needs more than one Durable Object to hold
  it. Gated on the shared world itself; M5 builds its first piece (a squad's durable position
  and the `ownerOf(squad)` seam), but leaves nothing to shard until there is load.

