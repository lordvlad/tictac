---
title: "Completed Work Archive"
id: "BACKLOG-COMPLETED"
type: "backlog"
status: "active"
lastReviewed: "2026-10-07"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/README.md"
  - "docs/design/adr/0001-ecs-render-decoupling.md"
  - "docs/design/adr/0002-deterministic-headless-balance-harness.md"
tags: ["archive", "completed", "history"]
---

# Completed Work Archive

Closed items: everything delivered, with what was built, what was measured and which
acceptance criteria stayed open — then, at the end, items rejected on purpose. Open work is
specified in the [active backlog](./active-backlog.md); what gets pulled next is the
[focus board](../plans/active-focus.md).

---

### [ITEM-001] Narrow Ports: Decouple Rules Layer from Render Layer
**Completed Date:** 2026-09-14  
**Type:** Architecture / Refactor  
**Milestone:** M1 — Headless Foundation  

#### Why
The ECS already did its job on data — components are plain serializable state — but behavior still leaked into graphics across three primary seams:

| Seam | Evidence | Nature |
| --- | --- | --- |
| `Soldier extends Entity3D` | `src/entities/Soldier.ts:66`, `initGraphics():382`, material cloning `:399` | Identity, glTF and the animation mixer lived in the same object as HP and AP |
| Resolvers call FX directly | `src/game/Combat.ts:109` takes `Tracers`, `:152` `spawnTracer`, `:154/208/209` `playShoot`/`playDeath`/`playHit`; same in `src/ecs/systems/CombatSystem.ts:33,93` | The rules layer imported the render layer |
| Match assembly needs the engine | `src/game/Squads.ts:78` `engine.world.add`, `src/game/Battlefield.ts:32,71` `engine.scene`, `TurnManager(…, rig)` wants an `OrbitRig` | A match could not be built without a scene and a camera |

#### Non-Problems Identified
- **Visibility is not raytraced**: `src/core/Visibility.ts` imports only `config` and `Grid`; line of sight is grid DDA marching, as is `src/core/Occlusion.ts`. The only `Raycaster` is `InteractionController:57` (screen-to-world pointer picking). Visibility already ran headless.
- **Three.js math is not rendering**: `three` appears in `core`/`ecs` only as `Vector3` (`Grid.tileToWorld`, `Grid.pathToWorldPoints`, `PositionComponent.targetPos`). `Vector3`, `Quaternion`, and `MathUtils` are pure arithmetic and execute under `bun test` with no GL context.

#### Key Changes
- Defined `Combatant` interface (`src/core/Combatant.ts`) representing what resolvers read: hp, armor, statuses, weapon, ammo, tile, position, proficiency, evasion, crit props, `isDead`.
- Defined `CombatFx` interface representing render effects: `spawnTracer`, `shoot`, `hit`, `death`. In real matches `Tracers` and `Soldier` implement them; headless, a no-op implementation does.
- `TurnManager` takes a camera focus port rather than a direct `OrbitRig`.
- `src/game/Combat.ts` and `src/ecs/systems/CombatSystem.ts` stopped importing from `src/render/` altogether.

---

### [ITEM-002] Deterministic Headless Balance Harness
**Completed Date:** 2026-09-14  
**Type:** Infrastructure / Tooling  
**Milestone:** M1 — Headless Foundation  

#### Why
Every gameplay tuning item is a balance change. Previously, the only way to check one was driving the browser by hand and reading numbers off the HUD, which did not scale to evaluating weapon biases or verifying refactors.

#### Key Changes
- Built headless simulation runner in `src/sim/` (`SimUnit.ts`, `SimMatch.ts`, `Balance.ts`). Runs on the pure layer (`MapGenerator`, `Grid`, `Pathfinding`, `Visibility`, `Ballistics`, `Combat`) with no HUD or canvas construction.
- Created CLI tool `scripts/balance.ts` for statistical reporting. 500 matches run in ~7 seconds under Bun.
- Pinned baseline balance outputs with automated test `tests/balance.test.ts`.

#### Initial Balance Findings (Baseline Sweep)
All figures are stock spread with sides swapped to account for first-move bias:
- **First move advantage is roughly 5–10 points**: 500 stock mirror matches: blue 292, red 184, 24 draws (blue moves first).
- **Fights are short and bimodal**: Median 3.5 turns, mean 6.35, with a tail out to turn cap.
- **Sniper rifle beats shotgun ~7 times in 10**: Sides swapped and averaged (174–98 one way, 222–60 the other).
- **Nullweave Vest provides zero measurable value**: 400 matches across seeds: vests on blue 224 wins, vests on red 230, neither 226. Crits are 1/6th of hits (multiplier 1.3–2.2), so removing crits is worth less than the 3 evasion the vest costs.
- **Trait win rates were not initially separable**: Over 500 matches: nimble 56.7%, stoic 53.9%, juggernaut 49.5%, fleet 48.9%. Requires paired-seed evaluation.

#### Regressions Caught by the Harness
1. **Shotgun Squad Freeze**: An initial AI policy stopped advancing as soon as it saw an enemy. Since a shotgun reaches 12m and sees 14m, shotgun squads froze outside range and fired zero rounds across 300 matches.
2. **First Legal vs Decent Shot**: Stopping at the first legal shot caused weapons to engage at max falloff. Fixing it moved shotguns from 37% hits / 22 dmg to 64% hits / 39 dmg.

#### Open Items
- Paired-seed trait comparison.
- `CombatSystem` roster port for direct simulation use rather than calling `fireWeapon` directly.

---

### [ITEM-003] Complete ECS Split: Data Units vs View Units
**Completed Date:** 2026-09-15  
**Type:** Refactor / Architecture  
**Milestone:** M1 — Headless Foundation  

#### Why
`ITEM-001` stopped the rules *calling* graphics, but a unit still *was* graphics: `Soldier` inherited `Entity3D`, carrying hit points, action points, stance and gear in the same object as a mesh, a skeleton and an animation mixer. A squad could not exist without a scene to stand in, and five test suites installed a canvas stub with hand-built structural stand-ins to work around it.

#### Key Changes
- `Soldier` is state over its components, with no `Entity3D` and no `three` types beyond `Vector3`.
- `SoldierView` (`src/render/SoldierView.ts`) owns the mesh, the mixer, the cloned per-soldier materials and the smoothed transform. Strictly a reader: it decides nothing.
- `SquadViews` (`src/render/SquadViews.ts`) builds the bodies and is the only way back from a unit to its own, resolving by identity rather than holding both halves.
- `RenderSystem` drives views rather than units, so component state remains the single source of animation.
- `Squads` takes no engine. `Battlefield` takes a `GeneratedMap` instead of generating one — which was the whole of the planned terrain split: `GeneratedMap` was already the data type and `Battlefield` was already only its view.

#### Three Findings Beyond the Split
1. **Unit visibility was living on the mesh.** Fog of war wrote `instance.visible` and the planners read it back, so "can I shoot that" was a question about the renderer and unanswerable without one. It is `SightedComponent` now, mirrored onto the mesh by the view. Costs one frame of latency where there was none (~16 ms).
2. **`CombatFx.death` was redundant and is removed.** A corpse is `hp <= 0` in a component, so the view collapses on seeing it. It had been announced *and* derived, playing the death clip twice per kill (observed live as two calls; now one). Supersedes the `CombatFx` surface recorded under `ITEM-001`. A peer's death now animates off replicated state rather than off a message.
3. **The canvas stub turned out to be load-bearing in more suites than expected — and hid an order dependency.** Dropping it from `movement`, `shooting` and `pathmarker` left the full run green, because `camera` and `debugmap` install it globally and happened to run first. Each of those three constructs canvas-backed textures (`PathMarker`, `ShootPlanner`) and genuinely needs it, so each installs its own now. CI runs files in a different order and caught it; `bun test <file>` per suite is the check that reproduces it.

#### Verification
- **Parity, not eyeballs** — the reason `ITEM-002` came first. 200 matches at seed 1 produce a byte-identical report before and after the split, re-checked after each follow-up change.
- **Browser** — bodies and portraits render; the run clip plays while moving and idle at rest; the body trails the unit by 0.12 m mid-stride and converges to 0; a click still resolves to the unit behind the mesh; all four enemies sit hidden under fog; a kill leaves a corpse holding its final frame.
- **`tests/headless.test.ts`** pins the payoff with no canvas stub in the file: a squad deploys with no engine and no glTF, its state is visible in components where replication can see it, a shot resolves with nobody to draw it, fog is state, and dying stops a unit where it stands. If that file ever needs the stub back, graphics have leaked into the rules again.

#### Acceptance Criteria
- [x] `Soldier` has no references to `three` rendering types (except pure vector math) or `Entity3D`.
- [x] Squads and battlefields instantiate headless in test suites without `installCanvasStub` — demonstrated by `tests/headless.test.ts`, which installs nothing. Suites that exercise render code (`camera`, `debugmap`, `movement`, `shooting`, `pathmarker`) still install it, each for itself.
- [x] Visual sanity: unit animations, crouching, facing angles, and yaw transitions verified in browser.
- [x] Full test suite passes (`bun test`) — 241 pass, `tsc` clean.

**Do not remove `installCanvasStub`** from `movement`, `camera`, `pathmarker`, `shooting` or
`debugmap` (once filed as ITEM-003.4, then struck). It was tried and broke CI (run #87): those
suites build canvas-backed textures through `PathMarker` and `ShootPlanner`, and passed locally
only because another file had installed the stub first.

---

### [ITEM-009] Exhaustion & Fatigue
**Completed Date:** 2026-09-15  
**Type:** Feature  
**Milestone:** M3 — Reconnaissance & Fog  

#### Why
Action points were a ceiling and nothing else: spending all twelve every turn cost exactly as much as spending none.

#### Key Changes
- `StatusKind.Winded` at -25% points, applied after `RULES.exhaustionTurns` (2) consecutive turns of spending the lot.
- `ActionPointsComponent` counts `spentThisTurn` and `exhaustedTurns`, both replicated — a peer has to agree about who is winded. Spending is tallied in the one setter every action deducts through; forfeiting a turn writes the component directly and so does not count as effort, because `endUnitTurn` hands a unit nothing remaining without it having run anywhere.
- `settleTurn` (`src/game/Turn.ts`) is now the turn boundary for the match *and* the simulation, on the same reasoning as `fireWeapon`. Order is load-bearing: exhaustion is judged on the side going out, then statuses tick, so a penalty earned this handover is already counting down. Winded lasts three ticks for that reason, leaving two.
- `effectiveMaxAp` floors at one point: a unit with nothing could not even end its own turn deliberately.
- **Statuses were invisible.** Squad cards now carry a chip per status with its effect and remaining turns in the tooltip, coloured by whether it helps rather than by a per-kind list.

#### Measured
Over 200 matches, 59 end with somebody winded and 74 units have been — about a third of fights, without dominating them. Draws fell 15 to 12, mean length 6.34 to 5.89 turns; per-weapon hit rates and kills moved under a point.

---

### [ITEM-008] Suppression & Morale Mechanics
**Completed Date:** 2026-09-15  
**Type:** Feature  
**Milestone:** M3 — Reconnaissance & Fog  

#### Why
A round that went past did nothing whatsoever, which made volume of fire pointless and a 30% shot strictly worse than not shooting at all.

#### Key Changes
- `StatusState` gains `stacks`; every numeric effect in a `StatusSpec` is per stack, and each spec declares `maxStacks` (1 for everything that already existed — a second flash in the same turn is still one flash).
- `StatusKind.Suppressed`: -12 to hit and -10% points per stack, up to three. There is no separate pinned state because the degree *is* the difference: -36 to hit with a third of a unit's points gone is being pinned.
- `stacks` is optional, read through `statusStacks`, which treats absent as one — statuses cross the wire, and a peer omitting the count must mean one rather than none. `StatusesComponent` normalises on the way out so a round trip is idempotent.
- Suppression is derived, never sent: `executeShot` counts rounds that went past, `replayShot` counts false entries in the rolls it was given. No message grew.
- `ItemSystem`, the debug panel and the grenade path all now apply statuses through `applyStatus` rather than by hand, so stacking could not diverge three ways.

#### Measured
Over 200 matches, 37 end with somebody suppressed, peak three stacks. Hit rates fell about a point and a half (rifle 90.2% → 88.4%, sniper 72.7% → 71.1%) and fights lengthened (mean 5.89 → 6.48 turns, draws 12 → 15).

---

### [ITEM-005] Dynamic Wounds as Negative Traits
**Completed Date:** 2026-09-15  
**Type:** Feature  
**Milestone:** M2 — Tactical Depth  

#### Why
Hit points only ever decided how many more shots a unit could take.

#### Key Changes
- `Limping` at or below half health: every step costs half again and 2 AP less to spend. `Concussed` at or below a quarter: -8 accuracy, -4 evasion. A quarter-health unit is both.
- **Derived from condition, not stamped on at a crossing.** The backlog asked for lasting traits; deriving is better and is what was meant. Hit points already replicate, so both peers reach the same answer with nothing sent and no threshold hysteresis; healing genuinely helps rather than leaving a unit limping at full health. The hit-point setter is the trigger, checked against the bands.
- `TraitEffects.moveCost` is an extra fraction, not a multiplier, because the fold adds — two half-again penalties mean twice as expensive. The backlog's `apCostDelta` was not needed: the -2 AP it was for is `maxAp: -2`, which the fold already had.
- `src/game/Movement.ts` (`stepCost`, `stepCostFor`, `moveBudget`) is now the only place a step is priced. Routes stay costed in the terrain's own points and the *budget* is divided, so cost, preview and reachability remain one currency — a route planned at one price and walked at another strands a unit halfway.
- The multiplier rides `TraitsComponent`, because the mover works on components and never sees a unit.
- Wounds are traits, so the status chips would not have shown them; the card's condition row lists them first.

#### Measured
Over 200 matches, 111 end with a wounded survivor — 87 limping, 40 concussed. Shotgun hit rate fell 62.7% → 60.2% and blue's wins 122 → 119, which is the wounded shooting worse rather than any change to the guns.

---

### [ITEM-006] Trait-Bearing Equipment Breadth
**Completed Date:** 2026-09-15  
**Type:** Content / Feature  
**Milestone:** M2 — Tactical Depth  

#### Key Changes
Four passive pieces, each with a trade: **Scope** (a third less accuracy lost to distance, -5 flat), **Bipod** (+10 accuracy, +6 evasion, crouched only), **Suppressor** (firing never reveals, -0.3 crit multiplier), **Plate Carrier** (a sixth less damage taken and +6 armour, -4 evasion, a quarter more per step).

Two needed new mechanisms rather than new numbers:

1. **"No muzzle reveal" had nothing to attach to.** Firing now reveals: `firedThisTurn` on `StanceComponent`, set by `executeShot` unless silenced, read by fog alongside line of sight, forgotten at the unit's own handover. State rather than an event, because fog is recomputed from scratch on every action.
2. **Plate could not work as armour points.** Armour subtracts flat per round and every hit floors at `AIM.minDamage`, so the base twenty already floors the small rounds of a burst — +8 armour *lost* 15 wins against the control, and +14 lost 15 more against a gatling squad. `TraitEffects.damageTaken` takes a share off instead, added to the status total rather than compounding with it.

#### Measured
One piece per unit against a stock control over 200 matches: scope +5 wins, plate inside the noise, suppressor -2, bipod exactly nil. The last two are limits of the instrument, not the kit — the AI only crouches when hurt and out of options, and it picks targets by line of sight rather than by what it can see, so a bipod is never set up and stealth is invisible to it. Recorded rather than tuned around.

#### Follow-ups Identified
- The scope and the plate were both strictly-better or strictly-worse until measured. Any new passive piece should be swept before it ships.
- `tests/gear.test.ts` pins the invariant that nothing worn is unconditionally free: every piece either costs something outright or pays only in a particular stance.

---

### [ITEM-007] Enemy Intel Fog
**Completed Date:** 2026-09-16  
**Type:** Feature / Polish  
**Milestone:** M3 — Reconnaissance & Fog  

#### Why
An enemy's exact evasion was legible the moment you aimed, which made a sheet read as a stat block rather than an opponent. It also left the suppressor buying something imperceptible: hiding a muzzle flash matters little when everything about the enemy is already readable.

#### Key Changes
- `SightedComponent` gained `known` beside `seen`: seeing a body tells you nothing about how hard it is to hit, so sight and knowledge are separate. Local per-peer, like fog — it is one side's knowledge, not a fact about the unit.
- Revealed by the two things an opponent can actually observe, set in the resolvers where the evidence is: **firing** (unless silenced — this is the suppressor's real payoff) and **being shot at or caught in a blast**, hit or miss. A grenade always reveals its thrower; there is no quiet way to throw one.
- Permanent, unlike `firedThisTurn`: a muzzle flash is about position and expires at the handover, while having measured a unit is knowledge you keep.
- Derived on both sides rather than sent — `replayShot` reveals from the shot it is replaying, exactly as it derives suppression. No message grew.
- HUD: the shot panel's header carries an `UNREAD` badge and the evasion row reads `-?%`; the target strip draws unread opponents with a dashed border and a `?`.

#### The Design Decision
**What is withheld is the attribution, not the number.** The headline hit chance stays honest — it is computed with the real evasion — because a figure a player commits action points to must never be a guess. Observable state is never hidden either: you can see that a soldier is bleeding, so health and armour stay visible. Only what the *sheet* says is held back.

#### Verification
- **Rules unmoved, proved rather than assumed**: 200 matches at seed 1 produce a byte-identical report with the change stashed and unstashed.
- **Live**: aiming at an unmet opponent showed `FIRING AT CRIMSON · UNREAD`, evasion `-?%`, a dashed strip card with `?`, and a headline of 84%. One missed shot later the badge was gone, the row read `-7%`, the card was solid — and the headline was still 84%, which is the point.
- 8 tests in `tests/intel.test.ts`, including that a suppressed shooter stays unread while its target does not, that bystanders are unaffected, and that being read survives a handover.

---

### [ITEM-013] Utility Proficiencies (Medical, Demolitions, Mechanics)
**Completed Date:** 2026-09-17  
**Type:** Feature  
**Milestone:** M2 — Tactical Depth  

#### Why
`sheet.proficiency` was `Record<WeaponId, number>` and nothing else, so a character had no
channel for training that was not a gun — while [GDD §2](../design/gdd/progression-and-meta.md)
gives one non-combat training on top of the four attributes.

#### How the Blocker Was Cleared
Filed blocked because only one of the three disciplines had anything to modify. All three
prerequisites were built in this pass rather than worked around:
- **Demolitions** was already live and needed nothing.
- **Medical** wanted targeted item use. `ItemSystem.canUse`/`use` now take a `target` that
  defaults to the user, and reaching across is read off the *effect* (`itemTargetsAlly`:
  anything that restores hit points, restores armour or clears statuses travels; a stim's lift
  and its AP top-up do not). The turn's price and the thing out of the pouch always come off
  the user.
- **Mechanics** wanted an item that repairs armour to exist. `ItemId.RepairKit` shipped in the
  same pass (see `ITEM-016`, which wanted the same item for the other half of its reason).

#### Key Changes
- `UtilityId` (`medical` | `demolitions` | `mechanics`) and `utility: Record<UtilityId, number>`
  on `CharacterSheet`, rolled from `CHARACTER.utility` and clamped in `sanitizeSheet` exactly
  as weapon proficiency is — bounded ints, unknown keys dropped, missing keys zero.
- **Rolled, not derived.** Utility is training rather than physique, so it is not a band off an
  attribute; it is also the channel `ITEM-004`'s learn-by-doing growth will write to.
- **Demolitions is stamped into the unit's own `grenadeSpecs`** (`areaRadius`, `armorShred`)
  beside the throw range Strength already stamped, rather than applied at the throw site. The
  one number every consumer already reads — the planner's blast preview, the range check in
  `throwGrenade`, the debug panel — is the number *this* thrower can reach, and it replicates
  with the component, so a peer sees the arm it is up against rather than its own stock copy.
  A radius is tiles, so it rounds and floors at the tile the grenade landed on.
- **Medical pays out only on somebody else** (`target === user ? 0 : …`): nobody gets credit
  for bandaging their own arm, and self-use keeps costing exactly what it did. It multiplies
  once with the *patient's* `healBonus` — the user's training and the target's physiology are
  two separate contributions, rounded once — and floors at a point, so a frail soldier is
  treated badly rather than not at all.
- **Mechanics pays on any plate**, the user's own included, because it is hands on armour
  rather than treatment of a body. It also discounts a repair's AP price, read off the item's
  effects in `itemApCost` rather than from a flag on the spec: anything with a `restoreArmor`
  effect is a mechanic's job by definition, so a future repair item inherits the discount
  without saying so twice. The band runs negative as well, so the untrained end fumbles and
  pays more.
- The HUD prints the same `itemApCost` the system charges, so the panel cannot lie about the
  price of the row being pressed.

Values for every discipline are in the generated
[status and trait catalogue](../design/gdd/status-and-trait-catalog.md) §4.2, which
`tests/catalog.test.ts` fails on if a discipline goes unprinted.

#### Acceptance Criteria
- [x] A sheet carries utility proficiencies and `sanitizeSheet` clamps them like weapon ones.
- [x] Demolitions changes a thrower's blast radius and armour shred, and nobody else's —
      per-unit `GrenadeSpecsComponent`, so a squadmate throwing the same kind is unaffected.
- [x] Medical only shipped once an item can be used on another unit, and Mechanics once an
      item repairs armour. Both prerequisites are in this pass rather than deferred.

---

### [ITEM-015] Strength Negating Heavy-Gear Penalties
**Completed Date:** 2026-09-17  
**Type:** Feature  
**Milestone:** M2 — Tactical Depth  

#### Why
[GDD §1](../design/gdd/progression-and-meta.md) has sufficient Strength negate the AP and
movement penalties heavy gear inflicts. Strength derived `throwRange` and `carrySlots` and
stopped there, so how strong a soldier was had no bearing on what plate did to them.

#### How the Blocker Was Cleared
The blocker was real and is worth reading next to the resolution: `ResolvedTraits` folds every
opinion into one scalar per number, so `Plated` and `Limping` were indistinguishable by the
time anything read `moveCost`, deliberately. "Negate gear penalties only" could not be phrased
against that number at all.

The fold was **split beside itself rather than replaced**:
- `TraitSource` (`innate` | `wound` | `gear`) and `SourcedTrait` name where a unit got a trait.
  Three sources, not four: worn kit and a fitted attachment are both gear, and no rule has
  wanted to tell a vest from a scope.
- `resolveSourcedInto(out, traits, source?)` is the same fold over tagged traits, filtered to
  one source when asked. The source-blind `resolveTraits`/`resolveTraitsInto` are untouched and
  still the default — source-blindness is what lets a vest and a bloodline grant the same
  modifier, and only one rule needed to care.
- One shared `addEffects` is now the single place that knows how each field combines (numbers
  sum, flags OR). Both folds go through it, so a new `TraitEffects` field cannot be honoured by
  one and silently dropped by the other — which is the failure mode a second fold invites.
- `Soldier` and `SimUnit` each keep a full fold and a gear-only fold and expose
  `gearOnlyTraits`, so the simulation and the match answer the question the same way.

#### Key Changes
- `DerivedStats.gearRelief` — a percent off Strength (band `CHARACTER.gearRelief`) — cancels
  that share of gear's *unfavourable* `moveCost` and of gear's *negative* `maxAp`, and nothing
  of a wound's or a bloodline's share. Penalties only, in both directions: kit that helps a
  unit move (`Math.max(0, …)`) or hands it a point (`Math.min(0, …)`) is never eaten, so being
  strong cannot undo a benefit.
- **`Plated` now also costs an action point** (`maxAp: -1`). Nothing worn inflicted an AP
  penalty before, so the GDD's "Strength negates the AP reductions heavy gear inflicts" had
  nothing to negate; the rule needed the cost to exist before it could answer it. Its
  protection was raised in the same pass to keep it worth wearing.
- Relief lands where each ceiling is already computed (`refreshTraits` for the AP ceiling,
  `moveCostMul` for the step price), so cost, preview and reachability stay one currency and a
  route planned at one price is still walked at that price.

#### Measured
400 matches over disjoint seed blocks 1000 / 5000 / 9000. Disjoint on purpose: `--seed` runs
consecutive seeds, so blocks closer together than `matches` share most of their matches.
- **Stock mirror control, after this pass**: blue 236 / 237 / 235, median 4 turns. (Before this
  pass: blue 251, red 128. Before the attribute refactor: blue 224, red 152.)
- **Plate on blue only**, against that control:
  - plate as it was (armour 6, no AP bite): 224 / 242 → neutral.
  - plate with the AP bite, protection unchanged: 188 / 231 → ≈ −27 blue wins. A bad buy.
  - plate with the AP bite and protection raised to +9 armour / −20% damage taken:
    203 / 241 / 242 → ≈ −8, back to roughly neutral on a *random* wearer, and strictly better
    on a strong one who pays neither cost. That is the intended shape: heavy kit is a decision
    about who wears it rather than a flat upgrade.
- **Block 1000 is consistently the least kind to plate in every variant.** Recorded as block
  variance rather than smoothed over — it is the reason three blocks are run and not one.

#### Acceptance Criteria
- [x] The movement/AP surcharge is readable per source: `resolveSourcedInto` with a
      `TraitSource` answers gear, wound or innate alone.
- [x] High Strength cancels a plate carrier's step cost and AP surcharge, and the same unit
      while `Limping` still pays the wound's share in full — relief is computed from the
      gear-only fold, which a wound never enters.
- [ ] **Not ticked: `bun run balance` shows the change only where heavy gear is worn.** The
      plate sweeps above do isolate the rule, and the relief is structurally inert with no gear
      on (it reads the gear-only fold, which is all zeroes). But the stock mirror *did* move
      across this pass (blue 251 → 236) with no plate anywhere, because `ITEM-013` landed in
      the same pass: rolling utility proficiency consumes the sheet RNG stream and Demolitions
      changes every thrower's blast. So "only where heavy gear is worn" was never demonstrated
      by a single isolated sweep, and this criterion is unproven rather than met. Re-running
      the mirror with `gearRelief` alone stashed is the check that would close it.

---

### [ITEM-016] Intelligence Gating Advanced Item Usage
**Completed Date:** 2026-09-17  
**Type:** Feature  
**Milestone:** M2 — Tactical Depth  

#### Why
[GDD §1](../design/gdd/progression-and-meta.md) has Intelligence both gate advanced kit and
amplify it. The amplifying half had landed — `itemApDelta` makes a clever character pay less
per use — and the gate had not.

#### How the Blocker Was Cleared
Nothing in `ITEMS` was advanced enough to gate: a stim, a first aid kit and two passive
garments, and gating any of them would only have taken ordinary kit away from low-Intelligence
units. `ItemId.RepairKit` is the item the blocker asked for, and `ITEM-013`'s Mechanics
discipline wanted exactly the same thing, so one item unblocked both.

#### Key Changes
- `ItemSpec.minIntelligence`, absent meaning anyone can work it. Below the bar the kit is dead
  weight in the pouch rather than used badly, because a technical item is knowing what to do
  with it.
- `ItemId.RepairKit`: 3 AP, `restoreArmor` 12, `minIntelligence` 5, not passive. Priced against
  the first aid kit (2 AP for 50 of ~100 HP) deliberately — armour is not a second life bar, it
  only blunts what lands, so 12 of a 20-point plate buys less of the turn and costs a point
  more. What earns it a slot is being the only kit that undoes *permanent* loss, and a trained
  mechanic bringing its price back down.
- **Stocked, not issued**: `STARTING_ITEMS` carries none and `DEMO_INVENTORY` holds 2, so
  bringing one is a loadout decision and no squad starts with kit half of it cannot use.
- **Refused in three places, for three different reasons.** `canUse` refuses below the bar, so
  the HUD greys the row out of the same predicate it uses to enable it. `use` refuses *before*
  the `force` bypass, so a peer cannot make this side spend a kit its character cannot work —
  the item id is the only thing this side trusts a peer for. The loadout screen refuses the
  pick with the requirement spelled out, so the reason a repair kit sits unused is legible
  rather than a dead button.
- `scripts/build-catalog.ts` grew a `Needs` column on the item table; `tests/catalog.test.ts`
  fails if a gated item's requirement goes unprinted.

#### Acceptance Criteria
- [x] An `ItemSpec` can require a minimum Intelligence and `canUse` refuses below it.
- [x] A peer's `useItem` for a gated item is refused on the receiving side too. Worth being
      precise about *where*: the live remote handler applies nothing at all (item effects
      replicate as component state), so the path that re-runs a peer-authored use is recorded
      playback — `applyRecordedCommand` — and the gate sits ahead of `force` in `use`, which is
      the only door that path goes through.
- [x] At least one item exists that is worth gating, so no currently-usable kit was removed:
      the gate applies to the new `RepairKit` and to nothing that already existed.

---

### [ITEM-020] Shadow Resolution & Divergence Detection
**Completed Date:** 2026-09-18  
**Type:** Refactor / Architecture  
**Milestone:** M2 — Tactical Depth  

#### Why
Combat was sender-resolved: the acting peer rolled, resolved and shipped the numbers, and the
receiver applied them verbatim. That trade bought instant feedback and one code path for local
play and the headless sim, and it carried a standing cost — the attacker had to know things
about the *target* that only the target's owner truly knew. Three bugs of exactly that shape
had shipped and been fixed one property at a time (the target's evasion, the plate carrier's
`damageTaken`/`evasionCrouched`, and `unreadable`), each silently: the wrong number was applied
and nothing complained. The rule written in those commits — *a defensive property must live in
`TraitsComponent`* — existed because the architecture pointed the wrong way, and it held only
as long as everyone remembered it.

#### Key Changes
- On receiving a resolved attack, the receiver re-derived the outcome from the intent plus its
  own state and compared it against the payload, reporting the first disagreement with both
  answers and the unit it concerned. The applied result stayed the sender's: the item observed
  and changed nothing about who was authoritative.
- The comparison drew nothing from the match stream — it replayed the sender's own crit flags —
  so it could not desynchronise the thing it was measuring.

#### Retired by `ITEM-023`, as intended
This was the interim check **and** the evidence that intent-only was safe to attempt: the item
was self-validating by design, and the mismatch rate it measured across real matches is what
decided `ITEM-023`. Once a resolved outcome no longer travels there is nothing left to
re-derive *against* — a shot is a shooter, a target and a mode — so `src/game/Divergence.ts`
was deleted with the payload it existed to check. The `Divergence` type and `reportDivergence`
survived the file: they moved into `src/game/StateDigest.ts`, which is what reports a
disagreement now. Recorded as the planned end of a staging item, not as a regression.

#### What it found
The shadow could not be a rebuild. The first implementation reconstructed the unit from its
sheet and kit, which re-folds its traits and therefore could not see a *replicated* property at
all — so the test that withheld a defensive property from replication failed, which is exactly
the bug class the item existed to catch, reproduced against the check itself. The shadow became
a delegate over the live unit instead.

#### Acceptance Criteria
- [x] A received `fireShot` was re-derived locally and compared; agreement was silent.
- [x] A deliberately unreplicated defensive property made the comparison fire, in a test.
      Proven red the useful way — see above.
- [x] A received `throwGrenade` was compared per victim, including the receiver's own units.
- [x] The comparison consumed no match randomness and changed no applied outcome, with a test
      snapshotting every unit's hp, armour, AP, clip, statuses and reveal state across a run.
- [x] Exercised end to end without a browser, by `bun run replay` over a recorded intent
      stream: a recorded match replayed with no divergence, and two tampering tests proved the
      check was not vacuous — one point added to a single hit was caught and named, and a
      claimed hit chance the state did not support was caught on a shot that missed.
- [ ] **Not ticked: observed between two live browser peers.** Blocked on tooling rather than
      code — the browser device fails with a filesystem `ELOOP` and there is no X server for
      headful Chrome. The headless replay is the standing substitute and runs in CI.

---

### [ITEM-021] State Digest at the Turn Boundary
**Completed Date:** 2026-09-18  
**Type:** Refactor / Architecture  
**Milestone:** M2 — Tactical Depth  

#### Why
`ITEM-020` caught an attack two peers resolved differently. It could not catch *drift* — two
states that diverged with no single action revealing it, which is how a desynchronised match
actually feels: everything looks fine until nothing does. Since `ITEM-023` took the numbers off
the wire there is nothing left to compare per action, so this is now the **only** check on two
peers agreeing at all.

#### Key Changes
- `src/game/StateDigest.ts`: `digestWorld` fingerprints a world from the component
  serialisations replication already produces. Keys are sorted before hashing and the fold over
  entities is commutative, because the entities a world holds are a set — so the digest does not
  depend on insertion order.
- **The shape is deliberately uneven.** Units carry a hash *per component*, so a mismatch names
  the entity and the component; everything else folds into one number for terrain and one for
  the rule tables. There are hundreds of wall entities, and paying a hash per wall per turn to
  diagnose a thing that has never drifted would be paying every turn for a report nobody has
  needed. A terrain mismatch still says *terrain*, which is enough to start.
- Exchanged immediately before `endTurn` and compared *before* the handover is applied, because
  that is the state the sender fingerprinted. Sent past the recorder on purpose: a digest is a
  claim about state, and a replay derives state from the intents rather than checking it, so
  recording one would put a number in the log that the log itself has to reproduce.
- Detection is not repair. The item stops at reporting; resynchronising from a designated
  authority reintroduces a host and is a decision to take on purpose (`ITEM-025`).

#### What it found
The digest went red between two *identical* worlds, and the only thing differing was a weapon's
**serial**. It came from a process-local counter, so two peers agreed on it only by luck of how
many templates each had cloned — and the loadout screen clones one on every press. A serial is
now derived from who carries the weapon (`weaponSerial(faction, squadIndex, weaponId)`), which
both sides compute without it travelling and a replay reproduces. A 400-match sweep was
byte-identical across the change. Exactly the class of silent drift `ITEM-022` exists to remove,
found by the check built to notice it — and the reason the digest was worth building *before*
the wire narrowed rather than after.

#### Acceptance Criteria
- [x] Both peers agree on a digest for an identical world, and the digest is stable across
      component insertion order.
- [x] A single mutated component on one side is reported at the next handover, naming the
      component and the entity; a non-unit entity is reported as *terrain* and a drifted rule
      table changes the fingerprint.
- [x] Digesting a match costs no measurable frame time: 40 digests — a whole match — are pinned
      under a single frame's budget, and it runs once per handover rather than per frame.
- [x] Exercised end to end by the replay runner: two runs of one recorded match reach the same
      digest, which is the property a stored match must have before a roster can be derived from
      it, and the one rejoin will stand on.
- [ ] **Not ticked: observed between two live browser peers.** Same tooling block as
      `ITEM-020`; the headless replay is the standing substitute.

---

### [ITEM-022] Determinism Audit: One Match RNG, a Version Gate, and Float Discipline
**Completed Date:** 2026-09-18  
**Type:** Refactor / Architecture  
**Milestone:** M2 — Tactical Depth  

#### Why
Prerequisite for `ITEM-023`. Re-deriving a fight from intent alone only works if both peers
take exactly the same steps, and three things made that untrue or unproven: only the acting
peer drew from the dice, two peers on different bundles diverged innocently, and the rules
branched on functions whose last bit is implementation-defined.

#### Key Changes
- **One match stream, drawn only by the rules.** `matchDice(seed)` in `src/core/rng.ts` is the
  only source, injected into `CombatSystem` and `ShootPlanner` rather than reached for.
  `Math.random` is gone from `src/core`, `src/ecs`, `src/sim` and `src/game`, with `resolveSeed`
  the single stated exception — choosing a seed is what *creates* the stream. The defaults that
  hid the problem went too: a resolver without dice no longer compiles. Presentation keeps its
  own randomness, because a draw from the match stream moves every later roll and a peer cannot
  know how many sparks the other side drew.
- **A version gate.** `src/version.ts` states a hand-maintained `PROTOCOL_VERSION` and a
  `BUILD_ID` injected by `scripts/build-bundle.ts`. Two numbers rather than one because they
  say *how* two peers failed to match: a protocol difference means one side cannot parse the
  other, a build difference means they agree on the envelope and might still resolve a shot
  differently. Checked on both first frames — the host's `init` and the joiner's new `hello` —
  refused with prose a player can act on, latched so a refused peer gets no second chance, and
  surfaced on the join screen instead of blaming the peer id. A peer that states no version at
  all is refused too: a build old enough to omit it is old enough to disagree about the rules.
- **Float discipline.** The inventory of transcendentals feeding a rules decision came to two:
  `Math.hypot` (every distance, so every range check, hit chance and blast radius) and
  `Math.atan2` (facing). `sqrt` is correctly rounded by IEEE 754 while `hypot` is a library
  routine with implementation-defined accuracy, so `distance()` in `src/core/math.ts` is squares
  and one root; overflow — the reason `hypot` exists — cannot happen on a grid tens of units
  across. `facingYaw()` keeps `atan2` and quantises to a thousandth of a radian, far finer than
  anything visible, because a facing is replicated *and* digested.
- **Identical entity ids and iteration order** as a stated invariant, with a test: two peers
  dealt the same match number their entities the same and reach the same digest.

#### What it found
The stream's fragility was already measured rather than hypothetical — adding one attribute
roll per character had once shifted every die in a 400-match sweep and nearly caused a balance
result to be mis-attributed. What this item established is that under intent-only that
fragility stops being an ordering problem and becomes a *version* problem, which is why the
gate is not optional: once disagreement is grounds for naming a cheat, a stale cache would be
the first thing accused. `tests/determinism.test.ts` now enforces the whole audit by reading
the rules directories, and was proven red by putting each banned function back.

#### Acceptance Criteria
- [x] The match stream has exactly one set of callers, all inside the rules layer, enforced by
      a test.
- [x] Peers on different protocol or build versions refuse the connection with a stated reason,
      latched, shown on the join screen.
- [x] Every transcendental feeding a rules decision is identified and either removed or
      quantised before it branches, with a test that refuses both functions anywhere the rules
      can see them.
- [x] Identical entity ids and iteration order, with a test.
- [x] `bun run balance` byte-identical before and after: 400 matches at seed 1000, unchanged
      across the dice threading and the float work.
- [x] **Symmetric drawing**, which this item could only set up and not finish: it landed
      asymmetric on purpose, because outcomes still travelled. Both sides draw in step from
      `ITEM-023`, which is the point of having built the stream first.

---

### [ITEM-023] Intent-Only Wire
**Completed Date:** 2026-09-18  
**Type:** Refactor / Architecture  
**Milestone:** M2 — Tactical Depth  

#### Why
The payoff of the three items above. With identical state, identical steps and a check that
notices drift, a resolved outcome no longer needs to travel: intent produces the same fight on
both sides. The wire shrinks to what one peer *decided*, and the asymmetry behind three bugs
goes away because the attacker never needs a fact it does not own — structurally, rather than
because everyone remembers a rule.

#### Key Changes
- `fireShot` is `{shooterFaction, shooterIndex, targetFaction, targetIndex, mode}` and
  `throwGrenade` is `{shooterFaction, shooterIndex, kind, targetTile}`. `WireHit`, `toWireHits`,
  `fromWireHits`, the resolved-hit replay path and the whole of `src/game/Divergence.ts` are
  deleted rather than deprecated.
- A peer's attack is now *resolved* on arrival rather than applied: the remote handler calls the
  same `CombatSystem.fireShot` and `GrenadePlanner.executeThrowAt` the acting side calls.
  `reload` is re-run for the same reason — a peer's clip is a number this side can work out.
- Replication narrows to state the receiver is not authoritative for. `NetworkManager.bindWorld`
  takes an ownership predicate: each peer transmits only its own faction's units, the host owns
  the rule tables and the walls, and an inbound update for an entity this side owns is dropped.
  Both sides now simulate, so without an owner each would broadcast its own guess and the two
  would overwrite each other mid-step.
- A recording and the wire became the same thing, which is what made `src/sim/Replay.ts` and
  `bun run replay` possible: running a file *is* receiving a match.
- Consequence worth stating: a client can no longer fake a die quietly. Dice come from the match
  stream in an order the rules fix, so a faked roll is not a lie but a desynchronisation — which
  the digest catches and a referee (`ITEM-025`) can attribute.

#### What it found
The replay runner refused three events on the first attempt, and the cause was the finding of
this item: `SimMatch` drew its squads *and* its dice from one stream, so *how many numbers a
sheet consumed* decided every roll that followed. A replay deals nobody, so it began the dice
where the sim had finished dealing and resolved a different match. That is the same fragility
measured back in the attribute refactor. The sim now derives its dice from the seed by their own
stream (`matchDice`) and setup keeps its own, so a match is still one number and a recorded
match replays into itself.

#### Measured
The `bun run balance` byte-identical criterion could not be met, **and it was the wrong test**:
re-phasing the dice re-phases them, so the files differ by construction. What the sweep had to
show instead is that the *balance* did not move, and it does not. Across disjoint seed blocks
1000 / 5000 / 9000: blue 236 / 237 / 235 → 226 / 247 / 238, red 136 / 142 / 132 →
150 / 131 / 133. Block-to-block variance is larger than the shift in either mean (blue
236 → 237, red 137 → 138), so the report is a different sample of the same game rather than a
different game.

#### Acceptance Criteria
- [x] A shot and a grenade replicate with intent only; `WireHit`, `toWireHits`, `fromWireHits`,
      the resolved-hit replay path and `Divergence.ts` no longer exist.
- [x] A recording and a peer consume the same frames — demonstrably, since the replay runner
      applies a recorded stream through the same door the peer path uses and refuses nothing.
- [x] A full match agrees end to end: the 55-event recorded match in `recordings/` replays with
      every command applied and no skips, reproducibly, and reaches the same survivors as the
      sweep match that produced it. Two carriers of the rules, one answer.
- [~] **`bun run balance` byte-identical: not achievable, and it should not be.** Replaced by
      the sweep above, which is the honest form of the question.
- [ ] **Not ticked: two live browser peers play a full match with no digest mismatch.** Same
      tooling block as `ITEM-020` and `ITEM-021`; the headless replay is the standing
      substitute and runs in CI. One thing only a live match would exercise: a replay is handed
      **both** squads' loadouts by the recording header, whereas a live match never sends a
      peer's loadout at all — see the standing gap in
      [P2P Networking §7](../architecture/networking.md).

---

### [ITEM-011] Overwatch & Reaction Fire
**Completed Date:** 2026-09-19  
**Type:** Feature  
**Milestone:** M4 — Competitive & Meta Roster  

#### Key Changes
- `ShotMode.Reaction` (0.7× chance), `StanceComponent.watching` (replicated), `Combatant.watching`.
- `src/game/Overwatch.ts`: `canWatch`, `watchCost` (a snap shot's price, paid up front) and
  `reactToArrival`. A reaction is **prepaid**: `shotApCost` returns 0 for it, because
  `effectiveWeapon` floors every other shot at 1 AP.
- No new wire traffic. `overwatch` is an ordinary intent; a reaction is a consequence of a
  `moveUnit` both peers already hold, triggered by `MovementSystem.onStep` per tile *arrival*
  (an index into a path, not a moment in time). Watchers are sorted by faction and squad index
  inside the rule, one reaction per watch, watches expire when their side's turn comes round.
- HUD action and `ui-overwatch` icon; sweep AI holds a poor shot as a watch rather than firing it;
  `bun run balance` reports watches and reactions per match.

#### Found on the way
Replaying recorded sweep matches through `MatchHost` and comparing unit state intent by intent
found six disagreements between the two carriers of the rules. Four predate overwatch:
- `MatchHost` never settled a turn, so statuses never expired in a replay. The settle now lives
  inside `TurnManager.startNextTurn`, the one door every path already used.
- Handover order differed: the game refilled then settled, the sweep the reverse. Both now
  settle then refill (`TurnSystem.advanceFaction` / `replenish`), so a penalty that has just run
  out no longer docks the allowance handed over after it.
- `MovementSystem` wrote the AP component directly, so walking never counted toward exhaustion
  in the played game.
- `SimUnit` priced `maxAp` once at kit-up, so wounds never cost the sweep any action points.

And two that overwatch caused: watchers iterated in caller order (the game interleaves squads,
the sweep blocks them), and `fireWeapon` read `apSpent` as "the shot happened", silently
discarding every prepaid reaction after it had done its damage.

#### Measured
Disjoint blocks 1000 / 5000 / 9000: blue 229 / 248 / 239, red 141 / 129 / 132 — the win split is
where it was (blue mean 237 → 239). Matches run slightly longer (mean 5.96 → 6.26 turns) and
winners keep more (2.51 → 2.68 of 4), consistent with movement now costing stamina. Reactions:
0.2–0.26 per match, rare because the policy never crosses watched ground — filed as ITEM-029
rather than claimed as exercised.

#### Acceptance Criteria
- [x] A unit may hold points to fire during the enemy's movement.
- [x] Both peers agree on every reaction with no message: 10 recorded matches replay with no
      skipped intent and the same survivors (`tests/replay.test.ts`).
- [ ] Not verified live in two browsers — same tooling block as ITEM-020..023.

---

### [ITEM-030] One Engine: The Sweep Drives MatchHost
**Completed Date:** 2026-09-19  
**Type:** Architecture / Refactor  
**Milestone:** M1 — Headless Foundation  

#### Why
The balance sweep was a second implementation of the game. `SimUnit` mirrored `Soldier` because,
when it was written, a soldier needed a scene; ITEM-001 removed that need the next day and the copy
stayed. ITEM-011's replay cross-check found it had drifted in ways no test caught — wounds that
cost it no action points, a turn handover settled in the opposite order — each moving every
balance number a little. The ECS unified the game's *state*; the rules still had two carriers.

#### Key Changes
- `SimMatch` is a policy over a `MatchHost`: it reads ECS soldiers, decides, and applies intents
  (`moveUnit` one tile at a time, so a watcher can interrupt and the unit can re-decide), recording
  each. A refused intent throws — the policy asks the rules first, so a refusal is a bug.
- `MatchHost.apply` reports what a shot did (`Carried.shot`) and the host counts reactions.
- `src/sim/SimUnit.ts` deleted. Rule tests (wounds, exhaustion, suppression, utility) run on a real
  headless `Soldier` via `tests/support/soldier.ts`; the one parity test between the two carriers
  was deleted as tautological.
- Grenade policy reads the thrower's own Strength-adjusted reach instead of the base spec.

#### Measured
Speed unchanged: ~7 s per 400 matches. Disjoint blocks 1000 / 5000 / 9000: blue 237 / 244 / 243,
red 140 / 135 / 129 (previously 229 / 248 / 239 and 141 / 129 / 132) — within block-to-block
variance. Reactions 0.21–0.25 per match.

#### Acceptance Criteria
- [x] No second soldier: `SimUnit` gone, every headless match is ECS.
- [x] Sweep throughput within the old budget.
- [x] Every recorded sweep match replays with no skipped intent and the same survivors
      (`tests/replay.test.ts`, ten seeds).

---

### [ITEM-029] AI That Crosses Covered Ground
**Completed Date:** 2026-09-19  
**Type:** Tooling / AI  
**Milestone:** M3 — Reconnaissance & Morale  

#### Why
The sweep's policy advanced along the shortest route until it had a shot and stopped, so it never
weighed a watched lane at all: overwatch fired about 0.2 times per match, and melee would have
measured as worthless for the same reason.

#### Key Changes
- `src/sim/Tactics.ts`: `chooseDestination` scores every tile reachable this turn in expected hit
  points — offence from there with the points left, minus reactions the route provokes (once per
  watcher, propagated down the search tree as a bitmask), minus exposure to enemies who can see
  it. While nothing is shootable from anywhere reachable, closing counts instead, weighted up by
  every quiet handover.
- `core/Pathfinding`: `reachable` (Dijkstra within a budget) and `routeTo`, sharing one stepping
  rule (`canStep`) with the A* search.
- The policy reloads — it never did, which only surfaced once fights ran long: draws became
  squads a metre apart with empty magazines.
- `SquadPlan.watch` and `--blueWatch=off` / `--redWatch=off` price the ability by removal.

#### Measured
Disjoint blocks 1000 / 5000 / 9000, 400 matches each:

| | blue | red | draws | reactions / match |
|---|---|---|---|---|
| mirror | 151 / 153 / 142 | 237 / 235 / 250 | 12 / 12 / 8 | 0.76 / 0.70 / 0.75 |
| blue may not watch | 133 / 138 / 145 | | | |
| red may not watch | | 217 / 225 / 240 | | |

A watch is worth about 3% of matches to the side holding it (positive in five of six runs). The
side moving **second** now wins about 60% of mirror matches, reversing the old first-mover edge:
the first squad to close has to end a turn where the other can see it. That is a statement about
this AI as much as the game, and is recorded rather than tuned away. Sweep speed 7 s → 12 s per
400 matches.

#### Acceptance Criteria
- [~] **Reactions an order of magnitude above 0.2: not met, and it was the wrong target.** A
      policy that holds a watch instead of a poor shot reached 4.9 reactions per match — and lost
      to a side forbidden to watch at all. A mover that prices danger *avoids* watched ground,
      which is the watch working. Settled at 0.7–0.76 (≈3.6×).
- [x] A watch's value is measurable: removing it costs a side ~3% of matches.

---

### [ITEM-018] Melee: Fists, Blades and Bludgeons
**Completed Date:** 2026-09-19  
**Type:** Feature  
**Milestone:** M2 — Tactical Depth  

#### Key Changes
- **A sidearm slot** beside the primary weapon: `UnitLoadout.sidearm`, stored on
  `InventoryComponent` (replicated, in the digest), stamped by `applyUnitLoadout`, validated in
  recordings (absent = fists, unknown = refused). The crate supplies knives and clubs; an empty
  slot is fists. Loadout screen picker with remaining counts; three new icons.
- **The rule** (`src/core/Melee.ts`, `meleeChance`/`meleeWeapon` in Ballistics,
  `canMelee`/`executeMelee` in Combat): adjacent incl. diagonal, same level, sight between. One
  roll — the attacker's sidearm and Strength against the defender's evasion and parry (their
  sidearm plus `LONG_GUN_PARRY` for what is in their other hand). No range, cover or ammunition
  term. Damage through the shared armour arithmetic; Strength scales it (`meleeSkill`,
  `meleePower`, its first combat use). A loud sidearm lights the attacker up like a shot.
- **On the wire**: `meleeAttack` names attacker and target; both peers resolve it.
- **In the game**: a *Strike* row beside the shot modes when the target is in reach, with its
  chance; a unit with too few points for any gun can still enter shoot mode to strike.
- **In the sweep**: a blow is one more option on the policy's damage-per-AP scale, and in the
  movement scorer's offence and exposure terms. `--blueSidearm=knife|club`; blows are tallied
  under the sidearm's name.

#### Found on the way
A duplicate `case 'overwatch'` in `InteractionController.handleRemoteNetworkMessage` (from
ITEM-011) meant a peer's watch was never applied in a live match. Fixed; `bun run lint:code`
(Biome `noDuplicateCase`) added and proven red on the shipped file; the underlying duplication
filed as ITEM-031.

#### Measured
Disjoint blocks 1000 / 5000 / 9000, 400 matches each. Melee is rare — 15 to 80 blows per 400
matches — because the policy strikes only when it is worth more than a shot, and win rates did
not move with any sidearm (blue 150 / 152 / 143 fists, 151 / 151 / 145 knife, 151 / 153 / 142
club). Per blow against a plated squad: fists 3–8 damage, knife 16–21 at 3 AP, club 21–23 at 4 AP
plus 12 armour stripped per landed blow. The club was first costed at 5 AP and measured *worse*
per point than a knife against plate, the one fight it exists for; it is 4.

#### Acceptance Criteria
- [x] A blow resolves with no cover or range term, from intent only, on both peers
      (`tests/melee.test.ts`, `tests/network.test.ts`).
- [x] Fists, knife and club differ measurably against an armoured target (above).
- [x] The sweep's AI strikes when a blow is worth more than a shot, and `bun run balance`
      reports what each family did.
- [ ] Not verified in a browser, the loadout picker and the Strike row included — same tooling
      block as every item since ITEM-020.
- Deferred: attacks from behind and the silent kill (ITEM-019), non-lethal takedowns (ITEM-012).

---

### [ITEM-031] One Intent Applier for the Played Game
**Completed Date:** 2026-09-19  
**Type:** Architecture / Refactor  
**Milestone:** M1 — Headless Foundation  

#### Why
`MatchHost.apply` and the controller's two switches (local input, peer messages) were three
readers of the same commands, and only the host's was tested. ITEM-011 shipped a duplicated
`case 'overwatch'` in the controller that meant a peer's watch was never applied in a live match
while every replay passed.

#### Key Changes
- `src/ecs/systems/CommandSystem.ts`: `apply(command, origin)` is the only switch over
  world-changing commands. The controller, replays, the referee, the sweep and the host all call
  it; the reaction trigger moved into it. `onApplied` / `onRefused` / `onBeforeApply` hooks
  carry presentation, recording, sending and the digest.
- Peer commands queue (`enqueue`) and drain only while nothing is walking; `whenSettled` orders
  the peer's digest behind them.
- The controller keeps one *presentation* switch (`present`) and no rule calls.
- `MatchHost` is the world plus a fixed-step clock over `CommandSystem`.

#### Found on the way — all live-only, all invisible to every headless test
- **Burst fire desynchronised peers.** `ShootPlanner.fire` pre-rolled every round's hit from the
  match stream and let the resolver draw crits after; the receiver drew hit, crit, hit, crit.
  Any burst landing two rounds put the peers on different dice. The planner now only chooses.
- **A peer's shot was resolved mid-walk.** Commands were applied on arrival, while the peer's
  previous move was still animating here. Proven by `tests/commands.test.ts`: remove the queue's
  movement gate and the peer's shots are refused.
- **Recordings of online matches held one side.** The recorder was tapped in
  `NetworkManager.send`; it now records every applied command from either side.
- **A peer's item use was never resolved** on the receiving side (component updates were relied
  on instead), unlike in a replay.

#### Acceptance Criteria
- [x] One switch over commands that change the world; the controller's are gone.
- [x] A test drives the live peer path headlessly with recorded matches at uneven frame rates,
      and is proven red without the queue's gate.
- [~] `bun run lint:code` kept rather than dropped: the controller still switches over HUD
      intents and presentation, and a duplicated case there is a bug too. It costs 0.1 s.
- [ ] Not verified in two live browsers — same tooling block as since ITEM-020.

---

### [ITEM-032] Projectile Hit Model
**Completed Date:** 2026-09-19  
**Type:** Feature / Rules  
**Milestone:** M2 — Tactical Depth  

#### Why
Hit chance was additive points, which cannot express what separates a rifle from a shotgun:
one straight line against a fan of them.

#### Key Changes
- Every projectile is a straight line that misses by `e = (sway + spread × d) × mode × training`
  and lands on a body of half-width `w` (visible share of cover and stance, less evasion) with
  probability `w² / (w² + e²)`. Weapons have `sway`, `spread`, `pellets`, and `damage` /
  `armorPen` per projectile; `baseAccuracy`, `accuracyPerMetre` and the subtractive cover table
  are gone. Rifle, gatling and sniper were fitted to the old curves (RMSE 6.6 points).
- A round lands if any projectile does; armour is taken off the round once and the minimum is
  per round; crit once per landed round; one roll per pellet from the match stream. The round's
  chance is floored, a pellet's is not.
- Shotgun: 9 pellets × 12, spread 0.05 — about twice a rifle's expected damage inside a room,
  level at ~6 m, worse beyond.
- Shot panel: chance, damage, AP and rounds only. Loadout weapon buttons show damage (9×12 for
  buckshot), range, clip, spread at 10 m and crit; the catalogue has a Weapons section.
- `expectedRoundDamage` is the one estimate the panel and every AI use.
- Sweep policy: the destination scorer runs *before* the take-it-now shot, since it counts
  staying and firing as a candidate. Without that a shotgun fired from 8 m, because a shell
  nearly always lands something.

#### Measured
Blocks 1000/5000/9000, wins summed:

| | 4× shotgun vs stock | shotgun distance | dmg/shot in / out | mirror blue / red |
| --- | --- | --- | --- | --- |
| before | 192 | 6.8 m | 16 / 21 | 568 / 579 |
| new model | 125 | 7.5 m | 22 / 27 | 549 / 591 |
| + reposition first | 155 | 6.6 m | 26 / 36 | 576 / 569 |

#### Acceptance Criteria
- [x] The rifle's curve stays close to the old one at 4–20 m.
- [x] A shotgun's damage falls with distance with no damage-falloff rule.
- [ ] **Not met: it does more per shot indoors than out.** It does less (26 vs 36): indoor
      fights go through doorways and partitions, where tall cover hides most of the target from
      any weapon.
- [ ] **Not met: four shotguns win clearly more than 17%.** 13%. They close to 6.6 m — where the
      new shotgun is by design level with a rifle — because getting inside 4 m means crossing
      rifle fire, which the scorer prices as expensive. The rule gives the shotgun its band; the
      AI and the map rarely produce a fight inside it.
- [x] Mirror stays even (576 / 569).
- [x] The shot panel shows only chance, damage, AP and rounds; verified in the browser.

**Follow-up (same day).** Tried and reverted, all measured on the same three blocks:
- *A quality bar for taking a shot* (expected damage as a share of the weapon's point-blank best,
  instead of a flat 50% chance): identical results — the far shots came from the policy's
  last-resort fire, not from the bar.
- *Holding very poor shots as a watch*: four shotguns 155 → 160, within noise.
- *Multi-turn flanking* (`planApproach`: a firing position scored on the target's cover from
  that side, walked to across turns): no gain for the shotgun (49 vs 46 on one block), shotgun
  kills in the mirror down, the sweep 4.4× slower. Any tile inside 4 m of an enemy is also where
  it shoots back point blank next turn, so every weapon's best position came out near 6 m; a
  shotgun's real edge — arriving and firing before the target can answer — is not something a
  static position score can see.

Kept: **pellets 12 → 14**. Four shotguns 155 → 201 (17%, back to before this item), shotgun
kills in the mirror up (~339 → ~356 a block), fights still at 6.9 m, mirror 575 / 583. At 16
they won 224 but took their fights out to 7.5 m and the mirror tilted to 598 / 567.

---

### [ITEM-019] Noise, Awareness and the Quiet Kill
**Completed Date:** 2026-09-24  
**Type:** Feature  
**Milestone:** M3 — Reconnaissance & Morale  

#### Why
[GDD: Noise & Stealth](../design/gdd/noise-and-stealth.md). Sight was modelled carefully and
sound not at all, so there was no choice between crossing a room quickly and crossing it
quietly.

#### Key Changes
Built in slices, mechanics before noise, each committed and measured on blocks 1000/5000/9000:

0. **The sweep's policy knows only what its side has seen** (`src/sim/Intel.ts`): contacts where
   an enemy was last seen, dropped when the tile is found empty; with none, a search of unseen
   ground by walking distance, keeping a shot in hand. Mirror 608 / 563 / 29.
1. **Crouched movement**: a crouched unit moves crouched at `RULES.crouchStepCost` (1.5×) a
   step. Mirror 600 / 558 / 42.
2. **Attacks from behind**: `PositionComponent.heading` (eight directions, no trigonometry);
   from behind a shot ignores evasion and status defence, a blow ignores parry too, and a knife
   does 5× damage. Cover still counts. Mirror 598 / 570 / 32.
3. **Noise** (`src/core/Noise.ts`): loudness per source with inverse-square falloff against each
   listener's own hearing (Intelligence); per-weapon loudness, a suppressor keeps a quarter, a
   frag is heard map-wide. Rings on the map, "heard at N m" on the move preview (which now also
   prices a crouched or limping walk at what the unit pays). Mirror 595 / 569 / 36.
4. **Awareness** (`src/core/Awareness.ts`, `AwarenessComponent`, replicated and digested):
   unaware, alerted, engaged. Hearing alerts and turns a unit toward the noise; the waiting side
   notices only what is in front of it; an unengaged watcher reacts only in front. Target strip
   and shot panel mark unaware / alerted. Mirror 595 / 569 / 36.
5. **Glass and the stone**: a shot, reaction or throw through glazing breaks it (a replicated
   wall change, heard at 15 m from the window); a stone (two per soldier, outside the crate) is
   heard where it lands and gives the thrower away to nobody. `World.query` got a per-component
   index, because wall entities in the headless host made every tick scan them. Mirror
   593 / 568 / 39; about 1.6 windows break a match.

Along the way: `NOISE.crouchStep` 1 → 0.9 m, since an ordinary ear on the neighbouring tile
caught a crouched step and no crouched approach could arrive; `tests/intel.test.ts` was
overwritten by the slice-0 commit and restored the next.

#### Acceptance Criteria
- [x] Being heard alerts a unit without handing the listener a firing solution.
- [x] A crouched approach can reach an unaware enemy; a standing one cannot.
- [x] A stone alerts enemies toward where it landed, not toward the thrower.
- [x] Breaking glass alerts, and the segment is gone for both peers (the replicated wall
      component, tested; not verified in two live browsers).
- [ ] The policy uses any of it. Only ~3% of its attacks land on a target that is not engaged —
      contact is mutual sight, and the side whose turn comes next looks all round — and a
      "crouch near an unengaged enemy" rule changed nothing. It never throws a stone. Stealth
      is a player's tool; the sweep does not measure it.

---

### [ITEM-014] Morale, Stress and Breaking
**Completed Date:** 2026-09-24  
**Type:** Feature  
**Milestone:** M3 — Reconnaissance & Morale  

#### Why
[GDD §3](../design/gdd/progression-and-meta.md) wanted stress from damage, near misses and
watching squadmates fall, and units that break under it. The only psychological state a unit
had was the `Suppressed` status.

#### Key Changes
Scoped with the user: three breaks, a rolled trigger, a rolled recovery with rising odds, and
character deciding panic or frenzy split out as ITEM-033 along with the predispositions.

- `MoraleComponent` (replicated, digested): morale 0–100, the break, turns begun broken.
  `src/core/Morale.ts`, numbers in `MORALE`, generated into the catalogue's §7.
- **Stress** (`shake`, called by `CombatSystem` after every shot, reaction, blow and throw,
  read off the resolved hits): a wound costs ½ point per percent of max HP, a round past the
  target 3, a death 20 to every squadmate; a kill pays the killer 15 and its squadmates 5.
- **Breaking** (`rollMorale`, at each handover, from the match's dice): below 50, 2% per point
  short; the kind is an even second draw among panic, frenzy and freeze. Nobody at steady or
  above draws. A break costs the breaker's squadmates 10.
- **Steadying**: 25% on the first turn after breaking, +25% a turn, certain on the fourth; the
  unit comes back to at least 50.
- **Freeze**: points to zero, not counted as spent.
- **Panic and frenzy are run by the rules** (`src/game/Breakdown.ts`): a panicking unit stands,
  runs to where the fewest enemies its side can see would see it, farthest from the nearest,
  and crouches; a frenzied one strikes or charges the nearest such enemy and shoots it with its
  cheapest shot. Seeing nobody, one cowers and the other watches. `CommandSystem` queues each
  run at the handover, one command at a time with the new origin `rules`: never sent, never
  recorded, derived again by the peer, a replay and the referee. A broken unit refuses every
  other command but `endUnitTurn`, and a `local` command is refused while the rules run anyone.
  `MatchHost` and playback wait for the queue as well as for walking.
- **HUD**: a card chip (Panicking / Frenzied / Frozen with the chance to steady, or Shaken with
  the chance to break), no actions for a broken unit, End Turn disabled while the rules act, a
  badge on an enemy's target icon, a callout over a unit that breaks or steadies, and the camera
  following a unit the rules walk.
- Sweep report: breaks per match.

#### Measured
Mirror on blocks 1000/5000/9000: 601 / 568 / 31, from 593 / 568 / 39. About one break a match,
evenly split across the three kinds.

#### Acceptance Criteria
- [x] Stress accrues from damage taken, near misses and squadmate deaths; both peers reach
      the same morale for the same unit (the component is in the digest; not verified in two
      live browsers, the same tooling block as since ITEM-020).
- [x] Breaking is rolled from morale; steadying is rolled with rising odds.
- [x] A panicking unit flees and a frenzied one charges under the rules' control; a frozen
      one has no points. None of them takes an order.
- [x] The other side sees a unit break (callout, card chip, target badge; verified in a
      hot-seat match in the browser).

---

### [ITEM-033] Character: Who Runs and Who Charges
**Completed Date:** 2026-09-24  
**Type:** Feature  
**Milestone:** M3 — Reconnaissance & Morale  

#### Why
ITEM-014 rolled a break's direction evenly. The GDD wants the person to decide it, and wants
Daredevil, Teamplayer and Loner to change how morale moves.

#### Key Changes
- **Temperament** on every sheet, hothead or skittish, dealt half and half, checked by
  `sanitizeSheet`, shown on the loadout card.
- **Which break** is no longer drawn (`breakKind`): freeze at 25 morale or more, below that
  frenzy for a hothead and panic for a skittish one; a daredevil always charges.
- **Predispositions** as innate traits with no combat numbers, rolled apart from the combat
  trait (35%): daredevil (+10 when outnumbered or below half health, −5 when winning by two),
  teamplayer (+5 while the squad is above half health; +5 to squadmates within 2 tiles), loner
  (none of the squad's losses, breaks, kills or company).
- Catalogue §7 lists temperaments and predispositions; trait rows say "morale (§7)".
- **Fixed on the way**: a broken unit's run was queued *behind* anything already waiting, so a
  peer's next commands arriving before this side got through the handover were applied before
  the rules' run here and after it on the peer. The existing live-queue test caught it once a
  seed produced a panic; the runs now go to the front of the queue.
- GDD combat §2.7 now says which extensions are built.

#### Measured
Mirror on blocks 1000/5000/9000: 605 / 564 / 31. Per hundred units (blocks 1000–1399), breaks:
none 11.5, teamplayer 7.9, loner 4.4, daredevil 3.5.

#### Acceptance Criteria
- [x] A character's sheet decides whether they panic or go into a frenzy.
- [x] Daredevil, Teamplayer and Loner each measurably change how a unit's morale moves (rule
      tests for each, proven red; in the sweep all three break less than nobody-in-particular).
- [ ] Open: every predisposition is a net gain. Whether one should cost something is a design
      question, not settled here.

---

### [ITEM-034] Tile Properties, Fire and Smoke
**Completed Date:** 2026-09-24  
**Type:** Feature  
**Milestone:** M2 — Tactical Depth  

#### Why
Every lasting effect was a status on a unit; nothing lived on the ground. Fire needs the ground
to be something, and smoke that only marked whoever stood in the blast was not smoke. Scoped
with the user: tile properties drive the spread, fire and smoke go together, the incendiary
grenade is the only source for now.

#### Key Changes
- **Surfaces** (`core/Surfaces`): paving, grass, concrete, timber, ash, laid by the map
  generator on a stream of its own so existing seeds make the same terrain. Crates are timber.
  The floor shows them; a tile readout names what is under the pointer.
- **Ground state** on one host-owned entity (`GroundComponent`, written only by
  `GroundSystem`): fire, smoke, ash, crates burned away. Replicated, digested, rewound.
- **Fire** (`core/Fire`): the incendiary grenade (two in the crate) lights its blast; at each
  handover fire spreads to orthogonal neighbours at their flammability, from the match's dice,
  and burns down to ash; a crate burned out is cover gone. 15 armour-ignoring damage for
  stepping in, starting a turn in it, or being caught by the blast.
- **Smoke** is ground state too: the smoke grenade fills its blast (not past any wall) for 4
  handovers, fire smokes while it burns and one handover after, and sight does not pass into,
  out of or through it except between neighbours. The `Smoked` status is gone.
- **Keeping out of it**: the sweep's policy walks round fire and walks out of it; it throws an
  incendiary at an enemy it sees but cannot shoot. A **broken unit does not avoid fire** —
  panicked people run into fires; decided with the user, after an avoiding version was built
  and removed. `--blueGrenades` / `--redGrenades` on the balance script; the report's
  `grenades:` line counts throws and hit points lost to fire.

#### Measured
Mirror on blocks 1000/5000/9000: 605 / 564 / 31, unchanged. Blue with two incendiaries:
605 / 559 / 36. Red loses 2–3 hp a match to fire. Thrown in place of a poor shot, the policy
lost ~8 points on block 1000, so it throws only with no shot on offer.

#### Acceptance Criteria
- [x] Every tile has a surface, and whether fire spreads onto it depends on that surface.
- [x] An incendiary grenade starts a fire that spreads over timber and grass and stops at paving
      and concrete; what burned becomes ash; a crate that burns away no longer gives cover.
- [x] Fire hurts whoever steps into it or starts a turn in it.
- [x] Smoke blocks sight, from a smoke grenade and from fire.
- [x] Both peers agree (the ground component rebuilds the same ground from what a peer
      sends), and a rewound replay puts the ground back. Not verified in two live browsers.
- [ ] Open: the policy never throws smoke, and uses incendiaries rarely; fire and smoke are a
      player's tools that the sweep barely measures.

---

### [ITEM-024] Transport Port: One Frame Channel, Three Implementations
**Completed Date:** 2026-09-18 (landed with `ITEM-025`)  
**Type:** Refactor / Architecture  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
[RFC-0001](../design/rfc/0001-referee-and-transports.md). Everything that arrives from another
process is a JSON-RPC frame, and everything that leaves is too — but the only way to move one
is PeerJS. That forecloses a referee in a worker, a referee in a process, and any test that
wants to drive two peers without a signalling broker.

The seam is already narrow, which is why this is cheap: `peerjs` appears in exactly one file,
and the whole conversation is `sendRpc(frame)` out and `handleIncomingRpc(frame)` in.

#### Change
1. A `Transport` port — `send(frame)`, `onFrame(handler)`, `onClosed(handler)`, `close()`.
2. `DataChannelTransport` wrapping today's PeerJS connection, with behaviour unchanged.
3. `SocketTransport` over `WebSocket`, browser side and `Bun.serve` side.
4. `LoopbackTransport`: a linked pair in one process, for tests. The network tests already
   hand-build a fake channel to observe what a peer would have transmitted — that is a
   transport implementation living in a test file without being called one.
5. **One codec: a JSON string, on every transport.** A socket needs a string anyway, so every
   frame is byte-identical however it travelled, and nothing has a per-transport branch.
6. `NetworkManager` takes a `Transport` rather than constructing a `Peer`.

#### Notes
Deferred at first — a port with one implementation is an abstraction looking for a second
caller — and then built as part of `ITEM-025`, whose referee was that caller (commit `b677154`).
`LoopbackTransport` shipped as the `loopback()` function in `src/game/Transport.ts`.

The argument that had grown meanwhile, recorded because it is evidence rather than taste: a
linked in-process pair is how a two-peer handshake gets tested. Verifying the version gate had
meant either a CDP script driving two real browser tabs through a public signalling broker, or
wiring two `NetworkManager`s to each other by hand in a test file — a loopback transport
written inline and not called one.

#### Affected Files
- `src/game/Transport.ts` (new)
- `src/game/NetworkManager.ts`
- `tests/network.test.ts`

#### Acceptance Criteria
- [x] `peerjs` is imported in exactly one file (`src/game/DataChannelTransport.ts`), and it is
      not `NetworkManager`.
- [x] A match's handshake, a squad and commands cross a `loopback()` pair with no PeerJS and no
      broker (`tests/network.test.ts`, "A match over a linked pair, with no broker").
- [x] Frames are one JSON string on both wire transports (`DataChannelTransport`,
      `SocketTransport`); the in-process `loopback()` passes frames as objects, synchronously.
- [ ] Not verified: peer-to-peer play between two live browsers after the cutover (the same
      tooling gap as since ITEM-020); the P2P code path is covered by the network tests only.

---

### [ITEM-025] Referee: The Rules, Hosted
**Completed Date:** 2026-09-18  
**Type:** Feature / Architecture  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
[RFC-0001](../design/rfc/0001-referee-and-transports.md). A campaign roster needs a home that
is not one player's tab, a crashed tab needs rebuilding, and a disagreement between two peers
needs a third opinion to become an accusation rather than a shrug.

**A witness, not an authority.** Since nothing is secret (RFC-0001 §2), the referee does not
need to be in the data path: clients still resolve locally and instantly, and the referee
recomputes the same intent stream at its own pace. It costs no latency, and a match plays on
unwatched when there is no referee at all.

What it adds is **attribution**. Two peers can already detect a disagreement (`ITEM-020`,
`ITEM-021`); neither can prove which side is wrong. A third recomputation makes it two against
one. It cannot see a maphack — that is a read, and no recomputation observes a read — and it
cannot see anything that happened before the first intent (`ITEM-027`).

#### Change
1. A referee module that drives the **existing** ECS world and systems from peer intents
   instead of from an AI policy. Not a second rule set: the resolvers already speak to narrow
   ports, `tests/headless.test.ts` already deploys a squad with no engine or canvas, and
   `src/sim/` already runs whole matches headlessly.
2. One entry point containing no rules: a `Bun.serve` process with a `websocket` handler. A
   referee in a `Worker` was struck — a witness inside one player's process cannot attribute
   anything about that player, and local versus already runs the rules in-page.
3. **Rejoin**: a client that lost its tab reconnects, receives the intent log and replays it.
   The same log the recorder already writes, which is why `ITEM-022`'s determinism work is
   load-bearing here and not merely tidy — a client that cannot reproduce the log cannot
   rejoin.
4. **Persistence**: the log and the roster are probably one store. `bun:sqlite` is built in.
5. **Abort on a foul**, per RFC-0001 §8.3: the log is kept as evidence, the abort names a side
   and a reason, and `ITEM-022`'s version gate ships first so the first player accused is not
   somebody running a stale bundle.

#### Blocker
Not blocked, but **ordered**: `ITEM-024` supplies the channel, `ITEM-022` supplies the
determinism that both attribution and rejoin stand on, and `ITEM-023` is what makes the log
the whole truth of a match. A referee over a wire that still carries resolved outcomes would
be verifying the sender's own arithmetic.

One hazard to handle before the first accusation: this project deploys on every push, so two
peers on different builds diverge innocently. Without `ITEM-022`'s version gate, the first
player this feature names as a cheat will be somebody whose browser cached yesterday's
bundle.

#### Affected Files
- `src/server/Referee.ts`, `src/server/MatchStore.ts` (new)
- `src/sim/MatchHost.ts` (new — the applier, shared with the replay runner)
- `src/game/Transport.ts`, `src/game/DataChannelTransport.ts`, `src/game/SocketTransport.ts` (new)
- `scripts/serve-match.ts` (new), `bun run serve:match`
- `src/game/NetworkManager.ts`, `src/game/JsonRpc.ts`, `src/game/Recording.ts`

#### The client side, which landed after the referee
"Play on a Match Server" is in the start menu: a URL, *Open a Match* or *Join the Match*, and
`hostOnServer`/`joinOnServer` on `NetworkManager`. The referee relays as well as watches, so the
handshake over a socket is the same one two peers do directly — which is what the transport port
bought.

One protocol addition was needed and is the interesting part: **`ready` now carries the sender's
loadout** beside its sheets. A referee refights a match from its intents, and a loadout is not
one of them — it reaches a *peer* as replicated component state, which is state its owner is
authoritative for rather than something anybody declared. So both sides now state their kit at
the one moment both know what they brought, and the host states the opening position to the
referee as `matchHeader`.

The kit is **refused rather than defaulted**, unlike the sheets next to it: a wrong sheet costs
display accuracy, a wrong weapon changes what every shot does. A peer whose loadout this build
cannot read deploys on the stock spread, which is what this side had already assumed.

Verified with two real `NetworkManager`s over real sockets against a real referee: the seed
reaches the joiner through the server, both sides exchange sheets and kit, intents are relayed
to the other side and never echoed to the sender, and the referee's own log refights to the
digest the referee itself holds. `tests/refereed.test.ts` runs that in CI against a `Bun.serve`
on port 0.

#### Acceptance Criteria
- [x] ~~A full match plays out with both clients as clients: no client resolves an attack.~~
      **The criterion was wrong and is restated**: it was written under the authority model,
      where the referee resolved and clients applied. The witness model this item's own *Why*
      section describes is the opposite — clients resolve everything, instantly, and the
      referee recomputes the same stream. Replaced by: *a full match is watched, and the
      referee's own world is the match.* A 59-intent match played over a real socket is
      recorded in full and reaches the digest an independent replay of the same stream reaches.
- [x] A client that disconnects mid-match rejoins and reaches the same state from the log.
      `resume { matchId, afterSeq }` is answered with the log after that point; replaying what
      it was handed reaches the referee's own digest. `afterSeq` exists so a client that has
      most of the log is not sent it twice.
- [x] A foul aborts the match, names a side and a reason, and keeps the log. Two kinds are
      caught: a client whose digest disagrees with the referee's recomputation, and an intent
      the referee *cannot carry out* — a disagreement about what was possible, which is larger
      than any disagreement about a number. A build mismatch is refused rather than judged, so
      the first player named is not somebody with a stale cache.
- [x] `bun run balance` byte-identical: 400 matches at seed 1000, unchanged.
- [x] **Persistence proven across the process boundary**, which was the real point: the referee
      was killed, the store reopened from disk, and the stored match replayed all 59 intents to
      the same digest the live client had computed.

---

### [ITEM-017] Doors, Locks and Keys
**Completed Date:** 2026-09-25  
**Type:** Feature  
**Milestone:** M2 — Tactical Depth  

#### Why
Targeted item use reached a squadmate, not a place or a thing: no key, no door. Picked up as
the next combat item after ITEM-034.

#### Scope, as built
The door half of [GDD: Interaction & Environment](../design/gdd/interaction-and-environment.md)
§2.3, with the verbs worked on the door a unit faces rather than through a generic item-target
step, and the keys as a permission the unlock verb asks for. A tile as an item's target was left
out: no item uses one yet.

#### Key Changes
- **Three wall kinds** (`core/Walls`, `core/Doors`): shut, open, locked; forced, a door is `None`.
  A door's state is the wall's `kind`, so it replicates, digests and rewinds with the walls.
  Shut or locked it is masonry to sight, cover and bullets; open, it is `open` like no wall, so
  fire and smoke go through it too.
- **Walking through** a shut door opens it, for `DOORS.openAp` on the step (`Grid.getStepCost`),
  so every planner prices it; the rules open it as the unit arrives, before anybody reacts.
- **`operateDoor`**: open and close (1 AP), unlock with the keys (1 AP; not used up), force
  (4 AP, heard 12 m off either way, gives at 30–75% by Strength — new derived stat `shoulder` —
  from the match's dice; a forced door is gone). Checked on both peers (`cannotWorkDoor`).
- **Keys**: a passive item with a permission (`ItemSpec.unlocks`) instead of a trait; two in the
  crate. The worn-kit invariant now reads "a trait or a permission".
- **The map** (`hangDoors`, own stream): shut doors in 60% of interior doorways and 80% of the
  ways in; locks on 10% / 35% of those, undone wherever a lock would leave ground reachable only
  through it.
- **HUD and view**: a row per verb for the door the unit faces, with the shoulder's odds; the tile
  readout names doors; timber doors, locked ones darker and redder; an open door drawn as its
  leaf; the debug map shows them. Catalogue §9 "Doors".
- Balance report: `doors:` line.

#### Measured
Mirror on blocks 1000/5000/9000: 607 / 562 / 31, from 605 / 564 / 31. About 14 doors a map; on
block 1000, 1.9 stand open at the end of a match. The policy never works a door on purpose.

#### Acceptance Criteria
- [ ] ~~An item can be pointed at a unit, a tile or a wall segment, through one selection
      step.~~ Restated with the scope above: a unit works the door it faces through one row in
      the action panel, and the keys are what the unlock verb asks for. No tile target.
- [x] A locked door refuses a push, opens to the keys, and both peers reach the same doors from
      the same commands (`tests/doors.test.ts`; browser: unlock, and a shoulder that held once
      and gave the second time). Keys open every lock: there is no "right" key yet.
- [x] A door's state survives a recorded replay: the same commands applied again as `record`
      leave the same doors.
- [ ] Open: the sweep's policy walks through shut doors but never shuts, unlocks or forces one,
      so doors are a player's tool the sweep barely measures. Not checked in two live browsers.

---

### [ITEM-004] After-Match Progression & the End Screen
**Completed Date:** 2026-09-25  
**Type:** Feature  
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

#### Measured
Block 1000, stock mirror; the rules are untouched (208 / 183 / 9). 2.6 surviving winners a match,
each with 4.4 rounds landed, 0.3 crits, 1.2 kills, 23 damage taken, 0.3 attacks on the unaware and
2.1 turns spent to the last point; at `PROGRESSION`'s thresholds each gains 0.53 attribute points
(Health 27%, Agility 26%) and 0.39 points of proficiency: a point every two matches or so. The
thresholds were set first and kept after the measurement, since that pace suits a roster that
will play many matches. Strength needs melee or plate (with knives and plate on Blue, 36% of
survivors); Intelligence stays at 0 because the policy never uses kit.

#### Acceptance Criteria
- [x] Both peers, and a replay, hold the same service record (`tests/progression.test.ts`: the
      same command applied as `local` and as `record`); the component is digested like any other.
- [x] Growth is a pure function of the sheet and the record; each change names its deeds; no
      scale is passed (a specialist's trained class keeps its head start at the top) and no
      attribute gains more than a point a match.
- [x] When one side is wiped out the match ends: in the browser (hot seat, seed 7) the loser's
      "Red — you lost", then "Blue wins" with each survivor's growth and "Nothing new this time"
      for one who learned nothing. The last Red units were set to 0 HP from the console rather
      than shot: the check is the same per-tick one either way.
- [x] The sweep reports records and growth per match.
- [ ] Not checked: the online end screen in two live browsers (each side its own page).
- [ ] Open: growth is shown and lost until persistence (`ITEM-012`).

---

### [ITEM-035] One of the Losers Carried Out Alive
**Completed Date:** 2026-09-25  
**Type:** Feature  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
With permadeath coming (ITEM-012), a lost match would wipe a squad out. The user, on 2026-09-25:
losers learn nothing — that is the point of permadeath — but one squadmate survives with HP
restored to 1, picked at random, preferably one without a condition that was getting worse, so
the loser takes at least something out of the match.

#### Key Changes
- `game/MatchEnd.carriedOut(squads, loser, grid, seed)`: one of the losing side, picked from a
  stream of the match seed (so both peers pick the same one and the match's dice are untouched),
  from those not lying in fire; from all of them when every one is.
- The loser's end-screen page names them: "Carried out alive, on 1 HP. The rest of the squad is
  gone." They learn nothing.
- Only fire counts as a worsening condition: there is no poison or bleeding in the game yet.
  Those would join the test when they exist.
- Nothing persists it yet: that is ITEM-012's post-match write, whose permadeath rule now names
  the exception.

#### Acceptance Criteria
- [x] The same seed picks the same unit, every unit can be picked, a unit in fire is passed over
      while anyone is not, and somebody is picked when all are (`tests/progression.test.ts`, red
      against mutants).
- [x] Shown on the loser's page (browser, hot seat, seed 7: "Garnet — carried out alive, on 1 HP").
- [ ] Open: persisted with 1 HP once ITEM-012 lands.

---

### [ITEM-036] Bleeding, and Ailments a First Aid Kit Treats
**Completed Date:** 2026-09-25  
**Type:** Feature  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
The user, before persistence: one more combat item — a bleeding status that behaves like a
critical. Any weapon, ranged or melee, may cause it, some more than others; some buffs prevent
it, as a Nullweave vest prevents crits; health packs stop it — and will stop poison, so the
design has to leave room for that.

#### Key Changes
- `Weapon.bleedChance` and `MeleeSpec.bleedChance`: sniper 35%, knife 45%, shotgun 25%, rifle
  15%, Gatling 8% a round, club 10%, fists never. `bleedChance(eff, target)` takes armour off as a
  crit's odds do (`BLEED.armorResist` = `CRIT.armorResist`), and nothing for `bleedImmune`.
- **Rolled like a crit**: once per landed round or blow, after the crit's draw, from the match's
  dice; no draw when the chance is 0 or the hit killed.
- **`StatusKind.Bleeding`**: 8 HP a stack at the start of the unit's own turn, armour ignored,
  with a wound's morale; stacks to 3; clots after three of its own turns.
- **Immunity**: new trait flag `bleedImmune` (replicated with the traits), on a new innate trait
  **Hardy** and on the **Nullweave** vest alongside its crit immunity.
- **Ailments**: `StatusSpec.ailment` and `damagePerTurn` make bleeding data, not a special case.
  The first aid kit gained a `treatAilments` effect that ends every ailment; `carriedOut`
  (ITEM-035) now also passes over the ailing. Poison is one more status entry.
- HUD: the status chip says what it costs a turn; the kit's panel says it stops bleeding. The
  kit's pre-pick counts an ailment as the HP it will still cost (`ailmentCost`), so a bleeding
  unit at full health is picked. **Fixed on the way**: picking a patient from the target strip
  did nothing — the strip sent `selectTarget`, which only ever chose an enemy.
  Catalogue: a Bleed column for guns and sidearms, and a paragraph on the rule.
- Balance report: `bleeding cost` per side per match.

#### Measured
Mirror on blocks 1000/5000/9000: 623 / 551 / 26. With bleeding off on the same build (Hardy
already reshuffles the rolled squads): 603 / 560 / 37. Bleeding costs a side 3–4 HP a match: the
sweep's fights are short and lethal, and plate halves a rifle's odds.

#### Acceptance Criteria
- [x] Every weapon and sidearm has its own chance; armour lowers it; immunity zeroes it
      (`tests/bleeding.test.ts`, red against mutants).
- [x] A landed round rolls for it after the crit; an immune target costs no draw (and the dice
      counts in `hitmodel` / `melee` tests say exactly what a round or blow draws).
- [x] It costs HP per stack at the start of the unit's own turns and clots after three; a first
      aid kit ends it and leaves other statuses; the one carried out is not a bleeding one while
      anyone else is not.
- [x] In the browser (seed 7): a unit at full health bleeding twice shows "Bleeding x2" on its
      card; the first aid kit's panel lists "Treats wounds, Stops bleeding"; the kit pre-picks
      that unit and ends the bleed.
- [ ] Open: the sweep's policy never treats a bleed, and bleeding barely moves its numbers.

---

### [ITEM-012] Permadeath & Campaign Roster Persistence
**Completed Date:** 2026-09-26  
**Type:** Feature  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Squads were rolled per match and forgotten on exit, so the growth `[ITEM-004]` shows at the
end screen was shown and lost. Per [RFC-0001](../design/rfc/0001-referee-and-transports.md) §9
persistence is the foundation the rest of the GDD stands on.

#### Key Changes
- **A portable database port** (`src/server/db/Db.ts`) on `Bun.SQL`: one tagged-template
  interface over SQLite and Postgres, no ORM and no driver. Where the database finally lives
  (Durable Objects or a central Postgres) is still open, so every query obeys stated
  portability rules and the whole suite runs against both engines when
  `TICTAC_TEST_POSTGRES_URL` is set.
- **Forward-only migrations** (`src/server/db/migrate.ts`): no `down`, idempotent, one
  transaction per migration together with the row recording it, and three refusals — ids not
  `1..n`, a name that disagrees with the database's, and a database from a *newer* build.
  `STORE_VERSION` and its `PRAGMA user_version` are gone.
- **`MatchStore` on the port**, asynchronous, with the append-only triggers moved into
  migration 1 and spelled for both engines (`RAISE(ABORT, …)` / plpgsql).
- **Passkeys, and nothing else** (`src/server/Accounts.ts`, `WebAuthn.ts`, `Api.ts`): no
  password, no email, no third party. Challenges are deleted as they are read, origin and
  relying-party are checked, the signature counter must move, and only ES256/RS256 are
  accepted. Sessions store a hash, never the token; a socket gets in with a single-use ticket.
- **Rosters** (`src/server/Rosters.ts`): registration deals one server-rolled squad, the
  referee refuses a match whose deployed squad is not that player's roster (and refuses one
  player on both sides), and `settlement()` (`src/game/MatchEnd.ts`) reads the finished match —
  winners grown, the losers' carried-out unit kept unchanged, everyone else dead. Settling is
  idempotent on `match_results`.
- **The referee writes through a queue** (`Referee.enqueue` / `idle`), so an asynchronous
  database never delays a judgement and two writes cannot race into a log whose numbering is
  its meaning. A failed write aborts the match.
- **Client** (`src/game/Account.ts`, `src/main.ts`): the match-server panel signs in, and a
  signed-in player deploys the roster the server holds. Local and P2P play are untouched — they
  still roll a fresh squad and write nothing.

See [ARCH-PERSISTENCE](../architecture/persistence.md) for the whole shape.

#### Acceptance Criteria
- [x] A signed-in player's squad survives the match, the tab and the process.
- [x] The winner's survivors come back grown; the dead do not come back.
- [x] The loser keeps exactly the one carried out, with nothing learned.
- [x] A squad that is not the server's roster aborts the match instead of settling.
- [x] Offline, local and P2P play are unchanged.
- [ ] Split out: an empty slot is not refilled (`ITEM-037`), and health and lasting wounds are
      not carried between matches (`ITEM-038`).

---

### [ITEM-028] Log and Store Schema Drift Guard
**Completed Date:** 2026-09-26  
**Type:** Infrastructure  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
[RFC-0001](../design/rfc/0001-referee-and-transports.md) §9: once a roster is derived from a
stored log, the log is a schema, not a debug dump. The *database* schema was already guarded by
forward-only migrations; nothing guarded the shape of what is *in* the rows. `PROTOCOL_VERSION`
was documented as "bumped by hand when the shape of the wire changes" since it was written, but
nothing made anybody actually do it — a command or a replicated component could gain, lose or
rename a field, every test would stay green, and a stored match or a live cross-build match
would silently stop meaning the same thing twice.

#### Key Changes
- `scripts/schemaCatalog.ts` extracts, without hand-copying either shape:
  - every `NetworkMessage` variant's fields, read off the union's own TypeScript parse tree in
    `src/game/NetworkManager.ts` (no type-checker needed — each variant is already an object
    type literal), including whether a field is optional;
  - every replicated component's shape, by instantiating one with its constructor defaults
    (`src/ecs/components/index.ts`) and reflecting the keys `serialize()` returns, recursively.
- The result is checked into `docs/schemas/wire-shape-catalog.json`, generated with
  `bun run schema:catalog`.
- `bun run schema:catalog --check` (`scripts/build-schema-catalog.ts`, thin over the pure
  `decide()` in `schemaCatalog.ts`) fails in exactly two situations: the shape changed and
  `PROTOCOL_VERSION` did not move (bump it), or the shape changed, the version moved, but the
  catalog was never regenerated (regenerate it). A change that touches no shape passes
  regardless of the version, and reordering fields is not a shape change — every comparison
  sorts keys recursively first.
- Wired into `bun run lint` (`schema:catalog:check`), and so into CI, with no workflow file
  changed.
- **Known limit**, stated in both the code and the docs rather than solved: a component whose
  default construction leaves a field empty (`StatusesComponent.list = []`) reflects as
  `"array<unknown>"`, not the shape of one `StatusState` — a realistic fixture for every
  component would itself be a hand-maintained second source of truth.

See [ARCH-NETWORKING §7](../architecture/networking.md#7-schema-drift-guard-item-028).

#### Acceptance Criteria
- [x] Adding, removing or renaming a field of a command or replicated component fails CI until
      the matching version is bumped and the recorded shape regenerated.
- [x] A change that does not touch a shape passes untouched.

---

### [ITEM-038] Lasting Wounds: Persisted HP, Healing, and a Combat Log
**Completed Date:** 2026-09-26  
**Type:** Feature  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
The rest of [GDD §5](../design/gdd/progression-and-meta.md) `[ITEM-012]` did not carry: every
match deployed at full health, and the one carried out of a lost match — who the GDD has
leaving on 1 HP — came back whole. Narrowed at 2026-09-26 from the original item: the
fatigue/medical-bay AP and morale penalty had no numbers anywhere and touches live combat
systems rather than persistence, so it was filed separately as `[ITEM-039]` (not designed).

#### Key Changes
- **Migration 4** (`roster.hp`, `roster.deeds`), `src/server/db/migrations.ts`.
- **`RecordingHeader.startingHp?: Partial<Record<Faction, number[]>>`**
  (`src/game/Recording.ts`), `RECORDING_VERSION` moved to 3. A starting HP has to be something
  both peers and the referee agree on *before the first digest*, so it travels the same way
  sheets do — never injected by the referee after the fact. `ready` gained `hp?: number[]`
  (`src/game/NetworkManager.ts`), `PROTOCOL_VERSION` moved to 2.
- **`Squads`/`Soldier`** deploy below full HP when a `startingHp` override is given; absent
  everywhere except a kept server match, so local and P2P play deploy exactly as before.
- **`settlement()`** (`src/game/MatchEnd.ts`) now carries each fate's HP at match end and this
  match's own `Deeds`, regardless of who won — `survived`/`carried`/`died` all keep a record.
- **Healing, as a stated rule**: `Rosters.settle` moves a survivor's stored HP by
  `HEALING.perMatch` (0.5) of missing HP, scaled by the sheet's own `healBonus` — the Health
  attribute's documented second job (GDD §1: "dictates the speed of natural healing... in the
  meta-layer"). The carried-out unit is written at exactly `HEALING.carriedOutHp` (1). `deeds`
  accumulates match by match (`mergeDeeds`), never replaced — the "scars and combat log."
- **`Referee.verifyRosters`** now also checks a signed-in side's stated `startingHp` against
  the roster's own HP, aborting on a mismatch *or an omission* — the same class of attack a
  sheet mismatch already guarded against.
- **`maxHpOf(sheet)`** (`src/core/Characters.ts`), added after a bug this item's own testing
  caught: `derive(sheet).maxHp` is the attribute band alone and does not know about a
  character's own maxHp-raising trait (Juggernaut's +25) — gear resets every match, but an
  innate trait does not. Using the bare band would have enlisted such a character short of
  their real ceiling and clamped their healing below it forever after. Every ceiling `Rosters`
  uses is `maxHpOf`, which matches `Soldier.maxHp` exactly.
- Client: `Account.roster()` returns `hp` alongside sheets; `main.ts` threads it through
  `ready` and into `RecordingHeader.startingHp` when hosting or joining signed in.

See [ARCH-PERSISTENCE §5](../architecture/persistence.md) for the whole shape.

#### Acceptance Criteria
- [x] The unit carried out of a lost match is on the roster with the health the rules say, not
      with full health.
- [x] Healing between matches is a rule with a test, not an implicit reset.
- [x] Local and P2P play are unchanged: every soldier still deploys at full derived HP there.
- [x] A dead roster row's final HP and deeds are readable as history.

---

### [ITEM-040] The Animations Combat Never Got
**Completed Date:** 2026-09-27  
**Type:** Feature  
**Milestone:** M2 — Tactical Depth (presentation debt)  

#### Why
Three combat verbs shipped without a body to perform them, and three clips shipped in
`public/character.glb` that nothing ever played. The audit that opened the item:

| Verb | What the body did | Where |
| --- | --- | --- |
| Melee | Nothing. The attacker stood still; only the victim flinched, via `applyWeaponDamage` → `fx.hit` | `executeMelee` |
| Grenade throw | The *pistol fire* pose — `fx.shoot(thrower)` borrowed for a throw | `Combat.ts:474` |
| Use item, operate door | Nothing | `ItemSystem` |
| Reload | Nothing, though a `reload` clip was in the GLB | `CombatSystem.reload` |
| Overwatch | Nothing, though an `aim` clip was in the GLB and `watching` is replicated | `CombatSystem.overwatch` |
| Firing, flinching while crouched | The standing clip, whole: the unit stood up, fired, and dropped back to `crouch` on the mixer's `finished` event | `SoldierView.playShoot` |

#### Key Changes
- **The port widened**: `CombatFx` gained `melee`, `throwing` and `reload` beside `tracer`,
  `shoot` and `hit`. `executeMelee` announces the blow before the damage, `throwGrenade` no
  longer borrows `fx.shoot`, and `CombatSystem.reload` announces the magazine. Item use needed no
  new port: `ItemSystem.onItemUsed` already existed and the controller already listened on it.
- **Four more clips, one fewer**: `Punch_Cross` → `punch`, `Sword_Attack` → `swing`,
  `Spell_Simple_Shoot` → `throw`, `Interact` → `interact`; `Walk_Loop` dropped, because standing
  movement always runs. 2.05 MB → 2.43 MB. A knife shares the punch with fists at the user's
  call — a thrust and a cross read the same from the camera's distance — so only the club swings.
- **Crouched actions are additive overlays** (`additiveClips`, `SoldierView`): each action clip is
  copied with every track below the spine dropped and the rest taken relative to the first frame
  of `idle` (`AnimationUtils.makeClipAdditive`). The crouch loop keeps running and the overlay
  accumulates on top of it, so nothing has to put the legs back. Death is exempt: a unit that dies
  crouched still collapses.
- **A watch is a stance**: `RenderSystem`'s stance key gained `-watch`, so `aim` loops whole while
  standing and as an overlay while crouched, resuming after any action that interrupts it — and a
  peer's watching unit poses off the same replicated `StanceComponent.watching` a local one does.
- **A door is worked, not merely opened**: `CommandSystem.onDoorWorked` fires in the
  `operateDoor` case, after the points are spent and *before* the shoulder is rolled — so a force
  that does not give is still a shove — and on both peers, because both resolve the intent. The
  controller plays `interact` on the worker. The same hook turns the unit through the doorway,
  `targetYaw` only: `heading` is what decides attacks from behind, and a door is not a turn the
  rules make. The implicit open that a step performs is left alone; the walk carries it.

#### Measured
`bun run balance` is unchanged, as a presentation-only change must be: the pinned sweep in
`tests/balance.test.ts` passes untouched.

In a local-versus match in a browser, driven through the real command path
(`toggleCover`, `overwatch`, `reload`): hips at 0.873 m standing, 0.474 m crouched, and
0.469–0.477 m through an entire crouched fire and reload — while the gun hand travels 0.6 m.
Crouched watch holds `crouch` + `aim:additive`; standing watch is `aim` itself. Each sidearm
picks its clip (`fists`/`knife` → `punch`, `club` → `swing`), and a throw, a use and a shot each
play their own. A door: `interact` on the worker, the wall going `Door` → `DoorOpen`, yaw turned
to the doorway; crouched, the same door is `crouch` + `interact:additive` with the hip at
0.477 → 0.471 m.

#### Found on the way
- `docs/guides/asset-pipeline.md` claimed Draco geometry compression. No Draco pass has ever run:
  the build only whitelists clips and prunes accessors, and the shipped GLB lists no extensions.
  The guide now says what the script does. The runtime still points `DRACOLoader` at
  `public/draco/`, so a compressed asset would load if one were produced.
- `tests/support/dom.ts` needed `document.getElementsByTagName`: three's example modules probe for
  a `<script>` tag at import time, and under the canvas stub the missing method was an unhandled
  error in whichever suite imported `GLTFLoader` — which the new animation suite does.

#### Acceptance Criteria
- [x] A blow plays a swing or a punch on the attacker, chosen by the sidearm, on both peers: the
      announcement is in the shared resolver (`tests/melee.test.ts`), and the view picks the clip
      from replicated inventory.
- [x] A thrown grenade no longer plays the pistol fire pose.
- [x] A crouched unit that fires, reloads or is hit keeps its legs crouched throughout
      (`tests/animation.test.ts`, and the hip measurements above in a browser).
- [x] Reloading and going on overwatch are visible on the body, crouched or standing.
- [x] `character.glb` ships no clip nothing plays: the asset and the played set are asserted equal
      in `tests/animation.test.ts`.
- [x] Working a door — opened, shut, unlocked, or shouldered and held — plays on the worker and
      turns them through the doorway (`tests/doors.test.ts`, and the browser run above).
- [x] No rules change: the pinned balance sweep is identical.

---

### [ITEM-010] Roles on the Loadout Screen
**Completed Date:** 2026-09-27  
**Type:** Feature  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Every unit was interchangeable apart from its generated character sheet: the crate had no
opinion about who drew from which row.

#### Key Changes
- **`src/core/Roles.ts`**: `RoleId` (Rifleman, Medic, Scout, Marksman) and `ROLES`, a
  `RoleSpec` per id — the weapon, attachment and item ids it may draw (absent means every row,
  which is what Rifleman is: the pre-existing default, unrestricted) and the one trait its
  training earns. Lives in `core/` rather than `game/Loadout.ts` so `entities/Soldier.ts` can
  read it without a reverse dependency on the game layer.
- **A fourth `TraitSource`**: `role`, beside `innate | wound | gear`. A role's trait folds in
  the moment it is picked (`Soldier.refreshTraits`, `TraitSource.Role`) and is deliberately
  outside `gearRelief`'s reach — training is not weight a soldier is carrying, so Strength
  does not cancel any of it. Three new traits: `roleMedic` (never bleeds), `roleScout` (+6
  evasion, steps a sixth cheaper) and `roleMarksman` (a fifth less range falloff, +8 accuracy
  crouched).
- **`UnitLoadout.role`** travels the same path every other slot does: `defaultLoadout` seeds
  Rifleman, `applyUnitLoadout` stamps it onto the soldier before the first trait fold,
  `Squads.loadoutOf` reads it back, and `squadLoadoutFrom` (`game/Recording.ts`) validates a
  file's or a peer's role the same way it validates a sidearm — refused if this build does not
  know it, defaulted to Rifleman if the slot predates roles.
- **The gate**: `canEquipWeapon`, `canFitAttachment` and `canAddItem` (`game/Loadout.ts`) check
  the holder's role before the crate's stock. `setRole` is the one new mutator — free to press,
  but a role that cannot cover what a unit is already holding drops it: the weapon falls back
  to the role's first allowed choice (rail trimmed the same way a downgrade trims it), and
  disallowed attachments and items are cleared. `remaining()` counts what is listed, so nothing
  dropped needs a refund.
- **`LoadoutScreen.ts`**: a Role section above Weapon, four buttons, always pressable. The
  squad card shows the picked role under the name and folds its trait into the sheet the same
  way a worn vest or a fitted scope already does. Four new icons
  (`role-rifleman/medic/scout/marksman`, `scripts/icons.json`).

#### Measured
`bun run balance` unaffected: every `SquadPlan` in `SimMatch.ts` defaults to
`RoleId.Rifleman` — unrestricted, no trait — so the sweep's policy plays exactly as it did
before roles existed.

In a local-versus match in a browser: assigning Marksman to a Gatling-armed unit fell back to
Rifle and disabled Shotgun; Scope and Bipod stayed pickable, Suppressor did not. Assigning
Medic disabled the Nullweave Vest, Plate Carrier and Keys rows and left Stim Pack, First Aid
Kit and Repair Kit open; the card showed "COMBAT MEDIC". The match deployed and played a turn
with no console errors.

#### Found on the way
- The generated [status and trait catalogue](../design/gdd/status-and-trait-catalog.md) reads
  its sources from `ITEMS`/`ATTACHMENTS`/wounds/innate only; `scripts/build-catalog.ts` needed
  a fourth lookup (`roleTraitIds`) or the three new traits would have printed as `unreachable`.

#### Acceptance Criteria
- [x] Medic, Scout and Marksman each narrow which weapon/attachment/item rows a unit may draw
      from, and each grants one trait nothing else does.
- [x] Rifleman (the pre-existing default) is unrestricted and grants nothing, so every squad
      that never touches the Role row plays exactly as before.
- [x] A role change never leaves a unit holding kit the new role forbids.
- [x] No rules change for a role-blind squad: the pinned balance sweep is identical.

---

### [ITEM-037] Recruits Fill an Empty Roster Slot
**Completed Date:** 2026-09-28  
**Type:** Feature  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Since `ITEM-012` a character who dies is marked dead and the slot they held is simply empty: a
player who loses two people fields two, forever. Persistence had stopped there on purpose —
where new people come from is a mechanic in its own right, and hard-wiring "the server rolls
you a replacement" would have settled cost, a pool, and an economy that does not exist yet by
accident.

#### Decision
A free, server-rolled recruit — the same roll `enlist` already deals a fresh squad
(`characterSheet`, seeded from system randomness), at no cost, because no economy prices one
yet. A hire from a pool or a paid cost both need a design this milestone does not have; a free
recruit needs none of it and is strictly better than the status quo (an empty slot forever) in
every case it changes. If a cost or a pool arrives later, the free roll is the thing it prices
— nothing here forecloses that.

#### Key Changes
- **`Rosters.recruit(playerId, rng?)`**: scans a player's `active()` roster for the lowest slot
  `0..SQUAD_SIZE-1` not already held, rolls one `characterSheet`, and inserts it through the
  same `roster_active_slot` partial index every settlement already writes through — the index,
  not this method's scan, is what actually stops two recruits landing on one slot. A dead row
  is untouched: it stopped being the active occupant the moment `record` marked it, so the
  history a player is building stays exactly where it was, one row per past occupant of the
  slot. Refuses (`AuthError(400, …)`, the one refusal type the whole API surface already
  throws) when every slot is already held — there is nothing to fill.
- **`POST /api/roster/recruit`** (`src/server/Api.ts`), bearer-authed like every other roster
  route: `{ member }` on success, `400` on a full roster.
- **`Referee.verifyRosters` needed no change.** It already compares a deployed squad against
  whatever `active()` currently returns; a recruit is simply one more row that call returns the
  next time a squad is fetched, the same way a settlement's growth already is.

#### Measured
No rules or sim code touched — `bun run balance` was not re-run, since nothing it exercises
changed. `bun test` (`tests/persistence.test.ts`, `tests/accounts.test.ts`): a killed slot
recruits back to a full squad with the old row left `dead` and unrelated to the new occupant's
`character_id`; a full roster refuses recruitment with `400` and `"already full"`; the same
path exercised through `apiHandler` end-to-end (a real registration, a real SQLite `roster`
table, no mocks) rather than unit-only.

#### Acceptance Criteria
- [x] A player whose character died can field a full squad again — a free server-rolled
      recruit — and the dead row stays in the table as history. Through the API only: no
      client screen calls `POST /api/roster/recruit` yet.
- [ ] ~~A short-handed squad still deploys and still settles~~ — ticked at the time on the
      strength of `verifyRosters` alone, and wrong: the short squad was topped up with a
      made-up fourth unit. Found and fixed as `[ITEM-041]`.

---

### [ITEM-041] A Short-Handed Roster Fielded a Phantom Unit
**Completed Date:** 2026-09-28  
**Type:** Bug  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Found while designing `[ITEM-039]`. A signed-in player with three living characters sent
three sheets and three HP values, the referee accepted them — and `Squads` built four units
anyway, because it always looped to `SQUAD_SIZE`. The fourth got a default sheet
(`characterSheet(new Rng(squadIndex + 1))`), fought, and was never settled, since the side
only has three character ids. On a peer, `startingHpFrom` refused any array that was not
exactly `SQUAD_SIZE` long, so the other side deployed the short squad at full health while the
referee deployed it wounded. `ITEM-037` had ticked "a short-handed squad still deploys and
still settles" without testing it.

#### Key Changes
- **`Squads`** fields exactly as many units per side as the header states sheets for, up to
  `SQUAD_SIZE`; no sheets stated at all (a sweep, a stock match) is still the full stock
  squad. Creation stays interleaved Blue/Red by index, so a full squad's entity ids and
  `soldiers` order do not move.
- **`startingHpFrom`** accepts one to `SQUAD_SIZE` entries.
- **The loadout screen** sizes its kit (`defaultLoadout(size)`), its cards and the
  `LoadoutScene` arc to the people deploying.
- **Nobody left**: the referee refuses a signed-in side with an empty roster, and the
  menu says so before connecting — a header with no sheets means the stock squad to
  `Squads`, which would be the same phantom four times over.
- **`RECORDING_VERSION` 3 → 4**: a version-3 header with a short squad replays differently
  now, which is the rule for a bump.
- **`SquadPlan.size`** and `bun run balance -- --blueSize=N`, so the sweep can price a man down.

#### Measured
`bun run balance` with full squads is identical to before (Blue 55, Red 43, 2 draws; mean 9.27
turns). `--blueSize=3`: Blue 34, Red 66, no draws. A man down costs 21 points of win rate —
worse than a fair fight, not a forfeit.

#### Acceptance Criteria
- [x] A refereed match with a roster whose slot 1 is dead deploys the three living, in slot
      order, and settles exactly those three (`tests/persistence.test.ts`); the test fails on
      the old `Squads` with four blue units.
- [x] A short squad's starting HP survives the wire (`tests/recording.test.ts`).
- [x] A signed-in player with nobody left is refused, not given a stock squad.
- [x] Full squads unchanged: the balance report is identical.

Superseded in part by `[ITEM-043]`: `startingHpFrom` and the separate `sheets`/`loadouts`
arrays this item widened no longer exist, folded into one `Deployment[]`. Nothing here was
wrong — the mechanism just moved.

---

### [ITEM-043] One Deployment Record Per Soldier, Not Parallel Lists
**Completed Date:** 2026-09-29  
**Type:** Refactor  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
A squad crossed the wire as several same-length arrays matched by position only: `sheets`,
`loadouts`, `startingHp` on `RecordingHeader`; `sheets`, `loadout`, `hp` on `ready`. Nothing
tied their lengths together. `[ITEM-041]` was exactly that failure: `startingHpFrom` enforced
`length === SQUAD_SIZE` on its own array while `sheets` had already gone short, so a
short-handed side's HP was silently dropped rather than read. `[ITEM-042]` wanted to add a
character id per soldier and `[ITEM-039]` wanted to add fatigue; bolting each onto its own
parallel array would have made five lists that all had to agree, with the same failure mode
five times over.

#### Key Changes
- **One shape** (`src/game/Recording.ts`): `DeploymentState { hp?, fatigue? }` — a bag on
  purpose, room for what comes after without another wire shape — and `Deployment { characterId?,
  sheet, loadout?, state? }`. `ready.squad: Deployment[]` and
  `RecordingHeader.squads: Record<Faction, Deployment[]>` replace the three parallel arrays.
- **`loadout` is optional on the type**, not the required field the design sketched. A peer's
  kit sometimes cannot be read (a newer build naming a weapon this one does not know), and
  `Squads` already had a real, distinct fallback for that — the raw stock spread, not
  `applyUnitLoadout` with a made-up loadout — which zeroes a starting Stim Pack and First Aid
  Kit that the stock path leaves alone. Folding "no kit" into a required field would have
  erased that distinction; an absent `loadout` keeps it exactly.
- **Two validators, not one.** `unitLoadoutFrom` (per soldier) and `deploymentsFrom` (per squad,
  strict: 1 to `SQUAD_SIZE`, throws same as `squadLoadoutFrom` did) replace `sheetsFrom`,
  `squadLoadoutFrom` and `startingHpFrom` for a header or a file. `NetworkManager`'s `ready`
  handler keeps its own leniency on top of `unitLoadoutFrom`: one unit's unreadable kit still
  costs the whole squad's, the same all-or-nothing failure the old code made — sheets and state
  arrive regardless, since HP now lives next to the sheet it belongs to rather than in a
  neighbour's slot.
- **`Squads`** drops `loadout`/`loadoutFaction`/`sheets`/`startingHp` for one
  `squads?: Record<Faction, Deployment[]>`; `equipFaction` and the never-called `adoptSheets`
  are gone, replaced by `deploymentsOf(faction)`, which reads a squad's sheets, kit and current
  HP back in the shape a header states them — used everywhere a header or `ready` used to be
  assembled from three separate reads.
- **`PROTOCOL_VERSION`** 2 → 3 (`ready`'s shape moved), **`RECORDING_VERSION`** 4 → 5 (a
  version-4 header's three arrays would zip a sheet against the wrong unit's kit the moment
  they disagreed — the schema catalog now refuses one with a stated reason).

#### Measured
`bun run balance` is identical to the `[ITEM-041]` baseline (Blue 55, Red 43, 2 draws, mean
9.27 turns) and to its `--blueSize=3` case (Blue 34, Red 66) — a refactor, not a rule change.
`bun test`: all 654 tests, including every `ready`-parsing edge case (nonsense sheets, an
unreadable kit, a missing squad) rewritten against the new shape. In a browser: a local match
deploys both squads, plays a shot and a full turn handover with no console errors.

#### Acceptance Criteria
- [x] No behaviour change: every existing test passes against the new shape, and `bun run
      balance` matches the pinned baseline exactly.
- [x] `deploymentsFrom` refuses a squad of 0 or more than `SQUAD_SIZE`, and every other refusal
      the old three parsers made (unknown weapon, unknown sidearm, unknown role) still fires,
      now from one place (`unitLoadoutFrom`).
- [x] A version-4 recording is refused with a stated reason, the same way a version-2 one is.

---

### [ITEM-042] The Bench: a Roster Bigger Than the Squad
**Completed Date:** 2026-09-30  
**Type:** Feature  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
A roster was exactly a squad: four people, all of whom deployed every match. So "who fights"
was never a decision, and nothing that depends on *not* deploying someone — resting them,
keeping them out while they recover — could mean anything. `[ITEM-039]` is built on this item.

#### Key Changes
- **`ROSTER.size = 6`** (`src/config.ts`), beside `SQUAD_SIZE = 4`. Registration deals six
  (`Accounts.register` → `rollSquadSheets(rng, ROSTER.size)`); `Rosters.recruit` fills the
  lowest empty slot of `0..ROSTER.size-1` instead of `0..SQUAD_SIZE-1`.
- **Picking the squad.** `src/hud/RosterScreen.ts`, a DOM-only overlay shown ahead of
  `LoadoutScreen` for a signed-in player: every active member by slot, HP and attribute summary
  — deliberately no callsign, since `FACTION_INFO.squadNames[index]` is assigned by *deployed*
  position and would promise one this screen cannot keep. Toggling picks 1 to `SQUAD_SIZE`,
  defaulting to the first four in slot order; an empty slot renders a **Recruit** button in its
  place instead of a member row.
- **The referee no longer compares position for position.** `verifyRosters` looks each deployed
  unit's stated `Deployment.characterId` up in the player's active roster (a `Map`, not an
  index), so a squad can be any 1–4 of the six, in any order — not only the first four slots.
  Once a name resolves, the same two checks as before run against the row it names: sheet
  (`sanitizeSheet` both ways) and `state.hp`, exactly. A missing id, an id that is not this
  player's, one that is not active, or one repeated within the same squad all abort with one
  message; a sheet or HP mismatch keep their own, existing ones.
- **Nothing new on the wire.** `Deployment.characterId` already existed from `[ITEM-043]`; this
  item is the first thing that populates it for a kept roster (still absent for a rolled one).
  `PROTOCOL_VERSION` and `RECORDING_VERSION` do not move — `bun run schema:catalog:check` passes
  unchanged, since the shape it is checking did not.
- **Rest heals.** `Rosters.settle` now heals every active roster member *not* named in a side's
  `characterIds` too, by the same survivor formula (`HEALING.perMatch` of missing HP, scaled by
  `healBonus`, clamped to `maxHpOf`) — without touching `matches` or `deeds`. Resting is not a
  match.
- **The ticket is minted after the pick, not before.** `main.ts`'s `equip()` shows the roster
  screen first and calls `account.socketUrl(url)` — which mints a single-use, 60-second ticket
  — only once `RosterScreen.pick()` resolves, so a player who lingers choosing a squad cannot
  burn the window before ever connecting.
- **`Account.roster()`** returns a client-local `RosterEntry[]` (`src/game/Account.ts`), not the
  server's `RosterMember` — `src/game`/`src/hud` do not import `src/server/`, even for a type.

#### Measured
`bun run balance` is identical to the `[ITEM-043]` baseline (Blue 55, Red 43, 2 draws, mean 9.27
turns) — the sweep has no roster, so nothing here could move it. `bun test`: all 655 tests,
including a dedicated bench rest-heal case and a referee test that picks a squad that is *not*
the first four roster slots. In a browser, against a real `bun run serve:match`: a freshly
registered player's roster screen shows six members, defaults to the first four picked; toggling
a non-default four (deselecting slot 1, selecting slot 5) and continuing carries exactly those
four sheets into the loadout screen (confirmed by their HP matching the picked slots, not the
default ones); Deploy proceeds to "Waiting for opponent to deploy" — the referee accepted the
non-default squad live. Separately, with one roster slot marked dead, the roster screen renders
it as `Empty` with a Recruit button; clicking it calls the live endpoint and splices the new
member into the slot in place, with no page reload.

#### Acceptance Criteria
- [x] Registration deals six; recruiting fills up to six and refuses a seventh
      (`tests/accounts.test.ts`, `tests/persistence.test.ts`).
- [x] A signed-in player deploys any 1–4 distinct active members, and the refereed match settles
      exactly those — tested with a pick that is *not* the first four slots
      (`tests/persistence.test.ts`, and live in a browser).
- [x] The referee aborts a stated id that is not this player's, is dead, repeats, is a fifth, or
      whose sheet or HP differs from the roster's.
- [x] A benched member heals by the survivor rule and does not count the match; a deployed one is
      settled exactly as today.
- [x] In a browser against `bun run serve:match`: pick four of six, recruit into an empty slot,
      deploy, and the match plays with the picked four.
- [x] No rules change: `bun run balance` is identical (the sweep has no roster).

---

### [ITEM-039] Fatigue & Medical-Bay Downtime
**Completed Date:** 2026-09-30  
**Type:** Feature  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Split out of `[ITEM-038]` at 2026-09-26: [GDD §5](../design/gdd/progression-and-meta.md) also
wants "fatigue over consecutive deployments" that temporarily lowers baseline AP and morale, and
"medical-bay downtime" for severe injury. Both only meant something once a player could choose
not to deploy somebody, which the bench (`[ITEM-042]`) made possible.

#### Key Changes
- **Stored.** Migration 5 adds `roster.fatigue` (0–`FATIGUE.max`, 4) and `roster.downtime`
  (≥ 0), both integers defaulting to 0 — the only stored numbers; AP and morale are derived from
  `fatigue` when a unit is built, never stored beside it.
- **Settling** (`Rosters.record`/`Rosters.rest`), per settled match of the player: deployed
  raises `fatigue` by one, capped at `FATIGUE.max`; benched lowers it by two and `downtime` by
  one, both floored at zero; a carried-out survivor's `downtime` is set to
  `MEDICAL_BAY.carriedOut` (2), one who ended at or below `WOUNDS.concussed` of their ceiling to
  `MEDICAL_BAY.concussed` (1).
- **The penalty**, from the stored level at deployment: `max(0, fatigue − 1)` steps, each
  `FATIGUE.apPerStep` off max AP and `FATIGUE.moralePerStep` off starting morale — so the first
  back-to-back match is free. `Soldier` takes a starting fatigue the way it already takes a
  starting HP; the AP step is one more term in `refreshTraits`' `maxAp` sum, and
  `MoraleComponent` starts at `MORALE.max − FATIGUE.moralePerStep × steps`.
- **Calibrated, not guessed.** `-1` AP a step, the design sketch's own number, cost 14 wins in
  100 at level 2 against a target of "at most 5" — `effectiveMaxAp`'s `Math.round` turns out to
  erase anything under half a point from a whole-number ceiling, so a half point a step
  (`FATIGUE.apPerStep = 0.5`) is invisible at one step and lands as a whole point at two: level 2
  measures 0 and level 4 measures 20, both inside their bands. `FATIGUE.moralePerStep` stayed at
  10 — morale's own threshold (`MORALE.steady`, 50) is far enough from `MORALE.max` that it
  contributes nothing at these levels either way, and is here for when a match's own morale
  losses stack on top of it.
- **Medical bay.** A member with `downtime > 0` cannot be picked: `RosterScreen` greys their row
  with the matches left instead of their attributes and refuses the toggle, and the default pick
  skips them; `Referee.verifyRosters` refuses a header that deploys one regardless, the same way
  it refuses a dead or foreign id.
- **On the wire**, in `Deployment.state.fatigue` — already part of the shape since `[ITEM-043]`,
  so no array and no version move. The referee checks a deployed unit's stated fatigue against
  the roster's own the same strict way it already checks `state.hp`: present and exact, not
  defaulted when absent.
- **Measured**, `SquadPlan.fatigue` and `bun run balance -- --blueFatigue=N` (every unit at level
  N), calibrated against a man down (`--blueSize=3`: Blue 55 → 34, `[ITEM-041]`).

#### Measured
`bun run balance`: unchanged (Blue 55, Red 43, 2 draws, mean 9.27 turns) — the sweep has no
roster and level 1 is free by design, so nothing here could move the baseline.
`--blueFatigue=2`: Blue 55 (cost 0, inside "at most 5"). `--blueFatigue=4`: Blue 35 (cost 20,
inside "10 to 21"). `--blueSize=3` reconfirmed at Blue 34 (cost 21), unmoved by this item.
`bun test`: all 665 tests, including settlement's fatigue/downtime transitions and the referee's
medical-bay and fatigue-mismatch refusals. In a browser against a real `bun run serve:match`: a
roster with one member's `downtime` set to 2 shows that row as "Medical bay — 2 matches left",
unpickable, skipped by the default pick; the match played to a live first turn on both sides.

#### Acceptance Criteria
- [x] Settling moves `fatigue` and `downtime` exactly as specified, including the caps and
      floors (`tests/persistence.test.ts`).
- [x] A unit deployed at level N has its sheet's max AP minus `FATIGUE.apPerStep × max(0, N − 1)`
      and starting morale `MORALE.max − FATIGUE.moralePerStep × max(0, N − 1)`
      (`tests/fatigue.test.ts`) — the per-step numbers moved from the design sketch's `-1`/`-10`
      during calibration, as the item's own escape hatch allowed.
- [x] A member in the medical bay cannot be picked, and the referee aborts a header that
      deploys one (`tests/persistence.test.ts`).
- [x] The referee aborts a stated fatigue that differs from the roster's.
- [x] `bun run balance -- --blueFatigue=4` costs Blue 20 wins in 100 (inside 10–21) and
      `--blueFatigue=2` costs 0 (inside "at most 5"); `bun run balance` without the flag is
      identical.

---

### [ITEM-044] A Live Match Never Actually Stated Its Own Squad's Id or Fatigue
**Completed Date:** 2026-09-30  
**Type:** Bug  
**Milestone:** M4 — Competitive & Meta Roster  

#### Why
Found while wiring `[ITEM-039]`'s fatigue onto the wire. The host's `matchHeader` — what a
referee actually judges — is built from `Squads.deploymentsOf`, reading back the live `Soldier`s
a match already deployed, not from the `Deployment[]` a client handed `Squads` at construction.
`deploymentsOf` read a soldier's sheet, kit and HP, but never carried `characterId` or
`state.fatigue` at all — both existed on the `Deployment` going *in*, and neither survived
coming back *out*. Every real, live, signed-in match since `[ITEM-042]` shipped would therefore
have stated no `characterId` for anyone on either side, and `Referee.verifyRosters` would have
aborted every one of them the moment a real referee saw one — a client's own live gameplay had
simply never gone through `Squads` to notice, since `[ITEM-042]`'s own tests built headers by
hand and its one browser session only confirmed the client reached "waiting for opponent", never
that the referee actually accepted what was sent.

#### Key Changes
- `Soldier` takes `characterId` and `startingFatigue` the way it already takes `startingHp`:
  stored as `readonly characterId?: string` and `readonly fatigue: number`, fixed for the match.
- `Squads`' constructor passes `deployment?.characterId` and `deployment?.state?.fatigue`
  through to each `Soldier`; `deploymentsOf` reads both back onto the `Deployment` it returns,
  alongside the sheet, kit and HP it already read.

#### Measured
A direct regression test (`tests/recording.test.ts`) builds a `Squads` from a `Deployment`
naming a `characterId` and a `state.fatigue`, and asserts `deploymentsOf` states both back —
failing against the code as it stood before this fix, by inspection. Confirmed live: a real
signed-in match, played end to end through the actual match-server UI in a browser against
`bun run serve:match`, reached a first turn on both sides with the referee logging
`watching match …` and no abort verdict — the same header-building path this bug lived in.

#### Acceptance Criteria
- [x] `Squads.deploymentsOf` states the `characterId` and `state.fatigue` a `Deployment` named it
      with; a rolled squad (no `characterId` given) states none.
- [x] A live signed-in match, built through the real `Squads`/`deploymentsOf` path rather than a
      hand-built header, is accepted by a real referee.
---

### [ITEM-045] Cloudflare Durable Object Deployment
**Completed Date:** 2026-10-01  
**Type:** Infrastructure  
**Milestone:** Unscheduled — infrastructure, not a milestone deliverable  

#### Why
[RFC-0001 §7](../design/rfc/0001-referee-and-transports.md#7-deployment) named two hosting
options for a public referee and built neither: "a Durable Object per match, or one central
Postgres." A referee on a developer's own machine (`bun run serve:match`) is fine for
development but is not a *deployment* — nobody else's browser can reach it, and there is
nothing running when the developer's machine is off. GitHub Pages stays the default deployment
path throughout — this is an *additional*, optional path for hosting a match server, not a
replacement for it.

#### Key Changes
- **One Durable Object, not one per match.** `workers/MatchDurableObject.ts`, addressed by
  `env.MATCH.idFromName('singleton')` from `workers/index.ts` — a match server is one referee,
  the same reason `startGameServer` binds one port to one `Referee`. The RFC's other phrasing,
  a Durable Object per match, is not what this deployment does.
- **The one DO serves both** a WebSocket upgrade and every other request (static assets via
  `env.ASSETS.fetch(request)`, `/api/…` via `apiHandler`) — `run_worker_first: true` in
  `wrangler.jsonc` routes every request through the Worker rather than letting the assets layer
  answer some of them directly.
- **A `Db` adapter over `ctx.storage.sql`** (`workers/DoSqliteDb.ts`). `Db.transaction` is async,
  built around `Bun.SQL`'s genuinely asynchronous protocol; `ctx.storage.sql`'s own transaction
  primitive, `transactionSync`, requires a callback with no `await` at all, which every caller
  (`migrate.ts`, `Rosters.settle`) is written without. The adapter keeps what a Durable Object's
  own request serialization already gives for free — overlapping `transaction` callers never
  interleave — and is honest about what it does not add: rollback on throw, the way the
  `Bun.SQL` adapter's `sql.begin()` does (`docs/architecture/deployment.md` §3).
- **The real `Referee`, not a relay.** `MatchDurableObject` runs the same `Referee`,
  `Persistence` (via a new `persistenceOverDb`) and `apiHandler` that `startGameServer` runs
  behind `Bun.serve`. **A match socket does not hibernate**: `Referee`'s open-match state has no
  durable backing, and hibernation evicts the whole object, so sockets use plain
  `server.accept()` rather than `ctx.acceptWebSocket()` — a reversal of this item's first,
  "planted" pass, which hibernated every socket including a match's.
- **Two files split for the isolated typecheck**: `src/server/db/Db.ts` used to import `bun`'s
  `SQL` type for its one `Bun.SQL`-specific implementation, which pulls in `@types/node`'s
  ambient `NodeJS` namespace — conflicting with `@cloudflare/workers-types`' own the moment both
  are reachable from one TypeScript project, which wiring the real `Referee`/`apiHandler` into
  `workers/` made true transitively. The Bun-specific halves moved to `src/server/db/BunSqlDb.ts`
  and `src/server/SocketTransport.ts`. `workers/tsconfig.json` typechecks `workers/` in isolation
  (`bun run typecheck:cf`, wired into `bun run lint`), excluded from the root `tsconfig.json`.
- **`src/sim/WireMatch.ts`**: elevates `SimMatch` — already able to play a decisive match
  deterministically, both sides, in milliseconds — to send that same command stream through two
  real `NetworkManager`s connected to a referee instead of only applying it in memory. The
  reusable answer to "prove a whole match reaches settlement" without scripting one by hand or
  driving two browsers. Commands are sent one at a time, each awaited until the other side's
  socket has received the referee's relay of it, because two independent sockets give no
  ordering guarantee against each other the way one connection gives against itself — firing
  them all at once raced a real referee's client registration and hung, over real network
  latency (not in-process `Bun.serve`).
- **Deployed for real**: `https://tictac-match-server.waldemar-reusch.workers.dev`, the
  account's default `*.workers.dev` subdomain. `wrangler.jsonc`'s `vars` set
  `RELYING_PARTY_ID`/`RELYING_PARTY_ORIGINS` to that exact host — a `*.workers.dev` subdomain is
  on the public suffix list, so the relying party id has to be the full host, not just
  `workers.dev`.
- **`src/main.ts`'s match-server field auto-detects its own origin**: `probeOwnOriginServer`
  tries a WebSocket at `location.host` and prefills the box only if one answers, rather than
  hardcoding a local-dev default. True at this deployment (one Durable Object serves both the
  client and the referee from the same origin) and false on GitHub Pages (no backend at all) —
  nothing about either host is named in the code.

#### Measured
`tests/cloudflare.test.ts` runs a real local Workers runtime (`wrangler dev`, spawned via
`bunx`) and drives it over real HTTP and WebSocket: a passkey ceremony, a ticket, a signed-in
socket, an anonymous one, an invalid ticket turned away with 401, a non-JSON-RPC frame dropped
without crashing the connection, and a whole decisive match reaching settlement
(`src/sim/WireMatch.ts`) with the Durable Object's own independent recomputation over
`ctx.storage.sql` agreeing on the winner. `tests/refereed.test.ts` runs the identical wire
function against the in-process `Bun.serve` referee and checks its digest and stored log agree
with the local sim bit for bit. `bun run typecheck:cf` keeps `workers/` typechecking in
isolation. `wrangler deploy --dry-run` was run repeatedly during development; a real
`wrangler deploy` against an actual Cloudflare account was run once credentials became
available, and the live deployment was independently verified by hand: a real passkey
registration, ticket and signed-in socket against
`https://tictac-match-server.waldemar-reusch.workers.dev`, an anonymous socket, an invalid
ticket rejected the same way, and a whole decisive match driven through it end to end with no
abort. The match-server auto-detect was verified in a real headless browser against both
`wrangler dev` (auto-fills, immediately shows a real account status) and a plain static file
server with no backend — the shape GitHub Pages serves — which leaves the field empty with a
placeholder hint.

#### Acceptance Criteria
- [x] `bun run cf:dev` serves the built client and accepts a WebSocket connection, through one
      Durable Object.
- [x] `workers/` typechecks in isolation (`bun run typecheck:cf`) without pulling DOM types into
      the main `tsconfig.json`, and without the main `tsconfig.json` pulling in
      `@cloudflare/workers-types`.
- [x] `tests/cloudflare.test.ts` runs a real local Workers runtime and passes in `bun test`,
      self-contained (builds `dist` itself rather than assuming a prior build step).
- [x] `.github/workflows/deploy.yml` (GitHub Pages) is untouched and remains the default
      deployment path.
- [x] A `Db` adapter over `ctx.storage.sql` — correct for `query`/`exec`, and for `transaction`
      in every case that does not throw partway through; does not roll back a partial failure
      the way the `Bun.SQL` adapter's `sql.begin()` does, stated plainly rather than pretended
      otherwise.
- [x] `Referee`/`Persistence`/`apiHandler` wired into `MatchDurableObject`, replacing the bare
      relay a first pass planted.
- [x] A real `wrangler deploy` against an actual Cloudflare account, verified with a real passkey
      registration, ticket and signed-in socket against the live deployment.
- [x] A whole decisive match reaches settlement through this deployment end to end, proven
      against both `wrangler dev` and the real live deployment. Left deliberately narrower than
      an earlier phrasing: this is an anonymous match, not a *registered* one whose roster is
      checked afterward — that needs the wire harness to deploy a squad sourced from a real
      roster's exact rows rather than its own freshly-rolled sheets (`Referee.verifyRosters`
      checks for an exact match), a different piece of work left open for whoever picks it up
      next.
- [x] The match-server field prefills its own address when one answers at the page's own origin,
      and leaves it empty otherwise, with nothing about either host named in the code.
---

### [ITEM-051] Retreat: the Rule and the Player's Command
**Completed Date:** 2026-10-02  
**Type:** Feature  
**Milestone:** Unscheduled  

#### Why
A fight ended only when one side had nobody left standing (`winnerOf`). There was no way to cut
losses, which matters now and will matter more once the AI fights for absent players
(`ITEM-048`, `ITEM-053`). Design: [GDD combat §2.8](../design/gdd/combat-mechanics.md#28-retreat).

#### Key Changes
- **The way out** (`src/core/Retreat.ts`): a side's deployment rows across the full width of the
  map, from `DEPLOY_INSET`/`DEPLOY_ROWS`, which `generateMap` now draws its zones with too.
  `leaversOf`, `cannotRetreat`, `watchersOf`, and `retreatChance` in whole percent (`RETREAT` in
  `config.ts`: 60, ±20 morale, ±20 health, −15 per watching enemy, clamped 5–95).
- **`retreat { faction }`**, side-level with no actor, like `endTurn`. The roll is the match's
  dice. Caught → `CommandSystem.handOver` (the `endTurn` body, now shared). Away → leavers'
  `health.withdrawn` set, everyone else left behind at 0 HP.
- **The match ends by who is on the field**: `Soldier.onField`; `winnerOf`, `MatchHost.living`
  and `SimMatch`'s loop count it, so the referee, the client and `AiOpponent` all see a retreat end
  the match with no code of their own.
- **Settlement**: `escaped()` grows the leavers from their deeds; they settle as `survived`, the
  left-behind as `died`, and `carriedOut` is null after a withdrawal. The planned separate
  `withdrew` fate was not needed: a leaver's fate has exactly the shape and roster treatment of any
  survivor's, so `Rosters` and `Referee.settle` are unchanged.
- **Panic runs for home**: `Breakdown.fleeTo` ranks exposure, then not closing on the nearest
  enemy, then rows from the way out, then distance from the enemy.
- **The player's command**: a Retreat button beside End Turn that asks twice and names who would
  be left behind; a note when an attempt is caught; a "you got out" end screen listing the leavers
  and what they learned.
- **Protocol** 3 → 4: `retreat` method, `health.withdrawn`, regenerated wire-shape catalogue.
- Fixed in passing: `tests/cloudflare.test.ts`, broken since the deploy set the production relying
  party in `wrangler.jsonc`; the test now pins the local one with `--var`.

#### Measured
`tests/retreat.test.ts`: the way out holds every spawn of 20 maps; the chance falls with morale,
health and watchers and clamps; a success withdraws the leavers, kills the stragglers, ends the
match for the stayer, settles leavers grown and nobody carried out; a failure hands over; refusals
out of turn and with nobody on the way out; a recorded retreat replays to the same digest. A new
morale test (panic in the open moves toward its own rows without closing on the enemy) fails on the
old flight and passes on the new. `bun run balance` was identical before and after the rules
commit; panic-runs-home moved it slightly (wins unchanged at 55/43/2, mean turns 9.27 → 9.36).
In a real browser, local versus, seed 11: turn one offers "Retreat · 95%", it arms, confirms, and
ends on "BLUE — YOU GOT OUT" then "RED WINS". Not exercised end to end: a referee settling a
*registered* retreat into `roster` through the socket (settlement is tested at the function the
referee calls; `Rosters` is unchanged).

#### Acceptance Criteria
- [x] A side with someone on its way out can retreat on its own turn; one with nobody there cannot.
- [x] A successful retreat ends the match: the stayer wins and grows; leavers settle with their HP,
      wounds and growth (as `survived` — see above); the left-behind are dead on the roster.
- [x] A failed roll ends the turn and the match goes on.
- [x] Both peers and the referee agree on every roll (the match's dice, one `MatchHost`); a
      recorded match containing a retreat replays identically.
- [x] A panicking unit flees toward its own way out.
- [x] `bun run balance` before/after recorded; `tests/determinism.test.ts` passes.
- [x] Living documentation updated.

---

### [ITEM-052] The AI Can Retreat: Standing Orders
**Completed Date:** 2026-10-02  
**Type:** Feature  
**Milestone:** Unscheduled  

#### Why
An AI that cannot retreat fights every fight to the last soldier. Once it plays for absent
players (`ITEM-048`, `ITEM-053`) that costs real characters, and an enemy that runs is better to
fight against than one that never does.

#### Key Changes
- **`StandingOrder`** in `src/sim/Policy.ts`: `stand` (default), `cautious` (first wound or
  death), `opportunist` (known contacts outnumber its living units, or half its starting HP gone),
  `evade` (at once). Read from the side's own state and `Intel`'s contacts only.
- **Pulling out** latches: units that take orders walk to the reachable tile fewest rows from the
  way out, one tile per intent; once everyone who takes orders is on it the side calls `retreat`.
  Simpler than the planned `chooseDestination` walk-cost field, and enough.
- **Where an order comes from**: `SquadPlan.order` for a sweep (`--blueOrder=`, `--redOrder=`),
  `PolicyOptions.orders` for anyone else. `AiOpponent` stays on `stand`; choosing an AI squad's
  order per encounter is `ITEM-048`'s.
- **Reporting**: `MatchOutcome.withdrew`; the sweep report's `retreats`, printed only when any
  happened.

#### Measured
`bun run balance` on `stand` is byte-identical to the post-`ITEM-051` baseline. Blue's order
against Red on `stand`, 100 matches: evade 0–100, retreated 100, 1.03 turns; cautious 2–98,
retreated 88, 4.82 turns; opportunist 29–69 (2 draws), retreated 57, 6.88 turns.
`tests/orders.test.ts`: stand never retreats however hurt; evade retreats on turn one; cautious
holds unhurt and goes once wounded; opportunist holds fresh and goes at half health; across 15
seeds a cautious side never calls retreat before it has been hurt; a match the AI retreated from
replays to the same digest.

#### Acceptance Criteria
- [x] Each order behaves as named in headless matches (tests drive each to its trigger).
- [x] No order reads enemy state the side has not seen.
- [x] `bun run balance` with every side on *stand* is identical to the post-`ITEM-051` baseline;
      sweeping the other orders reports how often each gets away.
---

### [ITEM-055] Render the HUD and Menus with React
**Completed Date:** 2026-10-04  
**Type:** Refactor  
**Milestone:** Unscheduled  

#### Why
Every HUD and menu surface was a string template assigned to `innerHTML`: 18 sites in `Hud.ts`,
8 in `main.ts`, 4 in `DebugMap.ts`, one each in `LoadoutScreen`, `RosterScreen`, `DebugPanel`,
`PlaybackControls` and `FullscreenPrompt`. Each assignment threw the old elements away, causing
scroll jumps (worked around in `5c7a457`), click loss during redraws, unescaped values, and
intents serialized as JSON in attributes.

#### Key Changes
- **React 19 & TSX**: React 19 + `react-dom` installed, `tsconfig.json` enabled `"jsx": "react-jsx"`,
  bundled natively with Bun.
- **Shared `<Icon>` component** in `src/hud/Icon.tsx` replaces the `icon()` string helper from
  the deleted `src/hud/icons.ts`.
- **Surfaces ported to `.tsx`**:
  - `src/hud/Hud.tsx`: TopCentre, LevelSelector, CornerActions, EndTurn, SquadBar, TargetStrip,
    ActionPanel (submenus, ShotCard, ThrowCard, ItemCard), TurnOverlay, EndScreen, ContextMenu,
    TileReadout.
  - `src/hud/LoadoutScreen.tsx`: Squad crate pool, kit panel, soldier cards and sheets, deploy button.
    The scroll save-restore loop from `5c7a457` was removed as DOM reconciliation preserves scroll.
  - `src/hud/menu/StartMenu.tsx` & `src/hud/menu/InterruptedOverlay.tsx`: Menu, lobby, Host P2P,
    Join P2P, Match Server passkey/roster flows, disconnection overlay.
  - `src/hud/RosterScreen.tsx`, `src/hud/PlaybackControls.tsx`, `src/hud/FullscreenPrompt.tsx`.
  - `src/hud/DebugMap.tsx` & `src/hud/DebugPanel.tsx`.
- **Test DOM**: `@happy-dom/global-registrator` registered locally in `tests/debugmap.test.ts`
  and cleaned up in `afterAll` so headless suites remain DOM-free.
- **Zero `innerHTML` left** across `src/hud/` and `src/main.tsx`.

#### Measured
- Full suite: 690 pass, 0 fail. `bun run lint` and `bun run build` clean.
- Bundle size change: 4,052,339 B → 4,262,037 B (+209.7 KB unminified, +65.4 KB gzipped).
- In-browser verification: Start menu (modes, flows, back buttons), Loadout screen (scrolling
  panel holds position across kit changes), in-match HUD (action buttons, targeting, submenus,
  minimap with ESC close, debug panel, two-step retreat, end screen).

#### Acceptance Criteria
- [x] No `innerHTML` assignment left in `src/hud/` or `src/main.tsx` for app markup.
- [x] Every surface verified in a real browser: menu, lobby, roster, loadout (scroll survives a
      pick with no restore code), the in-match HUD (select, shoot panel, items, end turn,
      retreat), the end screens, playback controls, debug map/panel.
- [x] `bun run lint`, `bun test`, `bun run build` green; the bundle size change recorded.
- [x] Living documentation updated (`docs/architecture/rendering.md`, `docs/architecture/overview.md`,
      `AGENTS.md`).
---

### [ITEM-056] The Deployed Match Server Refused Every Client It Served
**Completed Date:** 2026-10-05  
**Type:** Bug  
**Milestone:** Unscheduled — infrastructure  

#### Why
`https://tictac-match-server.waldemar-reusch.workers.dev` could not be played on at all.
Opening a match dropped straight back to the start menu; joining one failed with a connection
error. Both were the same cause: under [ADR-0004](../design/adr/0004-full-knowledge-lockstep.md)
the referee recomputes every intent, so `src/version.ts` applies to it as much as to a peer —
it states its own build and refuses a client whose build differs. `BUILD_ID` arrives through a
build-time `--define`, and the client and the Worker are built by two different tools:
`scripts/build-bundle.ts` for `dist/`, wrangler's own esbuild for `workers/index.ts`. Wrangler
knew nothing about the first one's define, so the deployed referee reported `dev` and turned
away the very bundle it had just served.

`tests/cloudflare.test.ts` was green throughout, because it drove `wrangler dev` from a test
process whose own `BUILD_ID` is the same `dev` fallback the unstamped Worker reported. The two
agreed; no browser could.

#### Key Changes
- **`scripts/wrangler.ts`** — a prefix for `cf:dev`/`cf:deploy` that reads
  `dist/build-id.txt` (now written by `scripts/build-bundle.ts`) and passes
  `--define __BUILD_ID__:"<id>"` to wrangler. The file rather than a second `git rev-parse`,
  because what must match is the client *in `dist/`*. It also spawns the installed wrangler
  binary rather than `bunx wrangler` and forwards `SIGINT`/`SIGTERM`, so `wrangler dev` stops
  its `workerd` instead of orphaning it.
- **`VersionVoices` in `src/version.ts`** — a refusal names both machines and both hashes.
  Between peers: *this page* / *the other player*. From a referee: *the match server is running
  build X, this page is running build Y*, with the remedy that follows from it (reload a stale
  tab; redeploy a mis-stamped server). The old text said "this page is running dev", which
  described the one machine that was not.
- **A refusal is shown, not swallowed.** An incoming `abort` is taken at `NetworkManager`'s edge
  and becomes the stated disconnect reason, instead of being forwarded to a controller that does
  not exist yet during the handshake; `showMenu(notice)` renders it. Previously the host saw the
  menu reappear with no explanation and the joiner saw whatever the socket said as it closed.
- **A host answers every `hello`.** Exposed once builds matched: a referee relays live and keeps
  nothing for a latecomer, so the `init` a host sends when it opens a match is gone by the time
  an opponent connects, and both sides waited on each other forever. The host now restates its
  opening — and its `ready`, if it has already deployed — whenever a `hello` arrives. Neither is
  an event and neither is recorded, so repeating them costs nothing.
- **`tests/cloudflare.test.ts` drives the real pairing**: `wrangler dev` through
  `scripts/wrangler.ts`, with its clients speaking `dist/build-id.txt`'s id, so losing the define
  fails every socket test rather than none. One test asserts the refusal text directly. Its
  readiness poll now bounds each `fetch`, and it clears the port before and after — a half-dead
  `workerd` from an earlier run accepted connections, answered nothing, and hung `beforeAll`
  until the runner's own timeout.

#### Measured
- Full suite: 708 pass, 0 fail. `bun run lint` clean. `tests/cloudflare.test.ts` run three times
  consecutively: green each time, no `workerd` left behind.
- In two real browsers against a locally stamped deployment: host opens, joiner joins, both
  deploy, turn 1 reached with the referee watching. Against the still-unstamped live deployment,
  the client now returns to the menu with the refusal printed rather than silently.

#### Acceptance Criteria
- [x] The Worker reports the build id of the bundle it serves, under `wrangler dev` and `wrangler deploy`.
- [x] A build refusal names both machines and both hashes.
- [x] A refusal reaches the player instead of an unexplained return to the menu.
- [x] A match opened on a server can be joined afterwards and played.
- [x] A test fails if the Worker's stamp is lost again.
- [x] Living documentation updated (`docs/architecture/deployment.md` §2.4,
      `docs/architecture/networking.md` §3/§5).
---

### [ITEM-057] Group the Start Menu by Who Is on the Other End
**Completed Date:** 2026-10-05  
**Type:** Refactor  
**Milestone:** Unscheduled  

#### Why
The first screen was a flat list of six buttons, and nothing on it said that the six were three
different kinds of thing. A match server keeps an account, watches the match and remembers what
it did; a peer is another browser and nothing else; offline is nobody at all. That distinction
decides whether signing in means anything, whether an id has to be exchanged, and whether a
result is kept — and it was the one thing the menu did not show. `StartMenu.tsx` was also 642
lines holding every panel's state and one inline `style` object per element: ten near-copies of
the same button, five of the same text field, each free to drift.

#### Key Changes
- **Three groups, each with a heading and a sentence**: *Match Server* (sign in with a passkey;
  your squad is kept), *Peer to Peer* (straight to another browser; nothing is kept), *Offline*
  (nobody on the other end). Tone follows the group, so a panel reached from one keeps its
  colour.
- **`src/hud/menu/controls.tsx`** — `MenuButton` (tone, size, grow), `MenuInput`, `MenuGroup`,
  `StatusLine`, `PanelTitle`, and the tone/colour tokens. The only inline styles left are the
  menu card itself and the few one-off lines of prose.
- **`src/hud/menu/ServerPanel.tsx`** owns the address, the passkey ceremony and both ways into a
  refereed match. The "who am I on this server" lookup is one `identify(url)` returning a
  `ServerIdentity`, instead of the same five `setState` calls written twice. Its passkey row is
  a column now — the name field above the two buttons — because three abreast wrapped both
  labels onto three lines each.
- **`src/hud/menu/PeerPanel.tsx`** holds `HostPanel` (the id, and copying it) and `JoinPanel`
  (the id, and using it), each with its own state and its own focus and copy-reset timers,
  cleaned up by their effects rather than left running.
- **`StartMenu.tsx` keeps only** the choice between groups and the remembered match-server
  address — the one piece of state that is a preference rather than a panel's business — and is
  under 200 lines. The title lost its `P2P`: peer-to-peer is one of three groups now, not what
  the game is.
- Every DOM id is unchanged (`#btn-local`, `#btn-server-mode`, `#server-url`, `#join-status`, …),
  so anything hooked onto them still works.

#### Measured
- `bun run lint` and `bun test` green; no behaviour changed.
- Every path exercised in a real browser against a local Durable Object deployment: the three
  groups; the server panel (address prefilled by the origin probe, account status, passkey row);
  Join P2P (autofocus, a bad id reporting *Could not connect to peer …*); Host P2P (broker id and
  copy); *Play Against the AI*; and a whole refereed match — host opens, joiner joins, both
  deploy, turn 1 — to prove the extracted panels still drive the same callbacks.

#### Acceptance Criteria
- [x] The main screen groups its choices by match server, peer-to-peer and offline.
- [x] Panels own their own state; `StartMenu` keeps only the choice and the remembered address.
- [x] One set of shared controls; no per-element copies of the same style object.
- [x] Every flow verified in a browser, including a full refereed match.
- [x] Living documentation updated (`docs/architecture/rendering.md`).
---

### [ITEM-058] A Lobby of Many Matches, With Spectators and One Window per Player
**Completed Date:** 2026-10-07  
**Type:** Feature  
**Milestone:** Unscheduled — infrastructure  

#### Why
A match server held exactly two players. Its `Referee` watched one match for the life of the
process and could never open a second; every socket that connected was treated as part of that
one match, a third socket was silently labelled Red, and the same player in two browser windows
was indistinguishable from an opponent. There was no way to see who was waiting, nothing to
watch, and nothing stopping a signed-in player from being in two places at once.

#### Key Changes
- **Rooms** (`src/server/Lobby.ts`, `src/server/Room.ts`, which replaces `Referee.ts`). A room
  is one match: a Blue seat, a Red seat, any number of spectators, and the referee's own
  recomputation. The server holds any number of them; a socket states its intent in its url
  (`open`, `join`, `watch`, `resume` — `src/game/Lobby.ts`) and is answered with one `seated`
  frame. Frames are routed within the room: intents to the other seat and every spectator,
  setup frames to the other seat only, nothing from a spectator.
- **One match per player; one live window per player.** A player in a match being played who
  asks for anything else is put back in it. A player's newest window replaces the old one
  wherever it was: the old window is told why and closed; a match already being played moves to
  the new window, rebuilt from the referee's log; a match still being set up is abandoned
  rather than moving a half-equipped loadout between windows. A signed-in seat that drops
  mid-match is held for two minutes for the player to come back.
- **`GET /api/lobby`** lists rooms not over (waiting for an opponent / in progress, with names,
  turn, spectators, and a seat that is reconnecting) and the asker's own seat.
- **The lobby panel** (`src/hud/menu/ServerPanel.tsx`, `LobbyList.tsx`): *Open a Match*, *Join*
  on a waiting room, *Watch* on one in progress, polled every two seconds; it takes a playing
  match over automatically when the player opens it in a new window.
- **The browser's side** (`NetworkManager.connectToServer`, `main.tsx` `takeSeat`): a seat being
  set up goes to the loadout as before; a seat in a match being played is rebuilt from the log
  (`InteractionController.catchUp`) and played on; a spectator watches it like a recording that
  is still being written, with a `SpectatorBar` and a way back.
- **Protocol 6.** `seated` added; the in-band `resume { matchId, afterSeq }` removed.
- **Two bugs that aborted every refereed match at its first handover**, found by playing one
  through a real Durable Object: `Squads.loadoutOf` read pouches back *with* the issued stones,
  so the header deployed every soldier with twice as many; and fog (`SightedComponent.seen`)
  was serialised, so each window's view was digested as if it were state. Both fixed, each with
  a regression test that fails before and passes after (`tests/recording.test.ts`,
  `tests/digest.test.ts`).

#### Measured
- `bun test`: 737 pass, 0 fail, including `tests/cloudflare.test.ts` against a real `workerd`.
  New: `tests/lobby.test.ts` (listing, join/refusals, spectators, redirect, takeover in play and
  in setup, grace and its expiry, a second match after the first), connect/log/buffering/
  spectator-silence tests in `tests/network.test.ts`, takeover and spectating over real sockets
  in `tests/refereed.test.ts`.
- In Chromium against a local Durable Object, four windows: a signed-in host opened, an
  anonymous player joined from the lobby, both deployed and played a full round through the
  referee's digest checks; a spectator watched from the lobby and caught up; the host opened a
  second window, which took the match over (the old one showed *You opened TicTac in another
  window; this one was disconnected.*; catch-up took 33 ms) and played two more handovers the
  referee accepted. At the end all three live windows agreed on every unit's tile and HP.

#### Acceptance Criteria
- [x] A lobby lists hosts waiting for a match and matches being played.
- [x] A waiting match can be joined; a match in progress can be watched read-only.
- [x] A signed-in player can only ever be in one match.
- [x] A player's state follows them to a new window, and the old window is disconnected with a
      reason; a match still being set up is dropped instead of moved.
- [x] Living documentation updated (`docs/architecture/networking.md` §8,
      `docs/architecture/deployment.md` §2, `docs/architecture/persistence.md`,
      `docs/architecture/rendering.md`).
---

### [ITEM-059] Matches Survive Restarts and Deploys; Windows Reconnect to Their Seats
**Completed Date:** 2026-10-07  
**Type:** Infrastructure  
**Milestone:** Unscheduled — infrastructure  

#### Why
`ITEM-058`'s rooms lived only in memory: a restart, a Durable Object eviction or a deploy lost
every open match, and every player in one saw the match end. A deploy is also a version change,
and the browsers in those matches keep running yesterday's bundle — which the version gate turned
away at the door. A deploy has to be something a player in a match barely notices.

#### Key Changes
- **Durable rooms.** `src/server/RoomStore.ts` (migration 6, `rooms`) holds each live room —
  seats, phase, build, roster sides, whether it is still judged — written through the room's
  ordered write chain; `Lobby.restore()` brings every one back before the first socket is
  accepted, rebuilding a playing room's referee world from its stored header and events.
- **Seat keys and grace for every seat.** `seated.seatKey` (only its hash is stored) lets the
  same window take its seat back with no ticket, signed in or not; it is not a new window. Every
  dropped seat in every phase is held for two minutes rather than aborting the room at once.
- **Rolling updates.** `OLDEST_SERVED_PROTOCOL` (the previous protocol; 6 is the floor, since
  nothing older can reconnect at all) and the room's own build admit the old bundle back into the
  match it was in; opening, joining and watching still need the current build. A room from another
  build is witnessed rather than judged: it relays, records and recomputes, and if the new rules
  ever disagree it stops judging instead of aborting, and keeps nobody's roster. A ratchet in
  `tests/version.test.ts` keeps the server serving the previous protocol on every bump.
- **Reconnect in the browser.** `NetworkManager` redials its seat after 250 ms, 500 ms, then every
  second, each try abandoned after 2 s, for up to two minutes, behind a small "reconnecting…"
  banner with the seat's input suspended. In a match being played it replays only what it missed,
  or rebuilds from the referee's log if one of its own intents never arrived; on the loadout
  screen it restates hello/init/ready. A decided server match lets its seat go, so a restart under
  the end screen does not lay "That match is gone." over the result.

#### Measured
- `bun test`: 765 pass, 0 fail. New: `tests/restart.test.ts` (waiting, deploying and playing
  rooms surviving a restart and settling; grace expiry after restore; a rolling update finished by
  the old build; cross-build divergence witnessed; protocol floor), keyed-reclaim tests in
  `tests/lobby.test.ts`, the backoff/give-up/resync decisions in `tests/network.test.ts`, and real
  server restarts mid-match, mid-deploy, with a lost intent and with a spectator in
  `tests/refereed.test.ts`. Store tests also run on Postgres.
- A rolling update under `wrangler dev` with persisted storage: two browsers on build `3713528`
  played a turn; the server was replaced by build `c3df148` over the same storage; both windows
  reconnected by themselves, played two more handovers whose digests the new server accepted, and
  agreed on every unit. A page on the new build saw the old match listed and was refused watching
  it; the old build was refused opening a new one; protocol 5 was refused outright.
- Reconnect timing, two headless seats across a `wrangler dev` restart: the server answered again
  3.1 s after it went down, and both seats were back in the same 50 ms poll — the client adds no
  stall of its own. The first browser measurement exposed two client waits that did (a 4 s backoff
  cap and a 5 s per-try timeout, each adding seconds after the server was back); both were cut to
  what is now shipped. Background browser tabs reconnect later than foreground ones, because the
  browser throttles their timers.

#### Acceptance Criteria
- [x] Open matches — waiting, deploying and playing — survive a server restart or redeploy.
- [x] A match in progress can be finished by the previous build across a deploy, with a stall
      and nothing else.
- [x] The server keeps serving the previous protocol, and a test fails if a bump forgets to.
- [x] Living documentation updated (`docs/architecture/networking.md` §8,
      `docs/architecture/deployment.md` §2.3, `docs/architecture/persistence.md`).
---

### [ITEM-060] One Connection per Window: the API Over JSON-RPC
**Completed Date:** 2026-10-07  
**Type:** Infrastructure  
**Milestone:** M5 — The Shared World  

#### Why
A signed-in window talked to its match server two ways: HTTP `fetch` to `/api/*` (passkeys,
sign-out, `me`, the roster, recruiting, the lobby, socket tickets) and a WebSocket for the room
it sat in. The second channel cost a ticket to bridge the two (a session token must not go in a
url), a CORS policy for GitHub Pages, and a lobby polled every two seconds because HTTP cannot
push. The world map and encounters need a channel the server can push down, and the socket the
one-window-per-player rule already governs is that channel. The user's decision (2026-10-07):
one connection per window, reused for everything.

#### Key Changes
- **The contract** (`src/game/Rpc.ts`): requests `tictac/api/account/{registerOptions,
  registerVerify,loginOptions,loginVerify,signIn,signOut,me}`, `tictac/api/roster/{list,recruit}`,
  `tictac/api/lobby/{subscribe,unsubscribe}`, `tictac/api/room/{enter,leave}`; pushes
  `tictac/api/lobby/changed` and `tictac/api/session/replaced`; `RPC_ERRORS` keeps the HTTP codes
  the routes answered (a 401 is still a 401). Match frames stay notifications on the same socket.
- **Server** (`src/server/Session.ts`, `Sessions.attach(transport, { url, place })`): `hello`
  first, then requests answered one at a time in arrival order. A refusal is an error response
  and the socket stays open; only the version gate, `session/replaced` or the client giving up
  end a connection, and a room's `abort` ends room membership, not the session. `Lobby` gains
  `enter`, `leave` and `subscribe` (pushes coalesced per burst of changes). `src/server/Api.ts`,
  tickets in `Accounts`, the API's CORS and `parseIntent`/`intentQuery` are deleted; the
  Durable Object hands upgrades to `Sessions` and everything else to its assets, and reads
  `request.cf` onto the session for `ITEM-063`.
- **Version admission**: protocol 7 at any build is admitted at the gate; `room/enter`
  open/join/watch from another build is a `409` naming both builds; a resume follows the room's
  build; `signIn`/`loginVerify` are a `409` when the player's playing seat is in a room this
  build cannot carry, so a newer tab cannot cut off the window that can finish it.
- **Sign-in holds seats.** `signIn` replaces the player's previous socket and holds its seat for
  the grace in every phase, because the same window reconnecting signs in before it re-enters by
  key. A setup room is abandoned only when the new window enters other than by that key, or the
  hold expires.
- **Protocol 6 for one release**: admitted only for a keyed resume named in its url
  (`Sessions.resume6`, `resumeOf6`) and answered the protocol-6 way, so a match in progress
  finishes across the deploy; marked for deletion when `OLDEST_SERVED_PROTOCOL` reaches 7.
- **Client** (`src/game/ServerConnection.ts`): one per window per server, held at module level in
  `main.tsx` (`connectionFor`, `leaveServer`). `request`, `watchLobby` (pushed, never polled),
  `signedIn`/`signedOut`, and `enter(intent, member)` returning the `Transport`
  `NetworkManager.enterRoom` plays over. Reconnect keeps `ITEM-059`'s schedule (250/500/1000 ms,
  then every second, 2 s per try, give up after 120 s) and re-establishes hello → signIn →
  lobby/subscribe → room/enter by seat key. `Account` is a thin wrapper over the connection;
  the server panel is driven by it.

#### Measured
- `bun test`: 792 pass, 0 fail. New: `tests/session.test.ts` (7: lobby pushes, room vs socket,
  refusals as answers on one socket, sign-in replacing a window while holding its seat, the
  protocol-6 resume and nothing else), `tests/serverConnection.test.ts` (8: request settling,
  refusals, timeouts, unreachable servers, lobby pushes, the re-establish order, token
  forgetting, replacement); `tests/accounts.test.ts` (11), `tests/network.test.ts` and
  `tests/refereed.test.ts` rewritten over `ServerConnection`; `tests/cloudflare.test.ts` drives
  passkeys, a token nobody issued (`401`, socket open) and the build gate (`409` on
  `room/enter`) over the socket against `workerd`.
- In Chromium against `wrangler dev`: each window holds one session socket from the server
  panel through a passkey registration (`registerOptions`/`registerVerify` on it, no HTTP), the
  lobby (a room opened in one window appeared in the other by a `lobby/changed` push), a match
  and its end (`room/leave` on the same socket). A second window signing in as the same player
  replaced the first, which showed `SESSION_REPLACED`. Two further sockets exist around it, both
  older than this item: the menu's own-origin probe (opened and closed before any server is
  chosen) and the page reload a finished match's way back to the menu does (`backToMenu`).
- Across a deploy under `wrangler dev`: two Chromium windows of build `81ec4a7` (protocol 6)
  playing on that build's Worker, which was then replaced by this one over the same storage,
  were each re-seated on the first socket that opened (`seated`, then `log`; no rebuild), played
  two more turn handovers refereed by the new build and settled (`BLUE WINS`, no verdict). The
  same swap of the old build under itself behaves identically.
- Found on the way, older than this item (`cde6af4`): `InteractionController.handleIntent`
  dropped every intent on the side whose turn it was not, so after a retreat or a win on the
  other side's turn the end screen's buttons did nothing. `endScreenNext` and `backToMenu` are
  now answered on any side, spectators included (`END_SCREEN_INTENTS`); observed in Chromium,
  Red leaving for the menu after Blue retreated on Blue's turn.
- On the deployed Worker (`66ca213`): passkey registration, roster, lobby and a refusal over
  the socket; tiles to the Pages origin (see the criteria below).

#### Acceptance Criteria
- [x] No `/api/` HTTP routes remain on either host (Bun server, Worker).
- [x] One session socket per window, observed in a browser through sign-in, the lobby, a match
      and its end (the menu's probe and the post-match reload are separate, older behaviour).
- [x] Lobby changes arrive as pushes; nothing polls.
- [x] Passkey registration and sign-in work over RPC on the deployed Worker: on `66ca213`,
      a software authenticator registered over the socket, then read the roster, subscribed to
      the lobby and signed out; a join to a missing room was a `410` with the socket kept open.
- [x] A protocol-6 window in a match finishes it across the deploy (observed across a
      `81ec4a7` → this build swap); any other protocol-6 request is refused with the reload text
      (`tests/session.test.ts`).
- [x] Tests updated.
- [x] Living documentation updated (`docs/architecture/networking.md` §8,
      `docs/architecture/persistence.md` §4, `docs/architecture/deployment.md` §2 and §5,
      `docs/architecture/rendering.md`).
---

### [ITEM-061] Serve the Map: a Low-Zoom Planet From R2
**Completed Date:** 2026-10-07  
**Type:** Infrastructure  
**Milestone:** M5 — The Shared World  

#### Why
The world is the real Earth (GDD-WORLD §1), and the only archive in R2,
`map-tiles/world.pmtiles`, was Stuttgart only (z0–14, 1,259 tiles). The user's decision
(2026-10-07): host the whole planet at the most zoomed-out levels now, closer zooms on demand
later (`ITEM-067`, deferred). Measured with `pmtiles extract --dry-run` against Protomaps build
`20261007` (138.7 GB at z0–15): z0–8 558 MB, z0–10 3.8 GB, z0–12 18 GB; R2's free tier is
10 GB-month.

#### Key Changes
- **Cap: z0–8** (countries, regions, large towns), chosen by the user over z0–10.
- **The archive**: `scripts/build-planet-tiles.ts` runs `pmtiles extract` by range requests,
  checks the header covers the whole planet to the cap, and streams it to R2 bucket `map-tiles`
  through the S3 API (`wrangler r2 object put` does not take objects this large). Object
  `planet-z8-20261007.pmtiles`, 557,631,269 bytes; a new build is a new key and a change to
  `MAP_TILES_KEY`, not to code.
- **One handler for both hosts** (`src/server/Tiles.ts`: `tileHandler`, `blobSource`,
  `r2Source`). The Worker binds the bucket as `MAP_TILES` and answers `/tiles/{z}/{x}/{y}.mvt`
  before the Durable Object, so a map pan neither wakes it nor queues behind its sockets; the
  Bun server takes a `tiles` option (`serve:match --tiles=<archive>`). Tiles go out as stored
  (gzip, never re-encoded), `204` past the cap, `Access-Control-Allow-Origin: *` — the only
  CORS left on the server. The R2 `Source` is the reference's with its abort handling fixed,
  and reads conditional on the archive's etag.
- **Self-hosted glyphs and sprites** under `public/map/`, so the map contacts no third-party
  origin. `world.pmtiles` stays in the bucket, unserved, for `ITEM-067` to keep or delete.

#### Measured
- `tests/tiles.test.ts` (13): bytes equal to the archive's once gunzipped, headers, HEAD, `204`
  past the cap, `400` outside the world, `404`/`405`/`OPTIONS`, the R2 source matching the file
  source, an etag swap under a warm handler, aborts.
- Under `wrangler dev` reading the real bucket: z0, z4 and z8 tiles for Stuttgart, Tokyo and São
  Paulo answer `200` with gzip MVT and `ACAO: *`; z9 answers `204`. A MapLibre page on another
  origin drew the planet at z1, Stuttgart at z8.5 and northern India (Devanagari labels) with no
  failed request and no third-party origin.
- Glyphs 11.5 MB in the repository, 17.7 MB in `dist/`; sprites 52 KB.

#### Acceptance Criteria
- [x] A tile is served to the match server's own origin and to a page on GitHub Pages: on the
      deployed Worker (`66ca213`), z0 and z8 `200` and z9 `204`, each with
      `access-control-allow-origin: *` to a request from the Pages origin.
- [x] A bare MapLibre page shows the whole planet down to the chosen cap.
- [x] No third-party origin is contacted at runtime (tiles, glyphs, sprites all self-hosted).
- [x] The Bun server serves the same route from a local file: `serve:match --tiles=` answered
      z0 and z8 with `200` and `ACAO: *`, z9 with `204`.
- [x] Living documentation updated (`docs/architecture/deployment.md` §6).
---

### [ITEM-062] Travel Maths in the Headless Core
**Completed Date:** 2026-10-08  
**Type:** Feature  
**Milestone:** M5 — The Shared World  

#### Why
A squad's position is a list of waypoints, and where it is now is a pure function of that list
and the clock (GDD-WORLD §2). The server's scheduler (`ITEM-064`) and the client's map
(`ITEM-065`) compute it with the same function. The prior art's
`../no-way-home/packages/shared/src/waypoint-utils.ts` had sound maths with the wrong
signatures: it read `Date.now()`, mutated its input and fell back to a 3 km/h default.

#### Key Changes
- **`src/core/Travel.ts`**: `positionAt`, `plannedArrivals`, `settle`, the five orders
  (`setOff` "go here", `redirect` "go here now", `detour` "go here first", `addStop` "go here
  next", `stop`) and `checkpoints`. Every moment is an argument; every order returns a new list.
- **Speed by gait**: a departure states `{ mode, pace }`, read from `SPEED_KMH` (on foot 3/5/7
  km/h); there is no default.
- **Stable keys**: a departure carries a trip id minted by the caller. Setting off and "go here
  now" start a trip; arriving on the way and "go here first" carry it on. A trip's checkpoints
  are every whole hour since it set off plus the moment it ended (arrival, stop or turn), keyed
  by `(trip, index)`; a passed checkpoint depends only on passed waypoints. The end counts so
  that stopping every 59 minutes is still weighed for an encounter.
- **Arrivals recorded when due** (`settle`): an intermediate arrival departs at once on the
  same trip at the same gait, so the projected position and the recorded history never
  disagree, and a late alarm never lengthens a trip. Orders settle first, so passed waypoints
  stay in the history.
- **What the maths is**: great-circle distance, linear lat/lng interpolation along a leg (the
  short way across the antimeridian), documented in the module and GDD-WORLD §2. JavaScript
  trigonometry is not correctly rounded, so two engines agree to within the last bits; what
  must agree exactly is the server's figure written into the list. `tests/determinism.test.ts`
  exempts this file from its `Math.atan2` ban for that reason: travel never feeds a match.

#### Measured
- `tests/travel.test.ts` (26): the 16 ported tests, then multi-stop projection (settling never
  moves the squad), speed by pace, the antimeridian, a zero-length leg, "go here next" after
  arrival, and checkpoints (hourly and end; a turn or stop ending a trip early keeps its passed
  checkpoints; a detour stays on the trip). Every fixture is frozen and `Date.now` throws for the
  whole file.

#### Acceptance Criteria
- [x] The 16 ported tests pass against an injected clock.
- [x] No function mutates its input list or reads the wall clock (frozen fixtures; `Date.now`
      throws in the test file).
- [x] Every leg's speed is stated by mode and pace; there is no default speed.
- [x] Trips and checkpoints carry stable keys.
- [x] The linear lat/lng interpolation is documented as such (module comment, GDD-WORLD §2).
---

### [ITEM-063] A Squad Has a Position, and a Place to Start
**Completed Date:** 2026-10-08  
**Type:** Feature  
**Milestone:** M5 — The Shared World  

#### Why
Nothing in the database said where a squad is. Decision D2: a squad's position lives in its own
`squads` table, one row per player for now, so captives, alien squads and several squads per
player can have positions later. Where a new player starts is GDD-WORLD §4.

#### Key Changes
- **Migration 7, `squads`**: id, player, the waypoint list as JSON (`src/core/Travel.ts`), and
  the start in integer millionths of a degree (the `Db` port takes TEXT and INTEGER only),
  indexed for the separation check; `squads_player` keeps one per player.
- **`src/server/Squads.ts`**: `drawAround` draws a start uniform over the 50 km disc (radius
  `R·√u`, uniform bearing, walked along the great circle) from system randomness; a draw within
  1 km of another start is redrawn, up to 100 times, then the last is taken and a line logged.
  The drawn point is rounded to the stored precision so the waypoint and the columns agree.
- **Registration places the squad** in the same transaction as the player and the roster
  (`Accounts.register(answer, near)`), near `Upgrade.place`, which the Durable Object reads off
  `request.cf`; Stuttgart centre (48.7775, 9.18) when there is none, which on the Bun server is
  always. The reported location is written nowhere. `SocketPlace` became the shared `LatLng`.
- **`tictac/api/squad/get`** returns `{ squad: { id, waypoints } }` to a signed-in socket. A
  player registered before migration 7 is placed on first asking (`Squads.ensure`, with
  `ON CONFLICT (player_id) DO NOTHING` for two windows at once), so the migration needs no
  random backfill in SQL.

#### Measured
- `tests/squads.test.ts`: 4,000 seeded draws all inside the disc; a χ² over five equal-area rings
  under the 1% critical value (a radius drawn without the square root fails it); each quadrant
  within 3% of a quarter; antimeridian draws stay on the map. On each test database, 300
  players from one anchor are all inside the disc and at least 1 km apart; a crowded anchor
  takes the last draw and logs once.
- `tests/accounts.test.ts`: a registration from Tokyo starts within 50 km of it and the
  `squads` row holds no trace of the reported point; one from nowhere starts near Stuttgart;
  `squad/get` is refused anonymously; a player with no row is placed near the asking socket's
  place and stays there.
- `tests/cloudflare.test.ts`: registered under `workerd`, the squad is read back near Stuttgart
  (`wrangler dev` reports no location).

#### Acceptance Criteria
- [x] A registration through Cloudflare stores a start within 50 km of the reported point, and
      the reported point is stored nowhere (`tests/accounts.test.ts` with a place on the socket;
      not yet observed on the deployed Worker, where `request.cf` is real).
- [x] A statistical test shows starts from one anchor spread uniformly over the disc, and no two
      starts within 1 km.
- [x] Registration off Cloudflare (and on the Bun server) works through the Stuttgart anchor.
- [x] The squad is readable over RPC.
- [x] Living documentation updated (`docs/architecture/persistence.md` §2 and §5a,
      `docs/architecture/networking.md` §8, GDD-WORLD §4).
---

### [ITEM-064] Orders, Pace and the Travel Scheduler
**Completed Date:** 2026-10-08  
**Type:** Feature  
**Milestone:** M5 — The Shared World  

#### Why
Travel runs on the wall clock and carries on while the player is away (GDD-WORLD §3). The match
server's Durable Object has one alarm, so something has to keep every squad's next due moment and
arm that alarm for the earliest.

#### Key Changes
- **`tictac/api/squad/order { order }`** takes the five verbs as a `SquadOrder` (`goHere` and
  `goHereNow` with a pace; `goHereFirst`, `goHereNext`; `stop`). `Session.ts` checks the shape
  (`invalidParams`), `Journeys` the fit (`conflict`: *already on the move*, *not on the move*);
  the answer is the new route. Every squad walks; the server, not the order, says so.
- **`src/server/Schedule.ts`**: the next due moment per `(kind, entity)`, the host's one alarm
  armed for the earliest and never more than an hour ahead, nothing armed when nothing is due.
  Handlers are given the moment their work was due. `ITEM-048`'s checkpoints and `ITEM-053`'s
  meetings are further kinds, not another mechanism.
- **`src/server/Journeys.ts`**: orders in, arrivals out, all through one queue so an alarm and a
  request never both write a route. An arrival records every waypoint due by now at its due time
  (`settle`), writes, pushes and schedules the next. `restore()` rebuilds the schedule from
  `squads` beside `lobby.restore()`.
- **Hosts**: the Durable Object arms `ctx.storage.setAlarm` and fires the schedule from
  `alarm()`; the Bun server arms a timer through an injectable `ServerClock`.
- **`ownerOf(squad)` and `MATCH_SERVER`** (`src/server/Owner.ts`): the Worker routes through
  `MATCH_SERVER` and `Journeys` checks `ownerOf` before acting — the two lookups `ITEM-046`
  replaces. The name stays `singleton`, which addresses the existing object and its storage.
- **`tictac/api/squad/changed { squad }`** is pushed to the player's window (`Lobby.tell`) on
  every order and every recorded arrival.

#### Measured
- `tests/journeys.test.ts` (11) over the socket with a hand-turned clock: each verb's route,
  refusals for verbs that do not fit and for malformed orders (nothing written), anonymous
  refused; an 11 km cautious trip woken with every alarm ten minutes late is armed at most an
  hour ahead each time and records its arrival at the due time, then disarms; an intermediate
  stop moves the alarm to the next; pushes on order and on arrival; a restart long after an
  arrival arms for the earliest due moment across two squads and records the overdue arrival at
  its due time; a trip's checkpoints read off the route the server wrote equal the planned ones.
- `tests/cloudflare.test.ts`: under `workerd`, a squad sent two metres is read back arrived —
  written by the Durable Object's own storage alarm.
- A throwaway script against `startGameServer` with real timers: a two-metre trip arrived within
  2.5 s and the window received two `squad/changed` pushes.

#### Acceptance Criteria
- [x] All five orders and three paces change the waypoint list as GDD-WORLD §3 says.
- [x] With a driven clock, a multi-hour trip arms alarms at most an hour apart and records the
      arrival at its expected time.
- [x] After a restart the schedule is rebuilt and the alarm armed for the earliest due moment.
- [x] The owner's socket receives a push when its squad's route changes or it arrives.
- [x] Living documentation updated (`docs/architecture/world.md`, new; `deployment.md` §2.1 and
      §5; `networking.md` §8; `persistence.md` §4; GDD-WORLD status).
---

### [ITEM-065] The Map Screen
**Completed Date:** 2026-10-08  
**Type:** Feature  
**Milestone:** M5 — The Shared World  

#### Why
The player has to see the squad on the map and give it orders; this is where M5's definition of
done is observed.

#### Key Changes
- **`src/hud/MapScreen.tsx`**: opened by **Open the Map** in the match-server panel for a
  signed-in player and closed back to it. Its panel shows the squad's status (resting, or pace
  and arrival time), the pace (cautious, normal, flat out), Stop and Find squad. A right-click
  offers the verbs that fit: *Go here* at rest; *Go here now / first / next* travelling.
- **The squad is drawn, never polled**: the route from `squad/get` (read again whenever the
  socket comes back) and `squad/changed` (`ServerConnection.watchSquad`); ten times a second,
  `positionAt(route, connection.now())` as a dot, the trail behind it, the route ahead and its
  stops.
- **By the server's clock** (the user's call): `tictac/api/clock/now` answers the Durable
  Object's time; every socket measures its offset over three round trips, keeping the quickest,
  and `ServerConnection.now()` is the local clock plus that offset. A browser whose clock is off
  still draws the squad where the server has it (`tests/serverConnection.test.ts`: a machine five
  minutes slow tells the server's time to the millisecond).
- **`src/hud/map/WorldMap.ts`** is the only file that imports MapLibre, reached by dynamic
  `import()`; `scripts/build-bundle.ts` now sets `splitting: true`. MapLibre's stylesheet and its
  tile worker are imported `with { type: 'file' }` — the stylesheet because Bun hoists a lazy
  chunk's CSS into the first load's, the worker because MapLibre 6 otherwise looks for
  `maplibre-gl-worker.mjs` beside its script, which no bundle emits (found as a 404 in the
  browser: the map drew its background and no tiles).
- **Style**: Protomaps' dark flavour (`@protomaps/basemaps`) over the connected server's
  `/tiles`, z0–8 stretched to z12, glyphs and sprites from the client's own `map/` assets.
- **Mounted on `<body>`** above the start menu, and `main.tsx` sets the engine's per-frame
  `renderer.update` aside while it is open (`pauseRendering`, `src/engine.ts`).

#### Measured
- Build: the first load is a 4.32 MB JS chunk and a 35 KB stylesheet with no MapLibre in either;
  opening the map fetches a 1.07 MB chunk, MapLibre's 83 KB stylesheet and its 508 KB worker.
- In Chromium, with the built client served from `localhost:18950` and `wrangler dev` (local R2
  seeded with the planet archive) on `localhost:18931` — the GitHub Pages arrangement:
  a passkey registered with a virtual authenticator; the map drew the planet around the squad's
  start near Stuttgart from cross-origin tiles, glyphs and sprites from the page's origin, and no
  third-party request. A right-click *Go here* flat out set off a 37 km trip (5 h 18 min); a page
  reload resumed with the dot in the same place and the same arrival time. A *Go here now* then
  turned it on the way.
- With no window connected (the tab closed, a script's socket disconnected), a 500 m trip
  arrived by the Durable Object's alarm: the stored route's last waypoint has
  `arrival === plannedArrivals(...)` (17:24:19.228Z) and rests; a fresh tab's map then showed it
  resting there.

#### Acceptance Criteria
- [x] A squad sent on a long trip keeps travelling with the tab closed; on return it is where
      the clock says, and an arrival that happened while away is recorded at its expected time.
- [x] A refresh mid-journey resumes without a jump.
- [x] Tiles load cross-origin on GitHub Pages: on `a65a167`, a page at
      `https://lordvlad.github.io` fetched z0 and z8 tiles from the deployed Worker (`200`, MVT)
      and z9 (`204`). The map itself cannot be opened there yet: passkeys are bound to the
      Worker's domain, which WebAuthn does not let a `github.io` page use, so nobody signs in
      from Pages (true since `ITEM-045`).
- [x] MapLibre is not in the initial bundle.
- [x] Living documentation updated (`docs/architecture/rendering.md` §4,
      `docs/architecture/world.md` §5).
---

### [ITEM-066] Before Encounters: the Decisions ITEM-048 Needs
**Completed Date:** 2026-10-08  
**Type:** Feature (design)  
**Milestone:** M5 — The Shared World  

#### Why
`ITEM-048` assumes the server can start a fight on its own, and everything built for rooms
(`ITEM-058`, `ITEM-059`) assumes humans open, join and hold them. The clashes were settled on
paper before building, each against the code it touches.

#### Key Changes
- **GDD-WORLD §5.4**, eight decisions:
  1. an encounter is the player's one match; the panel's takeover is how a player takes the
     fight, and does not take over an AI-held seat; no mid-match hand-back; encounter rooms
     unlisted;
  2. a *reserved* seat state with a 60 s join window (`JOIN_WINDOW_MS`) for an online player,
     none for an offline one; in a room with an AI to fall back on, grace expiry passes the seat
     to the AI instead of ending the room (`Room.hold`, `departure`);
  3. `Lobby.openEncounter` opens a room already `playing` from a server-composed header; the
     party is the first `SQUAD_SIZE` fit members by slot not deployed elsewhere;
  4. the AI is a client of the room (`AiSeat`, `AiOpponent` generalised over `loopback()`), not
     the referee; nobody present means two AI seats in the same room;
  5. `Rosters.rest` unchanged until bases exist (`ITEM-047`);
  6. travel changes characters only through roster rows, and the header is composed from them,
     so `verifyRosters` passes byte for byte;
  7. encounter rooms take the server's build; AI seats are not pinned and are re-attached on
     restore; `RoomStore` keeps a controller per seat;
  8. straight lines inside a zone, deliberate crossings at borders: RFC-0002 wins at the border.
- **`docs/architecture/networking.md` §8**: *Rooms the server opens* — controllers per seat,
  reserved seats, `encounter/started`, unlisted rooms, build.
- **RFC-0002 §2**: a pointer to decision 8.
- **`ITEM-048`**: Change and Affected Files rewritten to these decisions; now Ready.

#### Acceptance Criteria
- [x] Each of the eight points has a recorded decision (or an explicit "not needed for the first
      encounter, because …") in the GDD.
- [x] `ITEM-048`'s Change and Affected Files are updated to match.
---

### [ITEM-068] Sign in from GitHub Pages: WebAuthn related origins
**Completed Date:** 2026-10-08  
**Type:** Bug  
**Milestone:** M5 — The Shared World  

#### Why
Passkeys are bound to the Worker's host (`tictac-match-server.waldemar-reusch.workers.dev`), and
a browser refuses a relying party id that is not a registrable suffix of the page's host. So
nobody could register or sign in from `https://lordvlad.github.io`, and the world map
(`ITEM-065`) opened only on the Worker's own origin.

#### Key Changes
- **`src/server/RelatedOrigins.ts`**: `GET /.well-known/webauthn` answers
  `{"origins": [...]}` (`application/json`) with the relying party's origins — the same list the
  ceremony's `origin` check uses, so a site is trusted for both or neither.
- **`workers/index.ts`** answers it before the Durable Object, from `RELYING_PARTY_*`
  (`relyingPartyOf`, now exported from `MatchDurableObject.ts`).
- **`startGameServer`** serves it too, from `Persistence.party`: a `serve:match` on its own
  domain with its client on another site needs the same file.
- **`wrangler.jsonc`**: `RELYING_PARTY_ORIGINS` gains `https://lordvlad.github.io`.
- The client needed no change: it spreads the server's options, so a Pages page already asks for
  the Worker's id (`rp.id` at registration, `rpId` at sign-in).
- Browser support: Chrome/Edge 128+ and Safari 18; Firefox does not fetch the file yet.

#### Measured
- Chrome 151, headless, with a CDP virtual authenticator, on a page at
  `https://pages.example.org`, against `wrangler dev` configured with relying party
  `rp.example.com` and both origins, behind local TLS (`--host-resolver-rules`, a self-signed
  certificate trusted by SPKI): Chrome fetched `https://rp.example.com/.well-known/webauthn`
  from the Worker; registration and sign-in succeeded, the credential bound to
  `rp.example.com`, and the server accepted the cross-site origin. With the file answered `404`,
  registration failed with Chrome's `SecurityError` (*…an attempt to fetch the
  .well-known/webauthn resource of the claimed RP ID failed*). A `.test` domain did not work
  for this: Chrome needs a registrable domain on a known suffix.
- On the real site, build `b677bcc`: in Chromium at `https://lordvlad.github.io/tictac/` with a
  virtual authenticator, a passkey registered against the deployed Worker, the account line read
  *Signed in as PagesCheck*, and **Open the Map** drew the planet around the squad's start near
  Stuttgart with cross-origin tiles.
- Not verified: Safari. Firefox is unsupported.

#### Acceptance Criteria
- [x] The Worker serves `/.well-known/webauthn` with the configured origins
      (`tests/cloudflare.test.ts`, `tests/relatedOrigins.test.ts`).
- [x] `RELYING_PARTY_ORIGINS` includes the GitHub Pages origin.
- [x] A page on another site registers and signs in with the server's passkeys in Chromium.
- [x] The same on the real GitHub Pages site against the deployed Worker, and its map opens.
- [x] Living documentation updated (`docs/architecture/deployment.md` §4,
      `docs/architecture/persistence.md` §4 and §6).
---

### [ITEM-067] Closer Zooms on Demand
**Completed Date:** 2026-10-09  
**Type:** Infrastructure  
**Milestone:** Unscheduled (taken up after M5)  

#### Why
`ITEM-061` hosts the planet only at z0–8; past that the map stretches the last level into blocks.
Hosting every zoom is 138.7 GB (z0–15), so closer zooms are built for the places players look.

#### Design (the open questions, answered — deployment.md §6.4)
- **Zooms**: z9–14 (`MAP_TILE_MAX_ZOOM`); the planet's z15 is four times the storage for a
  tile a squad on foot crosses in under half an hour.
- **Granularity**: one tile, pulled through, not a region. A region build is an extraction, which
  is the Go CLI's job and cannot run in a Worker; a tile is one to three range reads.
- **Eviction**: none. At R2's $0.015/GB-month the whole planet at every zoom would be about $2 a
  month; the key names the build, so a new build is a new prefix to delete by.
- **Addressing**: one url scheme; `/tiles/tiles.json` (TileJSON) tells the client the deepest
  zoom, so a server with no planet (Bun, or `MAP_SOURCE_URL` unset) says 8 and nothing is
  hardcoded in the client.
- **Not a separate Worker**, and not coordinated: sharing an in-flight build between requests is
  not possible on a Worker, and concurrent first requests write identical bytes under one key.

#### Key Changes
- **`src/server/Tiles.ts`**: the archive reader is shared by the stored archive and the remote
  planet; `DemandTiles` (`source`, `store`, `prefix`, `maxZoom`, `allow`) adds the pull-through;
  `httpSource` reads the planet by `Range` (not `pmtiles`' `FetchSource`, whose
  `cache: 'no-store'` the Worker runtime refuses); `r2TileStore` keeps each tile with its
  `Content-Encoding`; `/tiles/tiles.json`.
- **`workers/index.ts`, `wrangler.jsonc`**: `MAP_SOURCE_URL` (the same dated build as the
  archive) and a `TILE_BUILDS` rate limit, 300 builds a minute per client, asked on a miss only;
  `429` past it.
- **Failure is not cached**: a planet that is down, slow past 8 s or gone answers `503` with
  `no-store` and stores nothing; a browser would keep a `204` for a week.
- **`src/hud/map/WorldMap.ts`**: the source is the server's TileJSON; no zoom is named but how far
  a player may look (16).

#### Measured
- Against the real planet (`build.protomaps.com/20261007.pmtiles`, 138,664,957,457 bytes) from a
  developer's machine: one tile is 1–3 range reads, 0.4–1.5 s; Stuttgart and Tokyo tiles are
  110–330 KB, an ocean tile 73 bytes.
- Under `wrangler dev` against that planet: a z12 tile built in 1.8 s and served again in 10 ms;
  four z14 builds took 0.4–0.9 s each; with the limit set to 5, the sixth build in a minute was
  `429` with `Retry-After: 30` and already-built tiles kept being served.
- In Chromium on the same server: zooming from the planet into the squad's start drew streets,
  buildings and street names at z14 from tiles z8–14 and no failed request; with the planet made
  unreachable, 47 tile requests answered `503` and the map drew the stretched z8 tiles (coarse,
  not blank).
- `tests/demandTiles.test.ts` (18), over a planet written in memory
  (`tests/support/pmtilesWriter.ts`): built once and kept, served from the store without the
  planet, empty tiles remembered, past the deepest zoom free, limit and failure paths,
  `tiles.json`, `httpSource`'s range and etag handling, the store's keys.

#### Acceptance Criteria
- [x] Designed (the open questions answered) before it was built.
- [~] A first request for an unbuilt tile builds and caches it. Under concurrent requests each
      may read the planet and write the same bytes under one key: nothing is stored twice, but
      the read is not shared (above). Not "once".
- [x] On the deployed Worker (`b48f3d1`): `tiles.json` says z0–14; a z12 tile built in 2.0 s,
      was kept at `demand/20261007/12/2144/1408.mvt` in the real bucket and answered again in
      0.26 s; z15 is `204`. In Chromium on `https://lordvlad.github.io/tictac/`, a passkey
      registered and the map zoomed from the planet to street level (tiles z8–14, no failed
      request): streets, house blocks, street names and a shop in Ostelsheim. The rate-limit
      binding is attached (`env.TILE_BUILDS (300 requests/60s)` in the deploy); its limit was
      exercised only under `wrangler dev`.
---

### [ITEM-048] Wild Alien Encounters on the Road
**Completed Date:** 2026-10-09  
**Type:** Feature  
**Milestone:** Unscheduled (taken up after M5)  

#### Why
Every refereed match needed two humans, and a squad on the map met nothing. Aliens find a
travelling squad, and the fight is an ordinary match: same rules, same referee, same log, same
settlement (GDD-WORLD §5, with the room and roster decisions of §5.4).

#### Key Changes
- **The roll** (`src/core/Encounters.ts`): at each hourly checkpoint of a trip the server rolls
  whether the stretch just travelled found the squad. The chance is 15% per hour at a normal pace
  (`ENCOUNTER` in `src/config.ts`), halved cautious and 1.5× flat out, capped at 90%, with danger
  flat. It is drawn from `Rng(hashSeed("squad|trip|checkpoint"))`: reproducible after the fact,
  independent between checkpoints, never a match's dice. The schedule gained a `CHECKPOINT`
  kind beside `ARRIVAL`; checkpoints are weighed in time order on the route as it was then, so a
  late alarm does not reorder them.
- **Contact halts, a miss does not**: a fight stops the squad where it stood at the checkpoint
  (`squad/changed` pushed); a contact that cannot become a fight (*busy*: the player already
  holds a match; *nobodyFit*) is recorded and the squad carries on. Rows in `encounters` are
  unique on (squad, trip, checkpoint), so a re-fired alarm after a restart is idempotent.
- **The server opens the room** (`Lobby.openEncounter`): already `playing`, unlisted, under the
  server's build, from a header it composes — the first four fit roster members by slot as Blue,
  dealt aliens as Red (`dealAliens`, nothing written to `roster`), a crypto seed,
  `controllers: { Blue: 'human', Red: 'ai' }` in the header (an optional field; protocol stays 7).
- **The AI is a client of the room** (`src/server/AiSeat.ts`): the browser opponent's play loop was
  extracted to `src/sim/AiPlayer.ts`; the seat rebuilds its own `MatchHost` from the room's log,
  plays through `Policy` and sends ordinary frames over a `loopback()`, refereed like a human. A
  stalemate guard (`ENCOUNTER.turnLimit`, 40) calls a fight off rather than hold a player to a
  seat nothing moves.
- **Seats have a control**: `player`, `reserved` (until `joinBy`) or `ai`, in `LobbyView.you`. An
  online player is pushed `encounter/started` and has 60 s (`ENCOUNTER.joinWindowMs`) to resume;
  an offline player's seat is the AI's at once; a dropped seat's grace expiry in an encounter
  room passes to the AI instead of aborting. Migration 8 stores the controls and deadlines so a
  restart re-attaches AI seats from the log and re-arms deadlines.
- **The feed** (`encounters` table, migration 9; `encounter/feed`, `match/recording`): newest
  first, with result, who played and a recording to watch back; checked against `match_results`.
- **Client**: a join prompt with a countdown on the server's clock (`EncounterPrompt`), the
  server panel no longer auto-takes a `reserved` or `ai` seat, and "While you were away" in the
  map panel with Watch. A `resume` without a seat key, which `main.tsx` already sent, is now
  accepted (it was refused as invalid).

#### Measured
- `tests/encounters.test.ts`, `encounterTravel.test.ts`, `encounterRooms.test.ts` (17),
  `aiSeat.test.ts`, `aiPlayer.test.ts`, `encounterPrompt.test.ts` (30) and the updated lobby,
  restart, server, session and store tests: 949 tests pass; lint, build and `typecheck:cf` clean.
  Covered: late-alarm time order; halt at the contact's moment; a passed-by contact in the feed;
  idempotent re-roll after restart; an offline player's fight settling the roster exactly as an
  independent replay of the stored log does, with no alien rows; an online player's turn through
  the referee with digests equal; lapse, late take-over, dropped-seat grace, restart mid-fight,
  unlisted rooms; determinism (`tests/determinism.test.ts`).
- In Chromium against the Bun server with a clock the script turned (a 24 h flat-out trip, found
  after 4 h): the prompt appeared with the push; **Take the fight** put the player in the match as
  Blue with four soldiers; ending the turn let the server-side AI play Red's turn and hand back
  (Turn 2); retreat settled ("you got out", all alive); the map's feed then read *Lost · 4
  aliens · You played · Watch* and the squad was free again.
- Over raw RPC on the same server: a window that let the 60 s lapse saw `control: reserved` in
  the window and the AI play it (*won, played by the AI*); a player offline at contact had the
  squad halted, the fight fought AI against AI and settled (*won, played by the AI*), and a
  427-event recording to fetch.

#### Acceptance Criteria
- [x] A travelling squad runs into an alien squad at a checkpoint, and its journey stops.
- [x] An online player takes the fight inside the join window and plays it through the referee to
      settlement; a player who lets the window lapse has it played for them.
- [x] With nobody online the fight is fought out on the server and settles the roster, growth
      included, exactly as a played match would.
- [x] Nothing about the alien squad is written to `roster`.
- [x] The encounter roll for a given (squad, trip, checkpoint) is reproducible after the fact.
- [x] Two encounters roll different alien squads; the same recording replays identically.
- [x] `tests/determinism.test.ts` still passes: the AI draws nothing from the match stream.
- [x] Living documentation updated (`networking.md` §8, `persistence.md` migrations 8–9 and §5b,
      `world.md` §3a–3b and the client, `rendering.md` §4, GDD-WORLD §5.1).
- [ ] Not yet seen on the deployed Worker (a real checkpoint alarm under `ctx.storage.setAlarm`,
      the push to a real window): after a deploy.
---

## Rejected — kept for the reasoning

Items that were designed and then turned down. They stay here because the argument is the
useful part: whoever wants to reopen one starts from why it was closed.

---

### [ITEM-026] Per-Peer Projection — REJECTED
**Type:** Feature  
**Priority:** —  
**Status:** Rejected  
**Milestone:** —  

#### Why it was proposed
[RFC-0001](../design/rfc/0001-referee-and-transports.md) §3.4, in its first draft. Fog of war
is a rendering filter: a client holds everything it declines to draw, which is the same
position every deterministic-lockstep RTS is in and the reason maphacks are that genre's
oldest cheat. A referee filtering `componentUpdate` frames per client would have made withheld
information actually withheld.

#### Why it is rejected
Hiding information is not one decision, it is one decision **per piece of state** — position,
sheet, action points, ammunition, statuses, grenade counts — and each needs an entitlement
rule, a ghost policy for state that has gone stale, and a HUD story for showing uncertainty. A
client that is simply *missing* an enemy leaks that the enemy moved, so ghosts are mandatory
rather than an optimisation. That is a large, permanent body of machinery, and its effect on
two friends playing each other is approximately nil.

It also costs the thing that made the accepted design cheap. Secrecy requires the referee to
be in the data path, which is a round trip per action, prediction and reconciliation on the
clients, and a match that cannot proceed when the referee is away. Dropping secrecy makes the
referee a witness instead: no latency, nothing to predict, and play continues unwatched.

Recorded rather than deleted because the reasoning is the valuable part: the accepted design
(RFC-0001 §2) knowingly accepts that a maphack is possible and unobservable, and a future
competitive mode that cannot accept that would have to reopen exactly this item.

#### Superseded by
- `ITEM-023` — intent-only wire, full knowledge on both sides.
- `ITEM-025` — the referee as a witness that attributes fouls rather than preventing peeking.

---

### [ITEM-027] Match Provenance — REJECTED
**Type:** Feature  
**Priority:** —  
**Status:** Rejected  
**Milestone:** —  

#### Why it was proposed
[RFC-0001](../design/rfc/0001-referee-and-transports.md) §8.1. Once outcomes stop travelling,
nothing after the first intent can be faked quietly — but everything before it can. The host
picks the match seed, so a host could reroll until it liked the map; each peer rolls its own
squad and sends the sheets, so a peer could roll ten squads and keep the best. Both are legal
from the first intent onward and no recomputation would ever see them. The fix was one
committed nonce each and a derived seed.

#### Why it is rejected
It defends peer-to-peer play, and peer-to-peer play is a debug utility and demo entry point —
not a mode anybody is scored in. Nothing is at stake in a match between two friends who can
both already read each other's state by design (`ITEM-026`).

And the premise expires anyway: going forward **the server rolls a new player's roster**, so
there is nothing for a client to grind. A squad becomes something a player is dealt and then
keeps, which is also what makes permadeath mean anything (`ITEM-012`) — the provenance problem
dissolves into the persistence design rather than needing a protocol of its own.

Recorded rather than deleted because the reasoning is the reusable part: a commitment scheme is
the right tool for a secret that has to be *fixed before* it is revealed, and if a competitive
mode ever needs client-chosen setup to be unforgeable, this is the shape it wants.

#### Superseded by
- `ITEM-012` — the server holds the roster, so a client never chooses one.
