import { describe, expect, test } from 'bun:test'
import { ENCOUNTER } from '../src/config'
import { firstContact } from '../src/core/Meetings'
import { distanceKm, positionAt, type LatLng, type PastWaypoint, type Waypoint } from '../src/core/Travel'
import type { EncounterEntry } from '../src/game/Encounter'
import type { JsonRpcNotification } from '../src/game/JsonRpc'
import { RPC_ERRORS, type Squad } from '../src/game/Rpc'
import type { MeetingContact, MeetingOpened, OpenMeeting } from '../src/server/EncounterPort'
import { Journeys } from '../src/server/Journeys'
import type { Persistence } from '../src/server/Persistence'
import { Schedule } from '../src/server/Schedule'
import { freshPersistence } from './support/db'
import { registerAt, rpcServer, type RpcServer, type Window } from './support/rpcServer'

/**
 * Two players' squads on the road (`ITEM-053`, GDD-WORLD §5.5): the moment
 * they come within a kilometre is found when a route is written, found again
 * when it falls due, and what comes of it — both squads stopped where they
 * stood, both feeds, nothing at all when a squad is busy or the trial switch
 * is off. The lobby is not here: `openMeeting` is a fake that answers as the
 * lobby would (`tests/meetingRooms.test.ts` has the lobby).
 */

const MIN = 60_000
const HOUR = 60 * MIN
const RANGE = ENCOUNTER.meetingRangeKm

const ORIGIN: LatLng = { lat: 48.1, lng: 11.5 }
const north = (from: LatLng, km: number): LatLng => ({ lat: from.lat + km / 111.2, lng: from.lng })
const east = (from: LatLng, km: number): LatLng => ({
  lat: from.lat,
  lng: from.lng + km / (111.2 * Math.cos((from.lat * Math.PI) / 180)),
})

const OPENED: MeetingOpened = { opened: true, roomId: 'room-1', blueJoinBy: null, redJoinBy: null }

interface Walker {
  name: string
  window: Window
  id: string
  squadId: string
}

interface Call {
  meeting: MeetingContact
  /** The two routes as they were stored when the lobby was asked. */
  routes: Record<string, readonly Waypoint[]>
}

interface World {
  persistence: Persistence
  server: RpcServer
  ada: Walker
  bo: Walker
  calls: Call[]
  /** What the fake lobby answers. */
  answer: MeetingOpened
  /** The trial switch. */
  on: boolean
  go(who: Walker, to: LatLng, pace?: 'cautious' | 'normal' | 'flatOut'): Promise<Squad>
  order(who: Walker, order: Record<string, unknown>): Promise<Squad>
  squad(who: Walker): Promise<Squad>
  feed(who: Walker): Promise<EncounterEntry[]>
  /** What the schedule would say now about the two squads' first meeting, from the clock. */
  expected(): Promise<{ at: number; place: LatLng } | null>
  /** Every `squad/changed` pushed to `who`, in order. */
  changed(who: Walker): Squad[]
  /** Run the clock to `at` and let the alarm go off. */
  wakeAt(at: number): Promise<void>
}

const restingAt = (squad: Squad): PastWaypoint => squad.waypoints.at(-1) as PastWaypoint

/**
 * Ada at `ORIGIN` and Bo 20 km north of it, both registered and resting, over
 * one database; a lobby that answers `answer` to whatever meets.
 */
async function world({ on = true, answer = OPENED }: { on?: boolean; answer?: MeetingOpened } = {}): Promise<World> {
  const persistence = await freshPersistence(':memory:')
  const calls: Call[] = []
  const state = { answer, on }
  const open: OpenMeeting = async (meeting) => {
    const routes: Call['routes'] = {}
    for (const side of [meeting.blue, meeting.red]) routes[side.squadId] = (await persistence.squads.of(side.player.id))!.waypoints
    calls.push({ meeting, routes })
    return state.answer
  }
  const server = rpcServer(persistence, undefined, { openMeeting: open, playerEncounters: () => state.on })

  const ada = await registerAt(server, persistence, 'Ada', ORIGIN)
  const bo = await registerAt(server, persistence, 'Bo', north(ORIGIN, 20))

  const order = async (who: Walker, body: Record<string, unknown>) =>
    (await who.window.call('tictac/api/squad/order', { order: body })).result.squad as Squad
  const squad = async (who: Walker) => (await persistence.squads.of(who.id))!

  return {
    persistence,
    server,
    ada,
    bo,
    calls,
    get answer() {
      return state.answer
    },
    set answer(next: MeetingOpened) {
      state.answer = next
    },
    get on() {
      return state.on
    },
    set on(next: boolean) {
      state.on = next
    },
    order,
    go: (who, to, pace = 'normal') => order(who, { kind: 'goHere', to, pace }),
    squad,
    feed: async (who) => (await who.window.call('tictac/api/encounter/feed')).result.entries as EncounterEntry[],
    expected: async () =>
      firstContact((await squad(ada)).waypoints, (await squad(bo)).waypoints, server.now, RANGE),
    changed: (who) =>
      who.window.pushes
        .filter((push: JsonRpcNotification) => push.method === 'tictac/api/squad/changed')
        .map((push) => (push.params as { squad: Squad }).squad),
    async wakeAt(at) {
      server.now = at
      await server.wake()
    },
  }
}

/** Both squads walking for the point between them: the routes cross about 1.9 h in. */
async function converging(w: World): Promise<{ at: number; place: LatLng }> {
  const middle = north(ORIGIN, 10)
  await w.go(w.ada, middle)
  await w.go(w.bo, middle)
  const meeting = await w.expected()
  expect(meeting).not.toBeNull()
  return meeting!
}

describe('Two squads whose routes cross', () => {
  test('meet at the computed moment, and both stop where they stood', async () => {
    const w = await world()
    const start = w.server.now
    const expected = await converging(w)
    const before = { ada: await w.squad(w.ada), bo: await w.squad(w.bo) }
    // 20 km apart and closing at 10 km/h: within a kilometre after 1.9 hours.
    expect(expected.at).toBeCloseTo(start + 1.9 * HOUR, -3)

    // Not a moment before it.
    await w.wakeAt(expected.at - 1)
    expect(w.calls).toHaveLength(0)

    await w.wakeAt(expected.at)
    expect(w.calls).toHaveLength(1)
    const { meeting, routes } = w.calls[0]!
    expect(meeting.at).toBe(expected.at)
    expect(meeting.place).toEqual(expected.place)
    expect([meeting.blue.player.name, meeting.red.player.name].sort()).toEqual(['Ada', 'Bo'])
    expect([meeting.blue.squadId, meeting.red.squadId].sort()).toEqual([w.ada.squadId, w.bo.squadId].sort())
    expect([meeting.blue.standing, meeting.red.standing]).toEqual(['stand', 'stand'])
    // The fight is opened first, on the routes as they were: the lobby is told
    // before either squad has been stopped.
    for (const route of Object.values(routes)) expect(route.at(-1)!.kind).toBe('future')

    // Both stopped, each where the old route had it at that moment.
    const [ada, bo] = [await w.squad(w.ada), await w.squad(w.bo)]
    for (const [now, was, who] of [
      [ada, before.ada, 'Ada'],
      [bo, before.bo, 'Bo'],
    ] as const) {
      const there = positionAt(was.waypoints, expected.at).position
      expect(restingAt(now), who).toMatchObject({ kind: 'past', arrival: expected.at, departed: null })
      expect(restingAt(now).lat).toBeCloseTo(there.lat, 9)
      expect(restingAt(now).lng).toBeCloseTo(there.lng, 9)
    }
    // A kilometre apart, which is what a meeting is.
    expect(distanceKm(restingAt(ada), restingAt(bo))).toBeCloseTo(RANGE, 2)

    // Both are told their squad stopped, and both feeds say who they met.
    for (const who of [w.ada, w.bo]) {
      expect(restingAt(w.changed(who).at(-1)!)).toMatchObject({ arrival: expected.at, departed: null })
    }
    for (const [who, other] of [
      [w.ada, 'Bo'],
      [w.bo, 'Ada'],
    ] as const) {
      const entries = await w.feed(who)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        at: expected.at,
        result: 'inProgress',
        passedFor: null,
        playedBy: 'ai',
        matchId: 'room-1',
        aliens: 0,
        against: other,
      })
      expect(entries[0]!.place.lat).toBeCloseTo(expected.place.lat, 5)
      expect(entries[0]!.place.lng).toBeCloseTo(expected.place.lng, 5)
    }

    // Nothing more happens to a pair that stands where it fought.
    await w.wakeAt(start + 10 * HOUR)
    expect(w.calls).toHaveLength(1)
  })

  test('meet a squad at rest, which is met and not moved', async () => {
    const w = await world()
    const start = w.server.now
    await w.go(w.bo, ORIGIN)
    const waiting = await w.squad(w.ada)
    const expected = (await w.expected())!
    // 20 km at 5 km/h, to within a kilometre.
    expect(expected.at).toBeCloseTo(start + 3.8 * HOUR, -4)

    await w.wakeAt(expected.at)
    expect(w.calls).toHaveLength(1)
    expect(await w.squad(w.ada)).toEqual(waiting)
    expect(w.changed(w.ada)).toEqual([])
    expect(restingAt(await w.squad(w.bo))).toMatchObject({ arrival: expected.at, departed: null })
    expect(await w.feed(w.ada)).toHaveLength(1)
    expect(await w.feed(w.bo)).toHaveLength(1)
  })

  test('are Blue and Red by the pair and the moment, so neither the one who moved nor the one who waited is always Blue', async () => {
    // Thirty-two pairs, each a squad walking at one that waits, with ids the
    // test picks so the answer is always the same.
    const persistence = await freshPersistence(':memory:')
    const calls: MeetingContact[] = []
    const server = rpcServer(persistence, undefined, {
      openMeeting: async (meeting) => {
        calls.push(meeting)
        return OPENED
      },
    })
    const movers = new Set<string>()
    for (let i = 0; i < 32; i++) {
      const spot = east(ORIGIN, i * 40)
      for (const [suffix, at] of [
        ['mover', north(spot, 8 + i * 0.37)],
        ['waiter', spot],
      ] as const) {
        const id = `${i}-${suffix}`
        await persistence.db.query`INSERT INTO players (id, name, created_at) VALUES (${id}, ${id}, ${'2026-01-01T00:00:00Z'})`
        const resting: PastWaypoint = { kind: 'past', ...at, arrival: server.now, departed: null }
        await persistence.db.query`INSERT INTO squads (id, player_id, waypoints, start_lat_e6, start_lng_e6, created_at)
          VALUES (${`squad-${id}`}, ${id}, ${JSON.stringify([resting])}, 0, 0, ${'2026-01-01T00:00:00Z'})`
        if (suffix === 'mover') movers.add(`squad-${id}`)
      }
      await server.journeys.order(`${i}-mover`, null, { kind: 'goHere', to: spot, pace: 'normal' })
    }
    await server.wake()
    server.now += 12 * HOUR
    await server.wake()

    expect(calls).toHaveLength(32)
    const moverBlue = calls.filter((meeting) => movers.has(meeting.blue.squadId)).length
    expect(moverBlue).toBeGreaterThan(8)
    expect(moverBlue).toBeLessThan(24)
  })
})

describe('A route changed before the meeting', () => {
  test('that takes a squad away cancels it', async () => {
    const w = await world()
    const start = w.server.now
    const planned = await converging(w)

    // An hour in, Ada turns and goes off east.
    await w.wakeAt(start + HOUR)
    await w.order(w.ada, { kind: 'goHereNow', to: east(ORIGIN, 40), pace: 'normal' })
    expect(await w.expected()).toBeNull()

    await w.wakeAt(planned.at)
    await w.wakeAt(start + 12 * HOUR)
    expect(w.calls).toEqual([])
    expect(await w.feed(w.ada)).toEqual([])
    expect(await w.feed(w.bo)).toEqual([])
  })

  test('that brings a squad closer moves it to the new moment, and the old one no longer happens', async () => {
    const w = await world()
    const start = w.server.now
    const planned = await converging(w)

    // Half an hour in, Ada is told to run for a point further on: she and Bo
    // close faster than they were going to.
    await w.wakeAt(start + 30 * MIN)
    await w.order(w.ada, { kind: 'goHereNow', to: north(ORIGIN, 16), pace: 'flatOut' })
    const moved = (await w.expected())!
    expect(moved.at).toBeLessThan(planned.at)

    await w.wakeAt(moved.at - 1)
    expect(w.calls).toHaveLength(0)
    await w.wakeAt(moved.at)
    expect(w.calls.map((call) => call.meeting.at)).toEqual([moved.at])

    // The moment it had before is gone with the route that made it.
    await w.wakeAt(planned.at + HOUR)
    expect(w.calls).toHaveLength(1)
  })

  test('that stops a squad moves it: the one still walking meets the one who stopped, where they stopped', async () => {
    const w = await world()
    const start = w.server.now
    // Head on, they would meet 1.9 hours in; Ada is going on past Bo's start.
    await w.go(w.ada, north(ORIGIN, 25))
    await w.go(w.bo, ORIGIN)
    const planned = (await w.expected())!

    // An hour in, Bo is 5 km south and stops. Ada, 5 km north, has 9 km to go.
    await w.wakeAt(start + HOUR)
    await w.order(w.bo, { kind: 'stop' })
    const moved = (await w.expected())!
    expect(moved.at).toBeCloseTo(start + 2.8 * HOUR, -4)
    expect(moved.at).toBeGreaterThan(planned.at)

    await w.wakeAt(planned.at)
    expect(w.calls).toEqual([])
    await w.wakeAt(moved.at)
    expect(w.calls.map((call) => call.meeting.at)).toEqual([moved.at])
    // Bo was stopped already and is not stopped again: he is where he was an hour in.
    expect(restingAt(await w.squad(w.bo))).toMatchObject({ arrival: start + HOUR, departed: null })
    expect(restingAt(await w.squad(w.ada))).toMatchObject({ arrival: moved.at, departed: null })
  })
})

describe('A meeting that does not happen', () => {
  test.each([
    ['busy', { opened: false, passedFor: 'busy' }],
    ['nobodyFit', { opened: false, passedFor: 'nobodyFit' }],
  ] as const)('because a squad is %s is recorded for nobody, and both squads carry on', async (_why, answer) => {
    const w = await world({ answer })
    const start = w.server.now
    const planned = await converging(w)
    const routes = { ada: await w.squad(w.ada), bo: await w.squad(w.bo) }
    const told = { ada: w.changed(w.ada).length, bo: w.changed(w.bo).length }

    await w.wakeAt(planned.at)
    expect(w.calls).toHaveLength(1)

    // Passed in the night: no feed, no stop, no push, and no second try.
    expect(await w.feed(w.ada)).toEqual([])
    expect(await w.feed(w.bo)).toEqual([])
    expect(await w.squad(w.ada)).toEqual(routes.ada)
    expect(await w.squad(w.bo)).toEqual(routes.bo)
    expect([w.changed(w.ada).length, w.changed(w.bo).length]).toEqual([told.ada, told.bo])
    await w.wakeAt(planned.at + 1)
    expect(w.calls).toHaveLength(1)

    // They go on to where they were going.
    await w.wakeAt(start + 3 * HOUR)
    for (const who of [w.ada, w.bo]) {
      expect(restingAt(await w.squad(who))).toMatchObject({ departed: null })
    }
    expect(w.calls).toHaveLength(1)
  })

  test('is the trial switch’s to stop: nothing is scheduled while it is off, and what is pending does nothing', async () => {
    const w = await world({ on: false })
    const start = w.server.now
    const planned = await converging(w)

    // Off when the routes were written: nothing was scheduled, so nothing fires.
    await w.wakeAt(planned.at)
    expect(w.calls).toEqual([])

    // On again: the next route written finds it.
    w.on = true
    await w.wakeAt(start + 15 * MIN)
    await w.order(w.ada, { kind: 'goHereNow', to: north(ORIGIN, 10), pace: 'normal' })
    const found = (await w.expected())!
    await w.wakeAt(found.at)
    expect(w.calls).toHaveLength(1)
  })

  test('is also read when it fires: one scheduled while on, switched off before its moment, does nothing and is gone', async () => {
    const w = await world()
    const planned = await converging(w)

    w.on = false
    await w.wakeAt(planned.at)
    expect(w.calls).toEqual([])
    expect(await w.feed(w.ada)).toEqual([])
    const ada = await w.squad(w.ada)
    expect(ada.waypoints.at(-1)!.kind).toBe('future')

    w.on = true
    await w.wakeAt(planned.at + 1)
    expect(w.calls).toEqual([])
  })

  test('and switched off and on again before its moment, still happens', async () => {
    const w = await world()
    const planned = await converging(w)
    w.on = false
    w.on = true
    await w.wakeAt(planned.at)
    expect(w.calls).toHaveLength(1)
  })
})

describe('A pair that has just fought', () => {
  test('does not fight again where it stands, and does when one has left range and come back', async () => {
    const w = await world()
    const first = await converging(w)
    await w.wakeAt(first.at)
    expect(w.calls).toHaveLength(1)

    // Standing a kilometre apart, in range: orders that keep Bo here, and a
    // little walk to the side that stays in range, are not a new meeting.
    expect(await w.expected()).toBeNull()
    await w.go(w.ada, east(restingAt(await w.squad(w.ada)), 0.3))
    expect(await w.expected()).toBeNull()
    await w.wakeAt(w.server.now + 2 * HOUR)
    expect(w.calls).toHaveLength(1)

    // Ada walks 6 km off east and then comes back for Bo: that is.
    const adaNow = restingAt(await w.squad(w.ada))
    await w.go(w.ada, east(adaNow, 6))
    await w.order(w.ada, { kind: 'goHereNext', to: restingAt(await w.squad(w.bo)) })
    const again = (await w.expected())!
    expect(again).not.toBeNull()
    expect(again.at).toBeGreaterThan(w.server.now + HOUR)

    await w.wakeAt(again.at - 1)
    expect(w.calls).toHaveLength(1)
    await w.wakeAt(again.at)
    expect(w.calls).toHaveLength(2)
    expect(w.calls[1]!.meeting.at).toBe(again.at)
    expect(await w.feed(w.ada)).toHaveLength(2)
  })
})

/** A second server over the same database, as after a restart, whose clock reads `clock.now`. */
async function restarted(persistence: Persistence, clock: { now: number }, open: OpenMeeting) {
  const armed: (number | null)[] = []
  const schedule = new Schedule({ now: () => clock.now, arm: (at) => armed.push(at) })
  const journeys = new Journeys({
    squads: persistence.squads,
    encounters: persistence.encounters,
    schedule,
    now: () => clock.now,
    tell: () => {},
    openMeeting: open,
  })
  await journeys.restore()
  return { schedule, armed }
}

describe('A server that restarts', () => {
  const fake = () => {
    const calls: MeetingContact[] = []
    const open: OpenMeeting = async (meeting) => {
      calls.push(meeting)
      return OPENED
    }
    return { calls, open }
  }

  test('finds the meeting a route made again, and holds it at the moment it was going to happen', async () => {
    const w = await world()
    const planned = await converging(w)
    const second = fake()
    const clock = { now: w.server.now }
    const { schedule } = await restarted(w.persistence, clock, second.open)

    clock.now = planned.at - 1
    await schedule.fire()
    expect(second.calls).toEqual([])
    clock.now = planned.at
    await schedule.fire()
    expect(second.calls.map((meeting) => meeting.at)).toEqual([planned.at])
    expect(await w.feed(w.ada)).toHaveLength(1)
  })

  test('does not find a pair that is already within range, or one that fought before it went down', async () => {
    const w = await world()
    const planned = await converging(w)
    await w.wakeAt(planned.at)
    expect(w.calls).toHaveLength(1)

    const second = fake()
    const clock = { now: planned.at + 5 * MIN }
    const { schedule, armed } = await restarted(w.persistence, clock, second.open)
    clock.now += 10 * HOUR
    await schedule.fire()
    expect(second.calls).toEqual([])
    expect(armed.at(-1)).toBeNull()
  })

  test('writes down a meeting once: one that was handled before the restart is not opened a second time, only its halt is made sure of', async () => {
    const w = await world()
    const planned = await converging(w)
    const first = (await w.squad(w.ada)).id

    // The server went down after the room opened and both rows were written,
    // before either squad was saved.
    const pair = [w.ada.squadId, w.bo.squadId].sort().join('|')
    for (const [who, other] of [
      [w.ada, w.bo],
      [w.bo, w.ada],
    ] as const) {
      await w.persistence.encounters.record({
        squadId: who.squadId,
        playerId: who.id,
        trip: `${pair}@${planned.at}`,
        checkpoint: 0,
        at: planned.at,
        place: planned.place,
        aliens: 0,
        roomId: 'room-9',
        passedFor: null,
        opponentPlayerId: other.id,
      })
    }
    expect(first).toBe(w.ada.squadId)

    await w.wakeAt(planned.at)
    expect(w.calls).toEqual([])
    for (const who of [w.ada, w.bo]) expect(restingAt(await w.squad(who))).toMatchObject({ arrival: planned.at, departed: null })
    expect(await w.feed(w.ada)).toHaveLength(1)
  })
})

describe('A squad’s standing order', () => {
  test('is stand until it is set, is set by squad/standing, comes back in the squad, and survives the route being written', async () => {
    const w = await world()
    expect((await w.ada.window.call('tictac/api/squad/get')).result.squad).toMatchObject({ standing: 'stand' })

    const set = await w.ada.window.call('tictac/api/squad/standing', { order: 'evade' })
    expect(set.code).toBeNull()
    expect(set.result.squad).toMatchObject({ id: w.ada.squadId, standing: 'evade' })
    expect(w.changed(w.ada).at(-1)).toMatchObject({ standing: 'evade' })
    expect((await w.squad(w.ada)).standing).toBe('evade')
    // Another player's is theirs.
    expect((await w.squad(w.bo)).standing).toBe('stand')

    // An order, an arrival and a halt each write the route, and none of them the standing.
    const ordered = await w.go(w.ada, north(ORIGIN, 1))
    expect(ordered.standing).toBe('evade')
    await w.wakeAt(w.server.now + 2 * HOUR)
    expect((await w.squad(w.ada)).standing).toBe('evade')

    const back = await w.ada.window.call('tictac/api/squad/standing', { order: 'stand' })
    expect(back.result.squad).toMatchObject({ standing: 'stand' })
    expect((await w.ada.window.call('tictac/api/squad/get')).result.squad).toMatchObject({ standing: 'stand' })
  })

  test('is told to the lobby as each side’s order when a meeting opens', async () => {
    const w = await world()
    await w.ada.window.call('tictac/api/squad/standing', { order: 'cautious' })
    await w.bo.window.call('tictac/api/squad/standing', { order: 'opportunist' })
    const planned = await converging(w)
    await w.wakeAt(planned.at)

    const { meeting } = w.calls[0]!
    const orders = Object.fromEntries([meeting.blue, meeting.red].map((side) => [side.player.name, side.standing]))
    expect(orders).toEqual({ Ada: 'cautious', Bo: 'opportunist' })
  })

  test.each([
    ['one that is not a standing order', 'berserk'],
    ['none', undefined],
    ['a number', 3],
    ['an object', { kind: 'stand' }],
    ['a name from the prototype', 'constructor'],
  ])('refuses %s, and changes nothing', async (_what, order) => {
    const w = await world()
    const answer = await w.ada.window.call('tictac/api/squad/standing', { order })
    expect(answer.code).toBe(RPC_ERRORS.invalidParams)
    expect((await w.squad(w.ada)).standing).toBe('stand')
  })

  test('is for a signed-in player', async () => {
    const w = await world()
    const stranger = w.server.window()
    const answer = await stranger.call('tictac/api/squad/standing', { order: 'evade' })
    expect(answer.code).toBe(RPC_ERRORS.signInFirst)
  })
})
