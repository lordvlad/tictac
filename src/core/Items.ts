import { StatusKind } from './Arsenal'

/**
 * Carried consumables: what a unit can spend a turn using on itself.
 *
 * An item is a name, an AP price and an ordered list of effects. Adding a new
 * item is data; adding a new *kind* of effect is one variant below and one
 * branch in {@link ItemSystem}. Nothing else needs to know items exist.
 */
export const ItemId = {
  StimPack: 'stim',
  FirstAidKit: 'firstAid',
} as const
export type ItemId = (typeof ItemId)[keyof typeof ItemId]

export type ItemEffect =
  /** Heal, capped at the unit's maximum. */
  | { kind: 'restoreHp'; amount: number }
  /** Repair armour, capped at the unit's maximum. */
  | { kind: 'restoreArmor'; amount: number }
  /** Top action points back up to the unit's current effective maximum. */
  | { kind: 'refillAp' }
  /** Clear every live status effect. */
  | { kind: 'clearStatuses' }
  /** Apply (or refresh) a status, carrying whatever that status does. */
  | { kind: 'applyStatus'; status: StatusKind }

export interface ItemSpec {
  id: ItemId
  name: string
  /** Action points spent using it. */
  apCost: number
  /**
   * Applied in order. `refillAp` after `applyStatus` matters: a status that
   * raises the maximum must be live before the top-up reads it.
   */
  effects: readonly ItemEffect[]
}

export const ITEMS: Record<ItemId, ItemSpec> = {
  [ItemId.StimPack]: {
    id: ItemId.StimPack,
    name: 'Stim Pack',
    apCost: 1,
    effects: [{ kind: 'applyStatus', status: StatusKind.Stimmed }, { kind: 'refillAp' }],
  },
  [ItemId.FirstAidKit]: {
    id: ItemId.FirstAidKit,
    name: 'First Aid Kit',
    apCost: 2,
    effects: [{ kind: 'restoreHp', amount: 50 }],
  },
}

/** Starting pouch, by item. */
export const STARTING_ITEMS: Record<ItemId, number> = {
  [ItemId.StimPack]: 1,
  [ItemId.FirstAidKit]: 1,
}
