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
Squads are rolled randomly per match and forgotten upon exit — and per
[RFC-0001](../design/rfc/0001-referee-and-transports.md) §9, persistence is the foundation the
rest of the GDD stands on rather than a feature bolted onto combat. Base building, the economy
and a campaign roster all need a store of record before any of them can begin.

#### Change
A store of record for rosters and for **matches as event logs**, not a save file.

1. `localStorage` is the offline and demo store, not the store of record. Once a server exists
   the roster lives there, and the handshake stops carrying saved sheets at all — which
   *simplifies* the trust story rather than complicating it: a peer cannot send a tampered
   roster if it does not send one.
2. A match is stored as its intent log (`ITEM-023`), so what persists is what happened rather
   than a summary of it. Replaying a log is how a roster is derived, how a crashed client
   rejoins (`ITEM-025`) and how a disputed match is audited — one artefact, three uses.
3. Character sheets carry XP, promotions and untreated wounds across matches.

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
In the serverless modes this changes what the handshake means: peers would send *saved*
rosters, making `sanitizeSheet` load-bearing against local tampering as well as a hostile peer.
With a server it goes the other way — nobody sends a roster.

Depends on `ITEM-022`: a stored log that cannot be replayed deterministically is not a store of
record, it is a diary.

#### Affected Files
- `src/core/Characters.ts`
- `src/game/Recording.ts`
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
**Status:** In Progress — landed for shots and grenades; see the note on what is not exercised  
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
- [x] A received `fireShot` is re-derived locally and compared; agreement is silent.
- [x] A deliberately unreplicated defensive property makes the comparison fire, in a test.
      Proven red the useful way: the first implementation rebuilt the unit from its sheet and
      kit, which re-folds its traits and therefore could not see a replicated property at all.
      The test failed, and the shadow became a delegate over the live unit instead.
- [x] A received `throwGrenade` is compared per victim, including the receiver's own units.
- [x] The comparison consumes no match randomness and changes no applied outcome — the crit
      outcomes are replayed from the sender's own flags, and a test snapshots every unit's hp,
      armour, AP, clip, statuses and reveal state across a shadow run.
- [x] Exercised end to end, without a browser. `bun run replay` (`src/sim/Replay.ts`) runs a
      recorded intent stream through the real systems, and every shot in the file arrives
      exactly as a peer's does — resolved numbers, the dice that produced them, the chance they
      were rolled against. A recorded 57-event match replays with **no divergence**, and two
      tampering tests prove the check is not vacuous: one point added to a single hit is caught
      and named, and a claimed hit chance the state does not support is caught on a shot that
      missed.
- [ ] Observed between two live browser peers. Still blocked on tooling rather than code
      (browser device `ELOOP`, no X server for headful Chrome), and now largely redundant: the
      replay path and the peer path are the same two call sites' worth of logic, and the replay
      runs in CI.

---

### [ITEM-021] State Checksum at the Turn Boundary
**Type:** Refactor / Architecture  
**Priority:** P1  
**Status:** In Progress — landed; live two-peer observation still outstanding  
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
- [x] Both peers agree on a digest for an identical world, and the digest is stable across
      component insertion order — keys are sorted before hashing, and the fold over entities is
      commutative because the entities a world holds are a set.
- [x] A single mutated component on one side is reported at the next handover, naming the
      component and the entity. Units carry a hash per component; everything else folds into
      one number for terrain and one for the rule tables, so a wall drifting says *terrain*
      rather than costing a hash per wall per turn.
- [x] Digesting a match costs no measurable frame time: 40 digests — a whole match — are
      pinned under a single frame's budget, and it runs once per handover rather than per frame.
- [x] Exercised end to end by the replay runner: two runs of one recorded match reach the same
      digest, which is the property a stored match must have before a roster can be derived
      from it — and the one rejoin will stand on.
- [ ] Observed between two live browser peers. Same tooling block as `ITEM-020`.

#### Found by this item
The digest went red between two *identical* worlds, and the only thing differing was a weapon's
**serial**. It came from a process-local counter, so two peers agreed on it only by luck of how
many templates each had cloned — and the loadout screen clones one on every press. A serial is
now derived from who carries the weapon (`weaponSerial(faction, squadIndex, weaponId)`), which
both sides compute without it travelling, and a 400-match sweep is byte-identical across the
change. This is exactly the class of drift `ITEM-022` exists to remove, found by the check
built to notice it.

---

### [ITEM-022] Determinism Audit: One Match RNG, a Version Gate, and Float Discipline
**Type:** Refactor / Architecture  
**Priority:** P1  
**Status:** In Progress — all four points landed; symmetric drawing waits on `ITEM-023`  
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
- [x] The match stream has exactly one set of callers, all inside the rules layer, enforced by
      a test. `matchDice(seed)` is the only source; `Math.random` is gone from `src/core`,
      `src/ecs`, `src/sim` and `src/game`, with `resolveSeed` the single stated exception
      (choosing a seed is what *creates* the stream). The defaults that hid the problem are
      gone too: a resolver without dice no longer compiles.
      **Still asymmetric**: only the acting side draws, because outcomes still travel. Both
      sides draw in step when `ITEM-023` lands, which is the point of having the stream now.
- [x] Peers on different protocol versions refuse the connection with a stated reason.
      `src/version.ts` states a hand-maintained protocol number and the commit the bundle was
      built from; the gate is checked on both first frames — the host's `init` and the joiner's
      new `hello` — refuses with prose a player can act on, latches so a refused peer gets no
      second chance, and the join screen shows the reason instead of blaming the peer id.
- [x] Every transcendental feeding a rules decision is identified, and each is either removed
      or quantised before it branches. Inventory: `Math.hypot` (every distance, so every range
      check, hit chance and blast radius) and `Math.atan2` (facing). `sqrt` is correctly
      rounded by IEEE 754 and `hypot` is a library routine with implementation-defined
      accuracy, so distance is now squares and one root; a facing is quantised to a thousandth
      of a radian, far finer than anything visible, because it is replicated *and* digested.
      A test refuses both functions anywhere the rules can see them, and was proven red by
      putting each back.
- [x] Identical entity ids and iteration order, with a test: two peers dealt the same match
      number their entities the same and reach the same digest.
- [x] `bun run balance` reports byte-identically before and after: 400 matches at seed 1000,
      unchanged across the dice threading and the float work.

---

### [ITEM-023] Intent-Only Wire
**Type:** Refactor / Architecture  
**Priority:** P2  
**Status:** Done — pending archive  
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

#### What it took, beyond the deletion
The replay runner refused three events on the first attempt, and the cause was the finding of
this item: `SimMatch` drew its squads *and* its dice from one stream, so how many numbers a
sheet consumed decided every roll that followed. A replay deals nobody, so it started the dice
where the sim had finished dealing and resolved a different match. That is the same fragility
measured back in the attribute refactor, when adding one attribute per character shifted every
die in a 400-match sweep. The sim now derives its dice from the seed by its own stream
(`matchDice`), setup keeps its own, and a recorded match replays into itself.

#### Blocker
`ITEM-020` and `ITEM-021` must have run green across real matches first — the mismatch rate is
the evidence, and attempting this without it is a leap of faith dressed as a refactor. And two
authorities must not both write: this item removes the resolved payload *and* narrows
`World.syncDirty`, or replication and local simulation will fight over the same state.

#### Notes
**This is the agreed destination**, not one of two options — see
[RFC-0001](../design/rfc/0001-referee-and-transports.md) §2. The trade was taken with eyes
open: both clients hold all state, so nothing is secret at the protocol level and fog of war
is a filter over what a client *draws*. That is already true today, so nothing regresses, and
the alternative — an entitlement rule, a ghost policy and a HUD story per component — was
rejected as machinery with no effect on play (`ITEM-026`).

Consequence worth stating: once a resolved outcome no longer travels, a client cannot fake a
die quietly. Dice come from the match stream in an order the rules fix, so a faked roll is not
a lie, it is a desynchronisation — which `ITEM-021` catches and a referee can attribute.

#### Affected Files
- `src/game/NetworkManager.ts`
- `src/game/InteractionController.ts`
- `src/ecs/systems/CombatSystem.ts`
- `src/ecs/World.ts`
- `tests/network.test.ts`

#### Acceptance Criteria
- [x] A shot and a grenade replicate with intent only; `WireHit` no longer exists, along with
      `toWireHits`, `fromWireHits`, `CombatSystem.replayShot`, `GrenadePlanner.replayThrow` and
      the whole of `Divergence.ts`.
- [x] A recording and a peer consume the same frames — demonstrably, since the replay runner
      applies a recorded stream through the same door the peer path uses and refuses nothing.
- [x] A full match agrees end to end: a 55-event recorded match replays with every command
      applied, and the replay reaches the same survivors as the match that produced it. Two
      carriers of the rules, one answer.
- [ ] Two *live browser* peers play a full match with no digest mismatch. Same tooling block as
      before; the replay is the standing substitute and runs in CI.
- [~] `bun run balance` byte-identical: **not achievable, and it should not be.** Splitting the
      sim's setup stream from its dice (below) re-phases every die by construction, so the
      files differ. What the sweep had to show instead is that the *balance* did not move, and
      it does not: across disjoint blocks 1000/5000/9000, blue 236/237/235 → 226/247/238 and
      red 136/142/132 → 150/131/133. Block-to-block variance is larger than the shift in either
      mean (blue 236 → 237, red 137 → 138).
---

### [ITEM-024] Transport Port: One Frame Channel, Three Implementations
**Type:** Refactor / Architecture  
**Priority:** P3  
**Status:** Deferred  
**Milestone:** M2 — Tactical Depth  

#### Why
[RFC-0001](../design/rfc/0001-referee-and-transports.md). Everything that arrives from another
process is a JSON-RPC frame, and everything that leaves is too — but the only way to move one
is PeerJS. That forecloses a referee in a worker, a referee in a process, and any test that
wants to drive two peers without a signalling broker.

The seam is already narrow, which is why this is cheap: `peerjs` appears in exactly one file,
and the whole conversation is `sendRpc(frame)` out and `handleIncomingRpc(frame)` in.

#### Change
1. A `Transport` port — `send(frame)`, `onFrame(handler)`, `onClosed(handler)`, `close()`.
2. `DataChannelTransport` wrapping today's PeerJS connection, with behaviour unchanged.
3. `SocketTransport` over `WebSocket`, browser side and `Bun.serve` side.
4. `LoopbackTransport`: a linked pair in one process, for tests. The network tests already
   hand-build a fake channel to observe what a peer would have transmitted — that is a
   transport implementation living in a test file without being called one.
5. **One codec: a JSON string, on every transport.** A socket needs a string anyway, so every
   frame is byte-identical however it travelled, and nothing has a per-transport branch.
6. `NetworkManager` takes a `Transport` rather than constructing a `Peer`.

#### Notes
**Deferred.** Nothing downstream needs it yet: the referee (`ITEM-025`) is the only consumer of
`SocketTransport`, and `ITEM-020`-`ITEM-023` all work against the existing PeerJS channel. A
port with one implementation is an abstraction looking for a second caller, so it waits until
the referee is the second caller.

The one argument that did get stronger, recorded because it is evidence rather than taste: a
linked in-process pair is how a two-peer handshake gets tested. Verifying the version gate
meant either a CDP script driving two real browser tabs through a public signalling broker, or
wiring two `NetworkManager`s to each other by hand in a test file — which is a loopback
transport written inline and not called one. The hand-wiring was the right call for one gate;
the second or third time it is needed, this item has earned itself.

#### Affected Files
- `src/game/Transport.ts` (new)
- `src/game/NetworkManager.ts`
- `tests/network.test.ts`

#### Acceptance Criteria
- [ ] `peerjs` is imported in exactly one file, and it is not `NetworkManager`.
- [ ] A match plays out over `LoopbackTransport` with no PeerJS and no broker, in a test.
- [ ] Frames are byte-identical across transports.
- [ ] Peer-to-peer play is behaviourally unchanged.

---

### [ITEM-025] Referee: The Rules, Hosted
**Type:** Feature / Architecture  
**Priority:** P2  
**Status:** Backlog  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
[RFC-0001](../design/rfc/0001-referee-and-transports.md). A campaign roster needs a home that
is not one player's tab, a crashed tab needs rebuilding, and a disagreement between two peers
needs a third opinion to become an accusation rather than a shrug.

**A witness, not an authority.** Since nothing is secret (RFC-0001 §2), the referee does not
need to be in the data path: clients still resolve locally and instantly, and the referee
recomputes the same intent stream at its own pace. It costs no latency, and a match plays on
unwatched when there is no referee at all.

What it adds is **attribution**. Two peers can already detect a disagreement (`ITEM-020`,
`ITEM-021`); neither can prove which side is wrong. A third recomputation makes it two against
one. It cannot see a maphack — that is a read, and no recomputation observes a read — and it
cannot see anything that happened before the first intent (`ITEM-027`).

#### Change
1. A referee module that drives the **existing** ECS world and systems from peer intents
   instead of from an AI policy. Not a second rule set: the resolvers already speak to narrow
   ports, `tests/headless.test.ts` already deploys a squad with no engine or canvas, and
   `src/sim/` already runs whole matches headlessly.
2. One entry point containing no rules: a `Bun.serve` process with a `websocket` handler. A
   referee in a `Worker` was struck — a witness inside one player's process cannot attribute
   anything about that player, and local versus already runs the rules in-page.
3. **Rejoin**: a client that lost its tab reconnects, receives the intent log and replays it.
   The same log the recorder already writes, which is why `ITEM-022`'s determinism work is
   load-bearing here and not merely tidy — a client that cannot reproduce the log cannot
   rejoin.
4. **Persistence**: the log and the roster are probably one store. `bun:sqlite` is built in.
5. **Abort on a foul**, per RFC-0001 §8.3: the log is kept as evidence, the abort names a side
   and a reason, and `ITEM-022`'s version gate ships first so the first player accused is not
   somebody running a stale bundle.

#### Blocker
Not blocked, but **ordered**: `ITEM-024` supplies the channel, `ITEM-022` supplies the
determinism that both attribution and rejoin stand on, and `ITEM-023` is what makes the log
the whole truth of a match. A referee over a wire that still carries resolved outcomes would
be verifying the sender's own arithmetic.

One hazard to handle before the first accusation: this project deploys on every push, so two
peers on different builds diverge innocently. Without `ITEM-022`'s version gate, the first
player this feature names as a cheat will be somebody whose browser cached yesterday's
bundle.

#### Affected Files
- `src/server/Referee.ts` (new)
- `src/server/worker.ts` (new)
- `scripts/serve-match.ts` (new)
- `src/game/NetworkManager.ts`
- `src/ecs/World.ts`

#### Acceptance Criteria
- [ ] A full match plays out with both clients as clients: no client resolves an attack.
- [ ] A client that disconnects mid-match rejoins and reaches the same state from the log.
- [ ] A foul aborts the match, names a side and a reason, and keeps the log.
- [ ] `bun run balance` still measures the same game, and says so byte-identically.

---

### [ITEM-026] Per-Peer Projection — REJECTED
**Type:** Feature  
**Priority:** —  
**Status:** Rejected  
**Milestone:** —  

#### Why it was proposed
[RFC-0001](../design/rfc/0001-referee-and-transports.md) §3.4, in its first draft. Fog of war
is a rendering filter: a client holds everything it declines to draw, which is the same
position every deterministic-lockstep RTS is in and the reason maphacks are that genre's
oldest cheat. A referee filtering `componentUpdate` frames per client would have made withheld
information actually withheld.

#### Why it is rejected
Hiding information is not one decision, it is one decision **per piece of state** — position,
sheet, action points, ammunition, statuses, grenade counts — and each needs an entitlement
rule, a ghost policy for state that has gone stale, and a HUD story for showing uncertainty. A
client that is simply *missing* an enemy leaks that the enemy moved, so ghosts are mandatory
rather than an optimisation. That is a large, permanent body of machinery, and its effect on
two friends playing each other is approximately nil.

It also costs the thing that made the accepted design cheap. Secrecy requires the referee to
be in the data path, which is a round trip per action, prediction and reconciliation on the
clients, and a match that cannot proceed when the referee is away. Dropping secrecy makes the
referee a witness instead: no latency, nothing to predict, and play continues unwatched.

Recorded rather than deleted because the reasoning is the valuable part: the accepted design
(RFC-0001 §2) knowingly accepts that a maphack is possible and unobservable, and a future
competitive mode that cannot accept that would have to reopen exactly this item.

#### Superseded by
- `ITEM-023` — intent-only wire, full knowledge on both sides.
- `ITEM-025` — the referee as a witness that attributes fouls rather than preventing peeking.

---

### [ITEM-027] Match Provenance — REJECTED
**Type:** Feature  
**Priority:** —  
**Status:** Rejected  
**Milestone:** —  

#### Why it was proposed
[RFC-0001](../design/rfc/0001-referee-and-transports.md) §8.1. Once outcomes stop travelling,
nothing after the first intent can be faked quietly — but everything before it can. The host
picks the match seed, so a host could reroll until it liked the map; each peer rolls its own
squad and sends the sheets, so a peer could roll ten squads and keep the best. Both are legal
from the first intent onward and no recomputation would ever see them. The fix was one
committed nonce each and a derived seed.

#### Why it is rejected
It defends peer-to-peer play, and peer-to-peer play is a debug utility and demo entry point —
not a mode anybody is scored in. Nothing is at stake in a match between two friends who can
both already read each other's state by design (`ITEM-026`).

And the premise expires anyway: going forward **the server rolls a new player's roster**, so
there is nothing for a client to grind. A squad becomes something a player is dealt and then
keeps, which is also what makes permadeath mean anything (`ITEM-012`) — the provenance problem
dissolves into the persistence design rather than needing a protocol of its own.

Recorded rather than deleted because the reasoning is the reusable part: a commitment scheme is
the right tool for a secret that has to be *fixed before* it is revealed, and if a competitive
mode ever needs client-chosen setup to be unforgeable, this is the shape it wants.

#### Superseded by
- `ITEM-012` — the server holds the roster, so a client never chooses one.
