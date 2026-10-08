---
title: "The World Map: Squads, Orders and the Travel Schedule"
id: "ARCH-WORLD"
type: "architecture"
status: "active"
lastReviewed: "2026-10-08"
appliesTo:
  - "src/core/Travel.ts"
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

`Journeys` owns the `arrival` kind. Its handler reads the squad, records every arrival due by now
at its due time (`settle`), writes the route if it changed, pushes it, and schedules the next
arrival. A late alarm therefore never lengthens a trip, and the stored route always has the
checkpoints the maths says it has.

Orders, arrivals and the restart all go through one queue in `Journeys`, so an alarm and a
request never read the same route and both write it. A Durable Object already runs one event at a
time; the Bun server needs the queue.

**Restart.** `Journeys.restore()` schedules every travelling squad's next arrival from `squads`,
beside `lobby.restore()`, before the host lets anyone in. An arrival that fell due while no
server was running is due at once, and recorded at the time it should have happened.

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
nobody), and draws `positionAt(route, Date.now())` ten times a second. It never asks where the
squad is. Orders are a right-click on the map; [ARCH-RENDERING §4](rendering.md) has the screen.

## 6. Pushes

`tictac/api/squad/changed { squad }` goes to the player's bound window (`Lobby.tell`) whenever the
route changes: an order from any of their windows, or an arrival. It carries the whole route, as
`squad/get` answers it; a window recomputes the position from it.
