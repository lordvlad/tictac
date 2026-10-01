---
title: "GDD: Economy, Base Building & Crafting"
id: "GDD-ECONOMY"
type: "gdd"
status: "active"
lastReviewed: "2026-10-01"
appliesTo:
  - "src/game/**"
relatedDocs:
  - "docs/design/gdd/README.md"
tags: ["economy", "base-building", "crafting", "research"]
---

# GDD: Economy, Base Building & Crafting

## 1. Base Concepts

Players choose between two foundational operational models at game start:

### Nomadic Lifestyle
- **Vehicles**: Mobile APCs, armored tour buses, or rivercraft.
- **Advantages**: Rapid global relocation, lower vulnerability to static raids, flexibility in mission selection.
- **Drawbacks**: Restricted space for laboratories, storage, and medical beds; high fuel consumption.

### Settled Lifestyle
- **Locations**: Refurbished military bunkers, industrial warehouses, or prepper compounds.
- **Advantages**: High capacity for research equipment, extensive manufacturing workshops, heavy defensive fortifications.
- **Drawbacks**: Fixed geographical location requiring long expedition travel times; risk of being raided.

### Roster Capacity (`ITEM-047`, designed, not built)
A base or a vehicle is also how many people a player can keep, not only where they keep
equipment: each one held adds bench capacity (see
[Progression & Squads](progression-and-meta.md#5-permadeath-wounds--roster-persistence) §5), and
a player holding several of either — a bunker and a spare truck, two trucks — stacks their
capacities rather than picking one. A vehicle's cramped hold naturally rooms fewer than a
bunker's dormitory, the same Nomadic/Settled trade-off already above, just paid in people as
well as lab space. This replaces the flat six `ITEM-042` shipped to get a demo playable with a
number that grows the way the rest of the economy does — by playing, not by a constant in
`src/config.ts`.

---

## 2. Resource Management

| Resource | Primary Sources | Key Uses | Scarcity Impact |
| --- | --- | --- | --- |
| **Food / Rations** | Scavenging, farming, organic matter converters | Squad upkeep, fatigue recovery | Starvation degrades AP and combat morale. |
| **Ammunition & Parts** | Scavenged military caches, crafting | Combat ammo reloads, weapon modifications | Forces reliance on sidearms and melee. |
| **Fuel & Energy** | Refineries, solar arrays, alien power cells | Vehicle travel, high-tier weapon charging, base power | Strands vehicles; powers down tech research. |
| **Scrap & Composites** | Battle debris, ruined structures | Base expansion, armor plating, traps | Gates tier-2 and tier-3 equipment upgrades. |

---

## 3. Research & Tech Trees

Cross-faction technology synthesis is central to mid- and late-game progression:
- **Human Inventions**: Kinetic ballistics, combustion engines, improvised electronics, bio-stimulants.
- **Alien Inventions**: Plasma conduits, gravimetric dampening, cellular regeneration devices.
- **Hybrid Technologies**: EMP kinetic rounds (shield-disrupting bullets), bio-mechanical armor weaves, hybrid energy generators.
