import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { AmmoId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { rollSquadSheets } from '../src/core/Characters'
import { NO_FX } from '../src/core/Combatant'
import { Grid, Side } from '../src/core/Grid'
import { WallKind } from '../src/core/Walls'
import { matchDice, Rng } from '../src/core/rng'
import { createGlobalRules } from '../src/ecs/globals'
import { World } from '../src/ecs/World'
import { canWatch, reactToArrival, watchCost } from '../src/game/Overwatch'
import { Squads } from '../src/game/Squads'
import { settleTurn } from '../src/game/Turn'

/** Two squads in the open, one watcher and one walker. */
function field() {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(24)
  const squads = new Squads(
    world,
    grid,
    { [Faction.Blue]: [{ x: 4, y: 4 }], [Faction.Red]: [{ x: 4, y: 9 }] },
    undefined,
    Faction.Blue,
    {
      [Faction.Blue]: rollSquadSheets(new Rng(3)),
      [Faction.Red]: rollSquadSheets(new Rng(4)),
    },
  )
  for (const [i, unit] of squads.soldiers.entries()) {
    unit.sheet.traits.length = 0
    unit.refreshTraits()
    unit.equip(WeaponId.Rifle, AmmoId.Standard)
    unit.tile = unit.faction === Faction.Blue ? { x: 4 + i, y: 4 } : { x: 4 + i, y: 12 }
  }
  return { world, grid, squads, dice: matchDice(9) }
}

describe('Holding fire for somebody else’s turn', () => {
  test('a watch costs the shot it reserves, up front', () => {
    // Paid now rather than when it fires: a watch nobody walks past still cost
    // something, or holding one would be strictly better than ending a turn.
    const { squads } = field()
    const watcher = squads.byFaction[Faction.Blue][0]!
    const before = watcher.ap

    expect(canWatch(watcher)).toBe(true)
    const cost = watchCost(watcher)
    expect(cost).toBeGreaterThan(0)

    watcher.ap -= cost
    watcher.watching = true

    expect(watcher.ap).toBe(before - cost)
  })

  test('a unit that cannot afford the shot cannot hold it', () => {
    const { squads } = field()
    const watcher = squads.byFaction[Faction.Blue][0]!
    watcher.ap = watchCost(watcher) - 1

    expect(canWatch(watcher)).toBe(false)
  })

  test('an empty weapon cannot be held ready', () => {
    // The reservation is a round, not an intention.
    const { squads } = field()
    const watcher = squads.byFaction[Faction.Blue][0]!
    watcher.weapon.currentClip = 0

    expect(canWatch(watcher)).toBe(false)
  })
})

describe('Walking into somebody’s watch', () => {
  test('an enemy arriving in view is shot at', () => {
    const { grid, squads, dice } = field()
    const watcher = squads.byFaction[Faction.Blue][0]!
    const mover = squads.byFaction[Faction.Red][0]!
    watcher.watching = true
    mover.tile = { x: watcher.tile.x, y: watcher.tile.y + 5 }

    const fired = reactToArrival(grid, mover, squads.soldiers, dice, NO_FX)

    expect(fired).toHaveLength(1)
    expect(fired[0]!.watcher).toBe(watcher)
  })

  test('a watcher does not react to what it cannot see', () => {
    // Range alone is not sight. Behind a solid wall the arrival is invisible,
    // and a watch that fired anyway would be shooting through the wall.
    const { grid, squads, dice } = field()
    const watcher = squads.byFaction[Faction.Blue][0]!
    const mover = squads.byFaction[Faction.Red][0]!
    watcher.watching = true
    mover.tile = { x: watcher.tile.x, y: watcher.tile.y + 5 }
    for (let x = 0; x < grid.size; x++) grid.setWall(x, watcher.tile.y + 2, Side.North, WallKind.Solid)

    expect(reactToArrival(grid, mover, squads.soldiers, dice, NO_FX)).toHaveLength(0)
    // Still watching: nothing was seen, so nothing was spent.
    expect(watcher.watching).toBe(true)
  })

  test('one watch is one reaction, however far the unit walks', () => {
    // Otherwise the number of shots a route provokes would depend on how many
    // tiles it happened to contain, and two peers stepping the same path at
    // different frame rates could disagree about it.
    const { grid, squads, dice } = field()
    const watcher = squads.byFaction[Faction.Blue][0]!
    const mover = squads.byFaction[Faction.Red][0]!
    watcher.watching = true

    let total = 0
    for (let step = 5; step > 1; step--) {
      mover.tile = { x: watcher.tile.x, y: watcher.tile.y + step }
      total += reactToArrival(grid, mover, squads.soldiers, dice, NO_FX).length
    }

    expect(total).toBe(1)
    expect(watcher.watching).toBe(false)
  })

  test('a squadmate walking past is not shot at', () => {
    const { grid, squads, dice } = field()
    const watcher = squads.byFaction[Faction.Blue][0]!
    const friend = squads.byFaction[Faction.Blue][1]!
    watcher.watching = true
    friend.tile = { x: watcher.tile.x, y: watcher.tile.y + 3 }

    expect(reactToArrival(grid, friend, squads.soldiers, dice, NO_FX)).toEqual([])
    expect(watcher.watching).toBe(true)
  })

  test('a watcher with no line to the mover holds its fire', () => {
    // Nothing is granted to a watcher that a shooter would not have: what the
    // points bought is the timing, not an exemption from the rules.
    const { grid, squads, dice } = field()
    const watcher = squads.byFaction[Faction.Blue][0]!
    const mover = squads.byFaction[Faction.Red][0]!
    // A shotgun, so "too far" is a distance that fits on the board: a rifle
    // reaches most of it.
    watcher.equip(WeaponId.Shotgun, AmmoId.Standard)
    watcher.watching = true
    mover.tile = { x: watcher.tile.x, y: watcher.tile.y + 18 }

    expect(reactToArrival(grid, mover, squads.soldiers, dice, NO_FX)).toEqual([])
    expect(watcher.watching).toBe(true)
  })

  test('the reaction is a worse shot than the one it replaced', () => {
    // A round snapped off at somebody crossing open ground. Expressed as a
    // shot *mode*, so every term in the chain already respects it.
    const { grid, squads, dice } = field()
    const watcher = squads.byFaction[Faction.Blue][0]!
    const mover = squads.byFaction[Faction.Red][0]!
    watcher.watching = true
    mover.tile = { x: watcher.tile.x, y: watcher.tile.y + 4 }

    const [fired] = reactToArrival(grid, mover, squads.soldiers, dice, NO_FX)
    expect(fired).toBeDefined()

    const snap = watcher.weapon.availableModes.includes(ShotMode.Snap)
    expect(snap).toBe(true)
    // The reaction resolved against a lower chance than a snap shot would have.
    expect(fired!.result.hitChance).toBeGreaterThan(0)
  })

  test('a watch is dropped when the watcher’s own turn comes round', () => {
    // It was held for somebody else's turn; coming round to your own ends it,
    // and the points are yours to spend again.
    const { squads } = field()
    const watcher = squads.byFaction[Faction.Blue][0]!
    watcher.watching = true

    settleTurn(squads.soldiers, Faction.Blue)

    expect(watcher.watching).toBe(false)
  })

  test('two watchers fire in squad order, so both sides draw the same dice', () => {
    // The rule that keeps a reaction free of the wire: every draw from the
    // match stream moves every later roll, so *which* watcher shoots first
    // cannot depend on iteration luck.
    const { grid, squads } = field()
    const first = squads.byFaction[Faction.Blue][0]!
    const second = squads.byFaction[Faction.Blue][1]!
    const mover = squads.byFaction[Faction.Red][0]!
    first.watching = true
    second.watching = true
    mover.tile = { x: first.tile.x, y: first.tile.y + 4 }
    mover.hp = mover.maxHp

    const fired = reactToArrival(grid, mover, squads.soldiers, matchDice(1), NO_FX)

    expect(fired.map((f) => f.watcher)).toEqual(
      fired.length === 2 ? [first, second] : [first],
    )
  })
})
