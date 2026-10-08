import { isJsonRpcFrame, type JsonRpcFrame } from '../game/JsonRpc'
import type { Transport } from '../game/Transport'

/** A server-side socket's transport, and the two calls its host makes into it. */
export interface ServerSocket extends Transport {
  /** A text frame the socket received. */
  deliver(raw: string): void
  /** The socket closed, for `reason`. */
  closed(reason: string): void
}

/**
 * One socket, behind the transport port.
 *
 * Frames are JSON text on every transport, so what crosses this socket is
 * byte-identical to what crosses a data channel between two peers. Split out
 * of `GameServer.ts` rather than merely exported from it: that file also
 * defines `startGameServer`, which calls `Bun.serve` directly, and importing
 * anything from a file that references the `Bun` global pulls that reference
 * into whichever TypeScript project imports it — `workers/MatchDurableObject.ts`
 * (`[ITEM-045]`) attaches the same `Sessions` to a Cloudflare `WebSocket`
 * instead of a `Bun.serve` one, and needs this function without `Bun.serve`'s
 * types along for the ride.
 */
export function socketTransport(
  ws: { send: (data: string) => void; close: () => void },
  log: (message: string) => void,
): ServerSocket {
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
