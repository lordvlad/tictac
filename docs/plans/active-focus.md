---
title: "Active Kanban Focus: M1 Headless Foundation"
id: "PLAN-ACTIVE-FOCUS"
type: "plan"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/active-backlog.md"
  - "docs/plans/roadmap.md"
tags: ["kanban", "active", "focus", "m1"]
---

# Active Kanban Focus: M1 Headless Foundation

## Focus & Theme
Complete the ECS Data vs View Unit split (`ENG-001`) to enable 100% headless squad creation, instant test execution, and clean separation between game rules and Three.js presentation.

---

## Kanban Board

### 🔄 In Progress / Next Up
- **`[ENG-001.1]`**: Create `SoldierView.ts` and `SquadViews.ts` render abstractions.
- **`[ENG-001.2]`**: Refactor `Soldier.ts` into a pure component data container.

### 📋 Ready (Pull Queue)
- **`[ENG-001.3]`**: Update `RenderSystem.ts` to bridge component transforms to views.
- **`[ENG-001.4]`**: Remove `installCanvasStub` from test suites (`tests/movement.test.ts`, `tests/camera.test.ts`, `tests/pathmarker.test.ts`, `tests/shooting.test.ts`, `tests/debugmap.test.ts`).
- **`[VERIF-001]`**: Validate browser visual animations, crouching, facing angles, and yaw transitions in interactive session (`bun run dev`).

### ✅ Completed
- **`[ARCH-001]`**: Narrow ports (`Combatant`, `CombatFx`, focus port for `TurnManager`).
- **`[ENG-000]`**: Headless simulation runner and balance harness (`scripts/balance.ts`, `src/sim/`).

---

## Definition of Done for M1
1. `Soldier` holds zero references to Three.js rendering objects or `Entity3D`.
2. All test suites pass headless with no canvas mocks (`bun test`).
3. Zero animation/visual regressions in interactive browser play.
4. Deterministic balance sweeps confirm zero rule regressions (`bun run balance`).
