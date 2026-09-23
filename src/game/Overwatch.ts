import { ShotMode } from '../core/Arsenal'
import type { Combatant, CombatFx } from '../core/Combatant'
import { NO_FX } from '../core/Combatant'
import type { Grid, Tile } from '../core/Grid'
import type { Roll } from '../core/rng'
import { effectiveWeapon } from '../core/Ballistics'
import { eyesOf, sees } from '../core/Visibility'
import { canShoot, fireWeapon, type ShotResult } from './Combat'

/**
 * Holding fire for somebody else's turn.
 *
 * The classic tactical ability, and the counter the game has been missing:
 * without it, crossing open ground is free, which is why melee
 * ([ITEM-018](../../docs/backlog/active-backlog.md)) has nowhere to be a
 * decision and why a soldier in good cover is close to unkillable while being
 * trivially reachable.
 *
 * ### Why this is cheap now, and would not have been before
 *
 * The hard part of reaction fire is never the shot. It is agreeing on *when*
 * it happened: a trigger has to be a point both sides compute identically, not
 * a moment one side noticed first. Under the old sender-resolved contract the
 * mover's own client resolved everything and would have had to author its
 * opponent's reactions, mid-path, on its opponent's behalf.
 *
 * Under intent-only ([ADR-0004](../../docs/design/adr/0004-full-knowledge-lockstep.md))
 * both peers already walk the same path: a `moveUnit` intent names the route,
 * `MovementSystem` steps it tile by tile, and `onStep` fires once per tile
 * *arrival* — an index into a path rather than a moment in time, so two clients
 * with different frame rates still agree about it. The dice come from the match
 * stream, drawn at the same point in the same order. So a reaction needs no new
 * message at all: it is a consequence of an intent both sides already hold.
 *
 * Two rules keep that true, and both are load-bearing rather than tidy:
 *
 * 1. **Watchers are considered in squad order.** Every draw from the match
 *    stream moves every later roll, so "which watcher fires first" must not
 *    depend on iteration luck.
 * 2. **One reaction per watch.** A watcher that fires stops watching, so the
 *    number of shots a path provokes is a function of the path and the state,
 *    not of how long anybody's browser took to render it.
 */

/**
 * What a walk into the open cost the unit walking.
 *
 * Generic over the kind of combatant so a caller gets back what it put in: the
 * live game hands in soldiers and wants soldiers to announce, and the headless
 * runners hand in their own units.
 */
export interface ReactionFire<T extends Combatant = Combatant> {
  watcher: T
  result: ShotResult
}

/**
 * Fire every reaction a unit's arrival on `tile` has earned.
 *
 * Called from `MovementSystem.onStep`, which is the only place that knows a
 * unit *entered* a tile rather than merely being on one. The mover is passed
 * having already arrived, so line of sight is judged from where it now stands —
 * a watcher covering the tile you stepped into is what an overwatch is.
 */
export function reactToArrival<T extends Combatant>(
  grid: Grid,
  mover: T,
  units: readonly T[],
  roll: Roll,
  fx: CombatFx = NO_FX,
  tile: Tile = mover.tile,
): ReactionFire<T>[] {
  if (mover.isDead) return []
  void tile

  // Sorted rather than taken in the caller's order, and this is the whole
  // reason the rule is stated twice. The two callers hold their units
  // differently — a match interleaves the squads (blue 0, red 0, blue 1, …),
  // the headless runner keeps each side in a block — so "squad order" was two
  // different orders, and with two watchers covering one tile they drew the
  // match stream in opposite sequences. That is a desync, found by replaying a
  // recorded match rather than by anybody reading this. Sorting here makes the
  // order a property of the rule instead of a property of an array.
  const watchers: T[] = []
  for (const unit of units) {
    if (!unit.watching || unit.isDead || unit.faction === mover.faction) continue
    watchers.push(unit)
  }
  if (watchers.length > 1) {
    watchers.sort((a, b) => a.faction - b.faction || a.squadIndex - b.squadIndex)
  }

  const fired: ReactionFire<T>[] = []
  for (const watcher of watchers) {
    // A watcher reacts to what it can see — the same sight fog grants — and
    // then to the ordinary legality of a shot: range and points. Nothing
    // special is granted; what it bought was the *timing*. (`canShoot` alone
    // asks range, not sight, because a player's shots are already chosen from
    // what is visible. Without this check a watcher fired through walls.)
    if (!sees(grid, watcher.tile, eyesOf(grid, watcher), mover.tile)) continue
    if (!canShoot(grid, watcher, mover, ShotMode.Reaction)) continue

    // Spent before the shot, so a unit cannot react twice to one path even if
    // resolving the shot somehow re-enters this rule.
    watcher.watching = false

    const result = fireWeapon(grid, watcher, mover, fx, units, ShotMode.Reaction, roll)
    if (result) fired.push({ watcher, result })

    // A mover that is down has stopped walking; `MovementSystem` notices the
    // same thing on its next tick, and nobody else gets to shoot a corpse.
    if (mover.isDead) break
  }
  return fired
}

/**
 * Can this unit go on watch?
 *
 * It pays the price of the shot it is reserving, so it has to be able to
 * afford one — and a reaction mode costs no points of its own, which is what
 * makes the reservation the whole cost.
 */
export function canWatch(unit: Combatant): boolean {
  if (unit.isDead || unit.watching) return false
  if (unit.weapon.currentClip <= 0) return false
  return unit.ap >= watchCost(unit)
}

/**
 * What going on watch costs.
 *
 * A snap shot's price, because that is the shot being held back. Paying up
 * front rather than when the reaction fires is deliberate: a watch has to cost
 * something even when nobody ever walks past, or holding one would be strictly
 * better than ending a turn.
 */
export function watchCost(unit: Combatant): number {
  // Through `effectiveWeapon` rather than off the weapon, so a stim, a wound
  // or a fitted attachment prices a watch the same way it prices the shot.
  return effectiveWeapon(unit, ShotMode.Snap).apCost
}
