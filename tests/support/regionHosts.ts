import type { LatLng, PastWaypoint } from '../../src/core/Travel'
import type { ServerClock } from '../../src/server/Clock'
import { openDb, openPersistence } from '../../src/server/db/BunSqlDb'
import { createMatchServer, type MatchServer } from '../../src/server/MatchServer'
import type { RegionPartition } from '../../src/server/Owner'
import type { Persistence } from '../../src/server/Persistence'
import { type RegionStore, regionStoreOverDb } from '../../src/server/RegionStore'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../../src/wire/JsonRpc'
import { loopback } from '../../src/wire/Transport'
import { MY_VERSION } from '../../src/version'
import { softwareAuthenticator } from './authenticator'
import { inProcessPeers, type PeerRegistry } from './peers'
import { register, type Answer, type Window } from './rpcServer'

/**
 * Two regions side by side in one process, as the Durable Objects are two
 * objects of one Worker: each its own `createMatchServer` over a database of
 * its own, one directory's accounts behind both, the same hand-turned clock,
 * and each reaching the other through `peers`. Windows speak raw JSON-RPC to
 * either over loopback, and the alarm is the test's: `at` sets the time and
 * wakes both.
 */

export const WEST = 'region-west'
export const EAST = 'region-east'

export const PARTITIONS: RegionPartition[] = [
  { id: 'west', durableObjectName: WEST, bounds: { minLat: 45, maxLat: 55, minLng: 5, maxLng: 10 } },
  { id: 'east', durableObjectName: EAST, bounds: { minLat: 45, maxLat: 55, minLng: 10.001, maxLng: 20 } },
]

export interface RegionHost {
  match: MatchServer
  region: RegionStore
  /** Every moment this host's schedule armed its alarm for, in order; null for disarmed. */
  armed: (number | null)[]
  /** This host's alarm going off at the hosts' time. */
  wake(): Promise<void>
  /** A page's socket to this host, past the version gate. */
  window(): Window
  /** The address a window is offered for this host. */
  url: string
  /** The server stopped and started again over the same database, as a deploy or a crash does: nothing but what it wrote down survives. */
  restart(): Promise<void>
}

export interface RegionHosts {
  west: RegionHost
  east: RegionHost
  peers: PeerRegistry
  persistence: Persistence
  /** What both hosts' clock reads. */
  now: number
  /** Turn the clock to `time`, running the timers that fall due on the way, and wake every host, west first. */
  at(time: number): Promise<void>
  stop(): Promise<void>
}

/** Every promise continuation queued so far, run: `setImmediate` comes after the whole microtask queue. */
function settled(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setImmediate(resolve)
  return promise
}

export async function regionHosts(start = Date.UTC(2026, 9, 8, 9)): Promise<RegionHosts> {
  let now = start
  const timers: { due: number; fn: () => void; live: boolean }[] = []
  const clock: ServerClock = {
    now: () => now,
    schedule(fn, ms) {
      const timer = { due: now + ms, fn, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
  }
  const persistence = await openPersistence(clock, ':memory:', { self: WEST })
  const { accounts, party } = persistence.accounts
  const eastRegion = await regionStoreOverDb(await openDb(':memory:'), clock, accounts, EAST)
  const peers = inProcessPeers()

  const host = async (region: RegionStore, url: string): Promise<RegionHost> => {
    const armed: (number | null)[] = []
    const open = () =>
      createMatchServer({
        clock,
        accounts,
        region,
        alarm: { arm: (at) => void armed.push(at) },
        placeOf: () => null,
        party,
        regions: PARTITIONS,
        peers,
        log: () => {},
        // Nothing is rolled for on the road: a squad's trip here is only its crossing.
        journeys: { openEncounter: undefined, openMeeting: undefined },
      })
    const started: RegionHost = {
      match: await open(),
      region,
      armed,
      url,
      wake: () => started.match.alarm(),
      window: () => window(started.match),
      async restart() {
        // The database is the host's, and outlives the server: what the new one finds there is all it has.
        await started.match.dispose()
        started.match = await open()
        peers.add(region.self, { crossings: started.match.crossings, url })
      },
    }
    peers.add(region.self, { crossings: started.match.crossings, url })
    return started
  }
  const west = await host(persistence.region, 'ws://west.test/')
  const east = await host(eastRegion, 'ws://east.test/')
  return {
    west,
    east,
    peers,
    persistence,
    get now() {
      return now
    },
    async at(time) {
      // The timers the hosts keep (a seat's grace) go off at their moments, in order, on the way.
      for (;;) {
        const next = timers.filter((timer) => timer.live && timer.due <= time).sort((a, b) => a.due - b.due)[0]
        if (!next) break
        next.live = false
        now = Math.max(now, next.due)
        next.fn()
        await settled()
      }
      now = time
      await west.wake()
      await east.wake()
      // What a handler sets going without waiting for it (telling the target to drop a copy) has landed.
      await settled()
    },
    async stop() {
      await west.match.dispose()
      await east.match.dispose()
      await eastRegion.close()
      await persistence.close()
    },
  }
}

/** A page's socket to `match`: raw JSON-RPC over loopback, with every push kept. */
function window(match: MatchServer): Window {
  const [page, socket] = loopback()
  match.sessions.attach(socket, { place: null })
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

/** A player registered at `host`, signed in on a window there, whose squad rests at `at`. */
export interface Enlisted {
  name: string
  window: Window
  token: string
  id: string
  squadId: string
}

export async function enlistAt(hosts: RegionHosts, host: RegionHost, name: string, at: LatLng): Promise<Enlisted> {
  const page = host.window()
  const token = await register(page, await softwareAuthenticator(), name)
  const id = ((await page.call('tictac/api/account/me')).result.player as { id: string }).id
  const squad = (await page.call('tictac/api/squad/get')).result.squad as { id: string }
  const resting: PastWaypoint = { kind: 'past', ...at, arrival: hosts.now, departed: null }
  await host.region.db.query`UPDATE squads SET waypoints = ${JSON.stringify([resting])} WHERE id = ${squad.id}`
  return { name, window: page, token, id, squadId: squad.id }
}

/** A second window of an enlisted player, on `host`, signed in with their token: what the client's second socket is. */
export async function signedInAt(host: RegionHost, who: Pick<Enlisted, 'token'>): Promise<Window> {
  const page = host.window()
  const answer = await page.call('tictac/api/account/signIn', { token: who.token })
  if (answer.code !== null) throw new Error(`signIn refused: ${answer.message}`)
  return page
}

/** The pushes of `method` a window was sent, in order. */
export function pushed<T>(page: Window, method: string): T[] {
  return page.pushes.filter((push) => push.method === method).map((push) => push.params as T)
}
