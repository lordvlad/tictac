import { Vector3 } from 'three'
import { FULL_BLOCK_HEIGHT, GRID_SIZE, HALF_BLOCK_HEIGHT, LEVEL_HEIGHT, RULES, TILE } from '../config'

export const Block = {
  /** Open floor. */
  None: 0,
  /** 1 m crate — blocks movement, does NOT block line of sight, grants half cover. */
  Half: 1,
  /** 2 m wall/building — blocks movement AND line of sight, grants full cover. */
  Full: 2,
  /** A flight of steps. Enterable from its foot and its head only. */
  Stair: 3,
} as const
export type Block = (typeof Block)[keyof typeof Block]

export const StairDirection = {
  North: 0, // Lower at (x, y-1), Upper at (x, y+1)
  East: 1,  // Lower at (x-1, y), Upper at (x+1, y)
  South: 2, // Lower at (x, y+1), Upper at (x, y-1)
  West: 3,  // Lower at (x+1, y), Upper at (x-1, y)
} as const
export type StairDirection = (typeof StairDirection)[keyof typeof StairDirection]

/**
 * Which vertical face of a tile carries a ladder, as bit flags.
 *
 * A ladder is bolted to the face of a raised tile and links it to the tile one
 * storey below on that side. It is an edge between two tiles, not a tile of
 * its own: it costs no floor space and nothing stands "on" it.
 */
export const LadderFace = {
  North: 1 << 0, // face toward y - 1
  East: 1 << 1,  // face toward x + 1
  South: 1 << 2, // face toward y + 1
  West: 1 << 3,  // face toward x - 1
} as const
export type LadderFace = (typeof LadderFace)[keyof typeof LadderFace]

/** The face of `from` that looks at `to`, or 0 when they are not orthogonal neighbours. */
export function faceToward(from: Tile, to: Tile): LadderFace | 0 {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === -1) return LadderFace.North
  if (dx === 0 && dy === 1) return LadderFace.South
  if (dx === 1 && dy === 0) return LadderFace.East
  if (dx === -1 && dy === 0) return LadderFace.West
  return 0
}

export function blockHeight(block: Block): number {
  if (block === Block.Half) return HALF_BLOCK_HEIGHT
  if (block === Block.Full) return FULL_BLOCK_HEIGHT
  return 0
}

/** A tile coordinate. Immutable value object; compare with `Grid.index`. */
export interface Tile {
  x: number
  y: number
}

export function tileEquals(a: Tile | null, b: Tile | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y
}

/** 8-connected neighbour offsets, orthogonals first. */
export const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

export const ORTHOGONAL: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/**
 * The tactical grid. Owns terrain only — unit occupancy is tracked separately
 * so that pathfinding can be asked to ignore specific units.
 */
export class Grid {
  readonly size: number
  readonly blocks: Uint8Array
  readonly levels: Uint8Array
  readonly stairDirections: Uint8Array
  /** Ladder faces per tile, as a {@link LadderFace} bitmask. */
  readonly ladderFaces: Uint8Array

  constructor(size: number = GRID_SIZE) {
    this.size = size
    this.blocks = new Uint8Array(size * size)
    this.levels = new Uint8Array(size * size)
    this.stairDirections = new Uint8Array(size * size)
    this.ladderFaces = new Uint8Array(size * size)
  }

  index(x: number, y: number): number {
    return y * this.size + x
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size
  }

  blockAt(x: number, y: number): Block {
    if (!this.inBounds(x, y)) return Block.Full
    return this.blocks[y * this.size + x] as Block
  }

  setBlock(x: number, y: number, block: Block): void {
    if (!this.inBounds(x, y)) return
    this.blocks[y * this.size + x] = block
  }

  /** Level / elevation index at tile (0 = ground, 1 = upper level, etc.). */
  levelAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0
    return this.levels[y * this.size + x]!
  }

  setLevel(x: number, y: number, level: number): void {
    if (!this.inBounds(x, y)) return
    this.levels[y * this.size + x] = level
  }

  stairDirectionAt(x: number, y: number): StairDirection {
    if (!this.inBounds(x, y)) return StairDirection.North
    return this.stairDirections[y * this.size + x] as StairDirection
  }

  setStair(x: number, y: number, direction: StairDirection, lowerLevel = 0): void {
    if (!this.inBounds(x, y)) return
    const idx = y * this.size + x
    this.blocks[idx] = Block.Stair
    this.stairDirections[idx] = direction
    this.levels[idx] = lowerLevel
  }

  /**
   * Bolt a ladder to one face of a raised tile.
   *
   * `x, y` is the *upper* tile: the ladder hangs from its edge down to the
   * tile one storey below on that side.
   */
  setLadderFace(x: number, y: number, face: LadderFace): void {
    if (!this.inBounds(x, y)) return
    const idx = y * this.size + x
    this.ladderFaces[idx] = this.ladderFaces[idx]! | face
  }

  ladderFacesAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0
    return this.ladderFaces[y * this.size + x]!
  }

  hasLadderFace(x: number, y: number, face: number): boolean {
    return (this.ladderFacesAt(x, y) & face) !== 0
  }

  /**
   * Is there a ladder joining these two tiles?
   *
   * One storey apart, orthogonally adjacent, and the higher tile carries a
   * ladder on the face looking at the lower one.
   */
  ladderBetween(a: Tile, b: Tile): boolean {
    const levelA = this.levelAt(a.x, a.y)
    const levelB = this.levelAt(b.x, b.y)
    if (Math.abs(levelA - levelB) !== 1) return false

    const upper = levelA > levelB ? a : b
    const lower = levelA > levelB ? b : a
    const face = faceToward(upper, lower)
    return face !== 0 && this.hasLadderFace(upper.x, upper.y, face)
  }

  /** Can a unit stand here (terrain only)? */
  isWalkable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false
    const block = this.blocks[y * this.size + x]
    return block === Block.None || block === Block.Stair
  }

  /** Does terrain here stop a line of sight ray? Only full-height blocks do. */
  blocksSight(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true
    return this.blocks[y * this.size + x] === Block.Full
  }

  // -------------------------------------------------------------------------
  // World <-> grid conversion. The grid is centred on the world origin.
  // -------------------------------------------------------------------------

  /** Half the map extent in metres. */
  get halfExtent(): number {
    return (this.size * TILE) / 2
  }

  worldX(tileX: number): number {
    return (tileX + 0.5) * TILE - this.halfExtent
  }

  worldZ(tileY: number): number {
    return (tileY + 0.5) * TILE - this.halfExtent
  }

  /** Centre of a tile, taking level elevation into account. */
  tileToWorld(tile: Tile, target = new Vector3()): Vector3 {
    const level = this.levelAt(tile.x, tile.y)
    // A stair tile is the ramp itself, so it stands half a storey proud of the
    // floor it starts from.
    const rampOffset = this.blockAt(tile.x, tile.y) === Block.Stair ? LEVEL_HEIGHT / 2 : 0
    return target.set(
      this.worldX(tile.x),
      level * LEVEL_HEIGHT + rampOffset,
      this.worldZ(tile.y),
    )
  }
  /**
   * A tile path as world points that follow the floor: level with the ground,
   * sloping over stairs, and climbing straight up at a ladder.
   *
   * The climb is drawn at the shared edge, because that is where the ladder
   * is: the route walks to the wall, goes up it, then steps off.
   */
  pathToWorldPoints(path: Tile[]): Vector3[] {
    const points: Vector3[] = []

    for (let i = 0; i < path.length; i++) {
      const curr = path[i]!

      if (i > 0) {
        const prev = path[i - 1]!
        if (this.ladderBetween(prev, curr)) {
          const edgeX = (this.worldX(prev.x) + this.worldX(curr.x)) / 2
          const edgeZ = (this.worldZ(prev.y) + this.worldZ(curr.y)) / 2
          points.push(
            new Vector3(edgeX, this.levelAt(prev.x, prev.y) * LEVEL_HEIGHT, edgeZ),
            new Vector3(edgeX, this.levelAt(curr.x, curr.y) * LEVEL_HEIGHT, edgeZ),
          )
        }
      }

      points.push(this.tileToWorld(curr))
    }

    return points
  }
  /** Get allowed entrance and exit tiles for a stair block at (x, y). */
  getStairAccessTiles(x: number, y: number): { lower: Tile; upper: Tile } {
    const dir = this.stairDirectionAt(x, y)
    switch (dir) {
      case StairDirection.North:
        return { lower: { x, y: y - 1 }, upper: { x, y: y + 1 } }
      case StairDirection.South:
        return { lower: { x, y: y + 1 }, upper: { x, y: y - 1 } }
      case StairDirection.East:
        return { lower: { x: x - 1, y }, upper: { x: x + 1, y } }
      case StairDirection.West:
        return { lower: { x: x + 1, y }, upper: { x: x - 1, y } }
    }
  }

  /**
   * Can a unit step directly from `from` to `to`?
   *
   * Enforces walkability, the stair's two-sided access, ladder edges, level
   * matching and the no-diagonal rule on vertical links.
   */
  canTraverse(from: Tile, to: Tile): boolean {
    if (!this.isWalkable(from.x, from.y) || !this.isWalkable(to.x, to.y)) return false

    const dx = to.x - from.x
    const dy = to.y - from.y
    if (dx === 0 && dy === 0) return false

    const isDiagonal = dx !== 0 && dy !== 0
    const fromBlock = this.blockAt(from.x, from.y)
    const toBlock = this.blockAt(to.x, to.y)

    // Stairs are only ever walked along, never cut across.
    if (isDiagonal && (fromBlock === Block.Stair || toBlock === Block.Stair)) return false

    // A stair is entered at its foot or its head, not from the side.
    if (toBlock === Block.Stair) {
      const access = this.getStairAccessTiles(to.x, to.y)
      if (!tileEquals(from, access.lower) && !tileEquals(from, access.upper)) return false
    }
    if (fromBlock === Block.Stair) {
      const access = this.getStairAccessTiles(from.x, from.y)
      if (!tileEquals(to, access.lower) && !tileEquals(to, access.upper)) return false
    }

    if (this.levelAt(from.x, from.y) === this.levelAt(to.x, to.y)) return true

    // Changing storey needs a stair or a ladder, and cannot be done cornerwise.
    if (isDiagonal) return false
    if (fromBlock === Block.Stair || toBlock === Block.Stair) return true
    return this.ladderBetween(from, to)
  }

  /** Action points to step from `from` to `to`. */
  getStepCost(from: Tile, to: Tile): number {
    // Hauling yourself up a ladder costs more than walking the same distance.
    if (this.ladderBetween(from, to)) return RULES.ladderStepCost

    if (this.blockAt(from.x, from.y) === Block.Stair || this.blockAt(to.x, to.y) === Block.Stair) {
      return RULES.stairStepCost
    }

    const isDiagonal = to.x !== from.x && to.y !== from.y
    return isDiagonal ? RULES.stepDiagonal : RULES.stepOrthogonal
  }
  /** Which tile contains this world position? May be out of bounds. */
  worldToTile(x: number, z: number): Tile {
    return {
      x: Math.floor((x + this.halfExtent) / TILE),
      y: Math.floor((z + this.halfExtent) / TILE),
    }
  }

  /** Euclidean distance between tile centres, in metres. */
  distance(a: Tile, b: Tile): number {
    return Math.hypot(a.x - b.x, a.y - b.y) * TILE
  }

  forEach(fn: (x: number, y: number, block: Block) => void): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        fn(x, y, this.blocks[y * this.size + x] as Block)
      }
    }
  }

  /**
   * Flood fill from `origin` over tiles a unit could actually walk to.
   *
   * Steps through {@link canTraverse}, so a raised floor counts as reached
   * only when a stair or ladder genuinely joins it. Testing walkability alone
   * reports storeys as connected that no unit can get to.
   */
  reachableMask(origin: Tile): Uint8Array {
    const mask = new Uint8Array(this.size * this.size)
    if (!this.isWalkable(origin.x, origin.y)) return mask

    const queue: number[] = [this.index(origin.x, origin.y)]
    mask[queue[0]!] = 1

    for (let head = 0; head < queue.length; head++) {
      const idx = queue[head]!
      const from = { x: idx % this.size, y: (idx / this.size) | 0 }
      for (const [dx, dy] of ORTHOGONAL) {
        const to = { x: from.x + dx, y: from.y + dy }
        if (!this.inBounds(to.x, to.y)) continue
        const nIdx = this.index(to.x, to.y)
        if (mask[nIdx]) continue
        if (!this.canTraverse(from, to)) continue
        mask[nIdx] = 1
        queue.push(nIdx)
      }
    }
    return mask
  }

  countWalkable(): number {
    let n = 0
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) if (this.isWalkable(x, y)) n++
    }
    return n
  }
}
