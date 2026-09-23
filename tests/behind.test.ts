import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AMMO, AmmoId, Rifle, ShotMode, WeaponId } from '../src/core/Arsenal'
import { type CombatantStats, hitChance, meleeChance, meleeWeapon, resolveDamage } from '../src/core/Ballistics'
import { characterSheet } from '../src/core/Characters'
import { NO_FX } from '../src/core/Combatant'
import { fromBehind, HEADINGS, headingToward } from '../src/core/Facing'
import { Grid } from '../src/core/Grid'
import { MeleeId } from '../src/core/Melee'
import { Rng } from '../src/core/rng'
import { CoverLevel } from '../src/core/Walls'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { MovementSystem } from '../src/ecs/systems/MovementSystem'
import { executeMelee, shotBreakdown } from '../src/game/Combat'
import { Squads } from '../src/game/Squads'

/** A person-shaped nobody: every modifier at zero, standard kit. */
function body(over: Partial<CombatantStats> = {}): CombatantStats {
  return {
    hp: 100,
    maxHp: 100,
    armor: 20,
    isCrouching: false,
    weapon: new Rifle(),
    ammo: AMMO[AmmoId.Standard],
    statuses: [],
    proficiency: 0,
    evasion: 0,
    critImmune: false,
    rangeFalloff: 0,
    damageTaken: 0,
    critChanceBonus: 0,
    critMultiplierBonus: 0,
    sidearm: MeleeId.Fists,
    meleeSkill: 0,
    meleePower: 0,
    ...over,
  }
}

const heading = (dx: number, dy: number) => HEADINGS.findIndex(([x, y]) => x === dx && y === dy)

/** Two real units in one world: Blue 0 at (5,5), Red 0 beside it at (6,5). Red is as quick as a sheet allows. */
function pair() {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(24)
  const far = (y: number) => Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 1 + i * 2, y }))
  const plain = (agility: number) => () => {
    const sheet = characterSheet(new Rng(4))
    return { ...sheet, traits: [], attributes: { ...sheet.attributes, agility } }
  }
  const squads = new Squads(world, grid, { [Faction.Blue]: far(1), [Faction.Red]: far(22) }, undefined, Faction.Blue, {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, plain(5)),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, plain(10)),
  })
  const attacker = squads.byFaction[Faction.Blue][0]!
  const defender = squads.byFaction[Faction.Red][0]!
  for (const unit of [attacker, defender]) unit.equip(WeaponId.Rifle, AmmoId.Standard)
  attacker.tile = { x: 5, y: 5 }
  defender.tile = { x: 6, y: 5 }
  return { world, grid, attacker, defender }
}

describe('Facing, as the rules read it', () => {
  test('a heading is the nearest of eight, decided by comparison alone', () => {
    expect(headingToward(0, 3)).toBe(heading(0, 1))
    expect(headingToward(-2, -2)).toBe(heading(-1, -1))
    // Just inside and just outside 22.5° of the x axis.
    expect(headingToward(10, 4)).toBe(heading(1, 0))
    expect(headingToward(10, 4.2)).toBe(heading(1, 1))
    // No direction at all keeps whatever it was.
    expect(headingToward(0, 0, 5)).toBe(5)
  })

  test('the three neighbours at a unit’s back are behind it, and no others', () => {
    const target = { tile: { x: 5, y: 5 }, heading: heading(0, 1) }
    const behind: [number, number][] = []
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && fromBehind(target, { x: 5 + dx, y: 5 + dy })) behind.push([dx, dy])
      }
    }
    expect(behind).toEqual([
      [-1, -1],
      [0, -1],
      [1, -1],
    ])
  })

  test('a unit faces the way it last stepped', () => {
    const { world, grid, attacker } = pair()
    const movement = new MovementSystem(grid)
    world.addSystem(movement)
    movement.startMovement(world, attacker.entityId, [
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 6, y: 3 },
    ])
    world.update(5)
    expect(attacker.heading).toBe(heading(1, -1))
  })
})

describe('An attack from behind', () => {
  test('a shot from behind gets past evasion, but not past cover', () => {
    const shooter = body()
    const nimble = body({ evasion: 12 })
    const chance = (cover: CoverLevel, behind: boolean) =>
      hitChance(shooter, nimble, 8, cover, ShotMode.Snap, behind).chance

    expect(chance(CoverLevel.None, true)).toBeGreaterThan(chance(CoverLevel.None, false))
    // Evasion is gone entirely, not merely reduced.
    expect(chance(CoverLevel.None, true)).toBe(hitChance(shooter, body(), 8, CoverLevel.None, ShotMode.Snap).chance)
    expect(chance(CoverLevel.Tall, true)).toBeLessThan(chance(CoverLevel.None, true))
  })

  test('a blow from behind is not parried or dodged', () => {
    const attacker = body({ sidearm: MeleeId.Knife })
    const guarded = body({ sidearm: MeleeId.Knife, evasion: 12 })
    const front = meleeChance(attacker, guarded).chance
    const back = meleeChance(attacker, guarded, true)
    expect(back.chance).toBeGreaterThan(front)
    expect(back.chance).toBe(meleeChance(attacker, body()).chance)
  })

  test('a knife from behind kills an ordinary soldier; the same knife from the front, or a fist from behind, does not', () => {
    const knife = body({ sidearm: MeleeId.Knife })
    const fist = body({ sidearm: MeleeId.Fists })
    // The top of the health band, in a full plate carrier's worth of armour.
    const soldier = body({ hp: 120, maxHp: 120 })

    expect(resolveDamage(meleeWeapon(knife, true), soldier).damage).toBeGreaterThanOrEqual(120)
    expect(resolveDamage(meleeWeapon(knife), soldier).damage).toBeLessThan(60)
    expect(resolveDamage(meleeWeapon(fist, true), soldier).damage).toBeLessThan(60)
  })

  test('a very large, plated soldier can survive a weak knifer', () => {
    const weak = body({ sidearm: MeleeId.Knife, meleePower: -25 })
    const large = body({ hp: 145, maxHp: 145, damageTaken: -0.2 })
    expect(resolveDamage(meleeWeapon(weak, true), large).damage).toBeLessThan(145)
  })

  test('the resolver reads the target’s real heading', () => {
    const lands = () => 0
    const facingAway = pair()
    facingAway.defender.sidearm = MeleeId.Fists
    facingAway.attacker.sidearm = MeleeId.Knife
    facingAway.defender.heading = heading(1, 0)
    executeMelee(facingAway.grid, facingAway.attacker, facingAway.defender, NO_FX, lands)
    expect(facingAway.defender.isDead).toBe(true)

    const facing = pair()
    facing.attacker.sidearm = MeleeId.Knife
    facing.defender.heading = heading(-1, 0)
    executeMelee(facing.grid, facing.attacker, facing.defender, NO_FX, lands)
    expect(facing.defender.isDead).toBe(false)
  })

  test('the shot panel’s odds know which way the target faces', () => {
    const { grid, attacker, defender } = pair()
    defender.tile = { x: 12, y: 5 }
    expect(defender.evasion).toBeGreaterThan(0)
    defender.heading = heading(-1, 0)
    const front = shotBreakdown(grid, attacker, defender, ShotMode.Snap).chance
    defender.heading = heading(1, 0)
    const back = shotBreakdown(grid, attacker, defender, ShotMode.Snap).chance
    expect(back).toBeGreaterThan(front)
  })
})
