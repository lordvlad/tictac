# Agent Contributing Guidelines & Engineering Invariants

Welcome to **TicTac (No Way Home)**. This document establishes guidelines, architectural invariants, tooling commands, and documentation workflows for AI agents and human contributors working in this repository.

---

## 1. Repository & Tech Stack Overview

- **Runtime & Package Manager**: [Bun](https://bun.sh) (v1.3.14+)
- **Language**: TypeScript (strict mode, target ESNext)
- **Rendering & 3D**: [Three.js](https://threejs.org) + `@mavonengine/core`
- **HUD & Menus**: [React](https://react.dev) 19 components (`.tsx`, compiled by Bun) over the canvas; see `docs/architecture/rendering.md` §4
- **Networking**: P2P WebRTC DataChannels via [PeerJS](https://peerjs.com) + JSON-RPC 2.0 notifications
- **Assets**: Draco-compressed glTF/GLB models (`public/character.glb`), SVG icons from `game-icons.net` (`public/icons/`)

---

## 2. Core Architectural Invariants

### 1. Headless-First Pure Rules Layer
- Code under `src/core/`, `src/rules/`, `src/wire/`, `src/ecs/`, and `src/sim/` must remain **100% headless** and free of DOM or WebGL dependencies.
- **Rule**: Never import from `src/render/`, `src/hud/`, or `src/camera/` inside `src/core/` or `src/ecs/`.
- **Enforced**: `tests/layers.test.ts` checks every runtime import against the layer DAG (core ← ecs ← rules ← sim ← wire ← server/client; render/hud/camera client-only; `workers/` reaches only `src/server`). Edges that still violate it are an allowlist, each under the ticket that removes it. A new violating edge fails the test, and so does a listed edge that no longer exists — delete its line when you delete the import. The list only shrinks.
- Three.js imports in core/ECS are restricted to pure vector arithmetic (`Vector3`, `Quaternion`, `MathUtils`).

### 2. Deterministic PRNG
- All dice rolls, spread calculations, hit probabilities, and map generation must use the seeded PRNG in `src/core/rng.ts`.
- Never use `Math.random()` for gameplay-affecting logic.

### 3. Intent on the Wire, Resolved on Both Sides
- A command carries what a player **decided**, never what it produced: `fireShot` is a shooter, a target and a mode. `WireHit` is gone.
- Both peers resolve every command through the same rules, from one seeded stream per match (`matchDice(seed)`), against state they both hold. See [ADR-0004](docs/design/adr/0004-full-knowledge-lockstep.md).
- Therefore: **only the rules may draw from the match stream**, and they must draw the same numbers in the same order on both sides. Setup (dealing squads) and presentation (tracer scatter, smoke) take their own randomness. Enforced by `tests/determinism.test.ts`.
- Disagreement is no longer a wrong number applied quietly; it is a desynchronisation, reported by the state digest exchanged at every handover.

### 4. Pure Intent Lockstep (ADR-0004)
- Match simulation replicates strictly through intent commands (`NetworkMessage`), not component diffs. Both peers and the referee simulate the match deterministically from the command stream.

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
- **Hobby-First Governance**: Planning uses a pull-based Kanban workflow (`Backlog` → `Ready` → `In Progress` → `Completed`) organized around capability milestones (`M1` to `M5`).
- **Issue Tracking via Beads (`bd`)**: Active issues and tasks are tracked in the local Dolt-backed Beads database (`.beads/`). Run `bd list` to view issues and `bd ready` for unblocked work.
- **Single Backlog Sequence**: Milestone and feature specifications use sequential IDs (`ITEM-001`, `ITEM-002`, ...), specified in `docs/backlog/active-backlog.md` and cross-referenced with Beads IDs (`tictac-<hash>`).
- **No Time Estimates or Sprints**: Work is prioritized by technical elegance, dependency ordering, and player value without artificial deadlines or time estimates.
- **No `owner` Field**: Backlog items, ADRs, RFCs, and document frontmatter do not track individual owner fields.
- **Active Focus**: The current work-in-progress and next items in the pull queue are listed in `docs/plans/active-focus.md`.

---

## 5. Directory Map

| Path | Description |
| --- | --- |
| `src/core/` | Pure math, Grid DDA, Line of Sight, Pathfinding, Ballistics, Combat formulas. |
| `src/rules/` | Headless game rules the systems execute: `Combat`, `Overwatch`, `Movement`, `Breakdown`, `Turn`, `MatchEnd`, the `StateDigest` shape and comparison, the `Command` language and the loadout pool rules. |
| `src/ecs/` | ECS `World`, components, systems, snapshot/restore. |
| `src/entities/` | `Soldier` (the wrapper over a unit's components), `Squads` (the units on the field) and `applyUnitLoadout` (`Kit`). |
| `src/wire/` | The contract two sides share: `NetworkMessage`, `Rpc`, `JsonRpc`, `Lobby`, `Encounter`, `Transport`, the `Recording` format, `Base64Url`. Headless; imports only `core` and `rules`. |
| `src/sim/` | Headless match simulation engine (`SimUnit`, `SimMatch`, `Balance`), plus what drives a match's turns and moments: `TurnManager`, the `Rewind` types and `digestWorld`. |
| `src/game/` | Client orchestration with no scene: `MatchSession` (intents to commands, the turn/act gate, state out as view models; headless-testable), the `MatchView` port it is drawn through, `NetworkManager`, `ServerConnection`, `Playback`. Imports none of `render`, `hud`, `camera`. |
| `src/client/` | The presentation of a match: `Presenter` (draws the session: HUD from its view models, fog, overlays, effects), `Input` (canvas and key events to intents), the planners (`MovementPlanner`, `ShootPlanner`, `GrenadePlanner`), `FogOfWar`, `WallXray`, `Battlefield`. The one layer that sees `game` and `render`/`hud`/`camera` both; only `main.tsx` builds it. |
| `src/render/` | Three.js meshes, animations, tracers, visual FX, materials. |
| `src/hud/` | DOM HUD overlays, loadout screen, portraits, debug panels. |
| `src/camera/` | Orbit rig, camera controls, pointer raycaster picking. |
| `docs/` | Living documentation: architecture, GDD, ADRs, backlog, plans, guides, schemas. |
| `scripts/` | Tooling: balance runner, icon compiler, character optimizer, doc linter. |

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:46cd31e7 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
