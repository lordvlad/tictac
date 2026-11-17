import { describe, expect, spyOn, test } from 'bun:test'
import { rollEncounter } from '../src/core/Encounters'
import { firstContact } from '../src/core/Meetings'
import { ENCOUNTER } from '../src/config'
import type { LatLng, PastWaypoint } from '../src/core/Travel'
import type { Squad } from '../src/wire/Rpc'
import { WALL_CLOCK } from '../src/server/Clock'
import { Batch, type Db } from '../src/server/db/Db'
import type { Persistence } from '../src/server/Persistence'
import { regionStoreOverDb } from '../src/server/RegionStore'
import { softwareAuthenticator } from './support/authenticator'
import { DATABASE_URLS, freshPersistence } from './support/db'
import { seedContact } from './support/encounters'
import { handClock, type HandClock } from './support/handServer'
import { register, registerAt, rpcServer, type RpcServer } from './support/rpcServer'

/**
 * A contact is written down before the fight it calls for is opened
 * (`Encounters.begin`), and a server that dies anywhere in between finds it
 * again and opens nothing twice (tictac-uqt.18).
 */

const MIN = 60_000
const HOUR = 60 * MIN
const ORIGIN: LatLng = { lat: 48.1, lng: 11.5 }
const north = (from: LatLng, km: number): LatLng => ({ lat: from.lat + km / 111.2, lng: from.lng })

describe.each(DATABASE_URLS)('The record of a contact on %s', (url) => {
  /** A player and a squad for the rows to name, since both are foreign keys. */
  async function people(persistence: Persistence, count = 2) {
    const named: { id: string; squadId: string }[] = []
    for (let i = 0; i < count; i++) {
      const id = `p${i}`
      await persistence.accounts.db.query`INSERT INTO players (id, name, created_at) VALUES (${id}, ${`Player ${i}`}, ${new Date(0).toISOString()})`
      named.push({ id, squadId: (await persistence.region.squads.place(id, null)).id })
    }
    return named
  }

  const intent = (who: { id: string; squadId: string }, over: { trip?: string; opponentPlayerId?: string } = {}) => ({
    squadId: who.squadId,
    playerId: who.id,
    trip: over.trip ?? 'trip',
    checkpoint: 0,
    at: 5,
    place: ORIGIN,
    opponentPlayerId: over.opponentPlayerId,
  })

  test('begin reserves one room id per contact, and asking again finds the same row, unsettled and unseen', async () => {
    const persistence = await freshPersistence(url)
    const [ada] = await people(persistence)
    const first = await persistence.region.encounters.begin([intent(ada!)])
    const again = await persistence.region.encounters.begin([intent(ada!)])

    expect(first.outcome).toBeNull()
    expect(again).toEqual(first)
    expect(await persistence.region.db.query`SELECT settled, room_id FROM encounters`).toEqual([{ settled: 0, room_id: first.roomId }])
    expect(await persistence.region.encounters.feed(ada!.id, 10)).toEqual([])

    await persistence.region.encounters.settle(first, { roomId: first.roomId, passedFor: null, aliens: 3 })
    const settled = await persistence.region.encounters.begin([intent(ada!)])
    expect(settled.outcome).toEqual({ roomId: first.roomId, passedFor: null, aliens: 3 })
    await persistence.close()
  })

  test('a meeting is begun, settled and discarded for both players together', async () => {
    const persistence = await freshPersistence(url)
    const [ada, bo] = await people(persistence)
    const sides = [intent(ada!, { opponentPlayerId: bo!.id }), intent(bo!, { opponentPlayerId: ada!.id })] as const
    const handling = await persistence.region.encounters.begin(sides)
    expect(handling.ids).toHaveLength(2)
    expect(await persistence.region.db.query`SELECT DISTINCT room_id FROM encounters`).toEqual([{ room_id: handling.roomId }])

    await persistence.region.encounters.discard(handling)
    expect(await persistence.region.db.query`SELECT id FROM encounters`).toEqual([])

    const second = await persistence.region.encounters.begin(sides)
    await persistence.region.encounters.settle(second, { roomId: second.roomId, passedFor: null, aliens: 0 })
    expect(await persistence.region.db.query`SELECT settled FROM encounters`).toEqual([{ settled: 1 }, { settled: 1 }])
    // A settled meeting is not discarded: it happened.
    await persistence.region.encounters.discard(second)
    expect(await persistence.region.db.query`SELECT id FROM encounters`).toHaveLength(2)
    await persistence.close()
  })

  test('a meeting that an older build wrote one side at a time is made whole, not opened again', async () => {
    const persistence = await freshPersistence(url)
    const [ada, bo] = await people(persistence)
    await seedContact(persistence.region.encounters, {
      squadId: ada!.squadId, playerId: ada!.id, trip: 'trip', checkpoint: 0, at: 5, place: ORIGIN,
      aliens: 0, roomId: 'room-9', passedFor: null, opponentPlayerId: bo!.id,
    })

    const handling = await persistence.region.encounters.begin([
      intent(ada!, { opponentPlayerId: bo!.id }),
      intent(bo!, { opponentPlayerId: ada!.id }),
    ])
    expect(handling.outcome).toEqual({ roomId: 'room-9', passedFor: null, aliens: 0 })
    expect(await persistence.region.db.query`SELECT player_id, room_id, settled FROM encounters ORDER BY player_id`).toEqual([
      { player_id: ada!.id, room_id: 'room-9', settled: 1 },
      { player_id: bo!.id, room_id: 'room-9', settled: 1 },
    ])
    await persistence.close()
  })

  test('a seat taken while the contact is still unsettled is kept, because the row was there first', async () => {
    const persistence = await freshPersistence(url)
    const [ada] = await people(persistence)
    const handling = await persistence.region.encounters.begin([intent(ada!)])
    await persistence.region.encounters.markTaken(handling.roomId, ada!.id)
    await persistence.region.encounters.settle(handling, { roomId: handling.roomId, passedFor: null, aliens: 2 })
    expect(await persistence.region.db.query`SELECT played_by_you FROM encounters`).toEqual([{ played_by_you: 1 }])
    await persistence.close()
  })
})

/** What a server that dies after the lobby opened the room, before the contact was settled, leaves behind. */
interface Boot {
  server: RpcServer
  /** How many fights this server opened and then died on. */
  deaths: number
  /** Whether squads on the road roll for aliens: see `boot`. */
  aliens: boolean
}

/**
 * `aliens: false` for a test of a meeting. A squad on the road rolls for
 * aliens at every checkpoint, on its squad id and a trip id that are random
 * unless the test picks them, so a route walked "to meet somebody" is also, in
 * some runs, a route on which aliens find the squad first: the server then
 * dies on that fight as well (`deaths` of 2 or 3, not 1) and opens a second
 * room. That was the flake; a test that is not about aliens has none to roll.
 */
function boot(
  persistence: Persistence,
  clock: HandClock,
  options: { dies: boolean; mintTrip?: () => string; aliens?: boolean },
): Boot {
  const state = { deaths: 0, aliens: options.aliens ?? true } as Boot
  const dying = async <T>(open: Promise<T>): Promise<T> => {
    const opened = await open
    if (!options.dies) return opened
    state.deaths++
    throw new Error('the process died after the room opened')
  }
  state.server = rpcServer(persistence, undefined, {
    openEncounter: state.aliens ? (contact) => dying(state.server.lobby.openEncounter(contact)) : undefined,
    openMeeting: (meeting) => dying(state.server.lobby.openMeeting(meeting)),
    schedule: (fn, ms) => clock.schedule(fn, ms),
    lobby: { rosters: persistence.region.rosters, mapSeed: () => 3 },
    mintTrip: options.mintTrip,
  })
  return state
}

/** A server stopped, and another started over the same database: what a deploy or a crash does. */
async function restart(persistence: Persistence, clock: HandClock, old: Boot): Promise<Boot> {
  await old.server.lobby.idle()
  await old.server.lobby.dispose()
  const next = boot(persistence, clock, { dies: false, aliens: old.aliens })
  await next.server.lobby.restore()
  await next.server.journeys.restore()
  return next
}

/**
 * `db` as a process that dies while committing a room's opening: the match
 * row is written, and the transaction fails before the room row is. A
 * transaction that takes both back leaves neither; two separate writes would
 * leave a match no restart could find (tictac-uqt.29).
 */
function diesAfterTheMatchRow(db: Db): Db {
  return {
    dialect: db.dialect,
    query: db.query.bind(db),
    exec: (statement) => db.exec(statement),
    close: () => db.close(),
    transaction: (batch) => {
      const opening = batch.steps.some((step) => step.kind === 'query' && step.strings.join('?').includes('INTO matches'))
      if (!opening) return db.transaction(batch)
      const dying = new Batch()
      dying.steps.push(...batch.steps, { kind: 'exec', statement: 'DELETE FROM the_process_died_here' })
      return db.transaction(dying)
    },
  }
}

/** A player whose squad is sent on a trip on which `rollEncounter` finds aliens, and the moment the first checkpoint is due. */
async function sendIntoAliens(server: RpcServer, trip: { current: string }) {
  const window = server.window()
  await register(window, await softwareAuthenticator(), 'Ada')
  const me = (await window.call('tictac/api/account/me')).result.player as { id: string } // the reply's shape is fixed by the API
  const home = (await window.call('tictac/api/squad/get')).result.squad as Squad
  for (let n = 0; ; n++) {
    trip.current = `trip-${n}`
    if (rollEncounter({ squad: home.id, trip: trip.current, index: 0 }, { hours: 1, pace: 'normal', danger: 1 }).met) break
  }
  const start = server.now
  const sent = (await window.call('tictac/api/squad/order', { order: { kind: 'goHere', to: north(ORIGIN, 20), pace: 'normal' } })).result.squad as Squad
  expect(sent.waypoints.length).toBeGreaterThan(1)
  return { playerId: me.id, start }
}

describe('A server that dies between opening the room and recording the contact', () => {
  test('opens one fight against aliens, not two, when it comes back', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const persistence = await freshPersistence(':memory:')
    const clock = handClock()
    const trip = { current: '' }
    const first = boot(persistence, clock, { dies: true, mintTrip: () => trip.current })
    const { playerId, start } = await sendIntoAliens(first.server, trip)

    first.server.now = start + 90 * MIN
    await first.server.wake()
    expect(first.deaths).toBe(1)
    await first.server.lobby.idle()

    // What the dead server left: the contact's row, unsettled, and the room it reserved, live.
    const [row] = await persistence.region.db.query<{ settled: number; room_id: string }>`SELECT settled, room_id FROM encounters`
    expect(row!.settled).toBe(0)
    expect((await persistence.region.rooms.live()).map((room) => room.id)).toEqual([row!.room_id])
    expect(await persistence.region.encounters.feed(playerId, 10)).toEqual([])

    const second = await restart(persistence, clock, first)
    second.server.now = start + 90 * MIN
    await second.server.wake()
    await second.server.lobby.idle()

    expect((await persistence.region.rooms.live()).map((room) => room.id)).toEqual([row!.room_id])
    expect(await persistence.region.db.query`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM matches`).toEqual([{ n: 1 }])
    expect(await persistence.region.db.query`SELECT settled, room_id FROM encounters`).toEqual([{ settled: 1, room_id: row!.room_id }])
    expect(await persistence.region.encounters.feed(playerId, 10)).toMatchObject([{ result: 'inProgress', matchId: row!.room_id }])
    // And the halt the fight called for was made.
    const halted = (await persistence.region.squads.of(playerId))!.waypoints.at(-1) as PastWaypoint
    expect(halted).toMatchObject({ kind: 'past', arrival: start + HOUR, departed: null })
    warn.mockRestore()
    await persistence.close()
  }, 60_000)

  test('a fight whose match row landed and room row did not is not lost: the transaction took both back, and the restart opens it once', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const persistence = await freshPersistence(':memory:')
    const clock = handClock()
    const trip = { current: '' }
    // The first server's database dies after the match insert, before the room insert is committed.
    const dying: Persistence = {
      accounts: persistence.accounts,
      region: await regionStoreOverDb(diesAfterTheMatchRow(persistence.region.db), WALL_CLOCK, persistence.accounts.accounts),
      close: async () => {},
    }
    const first = boot(dying, clock, { dies: true, mintTrip: () => trip.current })
    const { playerId, start } = await sendIntoAliens(first.server, trip)

    first.server.now = start + 90 * MIN
    await first.server.wake()
    expect(first.deaths).toBe(1)
    await first.server.lobby.idle()

    // Neither half of the opening survived: a match with no room would be a fight no restart can find.
    expect(await persistence.region.db.query`SELECT id FROM matches`).toEqual([])
    expect(await persistence.region.rooms.live()).toEqual([])
    const [row] = await persistence.region.db.query<{ settled: number; room_id: string }>`SELECT settled, room_id FROM encounters`
    expect(row!.settled).toBe(0)

    const second = await restart(persistence, clock, first)
    second.server.now = start + 90 * MIN
    await second.server.wake()
    await second.server.lobby.idle()

    // The fight was opened once, under the id the contact reserved. Nobody's window is on the new
    // server, so the AI plays both sides at once and the room may already be over: what matters is
    // that the match exists once and is the contact's.
    expect((await persistence.region.matches.recent()).map((match) => match.id)).toEqual([row!.room_id])
    expect(await persistence.region.db.query`SELECT settled, room_id FROM encounters`).toEqual([{ settled: 1, room_id: row!.room_id }])
    expect(await persistence.region.encounters.feed(playerId, 10)).toMatchObject([{ matchId: row!.room_id }])
    warn.mockRestore()
    await persistence.close()
  }, 60_000)

  test('opens one meeting, not two, and writes it for both players or neither', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const persistence = await freshPersistence(':memory:')
    const clock = handClock()
    const first = boot(persistence, clock, { dies: true, aliens: false })
    const ada = await registerAt(first.server, persistence, 'Ada', ORIGIN)
    const bo = await registerAt(first.server, persistence, 'Bo', north(ORIGIN, 20))
    const middle = north(ORIGIN, 10)
    for (const who of [ada, bo]) {
      const sent = await who.window.call('tictac/api/squad/order', { order: { kind: 'goHere', to: middle, pace: 'normal' } })
      expect(sent.code).toBeNull()
    }
    const squads = await Promise.all([ada, bo].map((who) => persistence.region.squads.of(who.id)))
    const found = firstContact(squads[0]!.waypoints, squads[1]!.waypoints, first.server.now, ENCOUNTER.meetingRangeKm)!

    first.server.now = found.at
    await first.server.wake()
    expect(first.deaths).toBe(1)
    await first.server.lobby.idle()

    // Both rows were begun together and neither settled; the room exists once.
    const rows = await persistence.region.db.query<{ settled: number; room_id: string }>`SELECT settled, room_id FROM encounters`
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.room_id)).size).toBe(1)
    expect(rows.map((row) => row.settled)).toEqual([0, 0])
    expect(await persistence.region.encounters.feed(ada.id, 10)).toEqual([])
    expect(await persistence.region.encounters.feed(bo.id, 10)).toEqual([])
    const roomId = rows[0]!.room_id
    expect((await persistence.region.rooms.live()).map((room) => room.id)).toEqual([roomId])

    const second = await restart(persistence, clock, first)
    second.server.now = found.at
    await second.server.wake()
    await second.server.lobby.idle()

    expect((await persistence.region.rooms.live()).map((room) => room.id)).toEqual([roomId])
    expect(await persistence.region.db.query`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM matches`).toEqual([{ n: 1 }])
    expect(await persistence.region.db.query`SELECT settled, room_id FROM encounters`).toEqual([
      { settled: 1, room_id: roomId },
      { settled: 1, room_id: roomId },
    ])
    for (const [who, other] of [
      [ada, 'Bo'],
      [bo, 'Ada'],
    ] as const) {
      expect(await persistence.region.encounters.feed(who.id, 10)).toMatchObject([{ result: 'inProgress', matchId: roomId, against: other }])
    }
    for (const who of [ada, bo]) {
      const squad = (await persistence.region.squads.of(who.id))!
      expect(squad.waypoints.at(-1)).toMatchObject({ kind: 'past', arrival: found.at, departed: null })
    }
    warn.mockRestore()
    await persistence.close()
  }, 60_000)
})
