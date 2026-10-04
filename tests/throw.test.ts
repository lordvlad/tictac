import { describe, expect, test } from 'bun:test'
import { Grid, Side } from '../src/core/Grid'
import { WallKind } from '../src/core/Walls'
import { flyThrow, heightAt, scatterAim, throwsLow } from '../src/core/Throw'
import type { Tile } from '../src/core/Grid'
import { LEVEL_HEIGHT } from '../src/config'

/**
 * A one-storey building over x 12..16, y 8..12: walls all round, a roof slab
 * at storey one, and an open door in the middle of its west face.
 */
function building(): Grid {
  const grid = new Grid(30)
  for (let y = 8; y <= 12; y++) for (let x = 12; x <= 16; x++) grid.setRoof(x, y, 1)
  for (let i = 8; i <= 12; i++) {
    grid.setWall(12, i, Side.West, i === 10 ? WallKind.DoorOpen : WallKind.Solid)
    grid.setWall(16, i, Side.East, WallKind.Solid)
  }
  for (let i = 12; i <= 16; i++) {
    grid.setWall(i, 8, Side.North, WallKind.Solid)
    grid.setWall(i, 12, Side.South, WallKind.Solid)
  }
  return grid
}

/** A throw exactly as aimed at `at`, on the storey `level`, with ten tiles of reach. */
function fly(grid: Grid, from: Tile, at: Tile, level = 0) {
  const aim = { dx: at.x - from.x, dy: at.y - from.y }
  return flyThrow(grid, from, aim, 10, throwsLow(grid, from, { ...at, level }))
}

describe('A thrown grenade', () => {
  test('aimed into a room from across the street, goes in low through the door and lands on its floor', () => {
    const flight = fly(building(), { x: 8, y: 10 }, { x: 14, y: 10 })
    expect(flight.landed).toEqual({ x: 14, y: 10 })
    expect(flight.landedY).toBe(0)
  })

  test('aimed at the roof, is lobbed over the walls and comes down on it', () => {
    const flight = fly(building(), { x: 4, y: 9 }, { x: 14, y: 9 }, 1)
    expect(flight.landed.y).toBe(9)
    expect(flight.landed.x).toBeGreaterThanOrEqual(12)
    expect(flight.landedY).toBe(LEVEL_HEIGHT)
    // It came down early, where the arc met the roof, rather than flying on.
    expect(flight.length).toBeLessThan(10)
  })

  test('thrown at a wall from under the roof turns back off it and stays inside', () => {
    const flight = fly(building(), { x: 14, y: 9 }, { x: 18, y: 9 })
    expect(flight.track.length).toBe(3)
    expect(flight.track[1]!.x).toBe(17)
    expect(flight.landed).toEqual({ x: 15, y: 9 })
    expect(flight.landedY).toBe(0)
  })

  test('lobbed in under a roof, is held below it and cannot clear a wall up to the ceiling', () => {
    const grid = building()
    grid.setWall(13, 10, Side.East, WallKind.Solid)
    // Aimed at the roof, so lobbed — but from beside the door it goes in beneath it.
    const flight = fly(grid, { x: 11, y: 10 }, { x: 16, y: 10 }, 1)
    expect(flight.landed.x).toBeLessThanOrEqual(13)
    expect(flight.landedY).toBe(0)
    for (let s = 1; s <= flight.length; s += 0.25) expect(heightAt(flight, s)).toBeLessThanOrEqual(LEVEL_HEIGHT)
  })

  test('goes through a hole in a wall at the storey it is flying through', () => {
    const walled = () => {
      const grid = new Grid(30)
      grid.setWall(6, 5, Side.East, WallKind.Solid)
      return grid
    }
    expect(fly(walled(), { x: 5, y: 5 }, { x: 8, y: 5 }).landed.x).toBeLessThanOrEqual(6)
    const holed = walled()
    holed.setWallOpening(6, 5, Side.East, 0)
    expect(fly(holed, { x: 5, y: 5 }, { x: 8, y: 5 }).landed).toEqual({ x: 8, y: 5 })
  })

  test('a parapet is thrown over', () => {
    const grid = new Grid(30)
    grid.setWall(6, 5, Side.East, WallKind.Parapet)
    expect(fly(grid, { x: 5, y: 5 }, { x: 7, y: 5 }).landed).toEqual({ x: 7, y: 5 })
  })

  test('never leaves the map, however high it is thrown at the edge', () => {
    const grid = new Grid(30)
    const flight = fly(grid, { x: 22, y: 5 }, { x: 31, y: 5 })
    expect(grid.inBounds(flight.landed.x, flight.landed.y)).toBe(true)
  })

  test('breaks the glass it flies through, and only that', () => {
    const grid = new Grid(30)
    grid.setWall(10, 8, Side.North, WallKind.Glass)
    grid.setWall(11, 8, Side.North, WallKind.Glass)
    const flight = fly(grid, { x: 10, y: 3 }, { x: 10, y: 13 })
    expect(flight.panes).toEqual([grid.edgeId(10, 8, Side.North)])
  })
})

describe('A throw that strays', () => {
  // The same dice: the widest sideways miss, the full length.
  const dice = () => {
    const rolls = [1, 0.5]
    return () => rolls.shift()!
  }

  test('misses by less from a steadier hand', () => {
    const aim = { dx: 8, dy: 0 }
    const steady = scatterAim(aim, 0.4, dice())
    const shaky = scatterAim(aim, 1.2, dice())
    const off = (a: { dx: number; dy: number }) => Math.abs(a.dy)
    expect(off(steady)).toBeGreaterThan(0)
    expect(off(shaky)).toBeGreaterThan(off(steady) * 2)
  })

  test('a sideways miss does not also throw long', () => {
    const strayed = scatterAim({ dx: 8, dy: 0 }, 1, dice())
    expect(Math.sqrt(strayed.dx ** 2 + strayed.dy ** 2)).toBeCloseTo(8, 9)
  })

  test('a throw at the thrower’s own feet draws no dice', () => {
    let drawn = 0
    scatterAim({ dx: 0, dy: 0 }, 1, () => {
      drawn++
      return 0.5
    })
    expect(drawn).toBe(0)
  })
})
