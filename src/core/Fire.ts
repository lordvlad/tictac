import { LEVEL_HEIGHT } from '../config'
import { Block, type Grid, ORTHOGONAL, type Tile } from './Grid'
import type { Roll } from './rng'
import { CRATE_FIRE, Surface, SURFACES } from './Surfaces'
import { walkLine } from './Visibility'
import { WallKind } from './Walls'

/**
 * Fire and smoke on the ground: what catches, how long it burns, where it
 * goes, and the smoke it and a smoke grenade leave — which sight does not
 * pass through (`hasLineOfSight`).
 *
 * Rules over the grid and nothing else, so both peers, a replay and the
 * referee burn the same map the same way. Every change goes through a
 * {@link Ground} — the one writer of ground state, which keeps the replicated
 * record and the grid's index in step, as `WallSystem` does for walls.
 */

/** The one writer of what is on the ground (`GroundSystem`). */
export interface Ground {
  readonly grid: Grid
  /** Set a tile burning for `turns` handovers, or put it out with 0. */
  setFire(index: number, turns: number): void
  /** A tile has burned out: its floor is ash, and a crate on it is gone. */
  burnOut(index: number): void
  /** Fill a tile with smoke for `turns` handovers, or clear it with 0. */
  setSmoke(index: number, turns: number): void
}

/** Percent chance a burning neighbour sets this tile alight: its floor's, or a crate's if higher. */
export function flammability(grid: Grid, index: number): number {
  const surface = SURFACES[grid.surfaces[index] as Surface].flammability
  return grid.blocks[index] === Block.Half ? Math.max(surface, CRATE_FIRE.flammability) : surface
}

/** Handovers a tile burns for once alight: its floor's, or a crate's if longer. */
export function burnTime(grid: Grid, index: number): number {
  const surface = SURFACES[grid.surfaces[index] as Surface].burns
  return grid.blocks[index] === Block.Half ? Math.max(surface, CRATE_FIRE.burns) : surface
}

/**
 * Whether fire can pass from `a` to its orthogonal neighbour `b`: the same
 * floor, and nothing standing on the edge between — masonry and glass alike.
 */
function passes(grid: Grid, a: Tile, b: Tile): boolean {
  if (!grid.inBounds(b.x, b.y)) return false
  if (grid.levelAt(a.x, a.y) !== grid.levelAt(b.x, b.y)) return false
  return grid.wallBetween(a, b) === WallKind.None
}

/**
 * Set a blast alight: every tile within `radius` of `at` on its floor that
 * the blast reaches without a wall in the way burns for `fuel` handovers, or
 * its own burn time if that is longer. Returns the tiles now burning, in
 * index order.
 */
export function kindle(ground: Ground, at: Tile, radius: number, fuel: number): number[] {
  const { grid } = ground
  const lit: number[] = []
  if (!grid.inBounds(at.x, at.y)) return lit
  for (let y = at.y - radius; y <= at.y + radius; y++) {
    for (let x = at.x - radius; x <= at.x + radius; x++) {
      const tile = { x, y }
      if (!grid.inBounds(x, y) || grid.distance(at, tile) > radius) continue
      if (grid.levelAt(x, y) !== grid.levelAt(at.x, at.y)) continue
      // The centre always burns; an arm of the blast only past open edges.
      if ((x !== at.x || y !== at.y) && !passes(grid, at, { x: at.x + Math.sign(x - at.x), y: at.y + Math.sign(y - at.y) })) continue
      const index = grid.index(x, y)
      const turns = Math.max(fuel, burnTime(grid, index), grid.fire[index]!)
      ground.setFire(index, turns)
      ground.setSmoke(index, Math.max(grid.smoke[index]!, turns + 1))
      lit.push(index)
    }
  }
  return lit
}

/** What a handover did to the fire. */
export interface Burn {
  /** Tiles that caught, in index order. */
  caught: number[]
  /** Tiles that burned out, in index order. */
  burnedOut: number[]
}

/**
 * A handover's worth of fire and smoke, from the match's dice.
 *
 * Smoke thins by one everywhere. Then every tile burning at the start
 * spreads: for each of its orthogonal neighbours that can burn, is not
 * already alight or ash, and that fire can pass to, one draw against the
 * neighbour's flammability. Tiles are taken in index order and neighbours in
 * {@link ORTHOGONAL} order, so both peers draw the same numbers for the same
 * questions. Then every tile that was burning burns down by one, and a tile
 * at nothing has burned out. What caught this handover starts burning next.
 * Whatever is burning smokes.
 */
export function burn(ground: Ground, roll: Roll): Burn {
  const { grid } = ground
  // Smoke thins first, so a cloud laid for four handovers is gone after four.
  for (let i = 0; i < grid.smoke.length; i++) {
    const smoke = grid.smoke[i]!
    if (smoke > 0) ground.setSmoke(i, smoke - 1)
  }
  const burning: number[] = []
  for (let i = 0; i < grid.fire.length; i++) if (grid.fire[i]! > 0) burning.push(i)

  const caught: number[] = []
  const catching = new Set<number>()
  for (const index of burning) {
    const from = { x: index % grid.size, y: (index / grid.size) | 0 }
    for (const [dx, dy] of ORTHOGONAL) {
      const to = { x: from.x + dx, y: from.y + dy }
      if (!passes(grid, from, to)) continue
      const next = grid.index(to.x, to.y)
      if (grid.fire[next]! > 0 || catching.has(next)) continue
      const chance = flammability(grid, next)
      if (chance <= 0) continue
      if (roll() * 100 < chance) {
        catching.add(next)
        caught.push(next)
      }
    }
  }

  const burnedOut: number[] = []
  for (const index of burning) {
    const left = grid.fire[index]! - 1
    ground.setFire(index, left)
    if (left === 0) {
      ground.burnOut(index)
      burnedOut.push(index)
    }
  }
  caught.sort((a, b) => a - b)
  for (const index of caught) ground.setFire(index, burnTime(grid, index))
  // A fire smokes while it burns, and for a handover after.
  for (let i = 0; i < grid.fire.length; i++) {
    const fire = grid.fire[i]!
    if (fire > 0) ground.setSmoke(i, Math.max(grid.smoke[i]!, fire + 1))
  }
  return { caught, burnedOut }
}

/**
 * Fill a blast with smoke for `turns` handovers: every tile within `radius`
 * of `at` on its floor that a line from the centre reaches without crossing
 * a wall of any kind — glass keeps smoke out as well as masonry does.
 * Returns the tiles filled, in index order.
 */
export function billow(ground: Ground, at: Tile, radius: number, turns: number): number[] {
  const { grid } = ground
  const filled: number[] = []
  if (!grid.inBounds(at.x, at.y)) return filled
  const floorY = grid.levelAt(at.x, at.y) * LEVEL_HEIGHT
  for (let y = at.y - radius; y <= at.y + radius; y++) {
    for (let x = at.x - radius; x <= at.x + radius; x++) {
      const tile = { x, y }
      if (!grid.inBounds(x, y) || grid.distance(at, tile) > radius) continue
      if (grid.levelAt(x, y) !== grid.levelAt(at.x, at.y)) continue
      const walled = walkLine(
        at,
        tile,
        (a, b) => grid.wallBetween(a, b) !== WallKind.None,
        (a, b) => grid.cornerClosed(a, b, floorY),
      )
      if (walled) continue
      const index = grid.index(x, y)
      ground.setSmoke(index, Math.max(grid.smoke[index]!, turns))
      filled.push(index)
    }
  }
  return filled
}

/** What a tile is once it has burned: ash, if its floor burns at all. */
export function burnedSurface(surface: Surface): Surface {
  return SURFACES[surface].flammability > 0 ? Surface.Ash : surface
}
