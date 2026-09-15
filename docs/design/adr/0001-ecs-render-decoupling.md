---
title: "ADR-0001: ECS Render Decoupling & View-Unit Separation"
id: "ADR-0001"
type: "adr"
status: "implemented"
lastReviewed: "2026-09-15"
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
- Introduced `UnitRef` (identity), `Casualty` (the state a resolved hit is applied to) and `Combatant` (`src/core/Combatant.ts`) defining only what game resolvers read (hp, armor, statuses, weapon, ammo, tile, position, proficiency, evasion, crit props).
- Introduced `CombatFx` for FX execution — `tracer`, `shoot`, `hit` — allowing headless execution with a no-op port (`NO_FX`). `FocusPort`/`NO_FOCUS` does the same for the camera.
- Removed all `src/render/` imports from `src/game/Combat.ts` and `src/ecs/systems/CombatSystem.ts`.

### Phase 2: Data / View Unit Split (Completed)
- `Soldier` is purely data over components.
- `SoldierView` owns `Entity3D`, glTF meshes, cloned materials, and animation mixers; `SquadViews` builds them and resolves a unit's body by identity.
- `RenderSystem` observes `PositionComponent`, `StanceComponent`, and `HealthComponent` to drive views.
- Unit visibility moved off the mesh into `SightedComponent`: fog of war writes state, the view mirrors it. Previously fog wrote `instance.visible` and the planners read it back, which made target eligibility a question about the renderer.
- `CombatFx` has no `death`. A corpse is `hp <= 0` in a component, so the view plays the collapse on observing it; announcing it as well played the clip twice per kill. This is why the port lists three methods rather than the four Phase 1 introduced.

### Consequences
- **Positive:**
  - Full match simulation runs 100% headless with no canvas or Three.js scene dependencies.
  - Sub-millisecond unit test execution, and a squad can be built in a test with no canvas stub at all (`tests/headless.test.ts`).
  - Enables deterministic headless AI vs AI balance testing (`scripts/balance.ts`), which is also how the split was verified: 200 matches at a fixed seed produce a byte-identical report before and after.
  - Anything derivable from component state needs no announcement at all, which is how the duplicated death clip was found.
- **Negative / Costs:**
  - Requires explicit event/component synchronization between simulation state and view representation.
  - State mirrored onto meshes lands one frame later than a direct write (~16 ms), which applies to unit visibility.
  - The split does not retire `installCanvasStub` for suites that exercise render code: `PathMarker` and `ShootPlanner` build canvas-backed textures, so `movement`, `shooting` and `pathmarker` still install it alongside `camera` and `debugmap`. Each suite must install its own — removing it from three of them left the aggregate run green only because another file had installed it first, and CI's file order exposed that.
