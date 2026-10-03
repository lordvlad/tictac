import { describe, expect, test } from 'bun:test'
import { Faction, GRID_SIZE, MORALE, RETREAT, SQUAD_SIZE } from '../src/config'
import { AmmoId, WeaponId } from '../src/core/Arsenal'
import { characterSheet } from '../src/core/Characters'
import { NO_FOCUS, NO_FX } from '../src/core/Combatant'
import { Grid, type Tile } from '../src/core/Grid'
import { generateMap } from '../src/core/MapGenerator'
import { onWayOut, retreatChance, rowsFromWayOut, wayOutRows } from '../src/core/Retreat'
import { Rng, type Roll } from '../src/core/rng'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { CombatSystem, GroundSystem, ItemSystem, MovementSystem, TurnSystem, WallSystem } from '../src/ecs/systems'
import { CommandSystem } from '../src/ecs/systems/CommandSystem'
import { carriedOut, settlement, winnerOf } from '../src/game/MatchEnd'
import { Squads } from '../src/game/Squads'
import { TurnManager } from '../src/game/TurnManager'
import { STOCK_PLAN } from '../src/sim/Balance'
import { SimMatch } from '../src/sim/SimMatch'
import { MatchHost } from '../src/sim/MatchHost'
import { replay } from '../src/sim/Replay'
import { stockSquads } from './support/squads'

const always = (value: number): Roll => () => value

/** An open field on the stock map size, on dice the test chooses, every unit where it says. */
function match(roll: Roll, blue: Tile[], red: Tile[]) {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(GRID_SIZE)
  const sheet = () => ({ ...characterSheet(new Rng(4)), traits: [] })
  const squads = new Squads(
    world,
    grid,
    { [Faction.Blue]: blue, [Faction.Red]: red },
    stockSquads({
      [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, sheet),
      [Faction.Red]: Array.from({ length: SQUAD_SIZE }, sheet),
    }),
  )
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
  return { grid, squads, commands, turnManager }
}

const row = (y: number, x0: number) => Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: x0 + i * 2, y }))

describe('A side’s way out', () => {
  test('is the rows it deployed in: every spawn of every map is on its own side’s way out', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { spawns, grid } = generateMap(seed)
      for (const faction of [Faction.Blue, Faction.Red]) {
        for (const tile of spawns[faction]) expect(onWayOut(faction, tile, grid.size)).toBe(true)
      }
    }
  })

  test('runs along the near edge for Blue and the far edge for Red, three rows deep', () => {
    expect(wayOutRows(Faction.Blue, 36)).toEqual({ first: 2, last: 4 })
    expect(wayOutRows(Faction.Red, 36)).toEqual({ first: 31, last: 33 })
    expect(rowsFromWayOut(Faction.Blue, { x: 9, y: 10 }, 36)).toBe(6)
    expect(rowsFromWayOut(Faction.Red, { x: 9, y: 10 }, 36)).toBe(21)
    expect(rowsFromWayOut(Faction.Red, { x: 9, y: 32 }, 36)).toBe(0)
  })
})

describe('The chance of getting away', () => {
  const leaver = (morale: number, hp: number) => ({ morale, hp, maxHp: 100 }) as Parameters<typeof retreatChance>[0][number]

  test('is near certain for a fresh, steady squad nobody can see', () => {
    expect(retreatChance([leaver(MORALE.max, 100)], 0)).toBe(RETREAT.max)
  })

  test('falls with nerve and health, and with every enemy watching', () => {
    const fresh = retreatChance([leaver(MORALE.max, 100)], 0)
    const shaken = retreatChance([leaver(30, 100)], 0)
    const hurt = retreatChance([leaver(MORALE.max, 30)], 0)
    expect(shaken).toBeLessThan(fresh)
    expect(hurt).toBeLessThan(fresh)
    const middling = retreatChance([leaver(50, 50)], 0)
    expect(middling).toBe(RETREAT.base)
    expect(retreatChance([leaver(50, 50)], 2)).toBe(RETREAT.base - 2 * RETREAT.perWatcher)
  })

  test('is never hopeless', () => {
    expect(retreatChance([leaver(0, 1)], 10)).toBe(RETREAT.min)
  })
})

describe('Retreating', () => {
  test('takes whoever is on the way out, leaves the rest behind dead, and ends the match', () => {
    // Blue 0 and 1 on Blue's way out, Blue 2 and 3 out in the field.
    const blue = [
      { x: 4, y: 3 },
      { x: 6, y: 3 },
      { x: 8, y: 12 },
      { x: 10, y: 12 },
    ]
    const m = match(always(0), blue, row(32, 4))
    const [stayer, , straggler] = m.squads.byFaction[Faction.Blue]
    stayer!.deeds.hits[WeaponId.Rifle] = 40

    const result = m.commands.apply({ type: 'retreat', faction: Faction.Blue }, 'local')

    expect(result.applied && result.retreat?.escaped).toBe(true)
    const side = m.squads.byFaction[Faction.Blue]
    expect(side.map((unit) => unit.withdrawn)).toEqual([true, true, false, false])
    expect(side.map((unit) => unit.isDead)).toEqual([false, false, true, true])
    expect(straggler!.hp).toBe(0)
    expect(winnerOf(m.squads)).toBe(Faction.Red)

    // The ones who got out come back, grown from what they did; nobody is
    // carried out; the left-behind are gone.
    expect(carriedOut(m.squads, Faction.Blue, m.grid, 1)).toBeNull()
    const fates = settlement(m.squads, Faction.Red, null)
    expect(fates[Faction.Blue].map((fate) => fate.kind)).toEqual(['survived', 'survived', 'died', 'died'])
    expect(fates[Faction.Red].every((fate) => fate.kind === 'survived')).toBe(true)
    const first = fates[Faction.Blue][0]!
    expect(first.kind === 'survived' && first.sheet.proficiency[WeaponId.Rifle]).toBeGreaterThan(
      stayer!.sheet.proficiency[WeaponId.Rifle],
    )
  })

  test('that fails ends the turn, and the match goes on', () => {
    const m = match(always(0.999), row(3, 4), row(32, 4))
    const result = m.commands.apply({ type: 'retreat', faction: Faction.Blue }, 'local')

    expect(result.applied && result.retreat?.escaped).toBe(false)
    expect(m.turnManager.activeFaction).toBe(Faction.Red)
    expect(m.squads.soldiers.some((unit) => unit.withdrawn || unit.isDead)).toBe(false)
    expect(winnerOf(m.squads)).toBeNull()
  })

  test('is harder under the enemy’s eyes: the roll is against the watched chance', () => {
    // Facing each other across the open field, well inside sight range.
    const m = match(always(0.5), row(3, 4), row(10, 4))
    const result = m.commands.apply({ type: 'retreat', faction: Faction.Blue }, 'local')
    expect(result.applied && result.retreat!.chance).toBeLessThan(RETREAT.max)
  })

  test('is refused with nobody on the way out, and out of turn', () => {
    const m = match(always(0), row(12, 4), row(32, 4))
    expect(m.commands.apply({ type: 'retreat', faction: Faction.Blue }, 'local').applied).toBe(false)
    expect(m.commands.apply({ type: 'retreat', faction: Faction.Red }, 'local').applied).toBe(false)
  })
})

describe('A recorded retreat', () => {
  test('replays to the same match, from its seed alone', () => {
    const { header } = new SimMatch({ seed: 11, blue: STOCK_PLAN, red: STOCK_PLAN, record: true }).recording!
    const live = new MatchHost(header)
    // Both squads begin on their own way out, so Blue can try at once.
    const applied = live.apply({ type: 'retreat', faction: Faction.Blue })
    expect(applied.applied).toBe(true)

    const refought = replay({
      header,
      events: [{ seq: 0, turn: 1, faction: Faction.Blue, command: { type: 'retreat', faction: Faction.Blue } }],
    })
    expect(refought.skipped).toEqual([])
    expect(refought.digest).toEqual(live.digest())
  })
})
