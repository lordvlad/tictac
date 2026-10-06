import { parseIntent, type ServerIntent } from '../game/Lobby'
import { BUILD_ID, PROTOCOL_VERSION } from '../version'
import type { Player } from './Accounts'
import { apiHandler } from './Api'
import { Lobby } from './Lobby'
import type { Persistence, RelyingParty } from './Persistence'
import { socketTransport } from './SocketTransport'

/**
 * The match server: one lobby of refereed rooms, one database, one port.
 *
 * Everything the game does travels over the WebSocket as JSON-RPC
 * notifications, byte-identical to what two peers send each other — which is
 * what lets a referee watch a match it is not part of. What HTTP adds is the
 * part a socket cannot do: the passkey ceremonies, the roster, the room list,
 * and the ticket that says which account a socket belongs to.
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
  party: RelyingParty
  log?: (message: string) => void
  /** How long a dropped signed-in seat is held; the lobby's default unless a test says otherwise. */
  graceMs?: number
}

type Socket = ReturnType<typeof socketTransport>

export async function startGameServer(options: GameServerOptions): Promise<GameServer> {
  const { persistence, party } = options
  const log = options.log ?? ((message: string) => console.info(`[referee] ${message}`))
  const lobby = new Lobby({
    matches: persistence.matches,
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

  const api = apiHandler(persistence, lobby, party, log)
  const sockets = new WeakMap<object, Socket>()

  const server = Bun.serve<{ player: Player | null; intent: ServerIntent | null }, never>({
    port: options.port,
    async fetch(request, server) {
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        // A ticket is how an account reaches a socket: a browser cannot put an
        // `Authorization` header on a WebSocket, and a session token in a url
        // is a session token in somebody's logs.
        const params = new URL(request.url).searchParams
        const ticket = params.get('ticket')
        const player = ticket ? persistence.accounts.redeemTicket(ticket) : null
        if (ticket && !player) {
          return Response.json(
            { error: 'that sign-in ticket is not valid; sign in again' },
            { status: 401 },
          )
        }
        // An intent the url states badly is not refused here: the lobby says
        // so in-band, after the version gate, where the page can show it.
        if (server.upgrade(request, { data: { player, intent: parseIntent(params) } })) return undefined
        return new Response('expected a websocket upgrade', { status: 400 })
      }

      const answered = await api(request)
      if (answered) return answered

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
        lobby.attach(transport, ws.data.player, ws.data.intent)
        log(`a client connected${ws.data.player ? ` as ${ws.data.player.name}` : ''}`)
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
    /** Stops serving. The database is the caller's: it opened it, it closes it. */
    stop: async () => {
      lobby.dispose()
      await server.stop(true)
    },
  }
}
