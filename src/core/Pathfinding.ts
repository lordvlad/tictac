import { RULES } from '../config'
import { NEIGHBOURS, type Grid, type Tile, tileEquals } from './Grid'

export interface PathResult {
  path: Tile[]
  totalCost: number
  valid: boolean
}

/**
 * Whether a unit may step from one tile to a neighbour.
 *
 * The one rule both searches use, so a route the planner offers is a route the
 * walker can take: the terrain allows the crossing, nobody is standing there
 * (the ends of a route excepted), and a diagonal does not cut a corner past a
 * wall or a body.
 */
function canStep(
  grid: Grid,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  occupied: Set<number>,
  startIdx: number,
  goalIdx: number,
): boolean {
  const nx = cx + dx
  const ny = cy + dy
  if (!grid.canTraverse({ x: cx, y: cy }, { x: nx, y: ny })) return false
  const nIdx = grid.index(nx, ny)
  if (nIdx !== startIdx && nIdx !== goalIdx && occupied.has(nIdx)) return false
  if (dx !== 0 && dy !== 0) {
    if (!grid.isWalkable(cx + dx, cy) || !grid.isWalkable(cx, cy + dy)) return false
    if (occupied.has(grid.index(cx + dx, cy)) || occupied.has(grid.index(cx, cy + dy))) return false
  }
  return true
}

/**
 * A* search between two tiles.
 */
export function findPathSegment(
  grid: Grid,
  start: Tile,
  goal: Tile,
  occupiedTiles: Set<number>,
): { path: Tile[]; cost: number } {
  if (tileEquals(start, goal)) {
    return { path: [start], cost: 0 }
  }

  const size = grid.size
  const startIdx = grid.index(start.x, start.y)
  const goalIdx = grid.index(goal.x, goal.y)

  const gScore = new Float32Array(size * size).fill(Infinity)
  const fScore = new Float32Array(size * size).fill(Infinity)
  const cameFrom = new Int32Array(size * size).fill(-1)

  gScore[startIdx] = 0
  fScore[startIdx] = grid.distance(start, goal)

  const openSet: number[] = [startIdx]

  while (openSet.length > 0) {
    // Find node in openSet with lowest fScore
    let bestIdx = 0
    let bestF = fScore[openSet[0]!]!
    for (let i = 1; i < openSet.length; i++) {
      const f = fScore[openSet[i]!]!
      if (f < bestF) {
        bestF = f
        bestIdx = i
      }
    }

    const current = openSet[bestIdx]!
    if (current === goalIdx) {
      // Reconstruct path
      const path: Tile[] = []
      let curr = goalIdx
      while (curr !== -1) {
        path.unshift({ x: curr % size, y: (curr / size) | 0 })
        curr = cameFrom[curr]!
      }
      return { path, cost: gScore[goalIdx]! }
    }

    openSet.splice(bestIdx, 1)
    const cx = current % size
    const cy = (current / size) | 0

    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cx + dx
      const ny = cy + dy
      if (!canStep(grid, cx, cy, dx, dy, occupiedTiles, startIdx, goalIdx)) continue
      const nIdx = grid.index(nx, ny)

      const stepCost = grid.getStepCost({ x: cx, y: cy }, { x: nx, y: ny })
      const tentativeG = gScore[current]! + stepCost
      if (tentativeG < gScore[nIdx]!) {
        cameFrom[nIdx] = current
        gScore[nIdx] = tentativeG
        fScore[nIdx] = tentativeG + grid.distance({ x: nx, y: ny }, goal)
        if (!openSet.includes(nIdx)) {
          openSet.push(nIdx)
        }
      }
    }
  }

  // No path found
  return { path: [], cost: Infinity }
}

/**
 * Find chained path passing through waypoints: start -> waypoints[0] -> ... -> goal
 */
export function findChainedPath(
  grid: Grid,
  start: Tile,
  goal: Tile,
  waypoints: Tile[],
  maxCost: number,
  occupiedTiles: Set<number>,
): PathResult {
  const points = [start, ...waypoints, goal]
  const fullPath: Tile[] = [start]
  let totalCost = 0

  for (let i = 0; i < points.length - 1; i++) {
    const pFrom = points[i]!
    const pTo = points[i + 1]!

    const segment = findPathSegment(grid, pFrom, pTo, occupiedTiles)
    if (segment.path.length === 0) {
      return { path: [], totalCost: Infinity, valid: false }
    }

    // Append segment tiles (excluding first tile since it's already in fullPath)
    for (let k = 1; k < segment.path.length; k++) {
      fullPath.push(segment.path[k]!)
    }
    totalCost += segment.cost
  }

  const valid = totalCost <= maxCost && grid.isWalkable(goal.x, goal.y)
  return { path: fullPath, totalCost, valid }
}

/** Every tile a unit can reach within a budget, and the cheapest way there. */
export interface Reach {
  /** Terrain cost to reach each tile by index; `Infinity` where it cannot. */
  cost: Float32Array
  /** The tile each one is reached from, by index; `-1` at the start and beyond reach. */
  from: Int32Array
  /** Indices of the reachable tiles, the start excluded, cheapest first. */
  tiles: number[]
}

/**
 * Dijkstra out from `start`, stopping at `budget` in the terrain's own prices.
 *
 * The same stepping rule as {@link findPathSegment}, so any tile it reports can
 * be walked to along {@link routeTo}. Occupied tiles are never destinations.
 * Pass the budget already divided by the unit's movement multiplier (see
 * `moveBudget`): routes are costed in terrain points.
 */
export function reachable(grid: Grid, start: Tile, occupied: Set<number>, budget: number): Reach {
  const size = grid.size
  const startIdx = grid.index(start.x, start.y)
  const cost = new Float32Array(size * size).fill(Infinity)
  const from = new Int32Array(size * size).fill(-1)
  const done = new Uint8Array(size * size)
  const tiles: number[] = []
  cost[startIdx] = 0
  const open: number[] = [startIdx]

  while (open.length > 0) {
    let best = 0
    for (let i = 1; i < open.length; i++) if (cost[open[i]!]! < cost[open[best]!]!) best = i
    const current = open[best]!
    open[best] = open[open.length - 1]!
    open.pop()
    if (done[current]) continue
    done[current] = 1
    if (current !== startIdx) tiles.push(current)

    const cx = current % size
    const cy = (current / size) | 0
    for (const [dx, dy] of NEIGHBOURS) {
      if (!canStep(grid, cx, cy, dx, dy, occupied, startIdx, -1)) continue
      const next = grid.index(cx + dx, cy + dy)
      if (done[next]) continue
      const through = cost[current]! + grid.getStepCost({ x: cx, y: cy }, { x: cx + dx, y: cy + dy })
      if (through > budget || through >= cost[next]!) continue
      cost[next] = through
      from[next] = current
      open.push(next)
    }
  }
  return { cost, from, tiles }
}

/** The route to a reachable tile, start first — the shape a `moveUnit` intent carries. */
export function routeTo(grid: Grid, reach: Reach, index: number): Tile[] {
  const route: Tile[] = []
  for (let at = index; at !== -1; at = reach.from[at]!) {
    route.push({ x: at % grid.size, y: (at / grid.size) | 0 })
  }
  return route.reverse()
}
