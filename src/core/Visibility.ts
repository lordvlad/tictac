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
 * Check if there is clear line of sight between two tiles on the grid.
 * Only FULL blocks stop line of sight rays.
 */
export function hasLineOfSight(grid: Grid, from: Tile, to: Tile): boolean {
  if (from.x === to.x && from.y === to.y) return true

  let x0 = from.x
  let y0 = from.y
  const x1 = to.x
  const y1 = to.y

  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)

  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1

  let err = dx - dy

  while (x0 !== x1 || y0 !== y1) {
    // If intermediate tile (excluding start and end) blocks sight, ray is blocked
    if ((x0 !== from.x || y0 !== from.y) && (x0 !== to.x || y0 !== to.y)) {
      if (grid.blocksSight(x0, y0)) {
        return false
      }
    }

    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x0 += sx
    }
    if (e2 < dx) {
      err += dx
      y0 += sy
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
 * Leaning only makes sense against something: the unit must be touching a
 * sight-blocking tile, and it can then lean into any free orthogonal
 * neighbour. Standing at the end of a wall, that neighbour is the tile past
 * the corner — which is exactly the view the wall was denying.
 */
export function peekOrigins(grid: Grid, from: Tile): Tile[] {
  let hugsWall = false
  for (const [dx, dy] of ORTHOGONAL) {
    if (grid.blocksSight(from.x + dx, from.y + dy)) {
      hugsWall = true
      break
    }
  }
  if (!hugsWall) return []

  const origins: Tile[] = []
  for (const [dx, dy] of ORTHOGONAL) {
    const x = from.x + dx
    const y = from.y + dy
    if (grid.isWalkable(x, y)) origins.push({ x, y })
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
