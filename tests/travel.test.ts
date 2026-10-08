import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import {
  addStop,
  checkpoints,
  CHECKPOINT_INTERVAL_MS,
  detour,
  distanceKm,
  type Gait,
  isAtRest,
  type PastWaypoint,
  plannedArrivals,
  positionAt,
  redirect,
  setOff,
  settle,
  stop,
  type Waypoint,
} from '../src/core/Travel'

/**
 * The travel maths (`src/core/Travel.ts`). The first sixteen tests are ported
 * from `../no-way-home/packages/shared/src/waypoint-utils.test.ts`, onto an
 * injected clock and lists that cannot be changed: every fixture is frozen, so
 * a function that wrote to its input would throw here, and `Date.now` throws
 * for the whole file, so one that read the wall clock would too.
 */

const NOW = Date.UTC(2026, 9, 7, 12)
const MIN = 60_000
const CAUTIOUS: Gait = { mode: 'foot', pace: 'cautious' }
const NORMAL: Gait = { mode: 'foot', pace: 'normal' }
const FLAT_OUT: Gait = { mode: 'foot', pace: 'flatOut' }

const nowSpy = spyOn(Date, 'now')
beforeAll(() =>
  nowSpy.mockImplementation(() => {
    throw new Error('the travel maths read the wall clock')
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

const resting = (lat: number, lng: number, arrival = NOW): PastWaypoint => ({
  kind: 'past',
  lat,
  lng,
  arrival,
  departed: null,
})

/** A squad that left (48.78, 9.18) at `departure` for `stops`, on trip `t1`. */
function travelling(departure: number, gait: Gait, ...stops: [number, number][]): readonly Waypoint[] {
  return frozen([
    { kind: 'past', lat: 48.78, lng: 9.18, arrival: departure, departed: { at: departure, trip: 't1', gait } },
    ...stops.map(([lat, lng]) => ({ kind: 'future' as const, lat, lng })),
  ])
}

describe('At rest or travelling', () => {
  test('an empty list is at rest', () => {
    expect(isAtRest([])).toBe(true)
  })

  test('a single waypoint with no departure is at rest', () => {
    expect(isAtRest(frozen([resting(48.78, 9.18)]))).toBe(true)
  })

  test('a list with a destination is travelling', () => {
    expect(isAtRest(travelling(NOW, CAUTIOUS, [48.79, 9.19]))).toBe(false)
  })
})

describe('Where the squad is', () => {
  test('at rest, where it last arrived', () => {
    const state = positionAt(frozen([resting(48.78, 9.18)]), NOW)
    expect(state).toEqual({ travelling: false, position: { lat: 48.78, lng: 9.18 } })
  })

  test('travelling, between its waypoints by time and speed', () => {
    // About 1.33 km at 3 km/h is about 27 minutes; 14 minutes in is about halfway.
    const state = positionAt(travelling(NOW - 14 * MIN, CAUTIOUS, [48.79, 9.19]), NOW)
    if (!state.travelling) throw new Error('should be travelling')
    expect(state.position.lat).toBeGreaterThan(48.78)
    expect(state.position.lat).toBeLessThan(48.79)
    expect(state.position.lng).toBeGreaterThan(9.18)
    expect(state.position.lng).toBeLessThan(9.19)
    expect(state.leg.progress).toBeGreaterThan(0.4)
    expect(state.leg.progress).toBeLessThan(0.6)
  })

  test('past its arrival time, at its destination', () => {
    const state = positionAt(travelling(NOW - 60 * MIN, CAUTIOUS, [48.787, 9.187]), NOW)
    if (!state.travelling) throw new Error('should be travelling')
    expect(state.leg.progress).toBe(1)
    expect(state.position.lat).toBeCloseTo(48.787, 3)
    expect(state.position.lng).toBeCloseTo(9.187, 3)
  })
})

describe('Go here', () => {
  test('departs from where the squad rests, at the gait and on the trip it is given', () => {
    const waypoints = frozen([resting(48.78, 9.18, NOW - 1000)])
    const route = setOff(waypoints, { lat: 48.79, lng: 9.19 }, CAUTIOUS, NOW, 't1')!

    expect(route).toEqual([
      { kind: 'past', lat: 48.78, lng: 9.18, arrival: NOW - 1000, departed: { at: NOW, trip: 't1', gait: CAUTIOUS } },
      { kind: 'future', lat: 48.79, lng: 9.19 },
    ])
  })

  test('is refused to a squad already travelling', () => {
    expect(setOff(travelling(NOW, CAUTIOUS, [48.79, 9.19]), { lat: 48.8, lng: 9.2 }, CAUTIOUS, NOW, 't2')).toBeNull()
  })
})

describe('Stop', () => {
  test('rests the squad where it is now', () => {
    const waypoints = travelling(NOW - 1_000_000, CAUTIOUS, [48.79, 9.19])
    const stopped = stop(waypoints, NOW)!

    expect(stopped).toHaveLength(2)
    expect(stopped[1]).toEqual({ kind: 'past', ...positionAt(waypoints, NOW).position, arrival: NOW, departed: null })
  })

  test('is refused to a squad at rest', () => {
    expect(stop(frozen([resting(48.78, 9.18)]), NOW)).toBeNull()
  })
})

describe('Go here now', () => {
  test('turns from where the squad is towards the new place, on a new trip', () => {
    const waypoints = travelling(NOW - 1_000_000, CAUTIOUS, [48.79, 9.19])
    const route = redirect(waypoints, { lat: 48.8, lng: 9.2 }, NORMAL, NOW, 't2')!

    expect(route).toHaveLength(3)
    expect(route[1]).toEqual({
      kind: 'past',
      ...positionAt(waypoints, NOW).position,
      arrival: NOW,
      departed: { at: NOW, trip: 't2', gait: NORMAL },
    })
    expect(route[2]).toEqual({ kind: 'future', lat: 48.8, lng: 9.2 })
  })
})

describe('Go here first', () => {
  test('detours from where the squad is, then carries on to where it was going', () => {
    const waypoints = travelling(NOW - 500_000, CAUTIOUS, [48.79, 9.19])
    const route = detour(waypoints, { lat: 48.785, lng: 9.185 }, NOW)!

    expect(route.map((waypoint) => [waypoint.kind, waypoint.lat])).toEqual([
      ['past', 48.78],
      ['past', positionAt(waypoints, NOW).position.lat],
      ['future', 48.785],
      ['future', 48.79],
    ])
    // The same trip at the same gait: a detour is part of the journey, not a new one.
    expect((route[1] as PastWaypoint).departed).toEqual({ at: NOW, trip: 't1', gait: CAUTIOUS })
  })
})

describe('Arriving', () => {
  test('is recorded at the moment it was due, not when it was noticed', () => {
    const waypoints = travelling(NOW - 30 * MIN, CAUTIOUS, [48.79, 9.19])
    const due = plannedArrivals(waypoints)[0]!
    const settled = settle(waypoints, NOW)

    expect(due).toBeLessThan(NOW)
    expect(settled[1]).toEqual({ kind: 'past', lat: 48.79, lng: 9.19, arrival: due, departed: null })
    expect(isAtRest(settled)).toBe(true)
  })

  test('on the way, carries on at once on the same trip at the same gait', () => {
    const waypoints = travelling(NOW - 30 * MIN, CAUTIOUS, [48.79, 9.19], [48.8, 9.2])
    const [first] = plannedArrivals(waypoints)
    const settled = settle(waypoints, NOW)

    expect((settled[1] as PastWaypoint).departed).toEqual({ at: first!, trip: 't1', gait: CAUTIOUS })
    expect(settled[2]).toEqual({ kind: 'future', lat: 48.8, lng: 9.2 })
  })
})

describe('Distance', () => {
  test('Stuttgart centre to a point about a kilometre away', () => {
    const km = distanceKm({ lat: 48.7775, lng: 9.18 }, { lat: 48.787, lng: 9.187 })
    expect(km).toBeGreaterThan(1.0)
    expect(km).toBeLessThan(1.2)
  })

  test('is zero to the same place', () => {
    expect(distanceKm({ lat: 48.78, lng: 9.18 }, { lat: 48.78, lng: 9.18 })).toBe(0)
  })
})

describe('Beyond the port', () => {
  test('a route of several stops is followed by the clock alone, and settling never moves the squad', () => {
    const waypoints = travelling(NOW, NORMAL, [48.79, 9.19], [48.8, 9.17], [48.81, 9.2])
    const [, second, last] = plannedArrivals(waypoints)
    for (const at of [NOW + 5 * MIN, (second! + last!) / 2, last! + 1]) {
      expect(positionAt(settle(waypoints, at), at).position).toEqual(positionAt(waypoints, at).position)
    }
    const midway = positionAt(waypoints, (second! + last!) / 2)
    expect(midway.travelling && midway.leg.index).toBe(2)
  })

  test('pace decides speed: flat out covers seven thirds of what cautious does in the same time', () => {
    const far: [number, number] = [48.9, 9.3]
    const after = NOW + 30 * MIN
    const covered = (gait: Gait) => {
      const state = positionAt(travelling(NOW, gait, far), after)
      if (!state.travelling) throw new Error('should be travelling')
      return state.leg.distanceKm - state.leg.remainingKm
    }
    expect(covered(CAUTIOUS)).toBeCloseTo(1.5, 6)
    expect(covered(FLAT_OUT)).toBeCloseTo(3.5, 6)
  })

  test('a leg across the antimeridian goes the short way round', () => {
    const waypoints = frozen([
      { kind: 'past' as const, lat: -17, lng: 179.9, arrival: NOW, departed: { at: NOW, trip: 't1', gait: CAUTIOUS } },
      { kind: 'future' as const, lat: -17, lng: -179.9 },
    ])
    const halfway = (NOW + plannedArrivals(waypoints)[0]!) / 2
    expect(Math.abs(positionAt(waypoints, halfway).position.lng)).toBeCloseTo(180, 6)
  })

  test('a destination where the squad already stands is reached at once', () => {
    const waypoints = travelling(NOW, CAUTIOUS, [48.78, 9.18])
    expect(plannedArrivals(waypoints)).toEqual([NOW])
    expect(positionAt(waypoints, NOW).position).toEqual({ lat: 48.78, lng: 9.18 })
  })

  test('go here next adds to the end of the route, but not for a squad that has arrived', () => {
    const waypoints = travelling(NOW, CAUTIOUS, [48.79, 9.19])
    expect(addStop(waypoints, { lat: 48.8, lng: 9.2 }, NOW + MIN)?.at(-1)).toEqual({ kind: 'future', lat: 48.8, lng: 9.2 })
    expect(addStop(waypoints, { lat: 48.8, lng: 9.2 }, NOW + 60 * MIN)).toBeNull()
  })
})

describe('Checkpoints', () => {
  // About 11 km at 3 km/h: three and a half hours.
  const long = () => travelling(NOW, CAUTIOUS, [48.88, 9.18])

  test('fall every hour from departure, and where the trip ends', () => {
    const end = plannedArrivals(long())[0]!
    expect(checkpoints(long(), 't1')).toEqual([
      { trip: 't1', index: 0, at: NOW + CHECKPOINT_INTERVAL_MS, end: false },
      { trip: 't1', index: 1, at: NOW + 2 * CHECKPOINT_INTERVAL_MS, end: false },
      { trip: 't1', index: 2, at: NOW + 3 * CHECKPOINT_INTERVAL_MS, end: false },
      { trip: 't1', index: 3, at: end, end: true },
    ])
  })

  test('a trip turned elsewhere ends where it turned, and keeps the checkpoints it had passed', () => {
    const before = checkpoints(long(), 't1')
    const turnedAt = NOW + 90 * MIN
    const turned = redirect(long(), { lat: 48.7, lng: 9.1 }, CAUTIOUS, turnedAt, 't2')!
    const after = checkpoints(turned, 't1')

    // The half hour after the last full one is still weighed: turning away is
    // not a way to slip past a checkpoint.
    expect(after).toEqual([before[0]!, { trip: 't1', index: 1, at: turnedAt, end: true }])
    expect(checkpoints(turned, 't2')[0]!.at).toBe(turnedAt + CHECKPOINT_INTERVAL_MS)
  })

  test('a stopped trip ends where it stopped', () => {
    const stoppedAt = NOW + 30 * MIN
    expect(checkpoints(stop(long(), stoppedAt)!, 't1')).toEqual([{ trip: 't1', index: 0, at: stoppedAt, end: true }])
  })

  test('a detour is the same trip, still counted from where it set off', () => {
    const detoured = detour(long(), { lat: 48.8, lng: 9.25 }, NOW + 20 * MIN)!
    const marks = checkpoints(detoured, 't1')
    expect(marks.slice(0, 2).map((mark) => mark.at)).toEqual([NOW + CHECKPOINT_INTERVAL_MS, NOW + 2 * CHECKPOINT_INTERVAL_MS])
    expect(marks.at(-1)!.at).toBe(plannedArrivals(detoured).at(-1)!)
  })

  test('a trip the route does not contain has none', () => {
    expect(checkpoints(long(), 'elsewhere')).toEqual([])
  })
})
