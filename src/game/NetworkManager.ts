import { Peer, DataConnection } from 'peerjs'
import { Faction, SQUAD_SIZE } from '../config'
import { type CharacterSheet, sanitizeSheet } from '../core/Characters'
import type { GrenadeId, ShotMode, StatusKind } from '../core/Arsenal'
import type { ItemId } from '../core/Items'
import type { World } from '../ecs/World'
import type { StateDigest } from './StateDigest'
import { MY_VERSION, versionRefusal } from '../version'
import {
  type JsonRpcFrame,
  type JsonRpcNotification,
  componentUpdateMethod,
  isJsonRpcFrame,
  parseComponentUpdateMethod,
  RpcMethods,
} from './JsonRpc'
import type { Recorder } from './Recording'

export type NetworkMode = 'local' | 'host' | 'join'

/**
 * One unit's share of an attack, exactly as the acting peer resolved it.
 *
 * The receiving peer holds only the *stock* copy of the sender's weapons and
 * grenades — the chosen loadout is stamped before replication starts — so an
 * attack's numbers travel with it and are applied verbatim.
 */
/**
 * Commands: things one peer asks the other to *do*.
 *
 * Everything a command changes is component state, and component state
 * replicates itself through {@link World.syncDirty}. Commands exist only for
 * the parts that cannot be inferred from a diff — the dice rolls behind a
 * shot, and the intent to start walking a particular route.
 */
export type NetworkMessage =
  // Both first frames state the build they came from: the host's `init` and
  // the joiner's `hello`. A match between two different builds is refused
  // before it starts — see `src/version.ts`.
  | { type: 'init'; seed: number; seedLabel: string; protocol: number; build: string }
  | { type: 'hello'; protocol: number; build: string }
  /**
   * A fingerprint of the sender's whole world, sent immediately before it hands
   * over. Not an intent: it asks the other side to *do* nothing, and it is not
   * recorded, because a replay derives its state rather than checking it.
   */
  | { type: 'digest'; digest: StateDigest }
  | { type: 'moveUnit'; faction: Faction; squadIndex: number; path: { x: number; y: number }[] }
  | {
      type: 'fireShot'
      shooterFaction: Faction
      shooterIndex: number
      targetFaction: Faction
      targetIndex: number
      mode: ShotMode
    }
  | { type: 'throwGrenade'; shooterFaction: Faction; shooterIndex: number; kind: GrenadeId; targetTile: { x: number; y: number } }
  | { type: 'reload'; faction: Faction; squadIndex: number }
  | { type: 'toggleCover'; faction: Faction; squadIndex: number }
  | { type: 'endUnitTurn'; faction: Faction; squadIndex: number }
  // The target is optional because most uses are on the carrier: a frame with
  // no target named, or naming a unit this side cannot find, is a self-use.
  | { type: 'useItem'; faction: Faction; squadIndex: number; itemId: ItemId; targetFaction?: Faction; targetIndex?: number }
  | { type: 'endTurn'; faction: Faction }
  | { type: 'rightClickFacing'; faction: Faction; squadIndex: number; x: number; z: number }
  | { type: 'ready'; sheets: CharacterSheet[] }

export class NetworkManager {
  peer: Peer | null = null
  conn: DataConnection | null = null
  mode: NetworkMode = 'local'
  myId: string = ''
  myFaction: Faction = Faction.Blue

  onMessage: ((msg: NetworkMessage) => void) | null = null
  onConnected: (() => void) | null = null
  onDisconnected: ((reason?: string) => void) | null = null
  /** Fired after peer state has been written into the world. */
  onComponentUpdate: (() => void) | null = null
  /**
   * Attached to write every command this side issues to a file.
   *
   * Tapped here rather than at each call site because this is the one door a
   * command goes out of, and a recording with a hole in it is worse than none.
   * Null unless the debug panel armed it.
   */
  recorder: Recorder | null = null

  /** Set once a peer has been turned away; nothing it sends is read again. */
  private refused = false
  private world: World | null = null
  private owns: (entityId: number) => boolean = () => true
  private readonly peerReady = Promise.withResolvers<CharacterSheet[]>()

  /**
   * Replicate component mutations for the entities this peer owns.
   *
   * Both peers run the same simulation, so without an owner each side would
   * broadcast its own guess at every unit and the two would overwrite each
   * other mid-step. `owns` names the authority: its answer is the only state
   * that travels, and state for anything else is only ever received.
   */
  bindWorld(world: World, owns: (entityId: number) => boolean): void {
    this.world = world
    this.owns = owns
    world.onComponentChanged((entityId, componentName, data) => {
      if (this.mode === 'local' || !this.owns(entityId)) return
      this.sendRpc({
        jsonrpc: '2.0',
        method: componentUpdateMethod(componentName),
        params: { entityId, ...data },
      })
    })
  }

  private setupConn(conn: DataConnection): void {
    this.conn = conn
    conn.on('data', (data) => {
      if (isJsonRpcFrame(data)) this.handleIncomingRpc(data)
    })
    conn.on('close', () => {
      console.warn('[p2p] Connection closed by remote peer')
      this.onDisconnected?.('Connection closed by remote peer')
    })
    conn.on('error', (err) => {
      console.warn('[p2p] Connection error:', err)
      this.onDisconnected?.(err.message || 'Connection error')
    })
  }

  /**
   * Refuse a peer, with a reason a player can act on.
   *
   * Closing the connection is the whole enforcement: there is no partial
   * compatibility to negotiate, and playing on would produce a match whose
   * result cannot be trusted or stored.
   */
  private refuse(reason: string): void {
    // Latched: a peer that has been refused does not get to carry on by
    // sending an acceptable frame afterwards. The closed channel is the
    // enforcement in practice, but the decision is this side's and it is not
    // re-litigated per frame.
    this.refused = true
    console.warn(`[p2p] Refusing the connection: ${reason}`)
    this.onDisconnected?.(reason)
    this.conn?.close()
    this.conn = null
  }

  private handleIncomingRpc(frame: JsonRpcFrame): void {
    if (this.refused) return
    if (!('method' in frame)) return
    const { method } = frame
    const params = (frame as JsonRpcNotification).params as Record<string, unknown>

    const componentName = parseComponentUpdateMethod(method)
    if (componentName) {
      if (typeof params.entityId !== 'number') return
      // A peer never gets to rewrite state this side is authoritative for.
      if (this.owns(params.entityId)) return
      if (this.world?.applyRemote(params.entityId, componentName, params)) {
        this.onComponentUpdate?.()
      }
      return
    }

    // The version gate, checked at the edge on both of the frames that can
    // carry it: the host's `init` and the joiner's `hello`. Before the seed is
    // taken and before anything is forwarded as a command, because a peer on
    // another build is not a peer whose commands mean anything here.
    if (method === RpcMethods.init || method === RpcMethods.hello) {
      const reason = versionRefusal(params)
      if (reason) {
        this.refuse(reason)
        return
      }
      // `hello` states a version and nothing else, so there is nothing left to
      // forward once it has been accepted.
      if (method === RpcMethods.hello) return
    }

    // Never forwarded as a command: `ready` can land before this side has left
    // its loadout screen, when there is no `onMessage` to receive it. The
    // sheets are checked here, at the edge, so nothing downstream has to wonder
    // whether a peer's numbers are numbers.
    if (method === RpcMethods.ready) {
      const raw = Array.isArray(params.sheets) ? params.sheets : []
      this.peerReady.resolve(raw.slice(0, SQUAD_SIZE).map(sanitizeSheet))
      return
    }

    const msg = this.rpcToMessage(method, params)
    if (msg) {
      console.info(`%c[P2P 📥 IN: ${msg.type}]`, 'color: #a855f7; font-weight: bold;', msg)
      this.onMessage?.(msg)
    }
  }

  private messageToRpc(msg: NetworkMessage): JsonRpcNotification {
    const params = { ...msg } as Record<string, unknown>
    delete params.type
    return { jsonrpc: '2.0', method: RpcMethods[msg.type], params }
  }

  private rpcToMessage(method: string, params: Record<string, unknown>): NetworkMessage | null {
    for (const [type, name] of Object.entries(RpcMethods)) {
      if (name === method) return { ...params, type } as NetworkMessage
    }
    return null
  }

  private setupPeer(peer: Peer): void {
    peer.on('error', (err) => {
      console.warn('[p2p] Peer error:', err)
      if (this.mode !== 'local') this.onDisconnected?.(err.message || 'Peer error')
    })
    peer.on('close', () => {
      console.warn('[p2p] Peer closed')
      if (this.mode !== 'local') this.onDisconnected?.('Peer closed')
    })
  }

  isMyTurn(activeFaction: Faction): boolean {
    if (this.mode === 'local') return true
    return activeFaction === this.myFaction
  }

  async initHost(seed: number, seedLabel: string): Promise<string> {
    this.mode = 'host'
    this.myFaction = Faction.Blue
    this.peer = new Peer()
    this.setupPeer(this.peer)

    const { promise, resolve } = Promise.withResolvers<string>()

    this.peer.on('open', (id) => {
      this.myId = id
      resolve(id)
    })

    this.peer.on('connection', (conn) => {
      this.setupConn(conn)
      conn.on('open', () => {
        console.info('[p2p] Client connected, sending init seed')
        this.send({ type: 'init', seed, seedLabel, ...MY_VERSION })
        this.onConnected?.()
      })
    })

    return promise
  }

  async initJoin(hostId: string): Promise<{ seed: number; seedLabel: string }> {
    this.mode = 'join'
    this.myFaction = Faction.Red
    this.peer = new Peer()
    this.setupPeer(this.peer)

    const { promise, resolve, reject } = Promise.withResolvers<{
      seed: number
      seedLabel: string
    }>()

    this.peer.on('open', (id) => {
      this.myId = id
      const conn = this.peer!.connect(hostId)
      this.setupConn(conn)

      conn.on('open', () => {
        console.info('[p2p] Connected to host')
        // Sent past the recorder rather than through `send`: a version is a
        // fact about this bundle, not an intent the match can replay.
        this.sendRpc(this.messageToRpc({ type: 'hello', ...MY_VERSION }))
        this.onConnected?.()
      })

      conn.on('data', (data) => {
        if (!isJsonRpcFrame(data) || !('method' in data)) return
        if (data.method !== RpcMethods.init) return
        const params = (data as JsonRpcNotification).params as Record<string, unknown>
        // Refused here as well as in `handleIncomingRpc`, because this is the
        // promise the join screen is waiting on: a mismatch has to surface as a
        // failure to join and not as a match that silently never starts.
        const refusal = versionRefusal(params)
        if (refusal) {
          reject(new Error(refusal))
          return
        }
        if (typeof params.seed === 'number' && typeof params.seedLabel === 'string') {
          resolve({ seed: params.seed, seedLabel: params.seedLabel })
        }
      })
    })

    return promise
  }

  sendRpc(frame: JsonRpcFrame): void {
    if (this.conn?.open) this.conn.send(frame)
  }

  send(msg: NetworkMessage): void {
    // Before the local-mode return: a recording is made of what this side did,
    // and in local play nothing is transmitted but everything still happened.
    this.recorder?.record(msg)
    if (this.mode === 'local') return
    console.info(`%c[P2P 📤 OUT: ${msg.type}]`, 'color: #38bdf8; font-weight: bold;', msg)
    this.sendRpc(this.messageToRpc(msg))
  }

  /**
   * Resolves with the peer's squad sheets once it has sent its `ready`, or
   * `null` in local play, where there is no peer and both squads were rolled
   * on this side.
   *
   * Blue moves first and the host is Blue, so without this barrier the host
   * could fire while the joiner is still on the loadout screen — and with no
   * `onMessage` attached yet, those commands would be dropped outright. The
   * sheets ride the same message because this is exactly the moment both sides
   * know who they brought: any later and a shot could be resolved against a
   * squad this side had guessed at.
   */
  waitForPeerReady(): Promise<CharacterSheet[] | null> {
    return this.mode === 'local' ? Promise.resolve(null) : this.peerReady.promise
  }

  dispose(): void {
    this.conn?.close()
    this.peer?.destroy()
  }
}
