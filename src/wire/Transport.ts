import type { JsonRpcFrame } from './JsonRpc'

/**
 * Somewhere to send frames, and somewhere they arrive from.
 *
 * The whole conversation between two peers is already this narrow: one frame
 * out, one frame in, JSON-RPC 2.0 either way
 * ([ADR-0003](../../docs/design/adr/0003-p2p-jsonrpc-replication.md)). What the
 * port adds is that the *channel* stops being PeerJS specifically — which is
 * what lets a referee exist at all, since a `Bun.serve` process cannot hold a
 * WebRTC data channel and does not want to
 * ([RFC-0001](../../docs/design/rfc/0001-referee-and-transports.md) §6).
 *
 * Deliberately not created until there was a second implementation to justify
 * it: a port with one caller is an abstraction looking for a job.
 */
export interface Transport {
  send(frame: JsonRpcFrame): void
  onFrame(handler: (frame: JsonRpcFrame) => void): void
  onClosed(handler: (reason: string) => void): void
  close(): void
}

/**
 * A linked pair, in one process.
 *
 * For tests, and for the same reason the port exists: a two-peer conversation
 * is otherwise only observable by hand-building a fake channel, which is a
 * transport implementation living in a test file without being called one.
 *
 * Delivery is synchronous. A real channel is not, but a test that has to await
 * a round trip to observe an intent is a test about scheduling.
 */
export function loopback(): [Transport, Transport] {
  const handlers: [((frame: JsonRpcFrame) => void)[], ((frame: JsonRpcFrame) => void)[]] = [[], []]
  const closers: [((reason: string) => void)[], ((reason: string) => void)[]] = [[], []]
  const open = [true, true]

  const side = (me: 0 | 1): Transport => {
    const them = (1 - me) as 0 | 1
    return {
      send(frame) {
        if (!open[me] || !open[them]) return
        for (const handler of handlers[them]) handler(frame)
      },
      onFrame(handler) {
        handlers[me].push(handler)
      },
      onClosed(handler) {
        closers[me].push(handler)
      },
      close() {
        if (!open[me]) return
        open[me] = false
        for (const handler of closers[them]) handler('the other side closed the connection')
      },
    }
  }

  return [side(0), side(1)]
}
