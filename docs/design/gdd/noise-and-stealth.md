---
title: "GDD: Noise & Stealth — Being Heard, and Not Being"
id: "GDD-NOISE"
type: "gdd"
status: "draft"
lastReviewed: "2026-09-17"
appliesTo:
  - "src/game/FogOfWar.ts"
  - "src/ecs/components/StanceComponent.ts"
  - "src/ecs/components/SightedComponent.ts"
  - "src/core/Walls.ts"
relatedDocs:
  - "docs/design/gdd/combat-mechanics.md"
  - "docs/design/gdd/melee-combat.md"
  - "docs/design/gdd/interaction-and-environment.md"
tags: ["stealth", "noise", "awareness", "design"]
---

# GDD: Noise & Stealth — Being Heard, and Not Being

**Status: draft.** A design proposal. Numbers are proposals; shipped ones live in the code and
appear in the [generated catalogue](status-and-trait-catalog.md).

## 1. The idea

The game models **sight** carefully and **sound** not at all. Every unit is either visible to
a side or not, and nothing a soldier does is audible. That leaves a gap a tactics player will
reach for immediately: the choice between crossing a room quickly and crossing it quietly.

Sound is the second information channel. Sight says *where somebody is*; sound says
*that somebody is there*. Those are different pieces of knowledge and should be modelled as
different pieces of knowledge — which the game is, conveniently, already set up for: a unit
can be **seen** without being **read**, and this proposal adds **heard** as a third state of
the same kind.

## 2. Moving quietly

- **Crouching is sneaking.** Not a new stance and not a new button: the game already has a
  crouch that trades speed for a harder target, already priced in action points, and already
  replicated. Making it also mean *quiet* gives an existing decision a second dimension
  instead of adding a mode.
- **Standing movement is audible** — not visible, audible. An enemy who cannot see you
  learning that *something is moving nearby* is the whole mechanic. Running the last two tiles
  to a doorway should be a choice with a cost.
- **Sprinting** — spending the whole turn's points on movement — should be the loudest thing
  a soldier can do that is not a gunshot. It also already leaves them `Winded`, so the loud
  option is the one that is punished twice, which is a good shape.
- **What you wear matters.** Plate is already heavy enough to cost a step and a point; it
  should also be the noisy option, with Strength's allowance answering the weight but *not*
  the noise. Broad shoulders do not make a plate carrier quiet.

## 3. Being heard

A noise is an event at a tile with a radius. Anything inside it learns that something is
there — not what, not exactly where.

| Noise | Proposed loudness | Notes |
| --- | --- | --- |
| Crouched move | silent | The reason to crouch |
| Standing move | quiet | Carries a tile or two |
| Sprint | loud | Plus `Winded` |
| Door opened | quiet | Forcing one is loud |
| Breaking glass | loud | And it leaves the window gone — see below |
| Bare-hand or blade kill | silent | The point of a knife |
| Bludgeon | loud | Hitting a plate with a hammer |
| Suppressed shot | quiet | The suppressor's existing upside, extended |
| Unsuppressed shot | very loud | Already reveals position; this generalises it |
| Grenade | very loud | Nothing quiet about it |

The crucial rule is what hearing *gives* you. Being heard should never hand the listener a
firing solution — only the knowledge that something is nearby, and roughly where. Otherwise
sound becomes a way to shoot through walls, and the careful sight model stops mattering.

## 4. Alertness, and the unaware kill

Sound is only interesting if somebody can be **unaware**. That is a state the game does not
have: a unit is currently always ready, and the only thing it does not know is where the enemy
is.

Three states, per unit, per side that is looking at it:

1. **Unaware** — has seen and heard nothing. Can be killed silently from behind, and does not
   react.
2. **Alerted** — has heard something, or had a squadmate die nearby. Knows to look; does not
   know at what. Should cost the intruder their free kill without giving the defender a target.
3. **Engaged** — has seen the enemy, or been shot at. Normal combat, which is the whole game
   today.

A **silent kill** is then a specific, checkable conjunction: the target is unaware, the
attacker is behind them, the weapon is quiet — and no third party is in a position to see or
hear it. That last clause is what makes it a tactical puzzle rather than a button: killing the
sentry is easy, killing the sentry *without the room hearing* is the interesting part.

The consequence that makes it a real mechanic: a squad that never alerts anybody should be
able to clear a building in a way that shooting cannot. If sneaking is only "shooting, later",
it is not worth building.

## 5. Glass, and the thrown stone

Glazing is the best object in the game for this, and it already exists as a wall kind:
transparent, stops nothing, and cannot be walked through. It is also the one piece of terrain
whose destruction is obviously loud.

- **Breaking glass is loud and permanent.** The wall segment becomes a gap. Both peers agree
  immediately, because a wall's kind is replicated component state.
- **Shooting through a window** should therefore be a decision with a cost: a free firing lane
  that announces you made one.
- **A thrown stone is a lie.** Throw something at a window across the room; the noise happens
  *there*, not where you are. Every unit that hears it is alerted toward the wrong tile — the
  first mechanic in the game that manipulates enemy information rather than enemy hit points.
  It should be cheap, reusable and useless against an already-engaged enemy.
- A stone thrown at nothing in particular still makes a noise where it lands, which is the
  simpler and more general version of the same trick.

This is the feature this whole document is for. It is also the one that most needs enemy
awareness to be real: a distraction is meaningless if nobody can be distracted.

## 6. What the player sees

- **A noise leaves a mark on the map** where it was heard from, on the side that heard it, and
  fades. Players need to see their own mistakes; a stealth system whose feedback is invisible
  reads as randomness.
- **Alertness is legible on the enemy.** Before committing to a knife, the player must be able
  to tell an unaware sentry from an alerted one. Intel fog already withholds an enemy's
  *sheet* until they have been read; awareness is the opposite — it should be shown, because
  it is the thing the player is acting on.
- **Loudness is shown before the action, not after.** The move preview should say the route is
  audible, the same way the shot panel says what a shot's odds are.
- **Crouching should visibly say "quiet"**, since it now means two things.

## 7. What exists today, precisely

| Hook | Where | What it gives this design |
| --- | --- | --- |
| Crouch stance | `StanceComponent.isCrouching` | The quiet-move input, already priced and replicated |
| Firing reveals position | `StanceComponent.firedThisTurn` | Exactly this design's "loud action reveals you", for one action |
| Quiet weapons | `silenced` trait (suppressor) | The precedent: an action whose noise can be removed |
| Per-side visibility | `SightedComponent.seen`, `FogOfWar` | Where a `heard` flag belongs, beside `seen` and `known` |
| Knowledge vs sight | `SightedComponent.known` (intel fog) | Proof the codebase can carry a second, separate kind of knowing |
| Facing | `PositionComponent.targetYaw` | "From behind" is computable today |
| Glass walls as entities | `WallKind.Glass`, `WallComponent` | A breakable, replicated object with no new wire message |
| Grid distance and DDA rays | `src/core/Grid.ts`, `src/core/Visibility.ts` | The geometry a noise radius needs; sound wants distance, not line of sight |
| Suppression | `Suppressed` status | Shows a per-unit "has been shot near" already works |

## 8. What it needs

1. **Awareness state per unit, per side.** The single load-bearing addition. It belongs beside
   `seen`/`known`, which means it replicates the same way and costs no new message.
2. **Noise events.** An action reports a tile and a loudness; whoever is within earshot gets
   alerted. Cheap, because it is distance, not ray-marching.
3. **Loudness on the things that make noise.** A field on weapons, items, grenades and
   movement — data, once the event exists.
4. **Breakable wall segments.** Glass first, since it is already the kind that stops nothing.
5. **An AI that can be fooled.** A distraction has no value against a policy that ignores
   information. This is the hidden cost of the feature: the headless policy needs to act on
   awareness or the sweep will show the whole system doing nothing — the same trap the shotgun
   fell into by never closing to its own range band.

## 9. Risks and open questions

- **Sound must not become x-ray.** If hearing yields a position precise enough to shoot, the
  cover and LOS model is bypassed. Alerted-but-blind has to be a real state.
- **Turn-based stealth is genuinely hard.** With both squads acting in alternating turns,
  "sneaking past" can degenerate into "the enemy stands still while you walk around them".
  Enemy patrol behaviour on their own turn is part of this feature, not separate from it.
- **P2P.** Awareness is per-side knowledge, so each peer derives its own — like intel fog. But
  a *silent kill* is resolved by the attacker and must be believed by the defender, so the
  numbers travel as they do for every other attack, and the check ("were you unaware") must be
  the attacker's answer, or the two sides will disagree about whether the sentry turned round.
- **It changes the shape of a match.** Fights currently last a median of four turns. A stealth
  approach is a longer, quieter opening, and the turn cap, AP economy and sweep baselines all
  assume the current tempo. Expect to re-measure everything.
