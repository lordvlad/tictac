import { describe, expect, test } from 'bun:test'
import { Faction, MORALE, SQUAD_SIZE } from '../src/config'
import { AmmoId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { characterSheet } from '../src/core/Characters'
import { NO_FOCUS, NO_FX } from '../src/core/Combatant'
import { Grid, Side } from '../src/core/Grid'
import { MoraleBreak } from '../src/core/Morale'
import { Rng, type Roll } from '../src/core/rng'
import { eyesOf, sees } from '../src/core/Visibility'
import { WallKind } from '../src/core/Walls'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { CombatSystem, ItemSystem, MovementSystem, TurnSystem, WallSystem } from '../src/ecs/systems'
import { type Command, type CommandOrigin, CommandSystem } from '../src/ecs/systems/CommandSystem'
import { Squads } from '../src/game/Squads'
import { TurnManager } from '../src/game/TurnManager'

/**
 * A small match with no scene, on dice the test chooses. Blue 0 and Red 0 are
 * placed by the test; everyone else is parked far apart in the bottom rows,
 * walled off, out of everybody's sight. Red rolls its morale when Blue hands
 * over, which is what {@link handOver} does.
 *
 * Constant dice make a roll's outcome a statement rather than luck: at 0.1
 * every roll under 10% fails and every one over succeeds, and a break's kind
 * is the first of the three (panic); 0.5 the second (frenzy); 0.9 the third
 * (freeze).
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
  const commands = new CommandSystem(world, squads, turnManager, movement, combat, new ItemSystem(), walls)
  for (const system of [commands, movement, combat, turns]) world.addSystem(system)
  const carried: Array<{ command: Command; origin: CommandOrigin }> = []
  commands.onApplied = (command, _result, origin) => carried.push({ command, origin })
  const settle = () => {
    for (let i = 0; i < 4000 && (commands.busy || commands.pending); i++) world.update(1 / 30)
  }
  const handOver = () => {
    commands.apply({ type: 'endTurn', faction: turns.activeFaction }, 'local')
    settle()
  }
  const blue = squads.byFaction[Faction.Blue][0]!
  const red = squads.byFaction[Faction.Red][0]!
  return { world, grid, squads, combat, commands, turns, blue, red, carried, settle, handOver }
}

const always = (value: number): Roll => () => value

describe('Stress', () => {
  test('a kill costs every one of the dead unit’s squadmates once, and pays the killer and theirs', () => {
    const { squads, combat, blue, red } = match(always(0.5))
    blue.tile = { x: 10, y: 10 }
    red.tile = { x: 10, y: 14 }
    red.hp = 1
    for (const unit of squads.soldiers) unit.morale = 50

    // A burst that lands every round: the first kills, and the rest land on
    // a body that is already dead — which is still one death.
    const result = combat.fireShot(blue, red, ShotMode.Burst, Array(10).fill(true))
    expect(result!.hits.filter((hit) => hit.killed).length).toBeGreaterThan(1)

    expect(red.isDead).toBe(true)
    for (const mate of squads.byFaction[Faction.Red].slice(1)) expect(mate.morale).toBe(50 - MORALE.mateDown)
    expect(blue.morale).toBe(50 + MORALE.kill)
    for (const mate of squads.byFaction[Faction.Blue].slice(1)) expect(mate.morale).toBe(50 + MORALE.enemyDown)
  })

  test('a wound costs the wounded in proportion to it, and rounds that go past shake the one shot at', () => {
    const wounded = match(always(0.5))
    wounded.blue.tile = { x: 10, y: 10 }
    wounded.red.tile = { x: 10, y: 14 }
    wounded.combat.fireShot(wounded.blue, wounded.red, ShotMode.Snap, [true])
    const lost = wounded.red.maxHp - wounded.red.hp
    expect(lost).toBeGreaterThan(0)
    expect(wounded.red.morale).toBe(MORALE.max - Math.round((lost * MORALE.wound) / wounded.red.maxHp))

    const missed = match(always(0.5))
    missed.blue.tile = { x: 10, y: 10 }
    missed.red.tile = { x: 10, y: 14 }
    missed.combat.fireShot(missed.blue, missed.red, ShotMode.Snap, [false])
    expect(missed.red.hp).toBe(missed.red.maxHp)
    expect(missed.red.morale).toBe(MORALE.max - MORALE.nearMiss)
  })
})

describe('Breaking is rolled, from morale', () => {
  test('nothing is rolled at steady; a unit short of it can break; at zero it always does', () => {
    // At 0 any roll with a chance above nothing succeeds; at 1, the worst roll
    // there is, only a certainty does.
    const atSteady = match(always(0))
    atSteady.red.morale = MORALE.steady
    atSteady.handOver()
    expect(atSteady.red.broken).toBeNull()

    const short = match(always(0))
    short.red.morale = MORALE.steady - 1
    short.handOver()
    expect(short.red.broken).not.toBeNull()

    const empty = match(always(1))
    empty.red.morale = 0
    empty.handOver()
    expect(empty.red.broken).not.toBeNull()
  })

  test('steadying is rolled with odds that rise each turn, not a fixed wait: one turn to four', () => {
    // The roll a unit has to beat on the nth of its turns after breaking is
    // 25n%, so a roll of 0.1 steadies on the first, 0.3 the second, 0.6 the
    // third — and on the fourth it is certain whatever the dice say, even the
    // worst roll there is.
    const rollsToSteady = (roll: number) => {
      const m = match(always(roll))
      m.red.morale = 80
      m.red.broken = MoraleBreak.Freeze
      let rolls = 0
      while (m.red.broken && rolls < 10) {
        m.handOver() // Red's turn: it rolls to steady
        rolls++
        if (m.red.broken) m.handOver() // and back to Blue
      }
      return rolls
    }
    expect([0.1, 0.3, 0.6, 1].map(rollsToSteady)).toEqual([1, 2, 3, 4])
  })
})

describe('A broken unit', () => {
  test('frozen, has no points and takes no orders from anybody', () => {
    const m = match(always(0.9))
    m.red.tile = { x: 10, y: 10 }
    m.red.morale = 0
    m.handOver()

    expect(m.red.broken).toBe(MoraleBreak.Freeze)
    expect(m.red.ap).toBe(0)
    // Turning costs nothing, so nothing but the break can be what refuses it.
    const order: Command = { type: 'rightClickFacing', faction: Faction.Red, squadIndex: 0, x: 0, z: 0 }
    expect(m.commands.apply(order, 'local').applied).toBe(false)
    expect(m.commands.apply(order, 'peer').applied).toBe(false)
    m.red.broken = null
    expect(m.commands.apply(order, 'local').applied).toBe(true)
  })

  test('panicking, runs out of sight of the enemy it saw, by itself, and ends its turn', () => {
    // A wall to the west to hide behind: the enemy at (10,16) cannot see past it.
    const m = match(always(0.1), (grid) => {
      for (let y = 4; y <= 18; y++) grid.setWall(6, y, Side.West, WallKind.Solid)
    })
    m.red.tile = { x: 10, y: 10 }
    m.blue.tile = { x: 10, y: 16 }
    m.red.morale = 0
    expect(sees(m.grid, m.blue.tile, eyesOf(m.grid, m.blue), m.red.tile)).toBe(true)
    m.handOver()

    expect(m.red.broken).toBe(MoraleBreak.Panic)
    expect(sees(m.grid, m.blue.tile, eyesOf(m.grid, m.blue), m.red.tile)).toBe(false)
    expect(m.red.ap).toBe(0)
    // The rules moved it: nothing on the wire or in a file asked.
    const moves = m.carried.filter(({ command }) => command.type === 'moveUnit')
    expect(moves.length).toBeGreaterThan(0)
    expect(moves.every(({ origin }) => origin === 'rules')).toBe(true)
  })

  test('in a frenzy, charges the nearest enemy its side can see and strikes it', () => {
    const m = match(always(0.5))
    m.red.tile = { x: 10, y: 10 }
    m.blue.tile = { x: 10, y: 16 }
    m.red.morale = 0
    m.handOver()

    expect(m.red.broken).toBe(MoraleBreak.Frenzy)
    expect(Math.max(Math.abs(m.red.tile.x - m.blue.tile.x), Math.abs(m.red.tile.y - m.blue.tile.y))).toBe(1)
    const blows = m.carried.filter(({ command }) => command.type === 'meleeAttack')
    expect(blows.length).toBeGreaterThan(0)
    expect(blows.every(({ origin }) => origin === 'rules')).toBe(true)
  })

  test('is run before the player gets the turn: an order given meanwhile is refused', () => {
    const m = match(always(0.1))
    m.red.tile = { x: 10, y: 10 }
    m.blue.tile = { x: 10, y: 16 }
    m.red.morale = 0
    m.commands.apply({ type: 'endTurn', faction: Faction.Blue }, 'local')
    const mate: Command = { type: 'toggleCover', faction: Faction.Red, squadIndex: 1 }

    expect(m.commands.pending).toBe(true)
    expect(m.commands.apply(mate, 'local').applied).toBe(false)
    m.settle()
    expect(m.commands.apply(mate, 'local').applied).toBe(true)
  })
})
