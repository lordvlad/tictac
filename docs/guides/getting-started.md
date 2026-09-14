---
title: "Developer Getting Started & Workflow Guide"
id: "GUIDE-GETTING-STARTED"
type: "guide"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "package.json"
  - "src/**"
  - "scripts/**"
relatedDocs:
  - "docs/architecture/overview.md"
  - "docs/architecture/headless-sim.md"
tags: ["setup", "workflow", "testing", "balance", "scripts"]
---

# Developer Getting Started & Workflow Guide

## 1. Prerequisites

- **Bun**: v1.3.14 or later (`curl -fsSL https://bun.sh/install | bash`)
- **Git**: Configured with submodule support (required if editing icons from source)

---

## 2. Installation & Quick Start

```bash
# Clone and enter repo
git clone <repo-url>
cd tictac

# Install dependencies
bun install

# Start development server with Hot Module Reloading (HMR)
bun run dev
```

The game server will boot on `http://localhost:5173`.

---

## 3. NPM Scripts & Tooling

| Command | Purpose | When to run |
| --- | --- | --- |
| `bun run dev` | Boots `src/index.ts` with HMR on port 5173. | Day-to-day interactive gameplay and UI development. |
| `bun test` | Runs the full unit & headless integration test suite. | Before every commit and PR. Fast execution (~1s). |
| `bun run balance` | Executes headless combat simulation sweeps across N seeded matches. | When adjusting weapon stats, traits, hit formulas, or refactoring rules. |
| `bun run lint` | Runs TypeScript typechecker and documentation linter in parallel. | Pre-commit validation. |
| `bun run lint:docs` | Validates doc links, JSON schemas, and frontmatter metadata. | Documentation updates. |
| `bun run typecheck`| Runs TypeScript compiler with `--noEmit`. | Type verification across the entire project. |
| `bun run build` | Compiles production bundle to `dist/` with minification. | CI/CD and deployment verification. |
| `bun run preview` | Runs the production build server locally. | Verifying production asset serving. |
| `bun run icons` | Re-compiles public SVG icons from `scripts/icons.json` and `vendor/game-icons`. | When introducing new weapon/item/HUD icons. |
| `bun run build:character` | Processes glTF character model, optimizations, and animations. | When modifying 3D character mesh or animations. |

---

## 4. Headless Balance Sweeps

The game features a fully headless simulation engine in `src/sim/` and `scripts/balance.ts`.

### Example Usages

```bash
# Run default sweep (500 symmetric matches across weapons)
bun run balance

# Asymmetric comparison (e.g. shotgun vs sniper)
bun run balance --blue=shotgun --red=sniper

# Test trait or ammo impact
bun run balance --blueAmmo=ap --redAmmo=standard
bun run balance --blueVests=1

# Specify seed count and range
bun run balance --matches=1000 --seed=42
```

---

## 5. Testing Guidelines

- **Headless First**: Tests in `tests/` should run in node/bun without requiring a WebGL context or browser DOM where possible.
- **Deterministic**: Seeded RNG is used for map generation, pathing, and combat calculations to make test failures reproducible.
- **Fast Feedback**: The entire test suite must complete in under 2 seconds.
