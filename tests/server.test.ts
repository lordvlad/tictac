import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { RpcMethods } from '../src/game/JsonRpc'
import { intentQuery, type LobbyView, type ServerIntent } from '../src/game/Lobby'
import { startGameServer } from '../src/server/GameServer'
import { openPersistence } from '../src/server/db/BunSqlDb'
import { LOCAL_RELYING_PARTY } from '../src/server/Persistence'
import { MY_VERSION } from '../src/version'
import { softwareAuthenticator } from './support/authenticator'

/**
 * The server as a client meets it: over a real port, with real `fetch` and a
 * real WebSocket.
 *
 * What the unit tests cannot cover is the seam between the two halves — that a
 * session bought over HTTP is what opens a socket, and that a socket without
 * one is turned away rather than quietly let in as an anonymous client.
 */

const ORIGIN = LOCAL_RELYING_PARTY.origins[0]!

interface Seat {
  socket: WebSocket
  roomId: string
  seatKey: string | null
}

/**
 * Open a socket the way a page does — ticket and intent in the url, `hello`
 * as the first frame — and resolve with the `seated` frame the server answers.
 */
function seated(base: string, intent: ServerIntent, ticket?: string): Promise<Seat> {
  const url = new URL(base.replace('http', 'ws'))
  if (ticket) url.searchParams.set('ticket', ticket)
  for (const [key, value] of new URLSearchParams(intentQuery(intent))) url.searchParams.set(key, value)
  const socket = new WebSocket(url)
  const { promise, resolve, reject } = Promise.withResolvers<Seat>()
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: RpcMethods.hello, params: MY_VERSION }))
  })
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as { method: string; params: Record<string, unknown> }
    if (frame.method === RpcMethods.seated) {
      resolve({ socket, roomId: frame.params.roomId as string, seatKey: frame.params.seatKey as string | null })
    }
    if (frame.method === RpcMethods.abort) reject(new Error(String(frame.params.reason)))
  })
  socket.addEventListener('error', () => reject(new Error('the socket failed')))
  return promise
}

async function registered(base: string): Promise<string> {
  const key = await softwareAuthenticator()
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body),
    })
    return (await response.json()) as Record<string, unknown>
  }

  const options = await post('/api/auth/register/options', { name: 'Tester' })
  const created = await key.create({
    challengeId: options.challengeId as string,
    challenge: (options.publicKey as { challenge: string }).challenge,
  })
  const verified = await post('/api/auth/register/verify', created)
  return verified.token as string
}

describe('The match server on a real port', () => {
  test('a signed-in player trades a session for a seat, and the lobby shows it as theirs alone', async () => {
    const persistence = await openPersistence()
    // Port 0 so the test cannot collide with anything, including itself.
    const server = await startGameServer({
      persistence,
      port: 0,
      party: LOCAL_RELYING_PARTY,
      log: () => {},
    })
    const base = server.url.replace(/\/$/, '')

    const token = await registered(base)
    const ticketed = await fetch(`${base}/api/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    })
    const { ticket } = (await ticketed.json()) as { ticket: string }

    const { socket, roomId } = await seated(base, { kind: 'open' }, ticket)

    const lobby = async (authorization?: string): Promise<LobbyView> => {
      const response = await fetch(`${base}/api/lobby`, {
        headers: authorization ? { authorization } : {},
      })
      expect(response.status).toBe(200)
      return (await response.json()) as LobbyView
    }
    // Anybody may read the room list; the seat is named by the ticket's player.
    const seen = await lobby()
    expect(seen.rooms).toHaveLength(1)
    expect(seen.rooms[0]).toMatchObject({
      id: roomId,
      phase: 'waiting',
      blue: { name: 'Tester', connected: true },
      red: null,
      spectators: 0,
      turn: null,
    })
    expect(seen.you).toBeNull()
    // Only the player holding it is told it is theirs — and a token the
    // server no longer honours costs that, not the list.
    expect((await lobby(`Bearer ${token}`)).you).toEqual({ roomId, faction: Faction.Blue, phase: 'waiting' })
    const stale = await lobby('Bearer not-a-token')
    expect(stale.you).toBeNull()
    expect(stale.rooms).toHaveLength(1)

    socket.close()
    await server.stop()
    await persistence.close()
  })

  test('a socket with a ticket nobody issued is turned away', async () => {
    const persistence = await openPersistence()
    const server = await startGameServer({
      persistence,
      port: 0,
      party: LOCAL_RELYING_PARTY,
      log: () => {},
    })
    const base = server.url.replace(/\/$/, '')

    // Spoken by hand rather than with `new WebSocket`, because what is being
    // checked is the HTTP answer to an upgrade the server refuses.
    const response = await fetch(`${base}/?ticket=nope`, {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })

    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: string }).error).toMatch(/not valid/)

    await server.stop()
    await persistence.close()
  })

  test('an anonymous socket is still welcome', async () => {
    // A match between two unregistered clients is watched and written down
    // exactly as before; it is simply kept on nobody's roster.
    const persistence = await openPersistence()
    const server = await startGameServer({
      persistence,
      port: 0,
      party: LOCAL_RELYING_PARTY,
      log: () => {},
    })

    const { socket, roomId } = await seated(server.url.replace(/\/$/, ''), { kind: 'open' })
    const view = (await (await fetch(`${server.url}api/lobby`)).json()) as LobbyView
    expect(view.rooms.map((room) => [room.id, room.blue.name])).toEqual([[roomId, null]])
    socket.close()

    await server.stop()
    await persistence.close()
  })

  test('a room outlives the server: a new one on the same database takes it up, and the window reconnects', async () => {
    const persistence = await openPersistence()
    const options = { persistence, port: 0, party: LOCAL_RELYING_PARTY, log: () => {} }
    const first = await startGameServer(options)
    const opened = await seated(first.url.replace(/\/$/, ''), { kind: 'open' })
    const closed = new Promise((resolve) => opened.socket.addEventListener('close', resolve))

    await first.stop()
    await closed

    const second = await startGameServer(options)
    const base = second.url.replace(/\/$/, '')
    const view = (await (await fetch(`${base}/api/lobby`)).json()) as LobbyView
    expect(view.rooms.map((room) => [room.id, room.blue.connected])).toEqual([[opened.roomId, false]])

    const back = await seated(base, { kind: 'resume', roomId: opened.roomId, seatKey: opened.seatKey! })
    expect([back.roomId, back.seatKey]).toEqual([opened.roomId, opened.seatKey])

    back.socket.close()
    await second.stop()
    await persistence.close()
  })

  test('the status document says which build is running', async () => {
    const persistence = await openPersistence()
    const server = await startGameServer({
      persistence,
      port: 0,
      party: LOCAL_RELYING_PARTY,
      log: () => {},
    })

    const status = (await (await fetch(server.url)).json()) as Record<string, unknown>
    expect(status.referee).toBe('tictac')
    expect(status.rooms).toBe(0)
    expect(status.recent).toEqual([])

    await server.stop()
    await persistence.close()
  })
})
