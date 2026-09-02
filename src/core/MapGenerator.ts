import { Faction, GRID_SIZE, SQUAD_SIZE } from '../config'
import { Block, faceToward, Grid, ORTHOGONAL, Side, StairDirection, type Tile } from './Grid'
import { WallKind } from './Walls'
import { clamp } from './math'
import { Rng } from './rng'

export interface GeneratedMap {
  grid: Grid
  spawns: Record<Faction, Tile[]>
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
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

/**
 * Procedural urban-ish battlefield:
 *   - rectangular buildings — walls on their boundary edges, open interiors,
 *     doorways and the odd glazed frontage
 *   - free-standing wall runs for mid-map cover
 *   - crate clusters (half-height, shootable over)
 *   - two opposing deployment zones, guaranteed clear and mutually reachable
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
  const blueX = Math.round(size / 2 - zoneW / 2 + rng.range(-3, 3))
  const redX = Math.round(size / 2 - zoneW / 2 + rng.range(-3, 3))
  const blueZone: Rect = { x: clamp(blueX, 2, size - 2 - zoneW), y: 2, w: zoneW, h: zoneH }
  const redZone: Rect = {
    x: clamp(redX, 2, size - 2 - zoneW),
    y: size - 2 - zoneH,
    w: zoneW,
    h: zoneH,
  }
  const zones = [blueZone, redZone]

  // --- Buildings ------------------------------------------------------------
  const buildings: Rect[] = []
  const buildingTarget = rng.int(4, 6)
  for (let attempt = 0; attempt < 300 && buildings.length < buildingTarget; attempt++) {
    const w = rng.int(4, 8)
    const h = rng.int(4, 8)
    const x = rng.int(2, size - 2 - w)
    const y = rng.int(2, size - 2 - h)
    const rect: Rect = { x, y, w, h }

    if (zones.some((z) => rectsOverlap(rect, z, 2))) continue
    if (buildings.some((b) => rectsOverlap(rect, b, 2))) continue

    buildings.push(rect)
    carveBuilding(grid, rng, rect)
  }
  // --- Upper storeys, stairs and ladders -----------------------------------
  // Debug hack, deliberately tame for now: at most one elevated structure per
  // access kind, so a storey is never served by both a stair and a ladder.
  //
  // Tiles a vertical link depends on are reserved, because the crate and
  // corridor passes that follow would otherwise seal a stair off at both ends
  // and strand the storey behind it.
  const reserved = new Set<number>()
  const reserve = (x: number, y: number): void => {
    reserved.add(grid.index(x, y))
  }

  /** Raise a whole room onto the upper storey. Its wall ring comes along. */
  const elevate = (rect: Rect): boolean => {
    if (rect.w < 4 || rect.h < 4) return false
    for (let dy = 0; dy < rect.h; dy++) {
      for (let dx = 0; dx < rect.w; dx++) {
        grid.setBlock(rect.x + dx, rect.y + dy, Block.None)
        grid.setLevel(rect.x + dx, rect.y + dy, 1)
      }
    }
    return true
  }

  const stairBuilding = buildings[0]
  if (stairBuilding !== undefined && elevate(stairBuilding)) {
    // The ramp stands on the ground just outside the south frontage: its foot
    // is the ground further out, its head is the room. Facing South puts that
    // head inward; facing North would strand the storey.
    const stairX = stairBuilding.x + Math.floor(stairBuilding.w / 2)
    const roomY = stairBuilding.y + stairBuilding.h - 1
    const stairY = roomY + 1

    grid.setStair(stairX, stairY, StairDirection.South, 0)
    // The doorway the ramp arrives at. Without it the wall would refuse the
    // step the stair exists to make.
    grid.setWall(stairX, roomY, Side.South, WallKind.None)

    // Approach, on the ground further out.
    grid.setBlock(stairX, stairY + 1, Block.None)
    grid.setLevel(stairX, stairY + 1, 0)

    reserve(stairX, stairY)
    reserve(stairX, stairY + 1)
    reserve(stairX, roomY)
  }

  const ladderBuilding = buildings[1]
  if (ladderBuilding !== undefined && elevate(ladderBuilding)) {
    // A ladder up the outside of the west wall. The wall stays: the climb goes
    // over it, onto the storey whose floor is that wall's top.
    const roomX = ladderBuilding.x
    const ladY = ladderBuilding.y + Math.floor(ladderBuilding.h / 2)

    grid.setBlock(roomX - 1, ladY, Block.None)
    grid.setLevel(roomX - 1, ladY, 0)
    grid.setLadderFace(roomX, ladY, Side.West)

    reserve(roomX - 1, ladY)
    reserve(roomX, ladY)
  }
  // --- Free-standing wall runs ---------------------------------------------
  // A run lies along one lattice line: a horizontal run is a row of north-side
  // edges, a vertical run a column of west-side edges. It costs no floor, so
  // both sides of it stay playable.
  const wallCount = rng.int(4, 8)
  for (let i = 0; i < wallCount; i++) {
    const horizontal = rng.chance(0.5)
    const length = rng.int(3, 8)
    const w = horizontal ? length : 1
    const h = horizontal ? 1 : length
    const x = rng.int(2, Math.max(2, size - 2 - w))
    const y = rng.int(2, Math.max(2, size - 2 - h))
    const rect: Rect = { x, y, w, h }
    if (zones.some((z) => rectsOverlap(rect, z, 2))) continue
    if (buildings.some((b) => rectsOverlap(rect, b, 1))) continue

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
  const clusterCount = rng.int(8, 14)
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
    for (let dy = 0; dy < zone.h; dy++) {
      for (let dx = 0; dx < zone.w; dx++) {
        const tx = zone.x + dx
        const ty = zone.y + dy
        grid.setBlock(tx, ty, Block.None)
        for (const face of [Side.North, Side.East, Side.South, Side.West]) {
          grid.setWall(tx, ty, face, WallKind.None)
        }
      }
    }
  }

  // --- Guarantee a single connected walkable region -------------------------
  repairConnectivity(grid, reserved)

  // --- Pick spawn tiles -----------------------------------------------------
  const spawns: Record<Faction, Tile[]> = {
    [Faction.Blue]: pickSpawns(grid, rng, blueZone),
    [Faction.Red]: pickSpawns(grid, rng, redZone),
  }

  return { grid, spawns }
}

/**
 * A building: walls on the boundary edges of `rect`, floor throughout, one or
 * two doorways and sometimes a glazed frontage.
 *
 * The whole footprint is walkable — the wall ring costs no tiles, so the
 * interior is a room a squad can fight over rather than a solid block.
 */
function carveBuilding(grid: Grid, rng: Rng, rect: Rect): void {
  const { x, y, w, h } = rect

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      grid.setBlock(x + dx, y + dy, Block.None)
    }
  }

  for (let dx = 0; dx < w; dx++) {
    grid.setWall(x + dx, y, Side.North, WallKind.Solid)
    grid.setWall(x + dx, y + h - 1, Side.South, WallKind.Solid)
  }
  for (let dy = 0; dy < h; dy++) {
    grid.setWall(x, y + dy, Side.West, WallKind.Solid)
    grid.setWall(x + w - 1, y + dy, Side.East, WallKind.Solid)
  }

  /** A non-corner edge on one of the four frontages. */
  const frontage = (which: number): { x: number; y: number; side: Side } => {
    if (which === 0) return { x: x + rng.int(1, w - 2), y, side: Side.North }
    if (which === 1) return { x: x + rng.int(1, w - 2), y: y + h - 1, side: Side.South }
    if (which === 2) return { x, y: y + rng.int(1, h - 2), side: Side.West }
    return { x: x + w - 1, y: y + rng.int(1, h - 2), side: Side.East }
  }

  // Doorways: gaps in the ring, never at a corner.
  const doors = rng.int(1, 2)
  for (let d = 0; d < doors; d++) {
    const spot = frontage(rng.int(0, 3))
    grid.setWall(spot.x, spot.y, spot.side, WallKind.None)
  }

  // Glazing: you can watch the room through it, but not walk in.
  if (rng.chance(0.5)) {
    const spot = frontage(rng.int(0, 3))
    if (grid.wallAt(spot.x, spot.y, spot.side) === WallKind.Solid) {
      grid.setWall(spot.x, spot.y, spot.side, WallKind.Glass)
    }
  }

  // A little interior clutter (crates or low partition walls) so buildings are not empty.
  if (w > 4 && h > 4) {
    if (rng.chance(0.4)) {
      grid.setBlock(x + rng.int(1, w - 2), y + rng.int(1, h - 2), Block.Half)
    }
    if (w > 5 && h > 5 && rng.chance(0.4)) {
      // Low interior partition wall
      const partX = x + Math.floor(w / 2)
      const partY = y + rng.int(1, h - 2)
      grid.setWall(partX, partY, Side.North, WallKind.Parapet)
    }
  }
}
/**
 * Reduce the map to a single region a unit can actually walk around.
 *
 * Components are grown through {@link Grid.canTraverse}, so a raised storey is
 * only "connected" when a stair or ladder truly joins it. Judging adjacency by
 * walkability alone reports storeys as connected that nothing can reach, and
 * then carves ground corridors that cannot possibly help.
 *
 * Two repairs are available: carve a corridor between components on the same
 * storey, or — where a stranded region merely sits above its neighbour — bolt
 * on a ladder.
 */
function repairConnectivity(grid: Grid, reserved: Set<number>): void {
  const size = grid.size
  const tileOf = (idx: number): Tile => ({ x: idx % size, y: (idx / size) | 0 })

  for (let guard = 0; guard < 64; guard++) {
    const components = labelComponents(grid)
    if (components.length <= 1) return

    let main = components[0]!
    for (const c of components) if (c.count > main.count) main = c

    const satellite = components.find((c) => c !== main)
    if (satellite === undefined) return

    if (linkByLadder(grid, satellite, main, tileOf)) continue

    // Corridor carving is a ground-plane operation, so pick the closest pair
    // of tiles that share a storey.
    let from: Tile | null = null
    let to: Tile | null = null
    let bestDist = Infinity
    for (const sIdx of satellite.tiles) {
      const s = tileOf(sIdx)
      const sLevel = grid.levelAt(s.x, s.y)
      for (const mIdx of main.tiles) {
        const m = tileOf(mIdx)
        if (grid.levelAt(m.x, m.y) !== sLevel) continue
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
 * Join two components with a ladder where one sits exactly one storey above a
 * neighbouring tile of the other.
 */
function linkByLadder(
  grid: Grid,
  satellite: Component,
  main: Component,
  tileOf: (idx: number) => Tile,
): boolean {
  const inMain = new Set(main.tiles)

  for (const sIdx of satellite.tiles) {
    const s = tileOf(sIdx)
    const sLevel = grid.levelAt(s.x, s.y)
    for (const [dx, dy] of ORTHOGONAL) {
      const n = { x: s.x + dx, y: s.y + dy }
      if (!grid.isWalkable(n.x, n.y)) continue
      if (!inMain.has(grid.index(n.x, n.y))) continue

      const nLevel = grid.levelAt(n.x, n.y)
      if (Math.abs(sLevel - nLevel) !== 1) continue

      const upper = sLevel > nLevel ? s : n
      const lower = sLevel > nLevel ? n : s
      const face = faceToward(upper, lower)
      if (face === 0) continue

      grid.setLadderFace(upper.x, upper.y, face)
      return true
    }
  }
  return false
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
  for (let dy = 0; dy < zone.h; dy++) {
    for (let dx = 0; dx < zone.w; dx++) {
      const x = zone.x + dx
      const y = zone.y + dy
      if (grid.isWalkable(x, y)) candidates.push({ x, y })
    }
  }
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
