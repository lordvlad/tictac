import { SQUAD_SIZE } from '../config'
import { AmmoId, GrenadeId, WeaponId } from './Arsenal'
import type { AttachmentId } from './Attachments'
import type { CharacterSheet } from './Characters'
import { ItemId } from './Items'
import { MeleeId } from './Melee'
import { RoleId } from './Roles'

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
  /**
   * What this member has trained for. Gates which crate rows they may draw
   * from ({@link ROLES}) and grants the one trait that training earns them.
   * {@link RoleId.Rifleman} is the empty slot: no gate, no trait.
   */
  role: RoleId
}

/** The squad's kit, one entry per `squadIndex`. */
export type SquadLoadout = UnitLoadout[]

/**
 * The spread the squad has always deployed with, as a valid starting point —
 * for the first `size` members, which is fewer than a full squad when a kept
 * roster has an empty slot.
 */
export function defaultLoadout(size = SQUAD_SIZE): SquadLoadout {
  const weapons = [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun] as const
  return weapons.slice(0, size).map((weaponId) => ({
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
    role: RoleId.Rifleman,
  }))
}

export interface DeploymentState {
  hp?: number
  fatigue?: number
}

/**
 * One soldier, fully stated: who they are, what they carry, and what state a
 * match starts them in — sheet, kit and session state travel together rather
 * than as three arrays a caller has to keep in step by hand.
 */
export interface Deployment {
  /** Present only for a kept roster (`[ITEM-042]`); absent for a rolled squad. */
  characterId?: string
  sheet: CharacterSheet
  /**
   * Absent when this soldier's stated kit could not be read (a peer on a
  * newer build naming a weapon this one does not know): they deploy on the
   * stock spread, the same as a soldier nobody ever equipped.
   */
  loadout?: UnitLoadout
  state?: DeploymentState
}
