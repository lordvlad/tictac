import { RULES } from '../config'
import { ORTHOGONAL, type Grid, type Tile } from './Grid'

/**
 * Visibility states, and the one brightness ramp every renderer must use.
 *
 * Plain object rather than a `const enum`: the bundler transpiles each file on
 * its own, so a cross-module `const enum` has no runtime value to read.
 */
export const VisState = {
  /** Never seen — pitch black shroud. */
  Unknown: 0,
  /** Seen earlier, remembered terrain. */
  Explored: 1,
  /** Currently in a soldier's line of sight. */
  Visible: 2,
} as const
export type VisState = (typeof VisState)[keyof typeof VisState]

/**
 * Brightness multiplier per state. Owning it here is what keeps the floor and
 * the blocks standing on it dimming by the same amount — they previously
 * disagreed by more than 2x (walls 0.22 against a floor that resolved to
 * ~0.495 through the ground shader's `mix`).
 */
export const VIS_BRIGHTNESS: Record<VisState, number> = {
  [VisState.Unknown]: 0,
  [VisState.Explored]: 0.35,
  [VisState.Visible]: 1,
}

export function createVisibilityMap(size: number): Uint8Array {
  return new Uint8Array(size * size)
}

/**
 * Is there clear line of sight from one tile centre to another?
 *
 * Sight is blocked by the walls the ray *crosses*, so this walks grid lines
 * rather than tiles: a wall is a boundary with no footprint, and asking "does
 * this tile block sight" has no meaning any more.
 *
 * Where the ray threads a lattice point exactly — the diagonal case — it slips
 * past unless both walls meeting at that corner are opaque. That is what lets
 * a unit see diagonally around the end of a wall.
 */
export function hasLineOfSight(grid: Grid, from: Tile, to: Tile): boolean {
  let x = from.x
  let y = from.y
  if (x === to.x && y === to.y) return true

  const spanX = Math.abs(to.x - from.x)
  const spanY = Math.abs(to.y - from.y)
  const stepX = Math.sign(to.x - from.x)
  const stepY = Math.sign(to.y - from.y)

  // Ray parameter at the next grid line: half a tile out of the centre, then
  // one tile per crossing.
  let nextX = spanX === 0 ? Infinity : 0.5 / spanX
  let nextY = spanY === 0 ? Infinity : 0.5 / spanY
  const strideX = spanX === 0 ? Infinity : 1 / spanX
  const strideY = spanY === 0 ? Infinity : 1 / spanY

  while (x !== to.x || y !== to.y) {
    // An axis that has arrived must not be stepped again, or the walk overruns
    // the target and reads walls beyond it.
    const dueX = x === to.x ? Infinity : nextX
    const dueY = y === to.y ? Infinity : nextY

    if (Math.abs(dueX - dueY) < 1e-9) {
      if (grid.cornerClosed({ x, y }, { x: x + stepX, y: y + stepY }, true)) return false
      x += stepX
      y += stepY
      nextX += strideX
      nextY += strideY
    } else if (dueX < dueY) {
      if (grid.blocksSightBetween({ x, y }, { x: x + stepX, y })) return false
      x += stepX
      nextX += strideX
    } else {
      if (grid.blocksSightBetween({ x, y }, { x, y: y + stepY })) return false
      y += stepY
      nextY += strideY
    }
  }

  return true
}

/** A unit doing the looking. */
export interface Viewer {
  tile: Tile
  /** Corner peeking: also see from the free tiles beside the wall it hugs. */
  peek: boolean
}

/**
 * Tiles a peeking unit may also look from.
 *
 * Leaning only makes sense against something: the unit must be up against a
 * sight-blocking wall, and it can then lean into any neighbour it could have
 * stepped to. Standing at the end of a wall, that neighbour is the tile past
 * the corner — which is exactly the view the wall was denying.
 */
export function peekOrigins(grid: Grid, from: Tile): Tile[] {
  let hugsWall = false
  for (const [dx, dy] of ORTHOGONAL) {
    if (grid.blocksSightBetween(from, { x: from.x + dx, y: from.y + dy })) {
      hugsWall = true
      break
    }
  }
  if (!hugsWall) return []

  const origins: Tile[] = []
  for (const [dx, dy] of ORTHOGONAL) {
    const to = { x: from.x + dx, y: from.y + dy }
    if (grid.canTraverse(from, to)) origins.push(to)
  }
  return origins
}

/**
 * Recompute visibility map for a faction from its living units.
 *
 * Range is always measured from the unit's own tile, including for peeked
 * sightlines: leaning around a corner must not extend how far it can see.
 */
export function computeFactionVisibility(
  grid: Grid,
  viewers: readonly Viewer[],
  existingVisMap: Uint8Array,
): Uint8Array {
  const size = grid.size

  // Downgrade all current Visible (2) tiles to Explored (1)
  for (let i = 0; i < existingVisMap.length; i++) {
    if (existingVisMap[i] === VisState.Visible) {
      existingVisMap[i] = VisState.Explored
    }
  }

  for (const viewer of viewers) {
    const origin = viewer.tile
    const eyes = [origin, ...(viewer.peek ? peekOrigins(grid, origin) : [])]

    const minX = Math.max(0, origin.x - RULES.sightRange)
    const maxX = Math.min(size - 1, origin.x + RULES.sightRange)
    const minY = Math.max(0, origin.y - RULES.sightRange)
    const maxY = Math.min(size - 1, origin.y + RULES.sightRange)

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const distSq = (x - origin.x) ** 2 + (y - origin.y) ** 2
        if (distSq > RULES.sightRange ** 2) continue
        if (existingVisMap[grid.index(x, y)] === VisState.Visible) continue

        const targetTile = { x, y }
        for (const eye of eyes) {
          if (hasLineOfSight(grid, eye, targetTile)) {
            existingVisMap[grid.index(x, y)] = VisState.Visible
            break
          }
        }
      }
    }
  }

  return existingVisMap
}
