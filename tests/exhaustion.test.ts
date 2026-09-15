import { describe, expect, test } from 'bun:test'
import { Faction, RULES, SQUAD_SIZE } from '../src/config'
import { AmmoId, GRENADES, type GrenadeId, StatusKind, WeaponId } from '../src/core/Arsenal'
import { effectiveMaxAp } from '../src/core/Ballistics'
import { characterSheet } from '../src/core/Characters'
import { Grid } from '../src/core/Grid'
import { ItemId } from '../src/core/Items'
import { Rng } from '../src/core/rng'
import { World } from '../src/ecs/World'
import { ActionPointsComponent } from '../src/ecs/components'
import { TurnSystem } from '../src/ecs/systems'
import { Squads } from '../src/game/Squads'
import { settleTurn } from '../src/game/Turn'
import { SimUnit } from '../src/sim/SimUnit'

/** A unit with no scene and no world: the rule only needs a combatant. */
function unit(faction: Faction = Faction.Blue): SimUnit {
  return new SimUnit(
    faction,
    0,
    'Test',
    characterSheet(new Rng(4)),
    WeaponId.Rifle,
    AmmoId.Standard,
    { x: 1, y: 1 },
    Object.fromEntries(Object.keys(GRENADES).map((k) => [k, 0])) as Record<GrenadeId, number>,
    { stim: 0, firstAid: 0, nullweave: 0 } as Record<ItemId, number>,
  )
}

/** Hand over, refill the side coming in, settle — the order a match uses. */
function handOver(units: SimUnit[], incoming: Faction): void {
  for (const u of units) if (u.faction === incoming && !u.isDead) u.ap = u.effectiveMaxAp
  settleTurn(units, incoming)
}

const winded = (u: SimUnit): boolean =>
  u.statuses.some((s) => s.kind === StatusKind.Winded && s.turnsLeft > 0)

describe('Running a unit into the ground', () => {
  test('one hard turn is a commitment, not a cost', () => {
    const u = unit()
    u.ap = 0

    handOver([u], Faction.Red)

    expect(u.exhaustedTurns).toBe(1)
    expect(winded(u)).toBe(false)
  })

  test(`${RULES.exhaustionTurns} in a row leaves it winded`, () => {
    const u = unit()

    for (let i = 0; i < RULES.exhaustionTurns; i++) {
      u.ap = 0
      handOver([u], Faction.Red)
      handOver([u], Faction.Blue)
    }

    expect(winded(u)).toBe(true)
    // Reset rather than left to climb, or the status would re-apply every turn
    // from here on instead of every other one.
    expect(u.exhaustedTurns).toBe(0)
  })

  test('a breather resets the count', () => {
    const u = unit()

    u.ap = 0
    handOver([u], Faction.Red)
    expect(u.exhaustedTurns).toBe(1)

    handOver([u], Faction.Blue)
    u.ap = 1 // stopped one point short of the lot
    handOver([u], Faction.Red)

    expect(u.exhaustedTurns).toBe(0)
    expect(winded(u)).toBe(false)
  })

  test('being winded costs points on the unit\u2019s own next turn, then lifts', () => {
    const u = unit()
    const fresh = u.effectiveMaxAp

    for (let i = 0; i < RULES.exhaustionTurns; i++) {
      u.ap = 0
      handOver([u], Faction.Red)
      handOver([u], Faction.Blue)
    }

    expect(u.effectiveMaxAp).toBeLessThan(fresh)
    expect(u.ap).toBeLessThan(fresh)

    // Two more handovers and it has run out.
    handOver([u], Faction.Red)
    handOver([u], Faction.Blue)
    expect(winded(u)).toBe(false)
    expect(u.effectiveMaxAp).toBe(fresh)
  })

  test('the ceiling never falls to nothing', () => {
    // A unit with no points at all could not even end its own turn, and no
    // status is meant to take a unit out of play.
    expect(effectiveMaxAp(2, [{ kind: StatusKind.Winded, turnsLeft: 3 }])).toBeGreaterThanOrEqual(1)
    expect(effectiveMaxAp(1, [{ kind: StatusKind.Winded, turnsLeft: 3 }])).toBe(1)
  })
})

describe('What counts as effort', () => {
  test('spending is counted on the way down, not read off what is left', () => {
    const u = unit()
    const start = u.ap

    u.ap -= 4
    u.ap -= 2

    expect(u.spentThisTurn).toBe(6)
    expect(u.ap).toBe(start - 6)
  })

  test('a refill forgets nothing on its own', () => {
    // Only the handover clears the tally: a bare refill must not, or a unit
    // could be handed points mid-turn and lose its record of running.
    const u = unit()
    u.ap -= 3
    u.ap = u.effectiveMaxAp

    expect(u.spentThisTurn).toBe(3)
  })

  test('the handover clears the tally for the side coming in, and only that side', () => {
    const blue = unit(Faction.Blue)
    const red = unit(Faction.Red)
    blue.ap -= 3
    red.ap -= 5

    settleTurn([blue, red], Faction.Blue)

    expect(blue.spentThisTurn).toBe(0)
    expect(red.spentThisTurn).toBe(5)
  })

  test('forfeiting a turn is not effort', () => {
    // `endUnitTurn` hands a unit nothing remaining without it having run
    // anywhere. Charging exhaustion for that would punish standing still.
    const world = new World()
    const grid = new Grid(16)
    const spawns = {
      [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 2 })),
      [Faction.Red]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 6 })),
    }
    const squads = new Squads(world, grid, spawns)
    const soldier = squads.byFaction[Faction.Blue][0]!
    const turns = new TurnSystem()

    turns.endUnitTurn(world, soldier.entityId)

    expect(world.getComponent(soldier.entityId, ActionPointsComponent)?.ap).toBe(0)
    expect(soldier.spentThisTurn).toBe(0)

    settleTurn(squads.soldiers, Faction.Red)
    expect(soldier.exhaustedTurns).toBe(0)
  })

  test('a soldier counts its own spending through the same setter', () => {
    const world = new World()
    const grid = new Grid(16)
    const spawns = {
      [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 2 })),
      [Faction.Red]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 6 })),
    }
    const soldier = new Squads(world, grid, spawns).byFaction[Faction.Blue][0]!

    soldier.ap -= 5
    expect(soldier.spentThisTurn).toBe(5)
    // Replicated, because a peer has to agree about who is winded.
    expect(world.getComponent(soldier.entityId, ActionPointsComponent)?.spentThisTurn).toBe(5)
  })
})
