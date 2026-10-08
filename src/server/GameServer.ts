import { BUILD_ID, PROTOCOL_VERSION } from '../version'
import { Lobby } from './Lobby'
import type { Persistence } from './Persistence'
import { Sessions } from './Session'
import { socketTransport, type ServerSocket } from './SocketTransport'
import type { TileHandler } from './Tiles'

/**
 * The match server: one lobby of refereed rooms, one database, one port.
 *
 * A window holds one WebSocket to it and asks everything over that, as
 * JSON-RPC (`Session.ts`): signing in, the roster, the lobby, taking a seat.
 * The match itself travels over the same socket as notifications,
 * byte-identical to what two peers send each other — which is what lets a
 * referee watch a match it is not part of. HTTP is left with what is static:
 * a status document, and the map's tiles.
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
  stop(): Promise<void>
}

export interface GameServerOptions {
  persistence: Persistence
  port: number
  log?: (message: string) => void
  /** How long a dropped seat is held; the lobby's default unless a test says otherwise. */
  graceMs?: number
  /** Map tiles at `/tiles/{z}/{x}/{y}.mvt` (`ITEM-061`); none when unset. */
  tiles?: TileHandler
}

export async function startGameServer(options: GameServerOptions): Promise<GameServer> {
  const { persistence } = options
  const log = options.log ?? ((message: string) => console.info(`[referee] ${message}`))
  const lobby = new Lobby({
    matches: persistence.matches,
    rooms: persistence.rooms,
    rosters: persistence.rosters,
    log,
    graceMs: options.graceMs,
    onVerdict: (verdict) => {
      log(`verdict on ${verdict.matchId}: ${verdict.reason}`)
      for (const found of verdict.found) {
        log(`  ${found.unit ?? ''} ${found.what}: referee ${found.mine}, client ${found.theirs}`)
      }
    },
  })
  // Before the port opens: a window reconnecting to its seat the moment this
  // server is up has to find the room already held for it.
  await lobby.restore()

  const sessions = new Sessions({ lobby, persistence, log })
  const sockets = new WeakMap<object, ServerSocket>()

  const server = Bun.serve<{ url: string }, never>({
    port: options.port,
    async fetch(request, server) {
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (server.upgrade(request, { data: { url: request.url } })) return undefined
        return new Response('expected a websocket upgrade', { status: 400 })
      }

      const tile = await options.tiles?.(request)
      if (tile) return tile

      // The one question a client needs answered before it commits to a match:
      // are we running the same build?
      return Response.json({
        referee: 'tictac',
        protocol: PROTOCOL_VERSION,
        build: BUILD_ID,
        rooms: lobby.view(null).rooms.length,
        recent: await persistence.matches.recent(5),
      })
    },
    websocket: {
      open(ws) {
        const transport = socketTransport(ws, log)
        sockets.set(ws, transport)
        sessions.attach(transport, { url: ws.data.url })
        log('a client connected')
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
    lobby,
    /** Stops serving. Rooms still live stay in the database for the next server to restore; the database is the caller's. */
    stop: async () => {
      await lobby.dispose()
      await server.stop(true)
    },
  }
}
