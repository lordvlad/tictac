import { System } from '../System'
import { STATUSES } from '../../core/Arsenal'
import { UtilityId } from '../../core/Characters'
import { ITEMS, type ItemId, itemApCost } from '../../core/Items'
import { applyStatus } from '../../game/Combat'
import type { Soldier } from '../../entities/Soldier'

/**
 * Using carried consumables, on the carrier or on a squadmate.
 *
 * Each item is a list of effects, applied in order; this is the only place
 * that knows what an effect *does*. A new item is data in {@link ITEMS}; a new
 * kind of effect is one more branch below.
 *
 * Reaching across to another unit is a property of the effect, not of the
 * item: treatment and repair land on whoever is being worked on, while the
 * turn's price and the thing out of the pouch always come off the user.
 */
export class ItemSystem extends System {
  /** Fired after an item is used, for HUD and visual feedback. */
  onItemUsed?: (soldier: Soldier, itemId: ItemId) => void

  update(): void {
    // Item use is command driven; nothing to advance per tick.
  }

  /**
   * Can this unit use `itemId` on `target` right now?
   *
   * Range and adjacency are deliberately absent: who is reachable is the
   * controller's question, and this predicate is also what greys a HUD row
   * out, where no target is picked yet.
   */
  canUse(user: Soldier, itemId: ItemId, target: Soldier = user): boolean {
    if (user.isDead) return false
    if (!Object.hasOwn(ITEMS, itemId)) return false
    const spec = ITEMS[itemId]
    // Worn gear has no action: it earns its slot by being carried, and
    // "using" it would consume the thing granting the trait.
    if (spec.passive) return false
    // The Intelligence gate: below the bar the kit is dead weight in the
    // pouch. Absent means anyone can work it, hence the zero.
    if (user.sheet.attributes.intelligence < (spec.minIntelligence ?? 0)) return false
    // A corpse is not a patient: death is final here - no item revives - and
    // every effect writes to a unit the turn order has already dropped, so
    // treating one would spend a kit to move numbers nobody will ever read.
    if (target.isDead) return false
    if ((user.items[itemId] ?? 0) <= 0) return false
    return user.ap >= itemApCost(spec, user.itemApDelta, user.utility[UtilityId.Mechanics])
  }

  /**
   * Use an item on `target`, the carrier by default.
   *
   * `force` replays a peer's use that the originating side already validated.
   */
  use(user: Soldier, itemId: ItemId, target: Soldier = user, force = false): boolean {
    // `Object.hasOwn`, not a truthiness check: the id arrives in a peer's
    // `useItem` and `ITEMS` inherits `toString`, which would otherwise read as
    // an item and then be spent as one with no `effects` to apply.
    if (!Object.hasOwn(ITEMS, itemId)) return false
    const spec = ITEMS[itemId]
    // Refused even under `force`: a peer replaying this would be destroying a
    // trait source on this side, and no legitimate peer sends it.
    if (spec.passive) return false
    // Refused even under `force` for the same reason as `passive`: the gate is
    // a fact about this character, so a peer must not be able to make a
    // soldier work kit they cannot work - the id it sends is the only thing
    // this side trusts it for.
    if (user.sheet.attributes.intelligence < (spec.minIntelligence ?? 0)) return false
    if (!force && !this.canUse(user, itemId, target)) return false

    user.ap = Math.max(
      0,
      user.ap - itemApCost(spec, user.itemApDelta, user.utility[UtilityId.Mechanics]),
    )
    user.items[itemId] = Math.max(0, (user.items[itemId] ?? 1) - 1)
    // Spending the last of something that granted a trait ends the trait. True
    // of no item today, but the pouch is the only source and this is where it
    // changes.
    user.refreshTraits()

    for (const effect of spec.effects) {
      switch (effect.kind) {
        case 'restoreHp': {
          // Two separate contributions, multiplied once and rounded once.
          // Health is the patient's physiology, so it decides how well
          // treatment takes on *that* body. Medical is the user's training,
          // and only pays out on somebody else: nobody gets credit for
          // bandaging their own arm, and self-use has to keep costing what it
          // always did. Never below a point: a frail soldier is treated
          // badly, not not at all.
          const medical = target === user ? 0 : user.utility[UtilityId.Medical]
          const healed = Math.max(
            1,
            Math.round(effect.amount * (1 + medical / 100) * (1 + target.healBonus / 100)),
          )
          target.hp = Math.min(target.maxHp, target.hp + healed)
          break
        }
        case 'restoreArmor': {
          // Mechanics is the user's hands on the plate either way, so unlike
          // treatment it pays on their own armour too.
          const repaired = Math.max(
            1,
            Math.round(effect.amount * (1 + user.utility[UtilityId.Mechanics] / 100)),
          )
          target.armor = Math.min(target.maxArmor, target.armor + repaired)
          break
        }
        case 'refillAp':
          // On the user, never the target: a kit buys back the time of the
          // soldier working it. Handing somebody else a turn would let a squad
          // pass action points around, which is not what any of this kit is.
          // Reads the ceiling after any status applied above, so a stim's
          // lift is included in the same use.
          user.ap = user.effectiveMaxAp
          break
        case 'clearStatuses':
          target.statuses = []
          break
        case 'treatAilments':
          target.statuses = target.statuses.filter((state) => !STATUSES[state.kind].ailment)
          break
        case 'applyStatus':
          // Through the shared rule rather than by hand, so stacking and the
          // clock behave the same whether a stim or a grenade applied it.
          applyStatus(target, effect.status)
          break
      }
    }

    this.onItemUsed?.(user, itemId)
    return true
  }
}
