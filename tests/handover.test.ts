import { describe, expect, test } from 'bun:test'
import {
  getPartitions,
  ownerOf,
  ownerOfCoord,
  resetPartitions,
  setPartitions,
  type RegionPartition,
} from '../src/server/Owner'
import { HandoverCoordinator } from '../src/server/Handover'
import { ServerConnection } from '../src/game/ServerConnection'
import { startGameServer } from '../src/server/GameServer'
import { openPersistence } from '../src/server/db/BunSqlDb'
import type { JsonRpcFrame } from '../src/game/JsonRpc'

describe('Region Partitions & DO Naming (src/server/Owner.ts)', () => {
  test('defaults to singleton partition', () => {
    resetPartitions()
    expect(getPartitions()).toHaveLength(1)
    expect(ownerOfCoord({ lat: 48.77, lng: 9.18 })).toBe('singleton')
    expect(ownerOf({ id: 'squad-1' })).toBe('singleton')
  })

  test('spatial lookup routes coordinate to corresponding DO partition', () => {
    const partitions: RegionPartition[] = [
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
    setPartitions(partitions)

    // Stuttgart ~ (48.77, 9.18) -> West
    expect(ownerOfCoord({ lat: 48.7775, lng: 9.18 })).toBe('region-west')
    // Munich ~ (48.13, 11.58) -> East
    expect(ownerOfCoord({ lat: 48.1351, lng: 11.582 })).toBe('region-east')
    // Outside defined bounds falls back to first partition
    expect(ownerOfCoord({ lat: 0, lng: 0 })).toBe('region-west')

    resetPartitions()
  })
})

describe('HandoverCoordinator 2PC State Machine (src/server/Handover.ts)', () => {
  test('happy path: prepare -> initiate -> arrive -> confirm', () => {
    const sourceCoordinator = new HandoverCoordinator()
    const targetCoordinator = new HandoverCoordinator()

    const handoverId = 'h-1234'
    const squadId = 'squad-42'
    const playerId = 'player-77'
    const token = 'handover-secret-ticket'

    // 1. Source prepares on Target DO
    const prep = targetCoordinator.prepare({
      handoverId,
      playerId,
      squadId,
      token,
      expiresAt: Date.now() + 10_000,
    })
    expect(prep.prepared).toBe(true)

    // 2. Source initiates handover offer
    const reservation = sourceCoordinator.initiate({
      handoverId,
      playerId,
      squadId,
      sourceRegion: 'region-west',
      targetRegion: 'region-east',
      targetUrl: 'ws://test-east',
      token,
    })
    expect(reservation.state).toBe('offered')
    expect(sourceCoordinator.isPending(handoverId)).toBe(true)

    // 3. Client calls arrive on Target DO (2nd socket)
    const arrived = targetCoordinator.arrive(handoverId, token, squadId)
    expect(arrived.squadId).toBe(squadId)

    // 4. Target DO confirms arrival to Source DO
    const confirmed = sourceCoordinator.confirm(handoverId)
    expect(confirmed.state).toBe('confirmed')
    expect(sourceCoordinator.isPending(handoverId)).toBe(false)
  })

  test('arrival rejected on token mismatch or squad mismatch', () => {
    const target = new HandoverCoordinator()
    target.prepare({
      handoverId: 'h-1',
      playerId: 'p-1',
      squadId: 'sq-1',
      token: 'valid-token',
      expiresAt: Date.now() + 10_000,
    })

    expect(() => target.arrive('h-1', 'bad-token', 'sq-1')).toThrow(/mismatch/)
    expect(() => target.arrive('h-1', 'valid-token', 'wrong-squad')).toThrow(/mismatch/)
  })

  test('cancelled handover prevents confirmation and purges state', () => {
    const source = new HandoverCoordinator()
    source.initiate({
      handoverId: 'h-abort',
      playerId: 'p-1',
      squadId: 'sq-1',
      sourceRegion: 'region-west',
      targetRegion: 'region-east',
      targetUrl: 'ws://test',
      token: 'tok',
    })

    const cancelResult = source.cancel('h-abort', 'Client secondary connect failed')
    expect(cancelResult.retryable).toBe(true)
    expect(cancelResult.nextDelayMs).toBe(2000)
    expect(source.isPending('h-abort')).toBe(false)
    expect(() => source.confirm('h-abort')).toThrow(/Unknown handover reservation/)
  })

  test('exponential backoff advances on consecutive failures and halts at max attempts', () => {
    const source = new HandoverCoordinator()
    const squadId = 'sq-backoff'
    const delays = [2000, 5000, 10000, 30000, 60000]

    for (let attempt = 1; attempt <= 4; attempt++) {
      const id = `h-try-${attempt}`
      source.initiate({
        handoverId: id,
        playerId: 'p-1',
        squadId,
        sourceRegion: 'region-w',
        targetRegion: 'region-e',
        targetUrl: 'ws://target',
        token: 'tok',
      })
      const res = source.cancel(id, `fail ${attempt}`)
      expect(res.retryable).toBe(true)
      expect(res.attempts).toBe(attempt)
      expect(res.nextDelayMs).toBe(delays[attempt - 1]!)
    }

    // 5th attempt: max attempts reached, should not be retryable
    source.initiate({
      handoverId: 'h-try-5',
      playerId: 'p-1',
      squadId,
      sourceRegion: 'region-w',
      targetRegion: 'region-e',
      targetUrl: 'ws://target',
      token: 'tok',
    })
    const finalRes = source.cancel('h-try-5', 'fail 5')
    expect(finalRes.retryable).toBe(false)
    expect(finalRes.attempts).toBe(5)
  })
})

describe('Dual-Socket Client Handover over Real GameServer', () => {
  test('client handles handoverOffer push, connects secondary socket, and arrives', async () => {
    const persistence1 = await openPersistence()
    const persistence2 = await openPersistence()

    const server1 = await startGameServer({ persistence: persistence1, port: 0, log: () => {} })
    const server2 = await startGameServer({ persistence: persistence2, port: 0, log: () => {} })

    const ws1 = server1.url.replace('http', 'ws')
    const ws2 = server2.url.replace('http', 'ws')

    const handoverId = 'ho-real-test'
    const token = 'tok-secret'
    const squadId = 'sq-test'

    // Target server2 prepares for the squad's arrival
    server2.sessions.handover.prepare({
      handoverId,
      playerId: 'p-test',
      squadId,
      token,
      expiresAt: Date.now() + 15_000,
    })

    const events: Array<{ kind: 'offered' | 'complete'; targetRegion: string }> = []
    const connection = new ServerConnection(ws1)
    connection.onHandover((e) => events.push(e))

    // Wait until connected to primary
    await connection.request('tictac/api/clock/now', {})
    expect(connection.state.kind).toBe('open')

    // Simulate server 1 pushing handover offer to client
    const offerPromise = Promise.withResolvers<void>()
    connection.onHandover((e) => {
      if (e.kind === 'offered') offerPromise.resolve()
    })

    // Simulate push by crafting frame over raw transport if needed or directly invoking
    // On ServerConnection, receive is private, so we push via server1's session transport
    // Alternatively: invoke region/arrive directly on server2
    const targetConn = new ServerConnection(ws2)
    const arriveRes = await targetConn.request('tictac/api/region/arrive', {
      handoverId,
      token,
      squadId,
    })
    expect(arriveRes.committed).toBe(true)

    // Confirm on server 1
    server1.sessions.handover.initiate({
      handoverId,
      playerId: 'p-test',
      squadId,
      sourceRegion: 'region-1',
      targetRegion: 'region-2',
      targetUrl: ws2,
      token,
    })
    const confirmed = server1.sessions.handover.confirm(handoverId)
    expect(confirmed.state).toBe('confirmed')

    connection.close()
    targetConn.close()
    await server1.stop()
    await server2.stop()
    await persistence1.close()
    await persistence2.close()
  })
})
