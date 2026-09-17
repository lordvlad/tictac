---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
lastReviewed: "2026-09-17"
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
4. **Organic growth (from [GDD §4](../design/gdd/progression-and-meta.md), folded in here
   rather than filed twice)**: proficiency rises from using the thing — landing hits,
   scoring crits, deploying utility — and the four attributes rise from being pushed:
   Health from surviving non-lethal damage, Agility from spending AP to just short of
   `Winded` and hitting with precision weapons, Strength from moving far while encumbered and
   winning melee, Intelligence from using advanced kit well. The GDD is explicit that this
   replaces "a generic XP pool spent in menus", so points 1–3 above are now the *fallback*
   design: if learn-by-doing lands, the perk draft is the promotion moment on top of it and
   the XP threshold is what earns the draft, not what buys the stat.
5. Growth writes to `sheet.attributes`, which is the whole reason the sheet keeps attributes
   rather than ceilings: a unit that trains gains a point, and every derived stat follows from
   `derive()` with nothing to migrate.

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

### [ITEM-012] Permadeath, Lasting Wounds & Campaign Roster Persistence
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Squads are rolled randomly per match and forgotten upon exit.

#### Change
Character sheets persist in `localStorage` across matches, carrying XP, promotions, and untreated wounds.

Also the rest of [GDD §5](../design/gdd/progression-and-meta.md), which only means anything
once a roster outlives a match and is therefore filed here rather than as its own item:
1. **Permadeath**: a unit that ends a match at `hp <= 0` without triage leaves the roster for
   good. In-match death is already just `hp <= 0` in a component — this is about what the
   post-match write does with it.
2. **Lasting wounds**: severe injury books medical-bay time between missions, and fatigue over
   consecutive deployments temporarily lowers baseline AP and morale. Distinct from the
   in-match wounds in `ITEM-005`, which are derived from current health and heal with it;
   these outlive the match and have to be stored, which is the first modifier that does.
3. Scars, combat logs and organic stat growth (`ITEM-004`) stored alongside the sheet. Growth
   lands in `sheet.attributes`, so what persists is four ints per character, not a stat block.

#### Caveat
Changes what the network handshake means: peers send *saved* rosters, making `sanitizeSheet` load-bearing against local tampering as well as hostile peers.

#### Affected Files
- `src/core/Characters.ts`
- `src/game/NetworkManager.ts`
- `src/hud/LoadoutScreen.ts`

---

### [ITEM-014] Morale, Stress & Psychological Predispositions
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M3 — Reconnaissance & Morale  

#### Why
[GDD §3](../design/gdd/progression-and-meta.md) wants stress to accrue from damage, near
misses and watching squadmates fall, with breaks (panic, AP loss, pinning) above a threshold
and surges below it. M3 shipped its reconnaissance half only: the sole psychological state a
unit has today is the `Suppressed` status, which costs accuracy and points and then decays.

#### Change
1. A `MoraleComponent` (morale, accumulated stress), replicated — a unit breaking is
   something the other side has to be able to watch happen.
2. Stress fed from events that already fire on both sides: damage applied, rounds that missed
   (`Suppressed` is already counted identically by `executeShot` and `replayShot`), a
   squadmate dying.
3. Breaks and surges expressed as statuses wherever possible, so the modifier fold does not
   grow a fifth source.
4. Daredevil, Teamplayer and Loner as innate ids.

#### Caveat
The three predispositions are trait-shaped and would drop straight into `INNATE_TRAITS`, but
`TraitEffects` are flat modifiers on combat numbers and a predisposition modifies *how morale
moves* — nothing a hit chance can express. They need the loop above to exist first; shipping
the ids alone would add three traits that do nothing.

#### Affected Files
- `src/ecs/components/MoraleComponent.ts` (new)
- `src/core/Traits.ts`
- `src/ecs/systems/CombatSystem.ts`
- `src/ecs/systems/TurnSystem.ts`
- `src/config.ts`

#### Acceptance Criteria
- [ ] Stress accrues from damage taken, near misses and squadmate deaths; both peers reach
      the same morale for the same unit.
- [ ] Crossing the break threshold costs the unit its turn in a way the other side sees.
- [ ] Daredevil, Teamplayer and Loner each measurably change how a unit's morale moves.

