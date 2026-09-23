import { RULES } from '../config'
import { ShotMode } from '../core/Arsenal'
import {
  effectiveWeapon,
  expectedRoundDamage,
  hitChance,
  meleeChance,
  meleeWeapon,
  resolveDamage,
} from '../core/Ballistics'
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

/**
 * How much of an enemy's *next-turn* threat to count against a tile it cannot
 * see yet. Half, because it has to spend the turn walking to take the shot, and
 * may spend it on somebody else.
 */
const NEXT_TURN = 0.5

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
 * An enemy as the side choosing believes it to be.
 *
 * Where it was last seen and whether it was watching then — not where it is.
 * Its sheet and kit are taken as read: what a policy may know about a unit's
 * *gun* is a separate question from where it is standing, and only the second
 * is what hiding is about.
 */
export interface Contact {
  unit: Combatant
  tile: Tile
  watching: boolean
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

/** Expected damage from spending `ap` on `target` standing on `at`, from `from`: by gun, or by hand when in reach. */
function offenseFrom(
  grid: Grid,
  shooter: Combatant,
  from: Tile,
  target: Combatant,
  at: Tile,
  distance: number,
  ap: number,
): number {
  const cover = shotCoverLevel(grid, from, at)
  let best = 0
  if (inReach(grid, from, at)) {
    best = blow(shooter, target) * Math.floor(ap / MELEE[shooter.sidearm].apCost)
  }
  for (const mode of shooter.weapon.availableModes) {
    const cost = shotApCost(shooter, mode)
    const bullets = shooter.weapon.bulletConsumption(mode)
    if (cost > ap || shooter.weapon.currentClip < bullets) continue
    const eff = effectiveWeapon(shooter, mode)
    if (distance > eff.maxRange) continue
    const shots = Math.min(Math.floor(ap / cost), Math.floor(shooter.weapon.currentClip / bullets))
    const value = expectedRoundDamage(eff, target, hitChance(shooter, target, distance, cover, mode)) * bullets * shots
    if (value > best) best = value
  }
  return best
}

/** Expected damage from one `mode` shot by `shooter` on `from` at `target` standing on `at`. */
function threat(grid: Grid, shooter: Combatant, from: Tile, target: Combatant, at: Tile, mode: ShotMode): number {
  const eff = effectiveWeapon(shooter, mode)
  const distance = grid.distance(from, at)
  if (distance > eff.maxRange || shooter.weapon.currentClip <= 0) return 0
  const odds = hitChance(shooter, target, distance, shotCoverLevel(grid, from, at), mode)
  return expectedRoundDamage(eff, target, odds) * shooter.weapon.bulletConsumption(mode)
}

/**
 * What `shooter` on `from` could do to `target` standing on `at` after
 * spending its next turn closing: its points less a snap shot's, walked
 * straight at the tile, then the shot — from the direction it stands in now,
 * so cover facing it counts.
 *
 * Straight-line and wall-blind on purpose: this prices *where a unit ends its
 * turn*, not a route, and it only has to be right about the thing that was
 * losing matches — stopping in the open inside what an enemy can reach and
 * shoot.
 */
function nextTurnThreat(grid: Grid, shooter: Combatant, from: Tile, target: Combatant, at: Tile): number {
  if (shooter.weapon.currentClip <= 0) return 0
  const eff = effectiveWeapon(shooter, ShotMode.Snap)
  const walk = Math.max(0, shooter.effectiveMaxAp - shotApCost(shooter, ShotMode.Snap)) / shooter.moveCostMul
  const distance = Math.max(1, grid.distance(from, at) - walk)
  if (distance > eff.maxRange) return 0
  const odds = hitChance(shooter, target, distance, shotCoverLevel(grid, from, at), ShotMode.Snap)
  return expectedRoundDamage(eff, target, odds) * shooter.weapon.bulletConsumption(ShotMode.Snap)
}

/**
 * The best place for `unit` to be this turn, or `null` when that is where it
 * already stands.
 *
 * Judged against `contacts` — where the side believes the enemy is — never
 * against where the enemy actually is. With nothing believed, the unit heads
 * for `search` instead, which is how a side that has lost the enemy finds it
 * again rather than standing still until the turn cap.
 *
 * Reactions are charged once per watcher per route — the rule's own "one
 * reaction per watch" — at the first tile of the route that watcher sees. They
 * are propagated down the search tree as a bitmask rather than recomputed per
 * destination, because every tile's route is its parent's route plus one step.
 */
export function chooseDestination(
  grid: Grid,
  unit: Combatant,
  contacts: readonly Contact[],
  occupied: Set<number>,
  /**
   * Handovers since anybody was hurt. Each one makes closing worth more: two
   * squads that each price the other's watch above a few metres of ground
   * will otherwise wait each other out to the turn cap, which is a standoff a
   * player breaks by getting impatient.
   */
  quiet = 0,
  /**
   * With nothing believed, the walking cost from every tile to where the unit
   * should look — walked, not measured, because ground behind a wall is a
   * metre away as the crow flies and a building away on foot, and a unit that
   * closed on it by the crow would stand against the wall for the rest of the
   * match. Null to stay put.
   */
  search: Float32Array | null = null,
): Destination | null {
  const searching = contacts.length === 0
  if (searching && !search) return null
  // A bit each in a 32-bit mask; a squad is four.
  const watchers = contacts.filter((contact) => contact.watching && contact.unit.weapon.currentClip > 0)
  const watcherEyes = watchers.map((watcher) => eyesOf(grid, { tile: watcher.tile, peek: watcher.unit.peek }))

  // Searching, a unit keeps a shot's points in hand. Whoever walks into the
  // other's view has usually spent the turn walking, and the side it found
  // answers with everything — so without a reserve, finding the enemy first
  // was how a side lost, and the side that happened to find first was
  // decided by turn order.
  const keep = searching ? shotApCost(unit, ShotMode.Snap) : 0
  const reach = reachable(grid, unit.tile, occupied, Math.max(0, unit.ap - keep) / unit.moveCostMul)
  const toSearch = searching ? search : null
  const size = grid.size
  const startIdx = grid.index(unit.tile.x, unit.tile.y)
  const mask = new Uint32Array(size * size)
  const danger = new Float32Array(size * size)

  const judge = (at: Tile, ap: number, routeDanger: number) => {
    let offense = 0
    let exposure = 0
    let nearest = toSearch ? toSearch[grid.index(at.x, at.y)]! : Infinity
    for (const { unit: enemy, tile } of contacts) {
      const distance = grid.distance(at, tile)
      if (distance < nearest) nearest = distance
      if (distance > RULES.sightRange || !hasLineOfSight(grid, at, tile)) {
        // Out of its sight now is not out of its reach next turn: a tile it
        // can walk into range of and shoot is a tile to end a turn on warily.
        exposure += NEXT_TURN * nextTurnThreat(grid, enemy, tile, unit, at)
        continue
      }
      offense = Math.max(offense, offenseFrom(grid, unit, at, enemy, tile, distance, ap))
      // What they would do to it on their turn: shoot it, or, standing next to
      // it, hit it — whichever is worse for the unit.
      exposure += Math.max(
        threat(grid, enemy, tile, unit, at, ShotMode.Snap),
        inReach(grid, tile, at) ? blow(enemy, unit) : 0,
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
      routeDanger += threat(grid, watcher.unit, watcher.tile, unit, at, ShotMode.Reaction)
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
