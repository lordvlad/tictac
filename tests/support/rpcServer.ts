import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../../src/game/JsonRpc'
import type { LatLng } from '../../src/core/Travel'
import { loopback } from '../../src/game/Transport'
import { Journeys } from '../../src/server/Journeys'
import { Lobby } from '../../src/server/Lobby'
import type { Persistence } from '../../src/server/Persistence'
import { Schedule } from '../../src/server/Schedule'
import { Sessions } from '../../src/server/Session'
import { MY_VERSION } from '../../src/version'
import type { SoftwareAuthenticator } from './authenticator'

/**
 * A match server in-process — lobby, sessions, the travel schedule — with
 * windows that speak raw JSON-RPC to it over loopback sockets, and a clock the
 * test turns by hand.
 *
 * The alarm is not a timer: `armed` records every moment the schedule asked
 * to be woken at, and `wake()` is the alarm going off at whatever `now` the
 * test has set — on time, or late, which is the point.
 */

export interface Answer {
  /** The error code (`RPC_ERRORS`), or null for a result. */
  code: number | null
  result: Record<string, unknown>
  message: string | null
}

export interface Window {
  call(method: string, params?: Record<string, unknown>): Promise<Answer>
  /** Every notification the server pushed to this socket, in order. */
  pushes: JsonRpcNotification[]
}

export interface RpcServer {
  lobby: Lobby
  journeys: Journeys
  /** Every moment the schedule armed the alarm for, in order; null for disarmed. */
  armed: (number | null)[]
  /** What the clock reads. */
  now: number
  /** The alarm going off at `now`. */
  wake(): Promise<void>
  /** A page's socket, past the version gate, connected from `place` when its host can tell. */
  window(place?: LatLng | null): Window
}

export function rpcServer(persistence: Persistence, start = Date.UTC(2026, 9, 8, 9)): RpcServer {
  let now = start
  const lobby = new Lobby({ matches: persistence.matches, rooms: persistence.rooms, log: () => {} })
  const armed: (number | null)[] = []
  const schedule = new Schedule({ now: () => now, arm: (at) => armed.push(at) })
  const journeys = new Journeys({
    squads: persistence.squads,
    schedule,
    now: () => now,
    tell: (playerId, squad) => lobby.tell(playerId, 'tictac/api/squad/changed', { squad }),
  })
  const sessions = new Sessions({ lobby, persistence, journeys, log: () => {} })

  const window = (place: LatLng | null = null): Window => {
    const [page, socket] = loopback()
    sessions.attach(socket, { url: 'ws://rpc.test/', place })
    const pending = new Map<number, (answer: Answer) => void>()
    const pushes: JsonRpcNotification[] = []
    let lastId = 0
    page.onFrame((frame) => {
      if ('method' in frame) {
        pushes.push(frame as JsonRpcNotification)
        return
      }
      if (typeof frame.id !== 'number') return
      const settle = pending.get(frame.id)
      pending.delete(frame.id)
      if ('error' in frame) settle?.({ code: frame.error.code, result: {}, message: frame.error.message })
      else settle?.({ code: null, result: (frame.result ?? {}) as Record<string, unknown>, message: null })
    })
    page.send({ jsonrpc: '2.0', method: RpcMethods.hello, params: { ...MY_VERSION } } as JsonRpcFrame)
    return {
      pushes,
      call: (method, params = {}) => {
        const { promise, resolve } = Promise.withResolvers<Answer>()
        const id = ++lastId
        pending.set(id, resolve)
        page.send({ jsonrpc: '2.0', id, method, params })
        return promise
      },
    }
  }

  return {
    lobby,
    journeys,
    armed,
    get now() {
      return now
    },
    set now(at: number) {
      now = at
    },
    wake: () => schedule.fire(),
    window,
  }
}

/** Register `name`, all the way through, on `window`, and hand back the session token. */
export async function register(window: Window, key: SoftwareAuthenticator, name = 'Tester'): Promise<string> {
  const options = await window.call('tictac/api/account/registerOptions', { name })
  if (options.code !== null) throw new Error(`registerOptions refused: ${options.message}`)
  const publicKey = options.result.publicKey as { challenge: string }
  const created = await key.create({ challengeId: options.result.challengeId as string, challenge: publicKey.challenge })
  const verified = await window.call('tictac/api/account/registerVerify', { ...created })
  if (verified.code !== null) throw new Error(`registerVerify refused: ${verified.message}`)
  return verified.result.token as string
}
