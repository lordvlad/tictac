import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE, WOUNDS } from '../src/config'
import { AmmoId, GRENADES, type GrenadeId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { characterSheet } from '../src/core/Characters'
import { Grid } from '../src/core/Grid'
import { ItemId } from '../src/core/Items'
import { Rng } from '../src/core/rng'
import { TraitId, resolveTraits, woundTraits } from '../src/core/Traits'
import { World } from '../src/ecs/World'
import { TraitsComponent } from '../src/ecs/components'
import { calculateHitChance } from '../src/game/Combat'
import { Squads } from '../src/game/Squads'
import { stepCostFor, moveBudget } from '../src/game/Movement'
import { SimUnit } from '../src/sim/SimUnit'

function unit(): SimUnit {
  return new SimUnit(
    Faction.Blue,
    0,
    'Test',
    characterSheet(new Rng(21)),
    WeaponId.Rifle,
    AmmoId.Standard,
    { x: 1, y: 1 },
    Object.fromEntries(Object.keys(GRENADES).map((k) => [k, 0])) as Record<GrenadeId, number>,
    { stim: 0, firstAid: 0, nullweave: 0 } as Record<ItemId, number>,
  )
}

function headlessSquads(): { world: World; grid: Grid; squads: Squads } {
  const world = new World()
  const grid = new Grid(16)
  const spawns = {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 2 })),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 6 })),
  }
  return { world, grid, squads: new Squads(world, grid, spawns) }
}

describe('What a wound is', () => {
  test('a whole unit carries none', () => {
    expect(woundTraits(100, 100)).toEqual([])
    expect(woundTraits(51, 100)).toEqual([])
  })

  test('half health is limping, a quarter is both', () => {
    expect(woundTraits(WOUNDS.limping * 100, 100)).toEqual([TraitId.Limping])
    expect(woundTraits(WOUNDS.concussed * 100, 100)).toEqual([TraitId.Limping, TraitId.Concussed])
  })

  test('the thresholds are shares, not point counts', () => {
    // A tough unit is not wounded at the hit points that would cripple a frail
    // one; it is wounded at the same *share* of its own maximum.
    expect(woundTraits(60, 200)).toEqual([TraitId.Limping])
    expect(woundTraits(60, 100)).toEqual([])
  })

  test('a corpse is not wounded', () => {
    // Nothing to slow down, and it would put chips on a dead unit's card.
    expect(woundTraits(0, 100)).toEqual([])
    expect(woundTraits(-20, 100)).toEqual([])
  })
})

describe('What a wound costs', () => {
  test('taking damage across a threshold starts costing, and healing stops it', () => {
    const u = unit()
    const wholeStep = u.moveCostMul

    u.hp = Math.floor(u.maxHp * WOUNDS.limping)
    expect(u.moveCostMul).toBeGreaterThan(wholeStep)

    // Derived from condition rather than stamped on, so patching a unit up
    // genuinely helps instead of leaving it limping at full health.
    u.hp = u.maxHp
    expect(u.moveCostMul).toBe(wholeStep)
  })

  test('being badly hurt costs accuracy and evasion too', () => {
    const u = unit()
    const wholeAim = u.proficiency
    const wholeEvasion = u.evasion

    u.hp = Math.floor(u.maxHp * WOUNDS.concussed)

    expect(u.proficiency).toBeLessThan(wholeAim)
    expect(u.evasion).toBeLessThanOrEqual(wholeEvasion)
  })

  test('two sources of slowness add rather than compounding', () => {
    // The fold adds, and adding multipliers is not how multipliers work: two
    // half-again penalties should be twice as expensive, not 2.25 times.
    const doubled = resolveTraits([TraitId.Limping, TraitId.Limping])
    expect(doubled.moveCost).toBe(1)
  })

  test('a limp is charged on the ground it walks', () => {
    const { grid } = headlessSquads()
    const whole = unit()
    const hurt = unit()
    hurt.hp = Math.floor(hurt.maxHp * WOUNDS.limping)

    const from = { x: 1, y: 1 }
    const to = { x: 1, y: 2 }
    expect(stepCostFor(grid, hurt, from, to)).toBeGreaterThan(stepCostFor(grid, whole, from, to))
  })

  test('a route is planned in the currency it is walked in', () => {
    // Routes are costed in terrain prices, so a unit paying more per step
    // affords fewer of them. Budget and charge have to agree or a confirmed
    // route strands the unit halfway.
    const whole = unit()
    const hurt = unit()
    hurt.hp = Math.floor(hurt.maxHp * WOUNDS.limping)
    hurt.ap = whole.ap

    expect(moveBudget(hurt)).toBeLessThan(moveBudget(whole))
    expect(moveBudget(whole)).toBe(whole.ap)
  })
})

describe('A wound on a real soldier', () => {
  test('the step price is replicated, because the mover reads components', () => {
    const { world, squads } = headlessSquads()
    const soldier = squads.soldiers[0]!

    expect(world.getComponent(soldier.entityId, TraitsComponent)?.moveCostMul).toBe(1)

    soldier.hp = Math.floor(soldier.maxHp * WOUNDS.limping)

    expect(soldier.moveCostMul).toBeGreaterThan(1)
    expect(world.getComponent(soldier.entityId, TraitsComponent)?.moveCostMul).toBe(
      soldier.moveCostMul,
    )
  })

  test('damage arriving through the resolver wounds the unit', () => {
    // The path a real hit takes: nothing calls `refreshTraits` explicitly, so
    // the hit-point setter has to be the trigger.
    const { squads } = headlessSquads()
    const soldier = squads.soldiers[0]!
    soldier.equip(WeaponId.Rifle, AmmoId.Standard)

    soldier.hp -= Math.ceil(soldier.maxHp * 0.6)

    expect(soldier.traits.moveCost).toBeGreaterThan(0)
    expect(soldier.moveCostMul).toBeGreaterThan(1)
  })

  test('a wound lowers the points a unit gets back', () => {
    const { squads } = headlessSquads()
    const soldier = squads.soldiers[0]!
    const whole = soldier.effectiveMaxAp

    soldier.hp = Math.floor(soldier.maxHp * WOUNDS.limping)

    expect(soldier.effectiveMaxAp).toBeLessThan(whole)
  })

  test('the shot it takes is worse for it', () => {
    const { grid, squads } = headlessSquads()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!
    shooter.equip(WeaponId.Rifle, AmmoId.Standard)

    const whole = calculateHitChance(grid, shooter, target, ShotMode.Snap)

    shooter.hp = Math.floor(shooter.maxHp * WOUNDS.concussed)
    expect(calculateHitChance(grid, shooter, target, ShotMode.Snap)).toBeLessThan(whole)
  })
})
