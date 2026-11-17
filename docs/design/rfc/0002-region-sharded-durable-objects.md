---
title: "RFC 0002: Region-Sharded Durable Objects"
id: "RFC-0002"
type: "rfc"
status: "accepted"
lastReviewed: "2026-11-16"
appliesTo:
  - "workers/**"
  - "src/server/Persistence.ts"
  - "src/server/AccountStore.ts"
  - "src/server/RegionStore.ts"
  - "src/server/AccountsRpc.ts"
  - "src/server/MatchServer.ts"
  - "src/server/Owner.ts"
  - "src/server/Handover.ts"
  - "src/server/Crossings.ts"
relatedDocs:
  - "docs/design/rfc/0001-referee-and-transports.md"
  - "docs/design/gdd/overview.md"
  - "docs/architecture/deployment.md"
  - "docs/backlog/active-backlog.md"
tags: ["network", "cloudflare", "durable-objects", "scaling", "rfc"]
---

# RFC 0002: Region-Sharded Durable Objects

**Status: design accepted; the handover protocol is implemented and verified; production sharding is
gated.** `[ITEM-045]` runs one Durable Object for the whole deployment today, deliberately — see
[ARCH-DEPLOYMENT §2.1](../../architecture/deployment.md#21-one-durable-object-not-one-per-match).
What is built (`tictac-dwq` and its children, all closed): the 2PC coordinator and its client half
(`src/server/Handover.ts`, `src/game/ServerConnection.ts`), the ownership directory (`src/server/Owner.ts`,
§4–§5), the per-region store split with the directory's accounts behind `AccountsPort` (§4,
`tictac-dwq.5`), a signed-in player's home region (`tictac-dwq.6`), the one host factory both hosts call
(`src/server/MatchServer.ts`), and the hand-off itself end to end — the order, the offer, the DO-to-DO
calls, the commit, the retries, the resolution of an in-doubt crossing and the persisted crossing intent
(`src/server/Crossings.ts`, `tictac-dwq.2`, `.4`, `.7`, `.8`). What is not: the shared world that makes a
second region worth having (§1). Sharding stays off in production until that world exists (the deployment
has one region, `REGIONS` in `src/server/Owner.ts`); the protocol is exercised by tests against two
servers, not by a second Durable Object in production. The shape of the replacement changes what "a match
server" is allowed to assume, which is why §5 constrains the single instance now.

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
than a fixed name (`workers/index.ts` once addressed only `'singleton'`; it now asks the partition table, which still holds one region). A connection routes to
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

*Squad travel* (GDD-WORLD §3) moves in straight lines on the wall clock. The two are reconciled in
[GDD-WORLD §5.4](../gdd/world-and-travel.md) (point 8, `ITEM-066`): inside a zone routes stay
straight; a route that would cross a border is cut at the crossing, where the squad stops, and
going through is an order of its own — the hand-off this section describes.

**The hand-off is a Two-Phase Commit (2PC) over dual client sockets.** The source Durable Object
must not purge the client's session, presence, or held entities until arrival at the target Durable
Object is confirmed. For the duration of the transition, the client keeps two active WebSocket connections:
0. The crossing begins with an order of its own, `crossBorder { to, destinationRegion }`, which walks the squad to
   the border checkpoint; its arrival there starts the hand-off (schedule kind `handover`).
1. Source DO initiates a reservation on Target DO (`prepareHandover`, over DO RPC: `env.MATCH.get(idFromName(region))`)
   carrying the squad's rows (`RegionStore.exportSquad`), which the target writes as a copy it does not keep
   (`importSquad`, owner still the source), and pushes `tictac/api/region/handoverOffer`
   (handover id, the squad's id, target url, single-use ticket, expiry) to the client.
2. Client opens a second socket to Target DO without closing its primary socket, says hello, signs in with its
   token, and calls `tictac/api/region/arrive` on it.
3. Target DO verifies the ticket for the signed-in player, commits itself as keeper (`squads.setOwner`) and
   calls `confirmArrival` on the source. `region/arrive` answers only after that, with the target's own region.
4. Source DO receives arrival confirmation, commits the new keeper, deletes the squad's rows, and ends the primary session with
   `session/ended` `{ reconnect: 'elsewhere', url }`. There is no separate completion push: that is the one word
   the client moves on. It makes the second socket its only one *inside the same `ServerConnection`* —
   lobby subscription and room asked for again on it, squad and encounter listeners untouched — and never
   redials the source.
5. If Target DO is unreachable, refuses or times out, client sends `region/cancelHandover` on the primary,
   closes the second socket, and stays on the source, which retains authority. The offer also lapses on the
   clock on both sides (`expiresAt`), so a window that never comes, or a source that never says, leaves
   nothing behind: the target drops its copy, the source schedules the next attempt at `HANDOVER_RETRY_DELAYS_MS`
   (2 s, 5 s, 10 s, 30 s) and, after `HANDOVER_MAX_ATTEMPTS` (5) failures, rests the squad at the checkpoint
   and tells the player (`squad/changed` and a `region/handoverFailed` push with the reason).

On Cloudflare the offer's `targetUrl` is the address the window reached the source through, asking the
Worker for the target (`?region=<durableObjectName>`, honoured only for a region the partition table routes to,
`workers/index.ts`); the window keeps it as its address after it moves, so a reconnect lands on the target.

**Decided (`tictac-dwq.2`): a seated player does not cross.** A match never spans two Durable Objects (§6.4), so
a window's seat in a live room cannot go with it. Rather than let the target refuse `room/enter` afterwards, a
squad whose player holds a seat in a room that is not over starts no crossing: it waits at the checkpoint and
looks again every 30 s on the schedule, using up no attempt, until the room is over (a seat still held for its
grace counts). A player with no window open waits the same way, since an offer is for a window to take. And the
two-phase commit enforces it at the other end: if the player sits down between the offer and the arrival, the
source refuses `confirmArrival`, and the target undoes its commit and refuses `region/arrive` (`conflict`). While
an offer is out the squad takes no order (`conflict`), so the rows the target holds cannot go stale.

**What is in doubt, and how it is resolved (`tictac-dwq.7`, `tictac-dwq.8`).** Both regions write down what they
hold of a handover (`HandoverStore`, the `handovers` table, keyed by handover id and told apart by `role`), and a
crossing's *intent* (the order, its attempts, the moment of the next) is a row of its own (`crossings`), so a
restart on either side resumes (`Crossings.restore`, before the squads' own schedule): a crossing goes back on
the schedule at its moment with the attempts it had; an offer a restarted source finds is in doubt and
resolved at once. The source writes its row *before* the window is told of the offer, because from then on the
target may commit; the target writes `committed` *before* it sets the owner. A source's rows are deleted only
after it knows the target committed, which is what keeps the squad from being kept by neither.

Between the target committing and the source hearing of it (a reply lost, a source that restarted, a target
that did not answer), neither region guesses:

- **The source asks.** When an offer lapses, on restore, and on the backoff, it calls the target's
  `handoverStatus(handoverId)` (DO RPC `MatchDurableObject.handoverStatus`). `committed` → the source
  completes: commits the new keeper, deletes its rows, ends the window's session `elsewhere` if one is open.
  `dropped` → the target has dropped its copy *in answering*, so it can never commit this handover; the source
  keeps the squad and schedules the next attempt. No answer → the source stays the keeper and asks again at
  2 s, 5 s, 10 s, 30 s, 60 s, 60 s …; the squad takes no order meanwhile.
- **The target asks.** A target whose `confirmArrival` was not answered adopts the squad (it is the keeper) and
  asks the source again on the same backoff: `ok`, or `gone` (a source that holds nothing of the handover has
  completed it), settles it and the target forgets the record; a `conflict` is a definite refusal and the target
  gives the squad back.
- **A source that decides against** a handover (the window said it will not come, the player sat down in a match)
  never completes it: the reservation stays, `cancelled`, until the target has let go — dropped its copy, or given
  back a commit it had already made — and only then is the attempt over and the next scheduled.

The two never contradict, because each decision is made once and by one region: the source completes only a
reservation that is still `offered`, and decides against it only before it completes; the target answers
`dropped` only after it can no longer commit. The squad is kept by both only between the commit and the first
answer either side hears, and not after.

**A partition is redrawn at the game's own natural disconnect windows, proactively rather than
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

## 3. What had to exist, and what still does not

Two of the three prerequisites are built; the third is the reason sharding stays off:

- **The shared world itself**, as one whole partition to start: a coordinate space bigger than
  one battlefield, and something for a squad to be "present" in between matches. **Not built as
  a place** — a squad's position is a durable route on the world map (`ARCH-WORLD`), but there
  is nothing yet to fill a second region with, and the game's load does not need one. The
  *many* partitions this RFC eventually needs do not have to exist up front — see §2 — but the
  single whole-world partition, and the fiction's capacity to eventually redraw it, do.
- **A directory: region id → owning Durable Object.** Built as the first stage of the staged
  decision (§6.3): while there are few enough partitions that the mapping is comfortable to read
  in a diff, it is a literal table in the deployed code — `REGIONS` in `src/server/Owner.ts`,
  read by the Worker through `regionMap` — which costs nothing extra to maintain, because §2
  already decided every split and merge lands at a deploy, and this mapping is part of that
  same deploy. Workers KV is deferred to the point where redeploying the Worker for every
  reassignment stops being the easy option — not reached for, by default, at hobby scale.
- **A hand-off protocol between two Durable Object instances.** Built: DO RPC between
  `MatchDurableObject`s (the `peers` port, `src/server/Handover.ts`), with §4 as the shape of
  what crosses it and §2 as the protocol.

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
  sockets non-hibernating today (a `Room`'s live state has no durable backing) does not automatically
  carry over to a presence connection once position itself is durable. Whether it actually can
  hibernate depends on what else a presence connection ends up holding in memory beyond
  position, which is, again, the world-map design's to answer — but it bears directly on §6.5's
  economics.

**Where the data lives: per region, owner-routed (decided 2026-11-16, `tictac-dwq.1`).** An
earlier draft said everything `Persistence` holds stays one logical store reachable by every
region. That is not what the code can do, and not what is chosen: each Durable Object opens its
own SQLite (`ctx.storage.sql`, `workers/MatchDurableObject.ts`), so a second region would start
with no accounts, and a shared store (D1, or a hub Durable Object every region calls on every
read) would put a network hop under every roster and squad read. Instead:

- **Each region Durable Object owns the squads standing in it and everything about them** —
  their rosters, encounters, the matches played in it and its live rooms — in its own
  `ctx.storage.sql`. A read of "my roster" goes to the region that keeps the squad, which is the
  one the player's socket is connected to.
- **Accounts live in one directory Durable Object**: players, passkeys, sessions and sign-in
  challenges. They are small, read at sign-in rather than per frame, and need one global answer
  (a name, a credential) that no region may disagree about.
- **Handover moves the squad's rows inside the 2PC.** The target writes the squad, its roster
  members and its open encounter state on prepare/arrive; the source deletes them only after
  confirm, and commits the new keeper (`squads.owner`) at the same moment. Until confirm the
  source stays authoritative and the target's copy is not live, which is what lets cancel and
  retry (§2) leave no trace on either side.
- **Cross-region reads go through the owning Durable Object, found via the directory:** the
  return feed of a player whose squad moved, the recording of a match played in another region,
  a player lookup by id or name. Nothing reads another region's tables directly.

**The port split.** `Persistence` (`src/server/Persistence.ts`) was one bag of stores over one
`Db`. It splits along the line above into two ports, each over its own `Db`:

- **`AccountStore`**, owned by the directory Durable Object: `Accounts` over `players`,
  `credentials`, `sessions` and `auth_challenges`. Asks: register, sign in, resolve a token to a
  player, resolve a player id to a name, which region keeps a player's squad.
- **`RegionStore`**, owned by each region Durable Object: `Squads` (`squads`), `Rosters`
  (`roster`, `match_results`), `Encounters` (`encounters`), `MatchStore` (`matches`, `events`) and
  `RoomStore` (`rooms`). Asks: everything a region does about its own squads and fights, plus the
  three handover verbs (write a squad's rows, delete them, commit the keeper).

Three consequences the split has to handle, found by reading the migrations:

- **Foreign keys to `players(id)` cannot cross a database.** `squads.player_id`, `roster.player_id`,
  `match_results.blue_player`/`red_player` and `encounters.player_id` become plain ids in the
  region schema; a player's name is asked of the directory (`Journeys` resolves a squad's player,
  and `Encounters` names an opponent, through `AccountsPort.player`).
- **A player's row is not a squad's.** The unique index `squads_player` and the roster's active-slot
  index are per region, so the directory, not either region, is what says a player has one squad
  anywhere.
- **A match belongs to the region that hosted it (§6.4), but its two players may be keepers in
  different regions.** Settling writes each player's growth to the roster rows of the region
  that keeps them, through that region's own port.

**Home region (`tictac-dwq.6`).** One squad per player across every region: `players.home_region`
(`accountMigrations.ts`, existing players = `singleton`) is the region that keeps the player's squad.
Registration sets it to the serving region (where the connection was first routed by its place);
the handover's commit moves it (`AccountsPort.moveHome`, called by `Crossings.arrive` right after
the target commits `squads.owner`, so the two are never left disagreeing by a recovery). A region
only deals a roster and squad (`RegionStore.enlist`) to a player it is the home of; a sign-in,
registration or login at any other region is answered with `session/ended { reconnect:
'elsewhere', url }` (`RegionPeers.urlOf`: the configured address on Bun, the same host with
`?region=<name>` on Cloudflare), holding no rows for them. The window of a handover is the one
exception: it signs in at the target before it arrives, and `Crossings.expects` says so. Place
routing stays for anonymous sockets and first registration only.

**Built (`tictac-dwq.5`).** The split is in the code: `AccountStore` and `RegionStore`
(`src/server/AccountStore.ts`, `src/server/RegionStore.ts`) over two `Db`s, with no foreign key or
join from a region table to `players` — a region's schema is `src/server/db/regionMigrations.ts`,
the directory's `accountMigrations.ts`, their ledgers kept apart (`store_migrations`) so the
singleton can keep both in the one database it has always had (existing data is adopted, not
migrated by hand: ARCH-PERSISTENCE §2.1). Registration is two steps (`Accounts.register`, then
`RegionStore.enlist` in the serving region). A region reaches the directory through `AccountsPort`,
in process (`Accounts`) or over DO RPC (`AccountsRpc.ts`, served by the singleton's
`MatchDurableObject.accounts`). The handover verbs are `RegionStore.exportSquad` / `importSquad` /
`deleteSquad` and `squads.setOwner` (the commit of the keeper, which `HandoverCoordinator.confirm` now
claims before awaiting, so a cancel cannot slip between the write and the bookkeeping).
`roster.died_in` is no longer a key to `matches` either: a roster travels, the matches it fought stay.
`Crossings` (`tictac-dwq.2`) calls the verbs; `tests/regions.test.ts` exercises them and a second
region serving a player whose account is only the directory's, `tests/crossings.test.ts` the hand-off
between two servers on a hand-turned clock, and `tests/handover.test.ts` a real client crossing between
two Bun servers.

**What transfers at a hand-off, beyond the durable position, is the rest of a squad's live
session:** the open socket's transport, which faction/side (if any) it is attached to, heading,
and whatever the region simulation was holding about it in memory beyond position itself.
**Decided:** the Durable Object currently holding the connection is responsible for the
hand-off — it initiates it the moment a deliberate crossing happens, rather than a directory or
the destination instance reaching in to pull the connection over. The source instance closes out
cleanly (the same shape as a match ending unwatched, RFC-0001 §8.6); the destination instance
opens a session the way `MatchDurableObject.fetch` opens one today, reading whatever durable
state it needs — including the squad's own position — from the rows the handover moved into its
own store (below), not from the instance it is succeeding.

**Decided: a match never spans two Durable Objects (§6.4).** A match belongs entirely to
whichever region's instance was hosting it when it started, the same way it belongs to one
`Room` today. What prevents two players from starting a fight exactly on a boundary is left
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

1. **Who owns what is a lookup, not a constant.** `RegionDirectory` (`src/server/Owner.ts`) is
   built by each host from its config and handed to `Journeys` and `Crossings` (which gives it to
   its `HandoverCoordinator`); the Worker routes through the same partition table
   (`regionMap(REGIONS)`). Where a *place* goes is a function of the table; who keeps a *squad* is
   a durable fact (`squads.owner`, written when a handover commits), never recomputed from where
   the squad stands. `env.MATCH.idFromName` is called with a name that lookup returns, and
   anything that starts depending on there being exactly one Durable Object instead of asking it
   is debt against this RFC.
2. **A match today is not "in" a region**, and does not need to become one before combat ships —
   `[ITEM-045]`'s single referee is correct for a game with no persistent world to place a match
   in. This RFC only starts mattering once §3's shared world exists.

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
3. ~~Directory consistency~~ **Decided, staged: baked into the deployed Worker while the Durable
   Object count is low; Workers KV once it is not.** A Durable Object with the SQLite storage
   backend — the one `[ITEM-045]` already uses — has its own free daily allowance (100,000
   requests, 13,000 GB-s compute duration), so neither stage of this changes anything about
   whether the Durable Objects themselves stay free-tier-eligible. What changes between the
   stages is the directory: redeploying the Worker to update a baked-in table costs nothing
   beyond the deploy §2 already needs for every split and merge, and sidesteps a second store's
   consistency question entirely for as long as the table is small enough to hand-maintain. The
   point to switch is reached *by DO count, not by a calendar date*: once there are enough
   partitions that redeploying for every reassignment is the inconvenient option rather than the
   free one, Workers KV takes over, accepting its eventual-consistency window — a brief
   disagreement between two Workers about who owns a freshly-split partition — rather than paying
   a directory Durable Object's extra hop on every routing decision forever. Worth keeping in
   mind for that later stage and not before: Workers KV's own free tier caps writes at 1,000/day
   (reads at 100,000/day), which a cadence of occasional, deliberate splits and merges stays
   nowhere near, but would be the first free-tier wall hit if reassignments ever became frequent.
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
   does today because a `Room`'s state has no durable backing (§4). If a presence connection can
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
