---
title: "GDD: The World Map, Travel and Encounters on the Road"
id: "GDD-WORLD"
type: "gdd"
status: "active"
lastReviewed: "2026-10-08"
appliesTo:
  - "src/core/Travel.ts"
  - "src/game/**"
  - "src/server/**"
  - "workers/**"
relatedDocs:
  - "docs/design/gdd/overview.md"
  - "docs/design/gdd/combat-mechanics.md"
  - "docs/design/rfc/0002-region-sharded-durable-objects.md"
  - "docs/backlog/active-backlog.md"
tags: ["world", "map", "travel", "encounters", "design"]
---

# GDD: The World Map, Travel and Encounters on the Road

**Status: designed; partly built** (M5: `ITEM-060`–`ITEM-065`, of which the map tiles, the
travel maths, the squads table with its starts, and orders with the travel schedule exist
([ARCH-WORLD](../../architecture/world.md)); then `ITEM-048`, `ITEM-053`). This
is where a squad is between fights. Combat ([Combat Mechanics](combat-mechanics.md)) is what
happens once two squads meet. The overview's shared world ([Overview](overview.md) §3, §4)
assumes this layer exists; this document says what it is.

**Prior art.** `../no-way-home`, the project this one grew out of, built a working version of
the map and travel half: a real-Earth basemap, waypoint travel driven by Durable Object alarms,
and path-based fog of war. Its design document never specified the map (its own §9 lists
"World Map design" as a TODO). What it shipped is a set of implementation decisions, and the
ones adopted here are named as such. Its tile archive, `map-tiles/world.pmtiles`, is already in
this account's R2, but it covers Stuttgart only (lon 8.9–9.5, lat 48.55–49.0), not the world.

## 1. The map is the real Earth

The world is laid over the real one ([Overview](overview.md) §3): a player in Lyon starts
around Lyon. The map is an OpenStreetMap-derived vector basemap (Protomaps), stored as PMTiles
in R2 and served by the match server one tile at a time, as static content at
`/tiles/{z}/{x}/{y}.mvt`. A position is latitude and longitude. There is no grid, no
projection and no region system at this layer; distance is great-circle distance.

**The whole planet, coarse first.** The full planet is 138.7 GB at z0–15. The match server
hosts the whole planet only at the most zoomed-out levels: z0–8, 558 MB (`ITEM-061`; z0–10
would have been 3.8 GB). Closer zooms, to z14, are built tile by tile the first time someone
looks there and kept (`ITEM-067`, [ARCH-DEPLOYMENT §6.4](../../architecture/deployment.md)).

## 2. A squad has a position

**Position belongs to the squad**, the same durable thing its people are
([RFC-0002](../rfc/0002-region-sharded-durable-objects.md) §4). It is not stored as a point.
It is a list of waypoints:

- **Past waypoints** are where the squad has been: where, when it arrived, and, if it left,
  when, on which trip and at which gait (mode and pace) it took the leg that followed.
- **Future waypoints** are where it has been told to go: just a place.

Where the squad is *now* is computed from that list and the clock, never stored: time since
it left its last waypoint times its speed, along the leg it is on. Server and client compute
it with the same function, so a refresh mid-journey resumes where the squad actually is, and
the client can draw it moving without asking the server anything. They agree to within the last
bits of a float (JavaScript trigonometry is not correctly rounded, so two engines may differ
there); whatever must agree exactly is the server's figure written into the list, such as an
arrival time once recorded. Along a leg the squad's latitude and longitude are interpolated
linearly, not along the great circle: indistinguishable at the distances a squad covers on
foot, and stated so nobody relies on it being a true geodesic. A leg across the antimeridian
goes the short way round.

**Where it is stored.** A squad is a row of its own, in a `squads` table holding its waypoint
list — one row per player for now — not a column on the player. Captives (`ITEM-054`), alien
squads and a player with several squads can then have positions without reshaping players.

**There is one movement mechanism.** A walk across a town and a drive across a country are both
a list of waypoints.

## 3. Travel takes real time

Travel runs on the wall clock, not on a game tick: a long trip takes real hours, and it carries
on while the player is away. That is part of the appeal, not a cost of it. Three reasons:

1. **It costs nothing while nothing happens.** The server sets an alarm for the next thing
   that will happen (an arrival, a checkpoint) and sleeps. A ticking world would keep its server
   awake to advance a clock, which on Cloudflare is billed for every second it is awake
   ([RFC-0002](../rfc/0002-region-sharded-durable-objects.md) §6.5).
2. **Nothing about it is random.** Moving along a straight line at a known speed is arithmetic.
   Quantising time into ticks would make it coarser, not more correct.
3. **It plans ahead.** The whole route is known the moment it is set, so the server knows in
   advance every moment that matters: each arrival, and (once the world is split into zones)
   each zone boundary crossed.

Alarms are set no more than an hour apart, so a multi-day trip is re-checked hourly rather than
resting on one far-future alarm. An arrival is recorded at the time it *should* have happened,
not the time the alarm fired, so lateness never accumulates over a long trip.

**Speed** comes from how the squad travels: on foot, or in a vehicle once vehicles exist
([Economy & Bases](economy-and-bases.md)). The pace is the player's choice: cautious (slow,
fewer encounters), normal, or flat out (fast, more encounters, more fuel once fuel exists).
On foot the three paces are **3 km/h, 5 km/h and 7 km/h**. Every leg states its own speed from
how the squad travels and its pace; there is no default speed.

**Orders on the map** are four verbs, given by pointing at a place:

| Verb | When | Effect |
| --- | --- | --- |
| Go here | at rest | set off |
| Go here now | travelling | abandon the route and head here from where the squad is |
| Go here first | travelling | detour here, then carry on |
| Go here next | travelling | add a stop at the end of the route |

Stopping where the squad is is the fifth.

**Trips and checkpoints.** Setting off from rest and "go here now" start a *trip*, with an id
the server mints; arriving somewhere on the way and "go here first" carry it on. A trip's
*checkpoints* are every whole hour since it set off and the moment it ended, keyed by trip and
index. The end counts even when it comes early (a stop, a turn elsewhere): otherwise stopping
every 59 minutes would never be weighed for an encounter (§5.1). A checkpoint that has passed
depends only on waypoints that have passed, so no later order renumbers it.

The maths is `src/core/Travel.ts` (`ITEM-062`): pure, no clock of its own (every moment is an
argument), and every order returns a new list.

## 4. Where a player starts

On registration a player's squad is placed at a random point within **50 km** of the
latitude and longitude Cloudflare reports for the connection ([Overview](overview.md) §3).
The point is drawn uniformly over the disc (radius `R·√u`), from system randomness rather than
any match's dice, and redrawn if it lands within **1 km** of another player's start. Only the
drawn point is stored; the reported one is kept nowhere. A connection with no reported
location — and every registration on the Bun server, which is not behind Cloudflare — falls
back to the default anchor, **Stuttgart centre (48.7775, 9.18)**. If 100 draws in a row land
too close to others, the last is taken and the server logs it rather than refusing the
player. A player who registered before squads existed is placed the same way the first time
their squad is asked for. (`ITEM-063`, built: `src/server/Squads.ts`.)

**Not decided: sea starts.** A drawn point can land in the sea; the server has no land mask.
Whether to accept that or redraw against a coarse mask is decided later.

## 5. Encounters on the road

A squad on the move can run into something. That is the commonest way a fight starts.

### 5.1 What finds you

- **The aliens** ([Overview](overview.md) §2, `ITEM-048`). At each alarm checkpoint the
  server rolls whether something found the squad on the stretch just travelled, scaled by how
  dangerous the area is and how fast the squad is going. The roll is setup randomness, seeded
  from the squad, the trip and the checkpoint, so it can be audited afterwards. It is never a
  draw from a match's dice, and it is not decided in advance: no future encounter exists for a
  client to read.
  *First-cut numbers* (`ENCOUNTER` in `src/config.ts`): a **15% chance per hour** at a normal pace,
  scaled by the hours of the stretch, by pace (**cautious ×0.5**, normal ×1, **flat out ×1.5**)
  and by the area's danger, never above **90%**. No area has a danger yet, so danger is flat:
  every area is 1. A five-hour walk at a normal pace is about a 55% chance of at least one
  fight. These are tuning, to be changed after play.
- **Other players** (`ITEM-053`). Every leg is a straight line at a steady speed, so the
  server can work out exactly when two squads' routes come within reach of each other. It
  checks a new route against every other squad in the zone when it is set, schedules the
  meeting, and checks again when the moment comes, since either route may have changed by
  then.

Contact stops the squad — when there is a fight. A squad whose player is already in a match, or
with nobody fit to fight, is passed by: it carries on, and the feed says so. The fight is an ordinary match: the same rules, the same referee, the
same log, the same settlement.

### 5.2 Who plays a fight nobody is watching

The server can seat the game's AI in any chair nobody is in:

| Present when contact happens | The fight |
| --- | --- |
| The player (and the other player, if any) | Played live. |
| One player; the other side absent | Live for the one who is there; the AI plays the absent squad. |
| Nobody | Fought out by the AI on both sides, at once, on the server. |

**A join window.** A player who is online when contact happens is told, and has a short window
to take the fight before the AI plays it for them.

An AI-played fight is a real fight. It is recorded and settles the roster exactly as a played
one does: wounds, deaths, carried-out, **and growth**. Being away can make a squad better as
well as worse. On return the player finds a feed of what happened while they were gone, and
every fight in it can be watched back.

**After a fight** the squad either carries on along its route or stops and waits. That is a
player setting.

### 5.3 Fighting players who are away

Squads whose players are offline can be found and fought by other players. **This is on trial**:
it ships, its effect on players is watched, and it can be switched off. Its risk is obvious: a
sleeping squad is a target. What stands between a squad and that risk:

1. **How it travels.** A cautious pace meets less.
2. **What it does when it meets something.** The AI fights for an absent player according to a
   standing order the player set beforehand: fight, fight but get out after the first wound or
   death, size the enemy up and decide, or avoid fighting and get out at once. Getting out is
   retreat ([Combat Mechanics](combat-mechanics.md) §2.8), and a squad that gets away has lost
   only time.
3. **Where it is.** Once the world has zones
   ([RFC-0002](../rfc/0002-region-sharded-durable-objects.md)), the fiction can make some of
   them places where an absent squad cannot be engaged at all.
4. **How good the AI is.** The AI was written to measure balance, not to fight on a player's
   behalf. Once it does, its weaknesses cost real characters, so improving it stops being
   optional.

### 5.4 What an encounter changes in rooms and rosters (`ITEM-066`)

Every room so far is opened by a human, joined by a human, and held by humans' sockets
(`ITEM-058`, `ITEM-059`). An encounter is started by the server, and often nobody is there.
These are the decisions `ITEM-048` builds on, each naming the code it changes.

1. **An encounter is the player's one match.** While their squad is in one, `Lobby.seatOf`
   finds that seat and every open, join or watch puts them back in it (`redirected`), as for
   any match: the squad is busy. The lobby panel's takeover (`ServerPanel`'s `resume` when
   `you.phase` is `playing`) is how a player *takes the fight* inside the join window, so the
   lobby's `you` gains who controls the seat (`human`, `ai`). Once the AI holds it, the panel
   does not take it over: it offers to watch. There is no taking a fight back from the AI
   mid-match; the join window is the only hand-over. Encounter rooms are not listed in the
   lobby for others to join or watch.
2. **The join window is not the seat grace.** A seat the server reserved for a player who has
   not arrived is a third state, beside held-by-a-socket and dropped: *reserved until* a
   deadline. An online player (a socket bound to them) is told
   (`tictac/api/encounter/started { roomId, joinBy }`) and has **60 seconds**
   (`JOIN_WINDOW_MS`, tunable); an offline player has no window at all. At the deadline the
   seat passes to the AI. In a room that has an AI to fall back on, `Room.hold`'s expiry does
   the same instead of ending the room with `departure()`: an encounter never aborts because a
   human left it. `GRACE_MS` still governs how long a dropped player can come back to their own
   seat before the AI takes it.
3. **The server opens the room.** `Lobby.openEncounter` creates a `Room` directly in `playing`,
   with its seats assigned to known players or the AI, and starts it from a header the server
   composes (`Room.start`), not one a host client sends — today `start` runs only on Blue's
   `matchHeader`, and a seat the server placed in a room still `waiting` or `deploying` would be
   abandoned the moment the player's window asked for anything (`Lobby.supersede`): the seed from system randomness, the
   battlefield `generateMap(seed)`, the player's party as Blue, the rolled alien squad as Red.
   **The party** is, until a travelling party can be chosen, the first `SQUAD_SIZE` active
   members by slot who are neither in the medical bay nor deployed in another live room; with
   nobody fit, the squad is passed by and the roll says so. The header records each side's
   controller (`ITEM-048` point 4).
4. **The AI is a client of the room, not the referee.** A server-side seat is the browser's
   `AiOpponent` generalised (`AiSeat`): a `NetworkManager` and a `Policy` on one end of a
   `loopback()` transport, the `Room` holding the other end as an ordinary `Client`. It reads the
   match from the room's `log`, as a window resuming a match does, plays either side, and is
   refereed like a human. It is already headless (`src/game`, `src/sim`), and it draws its own
   randomness, never `matchDice(seed)`. A fight with nobody present is the same room with two
   AI seats; over loopback it plays out in milliseconds and records and settles through the same
   path, rather than a second, `SimMatch`-only one.
5. **Resting stays per settled match** (`Rosters.rest`). Today every active member who did not
   deploy heals after any settlement. The whole roster travels with the squad and there is no
   base, so a member who stayed out of a fight did rest through it. Not changed for the first
   encounter; once bases exist (`ITEM-047`) and members can be left behind, `rest` applies to
   those at the base and travel decides what it does to the rest.
6. **Travel never changes a character except through their roster row.** `Room.verifyRosters`
   compares the header's sheets, HP and fatigue to the roster rows byte for byte. The server
   composes an encounter's header *from* those rows, at creation, and a member deployed in a
   live room is excluded from any other party (decision 3), so no settlement can change a row
   between the header and the check. If travel ever wears characters (fatigue on the road), it
   writes the rows first, and the header is read from them.
7. **An encounter takes the server's build, and the AI is not pinned to it.** The room is
   created under `lobby.version`; a window on another build cannot take the join
   (`Lobby.fits`), so the AI plays that seat when the window lapses. A room survives a deploy as
   any room does (`RoomStore`, `ITEM-059`); its AI seats are re-attached on restore from the
   room's log and play on under the new build. Like any room restored under another build, it is
   then witnessed rather than judged (`Room`'s `witness`), so a fight a deploy interrupts is
   recorded and settled but not refereed to the end. `RoomStore` gains a controller per seat so
   a restored room knows which seats to re-attach.
8. **Straight lines inside a zone, deliberate crossings between them.** GDD-WORLD's travel goes
   in a straight line; RFC-0002 §2 makes crossing a zone boundary a deliberate act. They do not
   clash while the world is one zone, which it is. Once it has borders, the RFC wins at the
   border: a route that would cross one is cut where it meets the crossing (the gate, the
   checkpoint), the squad stops there, and going through is its own order — the hand-off
   (`ownerOf`, `src/server/Owner.ts`). Inside a zone, routes stay straight lines.

## 6. Not designed yet

- **Fog of war on the map.** The prior art's model (reveal along the route actually travelled,
  each point of it to a sight radius) is the likely starting point; nothing here depends on it.
- **Points of interest**: towns, ruins, crash sites and what is in them.
- **Roads and terrain.** A leg is a straight line; nothing slows a squad crossing a mountain.
- **Fuel** and vehicles.
- **Capture and rescue** of characters left behind (`ITEM-054`).
- **Sea starts** (§4).
