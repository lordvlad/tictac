---
title: "The World Map: Squads, Orders and the Travel Schedule"
id: "ARCH-WORLD"
type: "architecture"
status: "active"
lastReviewed: "2026-10-08"
appliesTo:
  - "src/core/Travel.ts"
  - "src/core/Encounters.ts"
  - "src/server/Encounters.ts"
  - "src/server/Squads.ts"
  - "src/server/Journeys.ts"
  - "src/server/Schedule.ts"
  - "src/server/Owner.ts"
  - "src/server/GameServer.ts"
  - "workers/MatchDurableObject.ts"
  - "workers/index.ts"
  - "src/hud/MapScreen.tsx"
relatedDocs:
  - "docs/design/gdd/world-and-travel.md"
  - "docs/design/rfc/0002-region-sharded-durable-objects.md"
  - "docs/architecture/persistence.md"
  - "docs/architecture/networking.md"
  - "docs/architecture/deployment.md"
tags: ["world", "map", "travel", "squads", "scheduler", "alarms"]
---

# The World Map: Squads, Orders and the Travel Schedule

How the match server keeps squads somewhere on the planet and moves them on the wall clock. The
design is [GDD-WORLD](../design/gdd/world-and-travel.md); this is how it is built. Matches are
untouched by all of it: travel orders are requests on the session socket, outside any room, and
nothing here draws from a match's dice.

## 1. The pieces

| Piece | What it does |
|---|---|
| `src/core/Travel.ts` | The maths, shared by server and client: a route's position at a moment (`positionAt`), its arrival times (`plannedArrivals`), arrivals recorded when due (`settle`), the five orders, and a trip's checkpoints. Pure: no clock of its own, no mutation. |
| `src/core/Encounters.ts` | Whether the road finds a squad: the chance of a stretch, the roll (a pure function of its key), the aliens a contact deals (§3a). |
| `src/server/Encounters.ts` | The `encounters` table: one row per contact, and the return feed ([ARCH-PERSISTENCE §5b](persistence.md)). |
| `src/server/Squads.ts` | The `squads` table: where each squad starts and its route ([ARCH-PERSISTENCE §5a](persistence.md)). |
| `src/server/Journeys.ts` | Orders in, arrivals out: checks an order against the maths, writes the route, schedules the next arrival, pushes the change. |
| `src/server/Schedule.ts` | Every moment the server must wake for, behind the host's one alarm. |
| `src/server/Owner.ts` | `ownerOf(squad)` and `MATCH_SERVER`: which match server owns what (§4). |

## 2. Orders

A window sends `tictac/api/squad/order { order }` ([ARCH-NETWORKING §8](networking.md)) with
one of the five verbs, as a `SquadOrder` (`src/game/Rpc.ts`):

| `kind` | GDD verb | Fits | Route afterwards |
|---|---|---|---|
| `goHere { to, pace }` | go here | at rest | departs now, on a new trip, at `pace` |
| `goHereNow { to, pace }` | go here now | travelling | turns where it is, on a new trip, at `pace` |
| `goHereFirst { to }` | go here first | travelling | detours where it is, then carries on: same trip, same pace |
| `goHereNext { to }` | go here next | travelling | `to` is added at the end |
| `stop` | stop | travelling | rests where it is |

`Session.ts` checks the shape (a known verb, a point within ±90/±180, a pace of `cautious`,
`normal` or `flatOut`) and refuses anything else `invalidParams`. `Journeys` checks the fit and
refuses a verb that does not fit `conflict`. Every squad walks for now (`mode: 'foot'`; 3, 5 and
7 km/h): what carries a squad is the server's to say, not the order's. Trip ids are minted here
(`crypto.randomUUID`). The answer is the new route, and the same route is pushed to the
player's window as `squad/changed`.

## 3. The schedule

Between orders nothing runs: a squad's position is arithmetic on its route, which every window
does for itself. The server only has to wake when something becomes true, which today is a
squad reaching its next waypoint.

`Schedule` keeps the next due moment for each `(kind, entity)` and arms the host's alarm for the
earliest of them all, never more than `MAX_SLEEP_MS` (an hour) ahead. When the alarm goes off,
`fire` runs every moment due by then, earliest first, each with the moment it *was* due; a handler
may set the entity's next moment, and the alarm is armed for what remains. Nothing is due, so
nothing is armed, while every squad rests. `ITEM-048`'s checkpoint rolls and `ITEM-053`'s planned
meetings are further kinds with handlers of their own, not a second mechanism.

`Journeys` owns two kinds. `arrival`: its handler reads the squad, records the arrival due at `at`
(`settle(waypoints, at)`, not "by now"), writes the route if it changed, pushes it, and schedules
the next. A late alarm therefore never lengthens a trip, and the stored route always has the
checkpoints the maths says it has. `checkpoint`: one per travelling squad, set to the next
checkpoint of its current trip nobody has weighed (`checkpoints()`); cleared at rest. It exists only
where the host gave `Journeys` an `openEncounter`; without one nothing is rolled.

**Time order.** `Schedule.fire` looks for the earliest due moment again after every handler, so a
moment a handler sets runs in its place among the others already due. And because a checkpoint must
see the route as it was then, every writer of the route weighs the checkpoints due first: `arrive`
weighs everything due up to its own `at` before it settles to `at`, and an order weighs everything
due by now before it changes the route. A stopped or turned trip ends early, and its last stretch
(the end checkpoint at the moment of the order) is weighed too. A route whose last departure is
later than a checkpoint is never weighed for it: that was done before the departure was written.

Orders, arrivals and the restart all go through one queue in `Journeys`, so an alarm and a
request never read the same route and both write it. A Durable Object already runs one event at a
time; the Bun server needs the queue.

**Restart.** `Journeys.restore()` schedules every travelling squad's next arrival and checkpoint from `squads`,
beside `lobby.restore()`, before the host lets anyone in. An arrival that fell due while no
server was running is due at once, and recorded at the time it should have happened. So is a
checkpoint. Which checkpoints a squad has had weighed is kept in memory only, so after a restart
the trip's checkpoints after its last departure are weighed again; that is safe (§3a).

### 3a. The roll

At a checkpoint the handler weighs the stretch just travelled (`src/core/Encounters.ts`):
`hours` since the previous checkpoint (or the departure), the trip's `pace`, and `danger`
(`ENCOUNTER.dangerEverywhere` until areas have one). The chance is
`ENCOUNTER.perHour × hours × ENCOUNTER.pace[pace] × danger`, clamped to `ENCOUNTER.ceiling`.
First-cut numbers: 15% an hour, ×0.5 cautious, ×1.5 flat out, never above 90%
([GDD-WORLD §5.1](../design/gdd/world-and-travel.md)).

**Reproducible.** The roll is `rollEncounter({ squad, trip, index }, stretch)`, drawn from
`new Rng(hashSeed("squad|trip|index"))`: the same key and stretch always answer the same, and
another checkpoint of the same trip is independent. It draws whether it met, the aliens' seed and
the size offset (-1, 0 or 1) in that order whether or not it met, so tuning the odds never changes
who comes. It is setup randomness: never `matchDice`, never `Math.random`, never the clock. A
contact's `alienSeed` feeds `dealAliens(seed, size)` (sheets from `rollSquadSheets`, the stock
loadout); nothing about the aliens is stored.

**Handled once.** A roll that finds nothing leaves no trace. A contact calls
`options.openEncounter(contact)` and then writes an `encounters` row, unique on
`(squad, trip, checkpoint)`. A checkpoint weighed again after a restart re-rolls the same answer,
finds the row, and does not open a second fight; if the row says a fight opened and the squad is
still moving (the server went down between the row and the save), it only makes the halt. The one
window left is a crash between the room opening and the row being written, which opens two rooms.

**What a contact does to the squad.** A fight opened halts it where it stood at the checkpoint
(`stop(settle(route, at), at)`, pushed as `squad/changed`) and schedules nothing for it: its trip
is over, and a new trip has new checkpoints. A squad passed by (`busy`: already in a match;
`nobodyFit`) carries on, unhalted, and the feed says so. A contact at the very end of a trip finds
the squad already at rest and halts nothing. A failure to open a contact is logged and does not
stop the schedule; the checkpoint stays unweighed and the next arrival or order weighs it again.

### 3b. The fight

A contact is a room the server opens itself: `Lobby.openEncounter(contact)`, the other end of
`options.openEncounter` (`src/server/EncounterPort.ts`). It is the one place a roll meets a
roster, and it decides in this order ([ARCH-NETWORKING §8](networking.md) has the room):

1. **Busy.** A player who already holds a seat in a live room is passed by (`busy`) — an
   encounter is their one match, like any. It waits for everything a room has decided to be
   written first, so a match they just finished has settled onto the roster before a party is read
   from it.
2. **Nobody fit.** The party is the first `SQUAD_SIZE` active members by slot who are not in the
   medical bay (`downtime = 0`). Nobody deployed in another live room is picked either, and
   that needs no check of its own: a member is only ever deployed in their player's one seat. With
   nobody, the squad is passed by (`nobodyFit`).
3. **The header.** Blue is the party, composed *from the roster rows* — the sheets, hit points and
   fatigue are the rows', so `Room.verifyRosters` passes it byte for byte, and nothing can change a
   row before it does (no live room holds these members). Red is `dealAliens(alienSeed, size)`,
   `size = clamp(party + sizeOffset, 1, SQUAD_SIZE)`, which is never written to `roster` and has no
   `characterId`. The map seed is system randomness (`crypto`), not the aliens' seed. The header
   states `controllers: { Blue: human, Red: ai }`: whose each side *is*, which never changes, whoever
   is moving it.

**Who plays.** Red is an AI seat from the start. Blue is the player's, and who moves it depends on
whether a window is bound to them when the contact happens:

| The player is | Blue is | And then |
|---|---|---|
| online | *reserved* until `now + ENCOUNTER.joinWindowMs`; `encounter/started` is pushed | they take it with `room/enter { kind: 'resume', roomId }`, or at the deadline the AI does |
| offline | the AI's at once, no window | the fight plays out in the same turn of the event loop and settles |

Taking it cancels the deadline and fires `onEncounterTaken` (the feed's *played by you*). A seat
they took and then lost (the socket dropped and the grace ran out) goes to the AI rather than ending
the room. Whoever played, the human side settles through `Rosters.settle` like any match —
wounds, deaths, carried-out, and growth — and the aliens' side, which has no roster, is skipped as an
anonymous side is.

### Hosts

| Host | Clock | Alarm |
|---|---|---|
| `workers/MatchDurableObject.ts` | `Date.now()` | `ctx.storage.setAlarm` / `deleteAlarm`; `alarm()` calls `schedule.fire()`. The alarm is kept in storage, so it wakes an evicted instance, which restores and fires. |
| `src/server/GameServer.ts` | `ServerClock` option, the wall clock by default | a timer through `ServerClock.schedule`, replaced on every arm and cancelled on `stop` |
| tests (`tests/support/rpcServer.ts`) | a number the test sets | `armed` records each moment asked for; `wake()` is the alarm, on time or late |

## 4. Who owns a squad

RFC-0002 §5 calls the Worker's fixed `idFromName('singleton')` debt: a placeholder for a lookup.
`src/server/Owner.ts` is that lookup. The Worker routes every connection to `MATCH_SERVER`, and
`Journeys` asks `ownerOf(squad)` before it acts on one, refusing a squad that belongs to another
server. Both answer the same instance today. Splitting the world (`ITEM-046`) changes these two
and nothing that calls them. The name itself stays `singleton`: it is what addresses the existing
Durable Object and its storage, and renaming it would address a new, empty one.

## 5. The client

`src/hud/MapScreen.tsx` reads the route with `squad/get`, keeps it current from `squad/changed`
(and reads it again when its socket comes back, since a push sent while it was away reached
nobody), and draws `positionAt(route, connection.now())` ten times a second. It never asks where
the squad is.

**The server's clock, not the window's.** Arrivals and checkpoints are the server's arithmetic on
the Durable Object's clock; a browser's clock can be off by minutes. Every socket that opens asks
`clock/now` three times and keeps the quickest round trip: the offset is the server's answer
minus the midpoint of that trip, good to half its length. `ServerConnection.now()` is this
machine's clock plus that offset, so a squad is drawn where the server has it whatever the
machine's clock says. A server that does not answer `clock/now` leaves the last offset, or none. Orders are a right-click on the map; [ARCH-RENDERING §4](rendering.md) has the screen.

**Fights on the road.** A window learns of one two ways, and either is enough: the
`encounter/started` push (`ServerConnection.watchEncounters`), and `LobbyView.you` with
`control: 'reserved'` and a `joinBy` (the server's clock), which a window that connected after the
push reads instead. `src/hud/EncounterPrompt.tsx` asks the player and counts down on
`connection.now()`; **Take the fight** is `room/enter { kind: 'resume', roomId }`, the same
takeover as any window resuming its match. `ServerPanel` takes a seat over by itself only for
`control: 'player'`. The map's panel lists what happened while the player was away
(`encounter/feed`) and plays a fight back from `match/recording`
([ARCH-RENDERING §4](rendering.md)).

## 6. Pushes

`tictac/api/squad/changed { squad }` goes to the player's bound window (`Lobby.tell`) whenever the
route changes: an order from any of their windows, or an arrival. It carries the whole route, as
`squad/get` answers it; a window recomputes the position from it.
