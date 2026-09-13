import { describe, expect, test } from 'bun:test'
import { AMMO, AmmoId, Gatling, Rifle, Shotgun, Sniper, ShotMode } from '../src/core/Arsenal'
import {
  type CombatantStats,
  critBreakdown,
  effectiveWeapon,
  resolveDamage,
} from '../src/core/Ballistics'
import { AIM, CRIT } from '../src/config'

/** A shooter carrying `weapon`, loaded with `ammo`. */
function shooter(weapon: CombatantStats['weapon'], ammo = AMMO[AmmoId.Standard]): CombatantStats {
  return { hp: 100, maxHp: 100, armor: 0, isCrouching: false, weapon, ammo, statuses: [] }
}

/** A target wearing `armor` points of plate. */
function target(armor: number): CombatantStats {
  return {
    hp: 100,
    maxHp: 100,
    armor,
    isCrouching: false,
    weapon: new Rifle(),
    ammo: AMMO[AmmoId.Standard],
    statuses: [],
  }
}

function chanceAt(weapon: CombatantStats['weapon'], distance: number, armor = 0): number {
  const eff = effectiveWeapon(shooter(weapon), ShotMode.Snap)
  return critBreakdown(eff, target(armor), distance).chance
}

describe('What moves a crit chance', () => {
  test('the weapon sets where the chance starts', () => {
    const sniper = new Sniper()
    const gatling = new Gatling()

    // Midway along each weapon's own reach, so range contributes nothing.
    expect(chanceAt(sniper, sniper.maxRange / 2)).toBe(sniper.critChance)
    expect(chanceAt(gatling, gatling.maxRange / 2)).toBe(gatling.critChance)
    expect(chanceAt(sniper, sniper.maxRange / 2)).toBeGreaterThan(
      chanceAt(gatling, gatling.maxRange / 2),
    )
  })

  test('a shotgun wants to be close and a sniper rifle wants the distance', () => {
    const shotgun = new Shotgun()
    const sniper = new Sniper()

    expect(chanceAt(shotgun, 0)).toBeGreaterThan(chanceAt(shotgun, shotgun.maxRange))
    expect(chanceAt(sniper, sniper.maxRange)).toBeGreaterThan(chanceAt(sniper, 0))
  })

  test('the range swing is the full tunable at either extreme, and nothing midway', () => {
    const sniper = new Sniper()
    const eff = effectiveWeapon(shooter(sniper), ShotMode.Snap)

    expect(critBreakdown(eff, target(0), 0).rangeTerm).toBe(-CRIT.rangeSwing)
    expect(critBreakdown(eff, target(0), sniper.maxRange).rangeTerm).toBe(CRIT.rangeSwing)
    expect(critBreakdown(eff, target(0), sniper.maxRange / 2).rangeTerm).toBe(0)
  })

  test('a weapon with no range bias is indifferent to distance', () => {
    const rifle = new Rifle()
    expect(chanceAt(rifle, 0)).toBe(chanceAt(rifle, rifle.maxRange))
  })

  test('armour covers what a crit needs to reach', () => {
    const rifle = new Rifle()
    const near = rifle.maxRange / 2

    expect(chanceAt(rifle, near, 20)).toBeLessThan(chanceAt(rifle, near, 0))
  })

  test('a round that penetrates armour keeps its chance at the vitals', () => {
    const rifle = new Rifle()
    const near = rifle.maxRange / 2
    const standard = effectiveWeapon(shooter(rifle, AMMO[AmmoId.Standard]), ShotMode.Snap)
    const piercing = effectiveWeapon(shooter(rifle, AMMO[AmmoId.ArmorPiercing]), ShotMode.Snap)

    const plated = target(20)
    expect(critBreakdown(piercing, plated, near).armorTerm).toBe(0)
    expect(critBreakdown(standard, plated, near).armorTerm).toBeLessThan(0)
    expect(critBreakdown(piercing, plated, near).chance).toBeGreaterThan(
      critBreakdown(standard, plated, near).chance,
    )
  })

  test('the chance stays inside its clamps however lopsided the shot', () => {
    const shotgun = new Shotgun()
    const eff = effectiveWeapon(shooter(shotgun), ShotMode.Snap)

    // Far outside its element, against heavy plate it barely dents.
    const hopeless = critBreakdown(eff, target(200), shotgun.maxRange * 3)
    expect(hopeless.chance).toBeGreaterThanOrEqual(CRIT.min)
    expect(hopeless.chance).toBeLessThanOrEqual(CRIT.max)
  })

  test('the shot mode has no say', () => {
    const rifle = new Rifle()
    const plated = target(20)
    const snap = effectiveWeapon(shooter(rifle), ShotMode.Snap)
    const aimed = effectiveWeapon(shooter(rifle), ShotMode.Aimed)

    expect(critBreakdown(aimed, plated, 8)).toEqual(critBreakdown(snap, plated, 8))
  })
})

describe('What a crit is worth', () => {
  test('a crit multiplies the round by the weapon\u2019s multiplier', () => {
    const sniper = new Sniper()
    const eff = effectiveWeapon(shooter(sniper), ShotMode.Snap)
    const bare = target(0)

    const ordinary = resolveDamage(eff, bare)
    const critical = resolveDamage(eff, bare, 1, true)

    expect(critical.crit).toBe(true)
    expect(ordinary.crit).toBe(false)
    expect(critical.damage).toBe(Math.round(ordinary.damage * sniper.critMultiplier))
  })

  test('armour blunts a crit rather than being bypassed by it', () => {
    const rifle = new Rifle()
    const eff = effectiveWeapon(shooter(rifle), ShotMode.Snap)

    const bare = resolveDamage(eff, target(0), 1, true).damage
    const plated = resolveDamage(eff, target(20), 1, true).damage

    expect(plated).toBeLessThan(bare)
    // Armour subtracts after the multiplier, so what it stops is the same flat
    // bite it takes out of an ordinary hit.
    const armorInPlay = 20 * (1 - eff.armorPen)
    expect(bare - plated).toBe(Math.round(armorInPlay))
  })

  test('a crit still cannot fall below the floor every hit gets', () => {
    const gatling = new Gatling()
    const eff = effectiveWeapon(shooter(gatling), ShotMode.Snap)

    expect(resolveDamage(eff, target(500), 1, true).damage).toBe(AIM.minDamage)
  })

  test('falloff and the crit multiplier both apply to the same round', () => {
    const shotgun = new Shotgun()
    const eff = effectiveWeapon(shooter(shotgun), ShotMode.Snap)
    const bare = target(0)

    const full = resolveDamage(eff, bare, 1, true).damage
    const half = resolveDamage(eff, bare, 0.5, true).damage

    expect(half).toBe(Math.round(full / 2))
  })
})
