import { FULL_BLOCK_HEIGHT, HALF_BLOCK_HEIGHT } from '../config'

/**
 * How much a barrier shields the tile behind it.
 *
 * Lives here rather than with the shot geometry because it is a property of
 * the barrier itself: a wall kind and a crate answer the same question, and
 * {@link Cover} only decides *which* barrier a given shot has to cross.
 */
export const CoverLevel = {
  None: 0,
  Low: 1,
  Tall: 2,
} as const
export type CoverLevel = (typeof CoverLevel)[keyof typeof CoverLevel]

/**
 * A wall is a boundary between two adjacent tiles, not an occupant of one.
 *
 * Every kind stops movement — a barrier that lets units through is simply
 * absent ({@link WallKind.None}), which is also what a doorway is. What varies
 * is how tall it stands, whether sight passes, and how well it shields.
 */
export const WallKind = {
  /** No boundary: open ground, or a doorway punched through a run of wall. */
  None: 0,
  /** 2 m masonry. Stops sight; full cover. */
  Solid: 1,
  /** Chest-high parapet. See and shoot over it; half cover. */
  Parapet: 2,
  /** Glazing. Transparent and offers no shelter, but you still cannot walk through it. */
  Glass: 3,
} as const
export type WallKind = (typeof WallKind)[keyof typeof WallKind]

export interface WallSpec {
  /** Height in metres, measured from the floor of the lower of the two tiles. */
  height: number
  /** Does it stop a line-of-sight ray? */
  blocksSight: boolean
  /** Cover granted to a unit standing behind it. */
  cover: CoverLevel
}

/**
 * Material properties per wall kind.
 *
 * The single source for wall height: line of sight, camera occlusion and the
 * renderer all read it here, so a wall cannot be 2 m tall to the simulation
 * and some other height on screen.
 */
export const WALLS: Record<WallKind, WallSpec> = {
  [WallKind.None]: { height: 0, blocksSight: false, cover: CoverLevel.None },
  [WallKind.Solid]: { height: FULL_BLOCK_HEIGHT, blocksSight: true, cover: CoverLevel.Tall },
  [WallKind.Parapet]: { height: HALF_BLOCK_HEIGHT, blocksSight: false, cover: CoverLevel.Low },
  [WallKind.Glass]: { height: FULL_BLOCK_HEIGHT, blocksSight: false, cover: CoverLevel.None },
}
