import { describe, expect, test } from 'bun:test'
import { MeleeId } from '../src/core/Melee'
import { AmmoId, GRENADES, GrenadeId, WEAPONS, type Weapon, WeaponId } from '../src/core/Arsenal'
import { ATTACHMENTS, AttachmentId } from '../src/core/Attachments'
import { ITEMS, ItemId } from '../src/core/Items'
import { resolveTraits, type TraitId } from '../src/core/Traits'
import {
  LOADOUT_LIMITS,
  addGrenade,
  addItem,
  canAddItem,
  itemsCarried,
  applyUnitLoadout,
  canEquipSidearm,
  canEquipWeapon,
  canFitAttachment,
  defaultLoadout,
  equipSidearm,
  equipWeapon,
  fitAttachment,
  remaining,
} from '../src/game/Loadout'
import { squadLoadoutFrom } from '../src/game/Recording'
import type { Soldier } from '../src/entities/Soldier'

/**
 * The slice of a soldier a loadout is stamped onto. A real `Soldier` needs a
 * loaded glTF and an engine context, so the test stands in an object with the
 * same contract — including the component defaults the stamp has to overwrite.
 *
 * `equip` and `refreshTraits` do what the real ones do rather than nothing:
 * handing out a fresh clone of the template and refolding the kit is what makes
 * the stamp's order observable, and getting it wrong is the failure this file
 * is here to catch.
 */
function stubSoldier() {
  const soldier = {
    weaponId: WeaponId.Rifle as WeaponId,
    ammoId: AmmoId.Standard as AmmoId,
    weapon: WEAPONS[WeaponId.Rifle].clone() as Weapon,
    // What a fresh InventoryComponent / ItemsComponent hands out.
    grenades: { [GrenadeId.Frag]: 1, [GrenadeId.Flash]: 1, [GrenadeId.Smoke]: 1 },
    items: {
      [ItemId.StimPack]: 1,
      [ItemId.FirstAidKit]: 1,
      [ItemId.NullweaveVest]: 0,
      [ItemId.PlateCarrier]: 0,
      [ItemId.RepairKit]: 0,
    },
    traits: resolveTraits([]),
    equip(weaponId: WeaponId, ammoId: AmmoId): void {
      soldier.weaponId = weaponId
      soldier.ammoId = ammoId
      // A different weapon is a different rail: `WeaponComponent.equip` hands
      // out a clone of the template, which carries nothing.
      soldier.weapon = WEAPONS[weaponId].clone()
      soldier.refreshTraits()
    },
    fitAttachment(id: AttachmentId): boolean {
      if (!soldier.weapon.fit(id)) return false
      soldier.refreshTraits()
      return true
    },
    // Worn gear and bolted-on gear are both trait sources, folded together.
    refreshTraits(): void {
      const ids: TraitId[] = []
      for (const id of Object.values(ItemId)) {
        if (soldier.items[id] <= 0) continue
        for (const granted of ITEMS[id].traits ?? []) ids.push(granted)
      }
      for (const id of soldier.weapon.attachments) ids.push(...ATTACHMENTS[id].traits)
      soldier.traits = resolveTraits(ids)
    },
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
      [GrenadeId.Stone]: 0,
      [GrenadeId.Incendiary]: 2,
    })
    expect(left.items).toEqual({
      [ItemId.StimPack]: 4,
      [ItemId.FirstAidKit]: 4,
      [ItemId.NullweaveVest]: 2,
      [ItemId.PlateCarrier]: 2,
      [ItemId.RepairKit]: 2,
    })
    expect(left.attachments).toEqual({
      [AttachmentId.Scope]: 2,
      [AttachmentId.Bipod]: 2,
      [AttachmentId.Suppressor]: 2,
    })
    // Everyone starts bare-handed, so the whole rack is still on offer.
    expect(left.sidearms).toEqual({
      [MeleeId.Fists]: 0,
      [MeleeId.Knife]: 2,
      [MeleeId.Club]: 2,
    })
  })

  test('every item kind is stocked, and reaches a pouch', () => {
    // The gap ITEM-013 was filed over: an effect with no item carrying it is
    // unreachable in play, and an item the crate holds none of is the same
    // dead end one step later. Generalised over the enum so a new id has to
    // be stocked, not just declared.
    const stock = remaining(defaultLoadout()).items

    for (const id of Object.values(ItemId)) {
      expect(stock[id]).toBeGreaterThan(0)

      const loadout = defaultLoadout()
      addItem(loadout, 0, id, 1)
      expect(loadout[0]!.items[id]).toBe(1)
    }
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

  test('items obey the carrier and the stock, not a global cap', () => {
    // The cap is the character's, so the same three clicks land differently on
    // a strong soldier and a weak one - and nothing in here knows a number
    // that applies to everybody.
    const loadout = defaultLoadout()
    addItem(loadout, 0, ItemId.StimPack, 2)
    addItem(loadout, 0, ItemId.FirstAidKit, 2)
    addItem(loadout, 0, ItemId.StimPack, 2)

    expect(itemsCarried(loadout[0]!)).toBe(2)
    expect(loadout[0]!.items[ItemId.StimPack]).toBe(1)
    expect(loadout[0]!.items[ItemId.FirstAidKit]).toBe(1)
    expect(remaining(loadout).items[ItemId.StimPack]).toBe(3)

    const weak = defaultLoadout()
    addItem(weak, 0, ItemId.StimPack, 1)
    addItem(weak, 0, ItemId.FirstAidKit, 1)
    expect(itemsCarried(weak[0]!)).toBe(1)

    const strong = defaultLoadout()
    for (const id of [ItemId.StimPack, ItemId.FirstAidKit, ItemId.StimPack]) {
      addItem(strong, 0, id, 3)
    }
    expect(itemsCarried(strong[0]!)).toBe(3)
  })

  test('a character cannot be handed a slot they do not have', () => {
    const loadout = defaultLoadout()
    expect(canAddItem(loadout, 0, ItemId.StimPack, 1)).toBe(true)
    addItem(loadout, 0, ItemId.StimPack, 1)
    expect(canAddItem(loadout, 0, ItemId.FirstAidKit, 1)).toBe(false)
    // The same loadout, a stronger carrier: the crate is not what stopped it.
    expect(canAddItem(loadout, 0, ItemId.FirstAidKit, 2)).toBe(true)
  })
})

/**
 * The sidearm slot shares the crate on the same terms as the primary, with
 * one difference that every rule below has to respect: fists are the empty
 * slot. They are not stock, so choosing them can never be refused and never
 * leaves the crate any poorer.
 */
describe('Sidearms', () => {
  test('equipping a knife takes one from the crate', () => {
    const loadout = defaultLoadout()
    const before = remaining(loadout).sidearms[MeleeId.Knife]

    equipSidearm(loadout, 0, MeleeId.Knife)
    expect(loadout[0]!.sidearm).toBe(MeleeId.Knife)
    expect(remaining(loadout).sidearms[MeleeId.Knife]).toBe(before - 1)
  })

  test('the last knife cannot be taken twice', () => {
    const loadout = defaultLoadout()
    // Hand the crate out until exactly one blade is left in it.
    let at = 0
    while (remaining(loadout).sidearms[MeleeId.Knife] > 1) equipSidearm(loadout, at++, MeleeId.Knife)

    equipSidearm(loadout, at, MeleeId.Knife)
    expect(loadout[at]!.sidearm).toBe(MeleeId.Knife)
    expect(remaining(loadout).sidearms[MeleeId.Knife]).toBe(0)

    // The next member finds an empty sheath and is left as they were...
    expect(canEquipSidearm(loadout, at + 1, MeleeId.Knife)).toBe(false)
    equipSidearm(loadout, at + 1, MeleeId.Knife)
    expect(loadout[at + 1]!.sidearm).toBe(MeleeId.Fists)

    // ...while the one holding it may keep it, spare or not.
    expect(canEquipSidearm(loadout, at, MeleeId.Knife)).toBe(true)
  })

  test('fists never deplete anything', () => {
    const loadout = defaultLoadout()
    const before = remaining(loadout)

    // A crate with no fists in it at all still arms everyone with them, and
    // arming everyone with them leaves every count where it was.
    for (let at = 0; at < loadout.length; at++) {
      expect(canEquipSidearm(loadout, at, MeleeId.Fists)).toBe(true)
      equipSidearm(loadout, at, MeleeId.Fists)
    }
    expect(remaining(loadout)).toEqual(before)

    // And the empty slot is on offer to someone holding a blade, even with
    // the crate's fists entry zeroed: putting a knife back is not a withdrawal.
    equipSidearm(loadout, 0, MeleeId.Knife)
    expect(canEquipSidearm(loadout, 0, MeleeId.Fists)).toBe(true)
    equipSidearm(loadout, 0, MeleeId.Fists)
    expect(remaining(loadout)).toEqual(before)
  })

  test('swapping a knife for a club puts the knife back', () => {
    const loadout = defaultLoadout()
    const before = remaining(loadout).sidearms
    equipSidearm(loadout, 0, MeleeId.Knife)

    equipSidearm(loadout, 0, MeleeId.Club)
    expect(loadout[0]!.sidearm).toBe(MeleeId.Club)
    const after = remaining(loadout).sidearms
    expect(after[MeleeId.Knife]).toBe(before[MeleeId.Knife])
    expect(after[MeleeId.Club]).toBe(before[MeleeId.Club] - 1)
  })

  test('a squad’s sidearms survive the wire check', () => {
    // The same validation a peer's `ready` and a replay header go through:
    // a knife that came back as fists would change who can open a throat.
    const loadout = defaultLoadout()
    equipSidearm(loadout, 0, MeleeId.Knife)
    equipSidearm(loadout, 2, MeleeId.Club)

    const parsed = squadLoadoutFrom(JSON.parse(JSON.stringify(loadout)), 'test')
    expect(parsed.map((unit) => unit.sidearm)).toEqual(loadout.map((unit) => unit.sidearm))
  })

  test('an unknown sidearm is refused, not disarmed', () => {
    const tampered = JSON.parse(JSON.stringify(defaultLoadout()))
    tampered[1].sidearm = 'chainsaw'
    expect(() => squadLoadoutFrom(tampered, 'test')).toThrow(/chainsaw/)
  })
})

/**
 * The default spread is Rifle (3 slots), Gatling (2), Sniper (3), Shotgun (1),
 * which is what makes the rail rules visible: the same mod is a free choice on
 * one member and impossible on another.
 */
describe('Weapon rails', () => {
  test('the crate limits how many of one mod the squad can fit', () => {
    const loadout = defaultLoadout()
    fitAttachment(loadout, 0, AttachmentId.Scope)
    fitAttachment(loadout, 2, AttachmentId.Scope)
    expect(remaining(loadout).attachments[AttachmentId.Scope]).toBe(0)

    // Two scopes in the crate, and the third member has room for one.
    fitAttachment(loadout, 1, AttachmentId.Scope)
    expect(loadout[1]!.attachments).toEqual([])
  })

  test('a rail refuses a second of the same mod', () => {
    const loadout = defaultLoadout()
    fitAttachment(loadout, 0, AttachmentId.Scope)

    expect(canFitAttachment(loadout, 0, AttachmentId.Scope)).toBe(false)
    fitAttachment(loadout, 0, AttachmentId.Scope)
    expect(loadout[0]!.attachments).toEqual([AttachmentId.Scope])
  })

  test('a rail refuses one more than it has room for', () => {
    const loadout = defaultLoadout()
    // Member 1 carries the Gatling: a bipod mount and one other thing.
    fitAttachment(loadout, 1, AttachmentId.Scope)
    fitAttachment(loadout, 1, AttachmentId.Bipod)

    expect(canFitAttachment(loadout, 1, AttachmentId.Suppressor)).toBe(false)
    fitAttachment(loadout, 1, AttachmentId.Suppressor)
    expect(loadout[1]!.attachments).toEqual([AttachmentId.Scope, AttachmentId.Bipod])
  })

  test('a one-slot shotgun refuses what a three-slot rifle accepts', () => {
    const loadout = defaultLoadout()
    fitAttachment(loadout, 3, AttachmentId.Scope) // the Shotgun's only slot

    expect(canFitAttachment(loadout, 3, AttachmentId.Bipod)).toBe(false)
    expect(canFitAttachment(loadout, 0, AttachmentId.Bipod)).toBe(true)
  })

  test('downgrading the weapon trims the overflow back into the crate', () => {
    const loadout = defaultLoadout()
    fitAttachment(loadout, 0, AttachmentId.Scope)
    fitAttachment(loadout, 0, AttachmentId.Bipod)
    fitAttachment(loadout, 0, AttachmentId.Suppressor)
    expect(loadout[0]!.attachments).toHaveLength(3)

    // Three slots of rifle for one of shotgun: the two chosen last come off.
    equipWeapon(loadout, 0, WeaponId.Shotgun)

    expect(loadout[0]!.attachments).toEqual([AttachmentId.Scope])
    const left = remaining(loadout).attachments
    expect(left[AttachmentId.Bipod]).toBe(2)
    expect(left[AttachmentId.Suppressor]).toBe(2)
    expect(left[AttachmentId.Scope]).toBe(1)
  })

  test('trading up leaves what was already fitted alone', () => {
    const loadout = defaultLoadout()
    fitAttachment(loadout, 3, AttachmentId.Scope)

    equipWeapon(loadout, 3, WeaponId.Sniper)

    expect(loadout[3]!.attachments).toEqual([AttachmentId.Scope])
    expect(canFitAttachment(loadout, 3, AttachmentId.Bipod)).toBe(true)
  })
})

describe('Stamping a loadout onto a soldier', () => {
  test('kinds the player left out are zeroed, and what everybody is issued is added', () => {
    const soldier = stubSoldier()

    applyUnitLoadout(soldier, {
      weaponId: WeaponId.Sniper,
      ammoId: AmmoId.ArmorPiercing,
      grenades: { [GrenadeId.Frag]: 2, [GrenadeId.Flash]: 0, [GrenadeId.Smoke]: 0, [GrenadeId.Stone]: 0, [GrenadeId.Incendiary]: 0 },
      items: {
        [ItemId.StimPack]: 0,
        [ItemId.FirstAidKit]: 2,
        [ItemId.NullweaveVest]: 0,
        [ItemId.PlateCarrier]: 0,
        [ItemId.RepairKit]: 0,
      },
      attachments: [],
      sidearm: MeleeId.Fists,
    })

    expect(soldier.weaponId).toBe(WeaponId.Sniper)
    expect(soldier.ammoId).toBe(AmmoId.ArmorPiercing)
    expect(soldier.grenades).toEqual({
      [GrenadeId.Frag]: 2,
      [GrenadeId.Flash]: 0,
      [GrenadeId.Smoke]: 0,
      // Nobody packs stones; every soldier has a couple.
      [GrenadeId.Stone]: GRENADES[GrenadeId.Stone].issued,
      [GrenadeId.Incendiary]: 0,
    })
    expect(soldier.items).toEqual({
      [ItemId.StimPack]: 0,
      [ItemId.FirstAidKit]: 2,
      [ItemId.NullweaveVest]: 0,
      [ItemId.PlateCarrier]: 0,
      [ItemId.RepairKit]: 0,
    })
    expect(soldier.weapon.attachments).toEqual([])
  })

  test('the weapon carries exactly what was fitted, and its traits are in force', () => {
    const soldier = stubSoldier()

    applyUnitLoadout(soldier, {
      weaponId: WeaponId.Sniper,
      ammoId: AmmoId.Standard,
      grenades: { [GrenadeId.Frag]: 0, [GrenadeId.Flash]: 0, [GrenadeId.Smoke]: 0, [GrenadeId.Stone]: 0, [GrenadeId.Incendiary]: 0 },
      items: {
        [ItemId.StimPack]: 0,
        [ItemId.FirstAidKit]: 0,
        [ItemId.NullweaveVest]: 0,
        [ItemId.PlateCarrier]: 0,
        [ItemId.RepairKit]: 0,
      },
      attachments: [AttachmentId.Scope, AttachmentId.Suppressor],
      sidearm: MeleeId.Fists,
    })

    expect(soldier.weapon.attachments).toEqual([AttachmentId.Scope, AttachmentId.Suppressor])
    expect(soldier.weapon.slotsFree).toBe(1)
    // The glass has to reach the fold, not just the rail: a scope the soldier
    // cannot feel is a scope the shot preview will price wrong.
    expect(soldier.traits.rangeFalloff).toBeLessThan(0)
  })
})
