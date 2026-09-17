---
title: "Active Kanban Focus: M4 Competitive & Meta Roster"
id: "PLAN-ACTIVE-FOCUS"
type: "plan"
status: "active"
lastReviewed: "2026-09-16"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/active-backlog.md"
  - "docs/plans/roadmap.md"
tags: ["kanban", "active", "focus", "m4"]
---

# Active Kanban Focus: M4 Competitive & Meta Roster

## Focus & Theme
M1 (headless foundation), M2 (tactical depth) and M3 (reconnaissance & fog) are complete:
the rules run with no renderer, a balance sweep can answer what a change did, and an
opponent's sheet has to be earned rather than read. What is left is the meta layer — roles,
reaction fire and a roster that survives a match.

---

## Kanban Board

### 🔄 In Progress / Next Up
- Nothing in flight.

### 📋 Ready (Pull Queue)
- **`[ITEM-013]`**: Utility proficiencies — but **only the Demolitions third is actually
  ready**. Grenades already carry `areaRadius` and `armorShred` per kind, so a per-thrower
  multiplier has a number to move today. Medical waits on targeted item use (item use is
  self-only) and Mechanics waits on an armour-repair item existing at all, so pulling the
  whole item means building two prerequisites first.
- **`[ITEM-004]`**: In-match progression, now also the home for the GDD's learn-by-doing
  growth. **Measure before building**: the harness reports a median of 3.5 turns per match, so
  count kills per unit per match first and site the XP threshold where it can actually be
  reached — and note the GDD explicitly rejects a menu XP pool, so measure what a unit *does*
  in 3.5 turns before deciding growth can be earned in one match at all. This one widens
  peer-supplied input, so it needs its own sanitiser and regression pins rather than trusting
  `sanitizeSheet`.
- **`[ITEM-010]`**: Roles on the loadout screen. Mostly UI over the existing
  `LOADOUT_LIMITS` machinery.

### 🧊 Backlog (needs its own pass)
- **`[ITEM-014]`**: Morale, stress and predispositions. The unbuilt half of M3. Wants its own
  replicated component and its own stress hooks; the three predispositions are trait-shaped
  but have nothing to modify until the loop exists.
- **`[ITEM-011]`**: Overwatch & reaction fire. The biggest tactical lift available and the
  natural consumer of proficiency against evasion — but it interleaves resolution into the
  *enemy's* move, so `MovementSystem` and the wire protocol are both in scope. Under the
  "sender resolves, receiver replays" contract, every reaction must be authored by the
  reacting unit's owner and applied mid-path.
- **`[ITEM-015]`**: Strength negating heavy-gear penalties. Blocked on a design decision, not
  on effort: the modifier fold is deliberately source-blind, so "negate the gear share only"
  cannot be said to it. Splitting the fold by source changes its central contract and should
  not ride along with an attribute.
- **`[ITEM-016]`**: Intelligence gating advanced item usage. Nothing in `ITEMS` is advanced
  enough to gate; wants `ITEM-013`'s repair kit or a deployable first.
- **`[ITEM-012]`**: Permadeath, lasting wounds and roster persistence. Changes what the
  handshake means: a peer would be sending a *saved* roster, so `sanitizeSheet` becomes
  load-bearing against your own stored data as well as a hostile peer. Wants `ITEM-004`
  first — growth is what there would be to persist. Lasting wounds would be the first
  modifier that outlives a match, unlike `ITEM-005`'s health-derived ones.

### ✅ Completed
- **`[ITEM-001]`**: Narrow ports (`Combatant`, `CombatFx`, focus port for `TurnManager`).
- **`[ITEM-002]`**: Headless simulation runner and balance harness (`scripts/balance.ts`, `src/sim/`).
- **`[ITEM-003]`**: Data units vs view units (`SoldierView`, `SquadViews`, engine-free `Squads`).
- **`[ITEM-005]`**: Wounds derived from current health.
- **`[ITEM-006]`**: Weapon rails and worn kit, each with a real trade.
- **`[ITEM-007]`**: Enemy intel fog.
- **`[ITEM-008]`**: Suppression, via stacking statuses.
- **`[ITEM-009]`**: Exhaustion, and statuses made visible at all.
- **Character sheets rebuilt on four core attributes** (no item id — straight from the revised
  [progression GDD](../design/gdd/progression-and-meta.md)). Health, Agility, Strength and
  Intelligence are rolled; every tactical number is `derive()`d from them. Scoped on purpose
  to stats and derived stats: what the GDD specifies beyond that is filed as `ITEM-013`
  through `ITEM-016` and folded into `ITEM-004` and `ITEM-012`, each with the concrete reason
  it could not land in this pass. Worth noting for anything touching the handshake: a sheet no
  longer *has* a hit-point ceiling to send, so `sanitizeSheet` clamps four ints and the
  envelope is unforgeable by construction.

### 🚫 Struck
- **`[ITEM-003.4]`** — "Remove `installCanvasStub` from `movement`, `camera`, `pathmarker`,
  `shooting`, `debugmap`". **Do not do this.** It was attempted and broke CI (run #87):
  those suites construct canvas-backed textures through `PathMarker` and `ShootPlanner`, so
  they genuinely need the stub, and dropping it only passed locally because another file
  installed it first — an order dependency between test files. The headless win is
  `tests/headless.test.ts`, which builds a squad with no stub at all. Each suite installs
  its own now, and every file passes on its own as well as together.

---

## Definition of Done for M4
1. A squad's composition is a decision with consequences beyond its kit (`ITEM-010`).
2. A unit that survives a match is worth more than one that did not (`ITEM-004`).
3. Holding fire is a tactic (`ITEM-011`).
4. Every rule change is measured with `bun run balance` before and after, and every change
   that should *not* move the rules proves it with an identical report.
