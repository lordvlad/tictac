import { describe, expect, test } from 'bun:test'
import { Scene } from 'three'
import { RULES } from '../src/config'
import { Grid, Side, type Tile } from '../src/core/Grid'
import { WallKind } from '../src/core/Walls'
import { MovementPlanner } from '../src/game/MovementPlanner'
import type { Soldier } from '../src/entities/Soldier'
import type { Squads } from '../src/game/Squads'
import type { EngineContext } from '../src/engine'
import { installCanvasStub } from './support/dom'

installCanvasStub()

/** Just enough of a soldier for the planner: where it is and what it can spend. */
function unit(tile: Tile, ap = 12): Soldier {
  return { tile, ap, isDead: false } as unknown as Soldier
}

function harness(soldiers: Soldier[]): { planner: MovementPlanner; moves: Tile[][] } {
  const grid = new Grid(12)
  const squads = { soldiers } as unknown as Squads
  const engine = { scene: new Scene() } as unknown as EngineContext
  const planner = new MovementPlanner(grid, squads, engine)
  const moves: Tile[][] = []
  planner.onMovementStarted = (_s, path) => moves.push(path)
  return { planner, moves }
}

describe('Movement never shares a tile', () => {
  test('a target on an occupied tile stops the route one tile short', () => {
    const mover = unit({ x: 1, y: 1 })
    const enemy = unit({ x: 5, y: 1 })
    const { planner } = harness([mover, enemy])

    planner.handleClick(mover, enemy.tile, false)
    const { path, valid } = planner.plan

    // The route ends beside the occupant, not on it.
    expect(path[path.length - 1]).toEqual({ x: 4, y: 1 })
    expect(path).not.toContainEqual(enemy.tile)
    expect(valid).toBe(true)
  })

  test('the tap is still accepted, so a second one confirms the short route', () => {
    const mover = unit({ x: 1, y: 1 })
    const enemy = unit({ x: 5, y: 1 })
    const { planner, moves } = harness([mover, enemy])

    // First tap names the target — the occupied tile, which the player may not
    // even know is occupied.
    expect(planner.handleClick(mover, enemy.tile, false)).toBe(false)
    // Second tap on the same tile confirms.
    expect(planner.handleClick(mover, enemy.tile, false)).toBe(true)

    expect(moves.length).toBe(1)
    expect(moves[0]![moves[0]!.length - 1]).toEqual({ x: 4, y: 1 })
    expect(moves[0]).not.toContainEqual(enemy.tile)
  })

  test('the trimmed route is exactly one step shorter than the blocked one', () => {
    const enemy = unit({ x: 5, y: 1 })
    const blocked = harness([unit({ x: 1, y: 1 }), enemy])
    blocked.planner.handleClick(unit({ x: 1, y: 1 }), enemy.tile, false)

    const clear = harness([unit({ x: 1, y: 1 })])
    clear.planner.handleClick(unit({ x: 1, y: 1 }), { x: 5, y: 1 }, false)

    expect(clear.planner.plan.path.length - blocked.planner.plan.path.length).toBe(1)
  })

  test('an occupant right next door leaves nothing to walk', () => {
    const mover = unit({ x: 1, y: 1 })
    const enemy = unit({ x: 2, y: 1 })
    const { planner, moves } = harness([mover, enemy])

    planner.handleClick(mover, enemy.tile, false)
    expect(planner.plan.valid).toBe(false)

    // And confirming it does nothing rather than stepping onto the occupant.
    planner.handleClick(mover, enemy.tile, false)
    expect(moves).toEqual([])
  })

  test('a free target is unaffected', () => {
    const mover = unit({ x: 1, y: 1 })
    const { planner } = harness([mover])

    planner.handleClick(mover, { x: 5, y: 1 }, false)
    const { path, valid } = planner.plan

    expect(path[path.length - 1]).toEqual({ x: 5, y: 1 })
    expect(path.length).toBe(5)
    expect(valid).toBe(true)
  })

  test('a route that only fits without its last step becomes affordable', () => {
    // Exactly enough AP to reach the tile before the occupant, not the
    // occupant's own tile. Trimming has to be reflected in affordability.
    const ap = 3 * RULES.stepOrthogonal
    const mover = unit({ x: 1, y: 1 }, ap)
    const enemy = unit({ x: 5, y: 1 })
    const { planner } = harness([mover, enemy])

    planner.handleClick(mover, enemy.tile, false)
    expect(planner.plan.valid).toBe(true)
    expect(planner.plan.path[planner.plan.path.length - 1]).toEqual({ x: 4, y: 1 })
  })

  test('an unreachable target yields no route at all', () => {
    const mover = unit({ x: 1, y: 1 })
    const { planner } = harness([mover])
    const grid = (planner as unknown as { grid: Grid }).grid

    // Seal a tile off completely.
    for (const side of [Side.North, Side.East, Side.South, Side.West]) {
      grid.setWall(6, 6, side, WallKind.Solid)
    }

    planner.handleClick(mover, { x: 6, y: 6 }, false)
    expect(planner.plan.path).toEqual([])
    expect(planner.plan.valid).toBe(false)
  })
})
