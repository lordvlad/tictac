import { describe, expect, test } from 'bun:test'
import { AIM, Faction } from '../src/config'
import { AMMO, AmmoId, Rifle, Shotgun, ShotMode, type Weapon, WeaponId } from '../src/core/Arsenal'
import {
  type CombatantStats,
  effectiveWeapon,
  expectedRoundDamage,
  hitChance,
  resolveDamage,
} from '../src/core/Ballistics'
import { NO_FX } from '../src/core/Combatant'
import { Grid } from '../src/core/Grid'
import { MeleeId } from '../src/core/Melee'
import type { Roll } from '../src/core/rng'
import { CoverLevel } from '../src/core/Walls'
import { executeShot } from '../src/game/Combat'
import { headlessSoldier } from './support/soldier'

/** A person-shaped nobody: every modifier at zero, standard kit. */
function body(weapon: Weapon = new Rifle(), over: Partial<CombatantStats> = {}): CombatantStats {
  return {
    hp: 100,
    maxHp: 100,
    armor: 0,
    isCrouching: false,
    weapon,
    ammo: AMMO[AmmoId.Standard],
    statuses: [],
    proficiency: 0,
    evasion: 0,
    critImmune: false,
    bleedImmune: false,
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

const odds = (
  shooter: CombatantStats,
  target: CombatantStats,
  distance: number,
  cover: CoverLevel = CoverLevel.None,
  mode: ShotMode = ShotMode.Snap,
) =>
  hitChance(shooter, target, distance, cover, mode)

describe('One straight line', () => {
  test('a bullet lands less often the further it has to travel', () => {
    const chances = [2, 6, 12, 20].map((d) => odds(body(), body(), d).chance)
    for (let i = 1; i < chances.length; i++) expect(chances[i]!).toBeLessThan(chances[i - 1]!)
  })

  test('cover and a crouch hide body, and less body is harder to hit', () => {
    const at = (cover: CoverLevel, crouching: boolean) =>
      odds(body(), body(new Rifle(), { isCrouching: crouching }), 8, cover).chance
    expect(at(CoverLevel.None, true)).toBeLessThan(at(CoverLevel.None, false))
    expect(at(CoverLevel.Low, true)).toBeLessThan(at(CoverLevel.Low, false))
    expect(at(CoverLevel.Tall, false)).toBeLessThan(at(CoverLevel.Low, false))
    expect(at(CoverLevel.Tall, true)).toBeLessThan(at(CoverLevel.Tall, false))
  })

  test('taking aim narrows the line; firing on reflex widens it', () => {
    const snap = odds(body(), body(), 12).chance
    expect(odds(body(), body(), 12, CoverLevel.None, ShotMode.Aimed).chance).toBeGreaterThan(snap)
    expect(odds(body(), body(), 12, CoverLevel.None, ShotMode.Reaction).chance).toBeLessThan(snap)
  })
})

describe('A fan of lines', () => {
  test('buckshot lands something across a room, but what lands falls off with distance', () => {
    const shotgun = body(new Shotgun())
    const near = odds(shotgun, body(), 2)
    const room = odds(shotgun, body(), 6)
    const far = odds(shotgun, body(), 11)
    expect(near.landed).toBeGreaterThan(room.landed)
    expect(room.landed).toBeGreaterThan(far.landed)
    // Which is the whole of its damage falling with distance: no rule says so.
    const eff = effectiveWeapon(shotgun, ShotMode.Snap)
    const dealt = (o: typeof near) => expectedRoundDamage(eff, body(), o)
    expect(dealt(near)).toBeGreaterThan(dealt(room))
    expect(dealt(room)).toBeGreaterThan(dealt(far))
  })

  test('inside a room a shotgun out-hits a rifle; across the map it does not', () => {
    const plated = body(new Rifle(), { armor: 20 })
    const expected = (weapon: Weapon, distance: number) => {
      const shooter = body(weapon)
      return expectedRoundDamage(effectiveWeapon(shooter, ShotMode.Snap), plated, odds(shooter, plated, distance))
    }
    expect(expected(new Shotgun(), 3)).toBeGreaterThan(expected(new Rifle(), 3) * 1.5)
    expect(expected(new Shotgun(), 10)).toBeLessThan(expected(new Rifle(), 10))
  })

  test('armour is taken off the shell, not off every pellet', () => {
    // Plate that would stop any one pellet outright still only blunts a full
    // shell: buckshot is impact, not penetration.
    const eff = effectiveWeapon(body(new Shotgun()), ShotMode.Snap)
    const plate = body(new Rifle(), { armor: 20 })
    expect(resolveDamage(eff, plate, 1, false, 1).damage).toBe(AIM.minDamage)
    expect(resolveDamage(eff, plate, 1, false, 9).damage).toBeGreaterThan(eff.damage * 9 * 0.7)
  })

  test('the floor is the round’s: a distant shell may land hardly any pellet', () => {
    // Nine pellets each held up at five percent would make a shell at the end
    // of its range land a third of the time.
    const far = odds(body(new Shotgun()), body(new Rifle(), { isCrouching: true }), 11, CoverLevel.Tall)
    expect(far.projectile).toBeLessThan(AIM.min)
    expect(far.chance).toBeGreaterThanOrEqual(AIM.min)
  })
})

describe('Dice for a round', () => {
  /** A roll that always returns `value`, counting how many numbers it was asked for. */
  function counted(value: number): { roll: Roll; draws: () => number } {
    let n = 0
    return {
      roll: () => {
        n++
        return value
      },
      draws: () => n,
    }
  }

  function duel(weapon: WeaponId) {
    const grid = new Grid(16)
    const shooter = headlessSoldier({ faction: Faction.Blue, weapon, tile: { x: 4, y: 4 } })
    const target = headlessSoldier({ faction: Faction.Red, tile: { x: 4, y: 6 } })
    return { grid, shooter, target }
  }

  test('a shell rolls once per pellet, then once for the crit if anything landed, and a bleed only on a target still alive', () => {
    // The count and order of draws is what keeps two peers on one stream.
    // Nine pellets at point blank kill outright, so there is nobody left to bleed.
    const hit = counted(0)
    const { grid, shooter, target } = duel(WeaponId.Shotgun)
    executeShot(grid, shooter, target, NO_FX, [shooter, target], ShotMode.Snap, hit.roll)
    expect(target.isDead).toBe(true)
    expect(hit.draws()).toBe(new Shotgun().pellets + 1)

    const miss = counted(0.999)
    const again = duel(WeaponId.Shotgun)
    executeShot(again.grid, again.shooter, again.target, NO_FX, [again.shooter, again.target], ShotMode.Snap, miss.roll)
    expect(miss.draws()).toBe(new Shotgun().pellets)
  })

  test('a bullet that lands is one roll, one crit roll and one bleed roll', () => {
    const hit = counted(0)
    const { grid, shooter, target } = duel(WeaponId.Rifle)
    executeShot(grid, shooter, target, NO_FX, [shooter, target], ShotMode.Snap, hit.roll)
    expect(target.isDead).toBe(false)
    expect(hit.draws()).toBe(3)
  })
})
