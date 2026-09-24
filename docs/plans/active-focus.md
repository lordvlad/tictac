---
title: "Active Kanban Focus: M4 Competitive & Meta Roster"
id: "PLAN-ACTIVE-FOCUS"
type: "plan"
status: "active"
lastReviewed: "2026-09-24"
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
- Open from ITEM-019: the sweep's policy neither sneaks nor throws stones (only ~3% of its
  attacks land on a target not yet in the fight), so stealth is a player's tool the balance
  sweep does not measure.

### 📋 Ready (Pull Queue)
- **`[ITEM-033]`**: Character — who runs and who charges. Split from ITEM-014: the sheet
  decides panic or frenzy, and Daredevil, Teamplayer and Loner bend how morale moves.
- **`[ITEM-012]`**: Persistence as the foundation, not a save file — a store of record for
  rosters *and* matches as event logs. It is what the whole lockstep arc was for: a match is
  now a reproducible event log, so what persists is what happened rather than a summary of it.
- **`[ITEM-004]`**: In-match progression, now also the home for the GDD's learn-by-doing
  growth. **Measure before building**: the harness reports a median of four turns per match, so
  count kills per unit per match first and site the XP threshold where it can actually be
  reached.
- **`[ITEM-010]`**: Roles on the loadout screen. Mostly UI over the existing `LOADOUT_LIMITS`
  machinery.
- **`[ITEM-028]`**: Log and store schema drift guard. Wants doing *with* `[ITEM-012]`: the
  moment a roster is derived from a stored log, the log is a schema.

### 🧊 Backlog (needs its own pass)
- **`[ITEM-024]`** is **deferred**: a port with one implementation is an abstraction waiting
  for its second caller, and that caller is the referee. The transports come with it.
- **`[ITEM-023]`**: Intent-only wire. **The agreed destination**
  ([RFC-0001](../design/rfc/0001-referee-and-transports.md) §2): full knowledge on both sides,
  intent across the wire, both peers recompute. `[ITEM-026]` (per-peer projection) is rejected
  with its reasoning kept — hiding state is one rule *per component* plus ghosts plus a HUD
  story, for no effect on play.
- **`[ITEM-025]`**: The referee, as a **witness rather than an authority** — it recomputes the
  same intent stream, so it costs no latency and a match plays on unwatched without it. What it
  buys is persistence, rejoin after a crashed tab, and *attribution*: two peers can detect a
  disagreement but neither can prove whose fault it is. A foul aborts the match. One host, a
  `Bun.serve` process — the worker referee is struck, since a witness inside one player's
  process cannot attribute anything about that player.
- `[ITEM-026]` and `[ITEM-027]` are **rejected**, with their reasoning kept: hiding state costs
  a rule per component for no effect on play, and match provenance defends a debug utility
  against a grind the server removes by rolling rosters itself. The payoff of `[ITEM-020]`-`[ITEM-022]`: a resolved
  outcome stops travelling, `WireHit` is deleted, and the asymmetry behind three bugs goes
  away structurally rather than by everyone remembering a rule. Gated on the first three
  running green across real matches, and it permanently forecloses protocol-level secrets.
- **`[ITEM-012]`**: Permadeath, lasting wounds and roster persistence. Changes what the
  handshake means: a peer would be sending a *saved* roster, so `sanitizeSheet` becomes
  load-bearing against your own stored data as well as a hostile peer. Wants `ITEM-004`
  first — growth is what there would be to persist. Lasting wounds would be the first
  modifier that outlives a match, unlike `ITEM-005`'s health-derived ones.
- **`[ITEM-017]`**: Item verbs on tiles and objects — keys, locks, doors. The cheap half of
  [Interaction & Environment](../design/gdd/interaction-and-environment.md): walls are
  already replicated entities whose `kind` every consumer reads, so a door costs no new wire
  message. Fire is deliberately *not* in it — a burning tile is a per-tile effect with a
  clock, and every effect today is a status on a unit.

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
- **`[ITEM-013]`**: Utility proficiencies (Medical, Demolitions, Mechanics) — all three, not
  just the ready third. Both prerequisites the item was blocked on were built in the same
  pass: item use takes a target, and a repair kit exists for a mechanic to work.
- **`[ITEM-015]`**: Strength carrying heavy gear. The source-blind fold stayed the default and
  a source-tagged fold was added *beside* it, with one shared combining rule so the two cannot
  drift; `gearRelief` is the only rule that reads attribution. Plate had to be given an AP cost
  before there was anything for Strength to negate.
- **`[ITEM-016]`**: Intelligence gating advanced kit, on the repair kit `ITEM-013` needed
  anyway — so one item unblocked both halves.
- Of the four items filed out of the attribute pass, only **`[ITEM-014]`** (morale) is still
  open, and it is in the cold backlog for its own reason rather than for a missing prerequisite.
- **`[ITEM-020]`–`[ITEM-025]`**: full-knowledge lockstep — version gate, state digest, intent-only
  wire, the referee and the transport port.
- **`[ITEM-011]`**: Overwatch and reaction fire, with no message of its own.
- **`[ITEM-030]`**: One engine — the sweep drives `MatchHost`; `SimUnit` is gone.
- **`[ITEM-029]`**: The sweep's policy weighs the ground it crosses, and reloads.
- **`[ITEM-018]`**: Melee — a sidearm slot, fists, knife and club.
- **`[ITEM-031]`**: One command applier for every caller, live play included.
- **`[ITEM-032]`**: Projectile hit model — one straight line per projectile.
- **`[ITEM-019]`**: Noise, awareness and the quiet kill — crouched movement, attacks from
  behind, noise, awareness, glass and the stone; the policy knows only what it has seen.
- **`[ITEM-014]`**: Morale, stress and breaking — rolled breaks into panic, frenzy or freeze,
  run by the rules on both peers; steadying rolled with rising odds.

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
3. ~~Holding fire is a tactic (`ITEM-011`).~~ Done.
4. Every rule change is measured with `bun run balance` before and after, and every change
   that should *not* move the rules proves it with an identical report.
