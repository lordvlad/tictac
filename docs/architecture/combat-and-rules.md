---
title: "Combat, Ballistics & Rule Engine"
id: "ARCH-COMBAT-RULES"
type: "architecture"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
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
$$\text{Base Chance} = \text{Shooter Proficiency} - \text{Target Evasion} + \text{Range Modifier} - \text{Cover Penalty}$$

- **Range Modifier**: Evaluated against the weapon's configured range bands (`optimalRange`, `maxRange`, `falloffPerTile`).
- **Cover Penalty**:
  - Open: 0% evasion bonus
  - Half Cover: +15% target evasion
  - Full Cover: +30% target evasion

### Critical Hit Calculation
$$\text{Crit Chance} = \text{Weapon Base Crit} + \text{Flanking Bonus} - \text{Target Resilience}$$
$$\text{Crit Damage} = \text{Damage} \times \text{Crit Multiplier (1.3 to 2.2)}$$

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

- **Armor Absorption**: Each point of armor absorbs 1 damage up to the armor limit.
- **Armor Shredding**: High-penetration weapons and explosives reduce armor permanently.
- **Wound Trait Application**: When HP crosses below 50% or 25%, wound traits (`Winded`, `Concussed`, `Limping`) are added to the target's `TraitsComponent`.
