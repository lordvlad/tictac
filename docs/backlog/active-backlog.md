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
   good — except the one of a losing side carried out alive (`carriedOut`, ITEM-035), who goes
   back on the roster with 1 HP and nothing learned. In-match death is already just `hp <= 0` in
   a component — this is about what the post-match write does with it.
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
