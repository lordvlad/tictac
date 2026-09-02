import { RULES } from '../config'
import { NEIGHBOURS, type Grid, type Tile, tileEquals } from './Grid'

export interface PathResult {
  path: Tile[]
  totalCost: number
  valid: boolean
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

      if (!grid.canTraverse({ x: cx, y: cy }, { x: nx, y: ny })) continue

      const nIdx = grid.index(nx, ny)
      // Blocked by another unit (unless it's the start or goal tile)
      if (nIdx !== startIdx && nIdx !== goalIdx && occupiedTiles.has(nIdx)) continue

      const isDiagonal = dx !== 0 && dy !== 0
      if (isDiagonal) {
        if (!grid.isWalkable(cx + dx, cy) || !grid.isWalkable(cx, cy + dy)) continue
        if (occupiedTiles.has(grid.index(cx + dx, cy)) || occupiedTiles.has(grid.index(cx, cy + dy))) continue
      }

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
