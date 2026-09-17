---
title: "Completed Work Archive"
id: "BACKLOG-COMPLETED"
type: "backlog"
status: "active"
lastReviewed: "2026-09-17"
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
