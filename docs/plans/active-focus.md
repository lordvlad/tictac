---
title: "Active Kanban Focus: M4 Competitive & Meta Roster"
id: "PLAN-ACTIVE-FOCUS"
type: "plan"
status: "active"
lastReviewed: "2026-09-28"
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
- Nothing in flight. `[ITEM-041]` (a short-handed roster fielded a phantom unit) was found
  and fixed on 2026-09-28 while designing `[ITEM-039]`: a roster with an empty slot now deploys
  exactly its living, and a man down costs 21 points of win rate in the sweep.

## 📋 Ready — pull in this order
1. **`[ITEM-042]`** The bench: a roster of six, pick who deploys, recruit from the roster
   screen. Nothing that depends on *not* deploying someone can mean anything until this lands.
2. **`[ITEM-039]`** Fatigue & medical-bay downtime, on top of the bench. Numbers are set and
   calibrated against a man down (−21 wins in 100).

## 🧊 Backlog — not yet queued
- Nothing.

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
- **ITEM-012**: a dead character's slot stayed empty until `[ITEM-037]`, which fills it with a
  free server-rolled recruit — no cost and no pool, since no economy exists to price either
  yet. Durable Objects would still need one more `Db` adapter; none is written.
- **ITEM-037**: recruiting is an API route only (`POST /api/roster/recruit`); no client screen
  calls it yet, so in the game a dead slot stays empty until one does. `[ITEM-042]`'s roster
  screen closes this.
- **ITEM-038**: a bug caught in its own testing — `derive(sheet).maxHp` ignores a character's
  own maxHp trait (Juggernaut's +25); fixed with `maxHpOf`, which every roster ceiling now uses
  instead. Fatigue and medical-bay downtime split to `[ITEM-039]`, now designed on top of the
  bench (`[ITEM-042]`).
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
