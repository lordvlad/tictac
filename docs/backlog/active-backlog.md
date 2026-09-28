---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
lastReviewed: "2026-09-28"
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
**Priority:** P3  
**Status:** Backlog  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Split out of `[ITEM-038]` at 2026-09-26: [GDD §5](../design/gdd/progression-and-meta.md) also
wants "fatigue over consecutive deployments" that temporarily lowers baseline AP and morale, and
"medical-bay downtime" for severe injury. Neither has a number anywhere, and both are a
*combat-system* change (AP and morale are read every turn by systems `[ITEM-038]` never
touches), not a persistence one — filing it separately keeps that design work from blocking the
HP-and-healing slice that already has concrete acceptance criteria.

#### Change
Not designed yet. Needs, at minimum: what "a deployment" counts as now that a roster always
fields a full squad (`[ITEM-037]` may change that); a concrete fatigue curve and decay rule,
proven against the balance sweep the way every other rule change is; and where the temporary
penalty is read (`ActionPointsComponent`, `MoraleComponent`) without becoming a second, silently
diverging copy of the numbers `[ITEM-038]` already stores.

#### Affected Files
- `src/server/Rosters.ts`, `src/server/db/migrations.ts`
- `src/ecs/components/ActionPointsComponent.ts`, `MoraleComponent.ts`

#### Acceptance Criteria
- [ ] Not yet written: needs a design pass with numbers before this is Ready.
