---
title: "Active Engineering & Gameplay Backlog"
id: "BACKLOG-ACTIVE"
type: "backlog"
status: "active"
lastReviewed: "2026-09-28"
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

### [ITEM-043] One Deployment Record Per Soldier, Not Parallel Lists
**Type:** Refactor  
**Priority:** P2  
**Status:** Ready — blocks `[ITEM-042]`  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
A squad crosses the wire as several same-length arrays matched by position only: `sheets`,
`loadouts`, `startingHp` on `RecordingHeader`; `sheets`, `loadout`, `hp` on `ready`. Nothing
ties their lengths together. `[ITEM-041]` was exactly that failure: `startingHpFrom` enforced
`length === SQUAD_SIZE` on its own array while `sheets` had already gone short, so a
short-handed side's HP was silently dropped rather than read. `[ITEM-042]` wants to add a
character id per soldier and `[ITEM-039]` wants to add fatigue; bolting each onto its own
parallel array would make five lists that all have to agree, with the same failure mode times
five.

#### Change
1. One shape, in `src/game/Recording.ts`:
   ```ts
   /** Session state for one deployed soldier: what a match starts them on top
    *  of their sheet. A bag on purpose — hp today, fatigue next (`ITEM-039`),
    *  room for whatever comes after without another wire shape. */
   interface DeploymentState {
     hp?: number
     fatigue?: number
   }
   interface Deployment {
     /** Present only for a kept roster (`ITEM-042`); absent for a rolled squad. */
     characterId?: string
     sheet: CharacterSheet
     loadout: UnitLoadout
     state?: DeploymentState
   }
   ```
2. `ready.squad: Deployment[]` replaces `ready.sheets` + `ready.loadout` + `ready.hp`.
   `RecordingHeader.squads: Record<Faction, Deployment[]>` replaces `sheets` + `loadouts` +
   `startingHp`.
3. One validator, `deploymentsFrom(raw, what)`, replaces `sheetsFrom`, `squadLoadoutFrom` and
   `startingHpFrom`: one length rule (1 to `SQUAD_SIZE`) enforced once, on the one array every
   field for a soldier actually lives in — a short squad cannot disagree with itself about how
   short it is.
4. Every reader moves from three positional arrays to one: `Squads`' constructor,
   `Referee.verifyRosters`, `NetworkManager`, `main.ts`, `SimMatch`, `MatchHost`,
   `MatchStore`, and the tests that build a header by hand.
5. `PROTOCOL_VERSION` 2 → 3, `RECORDING_VERSION` 4 → 5 — the wire shape moved, not what it
   means.

#### Affected Files
- `src/game/Recording.ts`, `src/game/NetworkManager.ts`, `src/game/Squads.ts`
- `src/main.ts`, `src/sim/SimMatch.ts`, `src/sim/MatchHost.ts`, `src/server/Referee.ts`,
  `src/server/MatchStore.ts`, `src/version.ts`
- `docs/schemas/wire-shape-catalog.json` (regenerated)

#### Acceptance Criteria
- [ ] No behaviour change: every existing test passes against the new shape, and
      `bun run balance` is byte-identical to before.
- [ ] `deploymentsFrom` refuses a squad of 0 or more than `SQUAD_SIZE`, and every other refusal
      `sheetsFrom`/`squadLoadoutFrom`/`startingHpFrom` made (unknown weapon, unknown sidearm,
      malformed HP) still fires, now from one place.
- [ ] A version-4 recording is refused with a stated reason, the same way a version-2 one is
      today.

---

### [ITEM-042] The Bench: a Roster Bigger Than the Squad
**Type:** Feature  
**Priority:** P2  
**Status:** Ready — pulled after `[ITEM-043]`, which it is built on  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
A roster is exactly a squad: four people, all of whom deploy every match. So "who fights" is
never a decision, and nothing that depends on *not* deploying someone — resting them, keeping
them out while they recover — can mean anything. `[ITEM-039]` is built on this item.

#### Change
1. **Roster size.** `ROSTER.size = 6` in `src/config.ts`, beside `SQUAD_SIZE = 4`. Six so that
   a steady rotation rests two a match and each character sits out one match in three.
   Registration deals six (`enlist`); `Rosters.recruit` fills the lowest empty slot of
   `0..ROSTER.size-1`. Existing accounts reach six by recruiting — free since `[ITEM-037]`.
2. **Picking the squad.** A signed-in player chooses 1 to `SQUAD_SIZE` distinct active members
   to deploy. The default pick is the first four in slot order. The squad index is the order
   picked; the roster slot is where the character lives, and the two stop being the same.
3. **On the wire.** `Deployment.characterId` (`[ITEM-043]`) is populated for a kept roster and
   absent for a rolled one. No new array, and nothing else to keep in step with it: the id sits
   next to the sheet and loadout it names. `PROTOCOL_VERSION` and `RECORDING_VERSION` already
   moved for `[ITEM-043]`; this item does not move them again.
4. **The referee** replaces "the squad is the active roster" with "the squad is these stated
   members of the active roster": every id belongs to this player and is active, none repeats,
   there are 1 to `SQUAD_SIZE` of them, and the header's sheets and starting HP are exactly
   those members', in the stated order. Settlement writes fates to the stated ids.
5. **Rest heals.** At every settled match of a player, each active member who did *not*
   deploy heals by the same rule a survivor does (`HEALING.perMatch` of missing HP, scaled by
   `healBonus`) and does not count a match.
6. **A roster screen** before the loadout screen, for signed-in players only: every active
   member with HP, sheet summary and slot; toggle who deploys (at most four); a Recruit button
   on each empty slot (`POST /api/roster/recruit` — which also closes `[ITEM-037]`'s missing
   UI). Continue goes to the loadout screen with the picked sheets.

#### Affected Files
- `src/config.ts`, `src/server/Rosters.ts`, `src/server/Referee.ts`, `src/server/Accounts.ts`
- `src/game/NetworkManager.ts`, `src/game/Recording.ts`, `src/game/Account.ts`
- `src/main.ts`, a new `src/hud/RosterScreen.ts`, `src/game.css`
- `docs/schemas/wire-shape-catalog.json` (regenerated)

#### Acceptance Criteria
- [ ] Registration deals six; recruiting fills up to six and refuses a seventh.
- [ ] A signed-in player deploys any 1–4 distinct active members, and the refereed match
      settles exactly those — tested with a pick that is *not* the first four slots.
- [ ] The referee aborts a stated id that is not this player's, is dead, repeats, is a fifth, or
      whose sheet or HP differs from the header's at that position.
- [ ] A benched member heals by the survivor rule and does not count the match; a deployed one
      is settled exactly as today.
- [ ] In a browser against `bun run serve:match`: pick four of six, recruit into an empty slot,
      deploy, and the match plays with the picked four.
- [ ] No rules change: `bun run balance` is identical (the sweep has no roster).

#### Risks
- **Callsigns are positional.** In-match names come from `FACTION_INFO.squadNames[index]`, so
  whoever is picked first is always "Cobalt". Kept for this item — they are callsigns — but the
  roster screen must identify people by their sheet and slot, not by callsign.

---

### [ITEM-039] Fatigue & Medical-Bay Downtime
**Type:** Feature  
**Priority:** P2  
**Status:** Ready — pulled after `[ITEM-042]`, which it is built on  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Split out of `[ITEM-038]` at 2026-09-26: [GDD §5](../design/gdd/progression-and-meta.md) also
wants "fatigue over consecutive deployments" that temporarily lowers baseline AP and morale, and
"medical-bay downtime" for severe injury. Both only mean something once a player can choose
not to deploy somebody, which is `[ITEM-042]`.

#### Change
1. **Stored.** Migration 5 adds `roster.fatigue` (0–4) and `roster.downtime` (≥ 0), both
   integers defaulting to 0. These are the only stored numbers; AP and morale are derived from
   `fatigue` when a unit is built, never stored beside it.
2. **Settling**, per settled match of the player:
   - deployed: `fatigue + 1`, capped at 4;
   - not deployed: `fatigue − 2` and `downtime − 1`, both floored at 0;
   - carried out: `downtime = 2`; survived on HP at or below `WOUNDS.concussed` of their
     ceiling: `downtime = 1`.
3. **Penalty**, from the stored level at deployment: `max(0, fatigue − 1)` steps, each −1 max
   AP and −10 starting morale. So the first back-to-back match is free, and the same four
   fielded four matches running deploy on the fifth at −3 AP and 70 morale — still above
   `MORALE.steady` (50), so nobody breaks on turn one, and the +5 per turn rally wins it back.
   A six-character rotation (each resting one match in three) never passes one step.
4. **Where it is read.** `Soldier` takes a starting fatigue the way it takes a starting HP. The
   AP step is one more term in `refreshTraits`' `maxAp` sum — so every reader of `maxAp` sees it
   and Strength's `gearRelief` does not touch it — and `MoraleComponent` starts at
   `MORALE.max − 10 × steps`.
5. **Medical bay.** A member with `downtime > 0` cannot be picked: the roster screen greys them
   with the matches left, and the referee refuses them. They heal as a benched member meanwhile.
6. **On the wire**, in `Deployment.state.fatigue` (`[ITEM-043]`), beside `state.hp`. No new
   array and no version bump of its own: the bag exists precisely so this is the change. The
   referee checks it against the roster the same way it already checks `state.hp`.
7. **Measured.** `SquadPlan.fatigue` and `bun run balance -- --blueFatigue=N` (every unit at
   level N). Calibrated against a man down (`--blueSize=3`: Blue 55 → 34 wins, `[ITEM-041]`):
   level 4 must cost between half a man down and a whole one (10–21 points), so fielding a
   worn-out fourth against fielding three is a real choice; level 2 must cost at most 5. If the
   numbers in 3 miss those bands, the per-step AP and morale move, not the bands.

#### Affected Files
- `src/server/Rosters.ts`, `src/server/Referee.ts`, `src/server/db/migrations.ts`
- `src/entities/Soldier.ts`, `src/game/Squads.ts`, `src/config.ts`
- `src/hud/RosterScreen.ts` (from `[ITEM-042]`), `src/sim/SimMatch.ts`, `scripts/balance.ts`

#### Acceptance Criteria
- [ ] Settling moves `fatigue` and `downtime` exactly as in 2, including the caps and floors.
- [ ] A unit deployed at level N has its sheet's max AP minus `max(0, N − 1)` and starting
      morale `100 − 10 × max(0, N − 1)`, on both peers and the referee (digest agrees).
- [ ] A member in the medical bay cannot be picked, and the referee aborts a header that
      deploys one.
- [ ] The referee aborts a stated fatigue that differs from the roster's.
- [ ] `bun run balance -- --blueFatigue=4` costs Blue 10–21 wins in 100 and `--blueFatigue=2`
      at most 5, with the measured numbers recorded; `bun run balance` without the flag is
      identical.
