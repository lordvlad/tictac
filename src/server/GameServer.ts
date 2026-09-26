import { isJsonRpcFrame, type JsonRpcFrame } from '../game/JsonRpc'
import type { Transport } from '../game/Transport'
import { BUILD_ID, PROTOCOL_VERSION } from '../version'
import { apiHandler } from './Api'
import type { Persistence, RelyingParty } from './Persistence'
import { Referee } from './Referee'

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

/**
 * One socket, behind the transport port.
 *
 * Frames are JSON text on every transport, so what crosses this socket is
 * byte-identical to what crosses a data channel between two peers.
 */
function socketTransport(
  ws: { send: (data: string) => void; close: () => void },
  log: (message: string) => void,
): Transport & { deliver: (raw: string) => void; closed: (reason: string) => void } {
  const frames: ((frame: JsonRpcFrame) => void)[] = []
  const closers: ((reason: string) => void)[] = []
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    onFrame: (handler) => frames.push(handler),
    onClosed: (handler) => closers.push(handler),
    close: () => ws.close(),
    deliver: (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Dropped rather than fatal: closing on junk would let anything that
        // can reach the socket end somebody's match.
        log('dropping a frame that is not JSON')
        return
      }
      if (!isJsonRpcFrame(parsed)) return
      for (const handler of frames) handler(parsed)
    },
    closed: (reason) => {
      for (const handler of closers) handler(reason)
    },
  }
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
