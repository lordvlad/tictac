import { WALL_CLOCK } from '../src/server/Clock'
import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { distanceKm } from '../src/core/Travel'
import { START_RADIUS_KM } from '../src/server/Squads'
import type { LobbyView } from '../src/wire/Lobby'
import { RPC_ERRORS } from '../src/wire/Rpc'
import { heldTokens, RpcError, ServerConnection } from '../src/game/ServerConnection'
import { startGameServer, type GameServerOptions } from '../src/server/GameServer'
import { openPersistence } from '../src/server/db/BunSqlDb'
import { portsOf } from '../src/server/Persistence'
import { MY_VERSION } from '../src/version'
import { softwareAuthenticator } from './support/authenticator'

/**
 * The server as a window meets it: over a real port and a real WebSocket,
 * through the browser's own `ServerConnection`.
 *
 * What the unit tests cannot cover is the seam between the halves — that a
 * passkey ceremony over the socket is what makes that same socket somebody,
 * that the lobby arrives as pushes on it, and that HTTP is left with nothing
 * but the static.
 */

async function serve(graceMs?: number, more: Partial<GameServerOptions> = {}) {
  const persistence = await openPersistence(WALL_CLOCK)
  const server = await startGameServer({ ...portsOf(persistence), clock: WALL_CLOCK, port: 0, log: () => {}, graceMs, ...more })
  const ws = server.url.replace('http', 'ws')
  return {
    persistence,
    server,
    ws,
    connect: (token: string | null = null) => new ServerConnection(ws, { tokens: heldTokens(token) }),
    stop: async () => {
      await server.stop()
      await persistence.close()
    },
  }
}

/** Register a passkey over `connection`, as the browser's ceremony does; the token comes back. */
async function register(connection: ServerConnection, name = 'Tester'): Promise<string> {
  const key = await softwareAuthenticator()
  const options = await connection.request('tictac/api/account/registerOptions', { name })
  const created = await key.create({
    challengeId: options.challengeId,
    challenge: (options.publicKey as { challenge: string }).challenge,
  })
  const signed = await connection.request('tictac/api/account/registerVerify', created)
  connection.signedIn(signed)
  return signed.token
}

/** The next lobby view `connection` is pushed that satisfies `ready`. */
function lobbyWhere(connection: ServerConnection, ready: (view: LobbyView) => boolean): Promise<LobbyView> {
  const { promise, resolve } = Promise.withResolvers<LobbyView>()
  const stop = connection.watchLobby((view) => {
    if (!ready(view)) return
    stop()
    resolve(view)
  })
  return promise
}

/** Where the server put a window, by entering over its connection without a match on top. */
function enter(connection: ServerConnection, intent: Parameters<ServerConnection['enter']>[0]) {
  const { promise, resolve, reject } = Promise.withResolvers<{ roomId: string; seatKey: string | null }>()
  const channel = connection.enter(intent, {
    rejoin: () => intent,
    seated: (seat) => resolve(seat),
    dropped: () => {},
  })
  channel.onClosed((reason) => reject(new Error(reason)))
  return promise
}

describe('The match server on a real port', () => {
  test('a passkey made over the socket makes that socket somebody, and the lobby is pushed to it', async () => {
    const { connect, stop } = await serve()
    const ada = connect()
    const token = await register(ada, 'Ada')
    expect(ada.player?.name).toBe('Ada')

    const watcher = connect()
    const opened = await enter(ada, { kind: 'open' })

    // Anybody may read the room list; only the player holding a seat is told
    // it is theirs — and each is told by a push, nobody asks again.
    const seenByAda = await lobbyWhere(ada, (view) => view.rooms.length === 1)
    const seenByWatcher = await lobbyWhere(watcher, (view) => view.rooms.length === 1)
    expect(seenByWatcher.rooms[0]).toMatchObject({
      id: opened.roomId,
      phase: 'waiting',
      blue: { name: 'Ada', connected: true },
      red: null,
      spectators: 0,
      turn: null,
    })
    expect(seenByWatcher.you).toBeNull()
    expect(seenByAda.you).toEqual({ roomId: opened.roomId, faction: Faction.Blue, phase: 'waiting', control: 'player', joinBy: null, against: null })

    // The token is what every later socket presents, and it still works.
    expect(token.length).toBeGreaterThan(0)
    for (const connection of [ada, watcher]) connection.close()
    await stop()
  })

  test('a token the server no longer honours is a refusal, and the socket stays', async () => {
    const { connect, stop } = await serve()
    const stale = connect()

    const refusal = await stale.request('tictac/api/account/signIn', { token: 'not-a-token' }).catch((e) => e)
    expect(refusal).toBeInstanceOf(RpcError)
    expect((refusal as RpcError).code).toBe(RPC_ERRORS.signInFirst)

    // Same socket, next question: still answered.
    expect(await stale.request('tictac/api/account/me', {})).toEqual({ player: null })
    expect(stale.state.kind).toBe('open')
    stale.close()
    await stop()
  })

  test('a request before the page has said which build it is gets no answer but that', async () => {
    const { ws, stop } = await serve()
    const socket = new WebSocket(ws)
    const open = Promise.withResolvers<void>()
    socket.addEventListener('open', () => open.resolve())
    await open.promise
    const answer = Promise.withResolvers<{ error?: { code: number } }>()
    socket.addEventListener('message', (event) => answer.resolve(JSON.parse(String(event.data))))
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tictac/api/account/me', params: {} }))
    expect((await answer.promise).error?.code).toBe(RPC_ERRORS.helloFirst)

    socket.close()
    await stop()
  })

  test('a window that signs in elsewhere is replaced, and the old one is told why', async () => {
    const { connect, stop } = await serve()
    const first = connect()
    const token = await register(first, 'Bo')
    const closed = Promise.withResolvers<void>()
    first.onChange(() => {
      if (first.state.kind === 'closed') closed.resolve()
    })

    const second = connect(token)
    await second.request('tictac/api/account/me', {})
    await closed.promise
    expect(first.state).toEqual({ kind: 'closed', reason: 'You opened TicTac in another window; this one was disconnected.' })
    expect(second.player?.name).toBe('Bo')

    second.close()
    await stop()
  })

  test('a room outlives the server: a new one on the same database takes it up, and the window gets its seat back', async () => {
    const persistence = await openPersistence(WALL_CLOCK)
    const options = { ...portsOf(persistence), clock: WALL_CLOCK, port: 0, log: () => {} }
    const first = await startGameServer(options)
    const before = new ServerConnection(first.url.replace('http', 'ws'), { tokens: heldTokens() })
    const opened = await enter(before, { kind: 'open' })
    before.close()
    await first.stop()

    const second = await startGameServer(options)
    const after = new ServerConnection(second.url.replace('http', 'ws'), { tokens: heldTokens() })
    const held = await lobbyWhere(after, (view) => view.rooms.length === 1)
    expect(held.rooms.map((room) => [room.id, room.blue.connected])).toEqual([[opened.roomId, false]])

    const back = await enter(after, { kind: 'resume', roomId: opened.roomId, seatKey: opened.seatKey! })
    expect([back.roomId, back.seatKey]).toEqual([opened.roomId, opened.seatKey])

    after.close()
    await second.stop()
    await persistence.close()
  })

  test('HTTP is left with the status document at /status: there is no API on it any more', async () => {
    const { server, stop } = await serve()

    const status = (await (await fetch(`${server.url}status`)).json()) as Record<string, unknown>
    expect(status.referee).toBe('tictac')
    expect(status.protocol).toBe(MY_VERSION.protocol)
    expect(status.rooms).toBe(0)
    expect(status.recent).toEqual([])
    // The same route on the Durable Object (`tests/cloudflare.test.ts`); the
    // rest of the path space is the host's own, which is nothing here.
    expect((await fetch(`${server.url}api/lobby`)).status).toBe(404)
    expect((await fetch(server.url)).status).toBe(404)

    await stop()
  })

  test('a connection is placed where its host says it came from, which is how the Durable Object places one', async () => {
    // A Bun process knows no more than a socket's request; a test says where
    // from, in the url, and the squad is drawn there instead of at the default anchor.
    const sydney = { lat: -33.87, lng: 151.21 }
    const placeOf: GameServerOptions['placeOf'] = (request) => {
      const [lat, lng] = (new URL(request.url).searchParams.get('place') ?? '').split(',').map(Number)
      return lat === undefined || lng === undefined || Number.isNaN(lat) ? null : { lat, lng }
    }
    const { ws, stop } = await serve(undefined, { placeOf })

    const placed = new ServerConnection(`${ws}?place=${sydney.lat},${sydney.lng}`, { tokens: heldTokens() })
    await register(placed, 'Down Under')
    const squad = (await placed.request('tictac/api/squad/get', {})).squad
    const start = squad.waypoints[0]!
    expect(distanceKm(sydney, start)).toBeLessThanOrEqual(START_RADIUS_KM)

    // Where nothing is said, nothing is known: the default anchor, as on a Worker with no `cf`.
    const unplaced = new ServerConnection(ws, { tokens: heldTokens() })
    await register(unplaced, 'Anywhere')
    const home = (await unplaced.request('tictac/api/squad/get', {})).squad.waypoints[0]!
    expect(distanceKm(sydney, home)).toBeGreaterThan(START_RADIUS_KM)

    placed.close()
    unplaced.close()
    await stop()
  })
})
