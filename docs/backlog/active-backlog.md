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

---

### [ITEM-017] Item Verbs on Tiles and Objects
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M2 — Tactical Depth  

#### Why
[GDD: Interaction & Environment](../design/gdd/interaction-and-environment.md). Targeted item
use reaches a squadmate; it does not reach a *place* or a *thing*. Without that there is no
key, no door, and no way to set anything alight — a pouch that only points at people.

#### Change
1. `ItemSystem.use` takes a target that is one of several kinds — a unit, a tile, or a wall
   segment — with the same two-tap interaction and the same wire shape as targeted treatment.
2. A `Door` wall kind with lock state. Walls are already entities with a replicated `kind`,
   so opening or breaking one needs no new message and every consumer agrees at once.
3. A key: an item whose contribution is a *permission* rather than an effect.

#### Blocker
Nothing blocks the door half. **Fire does not belong in this item**: a fire that sits in a
doorway and burns whoever stands there is a per-tile effect with a clock, and every effect
today is a status on a unit ticked by the turn system. That is a separate kind of state and
should be its own item, so locks can ship without waiting for it.

#### Affected Files
- `src/core/Items.ts`
- `src/ecs/systems/ItemSystem.ts`
- `src/core/Walls.ts`
- `src/ecs/components/WallComponent.ts`
- `src/game/InteractionController.ts`

#### Acceptance Criteria
- [ ] An item can be pointed at a unit, a tile or a wall segment, through one selection step.
- [ ] A locked door refuses a push, opens to the right key, and both peers see it open.
- [ ] A door's state survives a recorded replay.

---

### [ITEM-018] Melee: Fists, Blades and Bludgeons
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M2 — Tactical Depth  

#### Why
[GDD: Melee Combat](../design/gdd/melee-combat.md). Distance is the only axis the game has,
so a soldier in good cover is close to unkillable while being trivially reachable. Melee is
the answer to that stalemate, the first combat consumer of Strength, and the only way to end
a sentry quietly.

#### Change
1. A melee resolution path beside `executeShot`: a contest between the attacker's strength
   and training and the defender's agility, with no range or cover terms and no ammunition.
   Sender-resolved, numbers on the wire like every other attack.
2. Three families that answer different questions — bare hands (non-lethal, worst against
   armour), blades (crits, quiet, find gaps) and bludgeons (shred armour, loud).
3. Attacks from outside a target's view resolved differently from attacks to the face; facing
   and per-side visibility are both already replicated.

#### Blocker
Two, and both are about the game around it rather than the swing itself. The headless policy
picks the best available *shot* and never closes, so a melee that ships before the AI can use
it will measure as worthless — exactly how the shotgun once measured, by never entering its
own range band. And melee without [ITEM-011](#item-011-overwatch--reaction-fire) has no
counter: crossing open ground has to be punishable or closing becomes strictly correct.

#### Affected Files
- `src/core/Arsenal.ts`
- `src/game/Combat.ts`
- `src/ecs/systems/CombatSystem.ts`
- `src/sim/SimMatch.ts`
- `src/game/Loadout.ts`

#### Acceptance Criteria
- [ ] A melee exchange resolves with no cover or range term, and a peer replays the sender's
      numbers verbatim.
- [ ] Bare hands, a blade and a bludgeon differ measurably against an armoured target.
- [ ] The sweep's AI closes when closing is the better option, and `bun run balance` reports
      what each family actually did.

---

### [ITEM-019] Noise, Awareness and the Quiet Kill
**Type:** Feature  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M3 — Reconnaissance & Morale  

#### Why
[GDD: Noise & Stealth](../design/gdd/noise-and-stealth.md). Sight is modelled carefully and
sound not at all, so there is no choice between crossing a room quickly and crossing it
quietly. Sound is the second information channel, and the codebase already separates *seen*
from *read* — awareness is a third state of the same kind.

#### Change
1. Awareness per unit, per side — unaware, alerted, engaged — beside `seen` and `known`, so
   it replicates the way intel fog already does.
2. Noise events: a tile, a loudness, and whoever is within earshot is alerted. Distance, not
   ray-marching. Crouching is silent; sprinting and gunfire are not; the suppressor's quiet
   is the existing precedent.
3. Breakable glazing — `WallKind.Glass` already stops nothing and is already a replicated
   entity — and a thrown stone that makes its noise where it *lands*, which is the first
   mechanic in the game that manipulates enemy information rather than enemy hit points.
4. A silent kill: an unaware target, from behind, with a quiet weapon, unobserved.

#### Blocker
Enemies cannot currently be unaware, so there is nothing to sneak past and nothing to
distract. The AI is the real cost: a policy that ignores awareness makes a thrown stone
measure as doing nothing. Turn-based stealth also needs the enemy to *act* on its own turn, or
sneaking degenerates into walking around statues — patrol behaviour is part of this item, not
separate from it.

#### Affected Files
- `src/ecs/components/SightedComponent.ts`
- `src/game/FogOfWar.ts`
- `src/core/Walls.ts`
- `src/sim/SimMatch.ts`
- `src/hud/HudModel.ts`

#### Acceptance Criteria
- [ ] Being heard alerts a unit without handing the listener a firing solution.
- [ ] A crouched approach can reach an unaware enemy; a standing one cannot.
- [ ] A stone alerts enemies toward where it landed, not toward the thrower.
- [ ] Breaking glass alerts, and the segment is gone for both peers.
---

### [ITEM-020] Shadow Resolution & Divergence Detection
**Type:** Refactor / Architecture  
**Priority:** P1  
**Status:** Ready  
**Milestone:** M2 — Tactical Depth  

#### Why
Combat is sender-resolved: the acting peer rolls, resolves and ships the numbers, and the
receiver applies them verbatim. That trade bought instant feedback and one code path for local
play and the headless sim, and it has a standing cost — the attacker must know things about
the *target* that only the target's owner truly knows. Three bugs of exactly that shape have
shipped and been fixed one property at a time:

| Bug | What the attacker read |
| --- | --- |
| `ITEM-006` fallout | its stock copy of the target's evasion |
| `ITEM-006` fallout | its stock copy of the target's plate (`damageTaken`, `evasionCrouched`) |
| `ITEM-007` fallout | its stock copy of the target's `unreadable` |

Each was silent: the wrong number was applied and nothing complained. The rule written in
those commits — *a defensive property must live in `TraitsComponent`* — exists because the
architecture points the wrong way, and it only holds as long as everyone remembers it.

The repository already depends on the property that would catch this class. A recording is an
**intent stream**: the captured sample is 57 events — moves, shots, grenades, turn ends — with
no outcomes in it, and `applyRecordedCommand` rebuilds the fight by re-running the rules.
Nothing currently checks that re-derivation against what originally happened, so if it cannot
be trusted, replay is already broken and has been lucky.

#### Change
Turn silent wrongness into a loud error, without changing the contract.
1. On receiving a resolved attack (`fireShot`, `throwGrenade`), the receiver **also**
   re-derives the outcome locally from the intent plus its own state, and compares against the
   payload it was sent.
2. A mismatch is reported once per occurrence with both answers and the unit it concerned —
   loudly enough to be noticed in a live match, cheap enough to leave on.
3. The applied result stays the sender's. This item changes nothing about who is authoritative;
   it only observes.
4. A test that reproduces the class: withhold a defensive property from replication and assert
   the comparison fires. That is the check the three bugs above would each have tripped.

#### Notes
- Deliberately observation-only, so it can land with no protocol change, no deletion and no
  latency. It is also self-validating: the mismatch rate across real matches is the evidence
  that decides whether `ITEM-023` is safe to attempt.
- The comparison must not draw from the match RNG, or it will itself desynchronise the thing
  it is measuring. It compares against the rolls already on the wire.

#### Affected Files
- `src/ecs/systems/CombatSystem.ts`
- `src/game/InteractionController.ts`
- `src/game/Combat.ts`
- `tests/network.test.ts`

#### Acceptance Criteria
- [ ] A received `fireShot` is re-derived locally and compared; agreement is silent.
- [ ] A deliberately unreplicated defensive property makes the comparison fire, in a test.
- [ ] A received `throwGrenade` is compared per victim, including the receiver's own units.
- [ ] The comparison consumes no match randomness and changes no applied outcome.

---

### [ITEM-021] State Checksum at the Turn Boundary
**Type:** Refactor / Architecture  
**Priority:** P1  
**Status:** Ready  
**Milestone:** M2 — Tactical Depth  

#### Why
`ITEM-020` catches an attack that two peers resolve differently. It cannot catch *drift* — two
states that diverged without any single action revealing it, which is how a desynchronised
match actually feels: everything looks fine until nothing does.

#### Change
1. A canonical state digest, computed from the component serialisations the replication layer
   already produces (`World` serialise per component), in a stable order.
2. Exchanged at handover — the natural sync point, and cheap at once per turn rather than per
   frame.
3. On disagreement, name what differs rather than only that something does: report the first
   differing component and entity, since "the states differ" is not a debuggable message.

#### Notes
- A digest is worth having before `ITEM-023` and useful without it. It is the difference
  between "we think both peers agree" and "both peers agreed as of turn 7".
- Detection is not repair. This item deliberately stops at reporting; resynchronising from a
  designated authority is a separate decision that reintroduces a host, and should be taken
  on purpose.

#### Affected Files
- `src/ecs/World.ts`
- `src/game/NetworkManager.ts`
- `src/game/JsonRpc.ts`
- `src/game/TurnManager.ts`
- `tests/network.test.ts`

#### Acceptance Criteria
- [ ] Both peers agree on a digest for an identical world, and the digest is stable across
      component insertion order.
- [ ] A single mutated component on one side is reported at the next handover, naming the
      component and the entity.
- [ ] Digesting a match costs no measurable frame time, being once per handover.

---

### [ITEM-022] Determinism Audit: One Match RNG, a Version Gate, and Float Discipline
**Type:** Refactor / Architecture  
**Priority:** P1  
**Status:** Ready  
**Milestone:** M2 — Tactical Depth  

#### Why
Prerequisite for `ITEM-023`. Re-deriving a fight from intent only works if both peers take
exactly the same steps, and three things currently make that untrue or unproven.

#### Change
1. **One match RNG, drawn only by rules.** Today the acting peer alone draws, so the two
   peers' stream positions differ by construction. Under intent-only they both draw, in the
   same order — which means any draw from outside the rules layer (an FX jitter, a HUD
   preview that samples, a visibility recompute) desynchronises the match. Make the match
   stream reachable only from the rules, and prove no other caller touches it.
2. **A protocol and build version in the handshake**, refused on mismatch. This project
   deploys to Pages on every push, so two peers on different commits is the ordinary case
   rather than an exotic one; different builds must decline to connect instead of quietly
   diverging.
3. **A float audit of the rules path.** IEEE basics and `sqrt` are bitwise deterministic;
   `Math.sin`/`exp`/`pow` are implementation-defined across engine versions. Find every
   transcendental that feeds a *decision* (as opposed to a camera or a mesh) and quantise
   before the branch.
4. **Identical entity ids and iteration order** as a stated invariant, with a test: both peers
   build the same entities in the same order, and nothing in the rules iterates a collection
   whose order is incidental.

#### Notes
The stream fragility here is measured, not hypothetical: adding one attribute roll per
character shifted every die in a 400-match sweep downstream and nearly caused a balance result
to be mis-attributed (see `ITEM-005` and the attribute refactor). Under intent-only that
fragility stops being an ordering problem and becomes a *version* problem, which is why the
gate in point 2 is not optional.

#### Affected Files
- `src/core/rng.ts`
- `src/core/Ballistics.ts`
- `src/game/NetworkManager.ts`
- `src/ecs/World.ts`
- `src/sim/SimMatch.ts`

#### Acceptance Criteria
- [ ] The match stream has exactly one set of callers, all inside the rules layer, enforced by
      a test.
- [ ] Peers on different protocol versions refuse the connection with a stated reason.
- [ ] Every transcendental feeding a rules decision is identified, and each is either removed
      or quantised before it branches.
- [ ] `bun run balance` reports byte-identically before and after: this item must move no rule.

---

### [ITEM-023] Intent-Only Wire
**Type:** Refactor / Architecture  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M2 — Tactical Depth  

#### Why
The payoff. With `ITEM-020`, `ITEM-021` and `ITEM-022` in place, a resolved outcome no longer
needs to travel: intent plus identical state and identical steps produces the same fight on
both sides. The wire shrinks to what one peer *decided*, and the asymmetry that caused three
bugs goes away — not because everyone remembers a rule, but because the attacker never needs a
fact it does not own.

#### Change
1. `fireShot` and `throwGrenade` carry intent only. `WireHit`, `toWireHits`/`fromWireHits` and
   the resolved-hit replay path are deleted, not deprecated.
2. Replication narrows to state that genuinely is not derivable.
3. Recordings become the same thing as the wire: a replay and a remote peer consume one format,
   which is already how the recorder behaves.

#### Blocker
`ITEM-020` and `ITEM-021` must have run green across real matches first — the mismatch rate is
the evidence, and attempting this without it is a leap of faith dressed as a refactor. And two
authorities must not both write: this item removes the resolved payload *and* narrows
`World.syncDirty`, or replication and local simulation will fight over the same state.

#### Notes
This forecloses one thing permanently and it should be a deliberate choice, not a discovery:
under intent-only, both clients hold all state, so **no information can be secret at the
protocol level** — only at the UI level. That is already true today (sheets arrive in the
`ready` handshake and `FogOfWar` computes both sides' visibility locally), so nothing
regresses; but the stealth draft's enemy awareness and any future hidden-information mechanic
can then never be more than a polite fiction without a referee. See
[Noise & Stealth](../design/gdd/noise-and-stealth.md).

#### Affected Files
- `src/game/NetworkManager.ts`
- `src/game/InteractionController.ts`
- `src/ecs/systems/CombatSystem.ts`
- `src/ecs/World.ts`
- `tests/network.test.ts`

#### Acceptance Criteria
- [ ] A shot and a grenade replicate with intent only; `WireHit` no longer exists.
- [ ] Two peers play a full match with no digest mismatch and no resolved payloads.
- [ ] A recording and a peer consume the same frames.
- [ ] `bun run balance` reports byte-identically: the rules must not move.
