import { StatusKind } from './Arsenal'
import { TraitId } from './Traits'

/**
 * Carried consumables: what a unit can spend a turn using, on itself or on a
 * squadmate.
 *
 * An item is a name, an AP price and an ordered list of effects. Adding a new
 * item is data; adding a new *kind* of effect is one variant below and one
 * branch in {@link ItemSystem}. Nothing else needs to know items exist.
 */
export const ItemId = {
  StimPack: 'stim',
  FirstAidKit: 'firstAid',
  RepairKit: 'repair',
  NullweaveVest: 'nullweave',
  PlateCarrier: 'plate',
  /** The keys to the locked doors on the map: unlock one quietly, for a point. */
  Keys: 'keys',
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
  /** End every ailment (`StatusSpec.ailment`): stop a bleed, and later a poison. */
  | { kind: 'treatAilments' }
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
  /**
   * Intelligence the character needs before the item does anything for them.
   *
   * The gate half of Intelligence: below the bar the kit is carried dead
   * weight rather than used badly, because a technical item is knowing what to
   * do with it. Absent means anyone can work it.
   */
  minIntelligence?: number
  /**
   * Carrying one lets the unit unlock a locked door (`core/Doors`). A
   * permission rather than an effect: nothing is used up, and it is why a
   * passive item can earn its slot without granting a trait.
   */
  unlocks?: boolean
}

/**
 * What using this item actually costs *this* character.
 *
 * Intelligence is the difference: technical literacy shows up as getting more
 * out of the same kit, and the cheapest way to say that with the items which
 * exist today is the price of working one. Floored at a point, so no character
 * ever uses gear for free - an item is always a decision about the turn.
 *
 * Mechanics is the second, narrower discount: it is training at working
 * armour, so it is read off the item's own effects rather than a flag on the
 * spec. Anything that repairs armour is a mechanic's job by definition, and a
 * new repair item inherits the discount without having to say so twice. It
 * cuts both ways, like every utility percent: the untrained end of the band
 * fumbles with a repair and pays more.
 *
 * Shared rather than computed at each call site because the HUD prints this
 * number and the system charges it; the two drifting would make the panel lie.
 */
export function itemApCost(spec: ItemSpec, apDelta: number, mechanics = 0): number {
  const repairs = mechanics !== 0 && spec.effects.some((e) => e.kind === 'restoreArmor')
  const base = repairs ? Math.round(spec.apCost * (1 - mechanics / 100)) : spec.apCost
  return Math.max(1, base + apDelta)
}

/**
 * Whether `spec` is something one soldier can administer to another.
 *
 * Treatment and repair travel - they are work done on a body or on a plate,
 * and it does not matter whose. Exertion and chemistry do not: a stim's lift
 * and its top-up belong to the soldier who took it. Read off the effects
 * rather than declared, so an item is targetable exactly when it has something
 * to do to the other unit.
 */
export function itemTargetsAlly(spec: ItemSpec): boolean {
  return spec.effects.some(
    (e) => e.kind === 'restoreHp' || e.kind === 'restoreArmor' || e.kind === 'clearStatuses' || e.kind === 'treatAilments',
  )
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
    // Dressing a wound stops it bleeding, and the same kit is what will treat
    // poison: any ailment (`StatusSpec.ailment`), not a list of them.
    effects: [{ kind: 'restoreHp', amount: 50 }, { kind: 'treatAilments' }],
  },
  [ItemId.RepairKit]: {
    id: ItemId.RepairKit,
    name: 'Repair Kit',
    apCost: 3,
    // Priced against the first aid kit (2 AP, 50 of ~100 HP) on purpose. Armour
    // is not a second life bar - it only blunts what lands - so 12 of a
    // 20-point plate buys less of this turn than 50 HP does, and it costs a
    // point more. What makes it worth a slot is being the only kit that undoes
    // permanent loss, and a trained mechanic bringing it back down to 2.
    effects: [{ kind: 'restoreArmor', amount: 12 }],
    // Mid-scale on a 1-10 attribute: the clever half of a squad can work it,
    // which is a real loadout decision rather than a tax on bad rolls.
    minIntelligence: 5,
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
  [ItemId.Keys]: {
    id: ItemId.Keys,
    name: 'Keys',
    apCost: 0,
    // Not used up and never worked from the pouch: a permission a door asks
    // for, not an effect. What it costs is the slot.
    effects: [],
    passive: true,
    unlocks: true,
  },
}

/** Starting pouch, by item. */
export const STARTING_ITEMS: Record<ItemId, number> = {
  [ItemId.StimPack]: 1,
  [ItemId.FirstAidKit]: 1,
  // Stocked by the crate, not carried by default: it is the one item a
  // character can be unable to use, so bringing it is a choice.
  [ItemId.RepairKit]: 0,
  [ItemId.NullweaveVest]: 0,
  [ItemId.PlateCarrier]: 0,
  [ItemId.Keys]: 0,
}
