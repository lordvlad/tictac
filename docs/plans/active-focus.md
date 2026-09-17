---
title: "Active Kanban Focus: M4 Competitive & Meta Roster"
id: "PLAN-ACTIVE-FOCUS"
type: "plan"
status: "active"
lastReviewed: "2026-09-17"
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
- Nothing in flight. **The next pull is `[ITEM-020]`**, then `[ITEM-021]` and `[ITEM-022]`.
  Read them as **foundation work, not networking work**: per
  [RFC-0001](../design/rfc/0001-referee-and-transports.md) §9, combat is one subsystem of the
  GDD's game and peer-to-peer play, recording and replay are debug helpers and demo entry
  points. What these three items actually buy is that a match is a *reproducible event log* —
  which is what a roster, a rejoin and an audit are all derived from, and what `[ITEM-012]`
  cannot be built on without. Two independent recomputations of the same log is simply the
  cheapest test of that property available today, and P2P is where they live.
  The immediate provocation was three bugs with the same shape — the attacker reading its own stock
  copy of a fact only the target's owner knows — and each was fixed one property at a time,
  silently, with no check that would have caught the next one. `[ITEM-020]` is the cheap half:
  re-derive a received attack and shout when the two answers differ. It changes no contract,
  adds no latency, deletes nothing, and it is a test for a property the recorder *already*
  assumes, since a recording is an intent stream with no outcomes in it.
- `[ITEM-004]` moves behind them. Progression widens peer-supplied input, and widening the
  wire before there is any check that both sides agree on what crossed it is the wrong order.

### 📋 Ready (Pull Queue)
- **`[ITEM-020]`**: Shadow resolution and divergence detection. Observation only; the mismatch
  rate it measures is what decides whether `[ITEM-023]` is safe to attempt at all.
- **`[ITEM-021]`**: State checksum at the turn boundary. Catches drift, which is what a
  desynchronised match actually looks like — fine until nothing is. Useful on its own.
- **`[ITEM-022]`**: Determinism audit. One match RNG drawn only by the rules, a build/protocol
  gate in the handshake (this project deploys on every push, so mismatched peers are the
  ordinary case), and a float audit of anything transcendental feeding a decision. Must move
  no rule: `bun run balance` byte-identical is the acceptance test.
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
- **`[ITEM-018]`**: Melee. First combat consumer of Strength and the answer to a unit that
  is unshootable in cover and trivially reachable. Blocked less by the swing than by the
  game around it: the sweep's policy never closes, so it would measure as worthless the way
  the shotgun once did, and without `[ITEM-011]` crossing open ground goes unpunished.
- **`[ITEM-019]`**: Noise, awareness and the quiet kill. Sound as the second information
  channel, with awareness sitting beside `seen` and `known` exactly as intel fog does. The
  real cost is an AI that can be *fooled* — a thrown stone is worth nothing against a policy
  that ignores information — plus enemy patrol behaviour, without which sneaking is walking
  around statues.

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
