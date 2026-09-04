import { Faction, GRID_SIZE, SQUAD_SIZE } from '../config'
import {
  Block,
  faceToward,
  Grid,
  ORTHOGONAL,
  Side,
  StairDirection,
  type Tile,
} from './Grid'
import { WallKind } from './Walls'
import { clamp } from './math'
import { Rng } from './rng'

export interface GeneratedMap {
  grid: Grid
  spawns: Record<Faction, Tile[]>
  /** Building footprints, so callers can ask what is indoors. */
  buildings: readonly Rect[]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
/** Smallest room side. Below this a "room" is a cupboard nobody can fight in. */
const MIN_ROOM_SIDE = 3

/** Grid-space step from a tile toward each of its faces. */
const SIDE_OFFSET: Record<Side, readonly [number, number]> = {
  [Side.North]: [0, -1],
  [Side.East]: [1, 0],
  [Side.South]: [0, 1],
  [Side.West]: [-1, 0],
}

/** Storeys above the ground a building may reach. */
const MAX_EXTRA_STOREYS = 2

/**
 * One storey of one building: the rooms it is divided into.
 *
 * A storey above the ground is always made of *whole rooms of the storey
 * below*, never an arbitrary region. That is what keeps a wall standing on a
 * wall — the outline of an upper storey is, by construction, a set of edges
 * that already carry walls from the storey underneath.
 */
interface Storey {
  level: number
  rooms: Rect[]
}

interface Building {
  footprint: Rect
  storeys: Storey[]
}

function rectsOverlap(a: Rect, b: Rect, padding: number): boolean {
  return (
    a.x - padding < b.x + b.w &&
    a.x + a.w + padding > b.x &&
    a.y - padding < b.y + b.h &&
    a.y + a.h + padding > b.y
  )
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

function rectArea(r: Rect): number {
  return r.w * r.h
}

/**
 * Procedural urban battlefield, generated one storey at a time.
 *
 * Each storey is laid out in three rounds — outer walls, then rooms, then
 * openings — and each storey above the ground takes the storey below as its
 * constraint. Vertical access is fitted last, once there is a finished
 * building to fit it into, because a stair needs to know what it lands on.
 *
 * No border pass: the map edge is solid by construction, so there is nothing
 * to draw and no ring of tiles lost to it.
 */
export function generateMap(seed: number, size: number = GRID_SIZE): GeneratedMap {
  const rng = new Rng(seed)
  const grid = new Grid(size)

  // --- Deployment zones -----------------------------------------------------
  // Blue deploys along the low-Y edge, Red along the high-Y edge, both centred
  // with a random lateral jitter so games do not always look identical.
  const zoneW = SQUAD_SIZE + 3
  const zoneH = 3
  const blueX = Math.round(size / 2 - zoneW / 2 + rng.range(-4, 4))
  const redX = Math.round(size / 2 - zoneW / 2 + rng.range(-4, 4))
  const blueZone: Rect = { x: clamp(blueX, 2, size - 2 - zoneW), y: 2, w: zoneW, h: zoneH }
  const redZone: Rect = {
    x: clamp(redX, 2, size - 2 - zoneW),
    y: size - 2 - zoneH,
    w: zoneW,
    h: zoneH,
  }
  const zones = [blueZone, redZone]

  // --- Building footprints --------------------------------------------------
  const buildings: Building[] = []
  const target = rng.int(5, 8)
  for (let attempt = 0; attempt < 500 && buildings.length < target; attempt++) {
    const w = rng.int(7, 13)
    const h = rng.int(7, 13)
    const footprint: Rect = {
      x: rng.int(2, size - 2 - w),
      y: rng.int(2, size - 2 - h),
      w,
      h,
    }

    if (zones.some((z) => rectsOverlap(footprint, z, 2))) continue
    if (buildings.some((b) => rectsOverlap(footprint, b.footprint, 2))) continue

    buildings.push(planBuilding(footprint, rng))
  }

  // --- Raise the storeys ----------------------------------------------------
  // Ascending, so a tile ends up at the level of the highest storey covering
  // it: the ground floor is the part of the footprint nothing was raised over.
  for (const building of buildings) {
    for (const storey of building.storeys) {
      for (const room of storey.rooms) {
        forEachTile(room, (x, y) => {
          grid.setBlock(x, y, Block.None)
          grid.setLevel(x, y, storey.level)
        })
      }
    }
  }

  // Tiles that later passes must leave alone. A crate dropped on the far side
  // of a building's only door seals the whole ground floor, and a stair whose
  // landing gets flattened stops being a stair.
  const reserved = new Set<number>()
  const reserve = (x: number, y: number): void => {
    reserved.add(grid.index(x, y))
  }

  // --- Build each storey, in three rounds -----------------------------------
  for (const building of buildings) {
    for (const storey of building.storeys) {
      raiseOuterWalls(grid, storey)
      raisePartitions(grid, storey)
      openDoorsAndWindows(grid, rng, storey, buildings, reserve)
    }
  }

  // --- Roof every room ------------------------------------------------------
  // One storey above its own floor, so a room reads as enclosed from outside
  // and the level filter lifts it away when the player looks inside.
  for (const building of buildings) {
    forEachTile(building.footprint, (x, y) => {
      grid.setRoof(x, y, grid.levelAt(x, y) + 1)
    })
  }

  // --- Vertical access ------------------------------------------------------
  for (const building of buildings) {
    fitStairs(grid, rng, building, reserve)
    fitLadders(grid, building, buildings, reserve)
  }

  // --- Free-standing wall runs ---------------------------------------------
  // A run lies along one lattice line: a horizontal run is a row of north-side
  // edges, a vertical run a column of west-side edges. It costs no floor, so
  // both sides of it stay playable.
  const runCount = rng.int(5, 10)
  for (let i = 0; i < runCount; i++) {
    const horizontal = rng.chance(0.5)
    const length = rng.int(3, 9)
    const w = horizontal ? length : 1
    const h = horizontal ? 1 : length
    const x = rng.int(2, Math.max(2, size - 2 - w))
    const y = rng.int(2, Math.max(2, size - 2 - h))
    const rect: Rect = { x, y, w, h }
    if (zones.some((z) => rectsOverlap(rect, z, 2))) continue
    if (buildings.some((b) => rectsOverlap(rect, b.footprint, 1))) continue

    const side = horizontal ? Side.North : Side.West
    const kind = rng.chance(0.35) ? WallKind.Parapet : WallKind.Solid
    for (let step = 0; step < length; step++) {
      const tx = horizontal ? x + step : x
      const ty = horizontal ? y : y + step
      if (reserved.has(grid.index(tx, ty))) continue
      grid.setWall(tx, ty, side, kind)
    }
  }

  // --- Crate clusters (half cover) -----------------------------------------
  const clusterCount = rng.int(10, 18)
  for (let i = 0; i < clusterCount; i++) {
    const cx = rng.int(2, size - 3)
    const cy = rng.int(2, size - 3)
    if (zones.some((z) => inRect(z, cx, cy))) continue
    const crates = rng.int(1, 4)
    for (let c = 0; c < crates; c++) {
      const x = cx + rng.int(-1, 1)
      const y = cy + rng.int(-1, 1)
      if (x < 2 || y < 2 || x >= size - 2 || y >= size - 2) continue
      if (zones.some((z) => inRect(z, x, y))) continue
      if (reserved.has(grid.index(x, y))) continue
      if (grid.blockAt(x, y) !== Block.None) continue
      grid.setBlock(x, y, Block.Half)
    }
  }

  // --- Clear the deployment zones ------------------------------------------
  // Both the floor and every edge around it: a squad that starts walled in has
  // nowhere to deploy to.
  for (const zone of zones) {
    forEachTile(zone, (x, y) => {
      grid.setBlock(x, y, Block.None)
      grid.setLevel(x, y, 0)
      grid.setRoof(x, y, 0)
      for (const face of [Side.North, Side.East, Side.South, Side.West]) {
        grid.setWall(x, y, face, WallKind.None)
      }
    })
  }

  // --- Settle the structure, then guarantee connectivity -------------------
  // The repairs below are deliberately crude — they flatten tiles, demote
  // storeys and knock walls through. Settling afterwards puts the invariants
  // back, and the two alternate until both hold.
  const footprints = buildings.map((b) => b.footprint)
  for (let pass = 0; pass < 3; pass++) {
    settleStructures(grid, footprints)
    repairConnectivity(grid, reserved)
  }
  settleStructures(grid, footprints)

  const spawns: Record<Faction, Tile[]> = {
    [Faction.Blue]: pickSpawns(grid, rng, blueZone),
    [Faction.Red]: pickSpawns(grid, rng, redZone),
  }

  return { grid, spawns, buildings: footprints }
}

/**
 * Restore the structural invariants after the connectivity repairs have had
 * their way with the map.
 *
 * Three things have to hold however the repairs left it. A floor that steps
 * down has masonry on the step, or it is a floor hanging in the air. A stair
 * spans exactly one storey and is enterable from both ends, or it is a ramp to
 * nowhere that also severs the floor it stands on. And every tile indoors is
 * roofed.
 */
function settleStructures(grid: Grid, footprints: readonly Rect[]): void {
  // Masonry first. Validating access before the walls are final would approve
  // a stair that this very pass then seals.
  grid.forEach((x, y) => {
    const level = grid.levelAt(x, y)
    if (level === 0) return
    if (grid.blockAt(x, y) === Block.Stair) return
    for (const [dx, dy] of ORTHOGONAL) {
      const n = { x: x + dx, y: y + dy }
      if (!grid.inBounds(n.x, n.y)) continue
      if (grid.levelAt(n.x, n.y) >= level) continue
      if (grid.blockAt(n.x, n.y) === Block.Stair) continue
      const side = faceToward({ x, y }, n)
      if (side === 0) continue
      // A ladder face is an open cutout in the wall — do not seal it with masonry.
      if ((grid.ladderFacesAt(x, y) & side) !== 0) continue
      if (grid.wallAt(x, y, side) === WallKind.None) {
        grid.setWall(x, y, side, WallKind.Solid)
      }
    }
  })

  // A stair that no longer spans one step, or whose ends are now pockets, is
  // worse than no stair: it severs the floor it stands on. Give the tile back.
  grid.forEach((x, y, block) => {
    if (block !== Block.Stair) return
    const access = grid.getStairAccessTiles(x, y)
    const lower = grid.levelAt(access.lower.x, access.lower.y)
    const upper = grid.levelAt(access.upper.x, access.upper.y)
    const usable =
      upper - lower === 1 &&
      grid.levelAt(x, y) === lower &&
      grid.canTraverse({ x, y }, access.lower) &&
      grid.canTraverse({ x, y }, access.upper) &&
      leadsOnward(grid, access.lower, { x, y }) &&
      leadsOnward(grid, access.upper, { x, y })
    if (!usable) grid.setBlock(x, y, Block.None)
  })

  // A ladder whose footing went away is no longer a ladder.
  // Active ladders require wall segments to be removed (wall cutout).
  grid.forEach((x, y) => {
    const faces = grid.ladderFacesAt(x, y)
    if (faces === 0) return
    for (const side of [Side.North, Side.East, Side.South, Side.West]) {
      if ((faces & side) === 0) continue
      const [dx, dy] = SIDE_OFFSET[side]!
      const foot = { x: x + dx, y: y + dy }
      const drop = grid.levelAt(x, y) - grid.levelAt(foot.x, foot.y)
      if (drop !== 1 || !grid.isWalkable(foot.x, foot.y)) {
        grid.clearLadderFaces(x, y)
      } else {
        grid.setWall(x, y, side, WallKind.None)
      }
    }
  })

  // Everything indoors is covered...
  for (const footprint of footprints) {
    forEachTile(footprint, (x, y) => {
      grid.setRoof(x, y, grid.levelAt(x, y) + 1)
    })
  }

  // ...except stairs and their upper landings, which require ceiling tiles to be removed (stairwell cutout).
  grid.forEach((x, y, block) => {
    if (block !== Block.Stair) return
    const access = grid.getStairAccessTiles(x, y)
    grid.setRoof(x, y, 0)
    grid.setRoof(access.upper.x, access.upper.y, 0)
  })
}

/** Can a unit on `tile` step anywhere except back to `from`? */
function leadsOnward(grid: Grid, tile: Tile, from: Tile): boolean {
  for (const [dx, dy] of ORTHOGONAL) {
    const n = { x: tile.x + dx, y: tile.y + dy }
    if (n.x === from.x && n.y === from.y) continue
    if (grid.canTraverse(tile, n)) return true
  }
  return false
}
/** The room of `building` covering a tile on `level`, or null. */
function roomAt(building: Building, level: number, x: number, y: number): Rect | null {
  const storey = building.storeys.find((s) => s.level === level)
  if (storey === undefined) return null
  return storey.rooms.find((room) => inRect(room, x, y)) ?? null
}


function forEachTile(rect: Rect, fn: (x: number, y: number) => void): void {
  for (let dy = 0; dy < rect.h; dy++) {
    for (let dx = 0; dx < rect.w; dx++) fn(rect.x + dx, rect.y + dy)
  }
}

/**
 * Plan a building bottom-up.
 *
 * The footprint is cut into rooms once, as a tree. A storey is then a *node*
 * of that tree: level 0 owns the root, level 1 owns one of the root's two
 * halves, level 2 one half of that. Each storey keeps the rooms of its own
 * node that the storey above did not take.
 *
 * Working from the tree has two properties worth the indirection. Every
 * storey's outline runs along cuts that already carry walls, so a wall always
 * stands on a wall. And every storey's region is a rectangle minus a
 * sub-rectangle — an L, a U or a ring — which is always in one piece, so no
 * storey can strand part of itself.
 */
function planBuilding(footprint: Rect, rng: Rng): Building {
  const root = subdivide(footprint, rng)

  // The nested regions each storey is drawn from, narrowing as they rise.
  const regions: BspNode[] = [root]
  for (let level = 1; level <= MAX_EXTRA_STOREYS; level++) {
    const below = regions[level - 1]!
    if (below.children === undefined) break
    if (!rng.chance(level === 1 ? 0.85 : 0.45)) break
    regions.push(rng.pick(below.children))
  }

  const storeys: Storey[] = []
  for (let level = 0; level < regions.length; level++) {
    const mine = leavesOf(regions[level]!)
    const above = regions[level + 1]
    const rooms =
      above === undefined
        ? mine
        : mine.filter((room) => !leavesOf(above).some((r) => r === room))
    if (rooms.length === 0) continue
    storeys.push({ level, rooms })
  }

  return { footprint, storeys }
}

interface BspNode {
  rect: Rect
  children?: readonly [BspNode, BspNode]
}

function leavesOf(node: BspNode): Rect[] {
  if (node.children === undefined) return [node.rect]
  return [...leavesOf(node.children[0]), ...leavesOf(node.children[1])]
}

/** Recursively halve `rect` until every part is a plausible room. */
function subdivide(rect: Rect, rng: Rng): BspNode {
  const canSplitX = rect.w >= MIN_ROOM_SIDE * 2
  const canSplitY = rect.h >= MIN_ROOM_SIDE * 2
  if (!canSplitX && !canSplitY) return { rect }

  // Stop early now and then, so a building has the odd hall among its cells.
  if (rectArea(rect) <= MIN_ROOM_SIDE * MIN_ROOM_SIDE * 2 && rng.chance(0.35)) return { rect }

  const splitX =
    canSplitX && (!canSplitY || (rect.w >= rect.h ? rng.chance(0.75) : rng.chance(0.25)))

  if (splitX) {
    const cut = rng.int(MIN_ROOM_SIDE, rect.w - MIN_ROOM_SIDE)
    return {
      rect,
      children: [
        subdivide({ x: rect.x, y: rect.y, w: cut, h: rect.h }, rng),
        subdivide({ x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h }, rng),
      ],
    }
  }

  const cut = rng.int(MIN_ROOM_SIDE, rect.h - MIN_ROOM_SIDE)
  return {
    rect,
    children: [
      subdivide({ x: rect.x, y: rect.y, w: rect.w, h: cut }, rng),
      subdivide({ x: rect.x, y: rect.y + cut, w: rect.w, h: rect.h - cut }, rng),
    ],
  }
}

// ---------------------------------------------------------------------------
// Round 1 & 2 — walls
// ---------------------------------------------------------------------------

/** Round 1: the outer wall of a storey, around the union of its rooms. */
function raiseOuterWalls(grid: Grid, storey: Storey): void {
  for (const room of storey.rooms) {
    for (const [dx, dy] of ORTHOGONAL) {
      const side = faceToward({ x: 0, y: 0 }, { x: dx, y: dy })
      if (side === 0) continue
      walkBoundary(room, dx, dy, (x, y) => {
        // An edge shared with another room of this storey is interior; it is
        // round 2's business.
        if (storey.rooms.some((other) => other !== room && inRect(other, x + dx, y + dy))) return
        grid.setWall(x, y, side, WallKind.Solid)
      })
    }
  }
}

/**
 * Round 2: the walls between rooms, each spanning its shared edge end to end.
 *
 * A partition that stops short of the outer wall leaves a gap that reads as a
 * doorway nobody placed, which is how rooms ended up joined at a corner.
 */
function raisePartitions(grid: Grid, storey: Storey): void {
  for (let i = 0; i < storey.rooms.length; i++) {
    for (let j = i + 1; j < storey.rooms.length; j++) {
      const shared = sharedEdge(storey.rooms[i]!, storey.rooms[j]!)
      if (shared === null) continue
      for (const { x, y, side } of shared.edges) grid.setWall(x, y, side, WallKind.Solid)
    }
  }
}

/** Every tile of `rect` on the side facing `(dx, dy)`. */
function walkBoundary(
  rect: Rect,
  dx: number,
  dy: number,
  fn: (x: number, y: number) => void,
): void {
  if (dx !== 0) {
    const x = dx > 0 ? rect.x + rect.w - 1 : rect.x
    for (let y = rect.y; y < rect.y + rect.h; y++) fn(x, y)
    return
  }
  const y = dy > 0 ? rect.y + rect.h - 1 : rect.y
  for (let x = rect.x; x < rect.x + rect.w; x++) fn(x, y)
}

interface SharedEdge {
  edges: { x: number; y: number; side: Side }[]
}

/** The run of edges two rooms share, or null when they do not touch. */
function sharedEdge(a: Rect, b: Rect): SharedEdge | null {
  const edges: { x: number; y: number; side: Side }[] = []

  // Vertical seam: `a` ends where `b` begins on X, with overlapping rows.
  for (const [left, right] of [
    [a, b],
    [b, a],
  ] as const) {
    if (left.x + left.w !== right.x) continue
    const y0 = Math.max(left.y, right.y)
    const y1 = Math.min(left.y + left.h, right.y + right.h)
    for (let y = y0; y < y1; y++) edges.push({ x: right.x, y, side: Side.West })
  }

  // Horizontal seam.
  for (const [top, bottom] of [
    [a, b],
    [b, a],
  ] as const) {
    if (top.y + top.h !== bottom.y) continue
    const x0 = Math.max(top.x, bottom.x)
    const x1 = Math.min(top.x + top.w, bottom.x + bottom.w)
    for (let x = x0; x < x1; x++) edges.push({ x, y: bottom.y, side: Side.North })
  }

  return edges.length === 0 ? null : { edges }
}

// ---------------------------------------------------------------------------
// Round 3 — doors and windows
// ---------------------------------------------------------------------------

/**
 * Round 3: openings.
 *
 * Interior doors first, along a spanning tree over the rooms, so every room
 * connects to at least one other and the whole storey is one space. Then
 * exterior doors, scaled to how many rooms there are to serve. Then windows,
 * scaled to how big each room is — a storage cupboard gets none, a hall gets
 * several.
 */
function openDoorsAndWindows(
  grid: Grid,
  rng: Rng,
  storey: Storey,
  all: readonly Building[],
  reserve: (x: number, y: number) => void,
): void {
  const rooms = storey.rooms

  // --- interior doors: spanning tree over the room adjacency graph ---------
  const parent = rooms.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]!
    while (parent[i] !== root) {
      const next = parent[i]!
      parent[i] = root
      i = next
    }
    return root
  }

  const pairs: { i: number; j: number; shared: SharedEdge }[] = []
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const shared = sharedEdge(rooms[i]!, rooms[j]!)
      if (shared !== null) pairs.push({ i, j, shared })
    }
  }
  rng.shuffle(pairs)

  for (const pair of pairs) {
    const ri = find(pair.i)
    const rj = find(pair.j)
    // One door per tree edge joins the rooms; a few extra make the plan less
    // of a corridor crawl.
    const joinsNewRooms = ri !== rj
    if (!joinsNewRooms && !rng.chance(0.25)) continue
    if (joinsNewRooms) parent[ri] = rj

    const spot = rng.pick(pair.shared.edges)
    grid.setWall(spot.x, spot.y, spot.side, WallKind.None)
  }

  // --- exterior doors: one per four rooms, give or take --------------------
  const outer = exteriorEdges(grid, storey, all)
  if (outer.length > 0) {
    const min = Math.max(1, Math.floor(rooms.length / 4))
    const doors = Math.min(outer.length, rng.int(min, min + 1))
    rng.shuffle(outer)
    for (let i = 0; i < doors; i++) {
      const spot = outer[i]!
      grid.setWall(spot.x, spot.y, spot.side, WallKind.None)
      // A door is no use if the next pass drops a crate against it.
      const [dx, dy] = SIDE_OFFSET[spot.side]!
      reserve(spot.x, spot.y)
      reserve(spot.x + dx, spot.y + dy)
    }
  }

  // --- windows: by room size, on that room's own outside walls ------------
  for (const room of rooms) {
    const mine = outer.filter((e) => inRect(room, e.x, e.y))
    if (mine.length === 0) continue

    // A cupboard can do without; a hall wants a couple.
    const target = Math.floor(rectArea(room) / 9)
    const count = Math.min(mine.length, Math.max(0, target + (rng.chance(0.5) ? 1 : 0)))
    rng.shuffle(mine)
    let placed = 0
    for (const spot of mine) {
      if (placed >= count) break
      // Never glaze over a doorway that was just cut.
      if (grid.wallAt(spot.x, spot.y, spot.side) !== WallKind.Solid) continue
      grid.setWall(spot.x, spot.y, spot.side, WallKind.Glass)
      placed++
    }
  }
}

/**
 * Edges of a storey that face the open air.
 *
 * "Open" means the tile beyond belongs to no building at all — a seam against
 * a neighbouring structure is not a frontage and must not be glazed or holed.
 */
function exteriorEdges(
  grid: Grid,
  storey: Storey,
  all: readonly Building[],
): { x: number; y: number; side: Side }[] {
  const result: { x: number; y: number; side: Side }[] = []

  for (const room of storey.rooms) {
    for (const [dx, dy] of ORTHOGONAL) {
      const side = faceToward({ x: 0, y: 0 }, { x: dx, y: dy })
      if (side === 0) continue
      walkBoundary(room, dx, dy, (x, y) => {
        const ox = x + dx
        const oy = y + dy
        if (!grid.inBounds(ox, oy)) return
        // Interior to this storey, so not a frontage.
        if (storey.rooms.some((other) => inRect(other, ox, oy))) return
        // Frontage is open air only: a seam against any building — including a
        // storey step in this one — is not somewhere to cut a door or a window.
        if (all.some((b) => inRect(b.footprint, ox, oy))) return
        result.push({ x, y, side })
      })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Vertical access
// ---------------------------------------------------------------------------

/**
 * Fit a stair inside a building for every storey step it has.
 *
 * A stair needs a straight run of three tiles: the floor it leaves, the ramp
 * itself, and the floor it arrives on. Both ends must be somewhere a unit can
 * actually stand and move on from, or the stair is a hole in a cupboard.
 *
 * One per step, not one per building: a three-storey block needs a way from
 * the ground to the first floor *and* from there to the second.
 */
function fitStairs(
  grid: Grid,
  rng: Rng,
  building: Building,
  reserve: (x: number, y: number) => void,
): void {
  const { footprint } = building
  const topLevel = building.storeys.reduce((top, s) => Math.max(top, s.level), 0)

  for (let level = 0; level < topLevel; level++) {
    const candidates: { stair: Tile; dir: StairDirection; lower: Tile; upper: Tile }[] = []

    forEachTile(footprint, (x, y) => {
      if (grid.levelAt(x, y) !== level) return
      for (const [dx, dy] of ORTHOGONAL) {
        const lower = { x: x - dx, y: y - dy }
        const upper = { x: x + dx, y: y + dy }
        if (!inRect(footprint, lower.x, lower.y)) continue
        if (!inRect(footprint, upper.x, upper.y)) continue
        if (grid.levelAt(lower.x, lower.y) !== level) continue
        if (grid.levelAt(upper.x, upper.y) !== level + 1) continue

        // A stair may only be entered along its own axis, so a ramp dropped on
        // a doorway severs the route through it. Open floor inside a room is
        // fine — a room has parallel paths — but a gap in a wall is not.
        const flanks = [
          { x: dy, y: dx },
          { x: -dy, y: -dx },
        ]
        const onDoorway = flanks.some((off) => {
          const side = faceToward({ x: 0, y: 0 }, off)
          if (side === 0) return false
          if (grid.wallAt(x, y, side) !== WallKind.None) return false
          // The face is open: only a problem when it leads out of this room.
          return roomAt(building, level, x, y) !== roomAt(building, level, x + off.x, y + off.y)
        })
        if (onDoorway) continue

        const dir = stairDirectionFor(dx, dy)
        if (dir === null) continue
        candidates.push({ stair: { x, y }, dir, lower, upper })
      }
    })

    rng.shuffle(candidates)

    for (const option of candidates) {
      if (!hasRoomToMove(grid, option.lower, option.stair)) continue
      if (!hasRoomToMove(grid, option.upper, option.stair)) continue

      grid.setStair(option.stair.x, option.stair.y, option.dir, level)
      // The ramp's two ends are doorways: the walls it needs through.
      const toLower = faceToward(option.stair, option.lower)
      const toUpper = faceToward(option.stair, option.upper)
      if (toLower !== 0) grid.setWall(option.stair.x, option.stair.y, toLower, WallKind.None)
      if (toUpper !== 0) grid.setWall(option.stair.x, option.stair.y, toUpper, WallKind.None)

      // Stairs require ceiling tiles to be removed (stairwell cutout).
      grid.setRoof(option.stair.x, option.stair.y, 0)
      grid.setRoof(option.upper.x, option.upper.y, 0)

      reserve(option.stair.x, option.stair.y)
      reserve(option.lower.x, option.lower.y)
      reserve(option.upper.x, option.upper.y)
      break
    }
  }
}
/**
 * The direction whose *upper* access lies at `(dx, dy)` from the ramp.
 *
 * {@link Grid.getStairAccessTiles} names a stair by where its head points, so
 * these read inverted next to a plain offset: North's head is at `+y`.
 */
function stairDirectionFor(dx: number, dy: number): StairDirection | null {
  if (dx === 0 && dy === 1) return StairDirection.North
  if (dx === 0 && dy === -1) return StairDirection.South
  if (dx === 1 && dy === 0) return StairDirection.East
  if (dx === -1 && dy === 0) return StairDirection.West
  return null
}

/**
 * Can a unit stand on `tile` and go somewhere other than back down the stair?
 *
 * Checks the tile itself and demands at least one onward step, so a stair
 * never lands in a pocket a unit cannot leave.
 */
function hasRoomToMove(grid: Grid, tile: Tile, from: Tile): boolean {
  if (!grid.isWalkable(tile.x, tile.y)) return false
  for (const [dx, dy] of ORTHOGONAL) {
    const onward = { x: tile.x + dx, y: tile.y + dy }
    if (onward.x === from.x && onward.y === from.y) continue
    if (grid.canTraverse(tile, onward)) return true
  }
  return false
}

/**
 * Bolt ladders to a building's outside walls.
 *
 * A ladder is only useful where it has somewhere to stand at the bottom, so it
 * goes on an outside face whose upper storey opens onto the air and whose
 * ground below is open, walkable and one storey down.
 */
function fitLadders(
  grid: Grid,
  building: Building,
  all: readonly Building[],
  reserve: (x: number, y: number) => void,
): void {
  for (const storey of building.storeys) {
    if (storey.level === 0) continue

    for (const room of storey.rooms) {
      for (const [dx, dy] of ORTHOGONAL) {
        const side = faceToward({ x: 0, y: 0 }, { x: dx, y: dy })
        if (side === 0) continue

        let placed = false
        walkBoundary(room, dx, dy, (x, y) => {
          if (placed) return
          const ox = x + dx
          const oy = y + dy
          if (!grid.inBounds(ox, oy)) return
          // The foot has to be open ground, not another building's floor.
          if (all.some((b) => inRect(b.footprint, ox, oy))) return
          if (!grid.isWalkable(ox, oy)) return
          if (grid.levelAt(ox, oy) !== storey.level - 1) return
          // Only where the storey actually opens onto the air.
          if (grid.wallAt(x, y, side) !== WallKind.None) return

          grid.setLadderFace(x, y, side)
          // Ladders require wall segments to be removed (wall cutout).
          grid.setWall(x, y, side, WallKind.None)
          reserve(x, y)
          reserve(ox, oy)
          placed = true
        })
        if (placed) return
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/**
 * Reduce the map to a single region a unit can actually walk around.
 *
 * Components are grown through {@link Grid.canTraverse}, so a raised storey is
 * only "connected" when a stair or ladder truly joins it. Judging adjacency by
 * walkability alone reports storeys as connected that nothing can reach.
 *
 * Three repairs, cheapest first: cut a door between two regions that already
 * touch; lower a raised region nothing can climb to, rather than inventing an
 * access it should not have; and only then carve a corridor across open ground.
 */
function repairConnectivity(grid: Grid, reserved: Set<number>): void {
  const size = grid.size
  const tileOf = (idx: number): Tile => ({ x: idx % size, y: (idx / size) | 0 })

  for (let guard = 0; guard < 128; guard++) {
    const components = labelComponents(grid)
    if (components.length <= 1) return

    let main = components[0]!
    for (const c of components) if (c.count > main.count) main = c

    const satellite = components.find((c) => c !== main)
    if (satellite === undefined) return

    const inMain = new Set(main.tiles)
    if (cutDoorInto(grid, satellite, inMain, tileOf)) continue
    if (clearBlockingStair(grid, satellite, inMain, tileOf)) continue
    if (dropUnreachableStorey(grid, satellite, inMain, tileOf)) continue

    // Corridor carving is a ground-plane operation, so pick the closest pair
    // of tiles that share a storey.
    let from: Tile | null = null
    let to: Tile | null = null
    let bestDist = Infinity
    for (const sIdx of satellite.tiles) {
      const s = tileOf(sIdx)
      for (const mIdx of main.tiles) {
        const m = tileOf(mIdx)
        if (grid.levelAt(s.x, s.y) !== grid.levelAt(m.x, m.y)) continue
        const d = Math.abs(s.x - m.x) + Math.abs(s.y - m.y)
        if (d < bestDist) {
          bestDist = d
          from = s
          to = m
        }
      }
    }

    if (from === null || to === null) return
    carveCorridor(grid, from, to, grid.levelAt(from.x, from.y), reserved)
  }
}

/**
 * Open a doorway where a cut-off region already touches the main one on the
 * same storey. A sealed room only ever needed a door.
 */
function cutDoorInto(
  grid: Grid,
  satellite: Component,
  inMain: ReadonlySet<number>,
  tileOf: (idx: number) => Tile,
): boolean {
  for (const idx of satellite.tiles) {
    const s = tileOf(idx)
    for (const [dx, dy] of ORTHOGONAL) {
      const n = { x: s.x + dx, y: s.y + dy }
      if (!grid.inBounds(n.x, n.y)) continue
      if (!inMain.has(grid.index(n.x, n.y))) continue
      if (grid.levelAt(s.x, s.y) !== grid.levelAt(n.x, n.y)) continue
      const side = faceToward(s, n)
      if (side === 0 || grid.wallAt(s.x, s.y, side) === WallKind.None) continue
      grid.setWall(s.x, s.y, side, WallKind.None)
      return true
    }
  }
  return false
}

/**
 * Demote a ramp that is severing the floor it stands on.
 *
 * A stair is only enterable along its axis, so one sitting where a route
 * crosses it sideways cuts that route — and the edge is already open, so no
 * door will fix it. The floor matters more than the stair: turn the ramp back
 * into plain floor and let the storey it served be re-judged, and demoted if
 * nothing else reaches it.
 */
function clearBlockingStair(
  grid: Grid,
  satellite: Component,
  inMain: ReadonlySet<number>,
  tileOf: (idx: number) => Tile,
): boolean {
  for (const idx of satellite.tiles) {
    const s = tileOf(idx)
    for (const [dx, dy] of ORTHOGONAL) {
      const n = { x: s.x + dx, y: s.y + dy }
      if (!grid.inBounds(n.x, n.y)) continue
      if (!inMain.has(grid.index(n.x, n.y))) continue
      if (grid.levelAt(s.x, s.y) !== grid.levelAt(n.x, n.y)) continue
      if (grid.blockAt(n.x, n.y) !== Block.Stair) continue
      if (grid.canTraverse(s, n)) continue
      grid.setBlock(n.x, n.y, Block.None)
      return true
    }
  }
  return false
}

/**
 * Lower a raised region that nothing can climb to.
 *
 * A storey with no stair and no ladder is exactly the floating room this
 * generator exists to avoid; putting it back on the ground is honest, where
 * bolting on an access it was never planned to have is not.
 */
function dropUnreachableStorey(
  grid: Grid,
  satellite: Component,
  inMain: ReadonlySet<number>,
  tileOf: (idx: number) => Tile,
): boolean {
  let target: number | null = null
  for (const idx of satellite.tiles) {
    const s = tileOf(idx)
    for (const [dx, dy] of ORTHOGONAL) {
      const n = { x: s.x + dx, y: s.y + dy }
      if (!grid.inBounds(n.x, n.y)) continue
      if (!inMain.has(grid.index(n.x, n.y))) continue
      const below = grid.levelAt(n.x, n.y)
      if (below >= grid.levelAt(s.x, s.y)) continue
      target = below
      break
    }
    if (target !== null) break
  }
  if (target === null) return false

  for (const idx of satellite.tiles) {
    const s = tileOf(idx)
    grid.setLevel(s.x, s.y, target)
    grid.setRoof(s.x, s.y, target + 1)
    grid.clearLadderFaces(s.x, s.y)
  }
  return true
}

interface Component {
  label: number
  count: number
  tiles: number[]
}

function labelComponents(grid: Grid): Component[] {
  const size = grid.size
  const labels = new Int32Array(size * size).fill(-1)
  const components: Component[] = []
  let nextLabel = 0

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const start = grid.index(x, y)
      if (labels[start] !== -1 || !grid.isWalkable(x, y)) continue

      const label = nextLabel++
      const tiles: number[] = [start]
      labels[start] = label

      for (let head = 0; head < tiles.length; head++) {
        const from = { x: tiles[head]! % size, y: (tiles[head]! / size) | 0 }
        for (const [dx, dy] of ORTHOGONAL) {
          const to = { x: from.x + dx, y: from.y + dy }
          if (!grid.inBounds(to.x, to.y)) continue
          const nIdx = grid.index(to.x, to.y)
          if (labels[nIdx] !== -1) continue
          if (!grid.canTraverse(from, to)) continue
          labels[nIdx] = label
          tiles.push(nIdx)
        }
      }

      components.push({ label, count: tiles.length, tiles })
    }
  }

  return components
}

/**
 * Clear an L-shaped corridor between two tiles, leaving the border intact.
 *
 * Corridor tiles are flattened to `level`, or the run would be cut by the very
 * storey change it is meant to bypass. Tiles a vertical link depends on are
 * left alone: flattening a stair landing would undo the link. Walls along the
 * run always come down — a corridor whose boundaries still stand is not a
 * corridor.
 */
function carveCorridor(
  grid: Grid,
  from: Tile,
  to: Tile,
  level: number,
  reserved: Set<number>,
): void {
  const size = grid.size
  let prev = from

  const advance = (x: number, y: number) => {
    const curr = { x, y }
    const side = faceToward(prev, curr)
    if (side !== 0) grid.setWall(prev.x, prev.y, side, WallKind.None)

    const onBorder = x <= 0 || y <= 0 || x >= size - 1 || y >= size - 1
    if (!onBorder && !reserved.has(grid.index(x, y))) {
      grid.setBlock(x, y, Block.None)
      grid.setLevel(x, y, level)
    }
    prev = curr
  }

  const stepX = Math.sign(to.x - from.x)
  let x = from.x
  while (x !== to.x) {
    x += stepX
    advance(x, from.y)
  }
  const stepY = Math.sign(to.y - from.y)
  let y = from.y
  while (y !== to.y) {
    y += stepY
    advance(to.x, y)
  }
}

/** Pick `SQUAD_SIZE` distinct walkable tiles inside a deployment zone. */
function pickSpawns(grid: Grid, rng: Rng, zone: Rect): Tile[] {
  const candidates: Tile[] = []
  forEachTile(zone, (x, y) => {
    if (grid.isWalkable(x, y)) candidates.push({ x, y })
  })
  rng.shuffle(candidates)

  const chosen: Tile[] = []
  for (const tile of candidates) {
    if (chosen.length >= SQUAD_SIZE) break
    // Prefer spread-out spawns.
    if (chosen.some((c) => Math.abs(c.x - tile.x) + Math.abs(c.y - tile.y) < 2)) continue
    chosen.push(tile)
  }
  // Fall back to any remaining walkable tile if the spread rule was too strict.
  for (const tile of candidates) {
    if (chosen.length >= SQUAD_SIZE) break
    if (chosen.some((c) => c.x === tile.x && c.y === tile.y)) continue
    chosen.push(tile)
  }
  return chosen
}
