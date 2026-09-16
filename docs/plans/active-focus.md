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
- **`[ITEM-004]`**: In-match progression & promotion draft. **Measure before building**: the
  harness reports a median of 3.5 turns per match, so count kills per unit per match first
  and site the XP threshold where it can actually be reached. This one widens peer-supplied
  input, so it needs its own sanitiser and regression pins rather than trusting
  `sanitizeSheet`.
- **`[ITEM-010]`**: Roles on the loadout screen. Mostly UI over the existing
  `LOADOUT_LIMITS` machinery.

### 🧊 Backlog (needs its own pass)
- **`[ITEM-011]`**: Overwatch & reaction fire. The biggest tactical lift available and the
  natural consumer of proficiency against evasion — but it interleaves resolution into the
  *enemy's* move, so `MovementSystem` and the wire protocol are both in scope. Under the
  "sender resolves, receiver replays" contract, every reaction must be authored by the
  reacting unit's owner and applied mid-path.
- **`[ITEM-012]`**: Campaign roster persistence. Changes what the handshake means: a peer
  would be sending a *saved* roster, so `sanitizeSheet` becomes load-bearing against your
  own stored data as well as a hostile peer. Wants `ITEM-004` first — XP is what there would
  be to persist.

### ✅ Completed
- **`[ITEM-001]`**: Narrow ports (`Combatant`, `CombatFx`, focus port for `TurnManager`).
- **`[ITEM-002]`**: Headless simulation runner and balance harness (`scripts/balance.ts`, `src/sim/`).
- **`[ITEM-003]`**: Data units vs view units (`SoldierView`, `SquadViews`, engine-free `Squads`).
- **`[ITEM-005]`**: Wounds derived from current health.
- **`[ITEM-006]`**: Weapon rails and worn kit, each with a real trade.
- **`[ITEM-007]`**: Enemy intel fog.
- **`[ITEM-008]`**: Suppression, via stacking statuses.
- **`[ITEM-009]`**: Exhaustion, and statuses made visible at all.

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
