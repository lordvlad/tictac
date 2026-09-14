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
**Key Changes:**
- Defined `Combatant` interface (`src/core/Combatant.ts`) separating rule resolution from entity rendering.
- Defined `CombatFx` interface (`src/core/Combatant.ts` / `src/render/SceneCombatFx.ts`) replacing direct imports of `Tracers` and render effects in `Combat.ts` and `CombatSystem.ts`.
- Refactored `TurnManager` to take a camera focus port rather than a direct `OrbitRig` dependency.

---

### [ENG-000] Deterministic Headless Balance Harness
**Completed Date:** 2026-09-14  
**Type:** Infrastructure / Tooling  
**Key Changes:**
- Built headless simulation runner in `src/sim/` (`SimUnit.ts`, `SimMatch.ts`, `Balance.ts`).
- Created CLI tool `scripts/balance.ts` for statistical reporting (win rates, turn counts, weapon efficiency, trait impacts).
- Pinned baseline balance outputs with automated test `tests/balance.test.ts`.

#### Initial Balance Findings (Baseline Sweep):
- First-move advantage: ~5-10% win rate bias towards blue.
- Match length: Median 3.5 turns, mean 6.35 turns.
- Sniper vs Shotgun: Sniper wins ~7 out of 10 engagements.
- Nullweave Vest: Statistically neutral in baseline configuration due to 3 evasion trade-off.
