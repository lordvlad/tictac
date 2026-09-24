import { LEVEL_HEIGHT, RULES } from '../config'
import { faceToward, ORTHOGONAL, type Grid, type Tile } from './Grid'
import { WallKind } from './Walls'

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
 * Walk the grid lines a straight line from one tile centre to another
 * crosses, in order, calling `cross(from, to)` for each orthogonal step and
 * `corner(from, to)` where the line threads a lattice point exactly — the
 * diagonal case, where it passes between two walls rather than through one.
 * Either returning true stops the walk; the result says whether it was
 * stopped.
 *
 * The one statement of "what does this line cross", shared by sight and by
 * anything that needs the edges themselves — a round breaking the window it
 * passes through.
 */
export function walkLine(
  from: Tile,
  to: Tile,
  cross: (a: Tile, b: Tile) => boolean,
  corner: (a: Tile, b: Tile) => boolean,
): boolean {
  let x = from.x
  let y = from.y
  if (x === to.x && y === to.y) return false

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
      if (corner({ x, y }, { x: x + stepX, y: y + stepY })) return true
      x += stepX
      y += stepY
      nextX += strideX
      nextY += strideY
    } else if (dueX < dueY) {
      if (cross({ x, y }, { x: x + stepX, y })) return true
      x += stepX
      nextX += strideX
    } else {
      if (cross({ x, y }, { x, y: y + stepY })) return true
      y += stepY
      nextY += strideY
    }
  }
  return false
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
 *
 * Smoke (`Grid.smoke`) stops it too: a line that enters a smoky tile — the
 * target's included — is blocked, and so is one that starts in smoke. Only a
 * neighbouring tile sees into or out of a cloud, which is also what keeps a
 * blow in smoke possible.
 */
export function hasLineOfSight(grid: Grid, from: Tile, to: Tile): boolean {
  const observerFloorY = grid.levelAt(from.x, from.y) * LEVEL_HEIGHT
  const near = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) <= 1
  if (!near && grid.smokeAt(from.x, from.y) > 0) return false
  const smoky = (tile: Tile) => !near && grid.smokeAt(tile.x, tile.y) > 0
  return !walkLine(
    from,
    to,
    (a, b) => grid.blocksSightBetween(a, b, observerFloorY) || smoky(b),
    (a, b) => grid.cornerClosed(a, b, observerFloorY) || smoky(b),
  )
}

/**
 * The glazing a straight line from `from` to `to` passes through, as edge
 * ids, in the order it meets them. A line that threads a corner passes
 * between the panes rather than through one, and breaks neither.
 */
export function glassCrossed(grid: Grid, from: Tile, to: Tile): number[] {
  const panes: number[] = []
  walkLine(
    from,
    to,
    (a, b) => {
      const side = faceToward(a, b)
      if (side !== 0 && grid.wallAt(a.x, a.y, side) === WallKind.Glass) panes.push(grid.edgeId(a.x, a.y, side))
      return false
    },
    () => false,
  )
  return panes
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

/** Where a unit looks from: its own tile, and beside the wall it hugs when peeking. */
export function eyesOf(grid: Grid, viewer: Viewer): Tile[] {
  return viewer.peek ? [viewer.tile, ...peekOrigins(grid, viewer.tile)] : [viewer.tile]
}

/**
 * Whether a unit at `origin`, looking from `eyes`, sees `to`.
 *
 * The one statement of what seeing is, shared by fog and by anything that may
 * only act on what it can see — a watcher reacting included. Range is measured
 * from the unit's own tile even for peeked sightlines: leaning round a corner
 * must not extend how far it can see.
 */
export function sees(grid: Grid, origin: Tile, eyes: readonly Tile[], to: Tile): boolean {
  if ((to.x - origin.x) ** 2 + (to.y - origin.y) ** 2 > RULES.sightRange ** 2) return false
  for (const eye of eyes) {
    if (hasLineOfSight(grid, eye, to)) return true
  }
  return false
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
    const eyes = eyesOf(grid, viewer)

    const minX = Math.max(0, origin.x - RULES.sightRange)
    const maxX = Math.min(size - 1, origin.x + RULES.sightRange)
    const minY = Math.max(0, origin.y - RULES.sightRange)
    const maxY = Math.min(size - 1, origin.y + RULES.sightRange)

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (existingVisMap[grid.index(x, y)] === VisState.Visible) continue
        if (sees(grid, origin, eyes, { x, y })) existingVisMap[grid.index(x, y)] = VisState.Visible
      }
    }
  }

  return existingVisMap
}
