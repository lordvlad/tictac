# Agent Contributing Guidelines & Engineering Invariants

Welcome to **TicTac (No Way Home)**. This document establishes guidelines, architectural invariants, tooling commands, and documentation workflows for AI agents and human contributors working in this repository.

---

## 1. Repository & Tech Stack Overview

- **Runtime & Package Manager**: [Bun](https://bun.sh) (v1.3.14+)
- **Language**: TypeScript (strict mode, target ESNext)
- **Rendering & 3D**: [Three.js](https://threejs.org) + `@mavonengine/core`
- **Networking**: P2P WebRTC DataChannels via [PeerJS](https://peerjs.com) + JSON-RPC 2.0 notifications
- **Assets**: Draco-compressed glTF/GLB models (`public/character.glb`), SVG icons from `game-icons.net` (`public/icons/`)

---

## 2. Core Architectural Invariants

### 1. Headless-First Pure Rules Layer
- Code under `src/core/`, `src/ecs/`, and `src/sim/` must remain **100% headless** and free of DOM or WebGL dependencies.
- **Rule**: Never import from `src/render/`, `src/hud/`, or `src/camera/` inside `src/core/` or `src/ecs/`.
- Three.js imports in core/ECS are restricted to pure vector arithmetic (`Vector3`, `Quaternion`, `MathUtils`).

### 2. Deterministic PRNG
- All dice rolls, spread calculations, hit probabilities, and map generation must use the seeded PRNG in `src/core/rng.ts`.
- Never use `Math.random()` for gameplay-affecting logic.

### 3. Intent on the Wire, Resolved on Both Sides
- A command carries what a player **decided**, never what it produced: `fireShot` is a shooter, a target and a mode. `WireHit` is gone.
- Both peers resolve every command through the same rules, from one seeded stream per match (`matchDice(seed)`), against state they both hold. See [ADR-0004](docs/design/adr/0004-full-knowledge-lockstep.md).
- Therefore: **only the rules may draw from the match stream**, and they must draw the same numbers in the same order on both sides. Setup (dealing squads) and presentation (tracer scatter, smoke) take their own randomness. Enforced by `tests/determinism.test.ts`.
- Disagreement is no longer a wrong number applied quietly; it is a desynchronisation, reported by the state digest exchanged at every handover.

### 4. Component Dirty-State Synchronization
- Replicated entity state changes travel via `World.syncDirty()`, which diffs serialized component state against previous snapshots and broadcasts JSON-RPC `componentUpdate` frames.

### 5. Pure Bun Runtime & Asynchronous File I/O Only
- The codebase runs strictly on **Bun**. Do not design for or introduce Node.js polyfills/shims.
- **Never use synchronous file APIs** (`fs.readFileSync`, `fs.writeFileSync`, `fs.existsSync`, `fs.statSync`, `fs.readdirSync`, etc.) anywhere in application code, tests, or build scripts.
- Use `Bun.file(path)` with top-level `await` (`file.text()`, `file.json()`, `file.exists()`, `Bun.write()`) or `node:fs/promises` for directory operations.
---

## 3. Tooling & Verification Workflow

Agents must run verification commands before completing non-trivial tasks:

```bash
# 1. Concurrently run TypeScript typecheck and documentation linter
bun run lint

# 2. Run unit and headless integration test suite (must stay 100% green)
bun test

# 3. Run headless balance sweep when modifying rules, weapons, or traits
bun run balance

# 4. Verify production bundle build
bun run build
```

---

## 4. Living Documentation & Backlog Governance

### Living Documentation Policy
- Documentation is located in `docs/` and evolves with the code.
- When modifying architectural seams, ECS components, network messages, or combat formulas, **update the corresponding living documentation in `docs/` in the same commit**.

### Kanban & Backlog Standards
- **Hobby-First Governance**: Planning uses a pull-based Kanban workflow (`Backlog` → `Ready` → `In Progress` → `Completed`) organized around capability milestones (`M1` to `M4`).
- **No Time Estimates or Sprints**: Work is prioritized by technical elegance, dependency ordering, and player value without artificial deadlines or time estimates.
- **Single Backlog Sequence**: All tasks use a single, unified ID sequence (`ITEM-001`, `ITEM-002`, `ITEM-003`, ...) tracked in `docs/backlog/active-backlog.md` and archived in `docs/backlog/completed.md`.
- **No `owner` Field**: Backlog items, ADRs, RFCs, and document frontmatter do not track individual owner fields.
- **Active Focus**: The current work-in-progress and next items in the pull queue are listed in `docs/plans/active-focus.md`.

---

## 5. Directory Map

| Path | Description |
| --- | --- |
| `src/core/` | Pure math, Grid DDA, Line of Sight, Pathfinding, Ballistics, Combat formulas. |
| `src/ecs/` | ECS `World`, components, systems, dirty state diffing. |
| `src/sim/` | Headless match simulation engine (`SimUnit`, `SimMatch`, `Balance`). |
| `src/game/` | Game orchestration: `TurnManager`, `NetworkManager`, `Battlefield`, `Squads`. |
| `src/render/` | Three.js meshes, animations, tracers, visual FX, materials. |
| `src/hud/` | DOM HUD overlays, loadout screen, portraits, debug panels. |
| `src/camera/` | Orbit rig, camera controls, pointer raycaster picking. |
| `docs/` | Living documentation: architecture, GDD, ADRs, backlog, plans, guides, schemas. |
| `scripts/` | Tooling: balance runner, icon compiler, character optimizer, doc linter. |
