---
title: "RFC 0002: Region-Sharded Durable Objects"
id: "RFC-0002"
type: "rfc"
status: "proposed"
lastReviewed: "2026-10-01"
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

**Players move between regions; their connection moves with them.** When a player crosses a
region boundary in the shared world, their session is hollowed out of the region they are
leaving and rebuilt on the Durable Object that owns the region they are entering — a live
hand-off, not a reconnect a player has to notice. §4 sizes what "session" means here, because it
is deliberately smaller than "everything about the player."

**A region splits under load rather than being sized up front.** When a region's Durable Object
approaches capacity, a second Durable Object is started to own half of it — the region is
subdivided along the world's own geometry — and players already in the region are moved to
whichever half now owns their location, gradually, as they naturally move around or as a
background process walks the roster, rather than as one cutover that drops every connection in
the region at once. The same subdivision can recurse: a half that is itself too busy splits
again. Nothing here ever merges two regions back down; a region that empties out is simply an
idle Durable Object, which costs nothing extra to leave running.

This gives horizontal scaling with the overhead concentrated exactly where the game already has
a natural seam — a region boundary — instead of an artificial shard key (player id, connection
order) that would turn every cross-region interaction between two players into a cross-shard
one regardless of whether they are standing next to each other.

## 3. What has to exist before this can be built

None of it exists yet:

- **The shared world itself.** Regions, a coordinate space bigger than one battlefield, and
  something for a player to be "present" in between matches. Today's game has neither; a match
  is the entire unit of play and ends in a debrief screen, not a place a character keeps
  standing in.
- **A directory: region id → owning Durable Object.** `env.MATCH.idFromName('singleton')` is a
  constant today; a region's owner is not, once a region can split. Something has to answer
  "which Durable Object currently owns region R" and be updated the moment a split changes the
  answer, consistently enough that two different Workers routing two different players' requests
  agree. The candidates — a dedicated small "directory" Durable Object that every routing
  decision reads through, or Workers KV accepting its eventual-consistency window — are an open
  question (§6.1), not a decision this RFC makes.
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
`this.clients`/`this.sides` today, scoped to one region instead of one match. The source
instance closes out cleanly (the same shape as a match ending unwatched, RFC-0001 §8.6); the
destination instance opens a session the way `MatchDurableObject.fetch` opens one today, reading
whatever durable state it needs from the one shared `Persistence`, not from the instance it is
succeeding.

This is the same reason a match rejoin (`resume`/`log`, RFC-0001 §5) is a **replay from the
durable log**, not a live memory copy from one process to another: a hand-off that depends on
reconstructing state from what is already durable is robust to the source instance being gone
by the time the destination asks; a hand-off that depends on shipping live memory between two
instances is not, and does not need to be, because nothing regional is meant to be
irreplaceable the way a match's command log is.

## 5. What this means for `[ITEM-045]` now

Two things, so the single instance built there is not accidentally load-bearing for an
assumption this RFC removes:

1. **`env.MATCH.idFromName('singleton')` is a placeholder for a lookup, not a constant to build
   more routing logic on top of.** Anything that starts depending on there being exactly one
   Durable Object (rather than going through a lookup that happens to always return the same
   one today) is debt against this RFC.
2. **A match today is not "in" a region**, and does not need to become one before combat ships —
   `[ITEM-045]`'s single referee is correct for a game with no persistent world to place a match
   in. This RFC only starts mattering once §3's prerequisites exist.

## 6. Open questions

1. **How is "at capacity" measured, and who decides a region splits?** Concurrent sockets is the
   cheapest signal and the one closest to what actually costs a Durable Object, but a region
   whose players are all fighting in one spot may need to split on CPU rather than headcount.
   Unresolved.
2. **What stops a player oscillating near a boundary from being handed off repeatedly?** A
   region border needs hysteresis — a margin a player has to cross past, not touch, before a
   hand-off starts — or a busy border becomes a stream of hand-offs instead of an occasional
   one. Unresolved; the margin's width is a balance question as much as an engineering one.
3. **Directory consistency**, named in §3: a dedicated directory Durable Object serializes every
   routing lookup through one more hop; Workers KV removes the hop but accepts a window where
   two Workers can disagree about who owns a region mid-split. Which is worse depends on how
   often a split actually happens, which is unknown until there is a player base large enough to
   need one.
4. **Can a match ever span two regions?** If two players fight where their characters happen to
   stand and that spot is near a border, does the match belong to one region's Durable Object
   (and which one), or does combat need its own placement independent of the world region a
   player is standing in? Unresolved, and not answerable before combat and the shared world
   exist in the same build.
5. **Does a region ever get reassigned back to a merged, larger Durable Object once load drops?**
   §2 states it does not, for simplicity; whether an idle half-region Durable Object is cheap
   enough to leave running forever is a real cost question once Cloudflare's pricing is being
   paid for real rather than dry-run.

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
- **Scaling the single Durable Object up rather than out.** Not a choice available to reject so
  much as one that does not exist: a Durable Object instance is one thread, and Cloudflare does
  not offer a bigger one to move to.
