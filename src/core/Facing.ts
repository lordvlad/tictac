import type { Tile } from './Grid'

/**
 * Which way a unit is facing, as a rule can use it.
 *
 * The view's facing is `targetYaw`, a float from `atan2`, and `atan2` is not
 * guaranteed to agree to the last bit between two engines — so no rule may
 * branch on it. A heading is one of eight compass directions on the grid,
 * worked out from a step or a line with comparisons only, which two peers
 * always agree about.
 *
 * Indexed clockwise from +y, the direction Blue deploys facing (yaw 0 looks
 * down +z, and a tile's y is its z).
 */
export const HEADINGS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
]

/**
 * The heading nearest the direction `(dx, dy)`, or `fallback` when there is
 * no direction at all.
 *
 * Straight when the other axis is within 22.5° of nothing, diagonal
 * otherwise. The boundary is tan 22.5° ≈ 0.414, taken as 5/12 so the test is
 * two multiplications: a float from a click and an integer from a step answer
 * the same way on every engine.
 */
export function headingToward(dx: number, dy: number, fallback = 0): number {
  if (dx === 0 && dy === 0) return fallback
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const x = ax * 12 < ay * 5 ? 0 : Math.sign(dx)
  const y = ay * 12 < ax * 5 ? 0 : Math.sign(dy)
  return HEADINGS.findIndex(([hx, hy]) => hx === x && hy === y)
}

/**
 * Whether an attack from `from` on `target` comes from behind it: from the
 * half of the world at its back, not level with its shoulders.
 *
 * Adjacent, that is the three rear neighbours of eight. Further off it is
 * the whole rear half-plane, which is what "flanked" means to a soldier who
 * is looking the other way. Anything with a tile and a heading will do — a
 * unit, or a policy's memory of where one stood and which way it faced.
 */
export function fromBehind(target: { tile: Tile; heading: number }, from: Tile): boolean {
  const [hx, hy] = HEADINGS[target.heading] ?? HEADINGS[0]!
  return hx * (from.x - target.tile.x) + hy * (from.y - target.tile.y) < 0
}
