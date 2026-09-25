---
title: "Completed Work Archive"
id: "BACKLOG-COMPLETED"
type: "backlog"
status: "active"
lastReviewed: "2026-09-24"
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
