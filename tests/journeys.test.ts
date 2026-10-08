import { describe, expect, test } from 'bun:test'
import { checkpoints, distanceKm, plannedArrivals, positionAt, type PastWaypoint, type Waypoint } from '../src/core/Travel'
import { RPC_ERRORS, type Squad } from '../src/game/Rpc'
import { Journeys } from '../src/server/Journeys'
import type { Persistence } from '../src/server/Persistence'
import { MAX_SLEEP_MS, Schedule } from '../src/server/Schedule'
import { softwareAuthenticator } from './support/authenticator'
import { freshPersistence } from './support/db'
import { register, rpcServer, type RpcServer, type Window } from './support/rpcServer'

/**
 * Squads on the move (`src/server/Journeys.ts`, `src/server/Schedule.ts`):
 * the five orders over the socket, the one alarm that wakes for arrivals, a
 * restart that picks the schedule back up, and the pushes that tell a window
 * its squad moved. Time is a hand-turned clock; the alarm goes off when the
 * test says, on time or late.
 */

const MIN = 60_000
const HOUR = 60 * MIN

interface Traveller {
  persistence: Persistence
  server: RpcServer
  window: Window
  /** The squad as the server holds it now. */
  squad(): Promise<Squad>
  order(order: Record<string, unknown>): Promise<{ code: number | null; message: string | null; squad: Squad }>
}

/** A registered player near Stuttgart, at rest, with the window they registered on. */
async function traveller(): Promise<Traveller> {
  const persistence = await freshPersistence(':memory:')
  const server = rpcServer(persistence)
  const window = server.window()
  await register(window, await softwareAuthenticator())
  return {
    persistence,
    server,
    window,
    squad: async () => (await window.call('tictac/api/squad/get')).result.squad as Squad,
    order: async (order) => {
      const answer = await window.call('tictac/api/squad/order', { order })
      return { code: answer.code, message: answer.message, squad: answer.result.squad as Squad }
    },
  }
}

/** Where the squad stands at rest. */
const restingAt = (squad: Squad): PastWaypoint => squad.waypoints.at(-1) as PastWaypoint

/** A point `km` north of `from`. */
const north = (from: { lat: number; lng: number }, km: number) => ({ lat: from.lat + km / 111.2, lng: from.lng })

describe('The five orders', () => {
  test('go here sets off at the pace given; go here again is refused while moving', async () => {
    const { order, squad } = await traveller()
    const home = restingAt(await squad())

    const sent = await order({ kind: 'goHere', to: north(home, 5), pace: 'flatOut' })
    expect(sent.code).toBeNull()
    expect((sent.squad.waypoints.at(-2) as PastWaypoint).departed?.gait).toEqual({ mode: 'foot', pace: 'flatOut' })
    expect(sent.squad.waypoints.at(-1)).toEqual({ kind: 'future', ...north(home, 5) })

    const again = await order({ kind: 'goHere', to: north(home, 9), pace: 'normal' })
    expect(again.code).toBe(RPC_ERRORS.conflict)
    expect(again.message).toMatch(/already on the move/)
    expect(await squad()).toEqual(sent.squad)
  })

  test('go here now turns from where it is, on a new trip at the new pace', async () => {
    const { order, squad, server } = await traveller()
    const home = restingAt(await squad())
    const first = await order({ kind: 'goHere', to: north(home, 5), pace: 'cautious' })
    const trip = (first.squad.waypoints.at(-2) as PastWaypoint).departed!.trip
    server.now += 30 * MIN

    const turned = (await order({ kind: 'goHereNow', to: north(home, -5), pace: 'normal' })).squad
    const turn = turned.waypoints.at(-2) as PastWaypoint
    expect(distanceKm(home, turn)).toBeCloseTo(1.5, 6)
    expect(turn.departed?.trip).not.toBe(trip)
    expect(turn.departed?.gait.pace).toBe('normal')
  })

  test('go here first detours on the same trip; go here next adds to the end', async () => {
    const { order, squad, server } = await traveller()
    const home = restingAt(await squad())
    const first = await order({ kind: 'goHere', to: north(home, 5), pace: 'normal' })
    const trip = (first.squad.waypoints.at(-2) as PastWaypoint).departed!.trip
    server.now += 12 * MIN

    const detoured = (await order({ kind: 'goHereFirst', to: { lat: home.lat, lng: home.lng + 0.02 } })).squad
    expect((detoured.waypoints.at(-3) as PastWaypoint).departed?.trip).toBe(trip)
    expect(detoured.waypoints.slice(-2).map((waypoint) => waypoint.kind)).toEqual(['future', 'future'])

    const extended = (await order({ kind: 'goHereNext', to: north(home, 8) })).squad
    expect(extended.waypoints.at(-1)).toEqual({ kind: 'future', ...north(home, 8) })
    expect(extended.waypoints).toHaveLength(detoured.waypoints.length + 1)
  })

  test('stop rests the squad where it is; at rest, every verb but go here is refused', async () => {
    const { order, squad, server } = await traveller()
    const home = restingAt(await squad())
    await order({ kind: 'goHere', to: north(home, 5), pace: 'normal' })
    server.now += 30 * MIN

    const stopped = (await order({ kind: 'stop' })).squad
    expect(restingAt(stopped).departed).toBeNull()
    expect(distanceKm(home, restingAt(stopped))).toBeCloseTo(2.5, 3)

    for (const kind of ['stop', 'goHereFirst', 'goHereNext', 'goHereNow']) {
      const refused = await order({ kind, to: north(home, 1), pace: 'normal' })
      expect([kind, refused.code]).toEqual([kind, RPC_ERRORS.conflict])
    }
  })

  test('an order that does not make sense is refused before anything moves', async () => {
    const { order, squad } = await traveller()
    const before = await squad()
    for (const [bad, reason] of [
      [{ kind: 'teleport', to: { lat: 0, lng: 0 } }, /not one a squad takes/],
      [{ kind: 'goHere', to: { lat: 91, lng: 0 }, pace: 'normal' }, /where on the map/],
      [{ kind: 'goHere', to: { lat: 48, lng: 'east' }, pace: 'normal' }, /where on the map/],
      [{ kind: 'goHere', to: { lat: 48, lng: 9 }, pace: 'sprint' }, /how fast/],
    ] as const) {
      const refused = await order(bad)
      expect(refused.code).toBe(RPC_ERRORS.invalidParams)
      expect(refused.message).toMatch(reason)
    }
    expect(await squad()).toEqual(before)
  })

  test('only a signed-in window gives orders', async () => {
    const persistence = await freshPersistence(':memory:')
    const refused = await rpcServer(persistence).window().call('tictac/api/squad/order', { order: { kind: 'stop' } })
    expect(refused.code).toBe(RPC_ERRORS.signInFirst)
  })
})

describe('The alarm', () => {
  test('a trip of hours wakes at most an hour apart, and the arrival is recorded when it was due, not when noticed', async () => {
    const { order, squad, server } = await traveller()
    const home = restingAt(await squad())
    const sent = (await order({ kind: 'goHere', to: north(home, 11), pace: 'cautious' })).squad
    const due = plannedArrivals(sent.waypoints)[0]!
    expect(due - server.now).toBeGreaterThan(3 * HOUR)

    // Every alarm goes off ten minutes late: lateness must not end up in the
    // recorded arrival.
    const wakes: number[] = []
    for (let i = 0; i < 10 && server.armed.at(-1) !== null; i++) {
      const at = server.armed.at(-1)!
      expect(at - server.now).toBeLessThanOrEqual(MAX_SLEEP_MS)
      wakes.push(at)
      server.now = at + 10 * MIN
      await server.wake()
    }

    expect(wakes.at(-1)).toBe(due)
    expect(wakes.slice(0, -1).length).toBeGreaterThanOrEqual(3)
    const arrived = await squad()
    expect(restingAt(arrived)).toMatchObject({ kind: 'past', arrival: due, departed: null })
    expect(server.armed.at(-1)).toBeNull()
  })

  test('a squad arriving somewhere on the way carries on, and the alarm moves to the next stop', async () => {
    const { order, squad, server } = await traveller()
    const home = restingAt(await squad())
    await order({ kind: 'goHere', to: north(home, 1), pace: 'normal' })
    const route = (await order({ kind: 'goHereNext', to: north(home, 2) })).squad
    const [first, second] = plannedArrivals(route.waypoints)

    server.now = first!
    await server.wake()
    const midway = await squad()
    expect((midway.waypoints.at(-2) as PastWaypoint).arrival).toBe(first!)
    expect(server.armed.at(-1)).toBe(second)
  })

  test('the window is told when its squad’s route changes and when it arrives', async () => {
    const { order, squad, server, window } = await traveller()
    const home = restingAt(await squad())
    const sent = (await order({ kind: 'goHere', to: north(home, 1), pace: 'flatOut' })).squad
    const told = () => window.pushes.filter((push) => push.method === 'tictac/api/squad/changed').map((push) => push.params)

    expect(told()).toEqual([{ squad: sent }])
    server.now = plannedArrivals(sent.waypoints)[0]!
    await server.wake()
    expect(told()).toHaveLength(2)
    expect(told()[1]).toEqual({ squad: await squad() })
  })
})

describe('A server that restarts', () => {
  test('rebuilds the schedule from the squads and arms for the earliest; an arrival due while it was down is recorded when it was due', async () => {
    const { order, squad, server, persistence } = await traveller()
    const home = restingAt(await squad())
    const sent = (await order({ kind: 'goHere', to: north(home, 2), pace: 'normal' })).squad
    const due = plannedArrivals(sent.waypoints)[0]!

    // A second squad, further, travelling too: the earliest is still the first's arrival.
    const other = server.window()
    await register(other, await softwareAuthenticator(), 'Other')
    const away = restingAt((await other.call('tictac/api/squad/get')).result.squad as Squad)
    await other.call('tictac/api/squad/order', { order: { kind: 'goHere', to: north(away, 30), pace: 'cautious' } })

    // The process goes; a new one starts over the same database long after the arrival.
    const later = due + 2 * HOUR
    const armed: (number | null)[] = []
    const schedule = new Schedule({ now: () => later, arm: (at) => armed.push(at) })
    const restarted = new Journeys({ squads: persistence.squads, schedule, now: () => later, tell: () => {} })
    await restarted.restore()
    expect(armed.at(-1)).toBe(due)

    await schedule.fire()
    const settled = (await persistence.squads.byId(sent.id))!.squad
    expect(restingAt(settled)).toMatchObject({ arrival: due, departed: null })
    expect(armed.at(-1)).not.toBeNull()
    expect(armed.at(-1)! - later).toBeLessThanOrEqual(MAX_SLEEP_MS)
  })
})

describe('Checkpoints stay where they were', () => {
  test('a route the server wrote has the same checkpoints the core says it has', async () => {
    // The scheduler records arrivals at their due times, so a trip's
    // checkpoints read off the stored route never move after the fact.
    const { order, squad, server } = await traveller()
    const home = restingAt(await squad())
    const sent = (await order({ kind: 'goHere', to: north(home, 11), pace: 'cautious' })).squad
    const trip = (sent.waypoints.at(-2) as PastWaypoint).departed!.trip
    const planned = checkpoints(sent.waypoints, trip)

    while (server.armed.at(-1) !== null) {
      server.now = server.armed.at(-1)! + 5 * MIN
      await server.wake()
    }
    const recorded = (await squad()).waypoints as Waypoint[]
    expect(checkpoints(recorded, trip)).toEqual(planned)
    expect(positionAt(recorded, server.now).travelling).toBe(false)
  })
})
