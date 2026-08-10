import { Vector3 } from 'three'
import { FULL_BLOCK_HEIGHT, GRID_SIZE, HALF_BLOCK_HEIGHT, TILE } from '../config'

export const Block = {
  /** Open floor. */
  None: 0,
  /** 1 m crate — blocks movement, does NOT block line of sight, grants half cover. */
  Half: 1,
  /** 2 m wall/building — blocks movement AND line of sight, grants full cover. */
  Full: 2,
} as const
export type Block = (typeof Block)[keyof typeof Block]

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

export function tileKey(t: Tile): number {
  return t.y * GRID_SIZE + t.x
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

  constructor(size: number = GRID_SIZE) {
    this.size = size
    this.blocks = new Uint8Array(size * size)
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

  /** Can a unit stand here (terrain only)? */
  isWalkable(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.blocks[y * this.size + x] === Block.None
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

  /** Centre of a tile, at floor level. */
  tileToWorld(tile: Tile, target = new Vector3()): Vector3 {
    return target.set(this.worldX(tile.x), 0, this.worldZ(tile.y))
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
