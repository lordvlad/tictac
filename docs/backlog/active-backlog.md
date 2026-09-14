---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/README.md"
  - "docs/plans/sprints/sprint-current.md"
tags: ["backlog", "tasks", "active"]
---

# Active Backlog

---

### [ENG-001] Complete ECS Split: Data Units vs View Units
**Type:** Refactor / Architecture  
**Priority:** P0  
**Status:** Ready  
**Milestone:** M1 — Headless Foundation  
**Owner:** Unassigned  

#### Why
While narrow ports (`Combatant`, `CombatFx`) decoupled rule execution from direct render calls, `Soldier` still inherits `Entity3D`. A squad cannot be constructed without an active 3D scene and camera. Five test suites still rely on canvas stubs.

#### Change
1. Make `Soldier` a pure data container wrapping entity components.
2. Introduce `SoldierView` (`src/render/SoldierView.ts`) owning `Entity3D`, glTF meshes, cloned materials, and animation mixers.
3. Update `RenderSystem` to drive `SoldierView` based on `PositionComponent`, `StanceComponent`, and `HealthComponent`.
4. Update `Squads.ts` and `Battlefield.ts` to instantiate data models independently of view representations.

#### Affected Files
- `src/entities/Soldier.ts`
- `src/render/SoldierView.ts` (new)
- `src/render/SquadViews.ts` (new)
- `src/ecs/systems/RenderSystem.ts`
- `src/game/Squads.ts`
- `src/game/Battlefield.ts`
- `src/main.ts`

#### Acceptance Criteria
- [ ] `Soldier` has no references to `three` rendering types (except pure vector math) or `Entity3D`.
- [ ] Squads and battlefields instantiate headless in test suites without `installCanvasStub`.
- [ ] Visual sanity: unit animations, crouching, facing angles, and yaw transitions verified in browser.
- [ ] Full test suite passes (`bun test`).

---

### [GAME-001] In-Match Progression & Promotion Draft
**Type:** Feature  
**Priority:** P1  
**Status:** Ready  
**Milestone:** M2 — Tactical Depth  
**Owner:** Unassigned  

#### Why
Units currently have fixed stats throughout combat. Actions taken during combat do not accrue tactical advancement or dynamic builds.

#### Change
1. Track unit XP from kills and assists.
2. Trigger promotion upon reaching threshold; present a 3-perk trait selection prompt on HUD.
3. Replicate choice across P2P wire as a `promote` command; append selected `TraitId` to `sheet.traits` and invoke `refreshTraits()`.

#### Affected Files
- `src/core/Progression.ts` (new)
- `src/ecs/systems/CombatSystem.ts`
- `src/game/NetworkManager.ts`
- `src/hud/Hud.ts`
- `tests/rpg.test.ts`

#### Acceptance Criteria
- [ ] Killing an enemy yields XP and triggers promotion dialog when threshold is reached.
- [ ] Selected trait applies immediately to active combat stats and replicates to remote peer.
- [ ] Wire sanitization verifies trait validity against cheat injections.

---

### [GAME-002] Dynamic Wounds as Negative Traits
**Type:** Feature  
**Priority:** P1  
**Status:** Backlog  
**Milestone:** M2 — Tactical Depth  
**Owner:** Unassigned  

#### Why
HP reduction currently only changes how many shots a soldier can take before dying. Health degradation should impose tactical penalties.

#### Change
1. Add threshold checks: <50% HP inflicts `Winded` (-2 AP), <25% HP inflicts `Concussed` (-6 accuracy) and `Limping` (1.5x movement cost).
2. Extend `TraitEffects` with `moveCostMul` and `apCostDelta`.

#### Affected Files
- `src/core/Traits.ts`
- `src/ecs/components/TraitsComponent.ts`
- `src/ecs/systems/MovementSystem.ts`
- `src/ecs/systems/CombatSystem.ts`

#### Acceptance Criteria
- [ ] Damage crossing 50% / 25% thresholds attaches corresponding wound traits.
- [ ] AP pools and movement costs reflect wound multipliers.
- [ ] Verified via unit test and headless balance sweep.

---

### [GAME-003] Trait-Bearing Equipment Breadth
**Type:** Content / Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M2 — Tactical Depth  
**Owner:** Unassigned  

#### Why
Items currently have limited variety. Expanding passive traits on gear increases loadout strategy.

#### Change
Implement gear items with passive traits:
- **Scope**: Accuracy scales with target distance.
- **Bipod**: Evasion and accuracy bonus while in crouched stance.
- **Suppressor**: Eliminates muzzle flash detection; minor crit penalty.
- **Plate Carrier**: +2 Armor, -3 Evasion.

#### Affected Files
- `src/core/Items.ts`
- `src/core/Arsenal.ts`
- `src/hud/LoadoutScreen.ts`

---

### [GAME-004] Enemy Intel Fog
**Type:** Feature / Polish  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M3 — Reconnaissance & Fog  
**Owner:** Unassigned  

#### Why
Enemy evasion and combat statistics are currently visible immediately upon targeting, eliminating tension and scouting utility.

#### Change
Hide enemy stat sheet numbers on HUD until that unit has acted or been engaged in combat.

#### Affected Files
- `src/hud/Hud.ts`
- `src/hud/HudModel.ts`
- `src/game/FogOfWar.ts`

---

### [GAME-005] Suppression & Morale Mechanics
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M3 — Reconnaissance & Fog  
**Owner:** Unassigned  

#### Why
Missed shots currently do zero mechanical work. Concentrated fire should pin enemy positions.

#### Change
Accumulate suppression status on targets from near-miss ballistic rounds, applying accuracy penalties and AP restrictions.

#### Affected Files
- `src/core/Arsenal.ts`
- `src/ecs/systems/CombatSystem.ts`
- `src/ecs/components/StatusesComponent.ts`

---

### [GAME-006] Fatigue & Exhaustion
**Type:** Feature  
**Priority:** P3  
**Status:** Backlog  
**Milestone:** M3 — Reconnaissance & Fog  
**Owner:** Unassigned  

#### Why
Expending maximum AP across consecutive turns has no trade-off.

#### Change
Expending full AP on two consecutive turns inflicts `Winded` on the following turn.

---

### [UI-001] Loadout Screen Role Archetypes
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M4 — Meta & Campaign  
**Owner:** Unassigned  

#### Why
All units are currently interchangeable at the loadout screen.

#### Change
Introduce Medic, Scout, Marksman, and Gunner roles that gate available weapon/item slots and provide unique role abilities.

---

### [GAME-007] Overwatch & Reaction Fire
**Type:** Feature  
**Priority:** P1  
**Status:** Backlog  
**Milestone:** M4 — Meta & Campaign  
**Owner:** Unassigned  

#### Why
The quintessential tactical ability: reserving AP to engage moving enemies during their turn.

#### Change
1. Allow units to hold AP in Overwatch stance.
2. Trigger reaction shots mid-path in `MovementSystem`.
3. Replicate reaction fire across wire protocol authored by the reacting unit's owner.

---

### [GAME-008] Persistent Campaign Roster
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M4 — Meta & Campaign  
**Owner:** Unassigned  

#### Why
Squads are rolled randomly per match and discarded.

#### Change
Persist squad character sheets in `localStorage` across matches with XP, combat records, and untreated wounds.
