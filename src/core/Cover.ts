import { Block, faceToward, type Grid, ORTHOGONAL, type Tile } from './Grid'
import { CoverLevel, WALLS } from './Walls'

/** The four side directions, in the same order as {@link ORTHOGONAL}: +x, -x, +z, -z. */
export const COVER_DIRS = ORTHOGONAL

/**
 * Cover shielding one side of `tile`.
 *
 * Two different things can shelter that side: the wall on the edge itself, and
 * a crate standing on the neighbouring tile. The better of the two wins — a
 * unit does not lose the wall it is hugging because the tile beyond happens to
 * be empty.
 */
export function coverLevelInDir(grid: Grid, tile: Tile, dx: number, dy: number): CoverLevel {
  const neighbour = { x: tile.x + dx, y: tile.y + dy }
  const side = faceToward(tile, neighbour)
  const fromWall = side === 0 ? CoverLevel.None : WALLS[grid.wallAt(tile.x, tile.y, side)].cover
  const fromBlock =
    grid.blockAt(neighbour.x, neighbour.y) === Block.Half ? CoverLevel.Low : CoverLevel.None
  return Math.max(fromWall, fromBlock) as CoverLevel
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
