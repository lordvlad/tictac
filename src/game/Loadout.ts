import { MeleeId } from '../core/Melee'
import { AmmoId, GRENADES, GrenadeId, WEAPONS, WeaponId } from '../core/Arsenal'
import { ATTACHMENTS, AttachmentId } from '../core/Attachments'
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

/**
 * One squad member's chosen kit.
 *
 * Attachments are a list rather than a count map: a rail either carries one of
 * a thing or it does not, and the weapon refuses a second of the same kind.
 */
export interface UnitLoadout {
  weaponId: WeaponId
  ammoId: AmmoId
  grenades: Record<GrenadeId, number>
  items: Record<ItemId, number>
  attachments: AttachmentId[]
  /**
   * The sidearm slot, beside the primary weapon rather than instead of it.
   * {@link MeleeId.Fists} is the empty slot: nothing to carry, always there.
   */
  sidearm: MeleeId
}

/** What the whole squad has to share out, by id. */
export interface Inventory {
  weapons: Record<WeaponId, number>
  ammo: Record<AmmoId, number>
  grenades: Record<GrenadeId, number>
  items: Record<ItemId, number>
  attachments: Record<AttachmentId, number>
  /**
   * Keyed by every {@link MeleeId} so the crate reads like the other tables,
   * but the {@link MeleeId.Fists} entry means nothing: fists are the empty
   * slot, never come out of the crate and never run out, and every piece of
   * accounting below skips them rather than trusting whatever number is here.
   */
  sidearms: Record<MeleeId, number>
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
    // Issued to every soldier instead (`GrenadeSpec.issued`): nobody packs a stone.
    [GrenadeId.Stone]: 0,
    [GrenadeId.Incendiary]: 2,
  },
  items: {
    [ItemId.StimPack]: 4,
    [ItemId.FirstAidKit]: 4,
    // Fewer of the passive pieces than there are soldiers, so kitting one out
    // is a decision about which one rather than a formality.
    [ItemId.NullweaveVest]: 2,
    [ItemId.PlateCarrier]: 2,
    // Two repair kits for the same reason, from the other direction: the kit
    // asks for Intelligence before it will work at all, so a stock matching
    // the squad would put one in a pouch that cannot use it.
    [ItemId.RepairKit]: 2,
    // One set of keys each side of a pair: a locked door is quiet and cheap to
    // whoever has them, and a shoulder or a window to everyone else.
    [ItemId.Keys]: 2,
  },
  // Two of each mod against ten rail slots across the squad: enough to make
  // fitting one a choice about which weapon deserves it.
  attachments: {
    [AttachmentId.Scope]: 2,
    [AttachmentId.Bipod]: 2,
    [AttachmentId.Suppressor]: 2,
  },
  // Half as many blades as soldiers, and as many clubs: arming one member for
  // contact is cheap, arming everyone is not on offer, so a sidearm goes to
  // whoever is going to end up next to someone.
  sidearms: {
    [MeleeId.Fists]: 0,
    [MeleeId.Knife]: 2,
    [MeleeId.Club]: 2,
  },
}

/** Grenade cap, so one soldier cannot hoover up the whole pouch. */
export const LOADOUT_LIMITS = { grenadesPerUnit: 3 } as const

/** The spread the squad has always deployed with, as a valid starting point. */
export function defaultLoadout(): SquadLoadout {
  const weapons = [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun] as const
  return weapons.map((weaponId) => ({
    weaponId,
    ammoId: AmmoId.Standard,
    grenades: {
      [GrenadeId.Frag]: 1,
      [GrenadeId.Flash]: 0,
      [GrenadeId.Smoke]: 0,
      [GrenadeId.Stone]: 0,
      [GrenadeId.Incendiary]: 0,
    },
    items: {
      [ItemId.StimPack]: 0,
      [ItemId.FirstAidKit]: 0,
      [ItemId.NullweaveVest]: 0,
      [ItemId.PlateCarrier]: 0,
      [ItemId.RepairKit]: 0,
      [ItemId.Keys]: 0,
    },
    attachments: [],
    sidearm: MeleeId.Fists,
  }))
}

/** The pool minus everything the squad is holding. Never negative. */
export function remaining(loadout: SquadLoadout, pool: Inventory = DEMO_INVENTORY): Inventory {
  const left: Inventory = {
    weapons: { ...pool.weapons },
    ammo: { ...pool.ammo },
    grenades: { ...pool.grenades },
    items: { ...pool.items },
    attachments: { ...pool.attachments },
    sidearms: { ...pool.sidearms },
  }

  for (const unit of loadout) {
    left.weapons[unit.weaponId] -= 1
    left.ammo[unit.ammoId] -= 1
    for (const kind of Object.values(GrenadeId)) left.grenades[kind] -= unit.grenades[kind] ?? 0
    for (const id of Object.values(ItemId)) left.items[id] -= unit.items[id] ?? 0
    for (const id of unit.attachments) left.attachments[id] -= 1
    // Fists are carried by everyone and owed to nobody.
    if (unit.sidearm !== MeleeId.Fists) left.sidearms[unit.sidearm] -= 1
  }

  for (const id of Object.values(WeaponId)) left.weapons[id] = Math.max(0, left.weapons[id])
  for (const id of Object.values(AmmoId)) left.ammo[id] = Math.max(0, left.ammo[id])
  for (const id of Object.values(GrenadeId)) left.grenades[id] = Math.max(0, left.grenades[id])
  for (const id of Object.values(ItemId)) left.items[id] = Math.max(0, left.items[id])
  for (const id of Object.values(AttachmentId)) {
    left.attachments[id] = Math.max(0, left.attachments[id])
  }
  for (const id of Object.values(MeleeId)) left.sidearms[id] = Math.max(0, left.sidearms[id])

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

/**
 * The rail this member is carrying: how much of it is spoken for, and how big
 * it is. Read off the weapon class, since that is where slots live.
 */
export function railSpace(unit: UnitLoadout): { used: number; total: number } {
  let used = 0
  for (const id of unit.attachments) used += ATTACHMENTS[id].slots
  return { used, total: WEAPONS[unit.weaponId].slots }
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
  const unit = loadout[index]!
  unit.weaponId = weaponId

  // Trading three slots of rifle for one of shotgun cannot leave two mods
  // hanging off nothing. The overflow is dropped from the end, so the mods
  // chosen first survive the swap, and no refund is needed: `remaining` counts
  // what is listed, so anything dropped is back in the crate by definition.
  const total = WEAPONS[weaponId].slots
  let used = 0
  for (let at = 0; at < unit.attachments.length; at++) {
    used += ATTACHMENTS[unit.attachments[at]!].slots
    if (used > total) {
      unit.attachments.length = at
      return
    }
  }
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

/**
 * Same shape as {@link canEquipWeapon}: keeping what you hold is always
 * allowed. Fists are always allowed as well — putting a knife back is
 * emptying the slot, and an empty slot is never short of stock.
 */
export function canEquipSidearm(
  loadout: SquadLoadout,
  index: number,
  id: MeleeId,
  pool?: Inventory,
): boolean {
  const unit = loadout[index]
  if (!unit) return false
  if (id === MeleeId.Fists || unit.sidearm === id) return true
  return remaining(loadout, pool).sidearms[id] > 0
}

export function equipSidearm(
  loadout: SquadLoadout,
  index: number,
  id: MeleeId,
  pool?: Inventory,
): void {
  if (!canEquipSidearm(loadout, index, id, pool)) return
  loadout[index]!.sidearm = id
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

/**
 * Room in the pouch, and one still in the crate.
 *
 * The consumable cap is an argument rather than an entry in
 * {@link LOADOUT_LIMITS} because it belongs to the person: it is `carrySlots`
 * off the holder's derived stats, so two members of the same squad answer
 * differently. Required, and deliberately not defaulted — a fallback here
 * would be the old global rule wearing a parameter's clothes, and the caller
 * that forgot to ask the sheet would never find out.
 */
export function canAddItem(
  loadout: SquadLoadout,
  index: number,
  id: ItemId,
  carrySlots: number,
  pool?: Inventory,
): boolean {
  const unit = loadout[index]
  if (!unit) return false
  if (itemsCarried(unit) >= carrySlots) return false
  return remaining(loadout, pool).items[id] > 0
}

export function addItem(
  loadout: SquadLoadout,
  index: number,
  id: ItemId,
  carrySlots: number,
  pool?: Inventory,
): void {
  if (!canAddItem(loadout, index, id, carrySlots, pool)) return
  loadout[index]!.items[id] += 1
}

export function removeItem(loadout: SquadLoadout, index: number, id: ItemId): void {
  const unit = loadout[index]
  if (!unit || unit.items[id] <= 0) return
  unit.items[id] -= 1
}

/**
 * Room on the rail, one in the crate, and not already fitted.
 *
 * Duplicates are refused for the same reason the weapon itself refuses them: a
 * second scope is not more glass, and the trait fold would count it twice.
 */
export function canFitAttachment(
  loadout: SquadLoadout,
  index: number,
  id: AttachmentId,
  pool?: Inventory,
): boolean {
  const unit = loadout[index]
  if (!unit || unit.attachments.includes(id)) return false
  const rail = railSpace(unit)
  if (ATTACHMENTS[id].slots > rail.total - rail.used) return false
  return remaining(loadout, pool).attachments[id] > 0
}

export function fitAttachment(
  loadout: SquadLoadout,
  index: number,
  id: AttachmentId,
  pool?: Inventory,
): void {
  if (!canFitAttachment(loadout, index, id, pool)) return
  loadout[index]!.attachments.push(id)
}

export function unfitAttachment(loadout: SquadLoadout, index: number, id: AttachmentId): void {
  const unit = loadout[index]
  if (!unit) return
  const at = unit.attachments.indexOf(id)
  if (at < 0) return
  unit.attachments.splice(at, 1)
}

/**
 * Stamp a chosen kit onto a soldier.
 *
 * Every grenade and item kind is written, zeros included: a fresh
 * `InventoryComponent` carries one of each grenade and `ItemsComponent` starts
 * from `STARTING_ITEMS`, so anything left unwritten keeps a default the player
 * never asked for.
 *
 * Attachments go on last, and only through the soldier: `equip` hands the unit
 * a fresh clone of the weapon template with a bare rail, so nothing fitted
 * before the swap can survive it.
 */
export function applyUnitLoadout(soldier: Soldier, unit: UnitLoadout): void {
  soldier.equip(unit.weaponId, unit.ammoId)
  // What was packed, plus what everybody has anyway.
  for (const kind of Object.values(GrenadeId)) {
    soldier.grenades[kind] = (unit.grenades[kind] ?? 0) + GRENADES[kind].issued
  }
  for (const id of Object.values(ItemId)) soldier.items[id] = unit.items[id] ?? 0
  // The pouch decides which worn gear is in force, so the traits it grants are
  // only known once it has been stamped. `equip` and every `fitAttachment`
  // refold as well, which is why the pouch is written before the rail: each
  // refold has to see the finished kit.
  soldier.refreshTraits()
  for (const id of unit.attachments) soldier.fitAttachment(id)
  soldier.sidearm = unit.sidearm
}
