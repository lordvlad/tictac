---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
lastReviewed: "2026-09-26"
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

### [ITEM-010] Roles on the Loadout Screen
**Type:** Feature  
**Priority:** P2  
**Status:** Ready  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Every unit is currently interchangeable apart from its generated character sheet.

#### Change
Medic, Scout, and Marksman roles gate which crate rows a unit may draw equipment from, each providing one unique role ability. Uses existing `LOADOUT_LIMITS` machinery.

#### Affected Files
- `src/hud/LoadoutScreen.ts`
- `src/game/Loadout.ts`

---

### [ITEM-037] Recruits Fill an Empty Roster Slot
**Type:** Feature  
**Priority:** P2  
**Status:** Ready  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Since `[ITEM-012]` a character who dies is marked dead and the slot they held is simply empty:
a player who loses two people fields two. Persistence had to stop there on purpose — where new
people come from is a mechanic in its own right (recruitment, cost, a pool to choose from),
and hard-wiring "the server rolls you a replacement" would have settled that question by
accident.

#### Change
1. Decide what fills a slot: a server-rolled recruit, a hire from a pool, or a cost paid out of
   an economy that does not exist yet. Until then a short-handed squad deploys short-handed.
2. Whatever the answer, it writes through `Rosters` and the `roster_active_slot` partial index
   already allows it: mark the old row dead first, then insert at the same slot.
3. `Referee.verifyRosters` compares the deployed squad against the *active* roster, so a
   short-handed squad already plays; a refill must not change that comparison.

#### Affected Files
- `src/server/Rosters.ts`
- `src/server/Api.ts` (if a player chooses rather than receives)

#### Acceptance Criteria
- [ ] A player whose character died can field a full squad again by whatever the chosen
      mechanic is, and the dead row stays in the table as history.
- [ ] A short-handed squad still deploys and still settles.

---

### [ITEM-038] Lasting Wounds & Health Between Matches
**Type:** Feature  
**Priority:** P2  
**Status:** Ready  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
The rest of [GDD §5](../design/gdd/progression-and-meta.md) that `[ITEM-012]` did not carry.
A roster now outlives the match, which is the precondition; what it does not yet store is a
body. Every match deploys at full health, and the one carried out of a lost match — who the
GDD has leaving on 1 HP — comes back whole.

#### Change
1. An `hp` column in a migration 4, and the between-match healing that makes it mean something
   rather than a permanent penalty.
2. **Lasting wounds**: severe injury books medical-bay time between missions, and fatigue over
   consecutive deployments temporarily lowers baseline AP and morale. Distinct from the
   in-match wounds in `ITEM-005`, which are derived from current health and heal with it.
3. Scars and combat logs alongside the sheet.

#### Affected Files
- `src/server/db/migrations.ts`
- `src/server/Rosters.ts`
- `src/game/MatchEnd.ts`

#### Acceptance Criteria
- [ ] The unit carried out of a lost match is on the roster with the health the rules say, not
      with full health.
- [ ] Healing between matches is a rule with a test, not an implicit reset.
