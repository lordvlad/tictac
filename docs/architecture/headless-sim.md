---
title: "Headless Simulation Engine & Balance Automation"
id: "ARCH-HEADLESS-SIM"
type: "architecture"
status: "active"
lastReviewed: "2026-09-19"
appliesTo:
  - "src/sim/**"
  - "scripts/balance.ts"
relatedDocs:
  - "docs/design/adr/0002-deterministic-headless-balance-harness.md"
  - "docs/guides/getting-started.md"
tags: ["headless", "simulation", "balance", "automation"]
---

# Headless Simulation Engine & Balance Automation

## 1. Headless Simulation Architecture

The simulation engine (`src/sim/`) runs completely headless in pure TypeScript/JavaScript under Bun without browser DOM or WebGL:

```mermaid
graph TD
    A[scripts/balance.ts CLI] --> B[SimMatch Runner]
    B --> E[Scripted Tactical AI Policy]
    E -->|reads| D[ECS Soldiers]
    E -->|intents| M[MatchHost]
    M --> D
    M --> G[CombatSystem · MovementSystem · TurnManager]
    B --> H[Balance Stats Collector]
    H --> I[CLI Aggregated Report Table]
```

---

## 2. Core Modules

- **`MatchHost` (`src/sim/MatchHost.ts`)**: The match. Real ECS soldiers and systems with no scene, advanced by intents — the same applier the replay runner and the referee use.
- **`SimMatch` (`src/sim/SimMatch.ts`)**: A policy and nothing else. It reads the board, decides, and hands the host an intent (`moveUnit` one tile at a time, `fireShot`, `throwGrenade`, `toggleCover`, `overwatch`, `endUnitTurn`, `endTurn`), recording each. A refused intent throws: the policy asks the rules before it acts, so a refusal is a bug.
- **`Balance` (`src/sim/Balance.ts`)**: Statistical aggregator tracking win rates by faction/seed, mean turns to victory, weapon shot accuracy, damage distribution, and trait differential win rates.
- **`scripts/balance.ts`**: Command-line entry point parsing sweep parameters and formatting tabular terminal outputs.

---

## 3. Scripted AI Decision Loop

The simulated AI executes deterministic decision steps each turn:
1. **Target Selection**: Evaluates all visible enemies; ranks targets by kill probability, current HP, and hit percentage.
2. **Engagement Position**: Moves to optimal firing range band while favoring cover tiles.
3. **Action Execution**: Fires primary weapon or reloads when empty; ends turn when AP is exhausted.

---

## 4. Determinism & Seed Pinning

Simulations take a numeric seed and generate identical outcomes across runs:
- `tests/balance.test.ts` executes a pinned 50-match sweep and asserts exact win/loss numbers to guarantee rule stability during refactoring.

---

## Replaying a recorded match

`src/sim/Replay.ts` (`bun run replay <file>`) refights a recorded intent stream
through the real ECS with no engine, no canvas and nothing watching.

It exists because a recording and the wire are the same frames: an attack in a
file is an intent, exactly as it is between two peers, and the outcome is
whatever the build resolves from the match's seeded dice. So running a file is
the same exercise as *receiving* a match — which is how the receiving side gets
tested without two browsers, a signalling broker and a second pair of hands.

What it proves is narrower and stronger than a comparison: that the same intents
over the same seed produce the same world, every time. A recorded match replays
with every intent applied, twice to the same digest, and reaches the same
survivors as the match that produced it. The sweep and the replay run the same
engine, so that agreement is the file checking itself: everything the policy did
is in the recording, in order.

It is not a second implementation of the rules: commands go through
`CombatSystem.fireShot`, `throwGrenade`, `MovementSystem` and `TurnManager`, the
doors a match uses. Movement is advanced at a fixed step, because a variable one
would make a replay depend on how fast the machine running it is.

## Two streams, not one

`SimMatch` draws its **dice** from `matchDice(seed)` and its **setup** — dealing
the squads — from a separate `Rng`. They shared one stream until intent-only
landed, and that made *how many numbers a sheet consumed* decide every roll
after it: adding one attribute per character once shifted every die in a
400-match sweep, and a replay (which deals nobody) began the dice where the sim
had finished dealing and resolved a different match.

A match is still one number. Its dice are a function of that number alone.

## One engine, not two

Until ITEM-030 the sweep ran on its own copy of the soldier (`SimUnit`) and its
own turn loop, written when a soldier could not exist without a scene. That
stopped being true a day later (ITEM-001) and the copy stayed. Replaying sweep
matches through `MatchHost` and comparing state intent by intent found it had
drifted in four places — wounds cost it no action points, it settled a handover
in the opposite order, walking never counted toward exhaustion on the ECS side,
and the host never settled a turn at all. None broke a test; each moved every
balance number a little. The sweep now drives `MatchHost`, so a balance number
is a measurement of the game by construction, at the same speed (~7 s per 400
matches).
