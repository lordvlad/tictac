/**
 * Host a refereed match.
 *
 * Usage:
 *   bun scripts/serve-match.ts
 *   bun scripts/serve-match.ts --port=5174 --store=matches.sqlite
 *
 * One process, one `Bun.serve` with a `websocket` handler, and no rules in this
 * file: everything it knows about the game it knows through `Referee`, which
 * knows it through `MatchHost`, which is the same systems a match uses.
 *
 * WebSocket rather than WebRTC on purpose. Bun has no WebRTC — the published
 * documentation does not mention it — and it is the wrong tool anyway: WebRTC
 * exists for NAT traversal between two clients that cannot address each other,
 * while a referee has a URL. It also means the signalling broker disappears
 * from a refereed match ([RFC-0001](../docs/design/rfc/0001-referee-and-transports.md) §6).
 *
 * Reachability is the honest cost. A page served over `https` may not open an
 * insecure socket, so a public referee needs a host and a certificate;
 * Chromium's loopback exception makes `ws://localhost` work from the deployed
 * site, which is enough for development and a match over a LAN.
 */
import type { JsonRpcFrame } from '../src/game/JsonRpc'
import { isJsonRpcFrame } from '../src/game/JsonRpc'
import type { Transport } from '../src/game/Transport'
import { MatchStore } from '../src/server/MatchStore'
import { Referee } from '../src/server/Referee'
import { BUILD_ID, PROTOCOL_VERSION } from '../src/version'

const arg = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=')[1]

const port = Number(arg('port') ?? 5174)
const storePath = arg('store') ?? ':memory:'

const store = new MatchStore(storePath)
const referee = new Referee({
  store,
  onVerdict: (verdict) => {
    console.warn(`[referee] verdict on ${verdict.matchId}: ${verdict.reason}`)
    for (const found of verdict.found) {
      console.warn(`  ${found.unit ?? ''} ${found.what}: referee ${found.mine}, client ${found.theirs}`)
    }
  },
})

/**
 * One socket, behind the transport port.
 *
 * Frames are JSON text on every transport, so what crosses this socket is
 * byte-identical to what crosses a data channel between two peers — which is
 * what lets one referee watch a match it is not part of.
 */
function socketTransport(ws: { send: (data: string) => void; close: () => void }): Transport & {
  deliver: (raw: string) => void
  closed: (reason: string) => void
} {
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
        console.warn('[referee] dropping a frame that is not JSON')
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
const sockets = new WeakMap<object, Socket>()

const server = Bun.serve({
  port,
  fetch(request, server) {
    if (server.upgrade(request)) return undefined
    // A referee answers one question over HTTP, and it is the one a client
    // needs before it commits to a match: are we running the same build?
    return Response.json({
      referee: 'tictac',
      protocol: PROTOCOL_VERSION,
      build: BUILD_ID,
      match: referee.openMatchId,
      recent: store.recent(5),
    })
  },
  websocket: {
    open(ws) {
      const transport = socketTransport(ws)
      sockets.set(ws, transport)
      referee.attach(transport)
      console.info('[referee] a client connected')
    },
    message(ws, message) {
      sockets.get(ws)?.deliver(typeof message === 'string' ? message : message.toString())
    },
    close(ws, code, reason) {
      sockets.get(ws)?.closed(reason || `the socket closed (code ${code})`)
    },
  },
})

console.info(`[referee] watching on ${server.url} — build ${BUILD_ID}, protocol ${PROTOCOL_VERSION}`)
console.info(`[referee] store: ${storePath}`)
