---
title: "ADR-0004: Full-Knowledge Lockstep With an Optional Referee"
id: "ADR-0004"
type: "adr"
status: "accepted"
lastReviewed: "2026-09-17"
appliesTo:
  - "src/game/NetworkManager.ts"
  - "src/game/JsonRpc.ts"
  - "src/game/Recording.ts"
  - "src/ecs/World.ts"
relatedDocs:
  - "docs/design/rfc/0001-referee-and-transports.md"
  - "docs/design/adr/0003-p2p-jsonrpc-replication.md"
  - "docs/design/adr/0002-deterministic-headless-balance-harness.md"
tags: ["networking", "lockstep", "authority", "persistence", "referee"]
---

# ADR-0004: Full-Knowledge Lockstep With an Optional Referee

## Status
**Status:** Accepted
**Date:** 2026-09-17
**Deciders:** Engineering
**Supersedes:** the sender-resolved half of [ADR-0003](./0003-p2p-jsonrpc-replication.md)
**Reasoning:** [RFC-0001](../rfc/0001-referee-and-transports.md)

---

## Context & Problem Statement

[ADR-0003](./0003-p2p-jsonrpc-replication.md) made the acting peer resolve an attack and ship
the numbers. That bought instant feedback and one code path shared with the headless harness,
and it carries a standing cost: the attacker must know things about the *target* that only the
target's owner truly knows. Three bugs of exactly that shape have shipped and been fixed one
property at a time — target evasion, the plate carrier's `damageTaken`/`evasionCrouched`, and
`unreadable` — each silently, each applying a wrong number with nothing complaining.

Two further questions arrived with the wider design. Can enemy state be hidden from a client
at all? And where does a campaign roster live once it outlives a match?

The second is the load-bearing one. Per the [GDD](../gdd/README.md), combat is **one subsystem**
of a much larger game; peer-to-peer play, recording and replay are debug helpers and demo
entry points, and persistence is the foundation the rest stands on.

## Decision

1. **Nothing is secret at the protocol level.** Both clients hold identical state. Fog of war
   and intel fog stay filters over what a client *draws*.
2. **Intent only on the wire.** Both peers recompute every outcome. Resolved payloads
   (`WireHit`) are deleted rather than deprecated.
3. **An optional referee**, a `Bun.serve` process, recomputes the same intent stream. It is a
   **witness, not an authority**: it is not in the data path, costs no latency, and a match
   plays on unwatched without it. What it buys is persistence, rejoin after a lost client, and
   *attribution* — two peers can detect a disagreement, but neither can prove whose fault it
   is until a third recomputation makes it two against one.
4. **A foul aborts the match.** The log is kept as evidence, and the abort names a side and a
   reason.
5. **Determinism is a persistence property, not a fairness property.** A stored intent log that
   cannot be replayed is not a store of record.

### Preconditions

- **A build/protocol gate precedes any accusation.** This project deploys on every push, so two
  peers on different bundles diverge innocently. Mismatched builds refuse to *start*, turning
  the whole class into a connection error with a stated cause instead of a foul with a wronged
  party.
- **One log, four uses**: replay, the wire, the referee's input, and rebuilding a client that
  crashed. The recorder already proves the first — a captured match is an intent stream with no
  outcomes in it — and nothing currently checks it, which is what makes this work overdue
  rather than speculative.

## Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Keep sender-resolved | The bug class survives as a rule everyone must remember; the wire asserts arithmetic nobody checks |
| Both peers roll and exchange | Needs a round trip inside an action, and is honest only with commit-reveal |
| Referee as authority, in the data path | A round trip per action to buy secrecy this ADR declines to have |
| Per-peer projection of state | An entitlement rule, a ghost policy and a HUD story *per component*, for no effect on play |
| A referee in a `Worker` | A witness inside one player's process cannot attribute anything about that player |
| Match provenance by commitment | Defends a debug utility; the server rolls a new player's roster, so there is nothing to grind |
| Shared-seed lockstep without verification | Divergence would be silent, which is the failure mode being removed |

## Consequences

**Positive**
- The bug class disappears structurally: an attacker never needs a fact it does not own.
- A match becomes a durable, replayable, auditable event log — the substrate persistence needs.
- A faked die stops being a lie and becomes a desynchronisation, which a digest catches and a
  referee attributes.
- The wire shrinks; `WireHit`, `toWireHits`/`fromWireHits` and the resolved-replay path go.

**Negative / accepted costs**
- A maphack is a read, and no recomputation observes a read. Accepted.
- Determinism becomes total rather than partial: one match RNG drawn only by the rules, no
  transcendental feeding a decision unquantised, identical entity ids and iteration order.
- Two peers on different builds must be refused rather than tolerated.
- The log becomes a schema, needing a drift guard and a version policy.

**Documents this retired when the work landed** (all three updated with `ITEM-023`)
- `AGENTS.md`'s sender-resolved invariant, now "intent on the wire, resolved on both sides".
- `docs/architecture/overview.md`'s `WireHit` description.
- The sender-resolved half of ADR-0003.

## Implementation status

Staged, in this order, and tracked in the [backlog](../../backlog/active-backlog.md):

| Item | What | State |
| --- | --- | --- |
| `ITEM-022` | Determinism audit: version gate, one match stream, float discipline | **Landed** |
| `ITEM-020` | Shadow resolution: re-derive a received attack and report disagreement | **Landed, then retired by `ITEM-023`** — with no numbers on the wire there is nothing to re-derive |
| `ITEM-021` | State digest at the turn boundary, for drift | **Landed** — and now the only check on agreement |
| `ITEM-023` | Intent-only wire; `WireHit` deleted | **Landed** |
| `ITEM-024` | Transport port: PeerJS behind a seam, plus socket and loopback | Deferred until the referee is its second caller |
| `ITEM-025` | The referee: witness, persistence, rejoin, abort on foul | Backlog |
| `ITEM-028` | Log and store schema drift guard | Ready |
