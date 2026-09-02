import { Block, blockHeight, faceToward, type Grid } from './Grid'
import { LEVEL_HEIGHT, TILE } from '../config'
import { WALLS } from './Walls'

/** A world-space point. Structural, so callers can pass a three `Vector3`. */
export interface Point3 {
  x: number
  y: number
  z: number
}

/**
 * What a camera→character segment has to see past.
 *
 * Two buffers because the two occluder families are addressed differently: a
 * crate belongs to a tile, a wall to an edge. Both are written, never cleared,
 * so several segments accumulate into one pass.
 */
export interface OcclusionMasks {
  /** One byte per tile, indexed by {@link Grid.index}. */
  tiles: Uint8Array
  /** One byte per edge, indexed by {@link Grid.edgeId}. */
  edges: Uint8Array
}

/**
 * Mark every occluder the segment `from`→`to` has to pass.
 *
 * A 2D DDA walk over the grid columns the segment crosses. A column counts
 * when the segment's height while inside it dips below whatever stands there;
 * a column it merely flies over — a 1 m crate with the ray still metres up —
 * does not. Each step between columns crosses one edge, which is exactly where
 * a wall lives, so walls are tested at the crossing rather than by footprint.
 */
export function markOccluders(
  grid: Grid,
  from: Point3,
  to: Point3,
  masks: OcclusionMasks,
): void {
  const half = grid.halfExtent

  let cx = Math.floor((from.x + half) / TILE)
  let cy = Math.floor((from.z + half) / TILE)
  const endX = Math.floor((to.x + half) / TILE)
  const endY = Math.floor((to.z + half) / TILE)

  const dx = to.x - from.x
  const dz = to.z - from.z
  const dy = to.y - from.y

  const stepX = dx > 0 ? 1 : -1
  const stepZ = dz > 0 ? 1 : -1

  // Segment parameter (0..1) at which the next grid line is crossed.
  let tMaxX = dx !== 0 ? ((cx + (dx > 0 ? 1 : 0)) * TILE - half - from.x) / dx : Infinity
  let tMaxZ = dz !== 0 ? ((cy + (dz > 0 ? 1 : 0)) * TILE - half - from.z) / dz : Infinity
  const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity
  const tDeltaZ = dz !== 0 ? Math.abs(TILE / dz) : Infinity

  // Every column the straight line crosses: at most one step per grid line.
  const steps = Math.abs(endX - cx) + Math.abs(endY - cy) + 2
  let tEnter = 0

  for (let i = 0; i < steps; i++) {
    const tExit = Math.min(tMaxX, tMaxZ, 1)

    if (grid.inBounds(cx, cy)) {
      const block = grid.blockAt(cx, cy)
      if (block !== Block.None) {
        const yEnter = from.y + dy * tEnter
        const yExit = from.y + dy * tExit
        const base = grid.levelAt(cx, cy) * LEVEL_HEIGHT
        // Blocks span y in [base, base + height]; both segment endpoints sit
        // above the floor, so overlap reduces to comparing the low end.
        if (Math.min(yEnter, yExit) < base + blockHeight(block)) {
          masks.tiles[grid.index(cx, cy)] = 1
        }
      }
    }

    if (tExit >= 1 || (cx === endX && cy === endY)) break

    // Stepping to the next column crosses one edge — test the wall on it at
    // the height the segment actually has there.
    const nextX = tMaxX < tMaxZ ? cx + stepX : cx
    const nextY = tMaxX < tMaxZ ? cy : cy + stepZ
    const side = faceToward({ x: cx, y: cy }, { x: nextX, y: nextY })
    if (side !== 0) {
      const kind = grid.wallAt(cx, cy, side)
      const spec = WALLS[kind]
      if (spec.height > 0) {
        const base =
          Math.min(grid.levelAt(cx, cy), grid.levelAt(nextX, nextY)) * LEVEL_HEIGHT
        if (from.y + dy * tExit < base + spec.height) {
          masks.edges[grid.edgeId(cx, cy, side)] = 1
        }
      }
    }

    if (tMaxX < tMaxZ) {
      cx += stepX
      tMaxX += tDeltaX
    } else {
      cy += stepZ
      tMaxZ += tDeltaZ
    }
    tEnter = tExit
  }
}
