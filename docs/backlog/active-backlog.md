---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
lastReviewed: "2026-10-01"
appliesTo:
  - "src/**"
  - "workers/**"
  - "wrangler.jsonc"
relatedDocs:
  - "docs/backlog/README.md"
  - "docs/backlog/completed.md"
  - "docs/plans/active-focus.md"
  - "docs/plans/roadmap.md"
  - "docs/architecture/deployment.md"
  - "docs/design/rfc/0002-region-sharded-durable-objects.md"
tags: ["backlog", "tasks", "active"]
---

# Active Backlog

**The specification of every open item** — why it is wanted, what changes, and how we will know
it is done. It is not ordered and says nothing about what happens next: that is the
[focus board](../plans/active-focus.md). Finished and rejected items move to the
[archive](./completed.md).

---

### [ITEM-046] Region-Sharded Durable Objects
**Type:** Infrastructure
**Priority:** P3
**Status:** Backlog — a design only ([RFC-0002](../design/rfc/0002-region-sharded-durable-objects.md)); not started, and not startable yet (see Why)
**Milestone:** Unscheduled — gated on the shared world existing, which is not a milestone deliverable today

#### Why
`[ITEM-045]`'s single Durable Object is correct for the game that exists today and wrong for
the one the [GDD](../design/gdd/overview.md) describes: a persistent shared world with base
building, an economy and regional chat, where players are present continuously rather than for
the few minutes one match takes. A single Durable Object instance is one thread and cannot be
scaled up, only replaced, so that replacement is worth planning before load forces it.
RFC-0002 is that plan: shard by region of the shared world, not by match, with a region
splitting into two Durable Objects under load and players handed off between them as they
cross a boundary or as a split moves the boundary through them.

**This item cannot be started today.** It depends on the shared world itself — regions, a
coordinate space bigger than one battlefield, a reason a character keeps existing somewhere
between matches — none of which the current game has. It is filed now, at Backlog rather than
Ready, so the dependency is visible rather than the plan being reinvented later under pressure.

#### Change
See [RFC-0002](../design/rfc/0002-region-sharded-durable-objects.md) in full; summarised:
1. A region id replaces `workers/index.ts`'s fixed `env.MATCH.idFromName('singleton')`. The
   region id → Durable Object lookup is **staged by Durable Object count, not fixed on one
   mechanism**: baked straight into the Worker's own deployed code while the count is low (no
   extra store at all — it is redeployed at the same disconnect-window deploy every split or
   merge already needs), graduating to a Workers KV directory only once redeploying for every
   reassignment stops being the convenient option (RFC-0002 §6.3). Workers KV's own free tier
   caps writes at 1,000/day; a cadence of occasional, deliberate splits and merges stays nowhere
   near it, but it is the first free-tier wall this item would hit if reassignments ever became
   frequent.
2. A zone has no identity of its own — it is shorthand for whatever partition of the world's
   content one Durable Object currently owns (RFC-0002 §2). The world starts as one whole
   partition — exactly `[ITEM-045]`'s single instance, already — and is redrawn over time as
   load grows, dressed in whichever piece of the fiction fits (a fence, a faction, a base, a
   political border), not shipped as invisible level geometry. Crossing a boundary is a
   deliberate, designed act, not a coordinate that can drift across an invisible line — which is
   also what rules out a player oscillating near a border and being handed off repeatedly
   (RFC-0002 §6.2).
3. The Durable Object currently holding a connection is responsible for handing it off to the
   destination the moment a crossing happens (RFC-0002 §4) — not a directory, and not the
   destination reaching in to pull it over.
4. A squad's position on the world map is its own durable property, not the connection's
   transient state (RFC-0002 §4 — a correction from this item's first draft). This is what
   answers cold-start routing (look up a squad's last known position, route through the
   directory) without a separate system, and is why a presence connection may end up able to use
   Cloudflare's Hibernation API where a match's referee socket today cannot. What still is not
   the roster: accounts, sheet, deeds, growth and the match log stay one logical `Persistence`
   store every region-owning instance can reach, per RFC-0001 §8.4's "one database, behind a
   portable port"; splitting *that* by region is explicitly rejected in RFC-0002 §4.
5. A partition facing too much load — measured by CPU time and by client latency read against
   what a player's real-world physical distance would predict, thresholds still to be tuned
   against real traffic (RFC-0002 §6.1) — spins up a second Durable Object *proactively*, at
   roughly 80% of that measure rather than waiting for it to be hit. New arrivals route straight
   to whichever half now owns their location from that moment; a connection already standing in
   the carved-off piece is reassigned at the next disconnect the deployment was already going to
   force (typically a schema-migrating deploy — `[ITEM-045]`'s `migrate.ts` migrations already
   run at Durable Object startup), not a bespoke idle-detection system (RFC-0002 §2).
6. The same trigger runs in reverse: a partition whose load falls back below a lower mark is
   merged back into a neighbour at the same disconnect windows. Decided, not left open — per
   Cloudflare's own pricing, an instance's compute-duration cost is driven by how long it stays
   non-hibernating multiplied by how many instances exist, not by how many connections are on
   each one, so a thinned-out unmerged partition keeps paying full-partition rates for as long as
   anything keeps its connections from hibernating (RFC-0002 §6.5).
7. A match never spans two Durable Objects (RFC-0002 §4, §6.4); keeping combat from starting
   exactly on a boundary is left to world/narrative design, not engineering.

#### Affected Files
- `workers/index.ts` (routing; a baked-in table at first, a Workers KV namespace later once DO
  count outgrows it — RFC-0002 §6.3)
- Whatever the shared world's own persistent squad-position and presence system turns out to be,
  once it exists — not yet a file in this repository

#### Acceptance Criteria
- [ ] The shared world exists as at least one partition with a squad's position tracked as its
      own durable property — tracked by whatever items eventually build it, not this one.
- [ ] A connection routes to the Durable Object currently owning a squad's position, through
      whichever directory mechanism is in force (baked-in table, or Workers KV once DO count
      outgrows it).
- [ ] Crossing a boundary (a deliberate, designed act, not continuous position tracking) hands a
      live session off without the player having to reconnect, verified by an automated test
      that plays a session across a scripted boundary.
- [ ] A partition under simulated load splits proactively (before, not after, the measured
      trigger), new arrivals route to whichever half owns their location immediately, and an
      already-connected player is reassigned at the next disconnect rather than mid-session.
- [ ] A partition whose load drops is merged back at the same disconnect windows, verified by an
      automated test or a documented cost model, not left permanently fragmented.
- [ ] `Persistence` remains reachable by every region-owning instance without being partitioned
      by region (RFC-0002 §4) — or, if that changes, the change is a deliberate edit to this
      item and RFC-0002, not a quiet divergence.

---

### [ITEM-047] Uncap the Roster: Bench Grows With Bases and Vehicles, Squad Cap Is Per-Combat
**Type:** Feature
**Priority:** P3
**Status:** Backlog — a design only ([GDD-OVERVIEW](../design/gdd/overview.md) §3,
[GDD-ECONOMY](../design/gdd/economy-and-bases.md),
[GDD-PROGRESSION](../design/gdd/progression-and-meta.md) §5); not started, and not startable yet
(see Why)
**Milestone:** Unscheduled — gated on base/vehicle economy existing, which is not a milestone
deliverable today

#### Why
`ITEM-042`'s `ROSTER.size = 6` and `SQUAD_SIZE = 4` were scoped to get a playable demo, not
declared as the game's ceiling — the design direction has moved past them. A player starts with
two characters, not six (the opening, GDD-OVERVIEW §3), and the bench grows from there as large
as whatever bases and vehicles they hold can house, with no constant capping it. How many of the
bench deploy to any one combat should be set by that combat (a narrow interior, a scripted story
ambush, an open-field assault each stating their own cap), not a flat four every time.

**This item cannot be started today.** Capacity and cap depend on systems that do not exist in
code: bench capacity depends on the base/vehicle economy (`GDD-ECONOMY`, currently prose only — no
`Base`/`Vehicle` exists anywhere under `src/`), and a per-combat squad cap depends on a
scenario/mission system that states one (nothing today hands `Referee`/`Squads` a cap other than
the flat constant). Dealing two at registration needs neither, but on its own it changes nothing:
recruiting is free (`ITEM-037`), so a player would recruit straight back to six. It ships with
capacity, not before. Filed at Backlog rather than Ready so the dependency is visible rather than
reinvented later, the same reasoning `ITEM-046` was filed on.

#### Change
1. **Registration deals two.** `Accounts.register` calls `rollSquadSheets(rng, ROSTER.size)`
   today; it deals the opening pair instead (GDD-OVERVIEW §3). The pair is fixed by the story,
   not by capacity — every starting holding houses at least two.
2. **Bench capacity becomes computed, not constant.** `ROSTER.size` (`src/config.ts`) stops
   being a flat 6; `Rosters.recruit` refuses past a capacity the economy computes (sum of
   whatever each held base/vehicle contributes) instead of the constant. Depends on the
   base/vehicle economy shipping a capacity number per holding first.
3. **Squad deploy cap becomes situational, not constant.** `SQUAD_SIZE` (`src/config.ts`) stops
   being a flat 4; `Referee.verifyRosters`, `deploymentsFrom` (`src/game/Recording.ts`), the
   default count of `rollSquadSheets` (`src/core/Characters.ts`), and `RosterScreen`'s toggle need a
   per-match cap supplied by whatever starts the combat (a scenario, a mission, a PvP queue),
   defaulting to *something* when nothing states one. Depends on a scenario/mission system that
   can state a cap existing first.
4. **Everywhere `SQUAD_SIZE`/`ROSTER.size` is referenced as a fixed bound** —
   `docs/architecture/networking.md`, `docs/architecture/persistence.md`,
   `docs/backlog/completed.md`'s `ITEM-041`/`ITEM-042`/`ITEM-043` entries — either gets a note
   that the constant was superseded, or (once built) is updated to describe the computed bound
   directly, per living-docs policy (architecture docs describe the system *now*).

#### Affected Files
- `src/config.ts` (`ROSTER.size`, `SQUAD_SIZE`)
- `src/server/Accounts.ts` (`register` deals two)
- `src/core/Characters.ts` (`rollSquadSheets` default count)
- `src/game/Recording.ts` (`deploymentsFrom` bound)
- `src/server/Rosters.ts` (`recruit`)
- `src/server/Room.ts` (`verifyRosters`)
- `src/hud/RosterScreen.ts` (deploy toggle, defaulting, empty-slot rendering)
- `docs/architecture/networking.md`, `docs/architecture/persistence.md`
- Whatever the base/vehicle economy and the scenario/mission system turn out to be, once they
  exist — not yet files in this repository

#### P2P / Simulation Impact
- `RecordingHeader`'s deployment count bound (today `1..SQUAD_SIZE`) becomes `1..cap`, where
  `cap` is carried on the header itself so a replay knows what bound applied without
  re-deriving it from state that can change later.
- The balance sweep (`scripts/balance.ts`) has no roster today (`ITEM-042`'s acceptance already
  noted this) and needs a stated cap once one is no longer implicit in a constant it already
  imports.

#### Acceptance Criteria
- [ ] A freshly registered player holds exactly two active roster members.
- [ ] A player can hold more than six active roster members once they hold enough bases/vehicles
      to house them, and recruiting past six no longer refuses.
- [ ] Two combats with different stated caps (e.g. 2 and 6) each accept a squad up to their own
      cap and refuse past it — not a `SQUAD_SIZE` shared by both.
- [ ] `RosterScreen` defaults its toggle and empty-slot count to the current combat's cap, not a
      hardcoded four.
- [ ] `bun run balance` states whatever cap it sweeps at explicitly (flag or config), not by
      importing `SQUAD_SIZE` implicitly.
- [ ] Living documentation updated: `docs/architecture/networking.md`,
      `docs/architecture/persistence.md` describe the computed bound, not the old constants.

#### Risks & Mitigations
- **Risk:** shipping the squad-cap half before a real scenario system exists means every combat
  still gets the same default cap, making the change invisible in play.
- **Mitigation:** do not pull this half Ready until at least one caller (even a hardcoded
  per-scenario test fixture) can state a cap different from the default — otherwise it is a
  refactor with no observable behavior, which is exactly what living-docs policy says not to
  claim as done.
- **Risk:** an unbounded bench with no economy yet to gate it (recruit is still free, `ITEM-037`)
  lets a player recruit without limit before base/vehicle capacity exists to cap it.
- **Mitigation:** sequence the base/vehicle economy's capacity number ahead of removing
  `ROSTER.size`'s constant, not after — §Why already states this as a hard dependency, not a
  nice-to-have ordering.

---

### [ITEM-048] Wild Alien Encounters on the Road
**Type:** Feature
**Priority:** P2
**Status:** Backlog — designed ([GDD-WORLD](../design/gdd/world-and-travel.md) §5,
[GDD-OVERVIEW](../design/gdd/overview.md) §2); not startable until `ITEM-050` (the world map and
travel) ships
**Milestone:** Unscheduled

#### Why
Humans are the only playable faction at the start; the aliens are run by the game and have no
persistent identity (GDD-OVERVIEW §2). Meeting them is a wild encounter: a random alien squad,
rolled fresh for the fight, gone once the fight is settled. Today there is no way to fight the
game at all from a live client against the referee; every refereed match needs two humans.

This item first argued it could ship before the world existed, with "a random place" meaning
only a freshly generated battlefield. That sequencing was overruled (2026-10-02): an encounter
is something that happens *somewhere on the map*, to a squad that was going somewhere, so it
waits for `ITEM-050`. The battlefield is still `generateMap(seed)`; the world map adds where
the squad was and what happens to its journey afterwards.

#### Change
1. **Encounters are found on the road** (GDD-WORLD §5.1). At each travel alarm checkpoint the
   server rolls whether an alien squad found the squad on the stretch just travelled, scaled by
   the area's danger and the travel pace. The roll is setup randomness from a stream seeded by
   (squad, trip, checkpoint), never a match's dice, and is decided at the checkpoint, not in
   advance, so no future encounter exists to leak. Contact halts travel.
2. **The referee plays the alien side.** It issues the alien squad's commands as intents, the
   same commands a human sends, using the policy `ebc3d49` split out of `SimMatch`. Not the
   human's client: a client that drives its own opponent can make it play badly.
3. **The referee can also play an absent human's side** (GDD-WORLD §5.2), to that player's
   standing order (`ITEM-052`). A player online at contact gets a **join window** to take the
   fight; otherwise the AI plays it. With nobody present the fight is fought out at once on the
   server, headless. Every one of these is an ordinary match: recorded, replayable, settled.
4. **The header records who controlled each side** (human or AI), for audit and for the
   return feed.
5. **The alien squad is rolled, not stored.** Sheets and kit are dealt from system randomness
   at encounter start, stated in the header like any squad, never written to `roster`; the
   alien side settles like an anonymous one does. The encounter sizes it within today's
   `1..SQUAD_SIZE` (`ITEM-041` already handles short-handed squads); once `ITEM-047` lands the
   encounter is the caller that states a per-combat cap.
6. **The human side settles normally**, including growth, whether it played or the AI played
   for it.
7. **After the fight** a surviving squad resumes its route or stops and waits: a player
   setting.
8. **A return feed**: what happened while the player was away, each fight watchable back.

#### Affected Files
- `src/server/Room.ts` (an AI-controlled side; settling a side with no roster)
- `src/sim/Policy.ts`, `src/game/AiOpponent.ts` (the policy seated by the referee)
- `src/game/Recording.ts` (controller per side in the header)
- Travel's alarm/checkpoint scheduler from `ITEM-050`
- `src/hud/` (the join window, the return feed)
- `docs/architecture/networking.md`, `docs/architecture/persistence.md`

#### P2P / Simulation Impact
- **The AI's own choices are intent, not rules.** It may take its own randomness to decide, but
  it must never draw from the match stream (`matchDice(seed)`): only the rules draw there, the
  same order on every side (ADR-0004, `tests/determinism.test.ts`).
- A recording replays from commands, so an AI match replays without the AI.
- The balance sweep is unchanged; it already plays AI against AI.

#### Acceptance Criteria
- [ ] A travelling squad runs into an alien squad at a checkpoint, and its journey stops.
- [ ] An online player takes the fight inside the join window and plays it through the referee to
      settlement; a player who lets the window lapse has it played for them.
- [ ] With nobody online the fight is fought out on the server and settles the roster, growth
      included, exactly as a played match would.
- [ ] Nothing about the alien squad is written to `roster`.
- [ ] The encounter roll for a given (squad, trip, checkpoint) is reproducible after the fact.
- [ ] Two encounters roll different alien squads; the same recording replays identically.
- [ ] `tests/determinism.test.ts` still passes: the AI draws nothing from the match stream.
- [ ] Living documentation updated.

#### Risks & Mitigations
- **Risk:** the aliens are a faction in the lore only. There is no alien kit (no plasma weapon
  exists in `src/`) and `Faction` is Blue/Red, so the first encounters are an AI squad dressed
  as aliens with human kit.
- **Mitigation:** ship the encounter with existing kit and file alien kit separately; the
  encounter does not depend on what the squad carries.
- **Risk:** the policy was written to measure balance, not to be fun to fight or to fight well on
  a player's behalf; it never sneaks, throws smoke or uses doors (focus board, "Left open").
  Once it plays absent players' squads, its weaknesses cost real characters.
- **Mitigation:** retreat (`ITEM-051`, `ITEM-052`) gives an absent squad a way out; improving
  the policy is filed as its own work once this exposes where it fails.
- **Risk:** a join window needs a way to tell an online player that something found them.
- **Mitigation:** in-app only to start (the player's open socket); push notifications are out of
  scope.

---

### [ITEM-049] Start Location From the Player's Real-World Area — merged into ITEM-050
**Type:** Feature
**Status:** Merged into `ITEM-050` (2026-10-02): the start location and the world map need the
same primitive, a squad's position, and ship together. The design is in
[GDD-WORLD](../design/gdd/world-and-travel.md) §4 and GDD-OVERVIEW §3; the change list moved
into `ITEM-050`'s.

---

### [ITEM-050] The World Map and Travel
**Type:** Feature
**Priority:** P2
**Status:** Ready — designed ([GDD-WORLD](../design/gdd/world-and-travel.md) §1–4); absorbs
`ITEM-049`
**Milestone:** Unscheduled

#### Why
Everything the GDD calls the shared world (GDD-OVERVIEW §3, §4) rests on one missing thing: a
squad has no position. Encounters on the road (`ITEM-048`, `ITEM-053`), where a player starts
(`ITEM-049`, merged here) and region sharding (`ITEM-046`) all wait on it.

Prior art exists in `../no-way-home`, the project this one grew out of: a real-Earth PMTiles
basemap served from R2, waypoint travel on Durable Object alarms, path-based fog of war. Its
waypoint maths (`packages/shared/src/waypoint-utils.ts`, 16 passing tests, no dependencies) is
sound and ports almost as-is. Its server orchestration is not proven: its integration suite is
disabled, its unit test is a placeholder and its E2E ran 4/7. And its basemap,
`map-tiles/world.pmtiles` (33 MB), is already in this account's R2 bucket `map-tiles`.

#### Change
1. **Serve the map.** Bind the existing R2 bucket `map-tiles` to `tictac-match-server`; serve
   `GET /api/tiles/{z}/{x}/{y}.mvt` by range-reading `world.pmtiles` (the prior art's ~70-line
   R2 `Source` adapter plus its tile route, with abort handling fixed). A client served from
   GitHub Pages fetches tiles from its match server, across origins.
2. **A squad has a position**, as a list of waypoints (GDD-WORLD §2), stored with the squad in
   `Persistence`. Port the waypoint maths into the headless core with the clock injected rather
   than read (`Date.now()` inside it today) and returning new lists rather than mutating; bring
   its tests along.
3. **Wall-clock travel on alarms** (GDD-WORLD §3). The match server's Durable Object holds one
   alarm, so a scheduler keeps every squad's next due moment and arms the alarm for the
   earliest. Alarms are at most an hour apart; an arrival is recorded at its expected time, not
   the time the alarm fired. One mechanism for every scale of movement.
4. **Orders on the map**: go here, go here now, go here first, go here next, stop (GDD-WORLD §3),
   as requests to the match server, which validates and updates the waypoint list. Pace
   (cautious, normal, flat out) sets the speed of a leg.
5. **Where a player starts** (ex-`ITEM-049`): on registration, read
   `request.cf.latitude`/`longitude` (absent off Cloudflare); draw a point uniformly over the
   50 km disc (radius `R·√u`); redraw while within a minimum distance of an existing start;
   store only the drawn point; fall back to a default anchor when nothing is reported.
6. **The map in the client**: MapLibre GL with a Protomaps style over the served tiles, the
   player's squad drawn where it is, moving between frames by the same position function the
   server uses, and the order verbs on right-click. Written fresh against this project's state,
   not ported from the prior art's 888-line view.

#### Affected Files
- `wrangler.jsonc` (R2 binding), `workers/index.ts`, `workers/MatchDurableObject.ts` (tiles,
  alarm, `request.cf` through to registration)
- `src/core/` (waypoint maths, headless), `src/server/` (travel orders, the scheduler, the
  squad's position in `Persistence`), `src/server/db/migrate.ts` (a migration for it)
- `src/server/Accounts.ts` (`register`: the start location)
- `src/hud/` or a new map view; `src/main.ts` (getting to it)
- `package.json` (`pmtiles`, `maplibre-gl`, `protomaps-themes-base`)
- `docs/architecture/` (a world/travel section), `docs/design/gdd/world-and-travel.md`

#### P2P / Simulation Impact
- None on matches. Travel has no randomness; its position function is a pure function of the
  waypoints and the time, so it needs no match stream and does not touch `matchDice`.
- Travel orders are not match commands and do not go on the match wire; the wire-shape catalogue
  is untouched unless travel later moves onto the socket.

#### Acceptance Criteria
- [ ] A freshly registered player through Cloudflare sees their squad on a real map within 50 km
      of the reported point, which is stored nowhere; starts from one anchor spread uniformly over
      the disc (statistical test) and respect the minimum distance; registration off Cloudflare
      still works through the fallback.
- [ ] Tiles are served from the existing `map-tiles/world.pmtiles` through the match server, to a
      client on the match server's own origin and to one on GitHub Pages.
- [ ] All five orders work and the waypoint maths is unit-tested with an injected clock.
- [ ] A squad sent on a long trip keeps travelling with the tab closed; on return it is where the
      clock says it should be, and an arrival that happened while away is recorded at its
      expected time.
- [ ] A refresh mid-journey resumes without a jump.
- [ ] Living documentation updated.

#### Risks & Mitigations
- **Risk:** a drawn start can land in the sea; the basemap knows where land is, the server does
  not yet.
- **Mitigation:** accept sea starts for now, or redraw against a coarse land mask; decide when
  it is built, not before.
- **Risk:** the 33 MB extract may not cover the whole world; a player from outside it starts on
  a blank map.
- **Mitigation:** check the extract's bounds first; the prior art's download script can fetch a
  larger build if needed (rewrite it to stream: it buffers the whole file in memory).
- **Risk:** IP geolocation can be far off (mobile carriers, VPNs).
- **Mitigation:** accepted. The start is meant to be roughly local, not exact.

---

### [ITEM-053] Player Encounters on the Road
**Type:** Feature
**Priority:** P3
**Status:** Backlog — designed ([GDD-WORLD](../design/gdd/world-and-travel.md) §5); waits for
`ITEM-050` and `ITEM-048`
**Milestone:** Unscheduled

#### Why
The "PvP" in PvPvE: two squads whose routes cross can fight. Travel carries on while players
are away, so most crossings will involve at least one absent player.

#### Change
1. **Finding each other.** Every leg is a straight line at constant speed, so two squads'
   closest approach is solved directly. When a route is set, the server checks it against every
   other squad in the same zone, schedules a meeting if they come within engagement range, and
   re-checks when it fires. Within one Durable Object only: no cross-DO matches
   ([RFC-0002](../design/rfc/0002-region-sharded-durable-objects.md) §6.4).
2. **Who plays** follows `ITEM-048`: live for whoever is present (join window), the AI to its
   player's standing order for whoever is not, fought out on the server if nobody is. Both
   sides are rostered and both settle.
3. **Offline squads can be engaged — on trial.** Ships enabled behind a server switch; feedback
   decides whether it stays. Zone rules (places where an absent squad cannot be engaged) wait for
   zones.

#### Affected Files
- Travel's scheduler (`ITEM-050`), the referee's AI seating (`ITEM-048`), `src/server/Room.ts`

#### P2P / Simulation Impact
- None on match rules. The meeting check is geometry over waypoints, outside any match.

#### Acceptance Criteria
- [ ] Two squads whose routes cross within range meet at the computed moment; a route changed
      beforehand moves or cancels the meeting.
- [ ] Each of the three presence cases plays and settles both rosters.
- [ ] Engaging offline squads can be switched off without a deploy of new code.

#### Risks & Mitigations
- **Risk:** a sleeping squad is a target; griefing.
- **Mitigation:** standing orders including evade (`ITEM-052`), travel pace, the switch, and zone
  rules once zones exist.

---

### [ITEM-054] Capture and Rescue
**Type:** Feature
**Priority:** P3
**Status:** Backlog — an idea, not designed
**Milestone:** Unscheduled

#### Why
A character left behind on a retreat (`ITEM-051`) is lost, counted as dead. Being captured
instead, held somewhere on the map and freed by a later fight, would turn that loss into a
reason to go somewhere.

#### Change
To be designed. Likely a `captured` roster status alongside `dead`, a place on the map where the
captive is held (`ITEM-050`), and a fight that frees them. Until then the left-behind are removed
from the roster the way the dead are; whether that row is deleted or kept makes no difference
to this item.

#### Acceptance Criteria
- [ ] Designed in the GDD before any of it is built.
