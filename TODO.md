# TODO / Backlog

> **Note:** The backlog and task tracking system is maintained in [`docs/backlog/active-backlog.md`](docs/backlog/active-backlog.md) following structured schemas and prioritization.

### Quick Links
- 📋 [Active Backlog](docs/backlog/active-backlog.md)
- 🏛️ [Architecture Decisions (ADRs)](docs/design/adr/README.md)
- 🚀 [Milestone Roadmap](docs/plans/roadmap.md)
- 🏃 [Current Sprint Plan](docs/plans/sprints/sprint-current.md)

---

### Historical Snapshot
- [x] [A. Narrow ports: get the rules layer off the render layer](#a-narrow-ports-get-the-rules-layer-off-the-render-layer)
- [x] [10. Balance harness](#10-balance-harness)
- [ ] [B. Finish the ECS split: data units, view units](#b-finish-the-ecs-split-data-units-view-units)
- [ ] [1. In-match progression](#1-in-match-progression)
- [ ] [2. Wounds as negative traits](#2-wounds-as-negative-traits)
- [ ] [3. Trait-bearing gear breadth](#3-trait-bearing-gear-breadth)
- [ ] [4. Enemy intel fog](#4-enemy-intel-fog)
- [ ] [5. Suppression and morale](#5-suppression-and-morale)
- [ ] [6. Exhaustion](#6-exhaustion)
- [ ] [7. Roles on the loadout screen](#7-roles-on-the-loadout-screen)
- [ ] [8. Overwatch and reaction fire](#8-overwatch-and-reaction-fire)
- [ ] [9. Campaign roster](#9-campaign-roster)

---

## A. Narrow ports: get the rules layer off the render layer

**Why.** The ECS already did its job on data — components are plain
serialisable state — but behaviour still leaks into graphics in three places:

| Seam | Evidence | Nature |
| --- | --- | --- |
| `Soldier extends Entity3D` | `src/entities/Soldier.ts:66`, `initGraphics():382`, material cloning `:399` | Identity, glTF and the animation mixer live in the same object as HP and AP |
| Resolvers call FX directly | `src/game/Combat.ts:109` takes `Tracers`, `:152` `spawnTracer`, `:154/208/209` `playShoot`/`playDeath`/`playHit`; same in `src/ecs/systems/CombatSystem.ts:33,93` | The rules layer imports the render layer |
| Match assembly needs the engine | `src/game/Squads.ts:78` `engine.world.add`, `src/game/Battlefield.ts:32,71` `engine.scene`, `TurnManager(…, rig)` wants an `OrbitRig` | A match cannot be built without a scene and a camera |

Two things that are *not* the problem, established by reading rather than
assuming:

- **Visibility is not raytraced.** `src/core/Visibility.ts` imports exactly
  `config` and `Grid`; line of sight is grid DDA marching, as is
  `src/core/Occlusion.ts`. The only `Raycaster` in the codebase is
  `InteractionController:57`, and it is pointer picking — screen to world, i.e.
  input. Visibility already runs headless.
- **three's maths is not rendering.** `three` appears in `core`/`ecs` only as
  `Vector3` (`Grid.tileToWorld`, `Grid.pathToWorldPoints`,
  `PositionComponent.targetPos`). `Vector3`, `Quaternion` and `MathUtils` are
  pure arithmetic and already run under `bun test` with no GL context; only
  `WebGLRenderer` needs a canvas. Keep using them — a bespoke vector type would
  be churn for nothing.

**Change.** Define two interfaces and hand them in:

- `Combatant` — what the resolvers actually read: hp, armor, statuses, weapon,
  ammo, tile, position, proficiency, evasion, crit props, `isDead`.
- `CombatFx` — what they currently reach into the renderer to do:
  `spawnTracer`, `shoot`, `hit`, `death`.

In a real match `Tracers` and `Soldier` implement them; headless, a no-op
implementation does. `TurnManager` takes a focus port rather than an
`OrbitRig`. `src/game/Combat.ts` and `src/ecs/systems/CombatSystem.ts` stop
importing from `src/render/` altogether.

**Cost and risk.** Four signature changes across `Combat.ts`,
`CombatSystem.ts`, `GrenadePlanner.ts` and `TurnManager.ts`. Strictly
behaviour-preserving, with the existing suite as the net. Low risk.

**Note.** This is a strict subset of item B's seam — `CombatFx` is precisely
what B's render system ends up implementing — so none of it is throwaway.

## 10. Balance harness

**Why.** Every gameplay item below is a balance change, and right now the only
way to check one is to drive the browser by hand and read numbers off the HUD.
That does not scale to "is the sniper's crit bias too strong", and it cannot
answer "did this refactor change the game" at all.

**Change.** A headless script that runs N seeded matches with a scripted AI on
both sides and reports:

- win rate by faction, and the spread across seeds;
- mean turns to a decision, and how often a match hits the turn cap;
- per weapon class: shots, hit rate, mean damage per shot, kills, crit rate;
- per trait: win rate of squads carrying it against squads that do not.

It runs on the pure layer — `MapGenerator`, `Grid`, `Pathfinding`,
`Visibility`, `Ballistics`, `Combat` — with the ports from item A supplying a
no-op FX implementation. It must never construct the HUD, the loadout screen,
`OffscreenPortraits` or `DebugMap`.

**Acceptance.** `bun run balance` prints a report for a default sweep, takes a
seed range and match count as arguments, and is deterministic: the same
arguments produce the same report, pinned by a test so the harness itself
cannot silently drift.

**Done.** `src/sim/` holds the runner (`SimUnit`, `SimMatch`, `Balance`);
`scripts/balance.ts` is the only part that knows about a terminal. 500 matches
run in about 7 seconds. Asymmetric sweeps are supported, because the useful
question is nearly always a comparison: `--blue=shotgun --red=sniper`,
`--redAmmo=ap`, `--blueVests=1`.

### What the first sweeps said

Recorded here because the gameplay items below are balance changes, and these
are the numbers they will move. All figures are the stock spread unless stated,
and every claim about a weapon or a trait was run with the sides swapped —
first move is worth several points, so a single-sided sweep cannot tell a good
gun from a good seat.

- **First move is worth roughly 5-10 points.** 500 stock mirror matches: blue
  292, red 184, 24 draws. Blue moves first.
- **Fights are short and bimodal.** Median 3.5 turns, mean 6.35, with a tail
  out to the cap. Balance work should assume a decision inside four turns.
- **The sniper rifle beats the shotgun about 7 times in 10**, sides swapped and
  averaged (174-98 one way, 222-60 the other). Not as one-sided as the range
  band suggests, but consistent.
- **The Nullweave Vest is worth nothing measurable.** 400 matches, same seeds,
  three ways: vests on blue 224 wins, vests on red 230, neither side 226. Every
  difference is inside the noise. Crits are a sixth of hits and the multiplier
  is 1.3-2.2, so removing them entirely is worth less than the 3 evasion the
  vest costs. Item 3 should treat this as a fault to fix, not a balance to
  keep.
- **Trait win rates are not yet separable.** Over 500 matches: nimble 56.7%,
  stoic 53.9%, juggernaut 49.5%, fleet 48.9%, on roughly 220 decisive matches
  each. That is within a couple of standard errors of even. Judging a trait
  needs paired seeds — the same map and the same squads, one trait swapped —
  which the harness does not do yet.

**Two things the harness itself caught, which is the point of building it:**

1. A first policy stopped advancing as soon as it *saw* an enemy. A shotgun
   reaches 12 m and sees 14, so shotgun squads froze just outside their own
   range and fired **no rounds at all** across 300 matches, while the report
   cheerfully showed a missing row.
2. Stopping at the first *legal* shot instead of a decent one had every weapon
   engaging at its longest reach. Fixing it moved the shotgun from 37% hits and
   22 damage a shot to 64% and 39 — the first number was measuring the
   instrument, not the gun.

**Still open.** Paired-seed trait comparison (above), and `CombatSystem` could
take a roster port so a simulation could use it directly rather than calling
`fireWeapon` itself. Neither blocks item B.

## B. Finish the ECS split: data units, view units

**Why.** With item A the rules no longer *call* graphics, but a unit is still a
graphics object: `Soldier` inherits `Entity3D`, so nothing can build a squad
without a scene. Five test suites (`camera`, `debugmap`, `movement`,
`pathmarker`, `shooting`) already install a canvas stub and hand-build
structural stand-ins — the tests are working around this seam today.

**Change.** `Soldier` becomes data-only over its components. A new
`SoldierView` owns the `Entity3D`, the animation mixer and the cloned
materials, driven by the existing `RenderSystem` reading
`PositionComponent`/`StanceComponent`/`HealthComponent`. `Squads` builds units
with no engine at all; a view factory attaches meshes only when there is a
scene to attach them to. `Battlefield` splits the same way: terrain data is
already pure (`MapGenerator`), terrain meshes are not.

**What it buys.** A full match that runs with no renderer: AI opponents,
deterministic replay from a seed plus a command log, the option of an
authoritative referee instead of trusting peers, far faster tests, and the
deletion of `installCanvasStub` from five suites.

**Cost and risk.** Touches `Soldier` (~495 lines), `Squads`, `Battlefield`,
`RenderSystem`, `main.ts`, and every site that reaches `soldier.position` or
`.rotation` through the `Entity3D` inheritance. Mechanically simple but broad.
The real risk is animation and yaw regressions, which are visual: they need
browser verification, not tests. Item 10 is the reason this is third — once a
whole match runs headless, "did the split change the game" is a measurable
question instead of an eyeball.

## 1. In-match progression

**Why.** Characters vary at deployment but never change during a fight, so
nothing a unit does accrues to it.

**Change.** Kills and assists grant XP; at a threshold the unit is promoted and
the player picks one perk from three. A perk is a `TraitId` appended to
`sheet.traits` followed by `refreshTraits()` — the whole mechanism already
exists.

**P2P.** The choice has to travel as a new `promote` command. Defensive perks
are already replicated through `TraitsComponent`; offensive ones need nothing,
because a shot's numbers are resolved by the sender and applied verbatim.

**Files.** New `src/core/Progression.ts`, a hook on
`CombatSystem.onShotResolved`, one HUD prompt.

**Caveat.** This puts player choice into the wire. The `Object.hasOwn` incident
during the RPG pass was exactly that class of bug, so it wants its own
sanitiser and regression pins rather than trusting the existing one.

## 2. Wounds as negative traits

**Why.** HP variation currently only decides how many shots a unit survives.
Crossing a threshold should cost something that persists.

**Change.** Dropping below 50% and 25% HP inflicts a lasting trait: `Winded`
(-2 AP), `Concussed` (-6 accuracy), `Limping` (movement cost x1.5). Reuses the
trait fold verbatim.

**Needs.** Two new `TraitEffects` fields — `moveCostMul`, and `apCostDelta` if
it should generalise beyond movement.

## 3. Trait-bearing gear breadth

**Why.** `ItemSpec.traits` and `passive` already work; the vest proved the
mechanism. What is missing is content.

**Change.** Mostly data: scope (accuracy that scales with range), bipod (bonus
while crouched), suppressor (no muzzle reveal, reduced crit), plate carrier
(+armour, -evasion). Each wants one new effect field, not new plumbing.

## 4. Enemy intel fog

**Why.** An enemy's exact evasion is visible the moment you aim at them. It is
mechanically necessary for an honest shot preview and narratively flat.

**Change.** Show the target's people-numbers as unknown until that unit has
acted or been shot at, then reveal them. HUD only — the data is already local.

**Note.** Argued for on taste rather than balance: it is what makes the sheets
read as people rather than stat blocks.

## 5. Suppression and morale

**Why.** A missed shot currently does nothing at all.

**Change.** Rounds that miss accumulate suppression on the target: an accuracy
penalty first, pinned at higher stacks. `STATUSES` already models accuracy,
defence and damage modifiers with per-turn decay, so this is a status plus a
hook in `executeShot` for the rounds that did *not* land.

## 6. Exhaustion

**Why.** Ties the "stamina" framing of AP to a cost instead of a ceiling.

**Change.** Spending every point two turns running leaves the unit `Winded` on
the next. Roughly thirty lines against the existing status machinery.

## 7. Roles on the loadout screen

**Why.** Every unit is currently interchangeable apart from its sheet.

**Change.** Medic, Scout and Marksman roles gate which crate rows a unit may
draw from, each with one role ability. Uses the existing `LOADOUT_LIMITS`
machinery; mostly UI and data.

## 8. Overwatch and reaction fire

**Why.** The biggest tactical lift available, and the natural consumer of
proficiency against evasion.

**Change.** A unit may hold its remaining AP to fire during the enemy's move.

**Cost.** Genuinely invasive. It interleaves resolution into the *enemy's*
turn, and under the "sender resolves, receiver replays" contract every reaction
must be authored by the reacting unit's owner and applied mid-path — so both
`MovementSystem` and the wire protocol are in scope. Worth doing properly, as
its own pass, not cheaply.

## 9. Campaign roster

**Why.** Squads are rolled per match and forgotten.

**Change.** Sheets persist in `localStorage` across matches, carrying XP and
untreated wounds; squads stop being rolled fresh. Needs a roster screen.

**Caveat.** This changes what the handshake means — a peer would be sending a
*saved* roster, so `sanitizeSheet` becomes load-bearing against your own stored
data as well as against a hostile peer. Own sanitiser, own pins.
