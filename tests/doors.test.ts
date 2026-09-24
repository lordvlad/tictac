import { describe, expect, test } from 'bun:test'
import { CHARACTER, DOORS, Faction, RULES, SQUAD_SIZE } from '../src/config'
import { AmmoId, WeaponId } from '../src/core/Arsenal'
import { characterSheet } from '../src/core/Characters'
import { NO_FOCUS, NO_FX } from '../src/core/Combatant'
import { Grid, Side } from '../src/core/Grid'
import { ItemId } from '../src/core/Items'
import { generateMap } from '../src/core/MapGenerator'
import type { Noise } from '../src/core/Noise'
import { Rng, type Roll } from '../src/core/rng'
import { hasLineOfSight } from '../src/core/Visibility'
import { WallKind } from '../src/core/Walls'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { CombatSystem, GroundSystem, ItemSystem, MovementSystem, TurnSystem, WallSystem } from '../src/ecs/systems'
import { type Command, CommandSystem } from '../src/ecs/systems/CommandSystem'
import { Squads } from '../src/game/Squads'
import { TurnManager } from '../src/game/TurnManager'

const always = (value: number): Roll => () => value

/**
 * A small match with no scene, on dice the test chooses, and walls the test
 * puts up before the wall entities are made. Everyone but Blue 0 and Red 0 is
 * parked in the bottom rows behind a wall.
 */
function match(roll: Roll, build: (grid: Grid) => void = () => {}) {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(40)
  for (let x = 0; x < grid.size; x++) grid.setWall(x, 35, Side.North, WallKind.Solid)
  build(grid)
  const parked = (x0: number) => Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: x0 + i * 2, y: 38 }))
  const sheet = () => ({ ...characterSheet(new Rng(4)), traits: [] })
  const squads = new Squads(world, grid, { [Faction.Blue]: parked(1), [Faction.Red]: parked(30) }, undefined, Faction.Blue, {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, sheet),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, sheet),
  })
  for (const unit of squads.soldiers) unit.equip(WeaponId.Rifle, AmmoId.Standard)
  const movement = new MovementSystem(grid)
  const combat = new CombatSystem(grid, squads, NO_FX, roll)
  const turns = new TurnSystem()
  const turnManager = new TurnManager(world, turns, squads, NO_FOCUS)
  const walls = new WallSystem(grid)
  walls.spawnFromGrid(world)
  const ground = new GroundSystem(grid)
  ground.spawn(world)
  const commands = new CommandSystem(world, squads, turnManager, movement, combat, new ItemSystem(), walls, ground)
  for (const system of [commands, movement, combat, turns]) world.addSystem(system)
  const settle = () => {
    for (let i = 0; i < 4000 && (commands.busy || commands.pending); i++) world.update(1 / 30)
  }
  const blue = squads.byFaction[Faction.Blue][0]!
  const red = squads.byFaction[Faction.Red][0]!
  return { world, grid, walls, commands, blue, red, settle }
}

/** A door on the north side of (10, 10): between (10, 10) and (10, 9). */
const door = (kind: WallKind) => (grid: Grid) => grid.setWall(10, 10, Side.North, kind)

describe('A shut door', () => {
  test('is a wall to the eye, and a door to the feet: walking through opens it, for a point more', () => {
    const m = match(always(0.99), door(WallKind.Door))
    m.blue.tile = { x: 10, y: 10 }
    m.red.tile = { x: 10, y: 6 }
    expect(hasLineOfSight(m.grid, m.blue.tile, m.red.tile)).toBe(false)
    const ap = m.blue.ap

    m.commands.apply({ type: 'moveUnit', faction: Faction.Blue, squadIndex: 0, path: [{ x: 10, y: 10 }, { x: 10, y: 9 }] }, 'local')
    m.settle()

    expect(m.blue.tile).toEqual({ x: 10, y: 9 })
    expect(ap - m.blue.ap).toBe(RULES.stepOrthogonal + DOORS.openAp)
    expect(m.grid.wallAt(10, 10, Side.North)).toBe(WallKind.DoorOpen)
    expect(hasLineOfSight(m.grid, { x: 10, y: 10 }, m.red.tile)).toBe(true)
  })

  test('is shut again from either side, for a point, and only by a unit standing at it', () => {
    const m = match(always(0.99), door(WallKind.DoorOpen))
    const edge = m.grid.edgeId(10, 10, Side.North)
    const shut: Command = { type: 'operateDoor', faction: Faction.Blue, squadIndex: 0, edge, verb: 'close' }

    m.blue.tile = { x: 10, y: 8 }
    expect(m.commands.apply(shut, 'local').applied).toBe(false)

    m.blue.tile = { x: 10, y: 9 }
    const ap = m.blue.ap
    expect(m.commands.apply(shut, 'local').applied).toBe(true)
    expect(ap - m.blue.ap).toBe(DOORS.closeAp)
    expect(m.grid.wallAt(10, 10, Side.North)).toBe(WallKind.Door)
    expect(hasLineOfSight(m.grid, { x: 10, y: 9 }, { x: 10, y: 12 })).toBe(false)
    // Shut is shut: there is nothing left to close.
    expect(m.commands.apply(shut, 'local').applied).toBe(false)
  })
})

describe('A locked door', () => {
  test('cannot be walked through, and opens to the keys, which are not used up', () => {
    const m = match(always(0.99), door(WallKind.Locked))
    const edge = m.grid.edgeId(10, 10, Side.North)
    const unlock: Command = { type: 'operateDoor', faction: Faction.Blue, squadIndex: 0, edge, verb: 'unlock' }
    m.blue.tile = { x: 10, y: 10 }
    expect(m.grid.canTraverse({ x: 10, y: 10 }, { x: 10, y: 9 })).toBe(false)

    expect(m.commands.apply(unlock, 'local').applied).toBe(false)
    m.blue.items[ItemId.Keys] = 1
    expect(m.commands.apply(unlock, 'local').applied).toBe(true)

    expect(m.grid.wallAt(10, 10, Side.North)).toBe(WallKind.DoorOpen)
    expect(m.blue.items[ItemId.Keys]).toBe(1)
    expect(m.grid.canTraverse({ x: 10, y: 10 }, { x: 10, y: 9 })).toBe(true)
  })

  test('gives to a shoulder at the odds Strength sets, from the dice, and is heard either way', () => {
    // At the bottom of the Strength scale the odds are the band's floor, so a
    // roll just under it gives and a roll at it does not.
    const odds = CHARACTER.shoulder.min / 100
    const shoulder = (roll: number) => {
      const m = match(always(roll), door(WallKind.Locked))
      m.blue.adoptSheet({ ...m.blue.sheet, attributes: { ...m.blue.sheet.attributes, strength: CHARACTER.attribute.min } })
      m.blue.tile = { x: 10, y: 10 }
      m.red.tile = { x: 10, y: 4 }
      const heard: Noise[] = []
      m.commands.onNoise = (noise) => heard.push(noise)
      const ap = m.blue.ap
      const edge = m.grid.edgeId(10, 10, Side.North)
      const applied = m.commands.apply({ type: 'operateDoor', faction: Faction.Blue, squadIndex: 0, edge, verb: 'force' }, 'local').applied
      return { applied, kind: m.grid.wallAt(10, 10, Side.North), spent: ap - m.blue.ap, heard: heard.length }
    }

    const gave = shoulder(odds - 0.01)
    const held = shoulder(odds)
    expect(gave).toEqual({ applied: true, kind: WallKind.None, spent: DOORS.forceAp, heard: 1 })
    expect(held).toEqual({ applied: true, kind: WallKind.Locked, spent: DOORS.forceAp, heard: 1 })
  })
})

describe('Doors are state both peers hold', () => {
  test('the same commands, applied again from the record, leave the same doors', () => {
    const lay = (grid: Grid) => {
      grid.setWall(10, 10, Side.North, WallKind.Door)
      grid.setWall(10, 10, Side.East, WallKind.Locked)
      grid.setWall(10, 10, Side.West, WallKind.Locked)
    }
    const here = match(always(0.1), lay)
    const there = match(always(0.1), lay)
    for (const m of [here, there]) {
      m.blue.tile = { x: 10, y: 10 }
      m.blue.items[ItemId.Keys] = 1
    }
    const edge = (side: Side) => here.grid.edgeId(10, 10, side)
    const script: Command[] = [
      { type: 'operateDoor', faction: Faction.Blue, squadIndex: 0, edge: edge(Side.East), verb: 'unlock' },
      { type: 'operateDoor', faction: Faction.Blue, squadIndex: 0, edge: edge(Side.West), verb: 'force' },
      { type: 'moveUnit', faction: Faction.Blue, squadIndex: 0, path: [{ x: 10, y: 10 }, { x: 10, y: 9 }] },
    ]
    for (const command of script) {
      expect(here.commands.apply(command, 'local').applied).toBe(true)
      here.settle()
      expect(there.commands.apply(command, 'record').applied).toBe(true)
      there.settle()
    }

    expect([...there.walls.kinds(there.world)]).toEqual([...here.walls.kinds(here.world)])
    expect([here.grid.wallAt(10, 10, Side.North), here.grid.wallAt(10, 10, Side.East), here.grid.wallAt(10, 10, Side.West)]).toEqual([
      WallKind.DoorOpen,
      WallKind.DoorOpen,
      WallKind.None,
    ])
  })
})

describe('The map hangs doors', () => {
  test('only in doorways between two floors a unit can stand on, at one height', () => {
    let doors = 0
    for (const seed of [1, 7, 1000, 5000, 9000]) {
      const { grid } = generateMap(seed)
      grid.forEachWall((x, y, side, kind) => {
        if (kind !== WallKind.Door) return
        doors++
        const beyond = side === Side.West ? { x: x - 1, y } : { x, y: y - 1 }
        expect(grid.isWalkable(x, y) && grid.isWalkable(beyond.x, beyond.y)).toBe(true)
        expect(grid.levelAt(x, y)).toBe(grid.levelAt(beyond.x, beyond.y))
      })
    }
    expect(doors).toBeGreaterThan(0)
  })
})
