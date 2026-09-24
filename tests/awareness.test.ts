import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { Awareness, CALM_AFTER, inFront } from '../src/core/Awareness'
import { characterSheet } from '../src/core/Characters'
import { NO_FOCUS, NO_FX } from '../src/core/Combatant'
import { fromBehind, HEADINGS } from '../src/core/Facing'
import { Grid, Side } from '../src/core/Grid'
import { matchDice, Rng } from '../src/core/rng'
import { WallKind } from '../src/core/Walls'
import { World } from '../src/ecs/World'
import { WallComponent } from '../src/ecs/components'
import { createGlobalRules } from '../src/ecs/globals'
import { CombatSystem, ItemSystem, MovementSystem, TurnSystem, WallSystem } from '../src/ecs/systems'
import { CommandSystem } from '../src/ecs/systems/CommandSystem'
import { Squads } from '../src/game/Squads'
import { TurnManager } from '../src/game/TurnManager'
import type { Tile } from '../src/core/Grid'

const heading = (dx: number, dy: number) => HEADINGS.findIndex(([x, y]) => x === dx && y === dy)
/**
 * A small match with no scene. Blue 0 is the intruder and Red 0 the sentry,
 * with ordinary ears unless `sharp`; everyone else stands far off behind a
 * wall, out of sight and earshot. `build` raises any walls a test needs
 * before they become entities.
 */
function match(sharp = false, build: (grid: Grid) => void = () => {}) {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(40)
  // Everyone else is parked in the bottom rows, walled off from the rest.
  for (let x = 0; x < grid.size; x++) grid.setWall(x, 35, Side.North, WallKind.Solid)
  build(grid)
  const far = (x0: number) => Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: x0 + i * 2, y: 38 }))
  const sheet = (intelligence: number) => () => {
    const base = characterSheet(new Rng(4))
    return { ...base, traits: [], attributes: { ...base.attributes, intelligence } }
  }
  const squads = new Squads(world, grid, { [Faction.Blue]: far(1), [Faction.Red]: far(20) }, undefined, Faction.Blue, {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, sheet(5)),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, sheet(sharp ? 10 : 5)),
  })
  for (const unit of squads.soldiers) unit.equip(WeaponId.Rifle, AmmoId.Standard)
  const movement = new MovementSystem(grid)
  const combat = new CombatSystem(grid, squads, NO_FX, matchDice(7))
  const turns = new TurnSystem()
  const turnManager = new TurnManager(world, turns, squads, NO_FOCUS)
  const walls = new WallSystem(grid)
  walls.spawnFromGrid(world)
  const commands = new CommandSystem(world, squads, turnManager, movement, combat, new ItemSystem(), walls)
  for (const system of [commands, movement, combat, turns]) world.addSystem(system)
  const intruder = squads.byFaction[Faction.Blue][0]!
  const sentry = squads.byFaction[Faction.Red][0]!
  const walk = (path: Tile[]) => {
    commands.apply({ type: 'moveUnit', faction: Faction.Blue, squadIndex: 0, path }, 'local')
    for (let i = 0; i < 2000 && commands.busy; i++) world.update(1 / 30)
  }
  return { world, grid, commands, intruder, sentry, walk }
}

/** A sentry at (10,10) facing north (+y), an intruder coming up behind it from the south. */
function approach(crouched: boolean) {
  const m = match()
  m.sentry.tile = { x: 10, y: 10 }
  m.sentry.heading = heading(0, 1)
  m.intruder.tile = { x: 10, y: 4 }
  if (crouched) m.intruder.enterCover()
  m.walk([4, 5, 6, 7, 8, 9].map((y) => ({ x: 10, y })))
  return m
}

describe('Sneaking up on a sentry', () => {
  test('a crouched approach reaches an unaware sentry’s back', () => {
    const { intruder, sentry } = approach(true)
    expect(intruder.tile).toEqual({ x: 10, y: 9 })
    expect(sentry.awareness).toBe(Awareness.Unaware)
    expect(fromBehind(sentry, intruder.tile)).toBe(true)
  })

  test('a standing one is heard, and the sentry turns to face it', () => {
    const { intruder, sentry } = approach(false)
    expect(sentry.awareness).not.toBe(Awareness.Unaware)
    expect(fromBehind(sentry, intruder.tile)).toBe(false)
  })

  test('a sharp ear hears the last crouched step beside it', () => {
    const m = match(true)
    m.sentry.tile = { x: 10, y: 10 }
    m.sentry.heading = heading(0, 1)
    m.intruder.tile = { x: 10, y: 7 }
    m.intruder.enterCover()
    m.walk([7, 8, 9].map((y) => ({ x: 10, y })))
    expect(fromBehind(m.sentry, m.intruder.tile)).toBe(false)
  })

  test('hearing turns a unit toward the noise, not toward whoever made it', () => {
    const m = match()
    m.sentry.tile = { x: 10, y: 10 }
    m.sentry.heading = heading(0, 1)
    // A frag lands off to the east, clear of the sentry; the thrower stands to
    // the west, level with its shoulder, where it does not see him.
    m.intruder.tile = { x: 6, y: 10 }
    m.intruder.grenades.frag = 1
    m.intruder.ap = 20
    m.commands.apply(
      { type: 'throwGrenade', shooterFaction: Faction.Blue, shooterIndex: 0, kind: 'frag', targetTile: { x: 15, y: 10 } },
      'local',
    )
    expect(m.sentry.awareness).toBe(Awareness.Alerted)
    expect(m.sentry.heading).toBe(heading(1, 0))
  })
})

describe('What a sentry notices', () => {
  test('on the other side’s turn, only what is in front of it', () => {
    const m = match()
    m.sentry.tile = { x: 10, y: 10 }
    m.sentry.heading = heading(0, 1)
    m.intruder.tile = { x: 10, y: 2 }
    m.intruder.enterCover()
    // Crouched along the sentry's back, at a distance it cannot hear.
    m.walk([2, 3, 4].map((y) => ({ x: 10, y })))
    expect(m.sentry.awareness).toBe(Awareness.Unaware)

    // Round in front of it, and it has seen.
    m.intruder.tile = { x: 13, y: 13 }
    m.walk([
      { x: 13, y: 13 },
      { x: 13, y: 14 },
    ])
    expect(m.sentry.awareness).toBe(Awareness.Engaged)
  })

  test('on its own turn, all round', () => {
    const m = match()
    m.sentry.tile = { x: 10, y: 10 }
    m.sentry.heading = heading(0, 1)
    m.intruder.tile = { x: 10, y: 4 }
    m.commands.apply({ type: 'endTurn', faction: Faction.Blue }, 'local')
    expect(m.sentry.awareness).toBe(Awareness.Engaged)
  })

  test('a watcher that is not in the fight does not react to what is behind it', () => {
    const m = match()
    m.sentry.tile = { x: 10, y: 10 }
    m.sentry.heading = heading(0, 1)
    m.sentry.watching = true
    m.intruder.tile = { x: 12, y: 4 }
    m.intruder.enterCover()
    m.walk([
      { x: 12, y: 4 },
      { x: 12, y: 5 },
    ])
    expect(m.sentry.watching).toBe(true)
    expect(m.sentry.awareness).toBe(Awareness.Unaware)

    // The same walk in front of an engaged watcher is shot at.
    const n = match()
    n.sentry.tile = { x: 10, y: 10 }
    n.sentry.heading = heading(0, 1)
    n.sentry.watching = true
    n.sentry.awareness = Awareness.Engaged
    n.intruder.tile = { x: 12, y: 4 }
    n.intruder.enterCover()
    n.walk([
      { x: 12, y: 4 },
      { x: 12, y: 5 },
    ])
    expect(n.sentry.watching).toBe(false)
  })
})

describe('Being in the fight', () => {
  test('being shot at engages, hit or miss; firing engages the shooter', () => {
    const m = match()
    m.sentry.tile = { x: 10, y: 10 }
    m.intruder.tile = { x: 10, y: 4 }
    m.commands.apply(
      { type: 'fireShot', shooterFaction: Faction.Blue, shooterIndex: 0, targetFaction: Faction.Red, targetIndex: 0, mode: ShotMode.Snap },
      'local',
    )
    expect(m.sentry.awareness).toBe(Awareness.Engaged)
    expect(m.intruder.awareness).toBe(Awareness.Engaged)
  })

  test('an alerted unit that hears nothing more settles back down', () => {
    const m = match()
    m.sentry.tile = { x: 10, y: 10 }
    m.sentry.heading = heading(0, 1)
    // A step behind a wall: heard, since walls do not muffle, but not seen.
    for (let x = 0; x < 40; x++) m.grid.setWall(x, 8, Side.North, WallKind.Solid)
    m.intruder.tile = { x: 10, y: 5 }
    m.walk([
      { x: 10, y: 5 },
      { x: 10, y: 6 },
    ])
    expect(m.sentry.awareness).toBe(Awareness.Alerted)
    for (let turn = 0; turn < CALM_AFTER; turn++) {
      m.commands.apply({ type: 'endTurn', faction: Faction.Blue }, 'local')
      m.commands.apply({ type: 'endTurn', faction: Faction.Red }, 'local')
    }
    expect(m.sentry.awareness).toBe(Awareness.Unaware)
  })
})

describe('A thrown stone', () => {
  test('alerts a sentry toward where it landed, and gives the thrower away to nobody', () => {
    const m = match()
    m.sentry.tile = { x: 10, y: 10 }
    m.sentry.heading = heading(0, 1)
    // Thrown from behind the sentry, landing off to its east.
    m.intruder.tile = { x: 10, y: 4 }
    const stones = m.intruder.grenades.stone
    m.commands.apply(
      { type: 'throwGrenade', shooterFaction: Faction.Blue, shooterIndex: 0, kind: 'stone', targetTile: { x: 16, y: 10 } },
      'local',
    )
    expect(m.intruder.grenades.stone).toBe(stones - 1)
    expect(m.sentry.awareness).toBe(Awareness.Alerted)
    expect(m.sentry.heading).toBe(heading(1, 0))
    // Turned away from the thrower, who stays unseen and unrevealed.
    expect(inFront(m.sentry, m.intruder.tile)).toBe(false)
    expect(m.intruder.firedThisTurn).toBe(false)
  })
})

describe('Glass', () => {
  // A pane between (10,7) and (10,8).
  const window = (grid: Grid) => grid.setWall(10, 8, Side.North, WallKind.Glass)
  const pane = (grid: Grid) => grid.edgeId(10, 8, Side.North)

  test('a shot through a window breaks it, in the replicated wall and the grid alike', () => {
    const m = match(false, window)
    m.intruder.tile = { x: 10, y: 5 }
    m.sentry.tile = { x: 10, y: 11 }
    m.commands.apply(
      { type: 'fireShot', shooterFaction: Faction.Blue, shooterIndex: 0, targetFaction: Faction.Red, targetIndex: 0, mode: ShotMode.Snap },
      'local',
    )
    expect(m.grid.wallBetween({ x: 10, y: 7 }, { x: 10, y: 8 })).toBe(WallKind.None)
    const wall = m.world
      .query([WallComponent])
      .map((id) => m.world.getComponent(id, WallComponent)!)
      .find((w) => w.edge === pane(m.grid))
    expect(wall?.kind).toBe(WallKind.None)
    // And the gap is walkable now.
    expect(m.grid.canTraverse({ x: 10, y: 7 }, { x: 10, y: 8 })).toBe(true)
  })

  test('breaking it is heard from the window, and a stone will do it', () => {
    // The thrower is screened from the sentry by a wall; the stone's line
    // runs down x = 10 through the window.
    const m = match(false, (grid) => {
      window(grid)
      for (let y = 0; y < 8; y++) grid.setWall(13, y, Side.East, WallKind.Solid)
    })
    // A sentry beyond the window, out of earshot of the stone's landing but not
    // of the pane.
    m.sentry.tile = { x: 18, y: 9 }
    m.sentry.heading = heading(1, 0)
    m.intruder.tile = { x: 10, y: 3 }
    m.commands.apply(
      { type: 'throwGrenade', shooterFaction: Faction.Blue, shooterIndex: 0, kind: 'stone', targetTile: { x: 10, y: 14 } },
      'local',
    )
    expect(m.grid.wallBetween({ x: 10, y: 7 }, { x: 10, y: 8 })).toBe(WallKind.None)
    expect(m.sentry.awareness).toBe(Awareness.Alerted)
    expect(m.sentry.heading).toBe(heading(-1, 0))
  })

  test('a throw that goes nowhere near a window breaks nothing', () => {
    const m = match(false, window)
    m.intruder.tile = { x: 3, y: 3 }
    m.commands.apply(
      { type: 'throwGrenade', shooterFaction: Faction.Blue, shooterIndex: 0, kind: 'stone', targetTile: { x: 3, y: 12 } },
      'local',
    )
    expect(m.grid.wallBetween({ x: 10, y: 7 }, { x: 10, y: 8 })).toBe(WallKind.Glass)
  })
})
