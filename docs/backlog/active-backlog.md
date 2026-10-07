---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
lastReviewed: "2026-10-07"
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
M5 — The Shared World (`ITEM-060`–`ITEM-065`) builds the first of these: a squad position as
its own durable row (`ITEM-063`) and the one routing seam, `ownerOf(squad)` (`ITEM-064`), that
this item later replaces. It still leaves nothing to shard until there is load.

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
- The `squads` table (`ITEM-063`) and the travel scheduler's `ownerOf(squad)` (`ITEM-064`) —
  the one seam the directory replaces

#### Acceptance Criteria
- [ ] The shared world exists as at least one partition with a squad's position tracked as its
      own durable property — built by `ITEM-063` (the `squads` table) and `ITEM-064`, not this one.
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
scenario/mission system that states one (nothing today hands `Room`/`Squads` a cap other than
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
   being a flat 4; `Room.verifyRosters`, `deploymentsFrom` (`src/game/Recording.ts`), the
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
[GDD-OVERVIEW](../design/gdd/overview.md) §2); not startable until the travel scheduler
(`ITEM-064`) ships and `ITEM-066` has settled the decisions it needs
**Milestone:** Unscheduled

#### Why
Humans are the only playable faction at the start; the aliens are run by the game and have no
persistent identity (GDD-OVERVIEW §2). Meeting them is a wild encounter: a random alien squad,
rolled fresh for the fight, gone once the fight is settled. Today there is no way to fight the
game at all from a live client against the referee; every refereed match needs two humans.

This item first argued it could ship before the world existed, with "a random place" meaning
only a freshly generated battlefield. That sequencing was overruled (2026-10-02): an encounter
is something that happens *somewhere on the map*, to a squad that was going somewhere, so it
waits for the world map (`ITEM-050`, split into `ITEM-060`–`ITEM-065`) and for the decisions in
`ITEM-066`. The battlefield is still `generateMap(seed)`; the world map adds where
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
- Travel's alarm/checkpoint scheduler from `ITEM-064`; the stable (squad, trip, checkpoint) keys
  from `ITEM-062`
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
into `ITEM-050`'s, and from there into `ITEM-063` when `ITEM-050` was split (2026-10-07).

---

### [ITEM-050] The World Map and Travel — split into ITEM-060–ITEM-065
**Type:** Feature
**Status:** Split into `ITEM-060`–`ITEM-065` on 2026-10-07 (milestone M5 — The Shared World);
the decisions encounters need before they are built are `ITEM-066`, and on-demand closer zooms
are `ITEM-067` (deferred). It had absorbed `ITEM-049`; the start location is now `ITEM-063`.
The design is still
[GDD-WORLD](../design/gdd/world-and-travel.md) §1–4. The prior art it pointed at, in
`../no-way-home`: the waypoint maths `packages/shared/src/waypoint-utils.ts` and its 16 tests
(ported by `ITEM-062`) and the R2 PMTiles `Source`, `packages/workers/src/lib/r2-pmtiles-source.ts`
(ported by `ITEM-061`). Its other assumption did not survive the split: the archive already in
R2, `map-tiles/world.pmtiles`, is not a world map but Stuttgart only (lon 8.9–9.5, lat
48.55–49.0, z0–14, 1,259 tiles), so serving the planet is `ITEM-061`'s job.

---

### [ITEM-053] Player Encounters on the Road
**Type:** Feature
**Priority:** P3
**Status:** Backlog — designed ([GDD-WORLD](../design/gdd/world-and-travel.md) §5); waits for
the travel scheduler (`ITEM-064`) and `ITEM-048`
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
- Travel's scheduler (`ITEM-064`, which keeps a due moment of any kind so a planned meeting
  fits), the referee's AI seating (`ITEM-048`), `src/server/Room.ts`

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
captive is held (a row of `ITEM-063`'s `squads` table, which is its own table partly so captives
can have positions), and a fight that frees them. Until then the left-behind are removed
from the roster the way the dead are; whether that row is deleted or kept makes no difference
to this item.

#### Acceptance Criteria
- [ ] Designed in the GDD before any of it is built.

---

### [ITEM-060] One Connection per Window: the API Over JSON-RPC
**Type:** Infrastructure
**Priority:** P2
**Status:** Ready
**Milestone:** M5 — The Shared World

#### Why
A signed-in window today talks to its match server two ways: HTTP `fetch` to `/api/*`
(`src/server/Api.ts`: passkey ceremonies, sign-out, `me`, the roster, recruiting, the lobby,
socket tickets) and a WebSocket for the room it sits in. The user's decision (2026-10-07) is
that the socket is reused for everything: one connection per window. It also pays for itself:

- The lobby panel polls `GET /api/lobby` every two seconds (`LOBBY_POLL_MS` in
  `src/hud/menu/ServerPanel.tsx`); over a socket the server pushes changes instead.
- Socket tickets (`POST /api/ticket`, held in memory by `Accounts`) exist only because a
  session token must not go in a socket url; an RPC carrying the token over an open socket
  needs no ticket.
- The API's CORS (`Access-Control-Allow-*` in `Api.ts`) exists only because a page on GitHub
  Pages `fetch`es another origin; a WebSocket needs none.
- The world map (`ITEM-064`, `ITEM-065`) and, later, an encounter's join window (`ITEM-048`) need
  a channel the server can push down. The socket already governed by the one-live-window-per-player
  rule (`ITEM-058`) is that channel, rather than a second one to reconcile with it.

Only static content stays HTTP: the built client, and map tiles, which MapLibre fetches by url
(`ITEM-061` moves them to `/tiles/{z}/{x}/{y}.mvt`, off `/api`).

#### Change
1. **A session socket per window**, opened as soon as a match server is chosen (not when a
   room is entered), and kept for the life of the window. Rooms are entered and left over it.
2. **Requests with ids, and notifications for pushes.** `src/game/JsonRpc.ts` already declares
   `JsonRpcRequest`, `JsonRpcSuccessResponse` and `JsonRpcErrorResponse`; only notifications are
   used today. Requests carry ids and get exactly one response; the server pushes with
   notifications. Match traffic stays the notifications it is.
3. **A method for every route in `Api.ts`**: passkey register options/verify, login
   options/verify, sign out, `me`, roster list, recruit. The lobby becomes a **subscription**:
   one call answers the current `LobbyView` and later changes arrive as notifications.
4. **Room intents become methods.** `open`, `join`, `watch` and `resume`, which ride the socket
   url today (`intentQuery`), are RPC calls answered by `seated`, with the same refusal texts.
5. **Identity is bound by an RPC carrying the session token**, never in a url. `/api/ticket`
   and the ticket store in `Accounts` are removed. Signing in or out over the socket rebinds or
   unbinds the session in place.
6. **The session rules carry over at session level**: one live window per player (`ITEM-058`)
   applies to the session socket, and seat keys and reconnect (`ITEM-059`) keep working — a
   reconnecting window resumes its seat by key over the new socket.
7. **`request.cf` is captured on the upgrade** and kept on the session, so registration can read
   the connection's latitude/longitude (`ITEM-063`).
8. **The HTTP `/api` handler and its CORS are removed** from `GameServer.ts` and
   `workers/MatchDurableObject.ts`; only static assets and `/tiles/` stay HTTP.
9. **Protocol bump to 7.** `OLDEST_SERVED_PROTOCOL` (`Math.max(6, PROTOCOL_VERSION - 1)`) then
   becomes 6, so the server keeps admitting a protocol-6 socket that resumes an existing room by
   seat key (url intent `resume{room, seat}`), and a match in progress finishes across the
   deploy. Every other protocol-6 request is refused with the reload text.

#### Affected Files
- `src/server/Api.ts` (removed; its handlers move behind RPC methods)
- `src/server/Lobby.ts` (session sockets, lobby subscription, intents as methods)
- `src/server/Room.ts`, `src/server/Accounts.ts` (tickets removed), `src/server/GameServer.ts`
- `workers/MatchDurableObject.ts` (`request.cf` on the upgrade; no `/api`)
- `src/game/Account.ts`, `src/game/NetworkManager.ts`, `src/game/JsonRpc.ts`
- `src/hud/menu/ServerPanel.tsx` (no polling), `src/main.tsx`
- `src/version.ts` (protocol 7)
- `docs/architecture/networking.md`, `docs/architecture/persistence.md`,
  `docs/architecture/deployment.md`

#### P2P / Simulation Impact
- Wire protocol 7: new request/response and notification methods on the match-server socket;
  the wire-shape catalogue gains them. Peer-to-peer matches are untouched.
- Match commands, the match stream and determinism are unchanged.

#### Acceptance Criteria
- [ ] No `/api/` HTTP routes remain on either host (Bun server, Worker).
- [ ] One socket per window, observed in a browser through sign-in, the lobby, a match and back.
- [ ] Lobby changes arrive as pushes; nothing polls.
- [ ] Passkey registration and sign-in work over RPC on the deployed Worker.
- [ ] A protocol-6 window in a match finishes it across the deploy; any other protocol-6 request
      is refused with the reload text.
- [ ] Tests updated (`bun test`).
- [ ] Living documentation updated: networking, persistence, deployment.

#### Risks & Mitigations
- **Risk:** WebAuthn ceremonies were built around request/response HTTP and its error paths.
- **Mitigation:** the RPC methods keep the same inputs and outputs; verify on the deployed
  Worker, not only locally (an acceptance criterion).
- **Risk:** a socket that is now long-lived keeps a Durable Object awake where a page with no
  room used to cost nothing.
- **Mitigation:** accepted for now; Cloudflare's Hibernation API for the session socket is the
  later fix if the bill shows it.

---

### [ITEM-061] Serve the Map: a Low-Zoom Planet From R2
**Type:** Infrastructure
**Priority:** P2
**Status:** Ready — the zoom cap is still to be chosen (see Change 1)
**Milestone:** M5 — The Shared World

#### Why
The world is the real Earth (GDD-WORLD §1), and the only archive in R2,
`map-tiles/world.pmtiles`, is Stuttgart: its header says lon 8.9–9.5, lat 48.55–49.0, z0–14,
1,259 tiles. The user's decision (2026-10-07, D1): host the whole planet at the most zoomed-out
levels now; closer zooms are built on demand later (`ITEM-067`, deferred).

Measured against Protomaps build `20261007.pmtiles` (the full planet, z0–15, is 138.7 GB) with
`pmtiles extract --dry-run`:

| Zooms | Size |
| --- | --- |
| z0–6 | 45 MB |
| z0–7 | 189 MB |
| z0–8 | 558 MB |
| z0–9 | 1.6 GB |
| z0–10 | 3.8 GB |
| z0–11 | 8.0 GB |
| z0–12 | 18 GB |

R2's free tier is 10 GB-month; standard storage beyond it is $0.015/GB-month.

#### Change
1. **Choose the zoom cap.** The candidates are **z0–8** (558 MB: countries, regions and large
   towns) and **z0–10** (3.8 GB: town streets begin to show), both inside the free tier. The
   choice is open and made when this item is pulled.
2. **Produce the archive** with `pmtiles extract https://build.protomaps.com/<date>.pmtiles
   <out> --maxzoom=N`, which streams by range requests (no 138 GB download).
3. **Upload it through the R2 S3 API** (multipart). `wrangler r2 object put` does not handle
   multi-GB objects. The credentials are in `.env` by name (`R2_S3_API`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`).
4. **Bind `map-tiles` to `tictac-match-server`** in `wrangler.jsonc`.
5. **Port the reference's R2 `Source`** (`../no-way-home/packages/workers/src/lib/r2-pmtiles-source.ts`)
   with its abort handling fixed.
6. **Answer `/tiles/{z}/{x}/{y}.mvt` in `workers/index.ts`**, before the request reaches the
   Durable Object: tiles need no game state, and a tile request should not wake or queue on it.
   The response carries CORS for any origin (a static asset, read by GitHub Pages).
7. **The Bun server answers the same route** from a local `.pmtiles` file, for development and
   tests.
8. **Self-host the style's glyphs and sprites.** The reference loads them from
   `protomaps.github.io`; they become static assets of this project.
9. **Retire the Stuttgart-only `world.pmtiles`**, unless the deferred pipeline (`ITEM-067`)
   wants it.

#### Affected Files
- `wrangler.jsonc` (R2 binding), `workers/index.ts` (the tile route)
- `src/server/GameServer.ts` (the same route from a local file)
- A new tile-source module beside them (the ported R2 `Source`)
- `public/` (glyphs, sprites, style)
- `package.json` (`pmtiles`)
- `docs/architecture/deployment.md`

#### P2P / Simulation Impact
- None. Tiles are static content, not on the match wire.

#### Acceptance Criteria
- [ ] A tile is served to the match server's own origin and to a page on GitHub Pages.
- [ ] A bare MapLibre page shows the whole planet down to the chosen cap.
- [ ] No third-party origin is contacted at runtime (tiles, glyphs, sprites all self-hosted).
- [ ] The Bun server serves the same route from a local file.
- [ ] Living documentation updated (deployment: the binding, the archive, how it was produced).

#### Risks & Mitigations
- **Risk:** a player zooms past the cap and sees nothing finer.
- **Mitigation:** MapLibre overzooms the last level; `ITEM-067` is the real answer.
- **Risk:** a multi-GB upload fails part-way.
- **Mitigation:** multipart through the S3 API, which retries a part rather than the whole.

---

### [ITEM-062] Travel Maths in the Headless Core
**Type:** Feature
**Priority:** P2
**Status:** Ready
**Milestone:** M5 — The Shared World

#### Why
A squad's position is a list of waypoints, and where it is now is a pure function of that list
and the clock (GDD-WORLD §2). The server's scheduler (`ITEM-064`) and the client's map
(`ITEM-065`) must compute it with the same function. The prior art's
`../no-way-home/packages/shared/src/waypoint-utils.ts` (16 passing tests, no dependencies) is
sound maths with the wrong signatures for this project.

#### Change
1. **Tests first:** port its 16 tests into `tests/`, then the code into `src/core/`.
2. **Signatures:** the clock is injected (it reads `Date.now()` today); functions return new
   lists rather than mutating; no inline speed default — each leg's speed comes from mode and
   pace (on foot: cautious 3 km/h, normal 5 km/h, flat out 7 km/h, GDD-WORLD §3).
3. **Stable keys from day one:** every trip has a stable id and every checkpoint an
   index/expected-time key, because `ITEM-048` needs the encounter roll for (squad, trip,
   checkpoint) to be reproducible after the fact.
4. **Say what the maths is.** It interpolates linearly in latitude/longitude. That is fine at
   these scales but it is not a great-circle path; document it in the code and in GDD-WORLD
   rather than claiming great-circle.

#### Affected Files
- `src/core/` (a new travel module)
- `tests/` (the ported tests)
- `docs/design/gdd/world-and-travel.md`

#### P2P / Simulation Impact
- Headless and deterministic: no randomness, no DOM; the match stream is untouched.

#### Acceptance Criteria
- [ ] The 16 ported tests pass against an injected clock.
- [ ] No function mutates its input list or reads the wall clock.
- [ ] Every leg's speed is stated by mode and pace; there is no default speed.
- [ ] Trips and checkpoints carry stable keys.
- [ ] The linear lat/lng interpolation is documented as such.

#### Risks & Mitigations
- **Risk:** linear lat/lng drifts from the true path over long legs and near the poles.
- **Mitigation:** accepted at the distances travelled on foot; revisit if vehicles make
  continental legs common.

---

### [ITEM-063] A Squad Has a Position, and a Place to Start
**Type:** Feature
**Priority:** P2
**Status:** Ready — after `ITEM-060` (`request.cf` on the session) and `ITEM-062` (the waypoint
shape)
**Milestone:** M5 — The Shared World

#### Why
Nothing in the database says where a squad is. The user's decision (D2): a squad's position
lives in a new `squads` table — one row per player for now — not a column on `players`, so that
captives (`ITEM-054`), alien squads and several squads per player can have positions later.
Where a new player starts is GDD-WORLD §4 (ex-`ITEM-049`).

#### Change
1. **A migration for `squads`**: the squad's id, its player, and its waypoint list (the
   `ITEM-062` shape).
2. **Registration places the squad**: draw a point uniformly over the 50 km disc around the
   session's `request.cf` latitude/longitude (radius `R·√u`); redraw if it lands within 1 km of
   another player's start (D4); store only the drawn point, never the reported one.
3. **The fallback anchor** is Stuttgart centre, 48.7775, 9.18 (D3), used when Cloudflare reports
   no location and always on the Bun server.
4. **The draw uses system randomness**, never the match stream (AGENTS.md §2.3).
5. **An RPC method reads the squad** (position as waypoints), over `ITEM-060`'s socket.

#### Affected Files
- `src/server/db/migrations.ts` (the `squads` table)
- `src/server/Accounts.ts` (`register`: the start), `src/server/Persistence.ts`
- `src/server/Lobby.ts` (the read method)
- `docs/architecture/persistence.md`

#### P2P / Simulation Impact
- None on matches. The draw is setup randomness outside any match.

#### Acceptance Criteria
- [ ] A registration through Cloudflare stores a start within 50 km of the reported point, and
      the reported point is stored nowhere.
- [ ] A statistical test shows starts from one anchor spread uniformly over the disc, and no two
      starts within 1 km.
- [ ] Registration off Cloudflare (and on the Bun server) works through the Stuttgart anchor.
- [ ] The squad is readable over RPC.
- [ ] Living documentation updated (persistence: the table).

#### Risks & Mitigations
- **Risk:** a drawn start lands in the sea; the server has no land mask (D6, open).
- **Mitigation:** decided later, not here: accept sea starts or redraw against a coarse mask.
- **Risk:** every off-Cloudflare player starts near Stuttgart, so the 1 km redraw runs more often
  there as players accumulate.
- **Mitigation:** the 50 km disc holds thousands of 1 km-separated starts; cap the redraws and
  log if it is ever hit.
- **Risk:** IP geolocation can be far off (mobile carriers, VPNs).
- **Mitigation:** accepted. The start is meant to be roughly local, not exact.

---

### [ITEM-064] Orders, Pace and the Travel Scheduler
**Type:** Feature
**Priority:** P2
**Status:** Ready — after `ITEM-062` and `ITEM-063`
**Milestone:** M5 — The Shared World

#### Why
Travel runs on the wall clock and carries on while the player is away (GDD-WORLD §3). The match
server's Durable Object has one alarm, so something must keep every squad's next due moment and
arm the alarm for the earliest.

#### Change
1. **The five orders and three paces as RPC methods**: go here, go here now, go here first, go
   here next, stop; cautious, normal, flat out. The server validates and returns the new
   waypoint list.
2. **A scheduler of due moments**: it keeps "the next due moment per entity, of some kind" —
   not only arrivals, so `ITEM-053`'s planned meetings and `ITEM-048`'s checkpoints fit without
   a second mechanism. It arms the Durable Object's single alarm for the earliest, never more
   than an hour away; an arrival is recorded at its expected time, not when the alarm fired.
3. **Restart:** the schedule is rebuilt from `squads` and the alarm re-armed at startup, beside
   `lobby.restore()`.
4. **The Bun server's twin** drives the same scheduler with timers, through an injectable clock
   so tests drive time.
5. **Squad requests route through `ownerOf(squad)`**, which returns the single instance today.
   RFC-0002 §5 (point 1) calls the hard-coded singleton debt; this is the one seam `ITEM-046`
   replaces.
6. **Position changes are pushed** to the owner's socket (`ITEM-060`).

#### Affected Files
- `src/server/` (orders, a scheduler module, `ownerOf`), `src/server/Lobby.ts` (methods)
- `workers/MatchDurableObject.ts` (the alarm handler, re-arming at startup)
- `src/server/GameServer.ts` (the timer-driven twin)
- `docs/architecture/` (a world/travel section), `docs/architecture/deployment.md`

#### P2P / Simulation Impact
- None on matches. Travel orders are not match commands; they are RPC methods on the session
  socket, outside any room.

#### Acceptance Criteria
- [ ] All five orders and three paces change the waypoint list as GDD-WORLD §3 says.
- [ ] With a driven clock, a multi-hour trip arms alarms at most an hour apart and records the
      arrival at its expected time.
- [ ] After a restart the schedule is rebuilt and the alarm armed for the earliest due moment.
- [ ] The owner's socket receives a push when its squad's route changes or it arrives.
- [ ] Living documentation updated.

#### Risks & Mitigations
- **Risk:** the alarm handler and a socket request race on the same squad.
- **Mitigation:** a Durable Object runs one event at a time; the Bun twin serialises through the
  same scheduler.

---

### [ITEM-065] The Map Screen
**Type:** Feature
**Priority:** P2
**Status:** Ready — after `ITEM-061` and `ITEM-064`
**Milestone:** M5 — The Shared World

#### Why
The player has to see the squad on the map and give it orders. This is where M5's definition of
done is observed.

#### Change
1. **A new screen for signed-in players**, reached from the Match Server group; the lobby stays
   as it is.
2. **MapLibre loaded by dynamic import** only when the map opens, so the game's first load does
   not carry it.
3. **Mounted like the loadout root**: on `body`, outside `#ui`'s pointer rules, with the
   Three.js update loop paused behind it.
4. **The squad drawn by the same position function the server uses** (`ITEM-062`), moving
   between frames without asking the server.
5. **Orders on right-click** (the five verbs) and a pace control.
6. Written fresh against this project's state, not ported from the prior art's 888-line view.

#### Affected Files
- `src/hud/` (the map screen), `src/hud/menu/ServerPanel.tsx` (the way in), `src/main.tsx`
- `package.json` (`maplibre-gl`, `@protomaps/basemaps` or `protomaps-themes-base`)
- `docs/architecture/rendering.md`

#### P2P / Simulation Impact
- None. The map reads the squad over RPC and draws it with the shared position function.

#### Acceptance Criteria
- [ ] A squad sent on a long trip keeps travelling with the tab closed; on return it is where
      the clock says, and an arrival that happened while away is recorded at its expected time.
- [ ] A refresh mid-journey resumes without a jump.
- [ ] Tiles load cross-origin on GitHub Pages.
- [ ] MapLibre is not in the initial bundle.
- [ ] Living documentation updated.

#### Risks & Mitigations
- **Risk:** two render loops (Three.js and MapLibre) compete for the GPU.
- **Mitigation:** the Three.js update loop pauses while the map is open.

---

### [ITEM-066] Before Encounters: the Decisions ITEM-048 Needs
**Type:** Feature
**Priority:** P2
**Status:** Backlog — a design task (GDD edits, no code); next after the M5 build items; blocks
`ITEM-048`
**Milestone:** M5 — The Shared World

#### Why
`ITEM-048` assumes the server can start a fight on its own. Everything built for rooms so far
(`ITEM-058`, `ITEM-059`) assumes a human opens it, a human joins it and humans hold the seats.
These clashes have to be decided in the GDD before encounters are built, not discovered while
building them.

#### Change
Settle each in [GDD-WORLD](../design/gdd/world-and-travel.md) §5 (and the networking doc where
it is a protocol rule):
1. **Is an encounter the player's one match?** And what does the lobby panel's auto-resume do
   with a fight the player did not start?
2. **The join window vs the two-minute seat grace** (`GRACE_MS`): an encounter at 03:00 must not
   abort itself because nobody took the seat.
3. **A server-side way to create a room** for known players, with pre-seated seats and a
   header the server composes.
4. **An AI seat attached server-side** over a loopback transport, as `AiOpponent` does in the
   browser.
5. **Rosters marking travellers as away.** Today `Rosters.rest()` heals every non-deployed member
   after any settlement.
6. **`verifyRosters` is byte-exact**: if travel ever changes character state, it must still
   verify.
7. **Build pinning** of a room created before a deploy and joined after.
8. **The unreconciled seam** between RFC-0002 §2/§6.2 (crossing a boundary is a deliberate act)
   and GDD-WORLD's free straight-line travel: record it, and either reconcile it or state which
   one gives way.

#### Affected Files
- `docs/design/gdd/world-and-travel.md`
- `docs/design/rfc/0002-region-sharded-durable-objects.md` (the seam)
- `docs/architecture/networking.md` (where a decision is a protocol rule)

#### P2P / Simulation Impact
- None directly; it decides what `ITEM-048` may assume about the referee and the rosters.

#### Acceptance Criteria
- [ ] Each of the eight points has a recorded decision (or an explicit "not needed for the first
      encounter, because …") in the GDD.
- [ ] `ITEM-048`'s Change and Affected Files are updated to match.

#### Risks & Mitigations
- **Risk:** decisions made on paper miss what the code forces.
- **Mitigation:** each decision names the file and function it touches (`Room`, `Lobby`,
  `Rosters.rest`, `verifyRosters`), as this item's Change does.

---

### [ITEM-067] Closer Zooms on Demand
**Type:** Infrastructure
**Priority:** P3
**Status:** Backlog — deferred by the user's decision (2026-10-07)
**Milestone:** Unscheduled

#### Why
`ITEM-061` hosts the planet only at low zooms. Hosting it all is 138.7 GB (z0–15); most of it
would never be looked at. Building the closer zooms for an area the first time someone looks
there keeps storage to the places players are.

#### Change
Build high-zoom tiles for an area on its first request, from the Protomaps planet build by range
reads, cache them in R2, and deduplicate — likely a separate Worker, so that concurrent first
requests for the same area build it once.

Cost, from `ITEM-061`'s measurements: z0–11 alone is 8.0 GB and z0–12 18 GB for the whole
planet; R2 storage is $0.015/GB-month past the 10 GB-month free tier, so only populated regions
should ever be built.

Open questions:
- Which zooms are built on demand (to z15, the build's maximum?).
- Region granularity: what one build covers.
- Eviction: whether unvisited regions are ever removed.
- Addressing: how the low-zoom archive and the on-demand tiles are served under one MapLibre
  source.

#### Affected Files
- `workers/` (a tile-building Worker, or the tile route in `workers/index.ts`), `wrangler.jsonc`

#### P2P / Simulation Impact
- None.

#### Acceptance Criteria
- [ ] Designed (the open questions answered) before it is built.
- [ ] A first request for an unbuilt area builds and caches it once, under concurrent requests.

#### Risks & Mitigations
- **Risk:** the Protomaps build url is dated and rotates.
- **Mitigation:** pin a build per region, recorded beside the cached tiles.
