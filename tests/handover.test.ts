import { WALL_CLOCK } from '../src/server/Clock'
import { describe, expect, test } from 'bun:test'
import {
  REGIONS,
  SINGLETON_REGION,
  regionDirectory,
  regionMap,
  type RegionPartition,
  type SquadOwners,
} from '../src/server/Owner'
import { HANDOVER_TIMEOUT_MS, HandoverCoordinator } from '../src/server/Handover'
import { RPC_ERRORS } from '../src/wire/Rpc'
import { Refusal } from '../src/server/Lobby'
import { startGameServer } from '../src/server/GameServer'
import { openDb, openPersistence } from '../src/server/db/BunSqlDb'
import { portsOf, type Persistence } from '../src/server/Persistence'
import { type RegionStore, regionStoreOverDb } from '../src/server/RegionStore'
import { heldTokens, ServerConnection } from '../src/game/ServerConnection'
import { softwareAuthenticator } from './support/authenticator'
import { inProcessPeers } from './support/peers'
import { turnedClock } from './support/turnedClock'

const PARTITIONS: RegionPartition[] = [
  {
    id: 'west',
    durableObjectName: 'region-west',
    bounds: { minLat: 45.0, maxLat: 55.0, minLng: 5.0, maxLng: 10.0 },
  },
  {
    id: 'east',
    durableObjectName: 'region-east',
    bounds: { minLat: 45.0, maxLat: 55.0, minLng: 10.001, maxLng: 20.0 },
  },
]

/** Squad keepers a test writes down by hand, as `Squads.setOwner` would. */
function owners(kept: Record<string, string>): SquadOwners & { kept: Record<string, string> } {
  return { kept, ownerOf: async (squadId) => kept[squadId] ?? null }
}

/** A player with a squad in `persistence`, returning the squad's id. */
async function squadIn(persistence: Persistence, playerId: string): Promise<string> {
  return (await persistence.region.enlist(playerId, null)).id
}

describe('Region directory (src/server/Owner.ts)', () => {
  test('the deployed table is one region covering the world', async () => {
    const map = regionMap(REGIONS)
    expect(map.ownerOfPlace({ lat: 48.77, lng: 9.18 })).toBe(SINGLETON_REGION)
    expect(map.ownerOfPlace({ lat: -33.9, lng: 151.2 })).toBe(SINGLETON_REGION)
  })

  test('a place goes to the region whose box holds it, and outside every box to the first', () => {
    const map = regionMap(PARTITIONS)
    // Stuttgart ~ (48.77, 9.18) -> West
    expect(map.ownerOfPlace({ lat: 48.7775, lng: 9.18 })).toBe('region-west')
    // Munich ~ (48.13, 11.58) -> East
    expect(map.ownerOfPlace({ lat: 48.1351, lng: 11.582 })).toBe('region-east')
    expect(map.ownerOfPlace({ lat: 0, lng: 0 })).toBe('region-west')
  })

  test('a table knows the regions it routes to, and nothing else', () => {
    const map = regionMap(PARTITIONS)
    expect(map.isRegion('region-west')).toBe(true)
    expect(map.isRegion('region-east')).toBe(true)
    // The partition's own id is not the name of its object.
    expect(map.isRegion('west')).toBe(false)
    expect(map.isRegion('region-mars')).toBe(false)
  })

  test('a map with no partitions is refused', () => {
    expect(() => regionMap([])).toThrow(/at least one partition/)
  })

  test('a squad belongs to the region last committed, wherever it stands', async () => {
    const kept = owners({ 'squad-west': 'region-west', 'squad-east': 'region-east' })
    const directory = regionDirectory({ owners: kept, partitions: PARTITIONS, self: 'region-west' })
    expect(directory.self).toBe('region-west')
    expect(await directory.ownerOfSquad('squad-west')).toBe('region-west')
    expect(await directory.ownerOfSquad('squad-east')).toBe('region-east')
    expect(await directory.ownerOfSquad('nobody')).toBeNull()

    // A handover commits: the answer follows the row, not a position.
    kept.kept['squad-west'] = 'region-east'
    expect(await directory.ownerOfSquad('squad-west')).toBe('region-east')
  })

  test('every squad row that exists defaults to the singleton region', async () => {
    const persistence = await openPersistence(WALL_CLOCK)
    const squadId = await squadIn(persistence, 'p-old')
    const directory = regionDirectory({ owners: persistence.region.squads })
    expect(await directory.ownerOfSquad(squadId)).toBe(SINGLETON_REGION)
    expect(await directory.ownerOfSquad('no-such-squad')).toBeNull()

    await persistence.region.squads.setOwner(squadId, 'region-east')
    expect(await directory.ownerOfSquad(squadId)).toBe('region-east')
    await persistence.close()
  })

  test('two servers in one process hold different directories', async () => {
    const persistence1 = await openPersistence(WALL_CLOCK, ':memory:', { self: 'region-west' })
    const persistence2 = await openPersistence(WALL_CLOCK)
    const server1 = await startGameServer({
      ...portsOf(persistence1),
      clock: WALL_CLOCK,
      port: 0,
      log: () => {},
      regions: PARTITIONS,
    })
    const server2 = await startGameServer({ ...portsOf(persistence2), clock: WALL_CLOCK, port: 0, log: () => {} })

    expect(server1.directory.self).toBe('region-west')
    expect(server1.directory.ownerOfPlace({ lat: 48.1351, lng: 11.582 })).toBe('region-east')
    expect(server2.directory.self).toBe(SINGLETON_REGION)
    expect(server2.directory.ownerOfPlace({ lat: 48.1351, lng: 11.582 })).toBe(SINGLETON_REGION)

    await server1.stop()
    await server2.stop()
    await persistence1.close()
    await persistence2.close()
  })
})

/** A coordinator for `region`, whose squad store holds `kept` and which writes the owners it commits there. */
function coordinatorFor(region: string, kept: Record<string, string>, clock = turnedClock()) {
  const store = owners(kept)
  const directory = regionDirectory({ owners: store, partitions: PARTITIONS, self: region })
  const squads = { setOwner: async (squadId: string, owner: string) => void (store.kept[squadId] = owner) }
  return { coordinator: new HandoverCoordinator({ clock, directory, squads }), directory, kept: store.kept }
}

const OFFER = {
  handoverId: 'h-1234',
  playerId: 'player-77',
  squadId: 'squad-42',
  sourceRegion: 'region-west',
  targetRegion: 'region-east',
  targetUrl: 'ws://test-east',
  token: 'handover-secret-ticket',
}

describe('HandoverCoordinator 2PC State Machine (src/server/Handover.ts)', () => {
  test('happy path: prepare -> initiate -> arrive -> confirm commits the new keeper', async () => {
    const clock = turnedClock()
    const source = coordinatorFor('region-west', { 'squad-42': 'region-west' }, clock)
    const target = coordinatorFor('region-east', {}, clock)

    // 1. Source prepares on Target DO
    const prep = target.coordinator.prepare({
      handoverId: OFFER.handoverId,
      playerId: OFFER.playerId,
      squadId: OFFER.squadId,
      sourceRegion: 'region-west',
      targetRegion: 'region-east',
      token: OFFER.token,
      expiresAt: 10_000,
    })
    expect(prep.prepared).toBe(true)

    // 2. Source initiates handover offer
    const reservation = await source.coordinator.initiate(OFFER)
    expect(reservation.state).toBe('offered')
    expect(source.coordinator.reservation(OFFER.handoverId)?.state).toBe('offered')

    // 3. Client calls arrive on Target DO (2nd socket)
    const arrived = target.coordinator.arrive(OFFER.handoverId, OFFER.token, OFFER.squadId, OFFER.playerId)
    expect(arrived.squadId).toBe(OFFER.squadId)

    // The squad is still the source's until arrival is confirmed.
    expect(await source.directory.ownerOfSquad(OFFER.squadId)).toBe('region-west')

    // 4. Target DO confirms arrival to Source DO
    const confirmed = await source.coordinator.confirm(OFFER.handoverId)
    expect(confirmed.state).toBe('confirmed')
    expect(source.coordinator.reservation(OFFER.handoverId)).toBeUndefined()
    expect(await source.directory.ownerOfSquad(OFFER.squadId)).toBe('region-east')
  })

  test('a region starts a handover only for a squad it keeps, from itself, to another', async () => {
    const source = coordinatorFor('region-west', { 'squad-42': 'region-east' })
    await expect(source.coordinator.initiate(OFFER)).rejects.toThrow(/kept by another/)
    await expect(source.coordinator.initiate({ ...OFFER, squadId: 'unknown' })).rejects.toThrow(/kept by another/)

    const keeper = coordinatorFor('region-west', { 'squad-42': 'region-west' })
    await expect(keeper.coordinator.initiate({ ...OFFER, sourceRegion: 'region-east' })).rejects.toThrow(/not this region's/)
    await expect(keeper.coordinator.initiate({ ...OFFER, targetRegion: 'region-west' })).rejects.toThrow(/not this region's/)
  })

  test('a region prepares only for arrivals addressed to it', () => {
    const { coordinator } = coordinatorFor('region-east', {})
    expect(() =>
      coordinator.prepare({
        handoverId: 'h-wrong',
        playerId: 'p-1',
        squadId: 'sq-1',
        sourceRegion: 'region-east',
        targetRegion: 'region-west',
        token: 'tok',
        expiresAt: 10_000,
      }),
    ).toThrow(/not region-east/)
  })

  test('arrival rejected on token mismatch or squad mismatch', () => {
    const { coordinator: target } = coordinatorFor('region-east', {})
    target.prepare({
      handoverId: 'h-1',
      playerId: 'p-1',
      squadId: 'sq-1',
      sourceRegion: 'region-west',
      targetRegion: 'region-east',
      token: 'valid-token',
      expiresAt: 10_000,
    })

    expect(() => target.arrive('h-1', 'bad-token', 'sq-1', 'p-1')).toThrow(/mismatch/)
    expect(() => target.arrive('h-1', 'valid-token', 'wrong-squad', 'p-1')).toThrow(/mismatch/)
  })

  test('cancelled handover prevents confirmation and keeps the squad where it was', async () => {
    const source = coordinatorFor('region-west', { 'sq-1': 'region-west' })
    await source.coordinator.initiate({ ...OFFER, handoverId: 'h-abort', squadId: 'sq-1' })

    const cancelResult = source.coordinator.cancel('h-abort', 'Client secondary connect failed')
    expect(cancelResult.retryable).toBe(true)
    expect(cancelResult.nextDelayMs).toBe(2000)
    expect(source.coordinator.reservation('h-abort')).toBeUndefined()
    await expect(source.coordinator.confirm('h-abort')).rejects.toThrow(/Unknown handover reservation/)
    expect(await source.directory.ownerOfSquad('sq-1')).toBe('region-west')
  })

  test('a cancel that arrives while the keeper is being committed is refused, and the commit stands', async () => {
    const writing = Promise.withResolvers<void>()
    const written: string[] = []
    const store = owners({ 'sq-1': 'region-west' })
    const directory = regionDirectory({ owners: store, partitions: PARTITIONS, self: 'region-west' })
    const squads = {
      setOwner: async (squadId: string, owner: string) => {
        await writing.promise
        store.kept[squadId] = owner
        written.push(owner)
      },
    }
    const coordinator = new HandoverCoordinator({ clock: turnedClock(), directory, squads })
    await coordinator.initiate({ ...OFFER, handoverId: 'h-race', squadId: 'sq-1' })

    const confirming = coordinator.confirm('h-race')
    // The write is in flight: the cancel lands between it and the bookkeeping.
    expect(() => coordinator.cancel('h-race', 'the second socket dropped')).toThrow(/already confirmed/)
    await expect(coordinator.confirm('h-race')).rejects.toThrow(/already being confirmed/)
    writing.resolve()

    expect((await confirming).state).toBe('confirmed')
    expect(written).toEqual(['region-east'])
    expect(await directory.ownerOfSquad('sq-1')).toBe('region-east')
  })

  test('a commit that fails gives the reservation back, to be confirmed again', async () => {
    const store = owners({ 'sq-1': 'region-west' })
    const directory = regionDirectory({ owners: store, partitions: PARTITIONS, self: 'region-west' })
    let failing = true
    const squads = {
      setOwner: async (squadId: string, owner: string) => {
        if (failing) throw new Error('the write failed')
        store.kept[squadId] = owner
      },
    }
    const coordinator = new HandoverCoordinator({ clock: turnedClock(), directory, squads })
    await coordinator.initiate({ ...OFFER, handoverId: 'h-retry', squadId: 'sq-1' })

    await expect(coordinator.confirm('h-retry')).rejects.toThrow(/the write failed/)
    expect(coordinator.reservation('h-retry')?.state).toBe('offered')
    expect(await directory.ownerOfSquad('sq-1')).toBe('region-west')

    failing = false
    expect((await coordinator.confirm('h-retry')).state).toBe('confirmed')
    expect(await directory.ownerOfSquad('sq-1')).toBe('region-east')
  })

  test('exponential backoff advances on consecutive failures and halts at max attempts', async () => {
    const { coordinator: source } = coordinatorFor('region-west', { 'sq-backoff': 'region-west' })
    const squadId = 'sq-backoff'
    const delays = [2000, 5000, 10000, 30000, 60000]

    for (let attempt = 1; attempt <= 4; attempt++) {
      const id = `h-try-${attempt}`
      await source.initiate({ ...OFFER, handoverId: id, squadId })
      const res = source.cancel(id, `fail ${attempt}`)
      expect(res.retryable).toBe(true)
      expect(res.attempts).toBe(attempt)
      expect(res.nextDelayMs).toBe(delays[attempt - 1]!)
    }

    // 5th attempt: max attempts reached, should not be retryable
    await source.initiate({ ...OFFER, handoverId: 'h-try-5', squadId })
    const finalRes = source.cancel('h-try-5', 'fail 5')
    expect(finalRes.retryable).toBe(false)
    expect(finalRes.attempts).toBe(5)
  })

  test('an offer the target never saw claimed lapses on the clock, not on a sleep', () => {
    const clock = turnedClock(1_000)
    const { coordinator: target } = coordinatorFor('region-east', {}, clock)
    const prepare = (handoverId: string) =>
      target.prepare({ handoverId, playerId: 'p-1', squadId: 'sq-1', sourceRegion: 'region-west', targetRegion: 'region-east', token: 'tok', expiresAt: clock.now() + HANDOVER_TIMEOUT_MS })
    prepare('h-late')

    clock.advance(HANDOVER_TIMEOUT_MS)
    // Exactly at the expiry the ticket is still good.
    expect(target.arrive('h-late', 'tok', 'sq-1', 'p-1').squadId).toBe('sq-1')

    prepare('h-later')
    clock.advance(HANDOVER_TIMEOUT_MS + 1)
    expect(() => target.arrive('h-later', 'tok', 'sq-1', 'p-1')).toThrow(/expired/)
  })

  test('an outgoing handover expires when its ttl has run out, and stays held until it is settled', async () => {
    const clock = turnedClock()
    const { coordinator: source } = coordinatorFor('region-west', { 'sq-1': 'region-west' }, clock)
    const reservation = await source.initiate({ ...OFFER, handoverId: 'h-ttl', squadId: 'sq-1', ttlMs: 5_000 })
    expect(reservation.expiresAt).toBe(clock.now() + 5_000)
    clock.advance(5_001)
    // Nothing forgets it on its own: only the source's resolution does, once the target has said what became of it.
    expect(source.reservation('h-ttl')?.state).toBe('offered')
  })

  test('a handover decided against stays held, cancelled, and can no longer be confirmed, until it is cancelled for good', async () => {
    const { coordinator: source } = coordinatorFor('region-west', { 'sq-1': 'region-west' })
    await source.initiate({ ...OFFER, handoverId: 'h-abort', squadId: 'sq-1' })

    expect(source.abort('h-abort').state).toBe('cancelled')
    expect(source.reservationOf('sq-1')?.handoverId).toBe('h-abort')
    await expect(source.confirm('h-abort')).rejects.toThrow(/was cancelled/)
    expect(source.cancel('h-abort', 'the target let go').retryable).toBe(true)
    expect(source.reservation('h-abort')).toBeUndefined()
    expect(() => source.abort('h-abort')).toThrow(/Unknown handover reservation/)
  })

  test('an arrival is remembered until it is settled, and an offer is expected only while it is unclaimed and live', () => {
    const clock = turnedClock(1_000)
    const { coordinator: target } = coordinatorFor('region-east', {}, clock)
    const offer = { handoverId: 'h-1', playerId: 'p-1', squadId: 'sq-1', sourceRegion: 'region-west', targetRegion: 'region-east', token: 'tok', expiresAt: 2_000 }
    target.prepare(offer)
    expect(target.expects('p-1')).toBe(true)
    expect(target.expects('p-2')).toBe(false)

    target.arrive('h-1', 'tok', 'sq-1', 'p-1')
    expect(target.expects('p-1')).toBe(false)
    expect(target.arrivedAt('h-1')).toEqual(offer)
    // A commit that could not be written gives the offer back, as it was.
    target.unclaim('h-1')
    expect(target.arrivedAt('h-1')).toBeUndefined()
    expect(target.prepared('h-1')).toEqual(offer)
    target.arrive('h-1', 'tok', 'sq-1', 'p-1')
    target.settle('h-1')
    expect(target.arrivedAt('h-1')).toBeUndefined()
    expect(target.prepared('h-1')).toBeUndefined()

    target.prepare({ ...offer, handoverId: 'h-2' })
    clock.advance(1_001)
    expect(target.expects('p-1')).toBe(false)
  })
})

describe('HandoverCoordinator refusals (tictac-dwq.4)', () => {
  /** What a call refused with: its code. */
  function codeOf(call: () => unknown): number | null {
    try {
      call()
    } catch (error) {
      if (error instanceof Refusal) return error.code
      throw error
    }
    return null
  }

  const prepared = {
    handoverId: 'h-1',
    playerId: 'p-1',
    squadId: 'sq-1',
    sourceRegion: 'region-west',
    targetRegion: 'region-east',
    token: 'ticket',
    expiresAt: 10_000,
  }

  test('arriving is refused gone for an unknown handover, notYours for another player, a wrong ticket or squad, conflict once it has lapsed', () => {
    const clock = turnedClock()
    const { coordinator } = coordinatorFor('region-east', {}, clock)
    coordinator.prepare(prepared)

    expect(codeOf(() => coordinator.arrive('h-nobody', 'ticket', 'sq-1', 'p-1'))).toBe(RPC_ERRORS.gone)
    expect(codeOf(() => coordinator.arrive('h-1', 'ticket', 'sq-1', 'p-2'))).toBe(RPC_ERRORS.notYours)
    expect(codeOf(() => coordinator.arrive('h-1', 'stolen', 'sq-1', 'p-1'))).toBe(RPC_ERRORS.notYours)
    expect(codeOf(() => coordinator.arrive('h-1', 'ticket', 'sq-2', 'p-1'))).toBe(RPC_ERRORS.notYours)
    clock.advance(10_001)
    expect(codeOf(() => coordinator.arrive('h-1', 'ticket', 'sq-1', 'p-1'))).toBe(RPC_ERRORS.conflict)
    // A refused arrival claims nothing: the lapsed ticket is still the region's to withdraw.
    expect(coordinator.withdraw('h-1')).toEqual(prepared)
    expect(coordinator.withdraw('h-1')).toBeNull()
  })

  test('cancelling a handover this region is not the source of is refused gone', () => {
    const { coordinator } = coordinatorFor('region-west', { 'sq-1': 'region-west' })
    expect(codeOf(() => coordinator.cancel('h-nobody', 'never was'))).toBe(RPC_ERRORS.gone)
  })
})

describe('A window crossing between two real servers', () => {
  const WEST = 'region-west'
  const EAST = 'region-east'

  /** Two servers on two ports, each its own region over its own database, the directory's accounts behind both. */
  async function twoServers() {
    const west = await openPersistence(WALL_CLOCK, ':memory:', { self: WEST })
    const eastRegion = await regionStoreOverDb(await openDb(':memory:'), WALL_CLOCK, west.accounts.accounts, EAST)
    const peers = inProcessPeers()
    const start = (region: RegionStore) =>
      startGameServer({
        accounts: west.accounts.accounts,
        region,
        party: west.accounts.party,
        regions: PARTITIONS,
        clock: WALL_CLOCK,
        port: 0,
        log: () => {},
        peers,
        // Nothing is rolled for on the road: the squad crosses from where it stands.
        journeys: { openEncounter: undefined, openMeeting: undefined },
      })
    const westServer = await start(west.region)
    const eastServer = await start(eastRegion)
    const wsOf = (server: { url: string }) => server.url.replace('http', 'ws')
    peers.add(WEST, { crossings: westServer.crossings, url: wsOf(westServer) })
    peers.add(EAST, { crossings: eastServer.crossings, url: wsOf(eastServer) })
    const stops: (() => Promise<void>)[] = []
    return {
      west: { server: westServer, region: west.region, url: wsOf(westServer) },
      east: { server: eastServer, region: eastRegion, url: wsOf(eastServer) },
      peers,
      /** A window on the west, registered, with the order to cross from where it stands. */
      async windowSentAcross() {
        const connection = new ServerConnection(wsOf(westServer), { tokens: heldTokens(null) })
        stops.push(async () => connection.close())
        const key = await softwareAuthenticator()
        const options = await connection.request('tictac/api/account/registerOptions', { name: 'ada' })
        const created = await key.create({
          challengeId: options.challengeId,
          challenge: (options.publicKey as { challenge: string }).challenge,
        })
        connection.signedIn(await connection.request('tictac/api/account/registerVerify', created))
        const { squad } = await connection.request('tictac/api/squad/get', {})
        const here = squad.waypoints.at(-1)!
        return { connection, squadId: squad.id, to: { lat: here.lat, lng: here.lng } }
      },
      async stop() {
        for (const stop of stops) await stop()
        await westServer.stop()
        await eastServer.stop().catch(() => {})
        await eastRegion.close()
        await west.close()
      },
    }
  }

  test('ends on the target with one socket: the target commits, the source purges only after it confirms', async () => {
    const world = await twoServers()
    try {
      const { connection, squadId, to } = await world.windowSentAcross()
      const seen: { westRow: boolean; eastKeeper: string | null }[] = []
      world.peers.through(WEST, (peer) => ({
        ...peer,
        confirmArrival: async (handoverId) => {
          // The target has committed, and the source has not yet let go.
          seen.push({
            westRow: (await world.west.region.squads.byId(squadId)) !== null,
            eastKeeper: await world.east.region.squads.ownerOf(squadId),
          })
          return peer.confirmArrival(handoverId)
        },
      }))
      const moved = Promise.withResolvers<void>()
      const events: string[] = []
      connection.onHandover((event) => {
        events.push(event.kind)
        if (event.kind === 'complete') moved.resolve()
      })

      const ordered = await connection.request('tictac/api/squad/order', {
        order: { kind: 'crossBorder', to, destinationRegion: EAST },
      })
      expect(ordered.squad.id).toBe(squadId)
      await moved.promise

      expect(events).toEqual(['offered', 'complete'])
      expect(seen).toEqual([{ westRow: true, eastKeeper: EAST }])
      expect(await world.west.region.squads.byId(squadId)).toBeNull()
      expect(await world.east.server.directory.ownerOfSquad(squadId)).toBe(EAST)
      // One window, on the target: the source's session was ended, and the second socket is the only one left.
      expect(world.west.server.lobby.hasWindow((await connection.request('tictac/api/account/me', {})).player!.id)).toBe(false)
      expect(world.east.server.lobby.hasWindow((await connection.request('tictac/api/account/me', {})).player!.id)).toBe(true)
      // And everything the window asks is answered by the target now.
      expect((await connection.request('tictac/api/squad/get', {})).squad.id).toBe(squadId)
    } finally {
      await world.stop()
    }
  })

  test('a target that is gone when the window comes leaves the squad with the source, which stays authoritative and the window where it was', async () => {
    const world = await twoServers()
    try {
      const { connection, squadId, to } = await world.windowSentAcross()
      const dropped = Promise.withResolvers<void>()
      world.peers.through(EAST, (peer) => ({
        ...peer,
        // The target answers the prepare and dies before the window gets to it.
        prepareHandover: async (request) => {
          const answer = await peer.prepareHandover(request)
          await world.east.server.stop()
          return answer
        },
        // The source hears from the window that it could not arrive, and tells the target to let go; it lets go of the squad once the target has.
        cancelHandover: async (handoverId) => {
          const answer = await peer.cancelHandover(handoverId)
          dropped.resolve()
          return answer
        },
      }))

      await connection.request('tictac/api/squad/order', { order: { kind: 'crossBorder', to, destinationRegion: EAST } })
      await dropped.promise
      // Real servers over real sockets, so no clock to turn: one turn of the event loop for the source to finish letting go once the target has answered.
      await Bun.sleep(0)

      expect(await world.west.server.directory.ownerOfSquad(squadId)).toBe(WEST)
      expect(world.west.server.crossings.inFlight(squadId)).toBe(false)
      expect((await connection.request('tictac/api/squad/get', {})).squad.id).toBe(squadId)
      expect(world.west.server.lobby.hasWindow((await connection.request('tictac/api/account/me', {})).player!.id)).toBe(true)
    } finally {
      await world.stop()
    }
  })
})
