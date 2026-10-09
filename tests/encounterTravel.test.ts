import { describe, expect, test } from 'bun:test'
import { ENCOUNTER, Faction } from '../src/config'
import { dealAliens, rollEncounter, stretchOf } from '../src/core/Encounters'
import { checkpoints, positionAt, type PastWaypoint, type Waypoint } from '../src/core/Travel'
import type { Pace } from '../src/core/Travel'
import type { EncounterEntry } from '../src/game/Encounter'
import { RECORDING_VERSION, type RecordingHeader } from '../src/game/Recording'
import { RPC_ERRORS, type Squad } from '../src/game/Rpc'
import type { EncounterContact, EncounterOpened, OpenEncounter } from '../src/server/EncounterPort'
import { Journeys } from '../src/server/Journeys'
import type { Persistence } from '../src/server/Persistence'
import { Schedule } from '../src/server/Schedule'
import { softwareAuthenticator } from './support/authenticator'
import { freshPersistence } from './support/db'
import { register, rpcServer, type RpcServer, type Window } from './support/rpcServer'

/**
 * What the road does to a travelling squad (`ITEM-048`): checkpoints rolled
 * at the moment they were due, a contact that halts the squad or is passed
 * by, a checkpoint handled once across a restart, the feed and the recording
 * a player is let into. The lobby is not here: `openEncounter` is a fake that
 * answers as the lobby would.
 */

const MIN = 60_000
const HOUR = 60 * MIN

const north = (from: { lat: number; lng: number }, km: number) => ({ lat: from.lat + km / 111.2, lng: from.lng })

/** A trip id whose checkpoints `0..want.length-1` (whole hours) meet or not as `want` says. */
function tripWhere(squad: string, pace: Pace, want: boolean[]): string {
  for (let n = 0; n < 100_000; n++) {
    const trip = `trip-${n}`
    const matches = want.every(
      (met, index) => rollEncounter({ squad, trip, index }, { hours: 1, pace, danger: 1 }).met === met,
    )
    if (matches) return trip
  }
  throw new Error('no trip with that pattern of contacts')
}

interface Contacts {
  /** Every contact the server asked to open, with the route it was stored as at that moment. */
  calls: { contact: EncounterContact; route: readonly Waypoint[] }[]
  open: OpenEncounter
}

/** An `openEncounter` that answers every contact with `answer`, and notes what the server held when asked. */
function contacts(persistence: Persistence, answer: EncounterOpened): Contacts {
  const calls: Contacts['calls'] = []
  return {
    calls,
    open: async (contact) => {
      const squad = await persistence.squads.of(contact.player.id)
      calls.push({ contact, route: squad!.waypoints })
      return answer
    },
  }
}

const PASSED: EncounterOpened = { opened: false, passedFor: 'busy' }
const FOUGHT: EncounterOpened = { opened: true, roomId: 'room-1', aliens: 3, joinBy: null }

interface Walker {
  persistence: Persistence
  server: RpcServer
  window: Window
  playerId: string
  squadId: string
  home: PastWaypoint
  /** Gives the squad an order, minting `trip` for it. */
  order(order: Record<string, unknown>): Promise<Squad>
  feed(): Promise<EncounterEntry[]>
}

/** A registered player at rest, whose next trip is `trip`, and what answers a contact. */
async function walker(trip: (squadId: string) => string, answer: (persistence: Persistence) => Contacts): Promise<Walker & { contacts: Contacts }> {
  const persistence = await freshPersistence(':memory:')
  const found = answer(persistence)
  let next = ''
  const server = rpcServer(persistence, undefined, { openEncounter: found.open, mintTrip: () => next })
  const window = server.window()
  await register(window, await softwareAuthenticator())
  const playerId = ((await window.call('tictac/api/account/me')).result.player as { id: string }).id
  const start = (await window.call('tictac/api/squad/get')).result.squad as Squad
  next = trip(start.id)
  return {
    persistence,
    server,
    window,
    playerId,
    squadId: start.id,
    home: start.waypoints.at(-1) as PastWaypoint,
    contacts: found,
    order: async (order) => (await window.call('tictac/api/squad/order', { order })).result.squad as Squad,
    feed: async () => (await window.call('tictac/api/encounter/feed')).result.entries as EncounterEntry[],
  }
}

const restingAt = (squad: Squad): PastWaypoint => squad.waypoints.at(-1) as PastWaypoint

describe('Checkpoints in time order', () => {
  test('a late alarm rolls every checkpoint at its own moment, each on the route as it was then', async () => {
    let held: Contacts
    const w = await walker(
      (squad) => tripWhere(squad, 'normal', [true, false, true]),
      (persistence) => (held = contacts(persistence, PASSED)),
    )
    // Two legs: the first ends at 1.5 h, between the first and second checkpoints.
    const { server, order, home } = w
    const start = server.now
    await order({ kind: 'goHere', to: north(home, 7.5), pace: 'normal' })
    const sent = await order({ kind: 'goHereNext', to: north(home, 20) })
    const trip = (sent.waypoints.find((waypoint) => waypoint.kind === 'past' && waypoint.departed) as PastWaypoint).departed!.trip
    const all = checkpoints(sent.waypoints, trip)
    const arrivalOfFirstLeg = start + 1.5 * HOUR

    // One alarm, hours late, for everything.
    server.now = start + 10 * HOUR
    await server.wake()

    const expected = all.filter((checkpoint) => {
      const stretch = stretchOf(sent.waypoints, trip, checkpoint.index)!
      return rollEncounter({ squad: w.squadId, trip, index: checkpoint.index }, stretch).met
    })
    expect(expected.length).toBeGreaterThanOrEqual(2)
    expect(held!.calls.map(({ contact }) => contact.checkpoint)).toEqual(expected.map((checkpoint) => checkpoint.index))
    expect(held!.calls.map(({ contact }) => contact.at)).toEqual(expected.map((checkpoint) => checkpoint.at))

    for (const { contact, route } of held!.calls) {
      const key = { squad: w.squadId, trip: contact.trip, index: contact.checkpoint }
      const roll = rollEncounter(key, stretchOf(sent.waypoints, trip, contact.checkpoint)!)
      expect(roll).toMatchObject({ met: true, alienSeed: contact.alienSeed, sizeOffset: contact.sizeOffset })
      const where = positionAt(sent.waypoints, contact.at)
      expect(contact.place.lat).toBeCloseTo(where.position.lat, 9)
      expect(contact.place.lng).toBeCloseTo(where.position.lng, 9)
      // The route was settled only as far as the moment being weighed.
      const recorded = route.filter((waypoint) => waypoint.kind === 'past').length - 1
      expect(recorded).toBe(contact.at < arrivalOfFirstLeg ? 0 : 1)
    }

    // Passed by, so the squad was never halted and has since arrived.
    const final = (await w.window.call('tictac/api/squad/get')).result.squad as Squad
    expect(restingAt(final).departed).toBeNull()
    expect(restingAt(final).arrival).toBe(all.at(-1)!.at)
    expect(server.armed.at(-1)).toBeNull()
  })

  test('a roll that finds nothing changes nothing and writes nothing, and the alarm moves to the next checkpoint', async () => {
    let held: Contacts
    const w = await walker(
      (squad) => tripWhere(squad, 'normal', [false, false, false]),
      (persistence) => (held = contacts(persistence, FOUGHT)),
    )
    const sent = await w.order({ kind: 'goHere', to: north(w.home, 20), pace: 'normal' })
    const start = w.server.now

    w.server.now = start + 70 * MIN
    await w.server.wake()

    expect(held!.calls).toHaveLength(0)
    expect((await w.window.call('tictac/api/squad/get')).result.squad).toEqual(sent)
    expect(w.server.armed.at(-1)).toBe(start + 2 * HOUR)
    expect(await w.feed()).toEqual([])
  })
})

describe('A contact', () => {
  test('halts the squad where it stood when it was found, and tells its window', async () => {
    let held: Contacts
    const w = await walker(
      (squad) => tripWhere(squad, 'normal', [true]),
      (persistence) => (held = contacts(persistence, FOUGHT)),
    )
    const sent = await w.order({ kind: 'goHere', to: north(w.home, 20), pace: 'normal' })
    const start = w.server.now

    // Late: the checkpoint was due at one hour.
    w.server.now = start + 90 * MIN
    await w.server.wake()

    const halted = (await w.window.call('tictac/api/squad/get')).result.squad as Squad
    expect(restingAt(halted)).toMatchObject({ kind: 'past', arrival: start + HOUR, departed: null })
    const where = positionAt(sent.waypoints, start + HOUR).position
    expect(restingAt(halted).lat).toBeCloseTo(where.lat, 9)
    expect(restingAt(halted).lng).toBeCloseTo(where.lng, 9)
    const told = w.window.pushes.filter((push) => push.method === 'tictac/api/squad/changed').map((push) => push.params)
    expect(told.at(-1)).toEqual({ squad: halted })

    expect(held!.calls).toHaveLength(1)
    expect(held!.calls[0]!.contact).toMatchObject({ squadId: w.squadId, checkpoint: 0, at: start + HOUR, player: { id: w.playerId } })
    // Nothing further is scheduled for a halted squad, and nothing more is rolled.
    expect(w.server.armed.at(-1)).toBeNull()
    w.server.now = start + 10 * HOUR
    await w.server.wake()
    expect(held!.calls).toHaveLength(1)

    expect(await w.feed()).toMatchObject([{ result: 'inProgress', matchId: 'room-1', aliens: 3, playedBy: 'ai', passedFor: null, at: start + HOUR }])
  })

  test('that is passed by leaves the squad travelling, and is in the feed with why', async () => {
    const w = await walker(
      (squad) => tripWhere(squad, 'normal', [true, false, false]),
      (persistence) => contacts(persistence, PASSED),
    )
    const sent = await w.order({ kind: 'goHere', to: north(w.home, 20), pace: 'normal' })
    const start = w.server.now

    w.server.now = start + 90 * MIN
    await w.server.wake()

    expect((await w.window.call('tictac/api/squad/get')).result.squad).toEqual(sent)
    expect(w.server.armed.at(-1)).toBe(start + 2 * HOUR)
    expect(await w.feed()).toEqual([
      expect.objectContaining({ result: 'passedBy', passedFor: 'busy', playedBy: null, matchId: null, at: start + HOUR }),
    ])
  })

  test('a stop ends the trip early, and its last stretch is weighed', async () => {
    const w = await walker(
      (squad) => {
        for (let n = 0; n < 100_000; n++) {
          const trip = `short-${n}`
          if (rollEncounter({ squad, trip, index: 0 }, { hours: 0.5, pace: 'normal', danger: 1 }).met) return trip
        }
        throw new Error('no trip')
      },
      (persistence) => contacts(persistence, FOUGHT),
    )
    await w.order({ kind: 'goHere', to: north(w.home, 20), pace: 'normal' })
    const start = w.server.now
    w.server.now = start + 30 * MIN
    const stopped = await w.order({ kind: 'stop' })

    expect(w.contacts.calls).toHaveLength(1)
    expect(w.contacts.calls[0]!.contact).toMatchObject({ checkpoint: 0, at: start + 30 * MIN })
    expect(restingAt(stopped).arrival).toBe(start + 30 * MIN)
  })
})

/** A second server over the same database, as after a restart, whose clock reads `now`. */
async function restarted(persistence: Persistence, now: number, open: OpenEncounter) {
  const armed: (number | null)[] = []
  const schedule = new Schedule({ now: () => now, arm: (at) => armed.push(at) })
  const journeys = new Journeys({
    squads: persistence.squads,
    encounters: persistence.encounters,
    schedule,
    now: () => now,
    tell: () => {},
    openEncounter: open,
  })
  await journeys.restore()
  return { schedule, armed }
}

describe('A server that restarts', () => {
  test('does not open a checkpoint it already handled', async () => {
    const w = await walker(
      (squad) => tripWhere(squad, 'normal', [true, false, false]),
      (persistence) => contacts(persistence, PASSED),
    )
    await w.order({ kind: 'goHere', to: north(w.home, 20), pace: 'normal' })
    const start = w.server.now
    w.server.now = start + 90 * MIN
    await w.server.wake()
    expect(w.contacts.calls.map(({ contact }) => contact.checkpoint)).toEqual([0])

    const second = contacts(w.persistence, PASSED)
    const { schedule } = await restarted(w.persistence, start + 90 * MIN, second.open)
    await schedule.fire()
    expect(second.calls.filter(({ contact }) => contact.checkpoint === 0)).toHaveLength(0)
    expect(await w.feed()).toHaveLength(1)
  })

  test('halts a squad whose fight was written down before the halt was', async () => {
    const w = await walker(
      (squad) => tripWhere(squad, 'normal', [true]),
      (persistence) => contacts(persistence, FOUGHT),
    )
    const sent = await w.order({ kind: 'goHere', to: north(w.home, 20), pace: 'normal' })
    const trip = (sent.waypoints.find((waypoint) => waypoint.kind === 'past' && waypoint.departed) as PastWaypoint).departed!.trip
    const start = w.server.now
    // The server went down after the room opened and the row was written, before the squad was saved.
    await w.persistence.encounters.record({
      squadId: w.squadId,
      playerId: w.playerId,
      trip,
      checkpoint: 0,
      at: start + HOUR,
      place: north(w.home, 5),
      aliens: 3,
      roomId: 'room-9',
      passedFor: null,
    })

    const second = contacts(w.persistence, FOUGHT)
    const { schedule } = await restarted(w.persistence, start + 90 * MIN, second.open)
    await schedule.fire()

    expect(second.calls).toHaveLength(0)
    const halted = (await w.persistence.squads.of(w.playerId))!
    expect(restingAt(halted)).toMatchObject({ arrival: start + HOUR, departed: null })
  })
})

const header = (): RecordingHeader => ({
  version: RECORDING_VERSION,
  seed: 1,
  seedLabel: 'test',
  source: 'live',
  createdAt: new Date(0).toISOString(),
  turnCap: null,
  squads: { [Faction.Blue]: dealAliens(1, 2), [Faction.Red]: dealAliens(2, 2) },
})

/** A match with a result row naming `blue` and `red` (a player id or null), won by `winner`. */
async function settledMatch(persistence: Persistence, id: string, winner: Faction, blue: string | null, red: string | null) {
  await persistence.matches.create(header(), id)
  await persistence.db.query`INSERT INTO match_results (match_id, winner, blue_player, red_player, settled_at)
                             VALUES (${id}, ${winner}, ${blue}, ${red}, ${new Date(0).toISOString()})`
}

describe('The return feed', () => {
  test('is newest first, says how each fight ended and who played it, and is limited', async () => {
    const w = await walker(() => 'unused', (persistence) => contacts(persistence, PASSED))
    const { persistence, playerId, squadId, home } = w
    const place = north(home, 1)
    const row = (checkpoint: number, at: number, roomId: string | null, passedFor: 'busy' | null) =>
      persistence.encounters.record({ squadId, playerId, trip: 't', checkpoint, at, place, aliens: roomId ? 2 : 0, roomId, passedFor })
    await row(0, 1_000, null, 'busy')
    await row(1, 2_000, 'in-progress', null)
    await row(2, 3_000, 'won', null)
    await row(3, 4_000, 'lost', null)
    await settledMatch(persistence, 'won', Faction.Blue, playerId, null)
    await settledMatch(persistence, 'lost', Faction.Red, playerId, null)
    await persistence.encounters.markTaken('won')

    const entries = await w.feed()
    expect(entries.map((entry) => entry.result)).toEqual(['lost', 'won', 'inProgress', 'passedBy'])
    expect(entries.map((entry) => entry.at)).toEqual([4_000, 3_000, 2_000, 1_000])
    expect(entries.map((entry) => entry.playedBy)).toEqual(['ai', 'you', 'ai', null])
    expect(entries.map((entry) => entry.matchId)).toEqual(['lost', 'won', 'in-progress', null])
    expect(entries[3]).toMatchObject({ passedFor: 'busy', aliens: 0 })
    expect(entries[0]!.place.lat).toBeCloseTo(place.lat, 6)
    expect(await persistence.encounters.feed(playerId, 2)).toHaveLength(2)
    expect(ENCOUNTER.feedLimit).toBeGreaterThanOrEqual(entries.length)
  })

  test('a player taking the seat before the row is written is still recorded as having played', async () => {
    const w = await walker(() => 'unused', (persistence) => contacts(persistence, PASSED))
    await w.persistence.encounters.markTaken('quick')
    await w.persistence.encounters.record({
      squadId: w.squadId, playerId: w.playerId, trip: 't', checkpoint: 0, at: 1, place: w.home, aliens: 1, roomId: 'quick', passedFor: null,
    })
    expect((await w.feed())[0]).toMatchObject({ playedBy: 'you' })
  })

  test('shows a player only their own, and only to a signed-in window', async () => {
    const w = await walker(() => 'unused', (persistence) => contacts(persistence, PASSED))
    await w.persistence.encounters.record({
      squadId: w.squadId, playerId: w.playerId, trip: 't', checkpoint: 0, at: 1, place: w.home, aliens: 0, roomId: null, passedFor: 'nobodyFit',
    })
    const other = w.server.window()
    expect((await other.call('tictac/api/encounter/feed')).code).toBe(RPC_ERRORS.signInFirst)
    await register(other, await softwareAuthenticator(), 'Other')
    expect((await other.call('tictac/api/encounter/feed')).result.entries).toEqual([])
    expect(await w.feed()).toHaveLength(1)
  })
})

describe('A recording', () => {
  test('is for the players in the match: its header and events, or a refusal', async () => {
    const w = await walker(() => 'unused', (persistence) => contacts(persistence, PASSED))
    const { persistence, playerId } = w
    const other = w.server.window()
    await register(other, await softwareAuthenticator(), 'Other')
    const otherId = ((await other.call('tictac/api/account/me')).result.player as { id: string }).id

    await settledMatch(persistence, 'settled', Faction.Blue, playerId, otherId)
    await persistence.matches.append('settled', {
      turn: 1,
      faction: Faction.Blue,
      command: { type: 'endTurn' } as never,
    })
    await persistence.matches.create(header(), 'running')
    await persistence.encounters.record({
      squadId: w.squadId, playerId, trip: 't', checkpoint: 0, at: 1, place: w.home, aliens: 2, roomId: 'running', passedFor: null,
    })
    await persistence.matches.create(header(), 'strangers')

    const settled = await w.window.call('tictac/api/match/recording', { matchId: 'settled' })
    expect(settled.code).toBeNull()
    expect(settled.result.recording).toMatchObject({ header: header(), events: [{ seq: 0, turn: 1 }] })
    // Both players of a settled match may watch it back.
    expect((await other.call('tictac/api/match/recording', { matchId: 'settled' })).code).toBeNull()
    // A fight is its player's from the moment it opens, settled or not.
    expect((await w.window.call('tictac/api/match/recording', { matchId: 'running' })).code).toBeNull()

    expect((await other.call('tictac/api/match/recording', { matchId: 'running' })).code).toBe(RPC_ERRORS.notYours)
    expect((await w.window.call('tictac/api/match/recording', { matchId: 'strangers' })).code).toBe(RPC_ERRORS.notYours)
    expect((await w.window.call('tictac/api/match/recording', { matchId: 'nothing-here' })).code).toBe(RPC_ERRORS.gone)
    expect((await w.window.call('tictac/api/match/recording', { matchId: 7 })).code).toBe(RPC_ERRORS.invalidParams)
    expect((await w.window.call('tictac/api/match/recording')).code).toBe(RPC_ERRORS.invalidParams)
    const anonymous = w.server.window()
    expect((await anonymous.call('tictac/api/match/recording', { matchId: 'settled' })).code).toBe(RPC_ERRORS.signInFirst)
  })
})
