---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
lastReviewed: "2026-09-15"
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

---

### [ITEM-004] In-Match Progression & Promotion Draft
**Type:** Feature  
**Priority:** P1  
**Status:** Ready  
**Milestone:** M2 — Tactical Depth  

#### Why
Characters vary at deployment but never change during a fight, so nothing a unit does accrues to it.

#### Change
1. Kills and assists grant XP; at a threshold the unit is promoted and the player picks one perk from three.
2. A perk is a `TraitId` appended to `sheet.traits` followed by `refreshTraits()` (mechanism already exists).
3. The choice travels across P2P as a new `promote` command. Defensive perks replicate through `TraitsComponent`; offensive ones resolve on sender.

#### Affected Files
- `src/core/Progression.ts` (new)
- `src/ecs/systems/CombatSystem.ts` (`onShotResolved` hook)
- `src/game/NetworkManager.ts`
- `src/hud/Hud.ts` (perk selection prompt)
- `tests/rpg.test.ts`

#### Caveat
Puts player choice into the wire protocol. Requires dedicated input sanitization against malformed traits and regression pins.

#### Acceptance Criteria
- [ ] Kills and assists accumulate XP; reaching threshold triggers 3-perk promotion UI.
- [ ] Selected trait applies immediately to active stats and replicates across P2P.
- [ ] Dedicated sanitizer guards wire against invalid traits.

---

### [ITEM-005] Dynamic Wounds as Negative Traits
**Type:** Feature  
**Priority:** P1  
**Status:** Backlog  
**Milestone:** M2 — Tactical Depth  

#### Why
HP variation currently only decides how many shots a unit survives. Crossing health degradation thresholds should cost something that persists.

#### Change
1. Dropping below 50% and 25% HP inflicts lasting traits: `Winded` (-2 AP), `Concussed` (-6 accuracy), `Limping` (movement cost x1.5). Reuses trait fold verbatim.
2. Extend `TraitEffects` with `moveCostMul` and `apCostDelta`.

#### Affected Files
- `src/core/Traits.ts`
- `src/ecs/components/TraitsComponent.ts`
- `src/ecs/systems/MovementSystem.ts`
- `src/ecs/systems/CombatSystem.ts`

#### Acceptance Criteria
- [ ] Damage crossing 50% and 25% thresholds attaches corresponding wound traits.
- [ ] AP pools and movement costs reflect wound multipliers.
- [ ] Regression tested in `tests/rpg.test.ts` and headless balance sweeps.

---

### [ITEM-006] Trait-Bearing Equipment Breadth
**Type:** Content / Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M2 — Tactical Depth  

#### Why
`ItemSpec.traits` and `passive` already work (the Nullweave vest proved the mechanism). Expanding content provides tactical loadout depth.

#### Change
Implement passive gear with specific effect fields:
- **Scope**: Accuracy that scales with range distance.
- **Bipod**: Evasion and accuracy bonus while crouched.
- **Suppressor**: No muzzle reveal, reduced crit multiplier.
- **Plate Carrier**: +Armor, -Evasion.

#### Affected Files
- `src/core/Items.ts`
- `src/core/Arsenal.ts`
- `src/hud/LoadoutScreen.ts`

---

### [ITEM-007] Enemy Intel Fog
**Type:** Feature / Polish  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M3 — Reconnaissance & Fog  

#### Why
An enemy's exact evasion is visible the moment you aim at them. While mechanically necessary for shot previews, it makes sheets read as stat blocks rather than living opponents.

#### Change
Show target stats as unknown until that unit has acted or been shot at, then reveal them. HUD only — data remains local.

#### Affected Files
- `src/hud/Hud.ts`
- `src/hud/HudModel.ts`
- `src/game/FogOfWar.ts`

---

### [ITEM-008] Suppression & Morale Mechanics
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M3 — Reconnaissance & Fog  

#### Why
A missed shot currently does nothing at all. Concentrated fire should pin down enemy positions.

#### Change
Rounds that miss accumulate suppression on the target: an accuracy penalty first, pinned at higher stacks. Integrates with `STATUSES` per-turn decay machinery via a hook in `executeShot` for un-landed rounds.

#### Affected Files
- `src/core/Arsenal.ts`
- `src/ecs/systems/CombatSystem.ts`
- `src/ecs/components/StatusesComponent.ts`

---

### [ITEM-009] Exhaustion & Fatigue
**Type:** Feature  
**Priority:** P3  
**Status:** Backlog  
**Milestone:** M3 — Reconnaissance & Fog  

#### Why
Ties the stamina framing of AP to a recurring cost instead of just an instantaneous ceiling.

#### Change
Spending every action point across two consecutive turns leaves the unit `Winded` on the following turn (~30 lines against existing status machinery).

#### Affected Files
- `src/ecs/systems/TurnSystem.ts`
- `src/ecs/components/ActionPointsComponent.ts`

---

### [ITEM-010] Roles on the Loadout Screen
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Every unit is currently interchangeable apart from its generated character sheet.

#### Change
Medic, Scout, and Marksman roles gate which crate rows a unit may draw equipment from, each providing one unique role ability. Uses existing `LOADOUT_LIMITS` machinery.

#### Affected Files
- `src/hud/LoadoutScreen.ts`
- `src/game/Loadout.ts`

---

### [ITEM-011] Overwatch & Reaction Fire
**Type:** Feature  
**Priority:** P1  
**Status:** Backlog  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
The quintessential tactical ability: reserving AP to engage moving enemies during their turn.

#### Change
A unit may hold remaining AP to fire during an enemy's movement phase.

#### Cost & Complexity
Genuinely invasive. It interleaves resolution into the *enemy's* turn, and under the "sender resolves, receiver replays" contract every reaction must be authored by the reacting unit's owner and applied mid-path — so both `MovementSystem` and the wire protocol are in scope.

#### Affected Files
- `src/ecs/systems/MovementSystem.ts`
- `src/ecs/systems/CombatSystem.ts`
- `src/game/NetworkManager.ts`
- `src/hud/Hud.ts`

---

### [ITEM-012] Campaign Roster Persistence
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Squads are rolled randomly per match and forgotten upon exit.

#### Change
Character sheets persist in `localStorage` across matches, carrying XP, promotions, and untreated wounds.

#### Caveat
Changes what the network handshake means: peers send *saved* rosters, making `sanitizeSheet` load-bearing against local tampering as well as hostile peers.

#### Affected Files
- `src/core/Characters.ts`
- `src/game/NetworkManager.ts`
- `src/hud/LoadoutScreen.ts`
