import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import type { JsonRpcFrame, JsonRpcRequest } from '../src/game/JsonRpc'
import { RpcMethods } from '../src/game/JsonRpc'
import type { LobbyView, Seated } from '../src/game/Lobby'
import { RPC_ERRORS, SESSION_REPLACED } from '../src/game/Rpc'
import {
  heldTokens,
  NO_ANSWER,
  REQUEST_TIMEOUT_MS,
  RpcError,
  ServerConnection,
  UNREACHABLE,
  type TokenStore,
} from '../src/game/ServerConnection'
import { handClock, handServer, type HandClock, type HandServer, type HandSocket } from './support/handServer'

/**
 * A window's one socket to its server (`src/game/ServerConnection.ts`), met
 * by a server the test answers by hand: what is asked and in what order,
 * what an answer settles, and what a drop, a refusal or a newer window does
 * to it.
 */

const ROOM = 'r00m'
const SEAT: Seated = { roomId: ROOM, faction: Faction.Blue, phase: 'playing', redirected: false, seatKey: 'k3y' }
const EMPTY: LobbyView = { rooms: [], you: null }
const PLAYER = { id: 'ada', name: 'Ada' }

const push = (method: string, params: Record<string, unknown>): JsonRpcFrame => ({ jsonrpc: '2.0', method, params })

/** A server that answers every request the way a healthy one does, with `overrides` by method. */
function answering(overrides: Record<string, (socket: HandSocket, request: JsonRpcRequest) => void> = {}) {
  return (socket: HandSocket, request: JsonRpcRequest) => {
    const id = request.id as number
    const override = overrides[request.method]
    if (override) override(socket, request)
    else if (request.method === 'tictac/api/account/signIn') socket.reply(id, { player: PLAYER })
    else if (request.method === 'tictac/api/lobby/subscribe') socket.reply(id, EMPTY)
    else if (request.method === 'tictac/api/room/enter') socket.reply(id, SEAT)
    else socket.reply(id, null)
  }
}

/** A window dialling a server that answers as `answering(overrides)` does, from its very first word. */
function setup(
  tokens: TokenStore = heldTokens(),
  overrides: Parameters<typeof answering>[0] = {},
): { clock: HandClock; server: HandServer; connection: ServerConnection } {
  const clock = handClock()
  const server = handServer(clock)
  server.answer = answering(overrides)
  const connection = new ServerConnection('ws://tictac.test/', { connect: server.connect, schedule: clock.schedule, tokens })
  return { clock, server, connection }
}

/** A room member that only remembers where it was put, as `NetworkManager` does. */
function member() {
  const seats: Seated[] = []
  const drops: number[] = []
  return {
    seats,
    drops,
    rejoin: () => ({ kind: 'resume' as const, roomId: ROOM, seatKey: 'k3y' }),
    seated: (seat: Seated) => seats.push(seat),
    dropped: (attempt: number) => drops.push(attempt),
  }
}

describe('Requests', () => {
  test('each answer settles the request it belongs to, in whatever order they come', async () => {
    const { clock, server, connection } = setup()
    const held: JsonRpcRequest[] = []
    server.answer = (_socket, request) => held.push(request)
    const first = connection.request('tictac/api/account/me', {})
    const second = connection.request('tictac/api/roster/list', {})
    await clock.advance(0)
    expect(held.map((request) => request.method)).toEqual(['tictac/api/account/me', 'tictac/api/roster/list'])

    server.last.reply(held[1]!.id as number, { roster: [] })
    server.last.reply(held[0]!.id as number, { player: PLAYER })
    expect(await second).toEqual({ roster: [] })
    expect(await first).toEqual({ player: PLAYER })
  })

  test('a refusal is the server’s words and code, and the socket stays open', async () => {
    const { server, connection } = setup(heldTokens(), {
      'tictac/api/roster/recruit': (socket, request) =>
        socket.refuse(request.id as number, RPC_ERRORS.badInput, 'Your roster is already full.'),
    })
    const error = await connection.request('tictac/api/roster/recruit', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect([(error as RpcError).code, (error as RpcError).message]).toEqual([RPC_ERRORS.badInput, 'Your roster is already full.'])
    expect(connection.state).toEqual({ kind: 'open' })
    expect(server.sockets).toHaveLength(1)
  })

  test('a request nobody answers is given up on, not waited on forever', async () => {
    const { clock, server, connection } = setup()
    server.answer = null
    // Caught as it settles: `expect(…).rejects` would wait for it right here,
    // on a clock nothing is turning.
    const asked = connection.request('tictac/api/account/me', {}).catch((error: Error) => error.message)
    await clock.advance(REQUEST_TIMEOUT_MS)
    expect(await asked).toBe(NO_ANSWER)
  })

  test('a server that never opens is unreachable, and is not dialled again', async () => {
    const clock = handClock()
    const server = handServer(clock)
    server.down = true
    const connection = new ServerConnection('ws://tictac.test/', { connect: server.connect, schedule: clock.schedule, tokens: heldTokens() })
    await expect(connection.request('tictac/api/account/me', {})).rejects.toThrow(UNREACHABLE)
    await clock.advance(60_000)
    expect(server.sockets).toHaveLength(1)
  })
})

describe('The lobby', () => {
  test('is pushed to every listener, and the subscription ends with the last of them', async () => {
    const { clock, server, connection } = setup()
    const heard: LobbyView[] = []
    const stop = connection.watchLobby((view) => heard.push(view))
    await clock.advance(0)
    expect(heard).toEqual([EMPTY])

    const opened: LobbyView = {
      rooms: [{ id: ROOM, phase: 'waiting', blue: { name: 'Ada', connected: true }, red: null, spectators: 0, build: 'dev' }],
      you: null,
    } as unknown as LobbyView
    server.last.send(push('tictac/api/lobby/changed', opened as unknown as Record<string, unknown>))
    expect(heard).toEqual([EMPTY, opened])

    stop()
    expect(server.last.methods.at(-1)).toBe('tictac/api/lobby/unsubscribe')
    server.last.send(push('tictac/api/lobby/changed', EMPTY as unknown as Record<string, unknown>))
    expect(heard).toHaveLength(2)
  })
})

describe('Getting back after a drop', () => {
  test('says who it is, then subscribes, then takes its seat back — in that order, on the new socket', async () => {
    const { clock, server, connection } = setup(heldTokens('t0ken'))
    connection.watchLobby(() => {})
    const seated = member()
    connection.enter({ kind: 'open' }, seated)
    await clock.advance(0)
    expect(server.last.methods).toEqual([
      RpcMethods.hello,
      'tictac/api/account/signIn',
      'tictac/api/lobby/subscribe',
      'tictac/api/room/enter',
    ])

    server.last.drop()
    expect(seated.drops).toEqual([1])
    await clock.advance(250)
    expect(server.sockets).toHaveLength(2)
    expect(server.last.methods).toEqual([
      RpcMethods.hello,
      'tictac/api/account/signIn',
      'tictac/api/lobby/subscribe',
      'tictac/api/room/enter',
    ])
    const back = server.last.heard.at(-1) as JsonRpcRequest
    expect(back.params).toEqual({ intent: { kind: 'resume', roomId: ROOM, seatKey: 'k3y' } })
    expect(seated.seats).toEqual([SEAT, SEAT])
    expect(connection.player).toEqual(PLAYER)
    expect(connection.state).toEqual({ kind: 'open' })
  })

  test('a token the server no longer honours is forgotten; one refused for another reason is kept, with the reason', async () => {
    const forgotten = heldTokens('old')
    const a = setup(forgotten, {
      'tictac/api/account/signIn': (socket, request) =>
        socket.refuse(request.id as number, RPC_ERRORS.signInFirst, 'that sign-in has expired; sign in again'),
    })
    await a.connection.request('tictac/api/account/me', {})
    expect([forgotten.get(), a.connection.player, a.connection.signInRefused]).toEqual([null, null, null])

    const kept = heldTokens('mine')
    const b = setup(kept, {
      'tictac/api/account/signIn': (socket, request) =>
        socket.refuse(request.id as number, RPC_ERRORS.conflict, 'Your match is on another build.'),
    })
    await b.connection.request('tictac/api/account/me', {})
    expect([kept.get(), b.connection.player, b.connection.signInRefused]).toEqual([
      'mine',
      null,
      'Your match is on another build.',
    ])
  })

  test('a window replaced by a newer one of its player stops, and does not come back', async () => {
    const { clock, server, connection } = setup()
    const seated = member()
    const room = connection.enter({ kind: 'open' }, seated)
    const lost: string[] = []
    room.onClosed((reason) => lost.push(reason))
    await clock.advance(0)

    server.last.send(push('tictac/api/session/replaced', { reason: SESSION_REPLACED }))
    expect(connection.state).toEqual({ kind: 'closed', reason: SESSION_REPLACED })
    expect(lost).toEqual([SESSION_REPLACED])
    await clock.advance(60_000)
    expect(server.sockets).toHaveLength(1)
    expect(seated.drops).toEqual([])
  })
})

describe('The server\'s clock', () => {
  test('is measured over the socket, and the window tells time by it rather than by its own', async () => {
    // This machine's clock is five minutes behind the server's. Every round
    // trip takes 80 ms but one, which takes 4: that is the one to trust.
    const clock = handClock()
    const server = handServer(clock)
    server.answer = answering()
    const SERVER_AHEAD = 5 * 60_000
    let local = 1_000_000
    let trips = 0
    server.tellTime = (socket, request) => {
      const delay = trips++ === 1 ? 2 : 40
      local += delay
      const serverNow = local + SERVER_AHEAD
      local += delay
      socket.reply(request.id as number, { now: serverNow })
    }
    const connection = new ServerConnection('ws://tictac.test/', {
      connect: server.connect,
      schedule: clock.schedule,
      tokens: heldTokens(),
      clock: () => local,
    })
    await clock.advance(0)

    expect(trips).toBe(3)
    expect(connection.now() - local).toBe(SERVER_AHEAD)
  })

  test('a server that cannot say leaves the window on its own clock', async () => {
    const { clock, server, connection } = setup()
    server.tellTime = (socket, request) =>
      socket.refuse(request.id as number, RPC_ERRORS.noSuchMethod, 'The match server does not answer that.')
    await clock.advance(0)
    expect(Math.abs(connection.now() - Date.now())).toBeLessThan(1000)
  })
})

