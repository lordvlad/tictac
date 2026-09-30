import { describe, expect, test } from 'bun:test'
import { FATIGUE, MORALE } from '../src/config'
import { characterSheet, derive } from '../src/core/Characters'
import { Rng } from '../src/core/rng'
import { headlessSoldier } from './support/soldier'

/**
 * Consecutive deployments without rest (`[ITEM-039]`), read at construction the
 * same way a starting HP is: fixed for the match, never rolled or mutated by
 * the rules once a unit exists.
 */
describe('A tired soldier deploys already worn down', () => {
  test('the first back-to-back deployment is free', () => {
    const sheet = characterSheet(new Rng(3))
    const fresh = headlessSoldier({ sheet, fatigue: 0 })
    const once = headlessSoldier({ sheet, fatigue: 1 })
    expect(once.maxAp).toBe(fresh.maxAp)
    expect(once.morale).toBe(fresh.morale)
    expect(once.morale).toBe(MORALE.max)
  })

  test('every level past the first costs a step of max AP and starting morale', () => {
    const sheet = characterSheet(new Rng(3))
    const fresh = headlessSoldier({ sheet, fatigue: 0 })
    for (let level = 2; level <= FATIGUE.max; level++) {
      const tired = headlessSoldier({ sheet, fatigue: level })
      const steps = level - 1
      expect(tired.maxAp).toBe(fresh.maxAp - FATIGUE.apPerStep * steps)
      expect(tired.morale).toBe(MORALE.max - FATIGUE.moralePerStep * steps)
    }
  })

  test('the penalty sits on top of the sheet\u2019s own derived ceiling, not in place of it', () => {
    const sheet = characterSheet(new Rng(9))
    const { maxAp } = derive(sheet)
    const tired = headlessSoldier({ sheet, fatigue: FATIGUE.max })
    const steps = FATIGUE.max - 1
    expect(tired.maxAp).toBe(maxAp - FATIGUE.apPerStep * steps)
  })

  test('absent fatigue is the same as level zero', () => {
    const sheet = characterSheet(new Rng(3))
    const unspecified = headlessSoldier({ sheet })
    const zero = headlessSoldier({ sheet, fatigue: 0 })
    expect(unspecified.maxAp).toBe(zero.maxAp)
    expect(unspecified.morale).toBe(zero.morale)
  })
})
