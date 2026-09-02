import { Vector3 } from 'three'
import { FULL_BLOCK_HEIGHT, GRID_SIZE, HALF_BLOCK_HEIGHT, RULES, TILE } from '../config'

export const Block = {
  /** Open floor. */
  None: 0,
  /** 1 m crate — blocks movement, does NOT block line of sight, grants half cover. */
  Half: 1,
  /** 2 m wall/building — blocks movement AND line of sight, grants full cover. */
  Full: 2,
  /** Stair block — transitions between lower level and upper level (2-side access only). */
  Stair: 3,
  /** Ladder wall — allows climbing up and down at increased AP cost. */
  Ladder: 4,
} as const
export type Block = (typeof Block)[keyof typeof Block]

export const StairDirection = {
  North: 0, // Lower at (x, y-1), Upper at (x, y+1)
  East: 1,  // Lower at (x-1, y), Upper at (x+1, y)
  South: 2, // Lower at (x, y+1), Upper at (x, y-1)
  West: 3,  // Lower at (x+1, y), Upper at (x-1, y)
} as const
export type StairDirection = (typeof StairDirection)[keyof typeof StairDirection]

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

  constructor(size: number = GRID_SIZE) {
    this.size = size
    this.blocks = new Uint8Array(size * size)
    this.levels = new Uint8Array(size * size)
    this.stairDirections = new Uint8Array(size * size)
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

  setLadder(x: number, y: number, lowerLevel = 0): void {
    if (!this.inBounds(x, y)) return
    const idx = y * this.size + x
    this.blocks[idx] = Block.Ladder
    this.levels[idx] = lowerLevel
  }

  /** Can a unit stand here / enter this tile? */
  isWalkable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false
    const block = this.blocks[y * this.size + x]
    return block === Block.None || block === Block.Stair || block === Block.Ladder
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
    const block = this.blockAt(tile.x, tile.y)
    // If it's a stair block, height is halfway between lower and upper
    const heightOffset = block === Block.Stair ? 1.0 : 0
    return target.set(this.worldX(tile.x), level * 2.0 + heightOffset, this.worldZ(tile.y))
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
   * Enforces terrain walkability, stair 2-side access, ladder vertical access,
   * level matching, and diagonal rules.
   */
  canTraverse(from: Tile, to: Tile): boolean {
    if (!this.isWalkable(from.x, from.y) || !this.isWalkable(to.x, to.y)) return false
    const dx = to.x - from.x
    const dy = to.y - from.y

    if (dx === 0 && dy === 0) return false
    const isDiagonal = dx !== 0 && dy !== 0

    const fromBlock = this.blockAt(from.x, from.y)
    const toBlock = this.blockAt(to.x, to.y)

    // Diagonal movement is strictly forbidden on stairs and ladders
    if (isDiagonal && (fromBlock === Block.Stair || toBlock === Block.Stair || fromBlock === Block.Ladder || toBlock === Block.Ladder)) {
      return false
    }

    // Check stair access constraints (stairs only allow access from two sides: upper and lower)
    if (toBlock === Block.Stair) {
      const access = this.getStairAccessTiles(to.x, to.y)
      if (!tileEquals(from, access.lower) && !tileEquals(from, access.upper)) return false
    }
    if (fromBlock === Block.Stair) {
      const access = this.getStairAccessTiles(from.x, from.y)
      if (!tileEquals(to, access.lower) && !tileEquals(to, access.upper)) return false
    }

    const fromLevel = this.levelAt(from.x, from.y)
    const toLevel = this.levelAt(to.x, to.y)

    // Level transitions
    if (fromLevel !== toLevel) {
      // Must be via stair or ladder
      const isStairStep = fromBlock === Block.Stair || toBlock === Block.Stair
      const isLadderStep = fromBlock === Block.Ladder || toBlock === Block.Ladder
      if (!isStairStep && !isLadderStep) return false
    }

    return true
  }

  /**
   * Calculate action points required to move between `from` and `to`.
   */
  getStepCost(from: Tile, to: Tile): number {
    const fromBlock = this.blockAt(from.x, from.y)
    const toBlock = this.blockAt(to.x, to.y)
    const isLadder = fromBlock === Block.Ladder || toBlock === Block.Ladder
    if (isLadder) return RULES.ladderStepCost

    const isStair = fromBlock === Block.Stair || toBlock === Block.Stair
    if (isStair) return RULES.stairStepCost

    const dx = to.x - from.x
    const dy = to.y - from.y
    return dx !== 0 && dy !== 0 ? RULES.stepDiagonal : RULES.stepOrthogonal
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
   * Flood fill of walkable tiles from `origin`.
   * Returns a boolean mask; used to verify (and repair) map connectivity.
   */
  reachableMask(origin: Tile): Uint8Array {
    const mask = new Uint8Array(this.size * this.size)
    if (!this.isWalkable(origin.x, origin.y)) return mask

    const queue: number[] = [this.index(origin.x, origin.y)]
    mask[queue[0]!] = 1

    for (let head = 0; head < queue.length; head++) {
      const idx = queue[head]!
      const cx = idx % this.size
      const cy = (idx / this.size) | 0
      for (const [dx, dy] of ORTHOGONAL) {
        const nx = cx + dx
        const ny = cy + dy
        if (!this.isWalkable(nx, ny)) continue
        const nIdx = this.index(nx, ny)
        if (mask[nIdx]) continue
        mask[nIdx] = 1
        queue.push(nIdx)
      }
    }
    return mask
  }

  countWalkable(): number {
    let n = 0
    for (let i = 0; i < this.blocks.length; i++) if (this.blocks[i] === Block.None) n++
    return n
  }
}
