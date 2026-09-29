---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
lastReviewed: "2026-09-30"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/README.md"
  - "docs/backlog/completed.md"
  - "docs/plans/active-focus.md"
  - "docs/plans/roadmap.md"
tags: ["backlog", "tasks", "active"]
---

# Active Backlog

**The specification of every open item** — why it is wanted, what changes, and how we will know
it is done. It is not ordered and says nothing about what happens next: that is the
[focus board](../plans/active-focus.md). Finished and rejected items move to the
[archive](./completed.md).

---

### [ITEM-039] Fatigue & Medical-Bay Downtime
**Type:** Feature  
**Priority:** P2  
**Status:** Ready — pulled next, now that `[ITEM-042]` (the bench) it is built on has shipped  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Split out of `[ITEM-038]` at 2026-09-26: [GDD §5](../design/gdd/progression-and-meta.md) also
wants "fatigue over consecutive deployments" that temporarily lowers baseline AP and morale, and
"medical-bay downtime" for severe injury. Both only mean something once a player can choose
not to deploy somebody, which the bench (`[ITEM-042]`, done) now lets one do.

#### Change
1. **Stored.** Migration 5 adds `roster.fatigue` (0–4) and `roster.downtime` (≥ 0), both
   integers defaulting to 0. These are the only stored numbers; AP and morale are derived from
   `fatigue` when a unit is built, never stored beside it.
2. **Settling**, per settled match of the player:
   - deployed: `fatigue + 1`, capped at 4;
   - not deployed: `fatigue − 2` and `downtime − 1`, both floored at 0;
   - carried out: `downtime = 2`; survived on HP at or below `WOUNDS.concussed` of their
     ceiling: `downtime = 1`.
3. **Penalty**, from the stored level at deployment: `max(0, fatigue − 1)` steps, each −1 max
   AP and −10 starting morale. So the first back-to-back match is free, and the same four
   fielded four matches running deploy on the fifth at −3 AP and 70 morale — still above
   `MORALE.steady` (50), so nobody breaks on turn one, and the +5 per turn rally wins it back.
   A six-character rotation (each resting one match in three) never passes one step.
4. **Where it is read.** `Soldier` takes a starting fatigue the way it takes a starting HP. The
   AP step is one more term in `refreshTraits`' `maxAp` sum — so every reader of `maxAp` sees it
   and Strength's `gearRelief` does not touch it — and `MoraleComponent` starts at
   `MORALE.max − 10 × steps`.
5. **Medical bay.** A member with `downtime > 0` cannot be picked: the roster screen greys them
   with the matches left, and the referee refuses them. They heal as a benched member meanwhile.
6. **On the wire**, in `Deployment.state.fatigue` (`[ITEM-043]`), beside `state.hp`. No new
   array and no version bump of its own: the bag exists precisely so this is the change. The
   referee checks it against the roster the same way it already checks `state.hp`.
7. **Measured.** `SquadPlan.fatigue` and `bun run balance -- --blueFatigue=N` (every unit at
   level N). Calibrated against a man down (`--blueSize=3`: Blue 55 → 34 wins, `[ITEM-041]`):
   level 4 must cost between half a man down and a whole one (10–21 points), so fielding a
   worn-out fourth against fielding three is a real choice; level 2 must cost at most 5. If the
   numbers in 3 miss those bands, the per-step AP and morale move, not the bands.

#### Affected Files
- `src/server/Rosters.ts`, `src/server/Referee.ts`, `src/server/db/migrations.ts`
- `src/entities/Soldier.ts`, `src/game/Squads.ts`, `src/config.ts`
- `src/hud/RosterScreen.ts` (from `[ITEM-042]`), `src/sim/SimMatch.ts`, `scripts/balance.ts`

#### Acceptance Criteria
- [ ] Settling moves `fatigue` and `downtime` exactly as in 2, including the caps and floors.
- [ ] A unit deployed at level N has its sheet's max AP minus `max(0, N − 1)` and starting
      morale `100 − 10 × max(0, N − 1)`, on both peers and the referee (digest agrees).
- [ ] A member in the medical bay cannot be picked, and the referee aborts a header that
      deploys one.
- [ ] The referee aborts a stated fatigue that differs from the roster's.
- [ ] `bun run balance -- --blueFatigue=4` costs Blue 10–21 wins in 100 and `--blueFatigue=2`
      at most 5, with the measured numbers recorded; `bun run balance` without the flag is
      identical.
