import { SIGHT_RANGE } from '../config'
import type { Grid, Tile } from './Grid'

/**
 * Visibility states:
 * 0 = Unknown (black)
 * 1 = Explored (dimmed remembered terrain)
 * 2 = Visible (currently lit by a soldier)
 */
export const enum VisState {
  Unknown = 0,
  Explored = 1,
  Visible = 2,
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

/**
 * Recompute visibility map for a faction given living soldier positions.
 */
export function computeFactionVisibility(
  grid: Grid,
  soldierTiles: Tile[],
  existingVisMap: Uint8Array,
): Uint8Array {
  const size = grid.size

  // Downgrade all current Visible (2) tiles to Explored (1)
  for (let i = 0; i < existingVisMap.length; i++) {
    if (existingVisMap[i] === VisState.Visible) {
      existingVisMap[i] = VisState.Explored
    }
  }

  for (const origin of soldierTiles) {
    const minX = Math.max(0, origin.x - SIGHT_RANGE)
    const maxX = Math.min(size - 1, origin.x + SIGHT_RANGE)
    const minY = Math.max(0, origin.y - SIGHT_RANGE)
    const maxY = Math.min(size - 1, origin.y + SIGHT_RANGE)

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const distSq = (x - origin.x) ** 2 + (y - origin.y) ** 2
        if (distSq > SIGHT_RANGE ** 2) continue

        const targetTile = { x, y }
        if (hasLineOfSight(grid, origin, targetTile)) {
          existingVisMap[grid.index(x, y)] = VisState.Visible
        }
      }
    }
  }

  return existingVisMap
}
