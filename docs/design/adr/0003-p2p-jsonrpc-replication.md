---
title: "ADR-0003: P2P JSON-RPC 2.0 State Replication & Sender-Resolved Combat"
id: "ADR-0003"
type: "adr"
status: "implemented"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "src/game/NetworkManager.ts"
  - "src/game/JsonRpc.ts"
  - "src/ecs/World.ts"
relatedDocs:
  - "docs/architecture/networking.md"
  - "docs/architecture/ecs.md"
tags: ["networking", "peerjs", "jsonrpc", "p2p", "replication"]
---

# ADR-0003: P2P JSON-RPC 2.0 State Replication & Sender-Resolved Combat

## Status
**Status:** Implemented
**Date:** 2026-09-14
**Deciders:** Engineering

---

## Context & Problem Statement
Tactical online play requires low-latency synchronization across browser clients without necessitating an authoritative hosted server for every peer match. Two primary challenges exist:
1. Replicating mutable entity state (HP, AP, position, stances, traits) without massive whole-world state payloads.
2. Resolving dice rolls, criticals, and damage calculations deterministically across peers with differing loadouts.

---

## Decision Outcome
**Chosen Architecture:** PeerJS WebRTC DataChannels formatted with standard JSON-RPC 2.0 frames (`src/game/JsonRpc.ts`) and a dual-tier replication model.

### 1. Component Dirty-State Replication
- `World.ts` maintains a snapshot cache of every component's serialized state.
- Calling `World.syncDirty()` computes structural diffs (`jsonEqual`) and emits `componentUpdate` JSON-RPC notifications.
- Remote peers unpack notifications and apply updates directly to entity component instances with an `applyingRemote` guard to prevent feedback loops.

### 2. Sender-Resolved Combat Intent
- Combat actions are calculated and resolved on the **acting peer's client**.
- Dice rolls, hits, damage, armor shred, and critical status are packed into `WireHit` structures and transmitted as `fireShot` or `throwGrenade` messages.
- The receiving peer applies the exact numbers verbatim and triggers the visual/audio FX, eliminating cross-peer roll desyncs.

### Consequences
- **Positive:**
  - Minimal bandwidth overhead (only dirty component properties transmit).
  - Clean separation between intent commands (`NetworkMessage`) and state propagation (`World.syncDirty`).
- **Negative / Costs:**
  - Client-side resolution requires strict input sanitization (`sanitizeSheet`) against malicious peer payloads in competitive contexts.
