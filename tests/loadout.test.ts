import { describe, expect, test } from 'bun:test'
import { AmmoId, GrenadeId, WeaponId } from '../src/core/Arsenal'
import { ItemId } from '../src/core/Items'
import {
  LOADOUT_LIMITS,
  addGrenade,
  addItem,
  applyUnitLoadout,
  canEquipWeapon,
  defaultLoadout,
  equipWeapon,
  remaining,
} from '../src/game/Loadout'
import type { Soldier } from '../src/entities/Soldier'

/**
 * The slice of a soldier a loadout is stamped onto. A real `Soldier` needs a
 * loaded glTF and an engine context, so the test stands in an object with the
 * same contract — including the component defaults the stamp has to overwrite.
 */
function stubSoldier() {
  const soldier = {
    weaponId: WeaponId.Rifle as WeaponId,
    ammoId: AmmoId.Standard as AmmoId,
    // What a fresh InventoryComponent / ItemsComponent hands out.
    grenades: { [GrenadeId.Frag]: 1, [GrenadeId.Flash]: 1, [GrenadeId.Smoke]: 1 },
    items: { [ItemId.StimPack]: 1, [ItemId.FirstAidKit]: 1, [ItemId.NullweaveVest]: 0 },
    equip(weaponId: WeaponId, ammoId: AmmoId): void {
      soldier.weaponId = weaponId
      soldier.ammoId = ammoId
    },
    // Worn gear is a trait source, so the stamp re-folds the pouch afterwards.
    refreshTraits(): void {},
  }
  return soldier as unknown as Soldier & typeof soldier
}

describe('Shared crate', () => {
  test('the default spread leaves the expected surplus', () => {
    const left = remaining(defaultLoadout())

    expect(left.weapons).toEqual({
      [WeaponId.Rifle]: 1,
      [WeaponId.Shotgun]: 1,
      [WeaponId.Sniper]: 1,
      [WeaponId.Gatling]: 1,
    })
    expect(left.ammo).toEqual({
      [AmmoId.Standard]: 0,
      [AmmoId.ArmorPiercing]: 3,
      [AmmoId.HollowPoint]: 3,
    })
    expect(left.grenades).toEqual({
      [GrenadeId.Frag]: 2,
      [GrenadeId.Flash]: 3,
      [GrenadeId.Smoke]: 3,
    })
    expect(left.items).toEqual({
      [ItemId.StimPack]: 4,
      [ItemId.FirstAidKit]: 4,
      [ItemId.NullweaveVest]: 2,
    })
  })

  test('a weapon can be handed out while the crate has one, and not after', () => {
    const loadout = defaultLoadout()

    // Two rifles in the crate, one already on member 0.
    equipWeapon(loadout, 1, WeaponId.Rifle)
    expect(loadout[1]!.weaponId).toBe(WeaponId.Rifle)
    expect(remaining(loadout).weapons[WeaponId.Rifle]).toBe(0)

    // The third request finds an empty rack and changes nothing.
    equipWeapon(loadout, 2, WeaponId.Rifle)
    expect(loadout[2]!.weaponId).toBe(WeaponId.Sniper)
  })

  test('keeping the weapon you already hold needs no spare', () => {
    const loadout = defaultLoadout()
    equipWeapon(loadout, 1, WeaponId.Rifle)
    expect(remaining(loadout).weapons[WeaponId.Rifle]).toBe(0)

    expect(canEquipWeapon(loadout, 1, WeaponId.Rifle)).toBe(true)
    equipWeapon(loadout, 1, WeaponId.Rifle)
    expect(loadout[1]!.weaponId).toBe(WeaponId.Rifle)
  })

  test('swapping a weapon puts the old one back in the crate', () => {
    const loadout = defaultLoadout()
    equipWeapon(loadout, 0, WeaponId.Rifle)

    equipWeapon(loadout, 1, WeaponId.Rifle) // member 1 drops the Gatling
    expect(remaining(loadout).weapons[WeaponId.Gatling]).toBe(2)
  })

  test('one soldier cannot carry more grenades than the cap', () => {
    const loadout = defaultLoadout()
    // Member 0 starts on one frag; the crate has flashes and smokes left.
    addGrenade(loadout, 0, GrenadeId.Flash)
    addGrenade(loadout, 0, GrenadeId.Smoke)
    addGrenade(loadout, 0, GrenadeId.Smoke)

    const carried =
      loadout[0]!.grenades[GrenadeId.Frag] +
      loadout[0]!.grenades[GrenadeId.Flash] +
      loadout[0]!.grenades[GrenadeId.Smoke]
    expect(carried).toBe(LOADOUT_LIMITS.grenadesPerUnit)
    expect(loadout[0]!.grenades[GrenadeId.Smoke]).toBe(1)
  })

  test('an emptied crate stops the next soldier taking one', () => {
    const loadout = defaultLoadout()
    addGrenade(loadout, 0, GrenadeId.Flash)
    addGrenade(loadout, 1, GrenadeId.Flash)
    addGrenade(loadout, 2, GrenadeId.Flash)
    expect(remaining(loadout).grenades[GrenadeId.Flash]).toBe(0)

    addGrenade(loadout, 3, GrenadeId.Flash)
    expect(loadout[3]!.grenades[GrenadeId.Flash]).toBe(0)
  })

  test('items obey their own cap and stock', () => {
    const loadout = defaultLoadout()
    addItem(loadout, 0, ItemId.StimPack)
    addItem(loadout, 0, ItemId.FirstAidKit)
    addItem(loadout, 0, ItemId.StimPack)

    expect(loadout[0]!.items[ItemId.StimPack]).toBe(1)
    expect(loadout[0]!.items[ItemId.FirstAidKit]).toBe(1)
    expect(remaining(loadout).items[ItemId.StimPack]).toBe(3)
  })
})

describe('Stamping a loadout onto a soldier', () => {
  test('kinds the player left out are zeroed, not left at their defaults', () => {
    const soldier = stubSoldier()

    applyUnitLoadout(soldier, {
      weaponId: WeaponId.Sniper,
      ammoId: AmmoId.ArmorPiercing,
      grenades: { [GrenadeId.Frag]: 2, [GrenadeId.Flash]: 0, [GrenadeId.Smoke]: 0 },
      items: { [ItemId.StimPack]: 0, [ItemId.FirstAidKit]: 2, [ItemId.NullweaveVest]: 0 },
    })

    expect(soldier.weaponId).toBe(WeaponId.Sniper)
    expect(soldier.ammoId).toBe(AmmoId.ArmorPiercing)
    expect(soldier.grenades).toEqual({
      [GrenadeId.Frag]: 2,
      [GrenadeId.Flash]: 0,
      [GrenadeId.Smoke]: 0,
    })
    expect(soldier.items).toEqual({
      [ItemId.StimPack]: 0,
      [ItemId.FirstAidKit]: 2,
      [ItemId.NullweaveVest]: 0,
    })
  })
})
