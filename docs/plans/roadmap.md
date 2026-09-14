---
title: "Multi-Milestone Product & Engineering Roadmap"
id: "PLAN-ROADMAP"
type: "plan"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "docs/plans/**"
relatedDocs:
  - "docs/backlog/active-backlog.md"
tags: ["roadmap", "milestones", "release"]
---

# Multi-Milestone Roadmap

## Milestone Timeline Overview

| Milestone | Target | Focus Area | Key Deliverables | Status |
| --- | --- | --- | --- | --- |
| **M1: Headless Core & Decoupling** | Q3 2026 | Architecture | Narrow Ports, Balance Harness, Full ECS Data/View Split | **In Progress** |
| **M2: Tactical Depth & Progression** | Q4 2026 | Gameplay | In-Match XP & Promotions, Dynamic Wounds, Equipment Traits | Planned |
| **M3: Reconnaissance & Morale** | Q1 2027 | Mechanics | Intel Fog, Suppression & Morale, AP Fatigue & Exhaustion | Planned |
| **M4: Competitive & Meta Roster** | Q2 2027 | Meta / Network | Overwatch & Reactions, Role Archetypes, Campaign Roster Persistence | Planned |

---

## Detailed Milestone Objectives

### Milestone 1: Headless Core & Decoupling
- Complete decoupling of rule resolvers from Three.js scene/camera rendering.
- `Soldier` decoupled into component data container; `SoldierView` managing meshes and animations.
- Deterministic headless simulation capable of executing 500+ match sweeps.

### Milestone 2: Tactical Depth & RPG Progression
- In-match promotion draft with dynamic trait application.
- Severe trauma wound system applying lasting debuffs (<50%, <25% HP).
- Trait-bearing passive items (Scopes, Bipods, Suppressors, Armor Carriers).

### Milestone 3: Reconnaissance, Suppression & Fog
- Dynamic intel fog obfuscating enemy sheet numbers until detected or attacked.
- Ballistic suppression mechanics pinning units on near-misses.
- Exhaustion penalty for consecutive max-AP turns.

### Milestone 4: Competitive Meta & Campaign Persistence
- Complex reaction fire and overwatch interleaving in enemy move paths.
- Distinct tactical roles (Medic, Scout, Marksman, Gunner) on loadout screen.
- LocalStorage and P2P campaign squad persistence across matches.
