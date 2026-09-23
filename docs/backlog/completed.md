---
title: "Completed Work Archive"
id: "BACKLOG-COMPLETED"
type: "backlog"
status: "active"
lastReviewed: "2026-09-18"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/README.md"
  - "docs/design/adr/0001-ecs-render-decoupling.md"
  - "docs/design/adr/0002-deterministic-headless-balance-harness.md"
tags: ["archive", "completed", "history"]
---

# Completed Work Archive

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
