import { describe, expect, test } from 'bun:test'
import { startGameServer } from '../src/server/GameServer'
import { LOCAL_RELYING_PARTY, openPersistence } from '../src/server/Persistence'
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

/** Whether a socket got as far as open, rather than how long it took. */
function opens(socket: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    socket.addEventListener('open', () => resolve(true))
    socket.addEventListener('error', () => resolve(false))
  })
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
  test('a signed-in player trades a session for a socket', async () => {
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

    const socket = new WebSocket(`${base.replace('http', 'ws')}/?ticket=${ticket}`)
    expect(await opens(socket)).toBe(true)
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

    const socket = new WebSocket(server.url.replace('http', 'ws'))
    expect(await opens(socket)).toBe(true)
    socket.close()

    await server.stop()
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
    expect(status.match).toBeNull()
    expect(status.recent).toEqual([])

    await server.stop()
    await persistence.close()
  })
})
