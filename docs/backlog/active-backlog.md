---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
lastReviewed: "2026-09-24"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/README.md"
  - "docs/backlog/completed.md"
  - "docs/plans/active-focus.md"
  - "docs/plans/roadmap.md"
tags: ["backlog", "tasks", "active"]
---

# Active Backlog

**The specification of every open item** — why it is wanted, what changes, and how we will know
it is done. It is not ordered and says nothing about what happens next: that is the
[focus board](../plans/active-focus.md). Finished and rejected items move to the
[archive](./completed.md).

---

### [ITEM-004] After-Match Progression & the End Screen
**Type:** Feature  
**Priority:** P1  
**Status:** In Progress  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Characters vary at deployment but never change, so nothing a unit does accrues to it. Rewritten
with the user on 2026-09-25: **progression happens after the match, not during it**. Inside a
match the character layer that moves is morale (ITEM-014), and it stays that way. A match that
ends has to be *seen* to end, too — today nothing happens when a side is wiped out.

#### Change
1. **A service record per unit**, kept by the rules while the match is played: rounds landed and
   criticals with each weapon class, kills, damage taken, attacks landed on a target that did not
   see them coming, turns spent to the last point without being winded, blows landed, doors
   forced, tiles walked in heavy kit, advanced kit used. A replicated, digested component
   (`DeedsComponent`), written by the rules on both peers from the same commands — like morale —
   so a peer, a replay and the referee all hold the same record, and a rewind puts it back.
2. **Growth, after the match** (`core/Progression`, pure): the winning side's survivors turn their
   record into growth, per [GDD §4](../design/gdd/progression-and-meta.md): a weapon class's
   proficiency from hits and crits with it; Health from damage taken and lived through; Agility
   from hitting the unaware or from behind, and from turns spent to the last point short of
   `Winded`; Strength from melee, doors forced and heavy kit carried; Intelligence from advanced
   kit used well. Intelligence speeds all of it. At most one point per attribute per match, capped
   at the scale's top. Growth writes `sheet.attributes` and `sheet.proficiency`, so every derived
   number follows from `derive()`.
3. **Who grows**: the winning side's survivors. The dead do not (what dying costs is
   `ITEM-012`'s permadeath); the losing side's survivors do not in this pass. Nothing about growth
   travels: both peers derive it from state they both hold.
4. **The end screen**: when a side has nobody standing, the match ends. In a local match the
   loser gets a plain "you lost" screen, then the winner sees each surviving unit's growth —
   what changed, from what to what, and which deeds earned it. Online, each side sees its own.
5. **Thresholds measured, not guessed**: the sweep reports the survivors' records and the growth
   they come to, per match, before the numbers are set.

Out of scope: persistence — growth is shown and then lost until `ITEM-012`, which comes next —
and the promotion perk draft, which the GDD's learn-by-doing replaces.

#### Affected Files
- `src/core/Progression.ts` (new), `src/ecs/components/DeedsComponent.ts` (new)
- `src/ecs/systems/CombatSystem.ts`, `src/ecs/systems/CommandSystem.ts`
- `src/hud/` (end screen), `src/game/InteractionController.ts`
- `src/sim/Balance.ts`, `src/sim/SimMatch.ts`

#### Acceptance Criteria
- [ ] Both peers, and a replay, hold the same service record for every unit (digested).
- [ ] Growth is a pure function of the sheet and the record; each change names the deeds behind
      it; nobody goes past the top of a scale or gains more than a point of an attribute a match.
- [ ] When one side is wiped out the match ends: the loser sees "you lost", the winner each
      survivor's growth (checked in the browser, hot seat).
- [ ] The sweep reports records and growth per match, and the thresholds are set from it.

---

### [ITEM-010] Roles on the Loadout Screen
**Type:** Feature  
**Priority:** P2  
**Status:** Ready  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Every unit is currently interchangeable apart from its generated character sheet.

#### Change
Medic, Scout, and Marksman roles gate which crate rows a unit may draw equipment from, each providing one unique role ability. Uses existing `LOADOUT_LIMITS` machinery.

#### Affected Files
- `src/hud/LoadoutScreen.ts`
- `src/game/Loadout.ts`

---

### [ITEM-012] Permadeath, Lasting Wounds & Campaign Roster Persistence
**Type:** Feature  
**Priority:** P2  
**Status:** Ready  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Squads are rolled randomly per match and forgotten upon exit — and per
[RFC-0001](../design/rfc/0001-referee-and-transports.md) §9, persistence is the foundation the
rest of the GDD stands on rather than a feature bolted onto combat. Base building, the economy
and a campaign roster all need a store of record before any of them can begin.

#### Change
A store of record for rosters and for **matches as event logs**, not a save file.

1. `localStorage` is the offline and demo store, not the store of record. Once a server exists
   the roster lives there, and the handshake stops carrying saved sheets at all — which
   *simplifies* the trust story rather than complicating it: a peer cannot send a tampered
   roster if it does not send one.
2. A match is stored as its intent log (`ITEM-023`), so what persists is what happened rather
   than a summary of it. Replaying a log is how a roster is derived, how a crashed client
   rejoins (`ITEM-025`) and how a disputed match is audited — one artefact, three uses.
3. Character sheets carry XP, promotions and untreated wounds across matches.

Also the rest of [GDD §5](../design/gdd/progression-and-meta.md), which only means anything
once a roster outlives a match and is therefore filed here rather than as its own item:
1. **Permadeath**: a unit that ends a match at `hp <= 0` without triage leaves the roster for
   good. In-match death is already just `hp <= 0` in a component — this is about what the
   post-match write does with it.
2. **Lasting wounds**: severe injury books medical-bay time between missions, and fatigue over
   consecutive deployments temporarily lowers baseline AP and morale. Distinct from the
   in-match wounds in `ITEM-005`, which are derived from current health and heal with it;
   these outlive the match and have to be stored, which is the first modifier that does.
3. Scars, combat logs and organic stat growth (`ITEM-004`) stored alongside the sheet. Growth
   lands in `sheet.attributes`, so what persists is four ints per character, not a stat block.

#### Caveat
In the serverless modes this changes what the handshake means: peers would send *saved*
rosters, making `sanitizeSheet` load-bearing against local tampering as well as a hostile peer.
With a server it goes the other way — nobody sends a roster.

Depends on `ITEM-022`: a stored log that cannot be replayed deterministically is not a store of
record, it is a diary.

#### Affected Files
- `src/core/Characters.ts`
- `src/game/Recording.ts`
- `src/game/NetworkManager.ts`
- `src/hud/LoadoutScreen.ts`

---

### [ITEM-028] Log and Store Schema Drift Guard
**Type:** Infrastructure  
**Priority:** P2  
**Status:** Ready  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
[RFC-0001](../design/rfc/0001-referee-and-transports.md) §9: once a roster is derived from a
stored log, the log is a schema, not a debug dump. Both versions exist and are enforced —
`RECORDING_VERSION` (2) refuses a recording from another format, `STORE_VERSION` (1) refuses a
store file from another schema (`tests/recording.test.ts`, `tests/store.test.ts`) — but nothing
makes anybody bump them. A command or a replicated component can change shape, every test stays
green, and a stored match silently stops replaying. Referenced from ADR-0004 and RFC-0001; had
no entry here until 2026-09-24.

#### Change
1. A guard, in the same spirit as `bun run docs:catalog --check`: the serialised shape of every
   command type and every replicated component, written down in the repo and checked in CI.
2. A shape change fails the check until the version it belongs to moves with it and the
   written shape is regenerated — so a change to the format is a decision, never an accident.
3. Pairs with `ITEM-012`: do it before the first roster is written from a log.

#### Affected Files
- `src/game/Recording.ts`, `src/server/MatchStore.ts`
- `src/ecs/components/*`, `src/ecs/systems/CommandSystem.ts` (the shapes being guarded)
- a new check script and its CI step

#### Acceptance Criteria
- [ ] Adding, removing or renaming a field of a command or replicated component fails CI until
      the matching version is bumped and the recorded shape regenerated.
- [ ] A change that does not touch a shape passes untouched.
