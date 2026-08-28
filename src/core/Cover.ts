import { Block, type Grid, ORTHOGONAL, type Tile } from './Grid'

/**
 * Directional cover model. Cover is evaluated independently for each of a
 * tile's four orthogonal sides:
 *
 *   - a Half block (1 m crate) gives Low cover;
 *   - a Full block (2 m wall) — or the map boundary — gives Tall cover;
 *   - open ground gives no cover.
 *
 * A shot only benefits from the cover on the side(s) it actually crosses.
 */
export const CoverLevel = {
  None: 0,
  Low: 1,
  Tall: 2,
} as const
export type CoverLevel = (typeof CoverLevel)[keyof typeof CoverLevel]

/** The four side directions, in the same order as {@link ORTHOGONAL}: +x, -x, +z, -z. */
export const COVER_DIRS = ORTHOGONAL

/** Cover provided by the block on one side of `tile`. Out-of-bounds counts as Tall (map edge). */
export function coverLevelInDir(grid: Grid, tile: Tile, dx: number, dy: number): CoverLevel {
  const block = grid.blockAt(tile.x + dx, tile.y + dy)
  if (block === Block.Full) return CoverLevel.Tall
  if (block === Block.Half) return CoverLevel.Low
  return CoverLevel.None
}

/** Cover level on every side of `tile`, aligned to {@link COVER_DIRS}. */
export function directionalCover(grid: Grid, tile: Tile): CoverLevel[] {
  return COVER_DIRS.map(([dx, dy]) => coverLevelInDir(grid, tile, dx, dy))
}

/**
 * Cover shielding `targetTile` from a shot fired at it from `shooterTile`: the
 * strongest of the (up to two) sides the incoming bullet crosses. A straight
 * shot crosses one side; a diagonal one grazes a corner, so either adjoining
 * side can protect and the stronger wins.
 */
export function shotCoverLevel(grid: Grid, shooterTile: Tile, targetTile: Tile): CoverLevel {
  const sx = Math.sign(shooterTile.x - targetTile.x)
  const sy = Math.sign(shooterTile.y - targetTile.y)
  let level: CoverLevel = CoverLevel.None
  if (sx !== 0) level = Math.max(level, coverLevelInDir(grid, targetTile, sx, 0)) as CoverLevel
  if (sy !== 0) level = Math.max(level, coverLevelInDir(grid, targetTile, 0, sy)) as CoverLevel
  return level
}
