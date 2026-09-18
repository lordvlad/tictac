import { isJsonRpcFrame, type JsonRpcFrame } from './JsonRpc'
import type { Transport } from './Transport'

/**
 * A `WebSocket` behind the frame port, for talking to a refereed match.
 *
 * A referee has a URL, which is the whole reason this exists: WebRTC solves NAT
 * traversal between two clients that cannot address each other, and Bun has no
 * WebRTC to solve it with
 * ([RFC-0001](../../docs/design/rfc/0001-referee-and-transports.md) §6).
 *
 * The codec is the same JSON text every transport uses — a socket needs a
 * string anyway, so uniformity costs nothing and means a frame that crossed a
 * test is byte-identical to one that crossed a network.
 */
export class SocketTransport implements Transport {
  private readonly frameHandlers: ((frame: JsonRpcFrame) => void)[] = []
  private readonly closeHandlers: ((reason: string) => void)[] = []
  /**
   * Frames written while the socket was still connecting.
   *
   * Queued rather than dropped, because the first thing a client says is its
   * version and the referee answers with the match: a lost `hello` is a
   * handshake that never completes, and there is nothing above this layer to
   * notice — an intent stream has no acknowledgements to time out.
   *
   * Unbounded, deliberately. The queue only exists between `new WebSocket` and
   * its first event, and a socket that never opens fires `close` instead, which
   * empties it.
   */
  private readonly waiting: string[] = []
  private live = true

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('open', () => {
      for (const text of this.waiting) socket.send(text)
      this.waiting.length = 0
    })
    socket.addEventListener('message', (event: MessageEvent) => this.receive(event.data))
    // `close` is the only exit, including for a connection that never opened: a
    // WebSocket `error` event states nothing about what went wrong by design,
    // and the close that follows it at least carries a code.
    socket.addEventListener('close', (event: CloseEvent) => {
      this.waiting.length = 0
      this.shut(
        event.reason.length > 0
          ? event.reason
          : event.wasClean
            ? 'The match server closed the connection.'
            : `The connection to the match server was lost (code ${event.code}).`,
      )
    })
  }

  send(frame: JsonRpcFrame): void {
    if (!this.live) return
    const text = JSON.stringify(frame)
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.waiting.push(text)
      return
    }
    // A socket that is closing or closed is not coming back: this transport
    // carries one match, and rebuilding a lost client is rejoining with a new
    // channel and the intent log, not retransmitting into a dead one.
    if (this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(text)
  }

  onFrame(handler: (frame: JsonRpcFrame) => void): void {
    this.frameHandlers.push(handler)
  }

  onClosed(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler)
  }

  close(): void {
    if (!this.live) return
    // Closing is this side's own decision, so no close handler fires: whatever
    // decided to close — a refusal, a finished match — has already said why.
    this.live = false
    this.waiting.length = 0
    this.socket.close(1000, 'match over')
  }

  private shut(reason: string): void {
    if (!this.live) return
    this.live = false
    console.warn(`[socket] ${reason}`)
    for (const handler of this.closeHandlers) handler(reason)
  }

  private receive(data: unknown): void {
    // Malformed traffic is dropped and the socket stays up. Closing on junk
    // would let anything that can reach this socket end a match, and there is
    // already a mechanism for "the other side is not speaking my protocol":
    // the version gate, which needs a frame to state a version in.
    if (typeof data !== 'string') {
      console.warn('[socket] Ignoring a message that is not text')
      return
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(data)
    } catch {
      console.warn('[socket] Ignoring a message that is not JSON')
      return
    }
    if (!isJsonRpcFrame(decoded)) {
      console.warn('[socket] Ignoring a message that is not a JSON-RPC frame')
      return
    }
    for (const handler of this.frameHandlers) handler(decoded)
  }
}
