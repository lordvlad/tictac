---
title: "Combat, Ballistics & Rule Engine"
id: "ARCH-COMBAT-RULES"
type: "architecture"
status: "active"
lastReviewed: "2026-09-16"
appliesTo:
  - "src/core/Arsenal.ts"
  - "src/core/Ballistics.ts"
  - "src/core/Visibility.ts"
  - "src/core/Cover.ts"
  - "src/game/Combat.ts"
relatedDocs:
  - "docs/architecture/overview.md"
  - "docs/design/gdd/combat-mechanics.md"
tags: ["combat", "ballistics", "rules", "los", "cover"]
---

# Combat, Ballistics & Rule Engine

## 1. Line of Sight (LOS) & Visibility

Grid visibility is computed purely in 2D/3D integer coordinates using high-speed DDA ray marching (`src/core/Visibility.ts` and `src/core/Occlusion.ts`):
- **Zero Raycasting in Core**: Physics raycasting is not used for gameplay checks; raycasters are restricted to pointer input picking in `InteractionController.ts`.
- **Wall Occlusion**: Solid wall components block vision unless destroyed or low-profile.

---

## 2. Ballistic Equations & Hit Probability

### Hit Calculation
`hitChance` (`src/core/Ballistics.ts`) sums every term inside one bracket and then scales
the lot by the shot mode, so a mode multiplies the situation rather than being added to it:

$$\text{chance} = \text{clamp}\Big(\big(\text{weapon base} + \text{global} + \text{proficiency} - \text{range} - \text{cover} - \text{shooter statuses} - \text{target statuses} - \text{evasion}\big) \times \text{mode}\Big)$$

- **Range**: `distance × accuracyPerMetre`, where the per-metre figure is the weapon's own,
  scaled by the loaded round and by carried glass (`rangeFalloff`, floored at zero — gear may
  cancel falloff, never invert it). Beyond `maxRange` the chance is 0 outright.
- **Cover** (`COVER`, applied by `coverPenalty`): standing behind a crate 20, crouching in the
  open 25, crouching behind a crate 40, standing behind a wall 45, crouching behind a wall 60.
- **Proficiency**: the shooter's training with *that weapon class*, plus trait accuracy, plus
  bipod-style bonuses that apply only while crouched.
- **Evasion**: the target's, never below zero. Subtracted before the mode multiplier, so a
  hard target is hard to snap at and hard to line up on alike.
- Clamped to `AIM.min`–`AIM.max`, which is why the headline percentage is recomputed from the
  terms rather than divided back out of a mode's result.

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

Current values for every trait, status and piece of kit named here live in the generated
[status and trait catalogue](../design/gdd/status-and-trait-catalog.md).

---

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
  the match.
- **Suppression**: rounds that *miss* stack `Suppressed` on the target (accuracy and points,
  per stack, pinned at the cap). It is derived on both sides rather than sent — `executeShot`
  counts the rounds that went past and `replayShot` counts the false entries in the rolls it
  was given, so no message had to grow.
- **Wounds**: `Limping` at or below half health and `Concussed` at or below a quarter, from
  `woundTraits(hp, maxHp)`. They are **derived from current health, not stamped on** when a
  threshold is crossed: hit points already replicate, so both peers reach the same answer with
  nothing sent, there is no threshold hysteresis to get wrong, and healing genuinely lifts
  them. `Winded` is a separate thing — a *status* from exhaustion, not a wound.
