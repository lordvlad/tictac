import { describe, expect, test } from 'bun:test'
import { ItemSystem } from '../src/ecs/systems/ItemSystem'
import { ITEMS, ItemId, itemApCost } from '../src/core/Items'
import { StatusKind, STATUSES } from '../src/core/Arsenal'
import { effectiveMaxAp } from '../src/core/Ballistics'
import type { StatusState } from '../src/core/Ballistics'
import type { Soldier } from '../src/entities/Soldier'

/**
 * The slice of a soldier that item effects touch.
 *
 * A real `Soldier` needs a loaded glTF and an engine context, so the tests
 * stand in an object with the same contract — including `effectiveMaxAp`,
 * which delegates to the same helper the real accessor uses.
 */
function stubSoldier(
  overrides: {
    hp?: number
    maxHp?: number
    ap?: number
    maxAp?: number
    armor?: number
    maxArmor?: number
    /** What Intelligence adds to an item's price. Average characters pay list. */
    itemApDelta?: number
    /** What Health adds to treatment taken. Average characters gain list. */
    healBonus?: number
  } = {},
) {
  const unit = {
    hp: overrides.hp ?? 100,
    maxHp: overrides.maxHp ?? 100,
    ap: overrides.ap ?? 12,
    maxAp: overrides.maxAp ?? 12,
    armor: overrides.armor ?? 20,
    maxArmor: overrides.maxArmor ?? 20,
    itemApDelta: overrides.itemApDelta ?? 0,
    healBonus: overrides.healBonus ?? 0,
    statuses: [] as StatusState[],
    items: {
      [ItemId.StimPack]: 1,
      [ItemId.FirstAidKit]: 1,
      [ItemId.NullweaveVest]: 0,
    } as Record<ItemId, number>,
    get isDead(): boolean {
      return this.hp <= 0
    },
    get effectiveMaxAp(): number {
      return effectiveMaxAp(this.maxAp, this.statuses)
    },
    // Spending an item can end a trait the pouch was granting, so the system
    // re-folds after every use.
    refreshTraits(): void {},
  }
  // Structurally the surface ItemSystem uses; the rest of Soldier is graphics.
  return unit as unknown as Soldier & typeof unit
}

describe('First aid kit', () => {
  test('restores health and is consumed', () => {
    const system = new ItemSystem()
    const unit = stubSoldier({ hp: 30 })

    expect(system.use(unit, ItemId.FirstAidKit)).toBe(true)
    expect(unit.hp).toBe(80)
    expect(unit.items[ItemId.FirstAidKit]).toBe(0)
    expect(unit.ap).toBe(12 - ITEMS[ItemId.FirstAidKit].apCost)
  })

  test('never heals past the unit maximum', () => {
    const system = new ItemSystem()
    const unit = stubSoldier({ hp: 80, maxHp: 100 })

    system.use(unit, ItemId.FirstAidKit)

    expect(unit.hp).toBe(100)
  })

  test('cannot be used when none are carried', () => {
    const system = new ItemSystem()
    const unit = stubSoldier({ hp: 10 })
    unit.items[ItemId.FirstAidKit] = 0

    expect(system.use(unit, ItemId.FirstAidKit)).toBe(false)
    expect(unit.hp).toBe(10)
  })

  test('cannot be used without the action points', () => {
    const system = new ItemSystem()
    const unit = stubSoldier({ hp: 10, ap: 0 })

    expect(system.use(unit, ItemId.FirstAidKit)).toBe(false)
    expect(unit.hp).toBe(10)
  })

  test('the dead cannot be revived with it', () => {
    const system = new ItemSystem()
    const unit = stubSoldier({ hp: 0 })

    expect(system.use(unit, ItemId.FirstAidKit)).toBe(false)
    expect(unit.hp).toBe(0)
  })
})

describe('Stim pack', () => {
  test('raises the action-point ceiling by a fifth and fills to it', () => {
    const system = new ItemSystem()
    const unit = stubSoldier({ ap: 1, maxAp: 10 })

    expect(system.use(unit, ItemId.StimPack)).toBe(true)
    expect(unit.effectiveMaxAp).toBe(12)
    // The refill runs after the cost is paid, so the unit ends up full.
    expect(unit.ap).toBe(12)
  })

  test('lasts two rounds — the unit gets it on its next two turns', () => {
    const system = new ItemSystem()
    const unit = stubSoldier()

    system.use(unit, ItemId.StimPack)
    const live = unit.statuses.find((s) => s.kind === StatusKind.Stimmed)

    // Statuses tick per handover, and a round is two handovers.
    expect(live?.turnsLeft).toBe(4)
    expect(STATUSES[StatusKind.Stimmed].turns).toBe(4)
  })

  test('the ceiling returns to normal once it lapses', () => {
    const system = new ItemSystem()
    const unit = stubSoldier({ maxAp: 10 })

    system.use(unit, ItemId.StimPack)
    expect(unit.effectiveMaxAp).toBe(12)

    unit.statuses = []
    expect(unit.effectiveMaxAp).toBe(10)
  })

  test('refreshing an active stim does not stack the bonus', () => {
    const system = new ItemSystem()
    const unit = stubSoldier({ maxAp: 10 })
    unit.items[ItemId.StimPack] = 2

    system.use(unit, ItemId.StimPack)
    system.use(unit, ItemId.StimPack)

    expect(unit.statuses.filter((s) => s.kind === StatusKind.Stimmed).length).toBe(1)
    expect(unit.effectiveMaxAp).toBe(12)
  })
})

describe('Item effect model', () => {
  test('an unknown item is refused rather than throwing', () => {
    const system = new ItemSystem()
    const unit = stubSoldier()

    expect(system.use(unit, 'nonexistent' as ItemId)).toBe(false)
  })

  test('a forced use replays a peer action past the local checks', () => {
    const system = new ItemSystem()
    const unit = stubSoldier({ hp: 10, ap: 0 })

    expect(system.use(unit, ItemId.FirstAidKit, true)).toBe(true)
    expect(unit.hp).toBe(60)
  })

  test('effects apply in the order the item declares', () => {
    // The stim's refill must come after its status, or the raised ceiling
    // would not be visible to the top-up.
    const effects = ITEMS[ItemId.StimPack].effects
    expect(effects.map((e) => e.kind)).toEqual(['applyStatus', 'refillAp'])
  })

  test('use reports the item to its listener', () => {
    const system = new ItemSystem()
    const unit = stubSoldier()
    const seen: ItemId[] = []
    system.onItemUsed = (_soldier, itemId) => seen.push(itemId)

    system.use(unit, ItemId.FirstAidKit)

    expect(seen).toEqual([ItemId.FirstAidKit])
  })
})

describe('What the carrier brings to their own kit', () => {
  test('a clever soldier pays less for the same item, a slow one more', () => {
    const system = new ItemSystem()
    const list = ITEMS[ItemId.FirstAidKit].apCost

    const clever = stubSoldier({ itemApDelta: -1 })
    const slow = stubSoldier({ itemApDelta: 1 })
    const cleverBefore = clever.ap
    const slowBefore = slow.ap

    system.use(clever, ItemId.FirstAidKit)
    system.use(slow, ItemId.FirstAidKit)

    expect(cleverBefore - clever.ap).toBe(list - 1)
    expect(slowBefore - slow.ap).toBe(list + 1)
  })

  test('nobody uses kit for free, however clever', () => {
    // The floor exists so an item is always a decision about the turn. Tested
    // on the first aid kit, not the stim: a stim's last effect is `refillAp`,
    // so its net cost to the turn is whatever the ceiling gives back.
    const system = new ItemSystem()
    const genius = stubSoldier({ itemApDelta: -99 })
    const before = genius.ap

    expect(system.use(genius, ItemId.FirstAidKit)).toBe(true)
    expect(before - genius.ap).toBe(1)
  })

  test('the price the system charges is the price a panel can print', () => {
    // Same rule both sides of the HUD seam: a row advertising the table's
    // figure would be a button whose cost is not the cost.
    const spec = ITEMS[ItemId.FirstAidKit]
    expect(itemApCost(spec, -1)).toBe(spec.apCost - 1)
    expect(itemApCost(spec, 0)).toBe(spec.apCost)
    expect(itemApCost(spec, -spec.apCost - 5)).toBe(1)
  })

  test('treatment takes better on a hardy body than a frail one', () => {
    const system = new ItemSystem()
    const amount = 50
    const hardy = stubSoldier({ hp: 10, maxHp: 500, healBonus: 30 })
    const frail = stubSoldier({ hp: 10, maxHp: 500, healBonus: -20 })

    system.use(hardy, ItemId.FirstAidKit)
    system.use(frail, ItemId.FirstAidKit)

    expect(hardy.hp - 10).toBeGreaterThan(amount)
    expect(frail.hp - 10).toBeLessThan(amount)
    // Treated badly, never not at all.
    expect(frail.hp).toBeGreaterThan(10)
  })
})
