import { describe, expect, test } from 'bun:test'
import { Faction, FIRE, SQUAD_SIZE } from '../src/config'
import { AmmoId, GRENADES, GrenadeId, WeaponId } from '../src/core/Arsenal'
import { characterSheet } from '../src/core/Characters'
import { NO_FOCUS, NO_FX } from '../src/core/Combatant'
import { burn, kindle } from '../src/core/Fire'
import { Block, Grid, Side } from '../src/core/Grid'
import { Rng, type Roll } from '../src/core/rng'
import { Surface } from '../src/core/Surfaces'
import { WallKind } from '../src/core/Walls'
import { hasLineOfSight } from '../src/core/Visibility'
import { World } from '../src/ecs/World'
import { GroundComponent } from '../src/ecs/components'
import { createGlobalRules } from '../src/ecs/globals'
import { CombatSystem, GroundSystem, ItemSystem, MovementSystem, TurnSystem, WallSystem } from '../src/ecs/systems'
import { CommandSystem } from '../src/ecs/systems/CommandSystem'
import { Squads } from '../src/game/Squads'
import { TurnManager } from '../src/game/TurnManager'

const always = (value: number): Roll => () => value

/**
 * A small match with no scene, on dice the test chooses, and ground the test
 * lays before anything reads it. Everyone but Blue 0 and Red 0 is parked in
 * the bottom rows behind a wall.
 */
function match(roll: Roll, lay: (grid: Grid) => void = () => {}) {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(40)
  for (let x = 0; x < grid.size; x++) grid.setWall(x, 35, Side.North, WallKind.Solid)
  lay(grid)
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
  const handOver = () => {
    commands.apply({ type: 'endTurn', faction: turns.activeFaction }, 'local')
    settle()
  }
  return { world, grid, ground, commands, squads, blue: squads.byFaction[Faction.Blue][0]!, red: squads.byFaction[Faction.Red][0]!, settle, handOver }
}

describe('Fire spreads by what the ground is made of', () => {
  test('it catches on what burns, and not on paving, not on ash, and not through a wall', () => {
    // At dice 0 every chance above nothing succeeds, so only the ground decides.
    const m = match(always(0), (grid) => {
      grid.setSurface(10, 10, Surface.Timber)
      grid.setSurface(11, 10, Surface.Timber) // east: catches
      grid.setSurface(10, 11, Surface.Grass) // south: catches
      grid.setSurface(9, 10, Surface.Paving) // west: does not burn
      grid.setSurface(10, 9, Surface.Timber) // north: timber, but walled off
      grid.setWall(10, 10, Side.North, WallKind.Solid)
    })
    m.ground.setFire(m.grid.index(10, 10), 3)

    const { caught } = burn(m.ground, always(0))

    expect(caught.map((i) => ({ x: i % m.grid.size, y: (i / m.grid.size) | 0 }))).toEqual([
      { x: 11, y: 10 },
      { x: 10, y: 11 },
    ])
  })

  test('it catches at the tile’s own odds: grass before timber', () => {
    // A roll of 0.5 beats timber's 35% but not grass's 60%.
    const m = match(always(0.5), (grid) => {
      grid.setSurface(11, 10, Surface.Timber)
      grid.setSurface(9, 10, Surface.Grass)
    })
    m.ground.setFire(m.grid.index(10, 10), 2)

    const { caught } = burn(m.ground, always(0.5))

    expect(caught).toEqual([m.grid.index(9, 10)])
  })

  test('what burned out is ash, and a crate that burned out is gone — and with it, its cover', () => {
    const m = match(always(0.99), (grid) => {
      grid.setSurface(10, 10, Surface.Timber)
      grid.setBlock(10, 10, Block.Half)
    })
    const index = m.grid.index(10, 10)
    m.ground.setFire(index, 1)

    burn(m.ground, always(0.99))

    expect(m.grid.fireAt(10, 10)).toBe(0)
    expect(m.grid.surfaceAt(10, 10)).toBe(Surface.Ash)
    expect(m.grid.blockAt(10, 10)).toBe(Block.None)
    // Ash never burns again, whatever is burning beside it.
    m.ground.setFire(m.grid.index(11, 10), 2)
    expect(burn(m.ground, always(0)).caught).not.toContain(index)
  })
})

describe('Fire hurts whoever is in it', () => {
  test('an incendiary sets its blast alight, and burns whoever is standing in it, armour or not', () => {
    const m = match(always(0.99))
    m.blue.tile = { x: 10, y: 10 }
    m.blue.grenades[GrenadeId.Incendiary] = 1
    m.red.tile = { x: 10, y: 15 }
    const before = { hp: m.red.hp, armor: m.red.armor }
    expect(before.armor).toBeGreaterThan(0)

    const thrown = m.commands.apply(
      { type: 'throwGrenade', shooterFaction: Faction.Blue, shooterIndex: 0, kind: GrenadeId.Incendiary, targetTile: { x: 10, y: 15 } },
      'local',
    )

    expect(thrown.applied).toBe(true)
    expect([m.grid.fireAt(10, 15), m.grid.fireAt(11, 15), m.grid.fireAt(10, 16)].every((t) => t > 0)).toBe(true)
    expect(m.red.hp).toBe(before.hp - FIRE.damage)
    expect(m.red.armor).toBe(before.armor)
  })

  test('walking into fire costs the step, and so does starting a turn in it', () => {
    const m = match(always(0.99))
    m.blue.tile = { x: 10, y: 10 }
    m.ground.setFire(m.grid.index(10, 11), 3)
    const full = m.blue.hp

    m.commands.apply({ type: 'moveUnit', faction: Faction.Blue, squadIndex: 0, path: [{ x: 10, y: 10 }, { x: 10, y: 11 }] }, 'local')
    m.settle()
    expect(m.blue.hp).toBe(full - FIRE.damage)

    m.handOver() // Red's turn: Blue is not the side starting a turn
    expect(m.blue.hp).toBe(full - FIRE.damage)
    m.handOver() // Blue's again, still standing in it
    expect(m.blue.hp).toBe(full - 2 * FIRE.damage)
  })
})

describe('Smoke', () => {
  test('sight does not pass through it, into it or out of it — except from the next tile', () => {
    const m = match(always(0.99))
    const seen = (from: { x: number; y: number }, to: { x: number; y: number }) => hasLineOfSight(m.grid, from, to)
    expect(seen({ x: 5, y: 10 }, { x: 15, y: 10 })).toBe(true)

    m.ground.setSmoke(m.grid.index(10, 10), 2)
    expect(seen({ x: 5, y: 10 }, { x: 15, y: 10 })).toBe(false) // through it
    expect(seen({ x: 5, y: 10 }, { x: 10, y: 10 })).toBe(false) // into it
    expect(seen({ x: 10, y: 10 }, { x: 5, y: 10 })).toBe(false) // out of it
    expect(seen({ x: 9, y: 10 }, { x: 10, y: 10 })).toBe(true) // from beside it
    expect(seen({ x: 5, y: 11 }, { x: 15, y: 11 })).toBe(true) // past it
  })

  test('a smoke grenade fills its blast but not past a wall, and the cloud thins away', () => {
    const m = match(always(0.99), (grid) => grid.setWall(10, 12, Side.West, WallKind.Glass))
    m.blue.tile = { x: 10, y: 5 }
    m.blue.grenades[GrenadeId.Smoke] = 1
    const turns = GRENADES[GrenadeId.Smoke].smokes

    m.commands.apply(
      { type: 'throwGrenade', shooterFaction: Faction.Blue, shooterIndex: 0, kind: GrenadeId.Smoke, targetTile: { x: 10, y: 12 } },
      'local',
    )

    expect([m.grid.smokeAt(10, 12), m.grid.smokeAt(12, 12), m.grid.smokeAt(10, 14)]).toEqual([turns, turns, turns])
    // Beyond the glass to the west: smoke keeps out of a room as sight does not.
    expect(m.grid.smokeAt(9, 12)).toBe(0)
    for (let i = 0; i < turns - 1; i++) m.handOver()
    expect(m.grid.smokeAt(10, 12)).toBe(1)
    m.handOver()
    expect(m.grid.smokeAt(10, 12)).toBe(0)
  })

  test('a fire smokes while it burns and for a turn after', () => {
    const m = match(always(0.99))
    const index = m.grid.index(10, 10)
    kindle(m.ground, { x: 10, y: 10 }, 0, 1)
    expect(m.grid.smokeAt(10, 10)).toBeGreaterThan(0)

    burn(m.ground, always(0.99)) // burns out
    expect(m.grid.fire[index]).toBe(0)
    expect(m.grid.smokeAt(10, 10)).toBe(1)
    burn(m.ground, always(0.99))
    expect(m.grid.smokeAt(10, 10)).toBe(0)
  })
})

describe('The ground is state both peers hold', () => {
  test('a peer handed the ground component rebuilds the same ground', () => {
    const here = match(always(0), (grid) => {
      grid.setSurface(10, 10, Surface.Timber)
      grid.setBlock(10, 10, Block.Half)
      grid.setSurface(11, 10, Surface.Timber)
    })
    here.ground.setFire(here.grid.index(10, 10), 1)
    burn(here.ground, always(0))

    const there = match(always(0), (grid) => {
      grid.setSurface(10, 10, Surface.Timber)
      grid.setBlock(10, 10, Block.Half)
      grid.setSurface(11, 10, Surface.Timber)
    })
    const state = here.world.getComponent(here.ground.entity, GroundComponent)!.serialize()
    there.world.getComponent(there.ground.entity, GroundComponent)!.deserialize(state)
    there.ground.update(0, there.world)

    expect(Array.from(there.grid.fire)).toEqual(Array.from(here.grid.fire))
    expect(Array.from(there.grid.surfaces)).toEqual(Array.from(here.grid.surfaces))
    expect(Array.from(there.grid.blocks)).toEqual(Array.from(here.grid.blocks))
  })
})
