import { EYE_HEIGHT, FULL_BLOCK_HEIGHT, HALF_BLOCK_HEIGHT } from '../config'

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
 * Most kinds stop movement, and what varies is how tall they stand and what
 * their material does to a bullet or a view. The exceptions are the open
 * kinds ({@link WallSpec.open}) — nothing at all, or a door standing open —
 * and a closed door, which a unit opens on its way through (`core/Doors`).
 */
export const WallKind = {
  /** No boundary: open ground, a doorway with no door in it, or a door kicked in. */
  None: 0,
  /** 2 m masonry. Stops sight and bullets. */
  Solid: 1,
  /** Chest-high parapet. Stops bullets, short enough to see and shoot over. */
  Parapet: 2,
  /** Glazing. Transparent and stops nothing, but you still cannot walk through it. */
  Glass: 3,
  /** A closed door: a wall to the eye and to a bullet, opened by walking through it. */
  Door: 4,
  /** A door standing open: a doorway until somebody closes it. */
  DoorOpen: 5,
  /** A locked door: a wall until it is unlocked with keys or forced. */
  Locked: 6,
} as const
export type WallKind = (typeof WallKind)[keyof typeof WallKind]

export interface WallSpec {
  /** Height in metres, measured from the floor of the lower tile it divides. */
  height: number
  /** Sight passes through the material at any height (glazing). */
  transparent: boolean
  /** The material stops a bullet, so standing behind it is worth something. */
  shields: boolean
  /**
   * Nothing stands in the way: a body walks through without doing anything,
   * and fire and smoke go through it as they do across open ground.
   */
  open: boolean
}

/**
 * Material properties per wall kind.
 *
 * Height lives here and nowhere else: line of sight, cover, camera occlusion
 * and the renderer all read it from this table, so a wall cannot be 2 m tall
 * to the simulation and some other height on screen.
 *
 * Note what is *not* here: whether a wall blocks sight, or how much cover it
 * gives. Neither is a fixed property of the kind, because both depend on which
 * storey you are standing on — see {@link wallHidesSight} and
 * {@link wallCover}.
 *
 * A closed door is masonry for everything but walking: nobody sees or shoots
 * through it, and it covers whoever stands behind it. That keeps what a door
 * does in a fight to one sentence — shut, it is a wall.
 */
export const WALLS: Record<WallKind, WallSpec> = {
  [WallKind.None]: { height: 0, transparent: true, shields: false, open: true },
  [WallKind.Solid]: { height: FULL_BLOCK_HEIGHT, transparent: false, shields: true, open: false },
  [WallKind.Parapet]: { height: HALF_BLOCK_HEIGHT, transparent: false, shields: true, open: false },
  [WallKind.Glass]: { height: FULL_BLOCK_HEIGHT, transparent: true, shields: false, open: false },
  [WallKind.Door]: { height: FULL_BLOCK_HEIGHT, transparent: false, shields: true, open: false },
  [WallKind.DoorOpen]: { height: 0, transparent: true, shields: false, open: true },
  [WallKind.Locked]: { height: FULL_BLOCK_HEIGHT, transparent: false, shields: true, open: false },
}

/**
 * Does a barrier topping out at `top` hide what lies beyond it from an eye on
 * the floor `floorY`?
 *
 * Judged against the observer's own storey, which is the whole point: the wall
 * around a building tops out level with its roof, so it hides the street from
 * someone at ground level and is underfoot to someone standing on top of it.
 */
export function wallHidesSight(kind: WallKind, top: number, floorY: number): boolean {
  return !WALLS[kind].transparent && top >= floorY + EYE_HEIGHT
}

/**
 * Cover for a unit standing on floor `floorY` behind a barrier topping out at
 * `top`.
 *
 * Chest-high is Low, head-high is Tall, and anything at or below the floor is
 * nothing at all. A material that does not stop bullets never shields,
 * however tall it is.
 */
export function wallCover(kind: WallKind, top: number, floorY: number): CoverLevel {
  if (!WALLS[kind].shields || top <= floorY) return CoverLevel.None
  return top >= floorY + EYE_HEIGHT ? CoverLevel.Tall : CoverLevel.Low
}
