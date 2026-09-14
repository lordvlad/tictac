---
title: "ADR-0002: Deterministic Headless Balance Harness"
id: "ADR-0002"
type: "adr"
status: "implemented"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "src/sim/**"
  - "scripts/balance.ts"
  - "tests/balance.test.ts"
relatedDocs:
  - "docs/architecture/headless-sim.md"
tags: ["balance", "simulation", "testing", "determinism"]
---

# ADR-0002: Deterministic Headless Balance Harness

## Status
**Status:** Implemented
**Date:** 2026-09-14
**Deciders:** Engineering & Design

---

## Context & Problem Statement
Tactical game balancing (e.g. assessing whether snipers outclass shotguns, evaluating Nullweave vest value, detecting first-move advantage) previously required manual playtesting and eyeball inspection. Manual playtesting cannot generate statistically significant datasets (500+ matches) and cannot verify whether a code refactor altered game mechanics.

---

## Decision Outcome
**Chosen Architecture:** Built a high-speed, deterministic headless simulation package (`src/sim/SimUnit.ts`, `src/sim/SimMatch.ts`, `src/sim/Balance.ts`) executed via CLI (`scripts/balance.ts`).

### Key Capabilities
1. **Headless Execution**: Runs entirely against the pure rule layer (`MapGenerator`, `Grid`, `Pathfinding`, `Visibility`, `Ballistics`, `Combat`) using a no-op `CombatFx` port.
2. **Speed & Throughput**: Executes 500 complete matches in ~7 seconds on Bun runtime.
3. **Seeded Determinism**: Matches use seeded PRNG (`src/core/rng.ts`). Given the same seed range, output statistics are mathematically identical.
4. **Asymmetric & Paired Sweeps**: Supports command-line flag configurations (`--blue=shotgun --red=sniper`, `--blueAmmo=ap`, `--blueVests=1`).

### Consequences
- **Positive:**
  - Immediate statistical feedback on balance changes.
  - Regression test `tests/balance.test.ts` pins baseline simulation outputs to catch unintentional rule drifts.
- **Negative / Costs:**
  - AI policy in `SimMatch` must be maintained as new tactical actions (overwatch, item usage) are introduced.
