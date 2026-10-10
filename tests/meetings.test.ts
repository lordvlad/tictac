import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { firstContact } from '../src/core/Meetings'
import { Rng } from '../src/core/rng'
import {
  distanceKm,
  EARTH_RADIUS_KM,
  type Gait,
  interpolate,
  type LatLng,
  type PastWaypoint,
  plannedArrivals,
  positionAt,
  type Waypoint,
} from '../src/core/Travel'

/**
 * Where two routes bring squads within reach of each other (`src/core/Meetings.ts`).
 * Fixtures are frozen, so a function that wrote to its input would throw, and
 * `Date.now` throws for the whole file, as in `tests/travel.test.ts`.
 *
 * Most of the geometry sits on a meridian, where the haversine distance is
 * exactly the difference of latitudes times the radius, so an expected moment
 * can be written down by arithmetic on kilometres and a speed.
 */

const NOW = Date.UTC(2026, 9, 7, 12)
const MIN = 60_000
const HOUR = 3_600_000
const CAUTIOUS: Gait = { mode: 'foot', pace: 'cautious' }
const NORMAL: Gait = { mode: 'foot', pace: 'normal' }
const FLAT_OUT: Gait = { mode: 'foot', pace: 'flatOut' }
const GAITS = [CAUTIOUS, NORMAL, FLAT_OUT]
const KM_PER_DEGREE = (EARTH_RADIUS_KM * Math.PI) / 180
/** `ENCOUNTER.meetingRangeKm`. */
const RANGE = 1

const nowSpy = spyOn(Date, 'now')
beforeAll(() =>
  nowSpy.mockImplementation(() => {
    throw new Error('the meeting maths read the wall clock')
  }),
)
afterAll(() => nowSpy.mockRestore())

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) frozen(inner)
    Object.freeze(value)
  }
  return value
}

/** `km` north of 48°N on the 9.18°E meridian. */
const north = (km: number): LatLng => ({ lat: 48 + km / KM_PER_DEGREE, lng: 9.18 })

/** A point `east` and `north` kilometres from the equator at the prime meridian. */
const equator = (east: number, northward: number): LatLng => ({ lat: northward / KM_PER_DEGREE, lng: east / KM_PER_DEGREE })

const resting = (at: LatLng, arrival = NOW): readonly Waypoint[] =>
  frozen<PastWaypoint[]>([{ kind: 'past', lat: at.lat, lng: at.lng, arrival, departed: null }])

/** A squad that left `start` at `departure`, on trip `t1`, for `stops`. */
function walking(gait: Gait, departure: number, start: LatLng, ...stops: LatLng[]): readonly Waypoint[] {
  return frozen([
    { kind: 'past', lat: start.lat, lng: start.lng, arrival: departure, departed: { at: departure, trip: 't1', gait } },
    ...stops.map((stop) => ({ kind: 'future' as const, lat: stop.lat, lng: stop.lng })),
  ])
}

/** Walking time at a normal pace over `km`. */
const normalMs = (km: number) => (km / 5) * HOUR

/** The moment is the expected one to the millisecond it is rounded up to. */
function expectAt(contact: { at: number } | null, expected: number, toleranceMs = 1) {
  expect(contact).not.toBeNull()
  expect(Math.abs(contact!.at - expected)).toBeLessThanOrEqual(toleranceMs)
}

/** The great-circle distance between the two squads at `at`. */
function apartKm(a: readonly Waypoint[], b: readonly Waypoint[], at: number) {
  return distanceKm(positionAt(a, at).position, positionAt(b, at).position)
}

describe('Two squads walking', () => {
  test('head-on: they meet when what is left between them is the range', () => {
    // 10 km apart, closing at 10 km/h: 9 km of it before they are one apart.
    const a = walking(NORMAL, NOW, north(0), north(20))
    const b = walking(NORMAL, NOW, north(10), north(0))
    const contact = firstContact(a, b, NOW, RANGE)
    expectAt(contact, NOW + 54 * MIN)
    expect(contact!.place.lat).toBeCloseTo(north(5).lat, 9)
    expect(contact!.place.lng).toBeCloseTo(9.18, 9)
  })

  test('crossing: two routes that cross at the same time meet short of the crossing', () => {
    // Each is 5 km from the crossing at the start, so each is x = 5 - 5t short of
    // it, and they are one apart when the two of them make a hypotenuse of 1 km.
    const a = walking(NORMAL, NOW, equator(-5, 0), equator(5, 0))
    const b = walking(NORMAL, NOW, equator(0, -5), equator(0, 5))
    const contact = firstContact(a, b, NOW, RANGE)
    expectAt(contact, NOW + (1 - 1 / (5 * Math.SQRT2)) * HOUR, 1000)
    expect(apartKm(a, b, contact!.at)).toBeCloseTo(RANGE, 5)
    expect(contact!.place.lng * KM_PER_DEGREE).toBeCloseTo(-1 / (2 * Math.SQRT2), 4)
    expect(contact!.place.lat * KM_PER_DEGREE).toBeCloseTo(-1 / (2 * Math.SQRT2), 4)
  })

  test('crossing at different times: the routes cross, the squads do not', () => {
    // B gets there an hour after A has gone by.
    const a = walking(NORMAL, NOW, equator(-5, 0), equator(5, 0))
    const b = walking(NORMAL, NOW, equator(0, -10), equator(0, 5))
    expect(firstContact(a, b, NOW, RANGE)).toBeNull()
  })

  test('overtaking: the faster squad behind closes the gap', () => {
    // 6 km apart, and flat out against cautious gains 4 km/h: 5 km of it to be one apart.
    const a = walking(FLAT_OUT, NOW, north(0), north(30))
    const b = walking(CAUTIOUS, NOW, north(6), north(30))
    expectAt(firstContact(a, b, NOW, RANGE), NOW + 75 * MIN)
  })

  test('the slower squad behind never catches up, unless the faster one has stopped for it', () => {
    const b = walking(FLAT_OUT, NOW, north(6), north(30))
    expect(firstContact(walking(CAUTIOUS, NOW, north(0), north(20)), b, NOW, RANGE)).toBeNull()
    // At rest at the end of its route, B is a point, and A walks up to it.
    expectAt(firstContact(walking(CAUTIOUS, NOW, north(0), north(30)), b, NOW, RANGE), NOW + (29 / 3) * HOUR)
  })

  test('parallel routes that stay out of range never meet', () => {
    const east = (km: number) => ({ ...north(km), lng: 9.18 + 3 / (KM_PER_DEGREE * Math.cos((48 * Math.PI) / 180)) })
    const a = walking(NORMAL, NOW, north(0), north(10))
    const b = walking(NORMAL, NOW, east(0), east(10))
    expect(firstContact(a, b, NOW, RANGE)).toBeNull()
  })

  test('parallel routes that start within range have already met: null', () => {
    const east = (km: number) => ({ ...north(km), lng: 9.18 + 0.5 / (KM_PER_DEGREE * Math.cos((48 * Math.PI) / 180)) })
    const a = walking(NORMAL, NOW, north(0), north(10))
    const b = walking(NORMAL, NOW, east(0), east(10))
    expect(firstContact(a, b, NOW, RANGE)).toBeNull()
  })

  test('squads that start within range, part and come back meet when they come back', () => {
    // Half a kilometre from B, A walks 3 km away (out of range at 1 km, 6 minutes in) and
    // back: 2 km of the way home takes it to a kilometre from B.
    const a = walking(NORMAL, NOW, north(0.5), north(3), north(0))
    const b = resting(north(0))
    expectAt(firstContact(a, b, NOW, RANGE), NOW + normalMs(2.5) + normalMs(2))
  })
})

describe('Squads at rest', () => {
  test('a resting squad is a point that a travelling one passes', () => {
    const a = walking(NORMAL, NOW, north(-5), north(5))
    const contact = firstContact(a, resting(north(0)), NOW, RANGE)
    expectAt(contact, NOW + normalMs(4))
    expect(contact!.place.lat).toBeCloseTo(north(-0.5).lat, 9)
  })

  test('one that stops short of the range is not met', () => {
    expect(firstContact(walking(NORMAL, NOW, north(-5), north(-2)), resting(north(0)), NOW, RANGE)).toBeNull()
  })

  test('one that stops inside the range is met on the way in', () => {
    expectAt(firstContact(walking(NORMAL, NOW, north(-5), north(-0.5)), resting(north(0)), NOW, RANGE), NOW + normalMs(4))
  })

  test('two squads at rest do not meet, near or far', () => {
    expect(firstContact(resting(north(0)), resting(north(5)), NOW, RANGE)).toBeNull()
    expect(firstContact(resting(north(0)), resting(north(0.2)), NOW, RANGE)).toBeNull()
  })

  test('a squad that has not set off yet stands at its origin until it does', () => {
    // B stands 3 km north of A, and sets off for it half an hour in; A and B are a kilometre
    // apart after the 2 km that takes.
    const a = resting(north(3))
    const b = walking(NORMAL, NOW + 30 * MIN, north(0), north(10))
    expectAt(firstContact(a, b, NOW, RANGE), NOW + 30 * MIN + normalMs(2))
  })

  test('a squad whose route has ended is met where it ended', () => {
    // A's 5 km are done in an hour, and B comes down from the north after that.
    const a = walking(NORMAL, NOW, north(0), north(5))
    const b = walking(NORMAL, NOW + 3 * HOUR, north(15), north(0))
    expectAt(firstContact(a, b, NOW, RANGE), NOW + 3 * HOUR + normalMs(9))
  })
})

describe('Crossings and the first of them', () => {
  // A passes B at 0 km, from the south to 5 km north of it, and back to the south: two passes.
  const a = walking(NORMAL, NOW, north(-5), north(5), north(-5))
  const b = resting(north(0))

  test('the first of several is the one found', () => {
    expectAt(firstContact(a, b, NOW, RANGE), NOW + normalMs(4))
  })

  test('from after the first, the second is found', () => {
    // At 1.5 h A is 2.5 km north, out of range, with 2.5 km to go to the turn.
    expectAt(firstContact(a, b, NOW + 90 * MIN, RANGE), NOW + normalMs(10 + 4))
  })

  test('from in the middle of the first, the pair has already met: the second is found', () => {
    expectAt(firstContact(a, b, NOW + 60 * MIN, RANGE), NOW + normalMs(10 + 4))
  })

  test('from after the last there is none', () => {
    expect(firstContact(a, b, NOW + normalMs(10 + 4) + 1, RANGE)).toBeNull()
  })

  test('the moment does not depend on from, so that asking again from just before it is the same answer', () => {
    const head = walking(NORMAL, NOW, north(0), north(20))
    const oncoming = walking(NORMAL, NOW, north(10), north(0))
    const first = firstContact(head, oncoming, NOW, RANGE)
    expect(first).not.toBeNull()
    for (const from of [NOW - HOUR, NOW + 10 * MIN, NOW + 53 * MIN, first!.at - 1]) {
      expect(firstContact(head, oncoming, from, RANGE)).toEqual(first)
    }
  })
})

describe('Touching exactly', () => {
  test('the closest approach is the range: a touch counts as meeting', () => {
    // A walks east along a parallel exactly a kilometre north of B, past it.
    const row = (lng: number) => ({ lat: north(1).lat, lng })
    const a = walking(NORMAL, NOW, row(9.06), row(9.3))
    const half = (distanceKm(row(9.06), row(9.3)) / 5) * HOUR * 0.5
    // The touch is a moment, and the range is met a hair before it (a billionth of it), in time:
    // under a tenth of a second.
    expectAt(firstContact(a, resting(north(0)), NOW, RANGE), NOW + half, 100)
  })

  test('a metre short of touching is not a meeting, and a metre inside is', () => {
    const row = (km: number) => (lng: number) => ({ lat: north(km).lat, lng })
    const half = (km: number) => (distanceKm(row(km)(9.06), row(km)(9.3)) / 5) * HOUR * 0.5
    const outside = walking(NORMAL, NOW, row(1.001)(9.06), row(1.001)(9.3))
    expect(firstContact(outside, resting(north(0)), NOW, RANGE)).toBeNull()
    const inside = walking(NORMAL, NOW, row(0.999)(9.06), row(0.999)(9.3))
    // The chord at 0.999 km is 2 × 44.7 m long, so the squad is in range for 36 seconds around the middle.
    expectAt(firstContact(inside, resting(north(0)), NOW, RANGE), NOW + half(0.999) - (0.0447 / 5) * HOUR, 1000)
  })

  test('a leg that ends exactly at the range, where the squad goes on in, is a meeting at the end of the leg', () => {
    const a = walking(NORMAL, NOW, north(5), north(1), north(-5))
    expectAt(firstContact(a, resting(north(0)), NOW, RANGE), NOW + normalMs(4))
  })

  test('a leg that ends exactly at the range, where the squad turns back, is a touch and a meeting', () => {
    const a = walking(NORMAL, NOW, north(5), north(1), north(5))
    expectAt(firstContact(a, resting(north(0)), NOW, RANGE), NOW + normalMs(4))
  })

  test('the same, a metre short, is not', () => {
    const a = walking(NORMAL, NOW, north(5), north(1.001), north(5))
    expect(firstContact(a, resting(north(0)), NOW, RANGE)).toBeNull()
  })

  test('a leg that takes no time is no leg', () => {
    const plain = walking(NORMAL, NOW, north(-5), north(5))
    const doubled = walking(NORMAL, NOW, north(-5), north(-5), north(5), north(5))
    const standing = resting(north(0))
    expect(firstContact(doubled, standing, NOW, RANGE)).toEqual(firstContact(plain, standing, NOW, RANGE))
  })

  test('a squad sent where it already stands has nowhere to go: it is at rest', () => {
    const toItself = walking(NORMAL, NOW, north(0), north(0))
    expect(firstContact(toItself, resting(north(5)), NOW, RANGE)).toBeNull()
    expectAt(firstContact(toItself, walking(NORMAL, NOW, north(10), north(0)), NOW, RANGE), NOW + normalMs(9))
  })
})

describe('After an arrival', () => {
  const a = walking(NORMAL, NOW, north(0), north(5))
  const arrival = plannedArrivals(a)[0]!

  test('a squad that has arrived and nobody else on the move: no meeting, however soon after', () => {
    const b = resting(north(8))
    for (const from of [arrival - 1, arrival, arrival + 1, arrival + 5 * HOUR]) {
      expect(firstContact(a, b, from, RANGE)).toBeNull()
    }
  })

  test('one that has arrived is a point for the other to walk into', () => {
    const b = walking(NORMAL, arrival + 10 * MIN, north(15), north(0))
    expectAt(firstContact(a, b, arrival + 1, RANGE), arrival + 10 * MIN + normalMs(9))
  })
})

describe('Round the globe', () => {
  test('a squad walks across the antimeridian to one that stands just beyond it', () => {
    const start = { lat: 0, lng: 179.9 }
    const end = { lat: 0, lng: -179.9 }
    const stands = { lat: 0, lng: -179.99 }
    const a = walking(NORMAL, NOW, start, end)
    // A gets within a kilometre of B from the west of it: a tenth of a degree to the antimeridian,
    // and the rest of the way, out of the 0.2 degrees of the leg.
    const entry = stands.lng - RANGE / KM_PER_DEGREE
    const progress = (0.1 + (entry + 180)) / 0.2
    const contact = firstContact(a, resting(stands), NOW, RANGE)
    expectAt(contact, NOW + progress * normalMs(distanceKm(start, end)), 1000)
    expect(apartKm(a, resting(stands), contact!.at)).toBeCloseTo(RANGE, 5)
  })

  test('two squads walking at one another across the antimeridian meet on it', () => {
    const a = walking(NORMAL, NOW, { lat: 0, lng: 179.95 }, { lat: 0, lng: -179.9 })
    const b = walking(NORMAL, NOW, { lat: 0, lng: -179.95 }, { lat: 0, lng: 179.9 })
    const contact = firstContact(a, b, NOW, RANGE)
    expectAt(contact, NOW + ((0.1 * KM_PER_DEGREE - RANGE) / 10) * HOUR, 1000)
    expect(Math.abs(contact!.place.lng)).toBeCloseTo(180, 6)
    expect(contact!.place.lat).toBeCloseTo(0, 9)
  })

  test('squads far apart in longitude close the last of 360 degrees within one stretch', () => {
    // A walks 95 degrees west and B 95 degrees east, so they have gone round the other side of
    // the world to one place, and where each started, 170 degrees from the other, tells nothing
    // of that. They have been moving for as long as each other the whole way.
    const a = walking(NORMAL, NOW, { lat: 0, lng: 0 }, { lat: 0, lng: -95 })
    const b = walking(NORMAL, NOW, { lat: 0, lng: 170 }, { lat: 0, lng: -95 })
    const contact = firstContact(a, b, NOW, RANGE)
    const lengthMs = normalMs(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: -95 }))
    expectAt(contact, NOW + lengthMs * (1 - RANGE / KM_PER_DEGREE / 190), 1000)
    expect(apartKm(a, b, contact!.at)).toBeCloseTo(RANGE, 5)
  })
})

describe('How far the flat frame is from the sphere', () => {
  // `Meetings.ts` solves in a flat frame at the pair's mean latitude. At a kilometre that is off
  // by tens of micrometres; what remains here is the moment's rounding up to a millisecond
  // (3.9 mm at most, for two squads closing at 14 km/h), so a centimetre bounds it with room.
  const CENTIMETRE = 1e-5

  test('walking at a resting squad from any side, at any latitude a squad can stand', () => {
    for (const lat of [0, 30, 48.78, 65, 80, 87]) {
      for (const bearing of [0, 40, 90, 135, 200, 270, 315]) {
        const stands = { lat, lng: 9 }
        const radians = (bearing * Math.PI) / 180
        const start = {
          lat: lat + (6 * Math.cos(radians)) / KM_PER_DEGREE,
          lng: 9 + (6 * Math.sin(radians)) / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180)),
        }
        const a = walking(NORMAL, NOW, start, stands)
        const contact = firstContact(a, resting(stands), NOW, RANGE)
        expect(contact).not.toBeNull()
        expect(Math.abs(apartKm(a, resting(stands), contact!.at) - RANGE)).toBeLessThan(CENTIMETRE)
      }
    }
  })

  test('for other ranges', () => {
    for (const range of [0.05, 0.3, 3, 10]) {
      const a = walking(FLAT_OUT, NOW, north(-30), north(30))
      const contact = firstContact(a, resting(north(0)), NOW, range)
      expect(Math.abs(apartKm(a, resting(north(0)), contact!.at) - range)).toBeLessThan(CENTIMETRE)
    }
  })

  test('a leg thousands of kilometres long, over latitudes where the cosine is not the same', () => {
    // B walks on from Africa to the Baltic, and A stands where it passes, 60% of the way along.
    // The flat frame is only right where the meeting is, which is not where the leg starts.
    const from = { lat: 30, lng: -10 }
    const to = { lat: 60, lng: 25 }
    const b = walking(NORMAL, NOW, from, to)
    const stands = interpolate(from, to, 0.6)
    const contact = firstContact(resting(stands), b, NOW, RANGE)
    expect(contact).not.toBeNull()
    expect(Math.abs(apartKm(resting(stands), b, contact!.at) - RANGE)).toBeLessThan(CENTIMETRE)
    const progress = (contact!.at - NOW) / (plannedArrivals(b)[0]! - NOW)
    expect(progress).toBeGreaterThan(0.59)
    expect(progress).toBeLessThan(0.6)
  })
})

describe('Against sampling every second', () => {
  /** The first second at which the squads are within range having been out of it a second before. */
  function sampledEntry(a: readonly Waypoint[], b: readonly Waypoint[], from: number, range: number): number | null {
    const horizon = Math.max(from, ...plannedArrivals(a), ...plannedArrivals(b))
    let before = apartKm(a, b, from) <= range
    for (let at = from + 1000; at <= horizon + 1000; at += 1000) {
      const now = apartKm(a, b, at) <= range
      if (now && !before) return at
      before = now
    }
    return null
  }

  /** Near `towards` for the first stop, as often as not, or else a random hop from where the squad is. */
  function randomRoute(rng: Rng, start: LatLng, towards: LatLng): readonly Waypoint[] {
    let here = start
    const stops: LatLng[] = []
    for (let stop = rng.int(0, 3); stop > 0; stop--) {
      here =
        stops.length === 0 && rng.chance(0.6)
          ? { lat: towards.lat + rng.range(-0.012, 0.012), lng: towards.lng + rng.range(-0.018, 0.018) }
          : { lat: here.lat + rng.range(-0.03, 0.03), lng: here.lng + rng.range(-0.045, 0.045) }
      stops.push(here)
    }
    if (stops.length === 0) return resting(start)
    return walking(rng.pick(GAITS), NOW + rng.int(-20, 20) * MIN, start, ...stops)
  }

  /** Two squads a few kilometres apart, which is about the range of the route's own reach. */
  function randomPair(rng: Rng): [readonly Waypoint[], readonly Waypoint[]] {
    const one = { lat: 48.78 + rng.range(-0.01, 0.01), lng: 9.18 + rng.range(-0.015, 0.015) }
    const bearing = rng.range(0, 2 * Math.PI)
    const km = rng.range(1.5, 6)
    const other = {
      lat: one.lat + (km * Math.cos(bearing)) / KM_PER_DEGREE,
      lng: one.lng + (km * Math.sin(bearing)) / (KM_PER_DEGREE * Math.cos((48.78 * Math.PI) / 180)),
    }
    return [randomRoute(rng, one, other), randomRoute(rng, other, one)]
  }

  test('the solved moment is the first sampled one, to the second, and null is nobody meeting', () => {
    const rng = new Rng(20261009)
    let met = 0
    let passed = 0
    for (let trial = 0; trial < 200; trial++) {
      const [a, b] = randomPair(rng)
      const range = rng.pick([0.3, 1, 2.5])
      const from = NOW + rng.int(-10, 30) * MIN
      const solved = firstContact(a, b, from, range)
      const sampled = sampledEntry(a, b, from, range)
      if (solved === null) {
        expect(sampled).toBeNull()
        passed++
        continue
      }
      met++
      expect(sampled).not.toBeNull()
      // The sample after the moment is no more than a second later, and cannot be before it.
      expect(sampled! - solved.at).toBeGreaterThanOrEqual(0)
      expect(sampled! - solved.at).toBeLessThanOrEqual(1000)
      expect(solved.at).toBeGreaterThanOrEqual(from)
      expect(Math.abs(apartKm(a, b, solved.at) - range)).toBeLessThan(1e-5)
      const there = interpolate(positionAt(a, solved.at).position, positionAt(b, solved.at).position, 0.5)
      expect(distanceKm(solved.place, there)).toBeLessThan(1e-6)
      expect(firstContact(a, b, solved.at - 1, range)).toEqual(solved)
    }
    // Neither side of the comparison is empty.
    expect(met).toBeGreaterThan(40)
    expect(passed).toBeGreaterThan(40)
  })
})
