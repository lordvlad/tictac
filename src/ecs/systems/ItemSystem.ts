import { System } from '../System'
import { STATUSES } from '../../core/Arsenal'
import { ITEMS, type ItemId } from '../../core/Items'
import type { Soldier } from '../../entities/Soldier'

/**
 * Using carried consumables.
 *
 * Each item is a list of effects, applied in order; this is the only place
 * that knows what an effect *does*. A new item is data in {@link ITEMS}; a new
 * kind of effect is one more branch below.
 */
export class ItemSystem extends System {
  /** Fired after an item is used, for HUD and visual feedback. */
  onItemUsed?: (soldier: Soldier, itemId: ItemId) => void

  update(): void {
    // Item use is command driven; nothing to advance per tick.
  }

  /** Can this unit use `itemId` right now? */
  canUse(soldier: Soldier, itemId: ItemId): boolean {
    if (soldier.isDead) return false
    if ((soldier.items[itemId] ?? 0) <= 0) return false
    return soldier.ap >= ITEMS[itemId].apCost
  }

  /**
   * Use an item on its carrier.
   *
   * `force` replays a peer's use that the originating side already validated.
   */
  use(soldier: Soldier, itemId: ItemId, force = false): boolean {
    const spec = ITEMS[itemId]
    if (!spec) return false
    if (!force && !this.canUse(soldier, itemId)) return false

    soldier.ap = Math.max(0, soldier.ap - spec.apCost)
    soldier.items[itemId] = Math.max(0, (soldier.items[itemId] ?? 1) - 1)

    for (const effect of spec.effects) {
      switch (effect.kind) {
        case 'restoreHp':
          soldier.hp = Math.min(soldier.maxHp, soldier.hp + effect.amount)
          break
        case 'restoreArmor':
          soldier.armor = Math.min(soldier.maxArmor, soldier.armor + effect.amount)
          break
        case 'refillAp':
          // Reads the ceiling after any status applied above, so a stim's
          // lift is included in the same use.
          soldier.ap = soldier.effectiveMaxAp
          break
        case 'clearStatuses':
          soldier.statuses = []
          break
        case 'applyStatus': {
          const status = STATUSES[effect.status]
          if (!status) break
          const live = soldier.statuses.find((s) => s.kind === status.kind)
          if (live) live.turnsLeft = status.turns
          else soldier.statuses.push({ kind: status.kind, turnsLeft: status.turns })
          break
        }
      }
    }

    this.onItemUsed?.(soldier, itemId)
    return true
  }
}
