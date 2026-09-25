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
- Nothing in flight. `[ITEM-004]` (after-match progression and the end screen) finished on
  2026-09-25; next is persistence, so the growth it shows is kept.

## 📋 Ready — pull in this order
1. **`[ITEM-028]`** Log and store schema drift guard, with `[ITEM-012]`: once a roster is
   derived from a stored log, the log is a schema.
2. **`[ITEM-012]`** Permadeath, lasting wounds and roster persistence, on the referee's store
   (`[ITEM-025]`). Straight after `[ITEM-004]`, by the user's call: growth is what there is to
   persist, and until then it is shown and lost.
3. **`[ITEM-010]`** Roles on the loadout screen. Independent of the others; mostly UI over
   `LOADOUT_LIMITS`.

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
- **ITEM-004**: growth is shown and lost until persistence; Strength and Intelligence barely grow
  in the sweep because the policy carries no plate, swings no knife and uses no kit.
- **ITEM-004 / ITEM-014 / ITEM-017 / ITEM-024 / ITEM-034**: nobody has played peer-to-peer in two
  live browsers since the transport cutover (the online end screen included). Agreement is
  covered by the network, digest and rewind tests only.

---

## Definition of Done for M4
1. A squad's composition is a decision with consequences beyond its kit (`ITEM-010`).
2. A unit that survives a match is worth more than one that did not (`ITEM-004`, `ITEM-012`).
3. ~~Holding fire is a tactic (`ITEM-011`).~~ Done.
4. Every rule change is measured with `bun run balance` before and after, and every change
   that should *not* move the rules proves it with an identical report.
