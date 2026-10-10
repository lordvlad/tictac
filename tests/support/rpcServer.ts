import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../../src/game/JsonRpc'
import type { LatLng, PastWaypoint } from '../../src/core/Travel'
import { loopback } from '../../src/game/Transport'
import type { OpenEncounter, OpenMeeting } from '../../src/server/EncounterPort'
import { Journeys } from '../../src/server/Journeys'
import { Lobby, type LobbyOptions } from '../../src/server/Lobby'
import type { Persistence } from '../../src/server/Persistence'
import { Schedule } from '../../src/server/Schedule'
import { Sessions } from '../../src/server/Session'
import { MY_VERSION } from '../../src/version'
import { softwareAuthenticator, type SoftwareAuthenticator } from './authenticator'

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

export interface RpcServerOptions {
  /** What finds a squad on the road opens here; unset, nothing is rolled for (`ITEM-048`). */
  openEncounter?: OpenEncounter
  /**
   * What two squads meeting opens here (`ITEM-053`): a fake, or `'lobby'` for
   * this server's own lobby, which then keeps rosters and runs by the test's
   * clock. Unset, squads never meet.
   */
  openMeeting?: OpenMeeting | 'lobby'
  /** The trial switch; on unless this says otherwise. */
  playerEncounters?: () => boolean
  /** More of the lobby's own options, over the clock and rosters `openMeeting: 'lobby'` gives it. */
  lobby?: Partial<LobbyOptions>
  /** A new trip's id; random unless a test needs to pick what its checkpoints roll. */
  mintTrip?: () => string
}

export function rpcServer(
  persistence: Persistence,
  start = Date.UTC(2026, 9, 8, 9),
  options: RpcServerOptions = {},
): RpcServer {
  let now = start
  const lobby = new Lobby({
    matches: persistence.matches,
    rooms: persistence.rooms,
    log: () => {},
    ...(options.openMeeting === 'lobby' ? { rosters: persistence.rosters, now: () => now } : {}),
    ...options.lobby,
  })
  const armed: (number | null)[] = []
  const schedule = new Schedule({ now: () => now, arm: (at) => armed.push(at) })
  const journeys = new Journeys({
    squads: persistence.squads,
    encounters: persistence.encounters,
    schedule,
    now: () => now,
    openEncounter: options.openEncounter,
    openMeeting: options.openMeeting === 'lobby' ? (meeting) => lobby.openMeeting(meeting) : options.openMeeting,
    playerEncounters: options.playerEncounters,
    mintTrip: options.mintTrip,
    tell: (playerId, squad) => lobby.tell(playerId, 'tictac/api/squad/changed', { squad }),
  })
  const sessions = new Sessions({ lobby, persistence, journeys, now: () => now, log: () => {} })

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

/**
 * A registered player, signed in on a new window, whose squad rests at `at`.
 * Registration places a squad at random; a test that sends two squads at each
 * other has to know where they are, so the row is rewritten.
 */
export async function registerAt(
  server: RpcServer,
  persistence: Persistence,
  name: string,
  at: LatLng,
): Promise<{ name: string; window: Window; id: string; squadId: string }> {
  const window = server.window()
  await register(window, await softwareAuthenticator(), name)
  const id = ((await window.call('tictac/api/account/me')).result.player as { id: string }).id
  const squad = (await window.call('tictac/api/squad/get')).result.squad as { id: string }
  const resting: PastWaypoint = { kind: 'past', ...at, arrival: server.now, departed: null }
  await persistence.db.query`UPDATE squads SET waypoints = ${JSON.stringify([resting])} WHERE id = ${squad.id}`
  return { name, window, id, squadId: squad.id }
}
