import { describe, expect, test } from 'bun:test'
import { CHARACTER, Faction, PROGRESSION, RULES, SQUAD_SIZE } from '../src/config'
import { AmmoId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { Awareness } from '../src/core/Awareness'
import { type CharacterSheet, characterSheet } from '../src/core/Characters'
import { NO_FOCUS, NO_FX } from '../src/core/Combatant'
import { Grid, Side } from '../src/core/Grid'
import { type Deeds, growthFrom, grown, noDeeds } from '../src/core/Progression'
import { Rng, type Roll } from '../src/core/rng'
import { WallKind } from '../src/core/Walls'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { CombatSystem, GroundSystem, ItemSystem, MovementSystem, TurnSystem, WallSystem } from '../src/ecs/systems'
import { CommandSystem } from '../src/ecs/systems/CommandSystem'
import { Squads } from '../src/game/Squads'
import { TurnManager } from '../src/game/TurnManager'
import { debrief, winnerOf } from '../src/game/MatchEnd'
import { endScreens } from '../src/hud/HudModel'

/** A sheet with every attribute and proficiency set where the test wants it. */
function sheet(attributes: Partial<CharacterSheet['attributes']> = {}): CharacterSheet {
  const base = characterSheet(new Rng(4))
  return {
    ...base,
    attributes: { health: 5, agility: 5, strength: 5, intelligence: 5, ...attributes },
    proficiency: { rifle: 0, shotgun: 0, sniper: 0, gatling: 0 },
    // Not a class any test lands rounds with, so no class gets a specialist's top.
    specialism: WeaponId.Gatling,
  }
}

const deeds = (partial: Partial<Deeds>): Deeds => ({ ...noDeeds(), ...partial })

/** Hits with the rifle, at a learning rate of exactly one. */
const rifleHits = (hits: number, crits = 0): Deeds =>
  deeds({ hits: { ...noDeeds().hits, rifle: hits }, crits: { ...noDeeds().crits, rifle: crits } })

describe('What a match teaches', () => {
  // Intelligence at the point of the scale where the learning rate is 1 would
  // make the arithmetic plain; the scale is integers, so the tests compare
  // against the same sheet with and without the deed instead.
  test('a weapon class grows by rounds landed with it, a critical counting double, up to the cap a match', () => {
    const at = sheet({ intelligence: CHARACTER.attribute.max })
    const points = (d: Deeds) => growthFrom(at, d).find((g) => g.kind === 'proficiency')?.to ?? 0

    // At the top of Intelligence every mark counts for more, so find the
    // fewest rounds that earn a point and check one fewer earns none.
    let fewest = 1
    while (points(rifleHits(fewest)) === 0) fewest++
    expect(points(rifleHits(fewest - 1))).toBe(0)
    expect(fewest).toBeLessThanOrEqual(PROGRESSION.hitsPerProficiency)
    // A critical is worth PROGRESSION.critHits rounds.
    expect(points(rifleHits(fewest - PROGRESSION.critHits + 1, 1))).toBe(1)
    // However many, no more than the cap in one match.
    expect(points(rifleHits(1000))).toBe(PROGRESSION.proficiencyPerMatch)
  })

  test('never past the top of a band or a scale, and never more than a point of an attribute', () => {
    const topped: CharacterSheet = {
      ...sheet({ health: CHARACTER.attribute.max }),
      proficiency: { rifle: CHARACTER.proficiency.max, shotgun: 0, sniper: 0, gatling: 0 },
    }
    expect(growthFrom(topped, deeds({ ...rifleHits(1000), wounds: 10_000 }))).toEqual([])

    const health = growthFrom(sheet(), deeds({ wounds: 10_000 })).filter((g) => g.kind === 'attribute')
    expect(health.map((g) => [g.from, g.to])).toEqual([[5, 6]])

    // The class trained in keeps its head start at the top: it grows past
    // where any other class stops, and no further than that plus the bonus.
    const top = CHARACTER.proficiency.max
    const specialist: CharacterSheet = { ...topped, specialism: WeaponId.Rifle }
    const rifle = growthFrom(specialist, rifleHits(1000)).find((g) => g.kind === 'proficiency')
    expect(rifle && [rifle.from, rifle.to]).toEqual([top, Math.min(top + PROGRESSION.proficiencyPerMatch, top + CHARACTER.specialistBonus)])
  })

  test('Intelligence speeds it: the same deeds teach the clever what they do not teach the slow', () => {
    // Exactly the Agility bar in marks: short of it at the slow end of the
    // learning rate, past it at the quick end.
    const marks = PROGRESSION.marksPerPoint.agility
    const record = deeds({ pushed: marks })
    const learns = (intelligence: number) =>
      growthFrom(sheet({ intelligence }), record).some((g) => g.kind === 'attribute' && g.attribute === 'agility')
    expect(learns(CHARACTER.attribute.min)).toBe(false)
    expect(learns(CHARACTER.attribute.max)).toBe(true)
  })

  test('each attribute grows from its own deeds, and says which', () => {
    const lots = deeds({ wounds: 200, unseen: 5, blows: 5, kit: 5 })
    const grew = growthFrom(sheet(), lots).filter((g) => g.kind === 'attribute')
    expect(grew.map((g) => g.kind === 'attribute' && g.attribute)).toEqual(['health', 'agility', 'strength', 'intelligence'])
    expect(grew.every((g) => g.because.length > 0)).toBe(true)
    expect(growthFrom(sheet(), noDeeds())).toEqual([])
  })

  test('growing makes a new sheet and leaves the old one alone', () => {
    const before = sheet()
    const after = grown(before, growthFrom(before, { ...rifleHits(100), wounds: 200 }))
    expect(after.attributes.health).toBe(6)
    expect(after.proficiency.rifle).toBe(PROGRESSION.proficiencyPerMatch)
    expect(before.attributes.health).toBe(5)
    expect(before.proficiency.rifle).toBe(0)
  })
})

/**
 * A small match with no scene, on dice the test chooses. Blue 0 and Red 0
 * are placed by the test; everyone else is parked behind a wall.
 */
function match(roll: Roll) {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(40)
  for (let x = 0; x < grid.size; x++) grid.setWall(x, 35, Side.North, WallKind.Solid)
  const parked = (x0: number) => Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: x0 + i * 2, y: 38 }))
  const plain = () => ({ ...characterSheet(new Rng(4)), traits: [] })
  const squads = new Squads(world, grid, { [Faction.Blue]: parked(1), [Faction.Red]: parked(30) }, undefined, Faction.Blue, {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, plain),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, plain),
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
  const blues = squads.byFaction[Faction.Blue]
  const reds = squads.byFaction[Faction.Red]
  return { world, grid, squads, combat, commands, turns, blue: blues[0]!, mate: blues[1]!, red: reds[0]! }
}

const always = (value: number): Roll => () => value

describe('The service record', () => {
  test('a gun credits its class with every round landed, a death once, and the wounds to whoever took them', () => {
    const m = match(always(0.5))
    m.blue.tile = { x: 10, y: 10 }
    m.red.tile = { x: 10, y: 14 }
    m.red.awareness = Awareness.Engaged
    m.red.hp = 1

    const result = m.combat.fireShot(m.blue, m.red, ShotMode.Burst, Array(10).fill(true))!
    const landed = result.hits.filter((hit) => hit.damage > 0).length
    expect(result.hits.filter((hit) => hit.killed).length).toBeGreaterThan(1)

    expect(m.blue.deeds.hits.rifle).toBe(landed)
    expect(m.blue.deeds.kills).toBe(1)
    expect(m.red.deeds.wounds).toBe(result.hits.reduce((sum, hit) => sum + hit.damage, 0))
    // Engaged and shot from the front: nothing about it was unseen.
    expect(m.blue.deeds.unseen).toBe(0)
  })

  test('a squadmate shot teaches the shooter nothing', () => {
    const m = match(always(0.5))
    m.blue.tile = { x: 10, y: 10 }
    m.mate.tile = { x: 10, y: 14 }
    m.combat.fireShot(m.blue, m.mate, ShotMode.Snap, [true])
    expect(m.blue.deeds.hits.rifle).toBe(0)
    expect(m.mate.deeds.wounds).toBeGreaterThan(0)
  })

  test('a shot on a unit not yet in the fight counts as one it did not see coming', () => {
    const m = match(always(0.5))
    m.blue.tile = { x: 10, y: 10 }
    m.red.tile = { x: 10, y: 14 }
    m.red.awareness = Awareness.Unaware
    m.combat.fireShot(m.blue, m.red, ShotMode.Snap, [true])
    expect(m.blue.deeds.unseen).toBe(1)
  })

  test('a turn spent to the last point counts, unless it is the one that winds the unit', () => {
    const pushed = (exhaustedTurns: number) => {
      const m = match(always(0.5))
      m.blue.ap = 0
      m.blue.spentThisTurn = m.blue.effectiveMaxAp
      m.blue.exhaustedTurns = exhaustedTurns
      m.commands.apply({ type: 'endTurn', faction: Faction.Blue }, 'local')
      return m.blue.deeds.pushed
    }
    expect(pushed(0)).toBe(1)
    expect(pushed(RULES.exhaustionTurns - 1)).toBe(0)
  })

  test('both peers keep the same record from the same commands', () => {
    const here = match(always(0.3))
    const there = match(always(0.3))
    for (const m of [here, there]) {
      m.blue.tile = { x: 10, y: 10 }
      m.red.tile = { x: 10, y: 14 }
    }
    const shot = { type: 'fireShot', shooterFaction: Faction.Blue, shooterIndex: 0, targetFaction: Faction.Red, targetIndex: 0, mode: ShotMode.Burst } as const
    here.commands.apply(shot, 'local')
    there.commands.apply(shot, 'record')
    expect(there.blue.deeds.serialize()).toEqual(here.blue.deeds.serialize())
    expect(there.red.deeds.serialize()).toEqual(here.red.deeds.serialize())
    expect(here.blue.deeds.hits.rifle).toBeGreaterThan(0)
  })
})

describe('The end of a match', () => {
  test('comes when one side has nobody standing, and teaches only that side’s survivors', () => {
    const m = match(always(0.5))
    // An ordinary constitution, so there is a point of Health to gain.
    m.blue.adoptSheet({ ...m.blue.sheet, attributes: { ...m.blue.sheet.attributes, health: 5 } })
    expect(winnerOf(m.squads)).toBeNull()
    for (const red of m.squads.byFaction[Faction.Red]) red.hp = 0
    expect(winnerOf(m.squads)).toBe(Faction.Blue)

    m.mate.hp = 0
    m.blue.deeds.wounds = 1000
    const debriefs = debrief(m.squads, Faction.Blue)
    expect(debriefs.map((d) => d.unit)).toEqual(m.squads.byFaction[Faction.Blue].filter((unit) => !unit.isDead))
    expect(debriefs.find((d) => d.unit === m.blue)!.growth.some((g) => g.kind === 'attribute' && g.attribute === 'health')).toBe(true)
  })

  test('shows a local match the loser’s page and then the winner’s; online, each side only its own', () => {
    const portraits = { getPortrait: () => '' }
    const stages = (viewer: Faction | null) => endScreens(Faction.Red, viewer, [], portraits).map((page) => [page.stage, page.next.type])
    expect(stages(null)).toEqual([
      ['lost', 'endScreenNext'],
      ['won', 'backToMenu'],
    ])
    expect(stages(Faction.Red)).toEqual([['won', 'backToMenu']])
    expect(stages(Faction.Blue)).toEqual([['lost', 'backToMenu']])
  })
})
