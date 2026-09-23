import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { Grid, Side } from '../src/core/Grid'
import { WallKind } from '../src/core/Walls'
import { Intel } from '../src/sim/Intel'
import { headlessSoldier } from './support/soldier'

/**
 * The headless policy may only act on what its side has seen. These pin the
 * ways a side's picture of the enemy differs from the truth, since each is a
 * way the old omniscient policy was wrong.
 */
describe('what the policy knows about the other side', () => {
  // A wall along y = 5 splits the map: rows 0–4 on one side, 5+ on the other.
  const walled = () => {
    const grid = new Grid(16)
    for (let x = 0; x < grid.size; x++) grid.setWall(x, 5, Side.North, WallKind.Solid)
    return grid
  }

  test('an enemy nobody has seen is not a contact, however close', () => {
    const grid = walled()
    const scout = headlessSoldier({ tile: { x: 4, y: 4 } })
    const enemy = headlessSoldier({ faction: Faction.Red, tile: { x: 4, y: 5 } })
    const intel = new Intel(grid, [scout], [enemy])

    intel.observe()
    expect(intel.contacts).toEqual([])

    enemy.tile = { x: 4, y: 2 }
    intel.observe()
    expect(intel.contacts.map((contact) => contact.tile)).toEqual([{ x: 4, y: 2 }])
  })

  test('a contact stays where it was seen until that tile is looked at and found empty', () => {
    const grid = walled()
    // Seen through a doorway, then the view is lost when the scout steps away.
    grid.setWall(8, 5, Side.North, WallKind.None)
    const scout = headlessSoldier({ tile: { x: 8, y: 3 } })
    const enemy = headlessSoldier({ faction: Faction.Red, tile: { x: 8, y: 8 } })
    const intel = new Intel(grid, [scout], [enemy])
    intel.observe()
    expect(intel.contacts).toHaveLength(1)

    scout.tile = { x: 2, y: 3 }
    enemy.tile = { x: 12, y: 12 }
    intel.observe()
    expect(intel.contacts.map((contact) => contact.tile)).toEqual([{ x: 8, y: 8 }])

    scout.tile = { x: 8, y: 3 }
    intel.observe()
    expect(intel.contacts).toEqual([])
  })

  test('firing gives a position away through a wall; a quiet unit is still unseen', () => {
    const grid = walled()
    const scout = headlessSoldier({ tile: { x: 4, y: 2 } })
    const enemy = headlessSoldier({ faction: Faction.Red, tile: { x: 4, y: 9 } })
    const intel = new Intel(grid, [scout], [enemy])

    intel.observe()
    expect(intel.contacts).toEqual([])

    enemy.firedThisTurn = true
    intel.observe()
    expect(intel.contacts.map((contact) => contact.tile)).toEqual([{ x: 4, y: 9 }])
  })
})
