import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, GRENADES, GrenadeId, WeaponId } from '../src/core/Arsenal'
import { AttachmentId } from '../src/core/Attachments'
import { characterSheet } from '../src/core/Characters'
import { NO_FOCUS, NO_FX } from '../src/core/Combatant'
import { Grid } from '../src/core/Grid'
import { type Ear, hears, NOISE, type Noise, roughly, shotLoudness, stepLoudness } from '../src/core/Noise'
import { matchDice, Rng } from '../src/core/rng'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { CombatSystem, ItemSystem, MovementSystem, TurnSystem, WallSystem } from '../src/ecs/systems'
import { CommandSystem } from '../src/ecs/systems/CommandSystem'
import { Squads } from '../src/game/Squads'
import { TurnManager } from '../src/game/TurnManager'
import type { Soldier } from '../src/entities/Soldier'

const ear = (x: number, y: number, hearing = 1): Ear => ({
  tile: { x, y },
  faction: Faction.Red,
  isDead: false,
  hearing,
})
const blue = (x: number, y: number, loudness: number): Noise => ({ at: { x, y }, loudness, faction: Faction.Blue })

describe('Who hears a noise', () => {
  test('an ordinary ear hears a standing step four metres off and not five', () => {
    const step = blue(0, 0, stepLoudness(false))
    expect(hears(ear(4, 0), step)).toBe(true)
    expect(hears(ear(5, 0), step)).toBe(false)
    // Two metres both ways is under three: heard.
    expect(hears(ear(2, 2), step)).toBe(true)
  })

  test('a crouched step beside a unit is heard by a sharp ear and missed by an ordinary one', () => {
    const step = blue(0, 0, stepLoudness(true))
    expect(hears(ear(1, 0, 1.25), step)).toBe(true)
    expect(hears(ear(1, 0, 0.8), step)).toBe(false)
    // Diagonal is further than a sharp ear reaches for a crouched step.
    expect(hears(ear(1, 1, 1.25), step)).toBe(false)
  })

  test('nobody listens for their own side', () => {
    const shot = blue(0, 0, 40)
    expect(hears({ ...ear(1, 0), faction: Faction.Blue }, shot)).toBe(false)
  })

  test('the dead hear nothing', () => {
    expect(hears({ ...ear(1, 0), isDead: true }, blue(0, 0, 40))).toBe(false)
  })

  test('a frag is heard across any map; a smoke canister only close by', () => {
    const frag = blue(0, 0, GRENADES[GrenadeId.Frag].loudness)
    const smoke = blue(0, 0, GRENADES[GrenadeId.Smoke].loudness)
    expect(hears(ear(71, 71, 0.8), frag)).toBe(true)
    expect(hears(ear(10, 0), smoke)).toBe(false)
    expect(hears(ear(10, 0), blue(0, 0, GRENADES[GrenadeId.Flash].loudness))).toBe(true)
  })

  test('hearing says roughly where, never exactly', () => {
    // Every tile of a block is reported as the block's middle.
    const reported = new Set<string>()
    for (let y = 3; y < 6; y++) for (let x = 6; x < 9; x++) reported.add(JSON.stringify(roughly({ x, y })))
    expect([...reported]).toEqual([JSON.stringify({ x: 7, y: 4 })])
  })
})

/** A small match with no scene: Blue 0 and Red 0 wherever a test puts them, the rest far away. */
function match() {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(24)
  const far = (y: number) => Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 1 + i * 2, y }))
  const sheet = (intelligence: number) => () => {
    const base = characterSheet(new Rng(4))
    return { ...base, traits: [], attributes: { ...base.attributes, intelligence } }
  }
  const squads = new Squads(world, grid, { [Faction.Blue]: far(1), [Faction.Red]: far(22) }, undefined, Faction.Blue, {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, sheet(5)),
    // The sharpest ears there are: if they miss a step, everybody does.
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, sheet(10)),
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
  const heard: { noise: Noise; by: Soldier[] }[] = []
  commands.onNoise = (noise, by) => heard.push({ noise, by })
  const walker = squads.byFaction[Faction.Blue][0]!
  const listener = squads.byFaction[Faction.Red][0]!
  const settle = () => {
    for (let i = 0; i < 500 && commands.busy; i++) world.update(1 / 30)
  }
  return { squads, commands, heard, walker, listener, settle }
}

describe('Noise in a match', () => {
  const walkPast = (crouched: boolean) => {
    const m = match()
    m.walker.tile = { x: 5, y: 10 }
    m.listener.tile = { x: 8, y: 12 }
    if (crouched) m.walker.enterCover()
    m.commands.apply(
      {
        type: 'moveUnit',
        faction: Faction.Blue,
        squadIndex: 0,
        path: [
          { x: 5, y: 10 },
          { x: 6, y: 10 },
          { x: 7, y: 10 },
          { x: 8, y: 10 },
        ],
      },
      'local',
    )
    m.settle()
    return m
  }

  test('a standing walk past a sentry is heard, a crouched one is not', () => {
    const standing = walkPast(false)
    expect(standing.heard.length).toBeGreaterThan(0)
    expect(standing.heard.every(({ by }) => by.includes(standing.listener))).toBe(true)

    const crouched = walkPast(true)
    expect(crouched.walker.tile).toEqual({ x: 8, y: 10 })
    expect(crouched.heard).toEqual([])
  })

  test('a suppressor takes most of a shot’s report off', () => {
    const m = match()
    const open = shotLoudness(m.walker)
    m.walker.fitAttachment(AttachmentId.Suppressor)
    expect(shotLoudness(m.walker)).toBe(open * NOISE.suppressed)
  })

  test('a shot is heard from where it was fired, by everyone in earshot of that', () => {
    const m = match()
    m.walker.tile = { x: 5, y: 5 }
    m.listener.tile = { x: 5, y: 9 }
    m.commands.apply(
      { type: 'fireShot', shooterFaction: Faction.Blue, shooterIndex: 0, targetFaction: Faction.Red, targetIndex: 0, mode: 'snap' },
      'local',
    )
    const shot = m.heard.find(({ noise }) => noise.loudness === shotLoudness(m.walker))
    expect(shot?.noise.at).toEqual({ x: 5, y: 5 })
    expect(shot?.by.map((u) => u.faction).every((f) => f === Faction.Red)).toBe(true)
  })
})
