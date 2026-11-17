import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../../src/wire/JsonRpc'
import type { LatLng, PastWaypoint } from '../../src/core/Travel'
import { loopback } from '../../src/wire/Transport'
import { WALL_CLOCK, type ServerClock } from '../../src/server/Clock'
import type { OpenEncounter, OpenMeeting } from '../../src/server/EncounterPort'
import { LOCAL_RELYING_PARTY } from '../../src/server/AccountStore'
import type { Journeys } from '../../src/server/Journeys'
import type { Lobby } from '../../src/server/Lobby'
import { createMatchServer, type MatchServerPorts } from '../../src/server/MatchServer'
import type { Persistence } from '../../src/server/Persistence'
import { MY_VERSION } from '../../src/version'
import { softwareAuthenticator, type SoftwareAuthenticator } from './authenticator'

/**
 * The match server `createMatchServer` assembles, in-process — lobby, sessions, the travel schedule — with
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
   * this server's own lobby, which runs by the test's clock. Unset, squads never meet.
   */
  openMeeting?: OpenMeeting | 'lobby'
  /** The trial switch; on unless this says otherwise. */
  playerEncounters?: () => boolean
  /** The timers the lobby's grace periods and join windows run on; real ones unless a test turns them. */
  schedule?: ServerClock['schedule']
  /** What the test replaces of the lobby's own options. */
  lobby?: MatchServerPorts['lobby']
  /** A new trip's id; random unless a test needs to pick what its checkpoints roll. */
  mintTrip?: () => string
}

export async function rpcServer(
  persistence: Persistence,
  start = Date.UTC(2026, 9, 8, 9),
  options: RpcServerOptions = {},
): Promise<RpcServer> {
  let now = start
  const clock: ServerClock = { now: () => now, schedule: options.schedule ?? WALL_CLOCK.schedule }
  const armed: (number | null)[] = []
  const match = await createMatchServer({
    clock,
    accounts: persistence.accounts.accounts,
    region: persistence.region,
    // Not a timer: the test's `wake` is the alarm going off.
    alarm: { arm: (at) => void armed.push(at) },
    placeOf: () => null,
    party: LOCAL_RELYING_PARTY,
    playerEncounters: options.playerEncounters,
    log: () => {},
    lobby: options.lobby,
    journeys: {
      mintTrip: options.mintTrip,
      // Explicitly undefined unless the test gave one: nothing is rolled or met by default, as on a host with no lobby.
      openEncounter: options.openEncounter,
      ...(options.openMeeting === 'lobby' ? {} : { openMeeting: options.openMeeting }),
    },
  })
  const window = (place: LatLng | null = null): Window => {
    const [page, socket] = loopback()
    match.sessions.attach(socket, { place })
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
    lobby: match.lobby,
    journeys: match.journeys,
    armed,
    get now() {
      return now
    },
    set now(at: number) {
      now = at
    },
    wake: () => match.alarm(),
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
  await persistence.region.db.query`UPDATE squads SET waypoints = ${JSON.stringify([resting])} WHERE id = ${squad.id}`
  return { name, window, id, squadId: squad.id }
}
