---
title: "Multi-Milestone Capability Roadmap"
id: "PLAN-ROADMAP"
type: "plan"
status: "active"
lastReviewed: "2026-09-14"
appliesTo:
  - "docs/plans/**"
relatedDocs:
  - "docs/backlog/active-backlog.md"
  - "docs/plans/active-focus.md"
tags: ["roadmap", "milestones", "capabilities"]
---

# Multi-Milestone Capability Roadmap

Milestones are ordered strictly by architectural dependency:

```mermaid
graph TD
    M1[Milestone 1: Headless Foundation & ECS Split] --> M2[Milestone 2: Tactical Depth & RPG Progression]
    M2 --> M3[Milestone 3: Reconnaissance & Morale]
    M3 --> M4[Milestone 4: Competitive Meta & Campaign]
```

---

## Milestone Sequence

### Milestone 1: Headless Foundation & ECS Split
**Status:** In Progress  
**Focus:** Complete separation of game rules from rendering.
- `[ITEM-001]` Narrow ports (`Combatant`, `CombatFx`). *(Completed)*
- `[ITEM-002]` Deterministic balance simulation runner. *(Completed)*
- `[ITEM-003]` `Soldier` as pure data unit; `SoldierView` owning Three.js meshes and animation mixers.
- Elimination of canvas stubs across test suites.

---

### Milestone 2: Tactical Depth & RPG Progression
**Status:** Planned  
**Focus:** Character growth and mechanical stakes during combat.
- `[ITEM-004]` In-match XP accrual and on-the-fly 3-perk promotion draft.
- `[ITEM-005]` Lasting wound debuffs when crossing <50% and <25% HP thresholds.
- `[ITEM-006]` Trait-bearing passive equipment: scopes, bipods, suppressors, plate carriers.

---

### Milestone 3: Reconnaissance & Morale
**Status:** Planned  
**Focus:** Information asymmetry and battlefield control.
- `[ITEM-007]` Enemy intel fog hiding opposing character stat numbers until engaged.
- `[ITEM-008]` Ballistic suppression mechanics applying accuracy debuffs on near-misses.
- `[ITEM-009]` AP fatigue penalty for consecutive maximum-movement turns.

---

### Milestone 4: Competitive Meta & Campaign
**Status:** Planned  
**Focus:** High-level tactics, team composition, and long-term roster persistence.
- `[ITEM-010]` Tactical role specializations on loadout screen (Medic, Scout, Marksman, Gunner).
- ~~`[ITEM-011]` Reaction fire and overwatch interleaving inside enemy movement paths.~~ Done.
- `[ITEM-012]` LocalStorage and P2P campaign roster persistence across matches.
