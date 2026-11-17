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
import { ServerConnection } from '../src/game/ServerConnection'
import { startGameServer } from '../src/server/GameServer'
import { openPersistence } from '../src/server/db/BunSqlDb'
import { portsOf, type Persistence } from '../src/server/Persistence'
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
  return (await persistence.region.squads.place(playerId, null)).id
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
      targetRegion: 'region-east',
      token: OFFER.token,
      expiresAt: 10_000,
    })
    expect(prep.prepared).toBe(true)

    // 2. Source initiates handover offer
    const reservation = await source.coordinator.initiate(OFFER)
    expect(reservation.state).toBe('offered')
    expect(source.coordinator.isPending(OFFER.handoverId)).toBe(true)

    // 3. Client calls arrive on Target DO (2nd socket)
    const arrived = target.coordinator.arrive(OFFER.handoverId, OFFER.token, OFFER.squadId)
    expect(arrived.squadId).toBe(OFFER.squadId)

    // The squad is still the source's until arrival is confirmed.
    expect(await source.directory.ownerOfSquad(OFFER.squadId)).toBe('region-west')

    // 4. Target DO confirms arrival to Source DO
    const confirmed = await source.coordinator.confirm(OFFER.handoverId)
    expect(confirmed.state).toBe('confirmed')
    expect(source.coordinator.isPending(OFFER.handoverId)).toBe(false)
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
      targetRegion: 'region-east',
      token: 'valid-token',
      expiresAt: 10_000,
    })

    expect(() => target.arrive('h-1', 'bad-token', 'sq-1')).toThrow(/mismatch/)
    expect(() => target.arrive('h-1', 'valid-token', 'wrong-squad')).toThrow(/mismatch/)
  })

  test('cancelled handover prevents confirmation and keeps the squad where it was', async () => {
    const source = coordinatorFor('region-west', { 'sq-1': 'region-west' })
    await source.coordinator.initiate({ ...OFFER, handoverId: 'h-abort', squadId: 'sq-1' })

    const cancelResult = source.coordinator.cancel('h-abort', 'Client secondary connect failed')
    expect(cancelResult.retryable).toBe(true)
    expect(cancelResult.nextDelayMs).toBe(2000)
    expect(source.coordinator.isPending('h-abort')).toBe(false)
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
    expect(coordinator.isPending('h-retry')).toBe(true)
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
      target.prepare({ handoverId, playerId: 'p-1', squadId: 'sq-1', targetRegion: 'region-east', token: 'tok', expiresAt: clock.now() + HANDOVER_TIMEOUT_MS })
    prepare('h-late')

    clock.advance(HANDOVER_TIMEOUT_MS)
    // Exactly at the expiry the ticket is still good.
    expect(target.arrive('h-late', 'tok', 'sq-1').squadId).toBe('sq-1')

    prepare('h-later')
    clock.advance(HANDOVER_TIMEOUT_MS + 1)
    expect(() => target.arrive('h-later', 'tok', 'sq-1')).toThrow(/expired/)
  })

  test('an outgoing handover stops being pending once its ttl has run out', async () => {
    const clock = turnedClock()
    const { coordinator: source } = coordinatorFor('region-west', { 'sq-1': 'region-west' }, clock)
    await source.initiate({ ...OFFER, handoverId: 'h-ttl', squadId: 'sq-1', ttlMs: 5_000 })
    clock.advance(5_000)
    expect(source.isPending('h-ttl')).toBe(true)
    clock.advance(1)
    expect(source.isPending('h-ttl')).toBe(false)
  })
})

describe('Dual-Socket Client Handover over Real GameServer', () => {
  test('client arrives at the target server, and the source commits the new keeper on confirm', async () => {
    const persistence1 = await openPersistence(WALL_CLOCK, ':memory:', { self: 'region-west' })
    const persistence2 = await openPersistence(WALL_CLOCK, ':memory:', { self: 'region-east' })

    const server1 = await startGameServer({
      ...portsOf(persistence1),
      clock: WALL_CLOCK,
      port: 0,
      log: () => {},
      regions: PARTITIONS,
    })
    const server2 = await startGameServer({
      ...portsOf(persistence2),
      clock: WALL_CLOCK,
      port: 0,
      log: () => {},
      regions: PARTITIONS,
    })

    const ws2 = server2.url.replace('http', 'ws')
    const handoverId = 'ho-real-test'
    const token = 'tok-secret'
    const squadId = await squadIn(persistence1, 'p-test')
    await persistence1.region.squads.setOwner(squadId, 'region-west')

    // Target server2 prepares for the squad's arrival
    server2.sessions.handover.prepare({
      handoverId,
      playerId: 'p-test',
      squadId,
      targetRegion: 'region-east',
      token,
      expiresAt: Date.now() + 15_000,
    })

    // The client's second socket arrives at the target.
    const targetConn = new ServerConnection(ws2)
    const arriveRes = await targetConn.request('tictac/api/region/arrive', { handoverId, token, squadId })
    expect(arriveRes.committed).toBe(true)
    expect(arriveRes.targetRegion).toBe('region-east')

    // Confirm on server 1: the squad is the target's from here on.
    await server1.sessions.handover.initiate({
      handoverId,
      playerId: 'p-test',
      squadId,
      sourceRegion: 'region-west',
      targetRegion: 'region-east',
      targetUrl: ws2,
      token,
    })
    const confirmed = await server1.sessions.handover.confirm(handoverId)
    expect(confirmed.state).toBe('confirmed')
    expect(await server1.directory.ownerOfSquad(squadId)).toBe('region-east')

    targetConn.close()
    await server1.stop()
    await server2.stop()
    await persistence1.close()
    await persistence2.close()
  })
})
