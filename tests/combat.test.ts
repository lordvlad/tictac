import { describe, expect, test } from 'bun:test'
import { StatusKind, WEAPONS, WeaponId } from '../src/core/Arsenal'
import { applyHitEffects } from '../src/game/Combat'
import type { Soldier } from '../src/entities/Soldier'

/**
 * The slice of a soldier a resolved hit is applied to. A real `Soldier` needs a
 * loaded glTF and an engine context, so the test stands in an object with the
 * same contract — including the weapon, which the applier must never consult.
 */
function stubSoldier(weaponId: WeaponId = WeaponId.Rifle) {
  const soldier = {
    hp: 100,
    armor: 20,
    statuses: [] as { kind: StatusKind; turnsLeft: number }[],
    weapon: WEAPONS[weaponId],
    hits: 0,
    deaths: 0,
    get isDead(): boolean {
      return soldier.hp <= 0
    },
    playHit(): void {
      soldier.hits += 1
    },
    playDeath(): void {
      soldier.deaths += 1
    },
  }
  return soldier as unknown as Soldier & typeof soldier
}

describe('Applying a resolved hit', () => {
  test('damage and shred come off, and the unit flinches', () => {
    const target = stubSoldier()

    applyHitEffects(target, 30, 10, null)

    expect(target.hp).toBe(70)
    expect(target.armor).toBe(10)
    expect(target.hits).toBe(1)
    expect(target.deaths).toBe(0)
  })

  test('a lethal hit clamps at zero, applies its status, and plays the death', () => {
    const target = stubSoldier()

    applyHitEffects(target, 200, 0, StatusKind.Shredded)

    expect(target.hp).toBe(0)
    expect(target.statuses.map((status) => status.kind)).toEqual([StatusKind.Shredded])
    expect(target.deaths).toBe(1)
    expect(target.hits).toBe(0)
  })

  test('armour alone can be stripped without a flinch', () => {
    const target = stubSoldier()

    applyHitEffects(target, 0, 5, null)

    expect(target.hp).toBe(100)
    expect(target.armor).toBe(15)
    expect(target.hits).toBe(0)
  })

  /**
   * The load-bearing case for P2P: the acting peer resolved 55 against *its*
   * weapon, and this side — holding a different one entirely — must apply that
   * number verbatim rather than re-deriving anything from the Shotgun.
   */
  test("a peer's number is applied verbatim, not re-derived from the local weapon", () => {
    const target = stubSoldier(WeaponId.Shotgun)
    expect(target.weapon.damage).not.toBe(55)

    applyHitEffects(target, 55, 0, null)

    expect(target.hp).toBe(45)
  })
})
