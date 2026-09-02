import { describe, expect, test } from 'bun:test'
import { Block, Grid, Side } from '../src/core/Grid'
import { CoverLevel, WallKind } from '../src/core/Walls'
import { coverLevelInDir, shotCoverLevel } from '../src/core/Cover'
import { hasLineOfSight, peekOrigins } from '../src/core/Visibility'
import { findPathSegment } from '../src/core/Pathfinding'
import { generateMap } from '../src/core/MapGenerator'
import { World } from '../src/ecs/World'
import { WallSystem } from '../src/ecs/systems/WallSystem'
import { WallComponent } from '../src/ecs/components/WallComponent'

describe('Walls as edges', () => {
  test('a wall blocks the step between two tiles without consuming either', () => {
    const grid = new Grid(10)
    grid.setWall(4, 4, Side.East, WallKind.Solid)

    // The wall has no footprint: a unit can stand on both sides of it.
    expect(grid.isWalkable(4, 4)).toBe(true)
    expect(grid.isWalkable(5, 4)).toBe(true)
    expect(grid.blockAt(4, 4)).toBe(Block.None)
    expect(grid.blockAt(5, 4)).toBe(Block.None)

    expect(grid.canTraverse({ x: 4, y: 4 }, { x: 5, y: 4 })).toBe(false)
    expect(grid.canTraverse({ x: 5, y: 4 }, { x: 4, y: 4 })).toBe(false)
    // Every other side of the same tile is still open.
    expect(grid.canTraverse({ x: 4, y: 4 }, { x: 4, y: 5 })).toBe(true)
  })

  test('an edge is one wall, not one per tile', () => {
    const grid = new Grid(10)
    grid.setWall(4, 4, Side.East, WallKind.Solid)

    // Read from the far tile: the same boundary, so the same wall.
    expect(grid.wallAt(5, 4, Side.West)).toBe(WallKind.Solid)
    expect(grid.wallBetween({ x: 5, y: 4 }, { x: 4, y: 4 })).toBe(WallKind.Solid)

    // Clearing it from the other side clears the one wall there is.
    grid.setWall(5, 4, Side.West, WallKind.None)
    expect(grid.wallAt(4, 4, Side.East)).toBe(WallKind.None)
  })

  test('the map border is solid and not writable', () => {
    const grid = new Grid(10)
    expect(grid.wallAt(0, 3, Side.West)).toBe(WallKind.Solid)
    expect(grid.wallAt(9, 3, Side.East)).toBe(WallKind.Solid)

    grid.setWall(0, 3, Side.West, WallKind.None)
    expect(grid.wallAt(0, 3, Side.West)).toBe(WallKind.Solid)
    expect(grid.canTraverse({ x: 0, y: 3 }, { x: -1, y: 3 })).toBe(false)
  })

  test('a diagonal walks round the end of a wall but not through a run of it', () => {
    const grid = new Grid(10)
    grid.setWall(4, 4, Side.East, WallKind.Solid)

    // That wall only *ends* at the corner, so the way round via (4,5) is open.
    expect(grid.canTraverse({ x: 4, y: 4 }, { x: 5, y: 5 })).toBe(true)
    expect(grid.canTraverse({ x: 5, y: 5 }, { x: 4, y: 4 })).toBe(true)

    // Extend it into a continuous run through the corner: now both ways round
    // are blocked and the diagonal is refused.
    grid.setWall(4, 5, Side.East, WallKind.Solid)
    expect(grid.canTraverse({ x: 4, y: 4 }, { x: 5, y: 5 })).toBe(false)
    expect(grid.canTraverse({ x: 5, y: 5 }, { x: 4, y: 4 })).toBe(false)

    // Wrapping the far tile closes it too, without any wall running through.
    const wrapped = new Grid(10)
    wrapped.setWall(5, 5, Side.North, WallKind.Solid)
    wrapped.setWall(5, 5, Side.West, WallKind.Solid)
    expect(wrapped.canTraverse({ x: 4, y: 4 }, { x: 5, y: 5 })).toBe(false)

    // A corner nothing touches is still fine.
    expect(grid.canTraverse({ x: 4, y: 4 }, { x: 3, y: 5 })).toBe(true)
  })

  test('glass stops movement but not sight; solid stops both', () => {
    const grid = new Grid(10)
    grid.setWall(2, 5, Side.East, WallKind.Glass)
    grid.setWall(6, 5, Side.East, WallKind.Solid)

    expect(grid.canTraverse({ x: 2, y: 5 }, { x: 3, y: 5 })).toBe(false)
    expect(grid.blocksSightBetween({ x: 2, y: 5 }, { x: 3, y: 5 })).toBe(false)

    expect(grid.canTraverse({ x: 6, y: 5 }, { x: 7, y: 5 })).toBe(false)
    expect(grid.blocksSightBetween({ x: 6, y: 5 }, { x: 7, y: 5 })).toBe(true)
  })

  test('a parapet is walked into but seen over, and shelters the tile behind it', () => {
    const grid = new Grid(10)
    grid.setWall(4, 4, Side.North, WallKind.Parapet)

    expect(grid.canTraverse({ x: 4, y: 4 }, { x: 4, y: 3 })).toBe(false)
    expect(hasLineOfSight(grid, { x: 4, y: 4 }, { x: 4, y: 1 })).toBe(true)
    expect(coverLevelInDir(grid, { x: 4, y: 4 }, 0, -1)).toBe(CoverLevel.Low)
  })
})

describe('Walls, sight and cover', () => {
  test('sight is stopped by the wall it crosses, not by a tile', () => {
    const grid = new Grid(10)
    grid.setWall(5, 5, Side.North, WallKind.Solid)

    // Straight through the wall.
    expect(hasLineOfSight(grid, { x: 5, y: 6 }, { x: 5, y: 4 })).toBe(false)
    // Alongside it, crossing nothing.
    expect(hasLineOfSight(grid, { x: 5, y: 6 }, { x: 5, y: 7 })).toBe(true)
    // The tile the wall stands on is not itself opaque.
    expect(hasLineOfSight(grid, { x: 3, y: 5 }, { x: 7, y: 5 })).toBe(true)
  })

  test('a single wall corner does not block the diagonal view past it', () => {
    const grid = new Grid(10)
    grid.setWall(5, 5, Side.North, WallKind.Solid)

    // The ray from (4,6) to (6,4) threads the lattice point at the wall's end.
    // One wall meets that corner, so the sightline survives.
    expect(hasLineOfSight(grid, { x: 4, y: 6 }, { x: 6, y: 4 })).toBe(true)
  })

  test('two walls meeting at a corner do block the diagonal view', () => {
    const grid = new Grid(10)
    grid.setWall(5, 5, Side.North, WallKind.Solid)
    grid.setWall(5, 5, Side.West, WallKind.Solid)

    expect(hasLineOfSight(grid, { x: 4, y: 4 }, { x: 6, y: 6 })).toBe(false)
  })

  test('glazing is transparent to a long sightline', () => {
    const grid = new Grid(10)
    grid.setWall(5, 5, Side.North, WallKind.Glass)
    expect(hasLineOfSight(grid, { x: 5, y: 7 }, { x: 5, y: 2 })).toBe(true)
  })

  test('cover comes from the wall crossed, and a crate still counts', () => {
    const grid = new Grid(10)
    grid.setWall(4, 4, Side.North, WallKind.Solid)
    grid.setBlock(5, 4, Block.Half)

    // Shot from the north crosses the wall.
    expect(shotCoverLevel(grid, { x: 4, y: 1 }, { x: 4, y: 4 })).toBe(CoverLevel.Tall)
    // Shot from the east crosses the crate's side.
    expect(shotCoverLevel(grid, { x: 8, y: 4 }, { x: 4, y: 4 })).toBe(CoverLevel.Low)
    // Shot from the south crosses neither.
    expect(shotCoverLevel(grid, { x: 4, y: 8 }, { x: 4, y: 4 })).toBe(CoverLevel.None)
  })

  test('a unit only peeks when it is actually up against a wall', () => {
    const grid = new Grid(10)
    expect(peekOrigins(grid, { x: 5, y: 5 })).toEqual([])

    grid.setWall(5, 5, Side.North, WallKind.Solid)
    const origins = peekOrigins(grid, { x: 5, y: 5 })
    expect(origins.length).toBeGreaterThan(0)
    // Leaning never goes through the wall it is leaning on.
    expect(origins).not.toContainEqual({ x: 5, y: 4 })
  })
})

describe('Walls and routing', () => {
  test('a walled room is entered through its doorway', () => {
    const grid = new Grid(12)
    // A 3x3 room from (4,4) to (6,6), sealed all round.
    for (let x = 4; x <= 6; x++) {
      grid.setWall(x, 4, Side.North, WallKind.Solid)
      grid.setWall(x, 6, Side.South, WallKind.Solid)
    }
    for (let y = 4; y <= 6; y++) {
      grid.setWall(4, y, Side.West, WallKind.Solid)
      grid.setWall(6, y, Side.East, WallKind.Solid)
    }

    expect(findPathSegment(grid, { x: 1, y: 5 }, { x: 5, y: 5 }, new Set()).path).toEqual([])

    // Punch a doorway in the west frontage.
    grid.setWall(4, 5, Side.West, WallKind.None)
    const res = findPathSegment(grid, { x: 1, y: 5 }, { x: 5, y: 5 }, new Set())
    expect(res.path.length).toBeGreaterThan(0)
    expect(res.path).toContainEqual({ x: 4, y: 5 })
  })

  test('glazing seals a room even though you can see inside', () => {
    const grid = new Grid(12)
    for (let x = 4; x <= 6; x++) {
      grid.setWall(x, 4, Side.North, WallKind.Solid)
      grid.setWall(x, 6, Side.South, WallKind.Solid)
    }
    for (let y = 4; y <= 6; y++) {
      grid.setWall(4, y, Side.West, WallKind.Glass)
      grid.setWall(6, y, Side.East, WallKind.Solid)
    }

    expect(findPathSegment(grid, { x: 1, y: 5 }, { x: 5, y: 5 }, new Set()).path).toEqual([])
    expect(hasLineOfSight(grid, { x: 1, y: 5 }, { x: 5, y: 5 })).toBe(true)
  })

  test('a ladder climbs over the wall it is bolted to', () => {
    const grid = new Grid(10)
    grid.setLevel(5, 5, 1)
    grid.setWall(5, 5, Side.West, WallKind.Solid)
    grid.setLadderFace(5, 5, Side.West)

    // The wall still stands, and still refuses a walk along the ground.
    expect(grid.wallAt(5, 5, Side.West)).toBe(WallKind.Solid)
    expect(grid.canTraverse({ x: 4, y: 4 }, { x: 5, y: 4 })).toBe(true)
    // The climb goes over it, onto the floor at that wall's top.
    expect(grid.canTraverse({ x: 4, y: 5 }, { x: 5, y: 5 })).toBe(true)
  })

  test('generated buildings have rooms rather than solid footprints', () => {
    for (const seed of [1, 42, 1337]) {
      const { grid } = generateMap(seed)

      let walls = 0
      let enclosed = 0
      for (let edge = 0; edge < grid.edgeCount; edge++) {
        const { x, y, side } = grid.edgeTile(edge)
        if (grid.wallAt(x, y, side) !== WallKind.None) walls++
      }
      // A tile fenced on all four sides would be a room nobody can use.
      grid.forEach((x, y) => {
        const sealed = [Side.North, Side.East, Side.South, Side.West].every(
          (side) => grid.wallAt(x, y, side) !== WallKind.None,
        )
        if (sealed) enclosed++
      })

      expect(walls).toBeGreaterThan(0)
      expect(enclosed).toBe(0)
    }
  })
})

describe('Walls in the ECS', () => {
  test('every wall on the map becomes one entity', () => {
    const grid = new Grid(10)
    grid.setWall(3, 3, Side.North, WallKind.Solid)
    grid.setWall(6, 6, Side.East, WallKind.Glass)

    const world = new World()
    const walls = new WallSystem(grid)
    walls.spawnFromGrid(world)

    const ids = world.query([WallComponent])
    expect(ids.length).toBe(2)

    const kinds = ids
      .map((id) => world.getComponent(id, WallComponent)!.kind)
      .sort((a, b) => a - b)
    expect(kinds).toEqual([WallKind.Solid, WallKind.Glass].sort((a, b) => a - b))
  })

  test('shattering glazing opens the edge for both the component and the grid', () => {
    const grid = new Grid(10)
    grid.setWall(3, 3, Side.North, WallKind.Glass)

    const world = new World()
    const walls = new WallSystem(grid)
    walls.spawnFromGrid(world)

    const edge = grid.edgeId(3, 3, Side.North)
    let notified = 0
    walls.onWallsChanged = () => notified++

    expect(grid.canTraverse({ x: 3, y: 3 }, { x: 3, y: 2 })).toBe(false)
    walls.setKind(world, edge, WallKind.None)

    expect(notified).toBe(1)
    expect(grid.wallAt(3, 3, Side.North)).toBe(WallKind.None)
    expect(grid.canTraverse({ x: 3, y: 3 }, { x: 3, y: 2 })).toBe(true)
    expect(world.getComponent(walls.entityAt(edge)!, WallComponent)!.kind).toBe(WallKind.None)
  })

  test('a wall change arriving from a peer reaches the grid', () => {
    const grid = new Grid(10)
    grid.setWall(3, 3, Side.North, WallKind.Solid)
    const world = new World()
    const walls = new WallSystem(grid)
    world.addSystem(walls)
    walls.spawnFromGrid(world)

    const edge = grid.edgeId(3, 3, Side.North)
    const entityId = walls.entityAt(edge)!

    // What NetworkManager does with an inbound component frame.
    world.applyRemote(entityId, WallComponent.componentName, { edge, kind: WallKind.None })
    // The grid is an index over the components, so it catches up on tick.
    expect(grid.wallAt(3, 3, Side.North)).toBe(WallKind.Solid)
    world.update(0)
    expect(grid.wallAt(3, 3, Side.North)).toBe(WallKind.None)
  })

  test('a wall mutation is broadcast like any other component', () => {
    const grid = new Grid(10)
    grid.setWall(3, 3, Side.North, WallKind.Glass)

    const world = new World()
    const walls = new WallSystem(grid)
    walls.spawnFromGrid(world)

    const seen: Array<{ name: string; data: Record<string, unknown> }> = []
    world.onComponentChanged((_id, name, data) => seen.push({ name, data }))

    walls.setKind(world, grid.edgeId(3, 3, Side.North), WallKind.None)
    world.syncDirty()

    const wallFrames = seen.filter((f) => f.name === WallComponent.componentName)
    expect(wallFrames.length).toBe(1)
    expect(wallFrames[0]!.data.kind).toBe(WallKind.None)
  })
})
