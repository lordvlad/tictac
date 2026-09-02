import { describe, expect, test } from 'bun:test'
import { ItemSystem } from '../src/ecs/systems/ItemSystem'
import { ITEMS, ItemId } from '../src/core/Items'
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
function stubSoldier(overrides: { hp?: number; maxHp?: number; ap?: number; maxAp?: number; armor?: number; maxArmor?: number } = {}) {
  const unit = {
    hp: overrides.hp ?? 100,
    maxHp: overrides.maxHp ?? 100,
    ap: overrides.ap ?? 12,
    maxAp: overrides.maxAp ?? 12,
    armor: overrides.armor ?? 20,
    maxArmor: overrides.maxArmor ?? 20,
    statuses: [] as StatusState[],
    items: { [ItemId.StimPack]: 1, [ItemId.FirstAidKit]: 1 } as Record<ItemId, number>,
    get isDead(): boolean {
      return this.hp <= 0
    },
    get effectiveMaxAp(): number {
      return effectiveMaxAp(this.maxAp, this.statuses)
    },
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
