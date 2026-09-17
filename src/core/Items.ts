import { StatusKind } from './Arsenal'
import { TraitId } from './Traits'

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
  NullweaveVest: 'nullweave',
  PlateCarrier: 'plate',
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
  /**
   * Traits the unit has while it is carrying one of these.
   *
   * This is how a piece of kit grants what a character could also have been
   * born with: both ends feed the same fold in {@link Traits}, so nothing in
   * combat asks where a modifier came from.
   */
  traits?: readonly TraitId[]
  /**
   * Worn, not used: it has no action of its own and never appears in the unit's
   * action panel. It earns its slot by what carrying it does.
   */
  passive?: boolean
}

/**
 * What using this item actually costs *this* character.
 *
 * Intelligence is the difference: technical literacy shows up as getting more
 * out of the same kit, and the cheapest way to say that with the items which
 * exist today is the price of working one. Floored at a point, so no character
 * ever uses gear for free - an item is always a decision about the turn.
 *
 * Shared rather than computed at each call site because the HUD prints this
 * number and the system charges it; the two drifting would make the panel lie.
 */
export function itemApCost(spec: ItemSpec, apDelta: number): number {
  return Math.max(1, spec.apCost + apDelta)
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
  [ItemId.NullweaveVest]: {
    id: ItemId.NullweaveVest,
    name: 'Nullweave Vest',
    apCost: 0,
    effects: [],
    traits: [TraitId.Nullweave],
    passive: true,
  },
  [ItemId.PlateCarrier]: {
    id: ItemId.PlateCarrier,
    name: 'Plate Carrier',
    apCost: 0,
    effects: [],
    traits: [TraitId.Plated],
    passive: true,
  },
}

/** Starting pouch, by item. */
export const STARTING_ITEMS: Record<ItemId, number> = {
  [ItemId.StimPack]: 1,
  [ItemId.FirstAidKit]: 1,
  [ItemId.NullweaveVest]: 0,
  [ItemId.PlateCarrier]: 0,
}
