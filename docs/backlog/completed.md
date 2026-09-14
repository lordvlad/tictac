---
title: "Completed Work Archive"
id: "BACKLOG-COMPLETED"
type: "backlog"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/README.md"
  - "docs/design/adr/0001-ecs-render-decoupling.md"
  - "docs/design/adr/0002-deterministic-headless-balance-harness.md"
tags: ["archive", "completed", "history"]
---

# Completed Work Archive

---

### [ARCH-001] Narrow Ports: Decouple Rules Layer from Render Layer
**Completed Date:** 2026-09-14  
**Type:** Architecture / Refactor  

#### Why
The ECS already did its job on data — components are plain serializable state — but behavior still leaked into graphics across three primary seams:

| Seam | Evidence | Nature |
| --- | --- | --- |
| `Soldier extends Entity3D` | `src/entities/Soldier.ts:66`, `initGraphics():382`, material cloning `:399` | Identity, glTF and the animation mixer lived in the same object as HP and AP |
| Resolvers call FX directly | `src/game/Combat.ts:109` takes `Tracers`, `:152` `spawnTracer`, `:154/208/209` `playShoot`/`playDeath`/`playHit`; same in `src/ecs/systems/CombatSystem.ts:33,93` | The rules layer imported the render layer |
| Match assembly needs the engine | `src/game/Squads.ts:78` `engine.world.add`, `src/game/Battlefield.ts:32,71` `engine.scene`, `TurnManager(…, rig)` wants an `OrbitRig` | A match could not be built without a scene and a camera |

#### Non-Problems Identified
- **Visibility is not raytraced**: `src/core/Visibility.ts` imports only `config` and `Grid`; line of sight is grid DDA marching, as is `src/core/Occlusion.ts`. The only `Raycaster` is `InteractionController:57` (screen-to-world pointer picking). Visibility already ran headless.
- **Three.js math is not rendering**: `three` appears in `core`/`ecs` only as `Vector3` (`Grid.tileToWorld`, `Grid.pathToWorldPoints`, `PositionComponent.targetPos`). `Vector3`, `Quaternion`, and `MathUtils` are pure arithmetic and execute under `bun test` with no GL context.

#### Key Changes
- Defined `Combatant` interface (`src/core/Combatant.ts`) representing what resolvers read: hp, armor, statuses, weapon, ammo, tile, position, proficiency, evasion, crit props, `isDead`.
- Defined `CombatFx` interface representing render effects: `spawnTracer`, `shoot`, `hit`, `death`. In real matches `Tracers` and `Soldier` implement them; headless, a no-op implementation does.
- `TurnManager` takes a camera focus port rather than a direct `OrbitRig`.
- `src/game/Combat.ts` and `src/ecs/systems/CombatSystem.ts` stopped importing from `src/render/` altogether.

---

### [ENG-000] Deterministic Headless Balance Harness
**Completed Date:** 2026-09-14  
**Type:** Infrastructure / Tooling  

#### Why
Every gameplay tuning item is a balance change. Previously, the only way to check one was driving the browser by hand and reading numbers off the HUD, which did not scale to evaluating weapon biases or verifying refactors.

#### Key Changes
- Built headless simulation runner in `src/sim/` (`SimUnit.ts`, `SimMatch.ts`, `Balance.ts`). Runs on the pure layer (`MapGenerator`, `Grid`, `Pathfinding`, `Visibility`, `Ballistics`, `Combat`) with no HUD or canvas construction.
- Created CLI tool `scripts/balance.ts` for statistical reporting. 500 matches run in ~7 seconds under Bun.
- Pinned baseline balance outputs with automated test `tests/balance.test.ts`.

#### Initial Balance Findings (Baseline Sweep)
All figures are stock spread with sides swapped to account for first-move bias:
- **First move advantage is roughly 5–10 points**: 500 stock mirror matches: blue 292, red 184, 24 draws (blue moves first).
- **Fights are short and bimodal**: Median 3.5 turns, mean 6.35, with a tail out to turn cap.
- **Sniper rifle beats shotgun ~7 times in 10**: Sides swapped and averaged (174–98 one way, 222–60 the other).
- **Nullweave Vest provides zero measurable value**: 400 matches across seeds: vests on blue 224 wins, vests on red 230, neither 226. Crits are 1/6th of hits (multiplier 1.3–2.2), so removing crits is worth less than the 3 evasion the vest costs.
- **Trait win rates were not initially separable**: Over 500 matches: nimble 56.7%, stoic 53.9%, juggernaut 49.5%, fleet 48.9%. Requires paired-seed evaluation.

#### Regressions Caught by the Harness
1. **Shotgun Squad Freeze**: An initial AI policy stopped advancing as soon as it saw an enemy. Since a shotgun reaches 12m and sees 14m, shotgun squads froze outside range and fired zero rounds across 300 matches.
2. **First Legal vs Decent Shot**: Stopping at the first legal shot caused weapons to engage at max falloff. Fixing it moved shotguns from 37% hits / 22 dmg to 64% hits / 39 dmg.

#### Open Items
- Paired-seed trait comparison.
- `CombatSystem` roster port for direct simulation use rather than calling `fireWeapon` directly.
