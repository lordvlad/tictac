---
title: "Active Kanban Focus: M4 Competitive & Meta Roster"
id: "PLAN-ACTIVE-FOCUS"
type: "plan"
status: "active"
lastReviewed: "2026-09-27"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/active-backlog.md"
  - "docs/backlog/completed.md"
  - "docs/plans/roadmap.md"
tags: ["kanban", "active", "focus", "m4"]
---

# Active Kanban Focus: M4 Competitive & Meta Roster

**What is in flight, what gets pulled next and in what order, and what finished work left
open.** One line per item, no specifications: each item's why, change and acceptance
criteria are in the [active backlog](../backlog/active-backlog.md), and finished items are in
the [archive](../backlog/completed.md).

## Focus & Theme
M1 (headless foundation), M2 (tactical depth) and M3 (reconnaissance & morale) are complete;
doors (`[ITEM-017]`) closed M2 on 2026-09-25. What is left is the meta layer: a unit that grows
during a match, roles, and a roster that outlives the match.

---

## 🔄 In Progress
- Nothing in flight. `[ITEM-010]` (roles on the loadout screen) finished on 2026-09-27: Medic,
  Scout and Marksman each narrow the crate and earn one trait; Rifleman, the pre-existing
  default, is untouched.

## 📋 Ready — pull in this order
1. **`[ITEM-037]`** Recruits fill an empty roster slot. Persistence marks the dead and leaves
   the slot empty on purpose; where new people come from is its own mechanic.

## 🧊 Backlog — not yet queued
- **`[ITEM-039]`** Fatigue & medical-bay downtime. No numbers, no acceptance criteria yet — a
  design pass before it can be Ready.

## ⚠️ Left open by finished work
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
- **ITEM-012**: a dead character's slot stays empty (`ITEM-037`). Durable Objects would need
  one more `Db` adapter; none is written.
- **ITEM-038**: a bug caught in its own testing — `derive(sheet).maxHp` ignores a character's
  own maxHp trait (Juggernaut's +25); fixed with `maxHpOf`, which every roster ceiling now uses
  instead. Fatigue and medical-bay downtime split to `[ITEM-039]`, not designed yet.
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

## Definition of Done for M4
1. A squad's composition is a decision with consequences beyond its kit (`ITEM-010`).
2. A unit that survives a match is worth more than one that did not (`ITEM-004`, `ITEM-012`,
   `ITEM-038`).
3. ~~Holding fire is a tactic (`ITEM-011`).~~ Done.
4. Every rule change is measured with `bun run balance` before and after, and every change
   that should *not* move the rules proves it with an identical report.
