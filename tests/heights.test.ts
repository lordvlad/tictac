import { describe, expect, test } from 'bun:test'
import { Blocks } from '../src/render/Blocks'
import { generateMap } from '../src/core/MapGenerator'
import { Block, Grid, StairDirection } from '../src/core/Grid'
import { findChainedPath, findPathSegment } from '../src/core/Pathfinding'
import { Faction, RULES } from '../src/config'
import type { Tile } from '../src/core/Grid'
import { World } from '../src/ecs/World'
import { PositionComponent } from '../src/ecs/components/PositionComponent'
import { StanceComponent } from '../src/ecs/components/StanceComponent'
import { ActionPointsComponent } from '../src/ecs/components/ActionPointsComponent'
import { HealthComponent } from '../src/ecs/components/HealthComponent'
import { MovementSystem } from '../src/ecs/systems/MovementSystem'

describe('Level Heights, Stairs, and Ladders in ECS & Core Engine', () => {
  test('grid tile levels and world elevation', () => {
    const grid = new Grid(10)
    grid.setLevel(3, 3, 1) // Level 1 (2.0 m)

    expect(grid.levelAt(3, 3)).toBe(1)

    const worldPosGround = grid.tileToWorld({ x: 0, y: 0 })
    expect(worldPosGround.y).toBe(0)

    const worldPosUpper = grid.tileToWorld({ x: 3, y: 3 })
    expect(worldPosUpper.y).toBe(2.0)
  })

  test('stair 2-side access restriction', () => {
    const grid = new Grid(10)
    // Place a North-facing stair at (5, 5), lower level 0.
    // Lower entrance is (5, 4) at level 0, upper exit is (5, 6) at level 1.
    grid.setLevel(5, 4, 0)
    grid.setStair(5, 5, StairDirection.North, 0)
    grid.setLevel(5, 6, 1)

    // Valid entrance from lower (5, 4) -> (5, 5)
    expect(grid.canTraverse({ x: 5, y: 4 }, { x: 5, y: 5 })).toBe(true)
    // Valid exit to upper (5, 6) -> (5, 5)
    expect(grid.canTraverse({ x: 5, y: 6 }, { x: 5, y: 5 })).toBe(true)

    // Side access is FORBIDDEN
    expect(grid.canTraverse({ x: 4, y: 5 }, { x: 5, y: 5 })).toBe(false)
    expect(grid.canTraverse({ x: 6, y: 5 }, { x: 5, y: 5 })).toBe(false)

    // Diagonal access is FORBIDDEN
    expect(grid.canTraverse({ x: 4, y: 4 }, { x: 5, y: 5 })).toBe(false)
    expect(grid.canTraverse({ x: 6, y: 6 }, { x: 5, y: 5 })).toBe(false)
  })

  test('ladder climbing and AP costs', () => {
    const grid = new Grid(10)
    // Ladder at (3, 3) connecting level 0 at (3, 2) to level 1 at (3, 3)
    grid.setLevel(3, 2, 0)
    grid.setLadder(3, 3, 0)
    grid.setLevel(3, 3, 1)

    // Valid ladder climb
    expect(grid.canTraverse({ x: 3, y: 2 }, { x: 3, y: 3 })).toBe(true)
    expect(grid.getStepCost({ x: 3, y: 2 }, { x: 3, y: 3 })).toBe(RULES.ladderStepCost)
    expect(RULES.ladderStepCost).toBe(3)

    // Direct level jump without stair or ladder is FORBIDDEN
    grid.setLevel(8, 8, 0)
    grid.setLevel(8, 9, 1)
    expect(grid.canTraverse({ x: 8, y: 8 }, { x: 8, y: 9 })).toBe(false)
  })

  test('pathfinding traverses stairs and ladders across levels', () => {
    const grid = new Grid(10)
    // Level 0 at (2, 2), North-facing stair at (2, 3), Level 1 at (2, 4)
    grid.setLevel(2, 2, 0)
    grid.setStair(2, 3, StairDirection.North, 0)
    grid.setLevel(2, 4, 1)

    const res = findPathSegment(grid, { x: 2, y: 2 }, { x: 2, y: 4 }, new Set())
    expect(res.path.length).toBe(3)
    expect(res.path).toEqual([{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 2, y: 4 }])
  })
  test('pathfinding specifically picks up ladder route to reach an upper level', () => {
    const grid = new Grid(10)
    // Level 0 at (3, 2). Ladder at (3, 3). Level 1 at (3, 4).
    grid.setLevel(3, 2, 0)
    grid.setLadder(3, 3, 0)
    grid.setLevel(3, 4, 1)

    const res = findPathSegment(grid, { x: 3, y: 2 }, { x: 3, y: 4 }, new Set())
    expect(res.path.length).toBe(3)
    expect(res.path).toEqual([{ x: 3, y: 2 }, { x: 3, y: 3 }, { x: 3, y: 4 }])
    expect(res.cost).toBe(RULES.ladderStepCost * 2)
  })

  test('pathfinding routes around to valid stair entrance when approaching from side', () => {
    const grid = new Grid(10)
    // Stair at (5, 5) facing North (lower entrance (5, 4), upper exit (5, 6))
    grid.setLevel(4, 5, 0)
    grid.setStair(5, 5, StairDirection.North, 0)
    grid.setLevel(5, 6, 1)

    // Start at side (4, 5). Path cannot go directly (4, 5) -> (5, 5).
    // Must route (4, 5) -> (5, 4) -> (5, 5) -> (5, 6).
    const res = findPathSegment(grid, { x: 4, y: 5 }, { x: 5, y: 6 }, new Set())
    expect(res.path[0]).toEqual({ x: 4, y: 5 })
    expect(res.path[1]).toEqual({ x: 5, y: 4 })
    expect(res.path[2]).toEqual({ x: 5, y: 5 })
    expect(res.path[3]).toEqual({ x: 5, y: 6 })
  })

  test('MovementSystem advances unit across levels and charges correct ladder AP', () => {
    const grid = new Grid(10)
    grid.setLevel(3, 2, 0)
    grid.setLadder(3, 3, 0)
    grid.setLevel(3, 3, 1)

    const world = new World()
    const moveSystem = new MovementSystem(grid)
    world.addSystem(moveSystem)

    const entity = world.createEntity()
    world.addComponent(entity, new PositionComponent({ x: 3, y: 2 }, grid.tileToWorld({ x: 3, y: 2 }), 0, 0))
    world.addComponent(entity, new StanceComponent())
    world.addComponent(entity, new ActionPointsComponent(10, 10))
    world.addComponent(entity, new HealthComponent(100, 100))

    moveSystem.startMovement(world, entity, [{ x: 3, y: 2 }, { x: 3, y: 3 }])
    world.update(2.0)

    const pos = world.getComponent(entity, PositionComponent)
    const ap = world.getComponent(entity, ActionPointsComponent)

    expect(pos?.tile).toEqual({ x: 3, y: 3 })
    expect(pos?.level).toBe(1)
    expect(ap?.ap).toBe(7) // 10 - 3 ladder AP cost
  })

  test('MapGenerator builds multi-level maps with stairs, ladders, and upper levels', () => {
    const map = generateMap(42)
    let stairCount = 0
    let ladderCount = 0
    let upperLevelCount = 0

    map.grid.forEach((x, y, block) => {
      if (block === Block.Stair) stairCount++
      if (block === Block.Ladder) ladderCount++
      if (map.grid.levelAt(x, y) > 0) upperLevelCount++
    })

    expect(stairCount).toBeGreaterThan(0)
    expect(ladderCount).toBeGreaterThan(0)
    expect(upperLevelCount).toBeGreaterThan(0)
  })

  test('Blocks setLevelFilter applies transparency to upper level blocks', () => {
    const grid = new Grid(10)
    grid.setBlock(2, 2, Block.Full)
    grid.setLevel(2, 2, 0)

    grid.setBlock(4, 4, Block.Full)
    grid.setLevel(4, 4, 1)

    const blocks = new Blocks(grid)
    blocks.setLevelFilter(0) // Ground level active: level 1 blocks should be transparent

    const layers = (blocks as unknown as { layers: Array<{ fade: { array: Float32Array }; instances: Array<{ x: number; y: number; index: number }> }> }).layers
    expect(layers.length).toBeGreaterThan(0)

    let level0Opacity = 0
    let level1Opacity = 0
    for (const layer of layers) {
      for (const inst of layer.instances) {
        if (inst.x === 2 && inst.y === 2) level0Opacity = layer.fade.array[inst.index]!
        if (inst.x === 4 && inst.y === 4) level1Opacity = layer.fade.array[inst.index]!
      }
    }

    expect(level0Opacity).toBe(1.0)
    expect(level1Opacity).toBeCloseTo(0.15)
  })

  test('a generated upper storey is reachable from the ground', () => {
    // An elevated floor with no walkable link to the ground is why a proposed
    // route collapsed to just its target marker: A* found nothing to draw.
    for (const seed of [1, 42, 1337, 90210, 5150]) {
      const { grid, spawns } = generateMap(seed)

      const upper: Tile[] = []
      grid.forEach((x, y) => {
        if (grid.levelAt(x, y) === 1 && grid.isWalkable(x, y)) upper.push({ x, y })
      })
      if (upper.length === 0) continue

      const start = spawns[Faction.Blue][0]!
      const reached = upper.some(
        (tile) => findPathSegment(grid, start, tile, new Set()).path.length > 0,
      )
      expect(reached).toBe(true)
    }
  })
})
