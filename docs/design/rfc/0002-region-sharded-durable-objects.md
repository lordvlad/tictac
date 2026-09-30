---
title: "RFC 0002: Region-Sharded Durable Objects"
id: "RFC-0002"
type: "rfc"
status: "proposed"
lastReviewed: "2026-10-02"
appliesTo:
  - "workers/**"
  - "src/server/Persistence.ts"
relatedDocs:
  - "docs/design/rfc/0001-referee-and-transports.md"
  - "docs/design/gdd/overview.md"
  - "docs/architecture/deployment.md"
  - "docs/backlog/active-backlog.md"
tags: ["network", "cloudflare", "durable-objects", "scaling", "rfc"]
---

# RFC 0002: Region-Sharded Durable Objects

**Status: proposed.** Nothing in this document is built. `[ITEM-045]` runs one Durable Object
for the whole deployment today, deliberately — see
[ARCH-DEPLOYMENT §2.1](../../architecture/deployment.md#21-one-durable-object-not-one-per-match).
This is the plan for what replaces that single instance once it needs replacing, and it is
gated on a game feature that does not exist yet (§1). It is written now because the shape of
the replacement changes what "a match server" is allowed to assume in the meantime — see §5.

## 1. Why this is not urgent, and why it is written anyway

One Durable Object is correct for the game that exists today: two friends, a handful of
concurrent matches, one process. Nothing about the current player base needs sharding.

It stops being correct the moment the [GDD](../gdd/overview.md)'s shared world ships — base
building, an economy, regional chat over radio networks, a persistent campaign roster that
lives in a world rather than between matches. RFC-0001 §9 names this explicitly: combat is one
subsystem, built first because it has to feel right; the shared world is the rest of the
product. A shared world means players are online and *present* in it continuously, not only for
the few minutes a match takes — a different load shape than today's, and one a single
single-threaded Durable Object cannot absorb no matter how large Cloudflare lets one grow,
because a Durable Object does not scale vertically. Its instance is one thread; the ceiling is
fixed the day it is hit, not raised by a bigger plan.

Writing the plan before the wall is hit, rather than after, is why this is an RFC now: it
constrains `[ITEM-045]`'s single instance and RFC-0001's assumptions (one referee, one `Db`) to
be a deliberate first stage of *this* design rather than an accident that later has to be
unpicked under load.

## 2. The shape of the plan

**Shard by game region, not by match.** A Durable Object owns one region of the shared world —
its real-time state, and the players currently present in it — addressed by a region id rather
than the fixed `'singleton'` name `workers/index.ts` uses today. A player's socket connects to
whichever Durable Object owns the region their character currently stands in.

**The world starts whole, and fractures over time — deliberately, and in the story.** Rather
than a map pre-divided into many small zones from the day the shared world ships, it begins as
one zone: one Durable Object owns the entire world, which is exactly `[ITEM-045]`'s single
instance already (§5). As the player base and its load grow, zones are split off the whole —
first one seam, then more — each split handed to a fresh Durable Object. This is worldbuilding
as much as it is infrastructure: the fracturing is written into the game's meta-story rather
than being an invisible technical migration, which is also what buys the next paragraph its
answer for free.

**Crossing a zone boundary is a deliberate act, not a continuous position that happens to cross
a line.** A border is not open terrain a character can wander back and forth over without
meaning to; it is a designed transition (a gate, a checkpoint, whatever the meta-story names it
once it exists) that a player chooses to go through. This removes the oscillation problem
structurally rather than needing a tuned hysteresis margin (§6.2): there is nothing to debounce
when the crossing itself is one discrete, intentional action instead of a coordinate that can
drift across a boundary and back.

**The hand-off is the source's responsibility.** The Durable Object currently holding a player
initiates their hand-off to the destination when a crossing happens — not an external
orchestrator, and not the destination reaching in to pull the player over. §4 is the shape of
what it hands off.

**A zone splits under load rather than being sized up front.** When a zone's Durable Object
approaches capacity, a new Durable Object is started to own a piece freshly cut from it. A
player already standing in the piece that just changed hands is not crossing anything — the
ground under them changed owner, not their position — so there is no intent to read, only a
static location to reassign against the new boundary. Reassigning them while they are offline is
strictly preferable to doing it while connected, and costs nothing extra to wait for: a player
who never logs off simply keeps talking to their zone's original instance until they do. Nothing
here ever merges two zones back down; a zone that empties out is simply an idle Durable Object,
which costs nothing extra to leave running (§6.5 is still open on whether that holds once real
billing is on the line).

This gives horizontal scaling with the overhead concentrated exactly where the game already has
a natural seam — a zone boundary, made deliberate rather than ambient — instead of an artificial
shard key (player id, connection order) that would turn every cross-region interaction between
two players into a cross-shard one regardless of whether they are standing next to each other.

## 3. What has to exist before this can be built

None of it exists yet:

- **The shared world itself**, as one whole zone to start: a coordinate space bigger than one
  battlefield, and something for a player to be "present" in between matches. Today's game has
  neither; a match is the entire unit of play and ends in a debrief screen, not a place a
  character keeps standing in. The *many* zones this RFC eventually needs do not have to exist
  up front — see §2 — but the single whole-world zone, and a reason within the story for it to
  someday fracture, do.
- **A directory: region id → owning Durable Object.** `env.MATCH.idFromName('singleton')` is a
  constant today; a region's owner is not, once a region can split. **Decided (§6.3):** Workers
  KV, read by every routing decision. Its eventual consistency is an accepted trade for not
  adding a directory Durable Object as one more hop in front of every request; a brief window
  where two Workers disagree about who owns a freshly-split zone is judged cheaper than that hop
  paid on every request forever.
- **A hand-off protocol between two Durable Object instances.** Cloudflare Durable Objects can
  call each other directly (RPC, or a Worker-mediated fetch); nothing today exercises that path.
  §4 is the shape of what needs to cross it.

## 4. What actually transfers at a boundary

**Not the roster.** `Persistence` — accounts, rosters, the match log — is one logical store
today (`src/server/db/Db.ts`, `[ITEM-012]`, `[ITEM-045]`'s `Db` adapter), addressed by whichever
Durable Object happens to hold the connection, and nothing about a roster is regional: a
character's sheet, deeds and growth mean the same thing whichever part of the world they are
standing in. Splitting *that* store by region would mean a player's own roster lives in a
different place depending on where they last stood, which turns every read of "my roster" into
a lookup of where it currently is — the load-bearing simplicity RFC-0001 §8.4 chose ("one
database, behind a portable port") lost for a scaling problem regional sharding does not
actually need solved that way. Persistence stays a store every region-owning Durable Object can
reach, sharded (if it ever needs to be) by whatever a database shards well by — not by region.

**What transfers is presence: a player's live session.** The open socket's transport, which
faction/side (if any) they are attached to, their position and heading in the region, and
whatever the region simulation was holding about them in memory — the equivalent of `Referee`'s
`this.clients`/`this.sides` today, scoped to one region instead of one match. **Decided:** the
Durable Object currently holding the player is responsible for the hand-off — it initiates it
the moment a deliberate crossing happens, rather than a directory or the destination instance
reaching in to pull the player over. The source instance closes out cleanly (the same shape as
a match ending unwatched, RFC-0001 §8.6); the destination instance opens a session the way
`MatchDurableObject.fetch` opens one today, reading whatever durable state it needs from the
one shared `Persistence`, not from the instance it is succeeding.

**Decided: a match never spans two Durable Objects (§6.4).** A match belongs entirely to
whichever region's instance was hosting it when it started, the same way it belongs to one
`Referee` today. What prevents two players from starting a fight exactly on a zone boundary is
left to the world and the story — the fracturing itself is meta-story territory (§2), and the
same design pass that decides where a border runs and why is responsible for there being a
reason combat does not break out standing on top of one.

This is the same reason a match rejoin (`resume`/`log`, RFC-0001 §5) is a **replay from the
durable log**, not a live memory copy from one process to another: a hand-off that depends on
reconstructing state from what is already durable is robust to the source instance being gone
by the time the destination asks; a hand-off that depends on shipping live memory between two
instances is not, and does not need to be, because nothing regional is meant to be
irreplaceable the way a match's command log is.

## 5. What this means for `[ITEM-045]` now

Not "replaced later" so much as "already region zero." §2's whole-world-first zone is exactly
the single `MatchDurableObject` instance that exists today — this RFC does not ask for a second
deployment model to migrate to, only for that instance to keep two things true so it is not
accidentally load-bearing for an assumption this RFC removes:

1. **`env.MATCH.idFromName('singleton')` is a placeholder for a lookup, not a constant to build
   more routing logic on top of.** Anything that starts depending on there being exactly one
   Durable Object (rather than going through a lookup that happens to always return the same
   one today) is debt against this RFC.
2. **A match today is not "in" a region**, and does not need to become one before combat ships —
   `[ITEM-045]`'s single referee is correct for a game with no persistent world to place a match
   in. This RFC only starts mattering once §3's prerequisites exist.

## 6. Open questions

1. ~~How is "at capacity" measured, and who decides a region splits?~~ **Decided: CPU time, plus
   client latency measured against what a player's real-world physical distance would predict.**
   Concurrent sockets alone was the cheapest signal but too blind to a region whose few players
   are all fighting in one spot; CPU time reads what actually costs a Durable Object directly.
   Latency-versus-distance is the second signal: a player whose measured latency is
   *worse* than their real-world distance to the instance would predict is evidence of an
   overloaded instance, not a far-away player, which a raw latency number alone cannot tell
   apart. What remains open, genuinely: the actual thresholds. Both signals need real metrics
   from a real deployment before a split trigger can be tuned, and that tuning is left for when
   there is traffic to tune it against.
2. ~~What stops a player oscillating near a boundary from being handed off repeatedly?~~
   **Decided, structurally rather than algorithmically: it cannot oscillate, because crossing a
   boundary is a deliberate act** (§2), not a coordinate that can drift back and forth over an
   invisible line. There is nothing to debounce once the crossing itself is a discrete,
   intentional action rather than continuous position tracking. See §7 for the alternative this
   replaced.
3. ~~Directory consistency~~ **Decided: Workers KV**, accepting its eventual-consistency window
   rather than paying a directory Durable Object's extra hop on every routing decision forever.
   A brief window where two Workers disagree about who owns a freshly-split zone is the
   accepted cost (§3).
4. ~~Can a match ever span two regions?~~ **Decided: no** (§4). A match belongs entirely to
   whichever instance was hosting it when it started. What is still open is not the rule but its
   enforcement: the world and its story need to make sure combat does not start standing exactly
   on a boundary in the first place, which is a level-design and narrative question, not an
   engineering one, and cannot be answered before the shared world exists to design a border
   into.
5. **Does a region ever get reassigned back to a merged, larger Durable Object once load drops?**
   Still open. §2 states it does not, for simplicity; whether an idle half-region Durable Object
   is cheap enough to leave running forever is a real cost question once Cloudflare's pricing is
   being paid for real rather than dry-run.

## 7. What this RFC rejects

- **Sharding by match, again.** RFC-0001 §7 already named "a Durable Object per match" as an
  alternative to the single instance `[ITEM-045]` built, and rejected it for the same reason it
  is rejected here in the shared-world shape: a match is not what a player spends most of their
  time inside of once there is a world to stand in between matches. Region is the seam that
  exists continuously; a match is not.
- **Sharding by player id.** A consistent hash over player ids balances load evenly with none of
  region-sharding's boundary-crossing complexity — and none of its locality either. Two players
  standing next to each other, fighting each other, would as likely as not land on two different
  shards, turning the one interaction regional sharding is built to keep cheap (nearby players
  talking to the same Durable Object) into the one it was meant to avoid.
- **A map pre-divided into many small zones from day one.** Considered directly, alongside the
  organic alternative this RFC chose (§2): building the shared world already cut into zones
  small enough to be sharded from the start. Rejected in favour of starting whole and fracturing
  the world over time, folded into the game's own meta-story, rather than shipping the scaling
  concern as a piece of invisible level geometry nobody in the fiction ever notices.
- **Inferring a border-wandering player's crossing intent, to move them only while offline.**
  The instinct is reasonable — moving a connected player is disruptive, and an offline one is
  free to move — but telling "wandering along one side of a border" from "mid-crossing when they
  logged off" from position history alone is exactly the kind of ambiguity that produces the
  oscillation this RFC is trying to avoid. Replaced by making the crossing itself deliberate
  (§2): there is no intent left to infer, because the player already stated it by choosing to
  cross.
- **Scaling the single Durable Object up rather than out.** Not a choice available to reject so
  much as one that does not exist: a Durable Object instance is one thread, and Cloudflare does
  not offer a bigger one to move to.
