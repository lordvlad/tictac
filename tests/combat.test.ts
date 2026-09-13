import { describe, expect, test } from 'bun:test'
import { StatusKind, WEAPONS, type Weapon, WeaponId } from '../src/core/Arsenal'
import type { StatusState } from '../src/core/Ballistics'
import { Faction } from '../src/config'
import type { Casualty, CombatFx } from '../src/core/Combatant'
import { applyHitEffects } from '../src/game/Combat'

/** A casualty that also carries the weapon the applier must never consult. */
interface StubUnit extends Casualty {
  weapon: Weapon
}

/**
 * The slice of a unit a resolved hit is applied to.
 *
 * A plain object, with no cast: since the resolvers took the `Casualty` port
 * there is nothing about applying a hit that needs a mesh, an engine or a glTF.
 */
function stubUnit(weaponId: WeaponId = WeaponId.Rifle): StubUnit {
  const unit = {
    faction: Faction.Red,
    squadIndex: 0,
    hp: 100,
    armor: 20,
    statuses: [] as StatusState[],
    weapon: WEAPONS[weaponId],
    get isDead(): boolean {
      return unit.hp <= 0
    },
  }
  return unit
}

/**
 * Counts what the resolver announced.
 *
 * The flinch and the death used to be methods on the unit, so a test asserted
 * them by counting calls on its own stub. They are announcements now, and this
 * is where they are counted — which is the same seam a scene listens on.
 */
interface CountingFx extends CombatFx {
  tracers: number
  shots: number
  hits: number
  deaths: number
}

function countingFx(): CountingFx {
  const fx = {
    tracers: 0,
    shots: 0,
    hits: 0,
    deaths: 0,
    tracer: () => {
      fx.tracers += 1
    },
    shoot: () => {
      fx.shots += 1
    },
    hit: () => {
      fx.hits += 1
    },
    death: () => {
      fx.deaths += 1
    },
  }
  return fx
}

describe('Applying a resolved hit', () => {
  test('damage and shred come off, and the unit flinches', () => {
    const target = stubUnit()
    const fx = countingFx()

    applyHitEffects(target, 30, 10, null, fx)

    expect(target.hp).toBe(70)
    expect(target.armor).toBe(10)
    expect(fx.hits).toBe(1)
    expect(fx.deaths).toBe(0)
  })

  test('a lethal hit clamps at zero, applies its status, and plays the death', () => {
    const target = stubUnit()
    const fx = countingFx()

    applyHitEffects(target, 200, 0, StatusKind.Shredded, fx)

    expect(target.hp).toBe(0)
    expect(target.statuses.map((status) => status.kind)).toEqual([StatusKind.Shredded])
    expect(fx.deaths).toBe(1)
    expect(fx.hits).toBe(0)
  })

  test('armour alone can be stripped without a flinch', () => {
    const target = stubUnit()
    const fx = countingFx()

    applyHitEffects(target, 0, 5, null, fx)

    expect(target.hp).toBe(100)
    expect(target.armor).toBe(15)
    expect(fx.hits).toBe(0)
  })

  /**
   * A replayed hit is the peer's picture to decide, not this function's, so the
   * default is silence — that is what lets the same applier serve a local shot
   * that draws and a wire hit whose FX are played elsewhere.
   */
  test('with nobody watching, a hit still lands', () => {
    const target = stubUnit()

    applyHitEffects(target, 30, 0, null)

    expect(target.hp).toBe(70)
  })

  /**
   * The load-bearing case for P2P: the acting peer resolved 55 against *its*
   * weapon, and this side — holding a different one entirely — must apply that
   * number verbatim rather than re-deriving anything from the Shotgun.
   */
  test("a peer's number is applied verbatim, not re-derived from the local weapon", () => {
    const target = stubUnit(WeaponId.Shotgun)
    const fx = countingFx()
    expect(target.weapon.damage).not.toBe(55)

    applyHitEffects(target, 55, 0, null, fx)

    expect(target.hp).toBe(45)
  })
})
