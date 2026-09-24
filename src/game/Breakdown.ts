import { RULES } from '../config'
import type { ShotMode } from '../core/Arsenal'
import type { Combatant } from '../core/Combatant'
import type { Grid, Tile } from '../core/Grid'
import { MoraleBreak } from '../core/Morale'
import { reachable, type Reach, routeTo } from '../core/Pathfinding'
import { eyesOf, sees } from '../core/Visibility'
import type { Command } from '../ecs/systems/CommandSystem'
import { canMelee, canShoot, shotApCost } from './Combat'
import { moveBudget } from './Movement'
import { canWatch } from './Overwatch'

/**
 * What a unit that has broken does, when the rules have taken it over.
 *
 * Rules, not a policy: both peers, a replay and the referee all work out the
 * same next command from the same state, which is why none of it is sent or
 * recorded — it is a consequence of the handover, like a reaction is of a
 * step. So the whole of it is integer comparisons over state everybody holds,
 * ties broken by squad order and tile index, and it acts only on enemies its
 * side can see: a panicking unit running *away* from somebody nobody on its
 * side has spotted would be telling its player where they are.
 *
 * One command at a time, asked again once the last has been carried out and
 * walked: a step can draw a watcher's fire, and whatever it does next is
 * decided from where it ended up.
 */

/** Enemies anybody on `unit`'s side can see from where they stand, in squad order. */
function threats<T extends Combatant>(grid: Grid, unit: T, units: readonly T[]): T[] {
  const eyes = units
    .filter((friend) => !friend.isDead && friend.faction === unit.faction)
    .map((friend) => ({ tile: friend.tile, eyes: eyesOf(grid, friend) }))
  return units.filter(
    (enemy) =>
      !enemy.isDead &&
      enemy.faction !== unit.faction &&
      eyes.some((friend) => sees(grid, friend.tile, friend.eyes, enemy.tile)),
  )
}

function distance2(a: Tile, b: Tile): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

/** Where `unit` could stand this turn, walking as it is now: its own tile first. */
function standable(grid: Grid, unit: Combatant, units: readonly Combatant[]): { reach: Reach; tiles: number[] } {
  const occupied = new Set<number>()
  for (const other of units) {
    if (other !== unit && !other.isDead) occupied.add(grid.index(other.tile.x, other.tile.y))
  }
  const reach = reachable(grid, unit.tile, occupied, moveBudget(unit))
  return { reach, tiles: [grid.index(unit.tile.x, unit.tile.y), ...reach.tiles] }
}

function tileOf(grid: Grid, index: number): Tile {
  return { x: index % grid.size, y: (index / grid.size) | 0 }
}

function walk(grid: Grid, unit: Combatant, reach: Reach, index: number): Command {
  return {
    type: 'moveUnit',
    faction: unit.faction,
    squadIndex: unit.squadIndex,
    path: routeTo(grid, reach, index).map(({ x, y }) => ({ x, y })),
  }
}

function toggleCover(unit: Combatant): Command {
  return { type: 'toggleCover', faction: unit.faction, squadIndex: unit.squadIndex }
}

/**
 * Where a panicking unit runs to: in sight of as few of the enemies its side
 * can see as it can manage, then as far from the nearest of them as it can
 * get, then the cheapest way there. Null when that is where it already is.
 */
function fleeTo(grid: Grid, unit: Combatant, seen: readonly Combatant[], units: readonly Combatant[]) {
  const { reach, tiles } = standable(grid, unit, units)
  const watchers = seen.map((enemy) => ({ tile: enemy.tile, eyes: eyesOf(grid, enemy) }))
  let best = -1
  let bestExposure = Infinity
  let bestNearest = -1
  for (const index of tiles) {
    const tile = tileOf(grid, index)
    let exposure = 0
    let nearest = Infinity
    for (const watcher of watchers) {
      if (sees(grid, watcher.tile, watcher.eyes, tile)) exposure++
      nearest = Math.min(nearest, distance2(watcher.tile, tile))
    }
    // Candidates arrive cheapest first, so a tie keeps the cheaper tile.
    if (exposure < bestExposure || (exposure === bestExposure && nearest > bestNearest)) {
      best = index
      bestExposure = exposure
      bestNearest = nearest
    }
  }
  return best === tiles[0] ? null : { reach, index: best }
}

/** Where a frenzied unit charges to: as near `target` as it can get. Null when it is there. */
function chargeTo(grid: Grid, unit: Combatant, target: Combatant, units: readonly Combatant[]) {
  const { reach, tiles } = standable(grid, unit, units)
  let best = tiles[0]!
  let bestDistance = distance2(unit.tile, target.tile)
  for (const index of tiles) {
    const d = distance2(tileOf(grid, index), target.tile)
    if (d < bestDistance) {
      best = index
      bestDistance = d
    }
  }
  return best === tiles[0] ? null : { reach, index: best }
}

/** The cheapest shot at `target` the unit can take and has the rounds for. */
function cheapestShot(grid: Grid, unit: Combatant, target: Combatant): ShotMode | null {
  let best: ShotMode | null = null
  for (const mode of unit.weapon.availableModes) {
    if (!canShoot(grid, unit, target, mode)) continue
    if (unit.weapon.currentClip < unit.weapon.bulletConsumption(mode)) continue
    if (best === null || shotApCost(unit, mode) < shotApCost(unit, best)) best = mode
  }
  return best
}

/**
 * Run: get up, go where the fewest enemies can see, get down if there are
 * points left. Seeing nobody, cower where it is.
 */
function panic<T extends Combatant>(grid: Grid, unit: T, units: readonly T[], moved: boolean): Command | null {
  const seen = threats(grid, unit, units)
  if (!moved && seen.length > 0) {
    const to = fleeTo(grid, unit, seen, units)
    if (to) return unit.isCrouching ? toggleCover(unit) : walk(grid, unit, to.reach, to.index)
  }
  return !unit.isCrouching && unit.ap >= RULES.coverApCost ? toggleCover(unit) : null
}

/**
 * Charge the nearest enemy its side can see: strike it if it can reach, close
 * on it once, then shoot at it with the cheapest shot until the points or the
 * rounds run out. Seeing nobody, watch for somebody.
 */
function frenzy<T extends Combatant>(grid: Grid, unit: T, units: readonly T[], moved: boolean): Command | null {
  const seen = threats(grid, unit, units)
  if (seen.length === 0) {
    return canWatch(unit) ? { type: 'overwatch', faction: unit.faction, squadIndex: unit.squadIndex } : null
  }
  let target = seen[0]!
  for (const enemy of seen) if (distance2(unit.tile, enemy.tile) < distance2(unit.tile, target.tile)) target = enemy
  const blow: Command = {
    type: 'meleeAttack',
    attackerFaction: unit.faction,
    attackerIndex: unit.squadIndex,
    targetFaction: target.faction,
    targetIndex: target.squadIndex,
  }
  if (canMelee(grid, unit, target)) return blow

  if (!moved) {
    const to = chargeTo(grid, unit, target, units)
    if (to) return unit.isCrouching ? toggleCover(unit) : walk(grid, unit, to.reach, to.index)
  }

  const mode = cheapestShot(grid, unit, target)
  if (mode) {
    return {
      type: 'fireShot',
      shooterFaction: unit.faction,
      shooterIndex: unit.squadIndex,
      targetFaction: target.faction,
      targetIndex: target.squadIndex,
      mode,
    }
  }
  const { weapon } = unit
  const empty = weapon.availableModes.every((m) => weapon.currentClip < weapon.bulletConsumption(m))
  if (empty && weapon.currentClip < weapon.maxClip && unit.ap >= RULES.reloadApCost) {
    return { type: 'reload', faction: unit.faction, squadIndex: unit.squadIndex }
  }
  return null
}

/**
 * The next thing a broken unit does, or null when it is done for the turn.
 * `moved` is whether it has already made its one move this turn.
 */
export function brokenStep<T extends Combatant>(grid: Grid, unit: T, units: readonly T[], moved: boolean): Command | null {
  if (unit.isDead) return null
  if (unit.broken === MoraleBreak.Panic) return panic(grid, unit, units, moved)
  if (unit.broken === MoraleBreak.Frenzy) return frenzy(grid, unit, units, moved)
  return null
}
