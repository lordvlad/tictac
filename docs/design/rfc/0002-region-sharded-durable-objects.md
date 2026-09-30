---
title: "RFC 0002: Region-Sharded Durable Objects"
id: "RFC-0002"
type: "rfc"
status: "proposed"
lastReviewed: "2026-10-03"
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
its real-time state, and the squads currently present in it — addressed by a region id rather
than the fixed `'singleton'` name `workers/index.ts` uses today. A connection routes to
whichever Durable Object owns the region a player's squad currently stands in.

**A zone is not a thing with an identity.** It is shorthand for whatever spatial partition of
the shared world's content — its towns, its landscapes, the squads currently standing in it —
one Durable Object is presently responsible for. The content is durable and continuous; the
*assignment* of that content to a serving Durable Object is what changes when a split or a
merge happens. Nothing here ever asks "which zone is this, historically" — only "which Durable
Object owns this ground right now."

**The world starts whole, and is redrawn over time — deliberately, and in the story.** It begins
as one partition: one Durable Object owns the entire world, which is exactly `[ITEM-045]`'s
single instance already (§5). As the player base and its load grow, pieces are cut off the whole
— first one seam, then more — each handed to a fresh Durable Object, and each dressed in
whichever piece of the fiction fits: a fence goes up, a faction claims territory, a new base
changes who controls a crossing, a political border closes. The toolkit is not limited to one
device, so it is not expected to run out before the game does — this is worldbuilding as much as
it is infrastructure, and it does not need to anticipate every load spike a real player base
could produce to be good enough for one. (Realistically: it will not handle everyone arriving at
once gracefully, and that is an accepted limit of a one-person hobby project, not a design flaw
to be engineered away.)

**Crossing a boundary is a deliberate act, not a continuous position that happens to cross a
line.** A border is not open terrain a squad can wander back and forth over without meaning to;
it is a designed transition (the gate, the checkpoint, whatever the fiction names it) that a
player chooses to go through. This removes the oscillation problem structurally rather than
needing a tuned hysteresis margin (§6.2): there is nothing to debounce when the crossing itself
is one discrete, intentional action instead of a coordinate that can drift across a boundary and
back. The same fiction toolkit does the same job at a border a player never deliberately crosses
but can still see across: whatever justifies the boundary justifies why the far side is not
visible or reachable from up close either.

**The hand-off is the source's responsibility.** The Durable Object currently holding a
connection initiates its hand-off to the destination when a crossing happens — not an external
orchestrator, and not the destination reaching in to pull the connection over. §4 is the shape
of what it hands off.

**A partition is redrawn at the game's own natural disconnect windows, proactively rather than
reactively, and the same trigger runs in both directions.** At roughly 80% of whatever §6.1's
capacity signal measures — deliberately before the instance is actually struggling, not after —
a new Durable Object is created to own a piece freshly cut from the busy one. From that moment,
every *new* arrival is routed to whichever of the two now owns its location; there is nothing to
transition for a connection that does not exist yet. A connection that already exists, standing
in the piece that just changed hands, is not crossing anything (§2's identity note: the ground
under it changed owner, not its position) and does not need to be moved immediately — it is
reassigned at the next disconnect the deployment was already going to force, most often a
schema-migrating deploy (`[ITEM-045]`'s `migrate.ts` forward-only migrations already run at
Durable Object startup, so a deploy that changes the schema already means every affected
instance restarts). No bespoke idle-detection system is needed to catch a connection quietly and
politely; the game already has to reconnect everyone for other reasons often enough to double as
this one. The same mechanism runs in reverse — a partition whose load falls back below a lower
mark is folded back into a neighbour at the same windows, dressed the same way in the fiction
(§6.5) — because, per the pricing research in §6.5, leaving an emptied-out split sitting on its
own is not free the way it first looked.

This gives horizontal scaling with the overhead concentrated exactly where the game already has
a natural seam — a boundary, made deliberate rather than ambient — instead of an artificial
shard key (player id, connection order) that would turn every cross-region interaction between
two players into a cross-shard one regardless of whether they are standing next to each other.

## 3. What has to exist before this can be built

None of it exists yet:

- **The shared world itself**, as one whole partition to start: a coordinate space bigger than
  one battlefield, and something for a squad to be "present" in between matches. Today's game
  has neither; a match is the entire unit of play and ends in a debrief screen, not a place a
  squad keeps standing in. The *many* partitions this RFC eventually needs do not have to exist
  up front — see §2 — but the single whole-world partition, and the fiction's capacity to
  eventually redraw it, do.
- **A directory: region id → owning Durable Object.** `env.MATCH.idFromName('singleton')` is a
  constant today; a region's owner is not, once a region can split. **Decided (§6.3):** Workers
  KV, read by every routing decision. Its eventual consistency is an accepted trade for not
  adding a directory Durable Object as one more hop in front of every request; a brief window
  where two Workers disagree about who owns a freshly-split partition is judged cheaper than
  that hop paid on every request forever.
- **A hand-off protocol between two Durable Object instances.** Cloudflare Durable Objects can
  call each other directly (RPC, or a Worker-mediated fetch); nothing today exercises that path.
  §4 is the shape of what needs to cross it.

## 4. What actually transfers at a boundary

**Position is a property of the squad, not of the connection.** This corrects what an earlier
draft of this RFC assumed: where a squad currently stands on the world map belongs to the squad
— the same durable thing its sheet, deeds and growth already are — not to a Durable Object's
transient in-memory session the way a match's live state is today. Exactly how (how often a
position is written, what "the world map" is structurally) is deferred to the world-map design
this RFC is not; what already follows from the correction is worth stating here, because it
answers two things this RFC would otherwise still be asking:

- **Cold-start routing has an answer.** A connecting or reconnecting player's squad has a last
  known position on record; the directory (§3) says which Durable Object currently owns it. No
  separate "where was this player" system needs to exist alongside it.
- **A presence connection is not forced to be the durable record of where a squad is,** which
  gives it more room to use Cloudflare's Hibernation API than a connection that would lose
  something irreplaceable by hibernating — the constraint that keeps `[ITEM-045]`'s match
  sockets non-hibernating today (`Referee`'s state has no durable backing) does not automatically
  carry over to a presence connection once position itself is durable. Whether it actually can
  hibernate depends on what else a presence connection ends up holding in memory beyond
  position, which is, again, the world-map design's to answer — but it bears directly on §6.5's
  economics.

**What still is not the roster: everything else `Persistence` already holds.** Accounts, the
sheet, deeds, growth and the match log stay one logical store (`src/server/db/Db.ts`,
`[ITEM-012]`, `[ITEM-045]`'s `Db` adapter) reachable by every region-owning Durable Object,
regardless of where a squad currently stands — nothing about a character's sheet or its owner's
account means anything different depending on which part of the world it is in. Splitting *that*
by region would turn every read of "my roster" into a lookup of where it currently lives, losing
the load-bearing simplicity RFC-0001 §8.4 chose ("one database, behind a portable port") for a
scaling problem regional sharding does not actually need solved that way.

**What transfers at a hand-off, beyond the durable position, is the rest of a squad's live
session:** the open socket's transport, which faction/side (if any) it is attached to, heading,
and whatever the region simulation was holding about it in memory beyond position itself.
**Decided:** the Durable Object currently holding the connection is responsible for the
hand-off — it initiates it the moment a deliberate crossing happens, rather than a directory or
the destination instance reaching in to pull the connection over. The source instance closes out
cleanly (the same shape as a match ending unwatched, RFC-0001 §8.6); the destination instance
opens a session the way `MatchDurableObject.fetch` opens one today, reading whatever durable
state it needs — including the squad's own position — from the one shared `Persistence`, not
from the instance it is succeeding.

**Decided: a match never spans two Durable Objects (§6.4).** A match belongs entirely to
whichever region's instance was hosting it when it started, the same way it belongs to one
`Referee` today. What prevents two players from starting a fight exactly on a boundary is left
to the world and the story — the same fiction toolkit that explains a boundary at all (§2) is
responsible for there being a reason combat does not break out standing on top of one.

This is the same reason a match rejoin (`resume`/`log`, RFC-0001 §5) is a **replay from the
durable log**, not a live memory copy from one process to another: a hand-off that depends on
reconstructing state from what is already durable is robust to the source instance being gone
by the time the destination asks; a hand-off that depends on shipping live memory between two
instances is not, and does not need to be, because nothing regional is meant to be
irreplaceable the way a match's command log is.

## 5. What this means for `[ITEM-045]` now

Not "replaced later" so much as "already region zero." §2's whole-world-first partition is
exactly the single `MatchDurableObject` instance that exists today — this RFC does not ask for a
second deployment model to migrate to, only for that instance to keep two things true so it is
not accidentally load-bearing for an assumption this RFC removes:

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
   Latency-versus-distance is the second signal: a player whose measured latency is *worse* than
   their real-world distance to the instance would predict is evidence of an overloaded
   instance, not a far-away player, which a raw latency number alone cannot tell apart. What
   remains open, genuinely: the actual thresholds. Both signals need real metrics from a real
   deployment before a split trigger can be tuned, and that tuning is left for when there is
   traffic to tune it against.

   **A related, still-open sub-question this raised: where a new Durable Object should be
   created.** Cloudflare lets a Durable Object's creation hint at a location. Decided in
   direction, not in formula: balance a partition's players' real-world physical distribution
   against their in-game position, rather than picking purely by one or the other. A player
   physically in Australia exploring an in-game region whose Durable Object was placed for a
   mostly-European population will see it — accepted, on the reasoning that this is turn-based
   squad combat, not a twitch shooter, and the genre's latency tolerance is generous enough that
   this is not expected to bite in practice.
2. ~~What stops a player oscillating near a boundary from being handed off repeatedly?~~
   **Decided, structurally rather than algorithmically: it cannot oscillate, because crossing a
   boundary is a deliberate act** (§2), not a coordinate that can drift back and forth over an
   invisible line. There is nothing to debounce once the crossing itself is a discrete,
   intentional action rather than continuous position tracking. See §7 for the alternative this
   replaced.
3. ~~Directory consistency~~ **Decided: Workers KV**, accepting its eventual-consistency window
   rather than paying a directory Durable Object's extra hop on every routing decision forever.
   A brief window where two Workers disagree about who owns a freshly-split partition is the
   accepted cost (§3).
4. ~~Can a match ever span two regions?~~ **Decided: no** (§4). A match belongs entirely to
   whichever instance was hosting it when it started. What is still open is not the rule but its
   enforcement: the world and its story need to make sure combat does not start standing exactly
   on a boundary in the first place, which is a level-design and narrative question, not an
   engineering one, and cannot be answered before the shared world exists to design a border
   into.
5. ~~Does a region ever get reassigned back to a merged, larger Durable Object once load
   drops?~~ **Decided: yes — and the pricing data says this matters more than "an idle object
   costs nothing" first suggested.**

   Cloudflare's own numbers ([pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/)):
   an object that is idle *and eligible to hibernate* is billed nothing for duration, even
   before the runtime actually hibernates it — so an emptied-out partition with no open
   connections at all really is free to leave sitting there. The catch is what "eligible to
   hibernate" excludes: compute duration is billed per active instance at a fixed rate as if it
   were allocated a full 128 MB, for as long as that instance holds even one connection it
   cannot hibernate — and that rate does not care whether the instance is holding one connection
   or fifty. Cloudflare's own worked examples make the shape of this concrete: 100 Durable
   Objects each holding a single always-open connection cost roughly $419/month in compute
   duration alone; 100 Durable Objects each holding fifty connections open eight hours a day
   cost roughly $143/month — *fewer total connections, spread over the same number of instances
   held open longer, cost about three times as much as more connections held open for less time
   on the same instance count.* The lesson is not "many small instances are expensive" in
   general — it is that **an instance's cost is driven by how long it stays non-hibernating,
   multiplied by how many instances exist, not by how many players are on each one.** A
   partition that splits at 80% capacity and then quietly sheds population back down to a
   handful of stragglers keeps paying the same per-instance rate a full partition would, for as
   long as anything about its connections keeps it from hibernating.

   The merge trigger this decides on is therefore the split trigger's mirror, at the same
   disconnect windows §2 already uses and dressed the same way in the fiction (a fence coming
   down, a faction losing ground) rather than an invisible technical event. One thing genuinely
   still unresolved, and it changes how much any of this matters: whether a partition's presence
   connections end up needing to stay non-hibernating at all, the way a match's referee socket
   does today because `Referee`'s state has no durable backing (§4). If a presence connection can
   tolerate the Hibernation API once a squad's position is itself durable (§4's correction), an
   underused partition may already cost nothing between messages regardless of merging, and this
   whole calculation changes. If it cannot, merging is the only lever available. Deferred to the
   world-map design, same as §4.

## 7. What this RFC rejects

- **Sharding by match, again.** RFC-0001 §7 already named "a Durable Object per match" as an
  alternative to the single instance `[ITEM-045]` built, and rejected it for the same reason it
  is rejected here in the shared-world shape: a match is not what a player spends most of their
  time inside of once there is a world to stand in between matches. A boundary is the seam that
  exists continuously; a match is not.
- **Sharding by player id.** A consistent hash over player ids balances load evenly with none of
  region-sharding's boundary-crossing complexity — and none of its locality either. Two players
  standing next to each other, fighting each other, would as likely as not land on two different
  shards, turning the one interaction regional sharding is built to keep cheap (nearby players
  talking to the same Durable Object) into the one it was meant to avoid.
- **A map pre-divided into many small zones from day one.** Considered directly, alongside the
  organic alternative this RFC chose (§2): building the shared world already cut into pieces
  small enough to be sharded from the start. Rejected in favour of starting whole and redrawing
  it over time, folded into the game's own meta-story, rather than shipping the scaling concern
  as a piece of invisible level geometry nobody in the fiction ever notices.
- **Inferring a border-wandering player's crossing intent, to move them only while
  disconnected.** The instinct is reasonable — moving a connected player is disruptive, and a
  disconnected one is free to move — but telling "wandering along one side of a border" from
  "mid-crossing when they disconnected" from position history alone is exactly the kind of
  ambiguity that produces the oscillation this RFC is trying to avoid. Replaced by making the
  crossing itself deliberate (§2): there is no intent left to infer, because the player already
  stated it by choosing to cross. (Reassignment *after a split*, §2's other use of a disconnect
  window, is a different and unambiguous case: nothing is inferred about a stationary player,
  only which instance now owns the ground they already were not moving on.)
- **Scaling the single Durable Object up rather than out.** Not a choice available to reject so
  much as one that does not exist: a Durable Object instance is one thread, and Cloudflare does
  not offer a bigger one to move to.
