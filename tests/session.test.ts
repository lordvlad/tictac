import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import type { Player } from '../src/game/Rpc'
import { Lobby } from '../src/server/Lobby'
import { MY_VERSION, PROTOCOL_VERSION } from '../src/version'
import { connect, keyOf, roomOf, seatBoth } from './support/lobby'
import { freshPersistence } from './support/db'

/**
 * The window's one socket, as the server keeps it (`src/server/Session.ts`):
 * the lobby pushed rather than polled, a room left without the socket going,
 * a newer window replacing an older one, and the one thing a page on the
 * protocol before this one may still do.
 *
 * Driven through `tests/support/lobby.ts`, which speaks raw frames the way a
 * window does.
 */

const ADA: Player = { id: 'ada', name: 'Ada' }
const BO: Player = { id: 'bo', name: 'Bo' }

async function harness() {
  const persistence = await freshPersistence(':memory:')
  const lobby = new Lobby({ matches: persistence.matches, rooms: persistence.rooms, log: () => {} })
  return { persistence, lobby }
}

describe('The lobby, pushed', () => {
  test('a subscriber is told of every room that opens, fills, and goes — and only its own seat is "you"', async () => {
    const { lobby } = await harness()
    const watcher = await connect(lobby, BO, null)
    const first = await watcher.request('tictac/api/lobby/subscribe', {})
    expect(first).toEqual({ rooms: [], you: null })

    const host = await connect(lobby, ADA, { kind: 'open' })
    const opened = await watcher.lobbyWhere((view) => view.rooms.length === 1)
    expect(opened.rooms.map((room) => [room.id, room.phase, room.blue.name])).toEqual([[roomOf(host), 'waiting', 'Ada']])
    expect(opened.you).toBeNull()

    // Bo joins from the watching socket: the push he gets says the seat is his.
    await watcher.request('tictac/api/room/enter', { intent: { kind: 'join', roomId: roomOf(host) } })
    const joined = await watcher.lobbyWhere((view) => view.you !== null)
    expect(joined.you).toEqual({ roomId: roomOf(host), faction: Faction.Red, phase: 'deploying' })

    // Ada's seat drops: the room stays listed, her seat marked as away.
    host.close()
    const dropped = await watcher.lobbyWhere((view) => view.rooms[0]?.blue.connected === false)
    expect(dropped.rooms.map((room) => room.id)).toEqual([roomOf(host)])
  })

  test('an unsubscribed socket is told nothing more', async () => {
    const { lobby } = await harness()
    const watcher = await connect(lobby, null, null)
    await watcher.request('tictac/api/lobby/subscribe', {})
    await watcher.request('tictac/api/lobby/unsubscribe', {})
    // Still subscribed, so the moment the push goes out is a moment this test can see.
    const control = await connect(lobby, null, null)
    await control.request('tictac/api/lobby/subscribe', {})
    const heard = watcher.lobby.length

    await connect(lobby, null, { kind: 'open' })
    await control.lobbyWhere((view) => view.rooms.length === 1)
    expect(watcher.lobby.length).toBe(heard)
  })
})

describe('A room is not the socket', () => {
  test('a spectator who leaves stays connected, and can take a seat next', async () => {
    const { lobby } = await harness()
    const { roomId } = await seatBoth(lobby, null, null)
    const visitor = await connect(lobby, null, { kind: 'watch', roomId })
    expect(lobby.view(null).rooms[0]!.spectators).toBe(1)

    expect(await visitor.request('tictac/api/room/leave', {})).toBeNull()
    expect(lobby.view(null).rooms[0]!.spectators).toBe(0)
    expect(visitor.closed).toBe(false)

    // Same socket, a room of its own.
    const seat = await visitor.request('tictac/api/room/enter', { intent: { kind: 'open' } })
    expect(seat.faction).toBe(Faction.Blue)
    expect(lobby.view(null).rooms).toHaveLength(2)
  })

  test('refusals are answers: a room that is gone, then one that is full, then a seat — on one socket', async () => {
    const { lobby } = await harness()
    const { roomId } = await seatBoth(lobby, null, null)
    const page = await connect(lobby, null, null)

    await expect(page.request('tictac/api/room/enter', { intent: { kind: 'join', roomId: 'nowhere' } })).rejects.toThrow(
      'That match is gone.',
    )
    await expect(page.request('tictac/api/room/enter', { intent: { kind: 'join', roomId } })).rejects.toThrow(
      'That match already has two players',
    )
    const watching = await page.request('tictac/api/room/enter', { intent: { kind: 'watch', roomId } })
    expect(watching.faction).toBeNull()
    expect(page.closed).toBe(false)
  })
})

describe('One window per player', () => {
  test('signing in on a new socket replaces the old one, whose seat is held rather than abandoned', async () => {
    // Signing in is what a reconnecting window does first, before it asks for
    // its seat back by key — so signing in alone must not cost a room still
    // being set up. Only entering somewhere else would.
    const { lobby } = await harness()
    const { blue, roomId } = await seatBoth(lobby, ADA, BO)

    const window = await connect(lobby, ADA, null)

    expect(blue.of('abort')[0]?.reason).toBe('You opened TicTac in another window; this one was disconnected.')
    expect(blue.closed).toBe(true)
    expect(lobby.view(null).rooms.map((room) => [room.id, room.phase, room.blue.connected])).toEqual([
      [roomId, 'deploying', false],
    ])

    // …and the same window takes the seat back by its key, the room intact.
    const back = await window.request('tictac/api/room/enter', {
      intent: { kind: 'resume', roomId, seatKey: keyOf(blue) },
    })
    expect(back).toMatchObject({ roomId, faction: Faction.Blue, phase: 'deploying' })
  })
})

describe('A page on the protocol before this one', () => {
  const PREVIOUS = { protocol: PROTOCOL_VERSION - 1, build: MY_VERSION.build }

  test('may take back the seat its url names, the way it always did', async () => {
    const { lobby } = await harness()
    const { blue, roomId } = await seatBoth(lobby, null, null)
    const seatKey = keyOf(blue)
    blue.close()

    const old = await connect(lobby, null, { kind: 'resume', roomId, seatKey }, { version: PREVIOUS })

    // Answered as protocol 6 is: a `seated` notification, not a response.
    expect(old.of('seated')[0]).toMatchObject({ roomId, faction: Faction.Blue, seatKey })
    expect(old.closed).toBe(false)
  })

  test('may do nothing else', async () => {
    const { lobby } = await harness()
    const old = await connect(lobby, null, null, { version: PREVIOUS, hello: false })
    old.send({ type: 'hello', ...PREVIOUS })

    expect(old.of('abort')[0]?.reason).toMatch(/Protocol mismatch/)
    expect(old.closed).toBe(true)
  })
})
