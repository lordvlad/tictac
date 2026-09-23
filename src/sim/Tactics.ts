import { RULES } from '../config'
import { ShotMode } from '../core/Arsenal'
import { effectiveWeapon, hitChance, meleeChance, meleeWeapon, resolveDamage } from '../core/Ballistics'
import type { Combatant } from '../core/Combatant'
import { shotCoverLevel } from '../core/Cover'
import type { Grid, Tile } from '../core/Grid'
import { reachable, routeTo } from '../core/Pathfinding'
import { MELEE } from '../core/Melee'
import { eyesOf, hasLineOfSight, sees } from '../core/Visibility'
import { shotApCost } from '../game/Combat'
import { moveBudget } from '../game/Movement'

/**
 * Where to stand, for the sweep's policy.
 *
 * The old policy walked the shortest route at the nearest enemy and stopped
 * when it had a shot. It never asked what the walk cost, so a watched lane was
 * invisible to it: overwatch fired about once in five matches and melee would
 * have measured as worthless, because both are about crossing ground. This
 * scores every tile the unit can reach this turn on three things a player
 * weighs — what it could do from there, what walking there will draw, and what
 * standing there invites — and picks the best, staying put included.
 *
 * Everything is in one currency, expected hit points, so the terms trade
 * against each other without weights pretending to be physics. The one weight
 * that is a judgement, {@link ADVANCE_PER_METRE}, only matters when nothing can
 * be shot from anywhere reachable.
 *
 * Headless and pure: it reads units and the grid and returns a route. The
 * policy turns that into `moveUnit` intents.
 */

/**
 * What closing one metre is worth, in expected hit points, when there is
 * nothing to shoot yet. Small enough that a sheltered approach beats an open
 * one of similar length; large enough that a squad still closes at all.
 */
const ADVANCE_PER_METRE = 2

/** A move has to beat standing still by this much, or it is not worth the points. */
const MARGIN = 1

export interface Destination {
  /** Start first: the shape a `moveUnit` intent carries. */
  route: Tile[]
  /** What the unit can expect to do from there with the points left. */
  offense: number
  /** Expected damage from reactions provoked on the way. */
  danger: number
  /** Expected damage from enemies who can see the tile, on their turn. */
  exposure: number
}

/**
 * Whether a unit standing on `a` could strike one standing on `b`: the
 * adjacency and level half of `canMelee`, for tiles nobody is standing on yet.
 * Sight between them is the caller's check, which it has already made.
 */
function inReach(grid: Grid, a: Tile, b: Tile): boolean {
  const dx = Math.abs(a.x - b.x)
  const dy = Math.abs(a.y - b.y)
  return dx <= 1 && dy <= 1 && dx + dy > 0 && grid.levelAt(a.x, a.y) === grid.levelAt(b.x, b.y)
}

/** Expected damage from a blow by `attacker` on `defender`. */
function blow(attacker: Combatant, defender: Combatant): number {
  return (meleeChance(attacker, defender).chance / 100) * resolveDamage(meleeWeapon(attacker), defender).damage
}

/** Expected damage from spending `ap` on `target`, from `from`: by gun, or by hand when in reach. */
function offenseFrom(
  grid: Grid,
  shooter: Combatant,
  from: Tile,
  target: Combatant,
  distance: number,
  ap: number,
): number {
  const cover = shotCoverLevel(grid, from, target.tile)
  let best = 0
  if (inReach(grid, from, target.tile)) {
    best = blow(shooter, target) * Math.floor(ap / MELEE[shooter.sidearm].apCost)
  }
  for (const mode of shooter.weapon.availableModes) {
    const cost = shotApCost(shooter, mode)
    const bullets = shooter.weapon.bulletConsumption(mode)
    if (cost > ap || shooter.weapon.currentClip < bullets) continue
    const eff = effectiveWeapon(shooter, mode)
    if (distance > eff.maxRange) continue
    const shots = Math.min(Math.floor(ap / cost), Math.floor(shooter.weapon.currentClip / bullets))
    const chance = hitChance(shooter, target, distance, cover, mode).chance / 100
    const value = chance * resolveDamage(eff, target).damage * bullets * shots
    if (value > best) best = value
  }
  return best
}

/** Expected damage from one `mode` shot by `shooter` at `target` standing on `at`. */
function threat(grid: Grid, shooter: Combatant, target: Combatant, at: Tile, mode: ShotMode): number {
  const eff = effectiveWeapon(shooter, mode)
  const distance = grid.distance(shooter.tile, at)
  if (distance > eff.maxRange || shooter.weapon.currentClip <= 0) return 0
  const chance = hitChance(shooter, target, distance, shotCoverLevel(grid, shooter.tile, at), mode).chance / 100
  return chance * resolveDamage(eff, target).damage * shooter.weapon.bulletConsumption(mode)
}

/**
 * The best place for `unit` to be this turn, or `null` when that is where it
 * already stands.
 *
 * Reactions are charged once per watcher per route — the rule's own "one
 * reaction per watch" — at the first tile of the route that watcher sees. They
 * are propagated down the search tree as a bitmask rather than recomputed per
 * destination, because every tile's route is its parent's route plus one step.
 */
export function chooseDestination(
  grid: Grid,
  unit: Combatant,
  enemies: readonly Combatant[],
  occupied: Set<number>,
  /**
   * Handovers since anybody was hurt. Each one makes closing worth more: two
   * squads that each price the other's watch above a few metres of ground
   * will otherwise wait each other out to the turn cap, which is a standoff a
   * player breaks by getting impatient.
   */
  quiet = 0,
): Destination | null {
  const living = enemies.filter((enemy) => !enemy.isDead)
  if (living.length === 0) return null
  // A bit each in a 32-bit mask; a squad is four.
  const watchers = living.filter((enemy) => enemy.watching && enemy.weapon.currentClip > 0)
  const watcherEyes = watchers.map((watcher) => eyesOf(grid, watcher))

  const reach = reachable(grid, unit.tile, occupied, moveBudget(unit))
  const size = grid.size
  const startIdx = grid.index(unit.tile.x, unit.tile.y)
  const mask = new Uint32Array(size * size)
  const danger = new Float32Array(size * size)

  const judge = (at: Tile, ap: number, routeDanger: number) => {
    let offense = 0
    let exposure = 0
    let nearest = Infinity
    for (const enemy of living) {
      const distance = grid.distance(at, enemy.tile)
      if (distance < nearest) nearest = distance
      if (distance > RULES.sightRange || !hasLineOfSight(grid, at, enemy.tile)) continue
      offense = Math.max(offense, offenseFrom(grid, unit, at, enemy, distance, ap))
      // What they would do to it on their turn: shoot it, or, standing next to
      // it, hit it — whichever is worse for the unit.
      exposure += Math.max(
        threat(grid, enemy, unit, at, ShotMode.Snap),
        inReach(grid, enemy.tile, at) ? blow(enemy, unit) : 0,
      )
    }
    return { offense, exposure, nearest, danger: routeDanger }
  }

  const here = judge(unit.tile, unit.ap, 0)
  let best = { index: startIdx, ...here }

  // Two regimes, so a distance weight never argues with a shot: while anything
  // is shootable from somewhere reachable, the shot is the point; only when
  // nothing is does closing the distance count.
  const advance = ADVANCE_PER_METRE * (1 + quiet)
  const scoreOf = (j: typeof here, shooting: boolean) =>
    (shooting ? j.offense : -advance * j.nearest) - j.danger - j.exposure

  const judged: Array<{ index: number } & typeof here> = []
  let anyOffense = here.offense > 0
  for (const index of reach.tiles) {
    const parent = reach.from[index]!
    const at = { x: index % size, y: (index / size) | 0 }
    let seen = mask[parent]!
    let routeDanger = danger[parent]!
    for (let w = 0; w < watchers.length; w++) {
      const bit = 1 << w
      if (seen & bit) continue
      const watcher = watchers[w]!
      if (!sees(grid, watcher.tile, watcherEyes[w]!, at)) continue
      seen |= bit
      routeDanger += threat(grid, watcher, unit, at, ShotMode.Reaction)
    }
    mask[index] = seen
    danger[index] = routeDanger

    const ap = unit.ap - reach.cost[index]! * unit.moveCostMul
    const j = { index, ...judge(at, ap, routeDanger) }
    if (j.offense > 0) anyOffense = true
    judged.push(j)
  }

  let bestScore = scoreOf(best, anyOffense)
  for (const j of judged) {
    const score = scoreOf(j, anyOffense)
    if (score > bestScore) {
      bestScore = score
      best = j
    }
  }

  if (best.index === startIdx || bestScore < scoreOf(here, anyOffense) + MARGIN) return null
  return {
    route: routeTo(grid, reach, best.index),
    offense: best.offense,
    danger: best.danger,
    exposure: best.exposure,
  }
}
