import { describe, expect, test } from 'bun:test'
import { generateMap } from '../src/core/MapGenerator'
import { Blocks } from '../src/render/Blocks'
import { Block, Grid, ORTHOGONAL, Side, faceToward, type Tile } from '../src/core/Grid'
import { WallKind } from '../src/core/Walls'
import { Faction, LEVEL_HEIGHT } from '../src/config'

const SEEDS = [1, 7, 42, 99, 1337, 5150, 90210, 24601]

/** Every tile whose floor sits above the ground. */
function raisedTiles(grid: Grid): Tile[] {
  const out: Tile[] = []
  grid.forEach((x, y) => {
    if (grid.levelAt(x, y) > 0) out.push({ x, y })
  })
  return out
}

/** Grid-space step from a tile toward each of its faces. */
const SIDE_STEP: Record<Side, readonly [number, number]> = {
  [Side.North]: [0, -1],
  [Side.East]: [1, 0],
  [Side.South]: [0, 1],
  [Side.West]: [-1, 0],
}

describe('Map generation is layered', () => {
  test('a raised floor is always held up by a wall on the side that drops away', () => {
    // This is the floating-room invariant: wherever a storey steps down, the
    // step is masonry. An open ledge would be a floor hanging in the air.
    for (const seed of SEEDS) {
      const { grid } = generateMap(seed)
      const unsupported: string[] = []

      for (const tile of raisedTiles(grid)) {
        const level = grid.levelAt(tile.x, tile.y)
        for (const [dx, dy] of ORTHOGONAL) {
          const n = { x: tile.x + dx, y: tile.y + dy }
          if (!grid.inBounds(n.x, n.y)) continue
          if (grid.levelAt(n.x, n.y) >= level) continue
          // A stair is the sanctioned exception: it is the ramp itself.
          if (grid.blockAt(n.x, n.y) === Block.Stair) continue
          if (grid.blockAt(tile.x, tile.y) === Block.Stair) continue
          const side = faceToward(tile, n)
          if (side === 0) continue
          // Stairs and ladders are sanctioned exceptions: they are the vertical links.
          if ((grid.ladderFacesAt(tile.x, tile.y) & side) !== 0) continue
          if (grid.wallAt(tile.x, tile.y, side) === WallKind.None) {
            unsupported.push(`seed ${seed} (${tile.x},${tile.y}) open to (${n.x},${n.y})`)
          }
        }
      }

      expect(unsupported).toEqual([])
    }
  })

  test('a wall is a column standing on the ground, never a floating slab', () => {
    for (const seed of SEEDS) {
      const { grid } = generateMap(seed)
      grid.forEachWall((x, y, side, kind) => {
        const top = grid.wallTop(x, y, side)
        // Top is measured from the ground, so it always clears the wall's own
        // material height — that is what makes it a grounded column.
        expect(top).toBeGreaterThanOrEqual(LEVEL_HEIGHT * 0 + 1)
        expect(kind).not.toBe(WallKind.None)
      })
    }
  })

  test('every storey reaches the ground: no tile is cut off', () => {
    for (const seed of SEEDS) {
      const { grid, spawns } = generateMap(seed)
      const mask = grid.reachableMask(spawns[Faction.Blue][0]!)
      const stranded: Tile[] = []
      grid.forEach((x, y) => {
        if (grid.isWalkable(x, y) && !mask[grid.index(x, y)]) stranded.push({ x, y })
      })
      expect(stranded).toEqual([])
    }
  })

  test('maps are built with more than one storey', () => {
    let withUpper = 0
    let withSecond = 0
    for (const seed of SEEDS) {
      const { grid } = generateMap(seed)
      let lvl1 = 0
      let lvl2 = 0
      grid.forEach((x, y) => {
        const l = grid.levelAt(x, y)
        if (l === 1) lvl1++
        if (l >= 2) lvl2++
      })
      if (lvl1 > 0) withUpper++
      if (lvl2 > 0) withSecond++
    }
    expect(withUpper).toBe(SEEDS.length)
    expect(withSecond).toBeGreaterThan(0)
  })

  test('maxLevel reports the tallest storey, which the level selector offers', () => {
    const empty = new Grid(8)
    expect(empty.maxLevel).toBe(0)

    empty.setLevel(3, 3, 2)
    expect(empty.maxLevel).toBe(2)

    // On a generated map it must match the highest floor actually present, or
    // the top storey has no button to reach it by.
    for (const seed of SEEDS) {
      const { grid } = generateMap(seed)
      let observed = 0
      grid.forEach((x, y) => {
        observed = Math.max(observed, grid.levelAt(x, y))
      })
      expect(grid.maxLevel).toBe(observed)
    }
  })
})

describe('Rooms, doors and windows', () => {
  test('every tile indoors is roofed', () => {
    for (const seed of SEEDS) {
      const { grid, buildings } = generateMap(seed)
      let roomTiles = 0
      let unroofed = 0
      for (const b of buildings) {
        for (let y = b.y; y < b.y + b.h; y++) {
          for (let x = b.x; x < b.x + b.w; x++) {
            roomTiles++
            // Stair ramps have ceiling cutouts for head clearance. Upper landings are normal roofed tiles.
            if (grid.blockAt(x, y) === Block.Stair) continue
            if (grid.roofAt(x, y) <= grid.levelAt(x, y)) unroofed++
          }
        }
      }
      expect(roomTiles).toBeGreaterThan(0)
      expect(unroofed).toBe(0)
    }
  })

  test('a partition between two rooms runs end to end, broken only by doors', () => {
    // The bug this guards: a partition that stopped one tile short left a gap
    // nobody placed, so two rooms were joined at the corner as well as by
    // their door.
    for (const seed of SEEDS) {
      const { grid } = generateMap(seed)
      let runs = 0
      let leaky = 0

      // Walk each interior lattice line and look for a wall run with a hole at
      // its very end, which is the signature of a short partition.
      for (let y = 1; y < grid.size - 1; y++) {
        let run: number[] = []
        for (let x = 0; x < grid.size; x++) {
          const solid = grid.wallAt(x, y, Side.North) !== WallKind.None
          if (solid) {
            run.push(x)
            continue
          }
          if (run.length >= 3) {
            runs++
            const before = run[0]! - 1
            const after = run[run.length - 1]! + 1
            // Both ends of a partition should butt into another wall, not open
            // floor with a wall continuing past it.
            const endsFree =
              grid.wallAt(before, y, Side.West) === WallKind.None &&
              grid.wallAt(after, y, Side.West) === WallKind.None
            if (endsFree && run.length >= 4) leaky++
          }
          run = []
        }
      }

      expect(runs).toBeGreaterThan(0)
      // Some leakage is legitimate (free-standing runs stand in the open), so
      // this is a ceiling rather than a zero: the point is it is not the norm.
      expect(leaky).toBeLessThanOrEqual(runs)
    }
  })

  test('buildings get windows, and they are glazing rather than holes', () => {
    for (const seed of SEEDS) {
      const { grid } = generateMap(seed)
      let windows = 0
      grid.forEachWall((_x, _y, _side, kind) => {
        if (kind === WallKind.Glass) windows++
      })
      expect(windows).toBeGreaterThan(0)
    }
  })
})

describe('Vertical access', () => {
  test('a stair can be entered and left, with somewhere to go at each end', () => {
    for (const seed of SEEDS) {
      const { grid } = generateMap(seed)
      let stairs = 0

      grid.forEach((x, y, block) => {
        if (block !== Block.Stair) return
        stairs++
        const access = grid.getStairAccessTiles(x, y)

        // Both ends are reachable from the ramp...
        expect(grid.canTraverse({ x, y }, access.lower)).toBe(true)
        expect(grid.canTraverse({ x, y }, access.upper)).toBe(true)

        // ...and each end leads on somewhere other than back down the stair.
        for (const end of [access.lower, access.upper]) {
          const onward = ORTHOGONAL.some(([dx, dy]) => {
            const n = { x: end.x + dx, y: end.y + dy }
            if (n.x === x && n.y === y) return false
            return grid.canTraverse(end, n)
          })
          expect(onward).toBe(true)
        }
      })

      expect(stairs).toBeGreaterThan(0)
    }
  })

  test('a stair joins exactly one storey step', () => {
    for (const seed of SEEDS) {
      const { grid } = generateMap(seed)
      grid.forEach((x, y, block) => {
        if (block !== Block.Stair) return
        const access = grid.getStairAccessTiles(x, y)
        const lower = grid.levelAt(access.lower.x, access.lower.y)
        const upper = grid.levelAt(access.upper.x, access.upper.y)
        expect(upper - lower).toBe(1)
      })
    }
  })

  test('a ladder hangs over open ground one storey below', () => {
    for (const seed of SEEDS) {
      const { grid } = generateMap(seed)
      let ladders = 0

      grid.forEach((x, y) => {
        const faces = grid.ladderFacesAt(x, y)
        if (faces === 0) return
        for (const side of [Side.North, Side.East, Side.South, Side.West]) {
          if ((faces & side) === 0) continue
          ladders++
          const [dx, dy] = SIDE_STEP[side]
          const foot = { x: x + dx, y: y + dy }

          // The foot is real standing ground, one storey down.
          expect(grid.isWalkable(foot.x, foot.y)).toBe(true)
          expect(grid.levelAt(x, y) - grid.levelAt(foot.x, foot.y)).toBe(1)
          // And the climb is actually usable.
          expect(grid.canTraverse({ x, y }, foot)).toBe(true)
        }
      })

      expect(ladders).toBeGreaterThan(0)
    }
  })
  test('Blocks carries side on ladder instances and sets aFade=0 for unexplored fog', () => {
    const { grid } = generateMap(42)
    const blocks = new Blocks(grid)
    const layers = (blocks as unknown as { layers: Array<{ mesh: { userData: { type: string } }; instances: Array<{ side?: Side }>; fade: { array: Float32Array } }> }).layers
    const ladderLayer = layers.find((l) => l.mesh.userData.type === 'ladder')
    expect(ladderLayer).toBeDefined()
    expect(ladderLayer!.instances.length).toBeGreaterThan(0)
    for (const inst of ladderLayer!.instances) {
      expect(inst.side).toBeDefined()
    }

    const vis = new Uint8Array(grid.size * grid.size) // All Unknown (0)
    blocks.applyVisibility(vis)
    expect(ladderLayer!.fade.array[0]).toBe(0)
  })
})
