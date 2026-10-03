---
title: "GDD: The World Map, Travel and Encounters on the Road"
id: "GDD-WORLD"
type: "gdd"
status: "active"
lastReviewed: "2026-10-02"
appliesTo:
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

**Status: designed, not built** (`ITEM-050`, `ITEM-048`, `ITEM-053`). This is where a squad
is between fights. Combat ([Combat Mechanics](combat-mechanics.md)) is what happens once two
squads meet. The overview's shared world ([Overview](overview.md) §3, §4) assumes this layer
exists; this document says what it is.

**Prior art.** `../no-way-home`, the project this one grew out of, built a working version of
the map and travel half: a real-Earth basemap, waypoint travel driven by Durable Object alarms,
and path-based fog of war. Its design document never specified the map (its own §9 lists
"World Map design" as a TODO). What it shipped is a set of implementation decisions, and the
ones adopted here are named as such. Its tile archive, `map-tiles/world.pmtiles` (a 33 MB
regional extract), is already in this account's R2.

## 1. The map is the real Earth

The world is laid over the real one ([Overview](overview.md) §3): a player in Lyon starts
around Lyon. The map is an OpenStreetMap-derived vector basemap (Protomaps), stored as one
PMTiles archive in R2 and served by the match server one tile at a time. A position is
latitude and longitude. There is no grid, no projection and no region system at this layer;
distance is great-circle distance.

## 2. A squad has a position

**Position belongs to the squad**, the same durable thing its people are
([RFC-0002](../rfc/0002-region-sharded-durable-objects.md) §4). It is not stored as a point.
It is a list of waypoints:

- **Past waypoints** are where the squad has been: where, when it arrived, when it left, and
  how fast it was going on the leg that followed.
- **Future waypoints** are where it has been told to go: just a place.

Where the squad is *now* is computed from that list and the clock, never stored: time since
it left its last waypoint times its speed, along the leg it is on. Server and client compute
it with the same function, so they cannot disagree. A refresh mid-journey resumes where the
squad actually is, and the client can draw it moving without asking the server anything.

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

**Orders on the map** are four verbs, given by pointing at a place:

| Verb | When | Effect |
| --- | --- | --- |
| Go here | at rest | set off |
| Go here now | travelling | abandon the route and head here from where the squad is |
| Go here first | travelling | detour here, then carry on |
| Go here next | travelling | add a stop after the current destination |

Stopping where the squad is is the fifth.

## 4. Where a player starts

On registration a player's squad is placed at a random point within **50 km** of the
latitude and longitude Cloudflare reports for the connection ([Overview](overview.md) §3).
The point is drawn uniformly over the disc, redrawn if it lands too close to another
player's start, and only the drawn point is stored. A connection with no reported location
falls back to a default anchor.

## 5. Encounters on the road

A squad on the move can run into something. That is the commonest way a fight starts.

### 5.1 What finds you

- **The aliens** ([Overview](overview.md) §2, `ITEM-048`). At each alarm checkpoint the
  server rolls whether something found the squad on the stretch just travelled, scaled by how
  dangerous the area is and how fast the squad is going. The roll is setup randomness, seeded
  from the squad, the trip and the checkpoint, so it can be audited afterwards. It is never a
  draw from a match's dice, and it is not decided in advance: no future encounter exists for a
  client to read.
- **Other players** (`ITEM-053`). Every leg is a straight line at a steady speed, so the
  server can work out exactly when two squads' routes come within reach of each other. It
  checks a new route against every other squad in the zone when it is set, schedules the
  meeting, and checks again when the moment comes, since either route may have changed by
  then.

Contact stops the squad. The fight is an ordinary match: the same rules, the same referee, the
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

## 6. Not designed yet

- **Fog of war on the map.** The prior art's model (reveal along the route actually travelled,
  each point of it to a sight radius) is the likely starting point; nothing here depends on it.
- **Points of interest**: towns, ruins, crash sites and what is in them.
- **Roads and terrain.** A leg is a straight line; nothing slows a squad crossing a mountain.
- **Fuel** and vehicles.
- **Capture and rescue** of characters left behind (`ITEM-054`).
