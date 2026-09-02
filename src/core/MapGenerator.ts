import { Faction, GRID_SIZE, SQUAD_SIZE } from '../config'
import { Block, Grid, ORTHOGONAL, StairDirection, type Tile } from './Grid'
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
 *   - solid map border
 *   - rectangular buildings (full-height walls, doorways, open interiors)
 *   - free-standing wall segments for mid-map cover
 *   - crate clusters (half-height, shootable over)
 *   - two opposing deployment zones, guaranteed clear and mutually reachable
 */
export function generateMap(seed: number, size: number = GRID_SIZE): GeneratedMap {
  const rng = new Rng(seed)
  const grid = new Grid(size)

  // --- Border ---------------------------------------------------------------
  for (let i = 0; i < size; i++) {
    grid.setBlock(i, 0, Block.Full)
    grid.setBlock(i, size - 1, Block.Full)
    grid.setBlock(0, i, Block.Full)
    grid.setBlock(size - 1, i, Block.Full)
  }

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
  const elevate = (rect: Rect): boolean => {
    if (rect.w < 4 || rect.h < 4) return false
    for (let dy = 1; dy < rect.h - 1; dy++) {
      for (let dx = 1; dx < rect.w - 1; dx++) {
        grid.setBlock(rect.x + dx, rect.y + dy, Block.None)
        grid.setLevel(rect.x + dx, rect.y + dy, 1)
      }
    }
    return true
  }

  const stairBuilding = buildings[0]
  if (stairBuilding !== undefined && elevate(stairBuilding)) {
    // The stair sits in the high-Y wall, so the ground approach is outside at
    // +Y and the landing is the storey inside at -Y. Facing South puts the
    // upper side inward; facing North would strand the storey.
    const stairX = stairBuilding.x + Math.floor(stairBuilding.w / 2)
    const stairY = stairBuilding.y + stairBuilding.h - 1
    grid.setStair(stairX, stairY, StairDirection.South, 0)

    // Approach, on the ground outside.
    grid.setBlock(stairX, stairY + 1, Block.None)
    grid.setLevel(stairX, stairY + 1, 0)
    // Landing, on the storey inside. Left at level 1 by `elevate`.
    grid.setBlock(stairX, stairY - 1, Block.None)
    grid.setLevel(stairX, stairY - 1, 1)
  }

  const ladderBuilding = buildings[1]
  if (ladderBuilding !== undefined && elevate(ladderBuilding)) {
    // The ladder sits in the low-X wall: ground outside at -X, storey inside
    // at +X.
    const ladX = ladderBuilding.x
    const ladY = ladderBuilding.y + Math.floor(ladderBuilding.h / 2)
    grid.setLadder(ladX, ladY, 0)

    grid.setBlock(ladX - 1, ladY, Block.None)
    grid.setLevel(ladX - 1, ladY, 0)
    grid.setBlock(ladX + 1, ladY, Block.None)
    grid.setLevel(ladX + 1, ladY, 1)
  }

  // --- Free-standing walls --------------------------------------------------
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

    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        grid.setBlock(x + dx, y + dy, Block.Full)
      }
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
      if (grid.blockAt(x, y) !== Block.None) continue
      grid.setBlock(x, y, Block.Half)
    }
  }

  // --- Clear the deployment zones ------------------------------------------
  for (const zone of zones) {
    for (let dy = 0; dy < zone.h; dy++) {
      for (let dx = 0; dx < zone.w; dx++) {
        grid.setBlock(zone.x + dx, zone.y + dy, Block.None)
      }
    }
  }

  // --- Guarantee a single connected walkable region -------------------------
  repairConnectivity(grid)

  // --- Pick spawn tiles -----------------------------------------------------
  const spawns: Record<Faction, Tile[]> = {
    [Faction.Blue]: pickSpawns(grid, rng, blueZone),
    [Faction.Red]: pickSpawns(grid, rng, redZone),
  }

  return { grid, spawns }
}

/** Walls on the perimeter of `rect`, hollow interior, 1–2 doorways. */
function carveBuilding(grid: Grid, rng: Rng, rect: Rect): void {
  const { x, y, w, h } = rect
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const isEdge = dx === 0 || dy === 0 || dx === w - 1 || dy === h - 1
      grid.setBlock(x + dx, y + dy, isEdge ? Block.Full : Block.None)
    }
  }

  // Doorways: punch holes in random wall segments (never in a corner).
  const doors = rng.int(1, 2)
  for (let d = 0; d < doors; d++) {
    const side = rng.int(0, 3)
    if (side === 0) grid.setBlock(x + rng.int(1, w - 2), y, Block.None)
    else if (side === 1) grid.setBlock(x + rng.int(1, w - 2), y + h - 1, Block.None)
    else if (side === 2) grid.setBlock(x, y + rng.int(1, h - 2), Block.None)
    else grid.setBlock(x + w - 1, y + rng.int(1, h - 2), Block.None)
  }

  // A little interior clutter so buildings are not empty boxes.
  if (w > 4 && h > 4 && rng.chance(0.6)) {
    grid.setBlock(x + rng.int(1, w - 2), y + rng.int(1, h - 2), Block.Half)
  }
}

/**
 * Split the walkable tiles into connected components and carve straight
 * corridors from every satellite component into the largest one, until a
 * single component remains. Never touches the map border.
 */
function repairConnectivity(grid: Grid): void {
  const size = grid.size

  for (let guard = 0; guard < 64; guard++) {
    const components = labelComponents(grid)
    if (components.length <= 1) return

    // Largest component is the mainland.
    let main = components[0]!
    for (const c of components) if (c.count > main.count) main = c

    // Take one satellite per pass, carve it into the mainland, then re-label.
    const satellite = components.find((c) => c !== main)
    if (satellite === undefined) return

    const from: Tile = { x: satellite.tiles[0]! % size, y: (satellite.tiles[0]! / size) | 0 }

    let to: Tile | null = null
    let bestDist = Infinity
    for (const mIdx of main.tiles) {
      const mx = mIdx % size
      const my = (mIdx / size) | 0
      const d = Math.abs(from.x - mx) + Math.abs(from.y - my)
      if (d < bestDist) {
        bestDist = d
        to = { x: mx, y: my }
      }
    }

    if (to === null) return
    carveCorridor(grid, from, to)
  }
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
        const idx = tiles[head]!
        const cx = idx % size
        const cy = (idx / size) | 0
        for (const [dx, dy] of ORTHOGONAL) {
          const nx = cx + dx
          const ny = cy + dy
          if (!grid.isWalkable(nx, ny)) continue
          const nIdx = grid.index(nx, ny)
          if (labels[nIdx] !== -1) continue
          labels[nIdx] = label
          tiles.push(nIdx)
        }
      }

      components.push({ label, count: tiles.length, tiles })
    }
  }

  return components
}

/** Clear an L-shaped corridor between two tiles, leaving the border intact. */
function carveCorridor(grid: Grid, from: Tile, to: Tile): void {
  const size = grid.size
  const clear = (x: number, y: number) => {
    if (x <= 0 || y <= 0 || x >= size - 1 || y >= size - 1) return
    grid.setBlock(x, y, Block.None)
  }

  const stepX = Math.sign(to.x - from.x)
  let x = from.x
  while (x !== to.x) {
    x += stepX
    clear(x, from.y)
  }
  const stepY = Math.sign(to.y - from.y)
  let y = from.y
  while (y !== to.y) {
    y += stepY
    clear(to.x, y)
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
