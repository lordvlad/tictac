---
title: "GDD: Squads, Progression & Meta Roster"
id: "GDD-PROGRESSION"
type: "gdd"
status: "active"
lastReviewed: "2026-09-14"
appliesTo:
  - "src/core/Characters.ts"
  - "src/core/Traits.ts"
relatedDocs:
  - "docs/design/gdd/combat-mechanics.md"
tags: ["progression", "rpg", "squads", "roster"]
---

# GDD: Squads, Progression & Meta Roster

## 1. Squad Structure & Character Identity

Squads are not generic armies; they are composed of unique, generated individuals with distinctive identities:
- **Procedural Sheets**: Random names, visual traits, initial proficiencies, and quirks.
- **Unified Skill Tree**: All characters share a flexible stat and trait framework rather than rigid classes, enabling dynamic role pivots (e.g. Field Medic who is also a heavy gunner).
- **Specializations & Roles**: Equipment loadout limits define tactical combat roles (Medic, Scout, Marksman, Gunner).

---

## 2. In-Match Progression & Promotion

During combat matches:
- Units gain experience (XP) for decisive tactical actions (kills, assists, critical revives, objective captures).
- Reaching promotion thresholds during combat allows on-the-fly trait selection from a draft of three perks.
- Traits append dynamically to the unit's active `TraitsComponent` and replicate across the P2P wire protocol.

---

## 3. Permadeath, Wounds & Roster Persistence

### Permadeath
- When a unit suffers fatal trauma and expires without triage before match end, they are permanently eliminated from the roster.
- Roster survival is critical: losing all squad members triggers an emergency survivor recovery scenario.

### Lasting Wounds & Fatigue
- Severe battle trauma leaves lasting wounds that persist back at base (e.g. Broken Ribs, Shrapnel Injury) requiring medical bay downtime or stim treatments.
- Units deployed in consecutive battles accumulate fatigue, lowering baseline AP and morale until given rest.

### Campaign Roster Persistence
- Squad sheets persist in local state/storage across matches, accumulating historical combat logs, medals, scars, and long-term tech proficiencies.
