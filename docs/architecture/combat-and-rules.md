---
title: "Combat, Ballistics & Rule Engine"
id: "ARCH-COMBAT-RULES"
type: "architecture"
status: "active"
lastReviewed: "2026-09-17"
appliesTo:
  - "src/core/Arsenal.ts"
  - "src/core/Characters.ts"
  - "src/core/Ballistics.ts"
  - "src/core/Visibility.ts"
  - "src/core/Cover.ts"
  - "src/game/Combat.ts"
  - "src/core/Fire.ts"
  - "src/core/Surfaces.ts"
  - "src/core/Morale.ts"
  - "src/game/Breakdown.ts"
  - "src/core/Traits.ts"
  - "src/core/Items.ts"
relatedDocs:
  - "docs/architecture/overview.md"
  - "docs/design/gdd/combat-mechanics.md"
  - "docs/design/gdd/progression-and-meta.md"
tags: ["combat", "ballistics", "rules", "los", "cover"]
---

# Combat, Ballistics & Rule Engine

## 1. Line of Sight (LOS) & Visibility

Grid visibility is computed purely in 2D/3D integer coordinates using high-speed DDA ray marching (`src/core/Visibility.ts` and `src/core/Occlusion.ts`):
- **Zero Raycasting in Core**: Physics raycasting is not used for gameplay checks; raycasters are restricted to pointer input picking in `InteractionController.ts`.
- **Wall Occlusion**: Solid wall components block vision unless destroyed or low-profile.

---

## 2. Ballistic Equations & Hit Probability

### Hit Calculation: projectiles are straight lines
Every round fires one or more **projectiles**, and each is a straight line that misses by some
error `e`. It lands on a target of presented half-width `w` with probability

$$P = \frac{w^2}{w^2 + e^2}, \qquad e = (\text{sway} + \text{spread} \times d) \times \text{mode} \times \text{training}, \qquad w = \text{size} \times \text{visible} \times (1 - \text{evasion})$$

`hitChance` (`src/core/Ballistics.ts`) returns `ShotOdds`: the chance the **round** lands (any
of its projectiles), the chance one projectile does, and how many are expected to land given
the round does. Multiplication and division only, so both peers compute the same number.

- **Weapon** (`Arsenal`): `sway` (metres of error at no distance — how steady it is in the
  hands), `spread` (metres per metre — how the error grows), `pellets` (lines per round: 1 for a
  bullet, 9 for a shell), and `damage` / `armorPen` per projectile. Out of `maxRange` the chance
  is 0 outright.
- **Mode** (`SHOT_MODES[mode].spreadMul`): aimed ×0.5, snap ×1, burst ×1.1, reaction ×1.4.
- **Training**: proficiency tightens the error by `AIM.trainingTighten` per point, a status
  penalty (flashed, suppressed) widens it by the same; clamped between 0.2× and 3×. Carried
  glass and the loaded round scale `spread` only (`rangeFalloff`, `rangePenaltyMul`), floored at
  zero.
- **Target**: `AIM.targetSize` (0.3 m) × the **visible share** for its stance and the cover the
  line crosses (`COVER`: open crouched 0.55, low cover 0.6 standing / 0.33 crouched, tall cover
  0.27 / 0.14) × `1 − AIM.evasionShrink × (evasion + status defence)`. Evasion below zero is
  treated as zero. **From behind** — the shooter in the target's rear half-plane by its
  `heading` (`fromBehind`, `src/core/Facing.ts`) — evasion and status defence count for
  nothing; cover still does.
- **Clamps**: one projectile never exceeds `AIM.max`; the *round* never falls below `AIM.min`.
  A floor per pellet would make a shell at the far end of its range land a third of the time.
- **A round** lands if any projectile does. Each projectile is its own roll from the match
  stream, in order, then one crit roll if anything landed. **Armour is taken off the round once**
  — `resolveDamage(…, landed)` sums the landed projectiles first — and the minimum damage is per
  round, so buckshot is impact rather than penetration and base armour blunts it without
  zeroing it.
- **Consequence, not rule**: a shotgun's damage falls with distance because fewer pellets
  land. Calibrated so it out-damages a rifle about twofold inside a room and draws level at
  about 7 m (9 pellets × 14). The rifle, gatling and sniper were fitted to the additive model
  this replaced, within a few points at 4–20 m.
- **What a player sees** is the round's chance and its damage when it lands (for a shell, with
  the pellets expected at that distance), plus AP and rounds. `expectedRoundDamage` is the same
  estimate for the AI. Spread, pellets and crit are on the loadout screen and in the
  [catalogue](../design/gdd/status-and-trait-catalog.md).

### Critical Hit Calculation
`critBreakdown` takes the weapon's own chance — with the holder's trait bonuses already folded
in by `effectiveWeapon` — and moves it by two things:

$$\text{crit}\% = \text{clamp}\Big(w_{\text{crit}} + S \cdot b_w\big(2\tfrac{d}{R_w} - 1\big) - A \cdot \text{armour} \cdot (1 - \text{pen})\Big)$$

- **Range swing** (`CRIT.rangeSwing`, `b_w` = the weapon's `critRangeBias`): the full swing at
  either extreme of the weapon's reach and nothing at its midpoint. A shotgun's bias is -1, a
  sniper rifle's +1, a service rifle's 0.
- **Armour resistance** (`CRIT.armorResist`): only the plate a round does not punch through,
  so armour-piercing keeps its chance at the vitals where buckshot loses nearly all of it.
- **Immunity short-circuits all of it**: a target with `critImmune` yields chance 0 and a
  multiplier of 1, whatever the weapon, the distance or the roll.
- A crit multiplies the round **before** armour subtracts, so plate blunts a critical hit with
  the same flat bite it takes out of an ordinary one rather than being bypassed.

### Where a modifier comes from
A unit's effective numbers are one additive fold over four sources, none of which normally
knows about the others: the **character sheet** it was rolled with, **wounds** derived from its
current health, **body-worn kit** in its pockets, and **attachments fitted to the weapon in
its hands**. A weapon is an instance with a serial and a rail whose size depends on its
class, so glass follows the rifle rather than the soldier — and swapping weapon drops what
was on the old one.

#### The sheet: four attributes, every number derived
A sheet is dealt four numbers — Health, Agility, Strength, Intelligence — each rolled on the
one scale in `CHARACTER.attribute`. Nothing tactical is rolled *beside* them: `derive()`
(`src/core/Characters.ts`) reads each attribute linearly onto the band its stat lives in, the
bottom of the scale landing on the bottom of the band and the top on the top. A stat is
therefore described entirely by its two ends in `CHARACTER` and needs no curve of its own,
and a band may run backwards — `itemApDelta` does, which is how an attribute makes kit
*cheaper* as it rises.

| Attribute | Derived stats | Band in `CHARACTER` |
| --- | --- | --- |
| Health | `maxHp`, `healBonus` | `hp`, `healBonus` |
| Agility | `maxAp`, `evasion` | `ap`, `evasion` |
| Strength | `throwRange`, `carrySlots`, `gearRelief`, `meleeSkill`, `meleePower` | `throwRange`, `carrySlots`, `gearRelief`, `meleeSkill`, `meleePower` |
| Intelligence | `itemApDelta` | `itemApDelta` (runs backwards, floored at 1 AP by `itemApCost`) |

AP and evasion sharing Agility is a deliberate coupling, not a shortage of attributes: a
quick character should be both harder to line up and able to do more with a turn, so the two
move together instead of being two unrelated dice that could disagree about the same person.

Intelligence is read **raw as well as banded**: the band amplifies kit (`itemApDelta`), while
the attribute itself gates it — an `ItemSpec.minIntelligence` is refused by `canUse`, which is
also the predicate that greys the HUD row, and refused again inside `use` ahead of the replay
bypass, so a peer cannot make this side work kit its character cannot work.

**Beside the four attributes the sheet also carries training**, which is rolled rather than
derived: a weapon-class accuracy per class with a bonus for the one specialism, and a
`utility` percent per discipline — Medical, Demolitions, Mechanics. Physique is rolled once
and read onto bands; training is a separate axis because it is what practice moves, and it is
the field organic growth will later write to. Each discipline scales exactly one thing:
Demolitions the blast radius and armour shred of ordnance *this* character throws (stamped
into the unit's own grenade specs, so every consumer reads the thrower's real numbers),
Medical the hit points a treatment this character applies to **another** unit restores,
Mechanics the armour a repair brings back and what the repair costs in points. Utility bands
run negative as well as positive, so the untrained end of one is a penalty and not merely an
absent bonus. `sanitizeSheet` clamps utility exactly as it clamps weapon proficiency.

`derive()` is a pure function of the attributes and of nothing else — not gear, not wounds,
not stance, which are the trait fold's business and are added on top of these. It is a
function rather than a getter, so a caller takes the result into a local once instead of
re-deriving per read.

**The wire consequence** is the load-bearing part: a sheet carries attributes, not ceilings.
Sheets arrive from a peer in the start handshake, and `sanitizeSheet` has four integers to
clamp to `CHARACTER.attribute`, plus a specialism and a trait list to recognise. A peer
cannot state a hit-point ceiling, an evasion or a carry limit *at all* — no such field exists
to send, and each side derives them from attributes it has clamped itself. The envelope is
unforgeable by construction rather than by validation: there is no absurd maximum to reject,
only a field that was never there.

#### What the fold knows about where a modifier came from
The fold is **source-blind by default, with a source-aware fold beside it** rather than in
place of it. Source-blindness is the property that lets a vest and a bloodline grant the same
modifier without either knowing the other exists, and it is still what every rule reads.

- `TraitSource` is `innate | wound | gear` — three, not four, because worn kit and a fitted
  attachment are both gear and no rule has wanted to tell a vest from a scope. A `SourcedTrait`
  is an id together with its source.
- `resolveSourcedInto(out, traits, source?)` is the same fold over tagged traits, filtered to
  one source when asked. With no source it is exactly the source-blind fold. `resolveTraits` /
  `resolveTraitsInto` are unchanged and remain the default; a unit keeps a full fold and a
  gear-only fold side by side and exposes `gearOnlyTraits`.
- **One combining rule.** `addEffects` is the single place that knows how each `TraitEffects`
  field combines — numbers sum, flags OR — and both folds go through it. That is the whole
  defence against the obvious hazard of a second fold: a newly added field cannot be honoured
  by one fold and silently dropped by the other.

**Exactly one rule consumes the attribution**: `gearRelief`, a percent off Strength, cancels
that share of what *gear* does to a unit's step price and action-point ceiling. It is
deliberately narrow in three ways — gear only (a limp is not something broad shoulders undo),
penalties only (kit that helps a unit move or hands it a point is never eaten, so being strong
cannot cancel a benefit), and movement and points only (carrying the weight is not the same as
being a smaller target, so plate's evasion cost stands whoever wears it). Heavy plate costs a
point as well as speed for this rule to have anything to answer.

Only the properties an *enemy* has to read are replicated (`TraitsComponent`: evasion, its
crouched half, crit immunity, step cost, damage taken). Everything a modifier does to its
own unit is either folded locally or already inside the numbers an attack carries, because
this side holds only a stock copy of the other squad's kit.

Current values for every trait, status, attachment and piece of kit named here live in the
generated [status and trait catalogue](../design/gdd/status-and-trait-catalog.md).

---

### Melee: a blow with the sidearm
Every soldier carries a **sidearm** in its own loadout slot, beside the primary weapon
(`UnitLoadout.sidearm`, stored on `InventoryComponent` and replicated). An empty slot is
`MeleeId.Fists`. The table is `MELEE` in `src/core/Melee.ts`; numbers in the
[catalogue](../design/gdd/status-and-trait-catalog.md#5-sidearms).

- **Reach** (`canMelee`): a neighbouring tile, diagonals included, on the same level, with line
  of sight between — a solid wall on the shared edge stops a blow, a parapet does not. Points
  enough for the sidearm; no range band and no ammunition.
- **Chance** (`meleeChance`): the sidearm's own accuracy plus the attacker's Strength
  (`meleeSkill`), minus the defender's evasion and **parry** — their sidearm's plus what their
  primary weapon is worth held across them (`LONG_GUN_PARRY`: a scoped rifle is a liability).
  Status penalties apply as for a shot. No range term and **no cover term**: that absence is
  what melee is for. One draw, a contest folded into one roll.
- **From behind** (the attacker on one of the three tiles at the defender's back): no parry,
  no evasion, no status defence — only the attacker's own condition counts — and the blow's
  damage is multiplied by the sidearm's `fromBehind`: **5× for a knife**, 1× for fists and the
  club. A knife from behind kills anyone in the ordinary health band through a full plate
  carrier; a very large, plated soldier can survive a weak knifer. It is not an outright kill.
- **Damage** (`meleeWeapon` → `resolveDamage`): the same armour arithmetic as a round. Strength
  scales the blow (`meleePower`); armour penetration and shred are what separate the families —
  fists barely dent plate, a club keeps its damage through it and strips it. Crits use
  `critBreakdown` with no distance term; a club has no crit chance at all.
- **Consequences** (`executeMelee`): contact makes both units `known`; an audible sidearm
  (`loudness > 0`: the club) sets `firedThisTurn` like a shot. No suppression. At most two draws from the match stream in a fixed
  order — the blow, then the crit if it landed and the weapon can crit.

**Facing is a rule quantity.** `PositionComponent.heading` is one of eight compass directions
(`HEADINGS`), set by a step (the direction walked), a shot or a blow (toward the target) and a
facing order — each worked out from tile or world offsets by comparison alone, since
`targetYaw` is a float from `atan2` and banned from rules code. It replicates and is in the
state digest. A non-lethal knockout belongs with the campaign roster (ITEM-012).

### Noise
Every step, shot, audible blow and grenade is a `Noise` (`src/core/Noise.ts`): a tile, the
side that made it, and a **loudness** — metres an ordinary ear hears it at. A listener of the
other side hears it when `dx² + dy² ≤ (loudness × hearing)²`: inverse-square falloff against
the listener's own threshold, `hearing` being `1 + derive(sheet).hearing / 100` from
Intelligence. Squares and products only, so both peers agree about who heard what; walls do
not muffle. Sources: `NOISE.step` (4 m) / `NOISE.crouchStep` (0.9 m), `Weapon.loudness` (40–55 m,
× `NOISE.suppressed` = 0.25 behind a suppressor), `MeleeSpec.loudness` (0 or 12 m),
`GrenadeSpec.loudness` (frag 1000 m — every map; flash 20; smoke 6), a grenade's heard where it
lands. `CommandSystem.onNoise(noise, heard)` reports each noise somebody heard. Knowledge of a
noise is `roughly(at)` — the middle of the 3×3 block — and never a firing solution.

### Awareness
`AwarenessComponent` (replicated, digested): **unaware**, **alerted** or **engaged**
(`src/core/Awareness.ts`). A unit that hears a noise and is not engaged is alerted and turns
toward it (`hear`: heading to the nearest of eight directions). Firing, being shot at, a blow
either way and an enemy grenade engage (`engage`, called from the resolvers where `known` is
set). After every step, command and handover `lookAround` engages any unit that sees an enemy
— all round on its own side's turn, only strictly in front (`inFront`) on the other side's, until
it is engaged. A watcher that is not engaged reacts only to what is in front of it
(`reactToArrival`). An alerted unit that hears nothing new for `CALM_AFTER` (2) of its own
turns settles back to unaware (`calmDown`, in `settleTurn`). Engaged does not wear off.

### Glass and the stone
A shot, a reaction or a throw whose line passes through glazing breaks it: `glassCrossed`
(`core/Visibility`, the same `walkLine` that decides sight) lists the panes, `CombatSystem`
reports each through `onGlass`, and `CommandSystem` sets the wall to `WallKind.None` through
`WallSystem.setKind` — the replicated component and the grid together — and makes it a noise at
the window (`NOISE.glass`, 15 m). `MatchHost` now holds wall entities too, so a broken window is
state there as in a played match. The **stone** is a `GrenadeId` with no damage and no status
(`harmless`): the throw reveals nobody and catches nobody; it is heard (8 m) where it lands.
`GrenadeSpec.issued` — two for a stone — is carried by every soldier outside the crate and the
grenade cap (`applyUnitLoadout`).

### Doors
A door is a wall kind with a state (`src/core/Doors.ts`, numbers in `DOORS`): **shut**
(`WallKind.Door`), **open** (`DoorOpen`) or **locked** (`Locked`); kicked in, it is `None`. So a
door's state is its `WallComponent.kind`, written only through `WallSystem.setKind`, replicated,
digested and rewound with every other wall. Shut or locked it is masonry to sight, cover and
bullets (`WALLS`); open it is `open` like `None`, which is also what lets fire and smoke through.

- **Walking through** a shut door is allowed (`Grid.canTraverse`) and costs `DOORS.openAp` on top
  of the step (`Grid.getStepCost`), so every planner — the player's, the sweep's, a broken unit's
  — prices it. The rules open it as the unit arrives (`CommandSystem`'s step handler), before
  anybody looks round or reacts.
- **`operateDoor`** works the door on a side of the unit's own tile: open, close, unlock (needs an
  item with `unlocks` — the keys, not used up) or force (`DOORS.forceAp`, heard at `NOISE.force`,
  gives at `CHARACTER.shoulder` percent from the match's dice, and a door forced is gone for
  good). `cannotWorkDoor` is asked on both peers, not only the sender's. The HUD offers the verbs
  for the door the unit faces (`doorAhead`).
- **The map** hangs doors in the doorways round 3 cut (`hangDoors`, on a stream of its own) once
  the terrain is final, only between two walkable tiles on one floor (`DOOR_CHANCE`: 60% of
  interior doorways, 80% of the ways in). It locks some (`LOCK_CHANCE`: 10% inside, 35% into a
  building), and puts a lock back to a shut door if it left any tile reachable from Blue's first
  spawn only through a lock — so a lock is a reason to go round, never a sealed room.
- **The sweep's policy** walks through shut doors (they are in its routes at their price) and
  treats a locked one as a wall: it never unlocks, forces, opens or shuts a door on purpose.

### Morale
`MoraleComponent` (replicated, digested): **morale** 0–100, the **break** a unit is in, and the
turns it has begun broken (`src/core/Morale.ts`, numbers in `MORALE`). `CombatSystem` calls
`shake` after every shot, reaction, blow and throw, reading the resolved hits: a wound costs the
wounded ½ point per percent of its max HP, each round that went past the target costs it 3, a
death costs every squadmate 20 and pays the killer 15 and its squadmates 5 (friendly fire pays
nobody; a death is counted once, however many rounds land on the body).

At each handover, after the incoming side's points are handed back, `CommandSystem` calls
`rollMorale` with the match's dice. In squad order, each unit's predisposition pulls first
(`lean`: a daredevil +10 when its side is outnumbered or it is below half health, −5 when its
side outnumbers the other by two; a teamplayer +5 while every squadmate is above half health).
Then a broken unit rolls to steady at `steadyChance` — 25% on the first of its turns after
breaking, +25% each turn after, so certain on the fourth — and comes back to at least steady
(50); anyone else below steady rolls to break at 2% per point short. Which way it breaks is not
drawn (`breakKind`): **freeze** at 25 morale or more, below that **frenzy** for a hothead and
**panic** for a skittish one, and always frenzy for a daredevil. A unit that holds gets 5 back,
10 within two tiles of a holding teamplayer; each break costs the breaker's squadmates 10,
after every roll is made. A loner takes none of the squad's losses, breaks or kills, and no
teamplayer's company. Temperament is on the sheet (`CharacterSheet.temperament`, checked by
`sanitizeSheet`); a predisposition is an innate trait with no combat effects. Nobody at steady or
above draws, so a match in which nobody was shaken draws what it drew before morale existed.

A frozen unit's points go to zero (taken, not spent: exhaustion does not see them). Panicking
and frenzied units are then run by the rules (`src/game/Breakdown.ts`), one command at a time,
each asked for after the last was carried out and walked, with the origin `rules`. The runs go
to the *front* of the applier's queue: a peer's commands for the turn can already be waiting
behind the handover, and they were decided after the runs, on the peer that made them.

- **panic**: stand, walk to the reachable tile in sight of the fewest enemies its side can see,
  farthest from the nearest of them, then crouch if it can afford to. Seeing nobody, it cowers.
- **frenzy**: strike the nearest enemy its side can see if in reach; otherwise charge to the
  reachable tile nearest it, then strike or fire the cheapest shot until the points or the rounds
  run out, reloading an empty weapon once. Seeing nobody, it goes on watch.

Integer comparisons only, ties by squad order and tile index, and only enemies the unit's own side
can see — a flight away from an enemy nobody has spotted would tell its player where they are.
The run ends with `endUnitTurn`. A broken unit refuses every command from any other origin
except `endUnitTurn`, and a `local` command is refused while the rules are still running anyone.

### Fire
Every tile has a surface (`src/core/Surfaces.ts`: paving, dry grass, concrete, timber, ash), laid
by the map generator on a stream of its own; a crate is timber in its own right. What burns and
for how long is read off the surface's `flammability` and `burns`, or the crate's where higher
(`core/Fire`: `flammability`, `burnTime`). Ground state lives on one entity (`GroundComponent`)
written only by `GroundSystem`, which keeps `Grid.fire` / `Grid.smoke` and the burned surfaces
and blocks in step.

- **Started** by the incendiary grenade (`GrenadeSpec.ignites`): `CommandSystem` calls `kindle`
  after the throw — every tile within `areaRadius` on the landing tile's floor, reached without
  a wall, burns for `ignites` handovers or its own burn time if longer — and burns whoever is
  standing there.
- **Spreads** at each handover (`burn`, from the match's dice, before morale is rolled): each
  tile burning at the start, in index order, tries each orthogonal neighbour in `ORTHOGONAL`
  order that is on its floor, has no wall on the shared edge, is not burning, and can burn —
  one draw against the neighbour's flammability. Then every tile that was burning burns down
  by one; at nothing it has burned out: a floor that burns becomes ash, a crate is gone.
  What caught starts burning next handover.
- **Hurts** (`CombatSystem.burn`): `FIRE.damage` (15) with armour ignored, and the morale a
  wound costs, to a unit that steps onto a burning tile (after any reaction to the step), to
  the incoming side's units standing in fire at a handover, and to whoever a blast sets
  alight. Nobody is credited with a death by fire.
- **Kept out of** by the sweep's policy only: `tryReposition` passes `burningTiles` to the
  pathfinder as ground it cannot cross, and `chooseDestination` counts `FIRE.damage` as exposure
  on a burning tile, so a unit standing in fire walks out. A broken unit's run (`Breakdown`)
  does not look at fire at all, by design.

### Smoke
Smoke is `Grid.smoke`, turns left per tile, written by `GroundSystem` like fire. The smoke
grenade (`GrenadeSpec.smokes`, 4 handovers) fills its blast through `billow`: every tile within
`areaRadius` on the landing floor that a line from the centre reaches without crossing any wall
(glass included). A burning tile smokes for its fire's turns plus one. At each handover, before
the fire moves, all smoke thins by one. **Sight** (`hasLineOfSight`, so fog, watchers, the AI's
knowledge, the shot overlay and melee reach alike) is blocked by a line that enters a smoky tile —
the target's included — or starts in one, unless the two tiles are neighbours. The old `Smoked`
status (a defence bonus on whoever stood in the blast) is gone.

### The service record, and after the match
Every soldier carries `DeedsComponent` (replicated, digested, rewound with the unit), written by
the rules on both peers: `CombatSystem.record` at every shot, reaction, blow, throw and burn
(rounds landed and crits by the shooter's weapon class, deaths counted once per victim, damage
taken by every victim, and whether the attacker's target had not seen it coming — judged before
the attack engages it); `CommandSystem` at each step (tiles in gear that drags), each use of kit
that asks for Intelligence, each lock opened with keys or forced, and at the handover (the
outgoing side's turns spent to the last point that will not wind them). Friendly fire teaches
nobody. Nothing in a match reads the record.

Once one side has nobody standing (`game/MatchEnd.winnerOf`), `debrief` turns the winning side's
survivors' records into growth with `core/Progression.growthFrom` — a pure function of the sheet
going in and the record (numbers in `PROGRESSION`, catalogue §10) — and the controller shows the
end screen (`HudModel.endScreens`): in a local match the loser's "you lost", then the winner's
survivors; online, each side its own. The losing side learns nothing; `carriedOut` picks one of
its fallen to leave the match alive on 1 HP, from a stream of the match seed (so both peers pick
the same one, and the match's dice are untouched), preferring one not lying in fire. `grown`
applies growth to a sheet; nothing stores either yet (ITEM-012). The sweep reports records and
growth (`progression:` line).

## 3. Damage Resolution & Armor

```mermaid
sequenceDiagram
    autonumber
    actor Shooter
    participant Combat as Combat Resolver
    actor Target

    Shooter->>Combat: fireWeapon(mode, target)
    Combat->>Combat: Roll D100 vs Hit Chance
    alt Hit Missed
        Combat-->>Target: Emit Miss / Suppression Event
    else Hit Landed
        Combat->>Combat: Roll Crit Chance
        Combat->>Combat: Calculate Raw Damage
        Combat->>Target: Apply Armor Absorption & Shred
        Combat->>Target: Deduct Remaining Damage from HP
        alt HP <= 0
            Combat->>Target: Set isDead = true
        end
    end
```

- **Armour absorption**: the target's armour is subtracted flat from each round, but only the
  share the round fails to penetrate — `armour × (1 - armorPen)`. Every hit still does at least
  `AIM.minDamage`, so armour can blunt a weapon and never makes a unit immune to it. That floor
  is why a piece of kit meant to survive burst fire reduces damage by a *fraction*
  (`TraitEffects.damageTaken`) rather than adding armour points: against many small rounds the
  base plate already floors them, and further points buy nothing.
- **Status and gear both pull on the same number**: `1 + statusDamageTaken + gearDamageTaken`,
  added rather than compounded, so a plated unit under a shred takes both and neither
  multiplies the other into something unintended.
- **Armour shredding**: high-penetration rounds and explosives reduce armour for the rest of
  the match — unless somebody spends a turn on it. A repair kit is the only thing that undoes
  permanent loss, which is what earns it a pouch slot; it needs Intelligence to operate and a
  mechanic's training makes it both cheaper and worth more.
- **Suppression**: rounds that *miss* stack `Suppressed` on the target (accuracy and points,
  per stack, pinned at the cap). It is derived on both sides rather than sent — `executeShot`
  counts the rounds that went past and `replayShot` counts the false entries in the rolls it
  was given, so no message had to grow.
- **Wounds**: `Limping` at or below half health and `Concussed` at or below a quarter, from
  `woundTraits(hp, maxHp)`. They are **derived from current health, not stamped on** when a
  threshold is crossed: hit points already replicate, so both peers reach the same answer with
  nothing sent, there is no threshold hysteresis to get wrong, and healing genuinely lifts
  them. `Winded` is a separate thing — a *status* from exhaustion, not a wound.
