import { describe, expect, test } from 'bun:test'
import { ItemSystem } from '../src/ecs/systems/ItemSystem'
import { ITEMS, ItemId, itemApCost } from '../src/core/Items'
import { StatusKind, STATUSES } from '../src/core/Arsenal'
import { UtilityId } from '../src/core/Characters'
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
    /** Utility training, per discipline. Untrained unless a test says otherwise. */
    utility?: Partial<Record<UtilityId, number>>
    /** Raw Intelligence, which the gate reads. Defaults to the repair kit's bar. */
    intelligence?: number
  } = {},
) {
  const utility = {} as Record<UtilityId, number>
  for (const id of Object.values(UtilityId)) utility[id] = overrides.utility?.[id] ?? 0

  const unit = {
    hp: overrides.hp ?? 100,
    maxHp: overrides.maxHp ?? 100,
    ap: overrides.ap ?? 12,
    maxAp: overrides.maxAp ?? 12,
    armor: overrides.armor ?? 20,
    maxArmor: overrides.maxArmor ?? 20,
    itemApDelta: overrides.itemApDelta ?? 0,
    healBonus: overrides.healBonus ?? 0,
    utility,
    // Only the slice of the sheet the gate reads; the rest is rolled elsewhere.
    sheet: { attributes: { intelligence: overrides.intelligence ?? 5 } },
    statuses: [] as StatusState[],
    items: {
      [ItemId.StimPack]: 1,
      [ItemId.FirstAidKit]: 1,
      [ItemId.RepairKit]: 1,
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

    expect(system.use(unit, ItemId.FirstAidKit, unit, true)).toBe(true)
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

describe('Treating somebody else', () => {
  test('a trained medic gets more out of the same kit than a rookie does', () => {
    const system = new ItemSystem()
    const medic = stubSoldier({ utility: { [UtilityId.Medical]: 30 } })
    const rookie = stubSoldier()
    // Roomy ceilings, so the cap is not what the comparison is measuring.
    const treated = stubSoldier({ hp: 10, maxHp: 500 })
    const neglected = stubSoldier({ hp: 10, maxHp: 500 })

    expect(system.use(medic, ItemId.FirstAidKit, treated)).toBe(true)
    expect(system.use(rookie, ItemId.FirstAidKit, neglected)).toBe(true)

    expect(neglected.hp - 10).toBe(50)
    expect(treated.hp - 10).toBeGreaterThan(neglected.hp - 10)
  })

  test('training does not pay out on yourself', () => {
    // You cannot get good at treating your own arm: self-use has to cost and
    // return what it always did, whatever the sheet says.
    const system = new ItemSystem()
    const medic = stubSoldier({ hp: 10, maxHp: 500, utility: { [UtilityId.Medical]: 30 } })

    system.use(medic, ItemId.FirstAidKit)

    expect(medic.hp - 10).toBe(50)
  })

  test('the body being treated is the one whose Health counts', () => {
    const system = new ItemSystem()
    const medic = stubSoldier({ healBonus: 30 })
    const otherMedic = stubSoldier()
    const hardy = stubSoldier({ hp: 10, maxHp: 500, healBonus: 30 })
    const average = stubSoldier({ hp: 10, maxHp: 500 })

    // A hardy medic treating an average soldier, and the reverse.
    system.use(medic, ItemId.FirstAidKit, average)
    system.use(otherMedic, ItemId.FirstAidKit, hardy)

    expect(average.hp - 10).toBe(50)
    expect(hardy.hp - 10).toBeGreaterThan(50)
  })

  test('the turn and the kit come off the medic, not the patient', () => {
    const system = new ItemSystem()
    const medic = stubSoldier()
    const patient = stubSoldier({ hp: 40 })

    system.use(medic, ItemId.FirstAidKit, patient)

    expect(medic.ap).toBe(12 - ITEMS[ItemId.FirstAidKit].apCost)
    expect(medic.items[ItemId.FirstAidKit]).toBe(0)
    expect(patient.ap).toBe(12)
    expect(patient.items[ItemId.FirstAidKit]).toBe(1)
    expect(medic.hp).toBe(100)
  })

  test('a corpse is not a patient, and a corpse is not a medic', () => {
    const system = new ItemSystem()
    const medic = stubSoldier()
    const corpse = stubSoldier({ hp: 0, maxHp: 100 })

    expect(system.canUse(medic, ItemId.FirstAidKit, corpse)).toBe(false)
    expect(system.use(medic, ItemId.FirstAidKit, corpse)).toBe(false)
    expect(corpse.hp).toBe(0)
    expect(medic.items[ItemId.FirstAidKit]).toBe(1)

    const patient = stubSoldier({ hp: 40 })
    expect(system.use(corpse, ItemId.FirstAidKit, patient)).toBe(false)
    expect(patient.hp).toBe(40)
  })

  test('no kit hands action points to somebody else', () => {
    const system = new ItemSystem()
    const user = stubSoldier({ ap: 1, maxAp: 10 })
    const other = stubSoldier({ ap: 1, maxAp: 10 })

    system.use(user, ItemId.StimPack, other)

    // `refillAp` is the soldier working the kit buying part of their own turn
    // back, so it lands on the user however the use was aimed. The chemistry
    // went to the other unit, so the top-up reads the user's own ceiling.
    expect(user.ap).toBe(10)
    expect(other.ap).toBe(1)
  })
})

describe('Repair kit', () => {
  test('restores armour and is consumed', () => {
    const system = new ItemSystem()
    const unit = stubSoldier({ armor: 5 })

    expect(system.use(unit, ItemId.RepairKit)).toBe(true)
    expect(unit.armor).toBe(17)
    expect(unit.items[ItemId.RepairKit]).toBe(0)
    expect(unit.ap).toBe(12 - ITEMS[ItemId.RepairKit].apCost)
  })

  test('a mechanic repairs more of the plate and pays less for it', () => {
    const system = new ItemSystem()
    const mechanic = stubSoldier({ armor: 5, maxArmor: 40, utility: { [UtilityId.Mechanics]: 35 } })
    const rookie = stubSoldier({ armor: 5, maxArmor: 40 })

    system.use(mechanic, ItemId.RepairKit)
    system.use(rookie, ItemId.RepairKit)

    expect(mechanic.armor - 5).toBeGreaterThan(rookie.armor - 5)
    expect(12 - mechanic.ap).toBeLessThan(12 - rookie.ap)
  })

  test('never repairs past the plate the unit is wearing', () => {
    const system = new ItemSystem()
    const mechanic = stubSoldier({ armor: 19, utility: { [UtilityId.Mechanics]: 35 } })

    system.use(mechanic, ItemId.RepairKit)

    expect(mechanic.armor).toBe(20)
  })

  test("a mechanic can work on a squadmate's plate", () => {
    const system = new ItemSystem()
    const mechanic = stubSoldier({ armor: 4, utility: { [UtilityId.Mechanics]: 35 } })
    const squadmate = stubSoldier({ armor: 4 })

    expect(system.use(mechanic, ItemId.RepairKit, squadmate)).toBe(true)

    expect(squadmate.armor).toBeGreaterThan(4)
    expect(mechanic.armor).toBe(4)
    expect(mechanic.items[ItemId.RepairKit]).toBe(0)
    expect(squadmate.items[ItemId.RepairKit]).toBe(1)
  })

  test('it is a used item, not worn kit', () => {
    // The gate only means something on kit that has an action to refuse.
    expect(ITEMS[ItemId.RepairKit].passive).toBeUndefined()
    expect(ITEMS[ItemId.RepairKit].traits).toBeUndefined()
  })

  test('Mechanics discounts a repair and nothing else', () => {
    const repair = ITEMS[ItemId.RepairKit]
    const aid = ITEMS[ItemId.FirstAidKit]

    expect(itemApCost(repair, 0, 35)).toBeLessThan(repair.apCost)
    // Knowing armour says nothing about reading a medkit's instructions.
    expect(itemApCost(aid, 0, 35)).toBe(aid.apCost)
    // Signed like every utility percent: the untrained end fumbles and pays.
    expect(itemApCost(repair, 0, -20)).toBeGreaterThan(repair.apCost)
    // Still never free, however good the hands.
    expect(itemApCost(repair, -5, 100)).toBe(1)
  })
})

describe('Kit a character cannot work', () => {
  test('the repair kit is refused below its Intelligence bar', () => {
    const system = new ItemSystem()
    const bar = ITEMS[ItemId.RepairKit].minIntelligence ?? 0
    const dull = stubSoldier({ armor: 5, intelligence: bar - 1 })

    expect(system.canUse(dull, ItemId.RepairKit)).toBe(false)
    expect(system.use(dull, ItemId.RepairKit)).toBe(false)
    expect(dull.armor).toBe(5)
    expect(dull.items[ItemId.RepairKit]).toBe(1)

    const capable = stubSoldier({ armor: 5, intelligence: bar })
    expect(system.canUse(capable, ItemId.RepairKit)).toBe(true)
  })

  test('a peer cannot force kit past the gate', () => {
    // The id arrives in a peer's `useItem`; whether this character can work it
    // is a fact about this side's sheet, not something the sender decides.
    const system = new ItemSystem()
    const bar = ITEMS[ItemId.RepairKit].minIntelligence ?? 0
    const dull = stubSoldier({ armor: 5, intelligence: bar - 1 })

    expect(system.use(dull, ItemId.RepairKit, dull, true)).toBe(false)
    expect(dull.armor).toBe(5)
    expect(dull.items[ItemId.RepairKit]).toBe(1)
    expect(dull.ap).toBe(12)
  })

  test('ordinary kit stays available to the slowest soldier', () => {
    const system = new ItemSystem()
    const dull = stubSoldier({ hp: 50, intelligence: 1 })

    expect(system.canUse(dull, ItemId.FirstAidKit)).toBe(true)
    expect(system.canUse(dull, ItemId.StimPack)).toBe(true)
  })
})
