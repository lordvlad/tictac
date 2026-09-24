---
title: "GDD: Squads, Progression & Meta Roster"
id: "GDD-PROGRESSION"
type: "gdd"
status: "active"
lastReviewed: "2026-09-24"
appliesTo:
  - "src/core/Characters.ts"
  - "src/config.ts"
  - "src/core/Traits.ts"
  - "src/core/Morale.ts"
  - "src/game/Breakdown.ts"
relatedDocs:
  - "docs/design/gdd/combat-mechanics.md"
tags: ["progression", "rpg", "squads", "roster", "attributes", "morale"]
---

# GDD: Squads, Progression & Meta Roster

## 1. Character Identity & Core Attributes

Characters are defined by four core attributes. These form the DNA of a unit, driving their derived tactical stats, gating equipment usage, and determining their playstyle.

### Health (Constitution)
Represents physical resilience and physiological recovery.
- **Derived Stats**: Determines Max HP.
- **Resistances**: Provides inherent Damage Reduction (DR) against small-caliber ballistics and melee attacks. Increases resilience against poison and environmental hazards (e.g., toxic gas, fire).
- **Recovery**: Grants a bonus to HP recovered when a First Aid Kit is used on them, and dictates the speed of natural healing between combat encounters in the meta-layer.

### Agility
Represents reflexes, precision, and spatial awareness.
- **Derived Stats**: Determines Max AP and baseline Evasion.
- **Mobility**: Dictates the recovery speed from agility-impeding statuses (e.g., "Winded"). Grants a chance to maintain stealth/evade detection after securing a kill, and a chance to completely evade environmental area-of-effect damage.
- **Combat Precision**: Provides inherent bonuses to Overwatch reaction fire, baseline aiming accuracy, and the accuracy/scatter reduction of thrown items (grenades).

### Strength
Represents raw physical power and load-bearing capacity.
- **Derived Stats**: Determines total inventory carry capacity and maximum throwing distance for items.
- **Equipment Gating**: Required to equip Heavy Armor and Heavy Weapons without suffering debilitating penalties. Sufficient Strength negates the inherent AP reductions normally inflicted by heavy gear.
- **Melee**: Dictates base melee damage output in close-quarters combat.

### Intelligence
Represents tactical acumen, technical literacy, and learning aptitude.
- **Progression**: Acts as a global multiplier for the speed of progression and XP gain across all other skills.
- **Utility Gating & Amplification**: Gates advanced item usage and amplifies their effects (e.g., increasing the efficiency of complex medical tools or deployables).
- **Environment**: Gates and amplifies environmental interactions, such as terminal hacking, bypassing security doors, or deciphering battlefield intel.

---

## 2. Utility Proficiencies

Beyond combat attributes, characters possess non-combat utility proficiencies that expand their tactical toolbox. These represent specialized training rather than innate physical ability:
- **Medical**: Amplifies the healing output of consumables used on others, and enables stabilization of critically wounded allies.
- **Demolitions**: Modifies the explosive radius and armor-shredding capability of grenades and breach charges.
- **Mechanics/Engineering**: Determines the speed and efficiency of repairing armor mid-match or interacting with mechanical hazards.

---

## 3. Morale, Stress & Predispositions

Units do not fight as emotionless robots; they have a psychological layer that fluctuates based on battlefield momentum.

**Status:** the morale loop and the three breaks are built (ITEM-014). Which way a character
breaks, and the predispositions that bend how their morale moves, are ITEM-033. Surges are a
proposal. Numbers are `MORALE` in `src/config.ts`, and the generated
[catalogue](status-and-trait-catalog.md) §7 lists them as shipped.

### Morale
Every soldier has **morale**, 0 to 100, starting full. It is state like hit points: replicated,
in the handover digest, and moved only by the rules, on both peers, from events both hold.

What wears it down (stress), and what builds it back:

| Event | Morale | Who |
| --- | --- | --- |
| Wounded | −½ point per percent of max HP lost | The one hit |
| A round that went past | −3 | The one shot at (the same count that suppresses) |
| A squadmate killed | −20 | Every living squadmate |
| A squadmate breaks | −10 | Every living squadmate |
| Killing an enemy | +15 | The killer |
| An enemy killed by the side | +5 | The killer's squadmates |
| A turn of its own, not broken | +5 | Everyone |

### Breaking
**The trigger is rolled, never a threshold.** At the start of each of its own turns, a unit
below **steady** (50) rolls to break: 2% per point short, so 20% at 40 and certain at 0. At 50
and above nothing is rolled. The roll comes from the match's dice, so both peers see the same
unit break.

A unit that breaks does one of three things:

- **Panic.** The rules take the unit over and it flees: stands up, runs to the reachable
  tile the fewest enemies its side can see would see it from, farthest from the nearest of
  them, and gets down if it has the points left. Seeing no enemy, it cowers where it is.
- **Frenzy.** The rules take the unit over and it throws itself into the fight: charges the
  nearest enemy its side can see, strikes it if it arrives in reach, and otherwise empties its
  cheapest shot at it. Seeing no enemy, it watches for one.
- **Freeze.** Its action points drop to zero. It does nothing, and holds no watch.

Which of the three is rolled evenly for now. **Character decides panic or frenzy** — a
daredevil charges, a coward runs — which is ITEM-033.

While broken, a unit takes no orders: the player cannot command it, and the rules refuse any
command that names it. Both players see it happen — the unit's card and an enemy's target
icon say which break it is in, and a line floats over it when it breaks and when it steadies.

### Snapping out
**Not a fixed cooldown: rolled, with rising odds.** A broken unit rolls to steady itself at the
start of each of its own turns after the one it broke on: 25% the first time, 50%, 75%, then
certainly. So a break costs at least one turn and at most four. A unit that steadies comes back
to at least steady (50) morale, so it is not rolling to break again the same turn.

### Surges (proposal)
High morale granting bonus AP or a guaranteed critical. Not built: nothing yet says what
morale *above* steady is worth, beyond distance from breaking.

### Psychological Predispositions (ITEM-033)
Characters possess inherent traits that alter how they process Stress and Morale:
- **Daredevil**: Craves adrenaline. Slowly loses Morale (gets bored) if the combat is heavily in their favor and easy. Rapidly gains Morale and shines when outnumbered, flanked, or when the situation turns dire.
- **Teamplayer**: Feeds off unit cohesion. Morale naturally boosts when the whole squad is healthy and successful. Acts as a localized aura, boosting the Morale recovery of adjacent allies.
- **Loner**: Detached from squad dynamics. Does not suffer Morale penalties when allies are downed, routed, or panic, but also receives no Morale benefits from squad-wide buffs or assists.

Character also decides the direction of a break: whether a unit that breaks panics or goes
into a frenzy.

---

## 4. Organic Progression (Learn-by-Doing)

Instead of a generic XP pool spent in menus, characters organically grow their attributes and proficiencies by pushing their limits in the field.

### Proficiency & Skill Growth
- **Weapon & Item Proficiencies**: Increase directly through successful in-match usage. Landing hits, scoring criticals, and effectively deploying utility items incrementally levels the associated proficiency.

### Attribute Growth Mechanics
- **Health**: Progresses by surviving non-lethal damage, enduring environmental hazards, and recovering from critical status effects without dying.
- **Agility**: Progresses by optimally expending Action Points (stopping just short of the "Winded" threshold), successfully flanking or sneaking up on enemies, and consistently scoring hits with small-hitcone/precision weapons (Sniper Rifles, Assault Rifles).
- **Strength**: Progresses by undertaking heavy lifting (moving long distances while heavily encumbered without hitting exhaustion) and successfully engaging and defeating enemies in melee combat.
- **Intelligence**: Progresses by successfully interacting with complex environmental terminals (hacking), decoding intel, and efficiently utilizing advanced utility items in critical moments.

---

## 5. Permadeath, Wounds & Roster Persistence

- **Permadeath**: Fatal trauma without immediate triage results in permanent roster removal.
- **Lasting Wounds**: Severe injuries require medical bay downtime between missions. Fatigue accumulates over consecutive deployments, temporarily reducing baseline AP and Morale.
- **Persistence**: Squad identities, scars, combat logs, and organic stat growths are stored in the meta-layer persistence across the campaign.