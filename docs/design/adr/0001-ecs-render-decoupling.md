---
title: "ADR-0001: ECS Render Decoupling & View-Unit Separation"
id: "ADR-0001"
type: "adr"
status: "implemented"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "src/ecs/**"
  - "src/entities/Soldier.ts"
  - "src/render/**"
  - "src/game/Combat.ts"
relatedDocs:
  - "docs/architecture/ecs.md"
  - "docs/architecture/rendering.md"
tags: ["ecs", "render", "decoupling", "headless"]
---

# ADR-0001: ECS Render Decoupling & View-Unit Separation

## Status
**Status:** Implemented (Narrow Ports established; Data Unit vs View Unit split in active progress)
**Date:** 2026-09-14
**Deciders:** Engineering Team

---

## Context & Problem Statement
Originally, gameplay entities directly inherited 3D rendering primitives:
- `Soldier` inherited `Entity3D`, binding identity, animation mixers, and Three.js materials to HP, AP, and position data.
- Game rules resolvers in `src/game/Combat.ts` and `src/ecs/systems/CombatSystem.ts` directly imported `Tracers` and render FX.
- Building a match required an active WebGL canvas, Three.js scene, and `OrbitRig` camera instance.
- Automated tests had to mock WebGL canvas contexts (`installCanvasStub`) to test simple movement and shooting math.

---

## Considered Options
1. **Option 1: Retain Monolithic Entity3D Inheritance with Canvas Mocking** — Keep `Soldier` as a Three.js object; install headless stubs for test execution.
2. **Option 2: Narrow Interface Ports (Combatant / CombatFx)** — Introduce strict behavioral interfaces separating game resolvers from rendering implementations.
3. **Option 3: Complete ECS Data / View Separation** — Turn `Soldier` into pure component state; encapsulate all meshes, animations, and materials in a detached `SoldierView` driven by `RenderSystem`.

---

## Decision Outcome
**Chosen Approach:** Two-stage architectural migration combining Option 2 and Option 3.

### Phase 1: Narrow Ports (Completed)
- Introduced `Combatant` interface (`src/core/Combatant.ts`) defining only what game resolvers read (hp, armor, statuses, weapon, ammo, tile, position, proficiency).
- Introduced `CombatFx` interface for FX execution (`spawnTracer`, `shoot`, `hit`, `death`), allowing headless execution with a no-op port.
- Removed all `src/render/` imports from `src/game/Combat.ts` and `src/ecs/systems/CombatSystem.ts`.

### Phase 2: Data / View Unit Split (Active)
- `Soldier` is purely data over components.
- `SoldierView` owns `Entity3D`, glTF meshes, cloned materials, and animation mixers.
- `RenderSystem` observes `PositionComponent`, `StanceComponent`, and `HealthComponent` to drive views.

### Consequences
- **Positive:**
  - Full match simulation runs 100% headless with no canvas or Three.js scene dependencies.
  - Sub-millisecond unit test execution.
  - Enables deterministic headless AI vs AI balance testing (`scripts/balance.ts`).
- **Negative / Costs:**
  - Requires explicit event/component synchronization between simulation state and view representation.
