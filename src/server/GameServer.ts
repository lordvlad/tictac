import type { LatLng } from '../core/Travel'
import type { AccountsPort } from './AccountsPort'
import type { RelyingParty } from './AccountStore'
import type { ServerClock } from './Clock'
import type { Journeys } from './Journeys'
import type { Lobby } from './Lobby'
import { createMatchServer, type AlarmPort } from './MatchServer'
import type { RegionStore } from './RegionStore'
import type { RegionDirectory, RegionPartition } from './Owner'
import type { Sessions } from './Session'
import { socketTransport, type ServerSocket } from './SocketTransport'
import type { TileHandler } from './Tiles'

/**
 * The match server on Bun: one lobby of refereed rooms, one port.
 *
 * Everything the server is lives in `createMatchServer` (`MatchServer.ts`),
 * which the Durable Object calls too; this file is what Bun adds — `Bun.serve`
 * for the sockets and the HTTP, a timer for the alarm, and the two stores
 * opened in this process.
 *
 * A window holds one WebSocket to it and asks everything over that, as
 * JSON-RPC (`Session.ts`): signing in, the roster, the lobby, taking a seat.
 * The match itself travels over the same socket as notifications,
 * byte-identical to what two peers send each other — which is what lets a
 * referee watch a match it is not part of. HTTP is left with what is static:
 * a status document (`/status`), the map's tiles, and the passkeys' related
 * origins.
 *
 * WebSocket rather than WebRTC on purpose. Bun has no WebRTC, and it is the
 * wrong tool anyway: WebRTC exists for NAT traversal between two clients that
 * cannot address each other, while a referee has a URL. It also means the
 * signalling broker disappears from a refereed match
 * ([RFC-0001](../../docs/design/rfc/0001-referee-and-transports.md) §6).
 */

export interface GameServer {
  url: string
  lobby: Lobby
  journeys: Journeys
  directory: RegionDirectory
  sessions: Sessions
  stop(): Promise<void>
}

export interface GameServerOptions {
  /** Who a player is: the directory's accounts, in this process (`portsOf`) or asked of another one (`AccountsPort`). */
  accounts: AccountsPort
  /** This region's database. */
  region: RegionStore
  /** The passkeys' relying party, which the server also publishes the related origins of. */
  party: RelyingParty
  port: number
  log?: (message: string) => void
  /** How long a dropped seat is held; the lobby's default unless a test says otherwise. */
  graceMs?: number
  /** Map tiles at `/tiles/{z}/{x}/{y}.mvt` (`ITEM-061`); none when unset. */
  tiles?: TileHandler
  /**
   * The host's one clock, the same one the stores were opened with: squads
   * travel by it, handovers expire by it, sessions last by it.
   */
  clock: ServerClock
  /**
   * Whether squads of different players can meet (`ITEM-053`): the trial
   * switch, read at every check; on unless this says otherwise.
   */
  playerEncounters?: () => boolean
  /** The partition table this host routes places by; the deployed one (`REGIONS`) unless set. */
  regions?: readonly RegionPartition[]
  /**
   * Where the connection that opened a request came from. Cloudflare says so
   * on every request (`request.cf`); a Bun process behind no such proxy cannot,
   * so by default it does not know — which is what a deployment wants, since a
   * header a client could set would let it choose where its squad starts.
   * A test supplies one to run the placement path the Durable Object runs.
   */
  placeOf?: (request: Request) => LatLng | null
}

/** The Durable Object's one alarm, as a timer: the schedule asks for one moment at a time, and each new ask replaces the last. */
function timerAlarm(clock: ServerClock, log: (message: string) => void): AlarmPort {
  let cancel: (() => void) | null = null
  return {
    arm(at, fire) {
      cancel?.()
      cancel =
        at === null
          ? null
          : clock.schedule(() => {
              fire().catch((error: unknown) => log(`the travel schedule failed: ${String(error)}`))
            }, Math.max(0, at - clock.now()))
    },
  }
}

export async function startGameServer(options: GameServerOptions): Promise<GameServer> {
  const { clock } = options
  const log = options.log ?? ((message: string) => console.info(`[referee] ${message}`))
  const match = await createMatchServer({
    clock,
    accounts: options.accounts,
    region: options.region,
    alarm: timerAlarm(clock, log),
    placeOf: options.placeOf ?? (() => null),
    party: options.party,
    regions: options.regions,
    playerEncounters: options.playerEncounters,
    graceMs: options.graceMs,
    tiles: options.tiles,
    log,
  })

  const sockets = new WeakMap<object, ServerSocket>()
  const server = Bun.serve<{ request: Request }, never>({
    port: options.port,
    async fetch(request, server) {
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (server.upgrade(request, { data: { request } })) return undefined
        return new Response('expected a websocket upgrade', { status: 400 })
      }
      return (await match.http(request)) ?? new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        const transport = socketTransport(ws, log)
        sockets.set(ws, transport)
        match.accept(transport, ws.data.request)
      },
      message(ws, message) {
        sockets.get(ws)?.deliver(typeof message === 'string' ? message : message.toString())
      },
      close(ws, code, reason) {
        sockets.get(ws)?.closed(reason || `the socket closed (code ${code})`)
      },
    },
  })

  return {
    url: String(server.url),
    lobby: match.lobby,
    journeys: match.journeys,
    directory: match.directory,
    sessions: match.sessions,
    stop: async () => {
      await match.dispose()
      await server.stop(true)
    },
  }
}
