import { describe, expect, test } from 'bun:test'
import { ENCOUNTER, SQUAD_SIZE } from '../src/config'
import { dealAliens, encounterChance, rollEncounter, stretchOf, type EncounterKey } from '../src/core/Encounters'
import { setOff, type Gait, type PastWaypoint, type Waypoint } from '../src/core/Travel'
import { sanitizeSheet } from '../src/core/Characters'

/**
 * Whether the road finds a squad (`src/core/Encounters.ts`, GDD-WORLD §5.1):
 * the chance of a stretch, a roll that is a pure function of its key, and the
 * aliens a contact deals.
 */

const STRETCH = { hours: 1, pace: 'normal', danger: 1 } as const

describe('The chance of a stretch', () => {
  test('is the rate per hour, scaled by hours, pace and danger', () => {
    expect(encounterChance(STRETCH)).toBeCloseTo(ENCOUNTER.perHour, 12)
    expect(encounterChance({ ...STRETCH, hours: 2 })).toBeCloseTo(2 * ENCOUNTER.perHour, 12)
    expect(encounterChance({ ...STRETCH, pace: 'cautious' })).toBeCloseTo(ENCOUNTER.perHour * ENCOUNTER.pace.cautious, 12)
    expect(encounterChance({ ...STRETCH, pace: 'flatOut' })).toBeCloseTo(ENCOUNTER.perHour * ENCOUNTER.pace.flatOut, 12)
    expect(encounterChance({ ...STRETCH, danger: 2 })).toBeCloseTo(2 * ENCOUNTER.perHour, 12)
  })

  test('is never below zero nor above the ceiling, however long or dangerous', () => {
    expect(encounterChance({ ...STRETCH, hours: 0 })).toBe(0)
    expect(encounterChance({ ...STRETCH, danger: 0 })).toBe(0)
    expect(encounterChance({ ...STRETCH, hours: -3 })).toBe(0)
    expect(encounterChance({ hours: 1000, pace: 'flatOut', danger: 50 })).toBe(ENCOUNTER.ceiling)
  })
})

describe('Rolling a checkpoint', () => {
  const key: EncounterKey = { squad: 'squad-1', trip: 'trip-1', index: 3 }

  test('gives the same answer for the same key and stretch, every time', () => {
    const certain = { hours: 1000, pace: 'normal', danger: 1 } as const
    const rolls = Array.from({ length: 5 }, () => rollEncounter(key, certain))
    for (const roll of rolls) expect(roll).toEqual(rolls[0]!)
    // A key that did not meet stays that way: the roll is not drawn, it is derived.
    const quiet = { ...key, index: 4 }
    expect(rollEncounter(quiet, { ...STRETCH, hours: 0 })).toEqual({ met: false })
    expect(rollEncounter(quiet, { ...STRETCH, hours: 0 })).toEqual({ met: false })
  })

  test('is independent per checkpoint, trip and squad', () => {
    const certain = { hours: 1000, pace: 'normal', danger: 1 } as const
    // The ceiling leaves one roll in ten empty, so count only the aliens that came.
    const seedsOf = (keys: EncounterKey[]) =>
      new Set(keys.flatMap((each) => {
        const roll = rollEncounter(each, certain)
        return roll.met ? [roll.alienSeed] : []
      }))
    const checkpoints = Array.from({ length: 50 }, (_, index) => ({ ...key, index }))
    const trips = Array.from({ length: 50 }, (_, n) => ({ ...key, trip: `trip-${n}` }))
    const squads = Array.from({ length: 50 }, (_, n) => ({ ...key, squad: `squad-${n}` }))
    for (const keys of [checkpoints, trips, squads]) {
      const met = keys.filter((each) => rollEncounter(each, certain).met).length
      expect(met).toBeGreaterThan(35)
      expect(seedsOf(keys).size).toBe(met)
    }
  })

  test('meets at about the chance it states, over many keys', () => {
    const stretch = { hours: 2, pace: 'normal', danger: 1 } as const
    const expected = encounterChance(stretch)
    const trials = 20_000
    let met = 0
    for (let n = 0; n < trials; n++) {
      if (rollEncounter({ squad: 's', trip: 't', index: n }, stretch).met) met++
    }
    const sigma = Math.sqrt((expected * (1 - expected)) / trials)
    expect(Math.abs(met / trials - expected)).toBeLessThan(5 * sigma)
  })

  test('deals every size offset, and the odds do not move who comes', () => {
    const offsets = new Set<number>()
    for (let n = 0; n < 200; n++) {
      const roll = rollEncounter({ squad: 's', trip: 't', index: n }, { hours: 1000, pace: 'normal', danger: 1 })
      if (roll.met) offsets.add(roll.sizeOffset)
    }
    expect([...offsets].sort()).toEqual([-1, 0, 1])

    // Tuning how likely a contact is never reshuffles the aliens a given key brings.
    const likely = rollEncounter(key, { hours: 1000, pace: 'normal', danger: 1 })
    const likelier = rollEncounter(key, { hours: 1000, pace: 'flatOut', danger: 9 })
    expect(likely).toEqual(likelier)
  })
})

describe('Dealing the aliens', () => {
  test('the same seed and size deal the same squad; another seed does not', () => {
    expect(dealAliens(7, SQUAD_SIZE)).toEqual(dealAliens(7, SQUAD_SIZE))
    expect(dealAliens(7, SQUAD_SIZE)).not.toEqual(dealAliens(8, SQUAD_SIZE))
  })

  test('is as many as asked, each with a readable sheet and a kit, and belongs to no roster', () => {
    for (const size of [1, 2, SQUAD_SIZE]) {
      const aliens = dealAliens(99, size)
      expect(aliens).toHaveLength(size)
      for (const alien of aliens) {
        expect(sanitizeSheet(alien.sheet)).toEqual(alien.sheet)
        expect(alien.loadout).toBeDefined()
        expect(alien.characterId).toBeUndefined()
      }
    }
  })
})

describe('What a checkpoint weighs', () => {
  const home = { kind: 'past', lat: 48.78, lng: 9.18, arrival: 0, departed: null } satisfies PastWaypoint
  const trip = (gait: Gait, km: number): readonly Waypoint[] =>
    setOff([home], { lat: home.lat + km / 111.2, lng: home.lng }, gait, 0, 'trip')!

  test('is the hours since the previous checkpoint, at the pace of the trip', () => {
    // 12.5 km at 5 km/h: two and a half hours, so checkpoints at 1h, 2h and the end at 2.5h.
    const route = trip({ mode: 'foot', pace: 'normal' }, 12.5)
    expect(stretchOf(route, 'trip', 0)).toEqual({ hours: 1, pace: 'normal', danger: ENCOUNTER.dangerEverywhere })
    expect(stretchOf(route, 'trip', 1)!.hours).toBeCloseTo(1, 2)
    expect(stretchOf(route, 'trip', 2)!.hours).toBeCloseTo(0.5, 2)
    expect(stretchOf(route, 'trip', 3)).toBeNull()
    expect(stretchOf(trip({ mode: 'foot', pace: 'flatOut' }, 12.5), 'trip', 0)!.pace).toBe('flatOut')
  })

  test('is null for a trip the route does not hold', () => {
    expect(stretchOf(trip({ mode: 'foot', pace: 'normal' }, 12.5), 'other', 0)).toBeNull()
  })

  test('the first stretch of a short trip is its whole length', () => {
    const route = trip({ mode: 'foot', pace: 'cautious' }, 1.5)
    expect(stretchOf(route, 'trip', 0)!.hours).toBeCloseTo(0.5, 2)
  })
})
