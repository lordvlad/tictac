import { BUILD_ID, PROTOCOL_VERSION } from '../version'
import { apiHandler } from './Api'
import type { Persistence, RelyingParty } from './Persistence'
import { Referee } from './Referee'
import { socketTransport } from './SocketTransport'

/**
 * The match server: one referee, one database, one port.
 *
 * Everything the game does travels over the WebSocket as JSON-RPC
 * notifications, byte-identical to what two peers send each other — which is
 * what lets one referee watch a match it is not part of. What HTTP adds is the
 * part a socket cannot do: the passkey ceremonies, the roster, and the ticket
 * that says which account a socket belongs to.
 *
 * WebSocket rather than WebRTC on purpose. Bun has no WebRTC, and it is the
 * wrong tool anyway: WebRTC exists for NAT traversal between two clients that
 * cannot address each other, while a referee has a URL. It also means the
 * signalling broker disappears from a refereed match
 * ([RFC-0001](../../docs/design/rfc/0001-referee-and-transports.md) §6).
 */

export interface GameServer {
  url: string
  referee: Referee
  stop(): Promise<void>
}

export interface GameServerOptions {
  persistence: Persistence
  port: number
  party: RelyingParty
  log?: (message: string) => void
}

type Socket = ReturnType<typeof socketTransport>

export async function startGameServer(options: GameServerOptions): Promise<GameServer> {
  const { persistence, party } = options
  const log = options.log ?? ((message: string) => console.info(`[referee] ${message}`))
  const referee = new Referee({
    matches: persistence.matches,
    rosters: persistence.rosters,
    log,
    onVerdict: (verdict) => {
      log(`verdict on ${verdict.matchId}: ${verdict.reason}`)
      for (const found of verdict.found) {
        log(`  ${found.unit ?? ''} ${found.what}: referee ${found.mine}, client ${found.theirs}`)
      }
    },
  })

  const api = apiHandler(persistence, party, log)
  const sockets = new WeakMap<object, Socket>()

  const server = Bun.serve<{ playerId: string | null }, never>({
    port: options.port,
    async fetch(request, server) {
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        // A ticket is how an account reaches a socket: a browser cannot put an
        // `Authorization` header on a WebSocket, and a session token in a url
        // is a session token in somebody's logs.
        const ticket = new URL(request.url).searchParams.get('ticket')
        const playerId = ticket ? persistence.accounts.redeemTicket(ticket) : null
        if (ticket && !playerId) {
          return Response.json(
            { error: 'that sign-in ticket is not valid; sign in again' },
            { status: 401 },
          )
        }
        if (server.upgrade(request, { data: { playerId } })) return undefined
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
        match: referee.openMatchId,
        recent: await persistence.matches.recent(5),
      })
    },
    websocket: {
      open(ws) {
        const transport = socketTransport(ws, log)
        sockets.set(ws, transport)
        referee.attach(transport, ws.data.playerId)
        log(`a client connected${ws.data.playerId ? ' signed in' : ''}`)
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
    referee,
    /** Stops serving. The database is the caller's: it opened it, it closes it. */
    stop: async () => {
      referee.dispose()
      await server.stop(true)
    },
  }
}
