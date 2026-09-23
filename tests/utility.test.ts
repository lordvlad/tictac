import { describe, expect, test } from 'bun:test'
import { CHARACTER } from '../src/config'
import { GRENADES, GrenadeId } from '../src/core/Arsenal'
import {
  type CharacterSheet,
  characterSheet,
  derive,
  sanitizeSheet,
  UtilityId,
} from '../src/core/Characters'
import { ItemId } from '../src/core/Items'
import { Rng } from '../src/core/rng'
import {
  NO_TRAITS,
  resolveSourcedInto,
  type SourcedTrait,
  TraitId,
  TraitSource,
} from '../src/core/Traits'
import type { Soldier } from '../src/entities/Soldier'
import { headlessSoldier } from './support/soldier'

/** A sheet with the attributes and training a test is about, nothing else. */
function sheetWith(over: {
  strength?: number
  utility?: Partial<Record<UtilityId, number>>
}): CharacterSheet {
  const base = characterSheet(new Rng(4))
  return {
    ...base,
    // Born traits are noise here, and one of them moves evasion.
    traits: [],
    attributes: { ...base.attributes, strength: over.strength ?? 5 },
    utility: { medical: 0, demolitions: 0, mechanics: 0, ...over.utility },
  }
}

function unit(sheet: CharacterSheet, items: Partial<Record<ItemId, number>> = {}): Soldier {
  return headlessSoldier({ sheet, items })
}

describe('Telling gear apart from everything else', () => {
  const sourced = (...traits: SourcedTrait[]): SourcedTrait[] => traits

  test('a source filter answers what gear alone is doing', () => {
    const traits = sourced(
      { id: TraitId.Plated, source: TraitSource.Gear },
      { id: TraitId.Limping, source: TraitSource.Wound },
    )
    const all = resolveSourcedInto({ ...NO_TRAITS }, traits)
    const gear = resolveSourcedInto({ ...NO_TRAITS }, traits, TraitSource.Gear)
    const wound = resolveSourcedInto({ ...NO_TRAITS }, traits, TraitSource.Wound)

    // The whole point: the same number, attributable.
    expect(gear.moveCost + wound.moveCost).toBeCloseTo(all.moveCost)
    expect(gear.moveCost).toBeGreaterThan(0)
    expect(wound.moveCost).toBeGreaterThan(0)
    // And gear's share carries gear's other opinions, not the wound's.
    expect(gear.armor).toBe(all.armor)
  })

  test('an unfiltered fold is still the source-blind one', () => {
    // Source-blindness is the contract everything else relies on; the split
    // exists beside it, not instead of it.
    const traits = sourced(
      { id: TraitId.Plated, source: TraitSource.Gear },
      { id: TraitId.Stoic, source: TraitSource.Innate },
    )
    const folded = resolveSourcedInto({ ...NO_TRAITS }, traits)

    expect(folded.critImmune).toBe(true)
    expect(folded.armor).toBeGreaterThan(0)
  })
})

describe('Strength against what heavy kit costs', () => {
  test('strong shoulders carry plate for nothing; weak ones pay in full', () => {
    const plate = { [ItemId.PlateCarrier]: 1 }
    const weak = unit(sheetWith({ strength: CHARACTER.attribute.min }), plate)
    const strong = unit(sheetWith({ strength: CHARACTER.attribute.max }), plate)
    const bare = unit(sheetWith({ strength: CHARACTER.attribute.min }))

    expect(weak.moveCostMul).toBeGreaterThan(1)
    expect(strong.moveCostMul).toBeCloseTo(bare.moveCostMul)
    // The allowance is spent on action points too, not only on steps.
    expect(strong.maxAp).toBeGreaterThanOrEqual(weak.maxAp)
  })

  test('being strong is not a cure for being hurt', () => {
    // The whole reason the fold had to be split by source: a limp is not a
    // rucksack, and cancelling it would have been a different game.
    const strong = unit(sheetWith({ strength: CHARACTER.attribute.max }))
    const healthy = strong.moveCostMul

    strong.hp = Math.floor(strong.maxHp * 0.4)

    expect(strong.moveCostMul).toBeGreaterThan(healthy)
  })

  test("plate costs an action point, and strength is what buys it back", () => {
    const plate = { [ItemId.PlateCarrier]: 1 }
    const weak = unit(sheetWith({ strength: CHARACTER.attribute.min }), plate)
    const strong = unit(sheetWith({ strength: CHARACTER.attribute.max }), plate)
    const bareWeak = unit(sheetWith({ strength: CHARACTER.attribute.min }))

    expect(weak.maxAp).toBeLessThan(bareWeak.maxAp)
    expect(strong.maxAp).toBe(bareWeak.maxAp)
  })

  test('relief is spent on penalties, never on advantages', () => {
    // A strong soldier does not undo their own kit: only the unfavourable
    // share of gear's fold is eligible, which is why the sign is checked
    // rather than the magnitude.
    const traits = [{ id: TraitId.Fleet, source: TraitSource.Gear }]
    const gear = resolveSourcedInto({ ...NO_TRAITS }, traits, TraitSource.Gear)
    expect(gear.maxAp).toBeGreaterThan(0)

    const strong = unit(sheetWith({ strength: CHARACTER.attribute.max }))
    const weak = unit(sheetWith({ strength: CHARACTER.attribute.min }))
    // Nothing worn, so the allowance has nothing to spend itself on and the
    // two differ only where an attribute says they should.
    expect(strong.moveCostMul).toBe(weak.moveCostMul)
  })
})

describe('Demolitions', () => {
  test("training shapes the charge this thrower's hands prepared", () => {
    const trained = unit(sheetWith({ utility: { demolitions: CHARACTER.utility.max } }))
    const untrained = unit(sheetWith({ utility: { demolitions: 0 } }))

    expect(trained.grenadeSpecs[GrenadeId.Frag].areaRadius).toBeGreaterThan(
      untrained.grenadeSpecs[GrenadeId.Frag].areaRadius,
    )
    expect(trained.grenadeSpecs[GrenadeId.Frag].armorShred).toBeGreaterThan(
      untrained.grenadeSpecs[GrenadeId.Frag].armorShred,
    )
  })

  test('one thrower\u2019s training is not everybody\u2019s', () => {
    // The shared `GRENADES` table is the trap: stamping onto it would arm the
    // whole squad with one soldier's charges.
    const before = GRENADES[GrenadeId.Frag].areaRadius
    unit(sheetWith({ utility: { demolitions: CHARACTER.utility.max } }))
    const untrained = unit(sheetWith({ utility: { demolitions: 0 } }))

    expect(GRENADES[GrenadeId.Frag].areaRadius).toBe(before)
    expect(untrained.grenadeSpecs[GrenadeId.Frag].areaRadius).toBe(before)
  })

  test('no amount of training produces a dud', () => {
    const hopeless = unit(sheetWith({ utility: { demolitions: CHARACTER.utility.min } }))
    for (const kind of Object.values(GrenadeId)) {
      expect(hopeless.grenadeSpecs[kind].areaRadius).toBeGreaterThanOrEqual(1)
      expect(hopeless.grenadeSpecs[kind].armorShred).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('Training off the wire', () => {
  test('a rolled sheet trains inside the band', () => {
    for (let seed = 0; seed < 200; seed++) {
      const sheet = characterSheet(new Rng(seed))
      for (const value of Object.values(sheet.utility)) {
        expect(value).toBeGreaterThanOrEqual(CHARACTER.utility.min)
        expect(value).toBeLessThanOrEqual(CHARACTER.utility.max)
      }
    }
  })

  test('a peer cannot claim training it has not got', () => {
    // Same treatment weapon proficiency gets: a blast radius is multiplied by
    // this number, so an unbounded one is an unbounded grenade.
    const sheet = sanitizeSheet({
      utility: { medical: 1e9, demolitions: -500, mechanics: 'lots', toString: 5 },
    })

    expect(sheet.utility[UtilityId.Medical]).toBe(CHARACTER.utility.max)
    expect(sheet.utility[UtilityId.Demolitions]).toBe(CHARACTER.utility.min)
    expect(sheet.utility[UtilityId.Mechanics]).toBe(0)
    expect(Object.keys(sheet.utility).sort()).toEqual([...Object.values(UtilityId)].sort())
  })

  test('the strength allowance is bounded whatever arrives', () => {
    const sheet = sanitizeSheet({ attributes: { strength: 1e9 } })
    expect(derive(sheet).gearRelief).toBeLessThanOrEqual(CHARACTER.gearRelief.max)
  })
})
