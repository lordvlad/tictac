import { AttachmentId } from './Attachments'
import { WeaponId } from './Arsenal'
import { ItemId } from './Items'
import { TraitId } from './Traits'

/**
 * Battlefield specialisation, chosen on the loadout screen.
 *
 * {@link RoleId.Rifleman} is the squad's default: no training beyond the
 * basic course, so no gate on the crate and no trait to show for it. The
 * other three each narrow a soldier to a slice of the crate and pay it back
 * with one trait, folded in the same way worn gear is.
 */
export const RoleId = {
  Rifleman: 'rifleman',
  Medic: 'medic',
  Scout: 'scout',
  Marksman: 'marksman',
} as const
export type RoleId = (typeof RoleId)[keyof typeof RoleId]

/**
 * What a role restricts and what it grants.
 *
 * `weapons`/`attachments`/`items` absent means unrestricted — the row reads
 * exactly as it does without a role. Present, they are the *only* ids
 * `canEquipWeapon`, `canFitAttachment` and `canAddItem` (`game/Loadout`) will
 * approve for a unit holding this role, on top of the usual stock check.
 */
export interface RoleSpec {
  id: RoleId
  name: string
  description: string
  weapons?: readonly WeaponId[]
  attachments?: readonly AttachmentId[]
  items?: readonly ItemId[]
  /** The one trait this role's training earns, or none for {@link RoleId.Rifleman}. */
  trait?: TraitId
}

export const ROLES: Record<RoleId, RoleSpec> = {
  [RoleId.Rifleman]: {
    id: RoleId.Rifleman,
    name: 'Rifleman',
    description: 'No specialist training: draws from the whole crate, and does nothing with it that another role would not.',
  },
  [RoleId.Medic]: {
    id: RoleId.Medic,
    name: 'Medic',
    description:
      'Trained on the aid kit, not the rack: a rifle or shotgun, and nothing from the crate but what treats a wound. Never bleeds.',
    weapons: [WeaponId.Rifle, WeaponId.Shotgun],
    items: [ItemId.StimPack, ItemId.FirstAidKit, ItemId.RepairKit],
    trait: TraitId.RoleMedic,
  },
  [RoleId.Scout]: {
    id: RoleId.Scout,
    name: 'Scout',
    description:
      'Travels light: a rifle or shotgun, a suppressor if anything goes on the rail, and moves like it — +6 evasion, cheaper steps.',
    weapons: [WeaponId.Rifle, WeaponId.Shotgun],
    attachments: [AttachmentId.Suppressor],
    trait: TraitId.RoleScout,
  },
  [RoleId.Marksman]: {
    id: RoleId.Marksman,
    name: 'Marksman',
    description:
      'Built around the long gun: a rifle or sniper, glass or a bipod, and distance costs less.',
    weapons: [WeaponId.Rifle, WeaponId.Sniper],
    attachments: [AttachmentId.Scope, AttachmentId.Bipod],
    trait: TraitId.RoleMarksman,
  },
}

export function roleAllowsWeapon(role: RoleId, id: WeaponId): boolean {
  const rows = ROLES[role].weapons
  return rows === undefined || rows.includes(id)
}

export function roleAllowsAttachment(role: RoleId, id: AttachmentId): boolean {
  const rows = ROLES[role].attachments
  return rows === undefined || rows.includes(id)
}

export function roleAllowsItem(role: RoleId, id: ItemId): boolean {
  const rows = ROLES[role].items
  return rows === undefined || rows.includes(id)
}
