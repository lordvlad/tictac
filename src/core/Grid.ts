import { Vector3 } from 'three'
import { GRID_SIZE, HALF_BLOCK_HEIGHT, LEVEL_HEIGHT, RULES, TILE } from '../config'
import { WALLS, wallHidesSight, WallKind } from './Walls'

/**
 * What occupies a tile's floor.
 *
 * Walls are deliberately absent: a wall is a boundary between two tiles, held
 * as an edge, so it consumes no floor. What is left here are things that
 * genuinely stand on a tile.
 */
export const Block = {
  /** Open floor. */
  None: 0,
  /** 1 m crate — blocks movement, does NOT block line of sight, grants half cover. */
  Half: 1,
  /** A flight of steps. Enterable from its foot and its head only. */
  Stair: 2,
} as const
export type Block = (typeof Block)[keyof typeof Block]

export const StairDirection = {
  North: 0,
  East: 1,
  South: 2,
  West: 3,
} as const
export type StairDirection = (typeof StairDirection)[keyof typeof StairDirection]

/**
 * One of a tile's four vertical faces, as bit flags so a tile can name several.
 *
 * Both fixtures that live on a boundary rather than on a floor are addressed
 * this way: the wall between two tiles, and the ladder bolted to a raised
 * tile's edge.
 */
export const Side = {
  North: 1,
  East: 2,
  South: 4,
  West: 8,
} as const
export type Side = (typeof Side)[keyof typeof Side]

/** The face of `from` that looks at `to`, or 0 when they are not orthogonal neighbours. */
export function faceToward(from: Tile, to: Tile): Side | 0 {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === -1) return Side.North
  if (dx === 0 && dy === 1) return Side.South
  if (dx === 1 && dy === 0) return Side.East
  if (dx === -1 && dy === 0) return Side.West
  return 0
}

export function blockHeight(block: Block): number {
  return block === Block.Half ? HALF_BLOCK_HEIGHT : 0
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
  /** Ladder faces per tile, as a {@link Side} bitmask. */
  readonly ladderFaces: Uint8Array
  /**
   * Storey a roof slab covers this tile at, or 0 for open sky.
   *
   * A roof is not a floor: nothing stands on it and it is not walkable. It
   * exists so an enclosed room reads as enclosed from outside, and it is
   * filtered away with its own storey when the player looks inside.
   */
  readonly roofs: Uint8Array

  /**
   * Wall kinds on the edges running north-south, one slot per edge.
   *
   * An edge is shared by the two tiles it separates, so it is stored once,
   * addressed by the lattice line it lies on. Holding a copy per tile side
   * would mean two writable spellings of one wall, and they would drift.
   */
  private readonly wallsV: Uint8Array
  /** Wall kinds on the edges running east-west. */
  private readonly wallsH: Uint8Array

  constructor(size: number = GRID_SIZE) {
    this.size = size
    this.blocks = new Uint8Array(size * size)
    this.levels = new Uint8Array(size * size)
    this.stairDirections = new Uint8Array(size * size)
    this.ladderFaces = new Uint8Array(size * size)
    this.roofs = new Uint8Array(size * size)
    this.wallsV = new Uint8Array((size + 1) * size)
    this.wallsH = new Uint8Array(size * (size + 1))
  }

  roofAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0
    return this.roofs[y * this.size + x]!
  }

  setRoof(x: number, y: number, level: number): void {
    if (!this.inBounds(x, y)) return
    this.roofs[y * this.size + x] = level
  }

  // -------------------------------------------------------------------------
  // Wall edges
  //
  // A vertical edge at lattice column `x` separates tile (x-1, y) from (x, y);
  // a horizontal edge at lattice row `y` separates (x, y-1) from (x, y). Both
  // families run one past the last tile, which is where the map border sits.
  // -------------------------------------------------------------------------

  /** Total addressable edges, for callers sizing a per-edge buffer. */
  get edgeCount(): number {
    return this.wallsV.length + this.wallsH.length
  }

  /**
   * A stable id for the edge on `side` of a tile, unique across both families.
   *
   * Vertical edges occupy the low range and horizontal ones follow, so an edge
   * mask or an instance table can be a single flat array.
   */
  edgeId(x: number, y: number, side: Side): number {
    return side === Side.West || side === Side.East
      ? y * (this.size + 1) + (side === Side.East ? x + 1 : x)
      : this.wallsV.length + (side === Side.South ? y + 1 : y) * this.size + x
  }

  /** Decode an {@link edgeId} back to the lower-coordinate tile and its side. */
  edgeTile(id: number): { x: number; y: number; side: Side } {
    if (id < this.wallsV.length) {
      const stride = this.size + 1
      return { x: id % stride, y: (id / stride) | 0, side: Side.West }
    }
    const rest = id - this.wallsV.length
    return { x: rest % this.size, y: (rest / this.size) | 0, side: Side.North }
  }

  /**
   * The wall on one side of a tile.
   *
   * The map border reads as solid: it is the one wall no generator has to draw,
   * and it keeps units, sight and cover from running off the edge of the world.
   */
  wallAt(x: number, y: number, side: Side): WallKind {
    if (side === Side.West || side === Side.East) {
      const lattice = side === Side.East ? x + 1 : x
      if (y < 0 || y >= this.size) return WallKind.Solid
      if (lattice <= 0 || lattice >= this.size) return WallKind.Solid
      return this.wallsV[y * (this.size + 1) + lattice] as WallKind
    }
    const lattice = side === Side.South ? y + 1 : y
    if (x < 0 || x >= this.size) return WallKind.Solid
    if (lattice <= 0 || lattice >= this.size) return WallKind.Solid
    return this.wallsH[lattice * this.size + x] as WallKind
  }

  /** Raise or clear a wall. The border is the grid's own invariant and is not writable. */
  setWall(x: number, y: number, side: Side, kind: WallKind): void {
    if (side === Side.West || side === Side.East) {
      const lattice = side === Side.East ? x + 1 : x
      if (y < 0 || y >= this.size) return
      if (lattice <= 0 || lattice >= this.size) return
      this.wallsV[y * (this.size + 1) + lattice] = kind
      return
    }
    const lattice = side === Side.South ? y + 1 : y
    if (x < 0 || x >= this.size) return
    if (lattice <= 0 || lattice >= this.size) return
    this.wallsH[lattice * this.size + x] = kind
  }

  /**
   * The wall standing between two orthogonally adjacent tiles.
   *
   * Returns {@link WallKind.None} for anything that is not a shared edge, so a
   * diagonal pair reports no wall: a diagonal crosses a corner, not a face,
   * and {@link canTraverse} resolves it from the two faces instead.
   */
  wallBetween(a: Tile, b: Tile): WallKind {
    const side = faceToward(a, b)
    if (side === 0) return WallKind.None
    return this.wallAt(a.x, a.y, side)
  }

  /**
   * Every wall that is actual map data, in edge order.
   *
   * Skips the border, which is the grid's own invariant rather than something
   * a generator placed or a system may change.
   */
  forEachWall(fn: (x: number, y: number, side: Side, kind: WallKind) => void): void {
    for (let y = 0; y < this.size; y++) {
      for (let lattice = 1; lattice < this.size; lattice++) {
        const kind = this.wallsV[y * (this.size + 1) + lattice] as WallKind
        if (kind !== WallKind.None) fn(lattice, y, Side.West, kind)
      }
    }
    for (let lattice = 1; lattice < this.size; lattice++) {
      for (let x = 0; x < this.size; x++) {
        const kind = this.wallsH[lattice * this.size + x] as WallKind
        if (kind !== WallKind.None) fn(x, lattice, Side.North, kind)
      }
    }
  }

  /**
   * Absolute world Y coordinate of a wall's top.
   *
   * A wall stands on the lower of the two floors it divides, so its top is that
   * floor's height plus the wall kind's height.
   */
  wallTop(x: number, y: number, side: Side): number {
    const kind = this.wallAt(x, y, side)
    if (kind === WallKind.None) return 0
    let nx = x
    let ny = y
    if (side === Side.East) nx += 1
    else if (side === Side.West) nx -= 1
    else if (side === Side.South) ny += 1
    else if (side === Side.North) ny -= 1
    const level = Math.max(this.levelAt(x, y), this.levelAt(nx, ny))
    return level * LEVEL_HEIGHT + WALLS[kind].height
  }

  /** Is one edge passable? `observerFloorY` names the eye floor for sight, or `null` for a body. */
  private edgeOpen(x: number, y: number, side: Side, observerFloorY: number | null): boolean {
    const kind = this.wallAt(x, y, side)
    if (observerFloorY === null) return kind === WallKind.None
    const top = this.wallTop(x, y, side)
    return !wallHidesSight(kind, top, observerFloorY)
  }

  /**
   * Is the corner between two diagonally adjacent tiles closed?
   *
   * A diagonal grazes a lattice point and slips past it if either way round
   * that point is clear. So a wall merely *ending* at the corner leaves the
   * other route open, while a wall running straight through it — or one
   * wrapping the far tile — closes both.
   *
   * `observerFloorY` selects what counts as a barrier: `null` for a body, or
   * the eye's floor height in metres for a line of sight.
   */
  cornerClosed(from: Tile, to: Tile, observerFloorY: number | null): boolean {
    const sideX = to.x > from.x ? Side.East : Side.West
    const sideY = to.y > from.y ? Side.South : Side.North

    const viaX =
      this.edgeOpen(from.x, from.y, sideX, observerFloorY) &&
      this.edgeOpen(to.x, from.y, sideY, observerFloorY)
    const viaY =
      this.edgeOpen(from.x, from.y, sideY, observerFloorY) &&
      this.edgeOpen(from.x, to.y, sideX, observerFloorY)

    return !viaX && !viaY
  }
  index(x: number, y: number): number {
    return y * this.size + x
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size
  }

  blockAt(x: number, y: number): Block {
    if (!this.inBounds(x, y)) return Block.None
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

  /** Strip every ladder off a tile's edges. */
  clearLadderFaces(x: number, y: number): void {
    if (!this.inBounds(x, y)) return
    this.ladderFaces[y * this.size + x] = 0
  }

  /**
   * Bolt a ladder to one face of a raised tile.
   *
   * `x, y` is the *upper* tile: the ladder hangs from its edge down to the
   * tile one storey below on that side.
   */
  setLadderFace(x: number, y: number, face: Side): void {
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

  /**
   * Does the wall between two adjacent tiles stop a line of sight ray?
   *
   * Sight is now purely a question about boundaries: nothing standing on a
   * tile is tall enough to block a view, so there is no per-tile answer left
   * to give.
   */
  /**
   * Does the wall between two adjacent tiles stop a line of sight ray?
   *
   * Evaluated relative to `observerFloorY` in metres: a wall whose top sits
   * at or below the observer's feet does not block their view.
   */
  blocksSightBetween(a: Tile, b: Tile, observerFloorY = 0): boolean {
    const side = faceToward(a, b)
    if (side === 0) return false
    const kind = this.wallAt(a.x, a.y, side)
    if (kind === WallKind.None) return false
    return wallHidesSight(kind, this.wallTop(a.x, a.y, side), observerFloorY)
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
   * Enforces walkability, wall edges, the stair's two-sided access, ladder
   * edges, level matching and the no-diagonal rule on vertical links.
   */
  canTraverse(from: Tile, to: Tile): boolean {
    if (!this.isWalkable(from.x, from.y) || !this.isWalkable(to.x, to.y)) return false

    const dx = to.x - from.x
    const dy = to.y - from.y
    if (dx === 0 && dy === 0) return false

    const isDiagonal = dx !== 0 && dy !== 0

    // A ladder is the sanctioned way across its own boundary: it is bolted to
    // the wall and takes a unit *over* it, onto the floor whose height is that
    // wall's top. So a climb is judged by the ladder, not by the wall.
    const climbing = this.ladderBetween(from, to)

    if (climbing) {
      // Nothing more to check: a ladder exists only between two orthogonally
      // adjacent tiles exactly one storey apart.
    } else if (!isDiagonal) {
      if (this.wallBetween(from, to) !== WallKind.None) return false
    } else {
      // A diagonal cuts a corner rather than crossing a face, so it is allowed
      // as long as a unit could have walked round that corner one way or the
      // other.
      if (this.cornerClosed(from, to, null)) return false
    }

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
    return climbing
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
