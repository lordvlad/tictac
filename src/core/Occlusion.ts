import { Block, blockHeight, type Grid } from './Grid'
import { TILE } from '../config'

/** A world-space point. Structural, so callers can pass a three `Vector3`. */
export interface Point3 {
  x: number
  y: number
  z: number
}

/**
 * Mark every blocking tile the segment `from`→`to` passes through.
 *
 * A 2D DDA walk over the grid columns the segment crosses, keeping only the
 * columns whose block actually stands in the way: the segment's height while it
 * is inside a column must dip below that block's height. Columns the segment
 * merely flies over (a 1 m crate with the ray still metres up) do not count.
 *
 * `mask` is one byte per tile and is written, never cleared, so several segments
 * can accumulate into one pass.
 */
export function markOccludedTiles(
  grid: Grid,
  from: Point3,
  to: Point3,
  mask: Uint8Array,
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
        // Blocks span y in [0, height]; both segment endpoints sit above the
        // floor, so overlap reduces to comparing the low end vs. the height.
        if (Math.min(yEnter, yExit) < blockHeight(block)) {
          mask[grid.index(cx, cy)] = 1
        }
      }
    }

    if (tExit >= 1 || (cx === endX && cy === endY)) break
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
