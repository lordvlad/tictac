/**
 * Today's PeerJS connection, behind the frame port.
 *
 * The only file in `src/` that mentions `peerjs`, which is the point: WebRTC is
 * how two browsers reach each other through a NAT, and it is neither available
 * nor wanted in a `Bun.serve` process
 * ([RFC-0001](../../docs/design/rfc/0001-referee-and-transports.md) §6). Keeping
 * the dependency in one leaf means a peer, a referee and a test all drive the
 * same `Transport`, and nothing above has a per-channel branch.
 *
 * The broker plumbing — a `Peer`, its id, waiting for the other side — lives
 * here too, because it is all the same concern: producing one open channel.
 */

import { Peer, type DataConnection } from 'peerjs'
import { isJsonRpcFrame, type JsonRpcFrame } from './JsonRpc'
import type { Transport } from './Transport'

/** The frame a message carries, or null when it does not carry one. */
function decodeFrame(data: unknown): JsonRpcFrame | null {
  // A frame is JSON text on every transport, so text is what a current peer
  // sends. An object is still accepted because that is what a peer on a build
  // predating the port sends, and such a peer has to be *refused* — with a
  // reason it can act on — rather than quietly ignored.
  let decoded = data
  if (typeof data === 'string') {
    try {
      decoded = JSON.parse(data)
    } catch {
      console.warn('[p2p] Discarding a message that is not JSON')
      return null
    }
  }
  return isJsonRpcFrame(decoded) ? decoded : null
}

export class DataChannelTransport implements Transport {
  private readonly frameHandlers: ((frame: JsonRpcFrame) => void)[] = []
  private readonly closeHandlers: ((reason: string) => void)[] = []
  private live = true

  /**
   * Built by {@link hostDataChannel} and {@link joinDataChannel} — the two
   * places a `Peer` comes from — with a connection that is already open.
   */
  constructor(
    private readonly peer: Peer,
    private readonly connection: DataConnection,
  ) {
    connection.on('data', (data) => {
      const frame = decodeFrame(data)
      if (!frame) return
      for (const handler of this.frameHandlers) handler(frame)
    })
    connection.on('close', () => this.shut('Connection closed by remote peer'))
    connection.on('error', (err) => this.shut(err.message || 'Connection error'))
    // Peer-level failures land on the same handler as connection-level ones: a
    // broker that has dropped this side leaves a channel that cannot be used,
    // and the player is owed one message about it rather than a taxonomy.
    peer.on('error', (err) => this.shut(err.message || 'Peer error'))
    peer.on('close', () => this.shut('Peer closed'))
  }

  /** The broker's name for this side. */
  get localId(): string {
    return this.peer.id
  }

  send(frame: JsonRpcFrame): void {
    if (!this.live || !this.connection.open) return
    // JSON text, as on every other transport: a socket needs a string anyway,
    // so a frame is the same bytes whichever channel carried it.
    this.connection.send(JSON.stringify(frame))
  }

  onFrame(handler: (frame: JsonRpcFrame) => void): void {
    this.frameHandlers.push(handler)
  }

  onClosed(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler)
  }

  close(): void {
    if (!this.live) return
    // Closing is this side's own decision, so no close handler fires and the
    // flag stops the channel's own `close` event from reporting one back: a
    // refusal has already told the player why, and a second message saying the
    // peer hung up would overwrite the reason with the symptom.
    this.live = false
    this.connection.close()
    // The peer as well. This side is done with the broker, and a refused or
    // finished match must not remain reachable by a fresh connection.
    this.peer.destroy()
  }

  private shut(reason: string): void {
    if (!this.live) return
    this.live = false
    console.warn(`[p2p] ${reason}`)
    for (const handler of this.closeHandlers) handler(reason)
  }
}

/**
 * A fresh peer, once the broker has given it a name.
 *
 * Rejects rather than waiting forever when the broker will not: hosting and
 * joining are both things a menu is blocked on, and "Connecting…" that never
 * resolves is the one outcome a player cannot act on.
 */
async function named(peer: Peer): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  peer.once('open', resolve)
  peer.once('error', (err) => reject(new Error(err.message || 'Peer error')))
  return promise
}

/** A peer waiting to be joined: its id, and the channel once somebody does. */
export interface DataChannelHost {
  /** The id a joiner needs to be told. */
  readonly id: string
  /**
   * The channel, once a joiner's connection is open.
   *
   * Rejects if the broker drops this side first, because until a joiner arrives
   * there is no channel to report a close on — the screen waiting for one is
   * the only thing listening.
   */
  readonly joined: Promise<DataChannelTransport>
  /** Stop hosting, and close the channel if one already arrived. */
  close(): void
}

export async function hostDataChannel(): Promise<DataChannelHost> {
  const peer = new Peer()
  const id = await named(peer)

  const { promise, resolve, reject } = Promise.withResolvers<DataChannelTransport>()
  let transport: DataChannelTransport | null = null
  peer.on('connection', (connection) => {
    connection.on('open', () => {
      transport = new DataChannelTransport(peer, connection)
      resolve(transport)
    })
  })
  peer.on('error', (err) => reject(new Error(err.message || 'Peer error')))
  peer.on('close', () => reject(new Error('Peer closed')))

  return {
    id,
    joined: promise,
    close() {
      // Through the transport when there is one, so the deliberate close is not
      // reported back as the peer having hung up.
      transport?.close()
      peer.destroy()
    },
  }
}

/**
 * Open a channel to a host, resolving once it can carry frames.
 *
 * Every failure before that point rejects: this is what the join screen awaits,
 * and a host that cannot be reached has to arrive as a failure to join rather
 * than as a match that silently never starts.
 */
export async function joinDataChannel(hostId: string): Promise<DataChannelTransport> {
  const peer = new Peer()
  await named(peer)

  const connection = peer.connect(hostId)
  const { promise, resolve, reject } = Promise.withResolvers<DataChannelTransport>()
  connection.once('open', () => resolve(new DataChannelTransport(peer, connection)))
  connection.once('error', (err) => reject(new Error(err.message || 'Connection error')))
  peer.once('error', (err) => reject(new Error(err.message || 'Peer error')))
  return promise
}
