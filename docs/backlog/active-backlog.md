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
- `src/server/Referee.ts` (`verifyRosters`)
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

### [ITEM-048] Wild Alien Encounters: a Fresh AI Squad per Fight
**Type:** Feature
**Priority:** P2
**Status:** Backlog — designed ([GDD-OVERVIEW](../design/gdd/overview.md) §2, §4); not started
**Milestone:** Unscheduled

#### Why
Humans are the only playable faction at the start; the aliens are run by the game and have no
persistent identity (GDD-OVERVIEW §2). Meeting them is a wild encounter: a random alien squad,
rolled fresh for the fight, at a random place, gone once the fight is settled. Today there is
no way to fight the game at all — the live client never imports `src/sim/`, and the only AI,
`SimMatch`'s policy, plays both sides of a headless sweep. Every live match needs two humans.

Most of this is startable before the shared world exists: "a random place" is today's
`generateMap(seed)`; what the world map adds later is *where* the encounter happens, not what it
is.

#### Change
1. **The AI plays one side of a live, refereed match.** The referee hosts the alien side and
   issues its commands as intents, the same commands a human sends. Not the human's client: a
   client that drives its own opponent can make it play badly. `SimMatch`'s policy is the
   starting point; whether it is reused as-is or split into a policy usable outside the sweep is
   this item's to decide.
2. **The alien squad is rolled, not stored.** Sheets and kit are dealt from system randomness
   at encounter start (setup, like `enlist`), stated in the header like any squad, and never
   written to `roster`. Settlement treats the alien side the way `Referee.verifyRosters` already
   treats an anonymous one: nothing to keep.
3. **The human side settles normally**: growth, HP, fatigue, permadeath, carried-out.
4. **The encounter sizes the alien squad.** Within today's `1..SQUAD_SIZE` (short-handed squads
   already deploy and settle, `ITEM-041`), so this does not wait for `ITEM-047`. Once
   `ITEM-047` lands, the encounter is the caller that states a per-combat cap — the one its
   Risks section says must exist before the cap is worth building.

#### Affected Files
- `src/server/Referee.ts` (hosting an AI side; settling a side with no roster)
- `src/sim/SimMatch.ts`, `src/sim/Tactics.ts` (policy usable for one side of a live match)
- `src/game/Recording.ts` (header records the AI side as rolled, not rostered)
- `src/hud/` (a way to start an encounter)
- `docs/architecture/networking.md`, `docs/architecture/persistence.md`

#### P2P / Simulation Impact
- **The AI's own choices are intent, not rules.** It may take its own randomness to decide, but
  it must never draw from the match stream (`matchDice(seed)`): only the rules draw there, the
  same order on every side (ADR-0004, `tests/determinism.test.ts`).
- A recording replays from commands, so an AI match replays without the AI.
- The balance sweep is unchanged; it already plays AI against AI.

#### Acceptance Criteria
- [ ] A signed-in player starts an encounter and plays a whole match against an AI-run squad
      through the referee, to settlement.
- [ ] The human side's roster settles exactly as in a match against a human; nothing about the
      alien squad is written to `roster`.
- [ ] Two encounters roll different alien squads; the same recording replays identically.
- [ ] `tests/determinism.test.ts` still passes: the AI draws nothing from the match stream.
- [ ] Living documentation updated.

#### Risks & Mitigations
- **Risk:** the aliens are a faction in the lore only. There is no alien kit (no plasma weapon
  exists in `src/`) and `Faction` is Blue/Red, so the first encounters are an AI squad dressed
  as aliens with human kit.
- **Mitigation:** ship the encounter with existing kit and file alien kit separately; the
  encounter does not depend on what the squad carries.
- **Risk:** the sweep policy was written to measure balance, not to be fun to fight; it never
  sneaks, throws smoke or uses doors (focus board, "Left open").
- **Mitigation:** accept it for the first encounters; make the policy better as its own item.

---

### [ITEM-049] Start Location From the Player's Real-World Area
**Type:** Feature
**Priority:** P3
**Status:** Backlog — designed ([GDD-OVERVIEW](../design/gdd/overview.md) §3); not startable yet
**Milestone:** Unscheduled — gated on the shared world existing

#### Why
A player starts near where they are (GDD-OVERVIEW §3): at a random point within 50 km of the
latitude and longitude Cloudflare reports for their connection. There is no world map to place
them on today, so this waits for the shared world, as `ITEM-046` does.

#### Change
1. On registration, read `request.cf.latitude`/`longitude` (strings in
   `@cloudflare/workers-types`; absent off Cloudflare, e.g. `bun run serve:match`).
2. Draw a point uniformly over the 50 km disc: radius `R·√u`, not `R·u`, which would crowd starts
   toward the centre. System randomness — setup, not rules.
3. Redraw while the point is within a minimum distance of an existing start.
4. Store only the drawn point as the squad's position (RFC-0002 §4); never the reported one.
5. A fallback when Cloudflare reports nothing.

#### Affected Files
- `src/server/Accounts.ts` (`register`)
- `workers/MatchDurableObject.ts` (passing `request.cf` through)
- The shared world's position store, once it exists

#### P2P / Simulation Impact
- None: the start point is set once, on the server, outside any match.

#### Acceptance Criteria
- [ ] A player registering through Cloudflare starts within 50 km of the reported point; the
      reported point is stored nowhere.
- [ ] Starts drawn from one anchor are spread uniformly over the disc (statistical test over many
      draws) and none is closer to another than the minimum distance.
- [ ] Registration off Cloudflare still works, through the fallback.

#### Risks & Mitigations
- **Risk:** the disc is drawn on the real map, so a coastal city's start can land in the sea.
- **Mitigation:** redraw off land as well as too close to another start; needs land data the
  world map will have to carry anyway.
- **Risk:** IP geolocation can be far off (mobile carriers, VPNs).
- **Mitigation:** accepted. The start is meant to be roughly local, not exact.
