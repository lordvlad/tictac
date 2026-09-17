---
title: "RFC 0001: Full-Knowledge Lockstep, With an Optional Referee"
id: "RFC-0001"
type: "rfc"
status: "accepted"
lastReviewed: "2026-09-17"
appliesTo:
  - "src/game/NetworkManager.ts"
  - "src/game/JsonRpc.ts"
  - "src/game/Recording.ts"
  - "src/sim/SimMatch.ts"
  - "src/ecs/World.ts"
relatedDocs:
  - "docs/design/adr/0003-p2p-jsonrpc-replication.md"
  - "docs/design/adr/0002-deterministic-headless-balance-harness.md"
  - "docs/design/gdd/noise-and-stealth.md"
  - "docs/backlog/active-backlog.md"
tags: ["network", "referee", "transport", "authority", "rfc"]
---

# RFC 0001: Full-Knowledge Lockstep, With an Optional Referee

**Status: accepted**, and graduated into [ADR-0004](../adr/0004-full-knowledge-lockstep.md),
which records the decision and its consequences. This document stays as the reasoning behind
it, including the alternatives that were rejected and why. The decision is in §2. Open questions that remain are in §8, and two of
them are holes this design *opens* rather than inherits.

## 1. Why this exists

Two threads met here: whether enemy state can be hidden from a client, and where a campaign
roster lives once it outlives a match.

The first has a cost nobody wanted to pay. Hiding information means an entitlement decision
per piece of state — position, sheet, action points, ammunition, statuses, grenade counts —
each needing a rule, a ghost policy for when it goes stale, and a HUD story for showing
uncertainty. That is a large amount of machinery whose effect on play is approximately nil in
a game two friends play against each other.

## 2. The decision

**Everything is known to both clients. Nothing is secret at the protocol level.** Fog of war
and intel fog remain what they already are: filters over what a client *draws*, not over what
a client *holds*.

Given that, the architecture is:

1. **Full-knowledge lockstep.** Both peers hold identical state, exchange **intent only**, and
   both recompute the outcome. No resolved payloads on the wire.
2. **An optional referee**, which recomputes the same intent stream and can say **who** broke
   the rules. It is a *witness*, not an authority.
3. **Local and peer-to-peer play keep working with no referee at all.** Joining a server is
   what buys persistence, rejoining after a crash, and attribution.

### Why this is better than either destination in the previous draft
The earlier version of this RFC framed intent-only lockstep and a referee as mutually
exclusive, because it assumed a referee existed to *hide* things. Dropping secrecy dissolves
that: a referee that only verifies does not need to be in the data path.

| | Previous draft's referee | This design |
| --- | --- | --- |
| Referee in the data path | Yes — every action round-trips | **No** — clients resolve locally, instantly |
| Latency cost | A round trip per action | **None** |
| Prediction and reconciliation | Required | Not needed; there is nothing to predict |
| Per-peer projection | Required, and complex | **Deleted** — see `ITEM-026`, rejected |
| Referee unavailable | Match cannot proceed | Match proceeds; nobody is watching |

### 2.1 Preconditions, not open questions

Two requirements fall out of the decision. They are listed here rather than in §8 because
neither is undecided — they are things that must be true before the parts that depend on them
are switched on.

1. **A build/protocol gate precedes any abort.** This project deploys on every push, so two
   peers on different bundles diverge for entirely innocent reasons, and a divergence report
   that names a side is an accusation. Mismatched builds must therefore refuse to *start* a
   match, which turns the whole class into a connection error with a clear cause instead of a
   foul with a wronged party. `ITEM-022` ships before `ITEM-025` can accuse anybody.
2. **A stored log is only a store of record if it can be replayed.** Determinism is not a
   fairness property here, it is what makes persistence possible at all (§9).

## 3. What the referee is actually for

Not detection — **attribution.**

With two parties, a disagreement is symmetric: each sees a mismatch and neither can prove
which side is wrong. Adding a third recomputation makes it two against one. That is the whole
product, and it is worth being precise that this is the *only* thing the third party adds,
because two peers can already detect disagreement by themselves (`ITEM-020`, `ITEM-021`).

The other two things a server brings are unrelated to cheating and are the reason to want one
anyway:

- **Persistence.** A roster that survives a match needs a home that is not one player's tab.
- **Rejoin.** A crashed tab can be rebuilt from the intent log.

### What it cannot see, stated plainly
- **Reading what you were sent.** A maphack is a read; no recomputation can observe it. This is
  accepted, and it is the price of the decision in §2.
- **Choosing well because you read too much.** Every intent a cheat submits is a *legal* intent.
- **Anything before the first intent.** See §8's provenance hole.

## 4. Why loaded dice stop being possible to fake quietly

Under intent-only, nobody sends a roll. Dice come from the match stream, derived from a shared
seed in an order the rules fix, so a client that "rolls" differently does not get a better
outcome — it gets a *different world*, which its peer and the referee both notice at the next
digest. Faking a die stops being a lie and becomes a desynchronisation, and the referee turns
that from "somebody is wrong" into "this side is wrong".

That is why `ITEM-022` (one match RNG, drawn only by the rules) is load-bearing twice over: it
is what makes the dice unfakeable, and it is what makes rejoin possible at all.

## 5. One log, four uses

The intent stream is already a format this repository produces and consumes:

| Use | Status |
| --- | --- |
| Replay a recorded match | Exists — a captured sample is 57 events with **no outcomes**, rebuilt by re-running the rules |
| The wire between two peers | `ITEM-023` |
| A referee's input | `ITEM-025` |
| Rebuilding a client that crashed | `ITEM-025`, same log, replayed on connect |

Four uses, one format, and the first already works. This is the strongest single argument for
the decision: the expensive property — *intent plus identical steps reproduces the match* — is
already relied upon by the recorder, and nothing currently checks it.

## 6. Transports

Unchanged from the previous draft, and confirmed rather than remembered: **Bun has no
WebRTC.** The published documentation does not mention `WebRTC`, `RTCPeerConnection` or
`datachannel` anywhere; server-side WebRTC would mean native bindings (`node-datachannel`) or
a large pure-JS stack (`werift`). It is also the wrong tool — WebRTC exists for NAT traversal
between two clients that cannot address each other, while a referee has a URL.

```ts
export interface Transport {
  send(frame: JsonRpcFrame): void
  onFrame(handler: (frame: JsonRpcFrame) => void): void
  onClosed(handler: (reason: string) => void): void
  close(): void
}
```

| Transport | Used by |
| --- | --- |
| `DataChannelTransport` | peer-to-peer play (PeerJS, unchanged) |
| `SocketTransport` | a referee in a `Bun.serve` process |
| `LoopbackTransport` | tests: a linked pair, in one process, no broker and no sockets |

`LoopbackTransport` earns its place on test ergonomics alone — the network tests currently
hand-build a fake channel to observe what a peer would have transmitted, which is a transport
implementation written in a test file and not called one.

**One codec: a JSON string on every transport.** A socket needs a string anyway, and Bun
documents a `postMessage` fast path that bypasses structured cloning entirely for strings — so
uniformity is also the faster option wherever an object would have been possible, and a frame
a test handed straight to its peer is byte-identical to one that crossed a network.

**Route through the referee when there is one.** It removes the signalling broker, gives the
log a canonical order, and means a rejoining client does not have to renegotiate a peer
connection mid-match. Peer-to-peer remains the no-referee path, and local versus stays exactly
what it is: the rules, in the page, with nothing in between.

## 7. Deployment

- **Bun process** — the only host. `wss://` needs a host and a certificate, because the game is
  served from Pages over `https`. Chromium treats `ws://localhost` as potentially trustworthy,
  so a referee on the player's own machine works from the deployed site in Chrome; Firefox and
  Safari are stricter. A public referee is where this project starts paying for
  infrastructure — the same moment persistence does, which is why they are one item.

## 8. Open questions, including two holes this design opens

1. **Match provenance.** Nothing after the first intent can be faked quietly — but everything
   *before* it can. The host picks the seed, so a host can grind seeds until it likes the map;
   and peers currently roll their own squads and send them in the `ready` handshake, so a peer
   can roll ten squads and keep the best. Both are legal from the first intent onward and no
   recomputation will ever see them. The fix is small and is the one place cryptography earns
   its keep: derive the seed from **both** peers' committed contributions. See `ITEM-027`.
   Note this revisits a deliberate earlier decision — that a peer's people are its own
   business, clock-seeded rather than derived from the match seed.
3. ~~What happens when a foul is found?~~ **Decided: abort.** A match whose state two of three
   parties no longer agree on is not a match, and playing it out produces a result that cannot
   be written to the roster — which, in a game whose foundation is persistence, is the only
   thing a match is *for*. Specifics:
   - The log is kept, not discarded. It is the evidence, and it is the only way to tell a foul
     from a bug in the rules.
   - The abort names a side and a reason, because "desynchronised" is not something a player
     can act on.
   - The version gate (`ITEM-022`) is a **precondition**, not a nicety: without it the first
     aborted match will be somebody on a stale bundle.
   - Unwatched matches cannot abort on a foul. With no referee there is no third opinion, so
     peer-to-peer play detects disagreement and can only stop; it cannot attribute.
4. **Does the referee store the log durably, and in what?** `bun:sqlite` is built in and the
   repo already reads SQLite. Persistence and the log are probably one store.
5. **Does the balance harness become a referee client?** It currently *is* the rules; driving a
   referee over a port would make the harness test the real server, at the cost of a 7-second
   sweep getting slower.
6. **Referee loss mid-match.** A witness going away is survivable by construction — the match
   continues unwatched. Whether it can re-attach and catch up from the log is a nice-to-have
   that falls out of rejoin.

## 9. How this fits the game that is actually being built

Worth stating plainly, because it changes what several items in this RFC are *for*.

The [GDD](../gdd/README.md) describes a PvPvE game with base building, an economy, research
and a campaign roster in a shared world. **Combat is one subsystem of it**, and it is the one
being built first because it is the part that has to feel right. Peer-to-peer play, recording
and replay are **debug helpers and demo entry points** — a way to exercise the rules with two
humans and to inspect what happened — not the product.

Persistence is the foundation everything else stands on. That reorders the justifications:

| Item | Justified by P2P fairness | Justified by the foundation |
| --- | --- | --- |
| `ITEM-020` shadow resolution | Catches a bug class that only manifests with two peers | The same comparison a server does; the first test of "the rules are reproducible" |
| `ITEM-021` digest | Two peers agreeing | A match's state is checkpointable, which is what rejoin and audit stand on |
| `ITEM-022` determinism | Unfakeable dice | **Load-bearing**: without it a stored log cannot be replayed, so it cannot be a store of record |
| `ITEM-023` intent-only | A smaller wire | The match becomes an **event log** — the natural shape for an event-sourced store |
| `ITEM-025` referee | Attribution | The store *is* the referee; recomputing is what it does with what it holds anyway |

Read that way, none of this is networking work. It is the work that makes a match a durable,
replayable, auditable fact — and the peer-to-peer mode is the cheapest available way to test
that property today, with two independent recomputations of the same log.

Two consequences follow, and both are cheap now and expensive later:

1. **The log is a schema, not a debug dump.** It already carries `header.version`, which was
   foresight. From the moment a roster is written from a log, the format needs the same
   discipline the generated catalogue gets: a guard that fails when a component's serialised
   shape changes without a migration. See `ITEM-028`.
2. **`localStorage` is a demo store, not the store of record.** `ITEM-012` was written against
   it. Once there is a server, the roster lives there, and the handshake stops carrying saved
   sheets at all — the server already has them. That is a *simplification* of the trust story,
   not an addition: a peer can no longer send a tampered roster because it does not send one.

## 10. What this RFC rejects

- **A referee in a `Worker`.** A thought experiment about symmetry with no job: a witness inside
  one player's process cannot attribute anything about that player, and local versus needs no
  referee to run the rules in-page. Struck before it cost anything.
- **Match provenance** (`ITEM-027`): committing to a nonce so neither side can grind the seed
  or reroll its squad. Rejected because it defends peer-to-peer play, which is a debug utility
  rather than a mode anybody is scored in — and because a server rolls a new player's roster
  anyway, so there is nothing for a client to grind.
- **Per-peer projection** (`ITEM-026`): entitlement per component, ghosts for stale state,
  uncertainty in the HUD. Rejected as complexity with no effect on play. Kept in the backlog
  as a rejected item, because the reasoning is worth more than the outcome.
- **A referee in the data path.** It would cost a round trip per action to buy secrecy this
  RFC has decided not to have.
- **Server-side WebRTC.** §6.

## 11. A standing invariant this will retire

`AGENTS.md` states sender-resolved combat as a core architectural invariant, and
`docs/architecture/overview.md` documents `WireHit` as how an attack travels. Both are accurate
today and both become wrong the moment `ITEM-023` lands. They are named here so the change is a
deliberate edit at that point rather than a document that quietly stops being true.
