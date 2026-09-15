import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { AmmoId, GRENADES, type GrenadeId, STATUSES, StatusKind, WeaponId } from '../src/core/Arsenal'
import { statusStacks } from '../src/core/Ballistics'
import { characterSheet } from '../src/core/Characters'
import { ItemId } from '../src/core/Items'
import { Rng } from '../src/core/rng'
import { applyStatus, suppress, tickStatuses } from '../src/game/Combat'
import { SimUnit } from '../src/sim/SimUnit'

function unit(faction: Faction = Faction.Blue): SimUnit {
  return new SimUnit(
    faction,
    0,
    'Test',
    characterSheet(new Rng(9)),
    WeaponId.Rifle,
    AmmoId.Standard,
    { x: 1, y: 1 },
    Object.fromEntries(Object.keys(GRENADES).map((k) => [k, 0])) as Record<GrenadeId, number>,
    { stim: 0, firstAid: 0, nullweave: 0 } as Record<ItemId, number>,
  )
}

const stacksOn = (u: SimUnit, kind: StatusKind): number => {
  const state = u.statuses.find((s) => s.kind === kind && s.turnsLeft > 0)
  return state ? statusStacks(state) : 0
}

describe('Rounds that go past rather than in', () => {
  test('a miss is no longer free', () => {
    const target = unit()

    suppress(target, 1)

    expect(stacksOn(target, StatusKind.Suppressed)).toBe(1)
  })

  test('volume of fire piles up', () => {
    const target = unit()

    suppress(target, 1)
    suppress(target, 1)

    expect(stacksOn(target, StatusKind.Suppressed)).toBe(2)
  })

  test('a burst suppresses by the rounds it missed with, not by being a burst', () => {
    const one = unit()
    const many = unit()

    suppress(one, 1)
    suppress(many, 3)

    expect(stacksOn(many, StatusKind.Suppressed)).toBeGreaterThan(
      stacksOn(one, StatusKind.Suppressed),
    )
  })

  test('it cannot pile up past being pinned', () => {
    const target = unit()

    suppress(target, 99)

    expect(stacksOn(target, StatusKind.Suppressed)).toBe(STATUSES[StatusKind.Suppressed].maxStacks)
  })

  test('landing every round suppresses nobody', () => {
    // The target is already having a bad enough time; suppression is what a
    // near miss is worth, and a hit is worth its damage instead.
    const target = unit()

    suppress(target, 0)

    expect(target.statuses).toEqual([])
  })

  test('a corpse is not suppressed', () => {
    // Nothing left to suppress, and it would show a chip on a dead unit's card.
    const target = unit()
    target.hp = 0

    suppress(target, 3)

    expect(target.statuses).toEqual([])
  })
})

describe('What being suppressed costs', () => {
  test('every stack costs accuracy and points', () => {
    const light = unit()
    const pinned = unit()
    const fresh = light.effectiveMaxAp

    suppress(light, 1)
    suppress(pinned, 3)

    const spec = STATUSES[StatusKind.Suppressed]
    // Read through the resolver's own sum rather than asserted as a constant:
    // the point is that the penalty scales, not what this turn's number is.
    expect(pinned.effectiveMaxAp).toBeLessThan(light.effectiveMaxAp)
    expect(light.effectiveMaxAp).toBeLessThan(fresh)
    expect(spec.accuracyPenalty).toBeGreaterThan(0)
    expect(spec.maxStacks).toBeGreaterThan(1)
  })

  test('it lifts on its own if no more rounds arrive', () => {
    const target = unit()
    suppress(target, 2)

    for (let i = 0; i < STATUSES[StatusKind.Suppressed].turns; i++) tickStatuses([target])

    expect(stacksOn(target, StatusKind.Suppressed)).toBe(0)
  })

  test('more fire refreshes the clock as well as the count', () => {
    const target = unit()
    suppress(target, 1)
    tickStatuses([target])

    const before = target.statuses.find((s) => s.kind === StatusKind.Suppressed)!.turnsLeft
    suppress(target, 1)
    const after = target.statuses.find((s) => s.kind === StatusKind.Suppressed)!.turnsLeft

    expect(after).toBeGreaterThan(before)
  })
})

describe('Statuses that are not meant to pile up', () => {
  test('a second flash in the same turn is still one flash', () => {
    const target = unit()

    applyStatus(target, StatusKind.Flashed)
    applyStatus(target, StatusKind.Flashed)

    expect(stacksOn(target, StatusKind.Flashed)).toBe(1)
    expect(STATUSES[StatusKind.Flashed].maxStacks).toBe(1)
  })

  test('a status with no recorded count counts as one', () => {
    // Peer traffic and older saves omit it; absent must mean one, never none,
    // or a replicated status would silently do nothing.
    const target = unit()
    target.statuses.push({ kind: StatusKind.Smoked, turnsLeft: 2 })

    expect(statusStacks(target.statuses[0]!)).toBe(1)
  })
})
