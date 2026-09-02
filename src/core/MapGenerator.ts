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
  const buildingTarget = rng.int(5, 7)
  for (let attempt = 0; attempt < 400 && buildings.length < buildingTarget; attempt++) {
    const w = rng.int(6, 12)
    const h = rng.int(6, 12)
    const x = rng.int(2, size - 2 - w)
    const y = rng.int(2, size - 2 - h)
    const rect: Rect = { x, y, w, h }

    if (zones.some((z) => rectsOverlap(rect, z, 2))) continue
    if (buildings.some((b) => rectsOverlap(rect, b, 2))) continue

    buildings.push(rect)
    carveBuilding(grid, rng, rect)
  }

  // --- Upper storeys, stairs and ladders (2-storey buildings) ---------------
  // Level 1 rooms are strictly built on top of / attached to Level 0 rooms.
  const reserved = new Set<number>()
  const reserve = (x: number, y: number): void => {
    reserved.add(grid.index(x, y))
  }

  // Stair building (buildings[0]): ground wing (level 0) + upper wing (level 1)
  const stairBuilding = buildings[0]
  if (stairBuilding !== undefined) {
    const { x, y, w, h } = stairBuilding
    const splitY = h >= 6 ? Math.floor(h / 2) : 2

    // Elevate upper wing to level 1 (ground wing at y..y+splitY-1 stays level 0)
    for (let dy = splitY; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        grid.setLevel(x + dx, y + dy, 1)
      }
    }

    const stairX = x + Math.floor(w / 2)
    const stairY = y + splitY

    // Stair connects ground room at (stairX, stairY - 1) to upper room at (stairX, stairY + 1)
    grid.setStair(stairX, stairY, StairDirection.North, 0)
    grid.setWall(stairX, stairY, Side.North, WallKind.None)
    grid.setWall(stairX, stairY, Side.South, WallKind.None)

    reserve(stairX, stairY)
    reserve(stairX, stairY - 1)
    reserve(stairX, stairY + 1)
  }

  // Ladder building (buildings[1]): ground wing (level 0) + upper wing (level 1)
  const ladderBuilding = buildings[1]
  if (ladderBuilding !== undefined && buildings.length > 1) {
    const { x, y, w, h } = ladderBuilding
    const splitX = w >= 6 ? Math.floor(w / 2) : 2

    // Elevate east wing to level 1 (west wing at x..x+splitX-1 stays level 0)
    for (let dy = 0; dy < h; dy++) {
      for (let dx = splitX; dx < w; dx++) {
        grid.setLevel(x + dx, y + dy, 1)
      }
    }

    const ladX = x + splitX
    const ladY = y + Math.floor(h / 2)

    // Ladder on interior partition facing West (connecting ground room to upper room)
    grid.setLadderFace(ladX, ladY, Side.West)

    reserve(ladX - 1, ladY)
    reserve(ladX, ladY)
  }
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
 * A multi-room building: perimeter walls, interior partition walls dividing it
 * into connected rooms, exterior doors, windows, and interior clutter.
 */
function carveBuilding(grid: Grid, rng: Rng, rect: Rect): void {
  const { x, y, w, h } = rect

  // 1. Clear floor at level 0 throughout
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      grid.setBlock(x + dx, y + dy, Block.None)
      grid.setLevel(x + dx, y + dy, 0)
    }
  }

  // 2. Outer perimeter walls
  for (let dx = 0; dx < w; dx++) {
    grid.setWall(x + dx, y, Side.North, WallKind.Solid)
    grid.setWall(x + dx, y + h - 1, Side.South, WallKind.Solid)
  }
  for (let dy = 0; dy < h; dy++) {
    grid.setWall(x, y + dy, Side.West, WallKind.Solid)
    grid.setWall(x + w - 1, y + dy, Side.East, WallKind.Solid)
  }

  // 3. Multi-room interior partition walls
  const splitX = w >= 7 ? Math.floor(w / 2) : 0
  const splitY = h >= 7 ? Math.floor(h / 2) : 0

  if (splitX > 0) {
    for (let dy = 1; dy < h - 1; dy++) {
      grid.setWall(x + splitX, y + dy, Side.West, WallKind.Solid)
    }
    // Doorway in vertical partition
    const doorY1 = y + rng.int(1, Math.max(1, splitY > 0 ? splitY - 1 : h - 2))
    grid.setWall(x + splitX, doorY1, Side.West, WallKind.None)
    if (splitY > 0 && h - 1 - splitY > 2) {
      const doorY2 = y + rng.int(splitY + 1, h - 2)
      grid.setWall(x + splitX, doorY2, Side.West, WallKind.None)
    }
  }

  if (splitY > 0) {
    for (let dx = 1; dx < w - 1; dx++) {
      grid.setWall(x + dx, y + splitY, Side.North, WallKind.Solid)
    }
    // Doorway in horizontal partition
    const doorX1 = x + rng.int(1, Math.max(1, splitX > 0 ? splitX - 1 : w - 2))
    grid.setWall(doorX1, y + splitY, Side.North, WallKind.None)
    if (splitX > 0 && w - 1 - splitX > 2) {
      const doorX2 = x + rng.int(splitX + 1, w - 2)
      grid.setWall(doorX2, y + splitY, Side.North, WallKind.None)
    }
  }

  // 4. Exterior doorways: 2-3 doors on frontages
  const frontage = (which: number): { x: number; y: number; side: Side } => {
    if (which === 0) return { x: x + rng.int(1, w - 2), y, side: Side.North }
    if (which === 1) return { x: x + rng.int(1, w - 2), y: y + h - 1, side: Side.South }
    if (which === 2) return { x, y: y + rng.int(1, h - 2), side: Side.West }
    return { x: x + w - 1, y: y + rng.int(1, h - 2), side: Side.East }
  }

  const doors = rng.int(2, 3)
  for (let d = 0; d < doors; d++) {
    const spot = frontage(rng.int(0, 3))
    grid.setWall(spot.x, spot.y, spot.side, WallKind.None)
  }

  // 5. Exterior glazing
  if (rng.chance(0.6)) {
    const spot = frontage(rng.int(0, 3))
    if (grid.wallAt(spot.x, spot.y, spot.side) === WallKind.Solid) {
      grid.setWall(spot.x, spot.y, spot.side, WallKind.Glass)
    }
  }

  // 6. Interior clutter (crates or low parapet partitions inside rooms)
  if (w > 4 && h > 4) {
    if (rng.chance(0.4)) {
      grid.setBlock(x + rng.int(1, w - 2), y + rng.int(1, h - 2), Block.Half)
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
