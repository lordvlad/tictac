import { AmmoId, GrenadeId, WeaponId } from '../core/Arsenal'
import { ItemId } from '../core/Items'
import type { Soldier } from '../entities/Soldier'

/**
 * Pre-combat kit: what the squad takes into the match, and what is left in the
 * crate after handing it out.
 *
 * The pool is never stored as a running balance. Every "how many are left"
 * question is answered by {@link remaining}, which subtracts the whole squad's
 * assignments from the fixed inventory — so swapping a weapon returns the old
 * one with no refund bookkeeping, and no code path can leak or duplicate an
 * item by forgetting a decrement.
 */

/** One squad member's chosen kit. */
export interface UnitLoadout {
  weaponId: WeaponId
  ammoId: AmmoId
  grenades: Record<GrenadeId, number>
  items: Record<ItemId, number>
}

/** What the whole squad has to share out, by id. */
export interface Inventory {
  weapons: Record<WeaponId, number>
  ammo: Record<AmmoId, number>
  grenades: Record<GrenadeId, number>
  items: Record<ItemId, number>
}

/** The squad's kit, one entry per `squadIndex`. */
export type SquadLoadout = UnitLoadout[]

/**
 * The crate.
 *
 * Two of every weapon, because the default spread already holds one of each:
 * with a single spare the weapon list is a dead end, since freeing a Sniper
 * means re-arming its owner first. Grenades and consumables stay scarce —
 * twelve grenades for twelve carryable slots, against a per-soldier cap of
 * three — so kitting the squad out is still a set of choices.
 */
export const DEMO_INVENTORY: Inventory = {
  weapons: {
    [WeaponId.Rifle]: 2,
    [WeaponId.Shotgun]: 2,
    [WeaponId.Sniper]: 2,
    [WeaponId.Gatling]: 2,
  },
  ammo: {
    [AmmoId.Standard]: 4,
    [AmmoId.ArmorPiercing]: 3,
    [AmmoId.HollowPoint]: 3,
  },
  grenades: {
    [GrenadeId.Frag]: 6,
    [GrenadeId.Flash]: 3,
    [GrenadeId.Smoke]: 3,
  },
  items: {
    [ItemId.StimPack]: 4,
    [ItemId.FirstAidKit]: 4,
    // Fewer of the passive pieces than there are soldiers, so kitting one out
    // is a decision about which one rather than a formality.
    [ItemId.NullweaveVest]: 2,
    [ItemId.Scope]: 2,
    [ItemId.Bipod]: 2,
    [ItemId.Suppressor]: 2,
    [ItemId.PlateCarrier]: 2,
  },
}

/** Carry caps, so one soldier cannot hoover up the whole pouch. */
export const LOADOUT_LIMITS = { grenadesPerUnit: 3, itemsPerUnit: 2 } as const

/** The spread the squad has always deployed with, as a valid starting point. */
export function defaultLoadout(): SquadLoadout {
  const weapons = [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun] as const
  return weapons.map((weaponId) => ({
    weaponId,
    ammoId: AmmoId.Standard,
    grenades: { [GrenadeId.Frag]: 1, [GrenadeId.Flash]: 0, [GrenadeId.Smoke]: 0 },
    items: {
      [ItemId.StimPack]: 0,
      [ItemId.FirstAidKit]: 0,
      [ItemId.NullweaveVest]: 0,
      [ItemId.Scope]: 0,
      [ItemId.Bipod]: 0,
      [ItemId.Suppressor]: 0,
      [ItemId.PlateCarrier]: 0,
    },
  }))
}

/** The pool minus everything the squad is holding. Never negative. */
export function remaining(loadout: SquadLoadout, pool: Inventory = DEMO_INVENTORY): Inventory {
  const left: Inventory = {
    weapons: { ...pool.weapons },
    ammo: { ...pool.ammo },
    grenades: { ...pool.grenades },
    items: { ...pool.items },
  }

  for (const unit of loadout) {
    left.weapons[unit.weaponId] -= 1
    left.ammo[unit.ammoId] -= 1
    for (const kind of Object.values(GrenadeId)) left.grenades[kind] -= unit.grenades[kind] ?? 0
    for (const id of Object.values(ItemId)) left.items[id] -= unit.items[id] ?? 0
  }

  for (const id of Object.values(WeaponId)) left.weapons[id] = Math.max(0, left.weapons[id])
  for (const id of Object.values(AmmoId)) left.ammo[id] = Math.max(0, left.ammo[id])
  for (const id of Object.values(GrenadeId)) left.grenades[id] = Math.max(0, left.grenades[id])
  for (const id of Object.values(ItemId)) left.items[id] = Math.max(0, left.items[id])

  return left
}

/** Grenades this member is already carrying, across all kinds. */
export function grenadesCarried(unit: UnitLoadout): number {
  let total = 0
  for (const kind of Object.values(GrenadeId)) total += unit.grenades[kind] ?? 0
  return total
}

/** Consumables this member is already carrying, across all kinds. */
export function itemsCarried(unit: UnitLoadout): number {
  let total = 0
  for (const id of Object.values(ItemId)) total += unit.items[id] ?? 0
  return total
}

/** Keeping the weapon you already hold is always allowed, spare or not. */
export function canEquipWeapon(
  loadout: SquadLoadout,
  index: number,
  weaponId: WeaponId,
  pool?: Inventory,
): boolean {
  const unit = loadout[index]
  if (!unit) return false
  return unit.weaponId === weaponId || remaining(loadout, pool).weapons[weaponId] > 0
}

export function equipWeapon(
  loadout: SquadLoadout,
  index: number,
  weaponId: WeaponId,
  pool?: Inventory,
): void {
  if (!canEquipWeapon(loadout, index, weaponId, pool)) return
  loadout[index]!.weaponId = weaponId
}

export function canEquipAmmo(
  loadout: SquadLoadout,
  index: number,
  ammoId: AmmoId,
  pool?: Inventory,
): boolean {
  const unit = loadout[index]
  if (!unit) return false
  return unit.ammoId === ammoId || remaining(loadout, pool).ammo[ammoId] > 0
}

export function equipAmmo(
  loadout: SquadLoadout,
  index: number,
  ammoId: AmmoId,
  pool?: Inventory,
): void {
  if (!canEquipAmmo(loadout, index, ammoId, pool)) return
  loadout[index]!.ammoId = ammoId
}

export function canAddGrenade(
  loadout: SquadLoadout,
  index: number,
  kind: GrenadeId,
  pool?: Inventory,
): boolean {
  const unit = loadout[index]
  if (!unit) return false
  if (grenadesCarried(unit) >= LOADOUT_LIMITS.grenadesPerUnit) return false
  return remaining(loadout, pool).grenades[kind] > 0
}

export function addGrenade(
  loadout: SquadLoadout,
  index: number,
  kind: GrenadeId,
  pool?: Inventory,
): void {
  if (!canAddGrenade(loadout, index, kind, pool)) return
  loadout[index]!.grenades[kind] += 1
}

export function removeGrenade(loadout: SquadLoadout, index: number, kind: GrenadeId): void {
  const unit = loadout[index]
  if (!unit || unit.grenades[kind] <= 0) return
  unit.grenades[kind] -= 1
}

export function canAddItem(
  loadout: SquadLoadout,
  index: number,
  id: ItemId,
  pool?: Inventory,
): boolean {
  const unit = loadout[index]
  if (!unit) return false
  if (itemsCarried(unit) >= LOADOUT_LIMITS.itemsPerUnit) return false
  return remaining(loadout, pool).items[id] > 0
}

export function addItem(
  loadout: SquadLoadout,
  index: number,
  id: ItemId,
  pool?: Inventory,
): void {
  if (!canAddItem(loadout, index, id, pool)) return
  loadout[index]!.items[id] += 1
}

export function removeItem(loadout: SquadLoadout, index: number, id: ItemId): void {
  const unit = loadout[index]
  if (!unit || unit.items[id] <= 0) return
  unit.items[id] -= 1
}

/**
 * Stamp a chosen kit onto a soldier.
 *
 * Every grenade and item kind is written, zeros included: a fresh
 * `InventoryComponent` carries one of each grenade and `ItemsComponent` starts
 * from `STARTING_ITEMS`, so anything left unwritten keeps a default the player
 * never asked for.
 */
export function applyUnitLoadout(soldier: Soldier, unit: UnitLoadout): void {
  soldier.equip(unit.weaponId, unit.ammoId)
  for (const kind of Object.values(GrenadeId)) soldier.grenades[kind] = unit.grenades[kind] ?? 0
  for (const id of Object.values(ItemId)) soldier.items[id] = unit.items[id] ?? 0
  // The pouch decides which worn gear is in force, so the traits it grants are
  // only known once it has been stamped.
  soldier.refreshTraits()
}
