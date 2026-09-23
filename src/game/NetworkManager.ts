import { Faction, SQUAD_SIZE } from '../config'
import { type CharacterSheet, sanitizeSheet } from '../core/Characters'
import type { GrenadeId, ShotMode, StatusKind } from '../core/Arsenal'
import type { ItemId } from '../core/Items'
import type { World } from '../ecs/World'
import { squadLoadoutFrom, type RecordedEvent, type RecordingHeader } from './Recording'
import type { SquadLoadout } from './Loadout'
import { SocketTransport } from './SocketTransport'
import type { StateDigest } from './StateDigest'
import { MY_VERSION, versionRefusal } from '../version'
import {
  type JsonRpcFrame,
  type JsonRpcNotification,
  componentUpdateMethod,
  parseComponentUpdateMethod,
  RpcMethods,
} from './JsonRpc'
import type { Recorder } from './Recording'
import {
  hostDataChannel,
  joinDataChannel,
  type DataChannelHost,
} from './DataChannelTransport'
import type { Transport } from './Transport'

export type NetworkMode = 'local' | 'host' | 'join'

/** What a peer brought: its people, and its kit if this build could read it. */
export interface PeerSquad {
  sheets: CharacterSheet[]
  loadout: SquadLoadout | null
}

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
  /**
   * The opening position, stated to a referee.
   *
   * A referee refights the match from its intents, so it needs what the
   * intents are *about*: the seed, both squads' people and both squads' kit.
   * None of that is derivable from the stream — a loadout reaches a peer as
   * replicated component state, which is state its owner is authoritative for
   * rather than something anybody declared — so a refereed match declares it
   * once, at the start.
   */
  | { type: 'matchHeader'; header: RecordingHeader }
  /**
   * A client that lost its tab, asking for the rest of the log.
   *
   * `afterSeq` is the last intent it is sure of; -1 means it has nothing and
   * wants the match from the beginning.
   */
  | { type: 'resume'; matchId: string; afterSeq: number }
  /** The log a resuming client replays to catch up. */
  | { type: 'log'; matchId: string; header: RecordingHeader; events: RecordedEvent[] }
  /**
   * The match is over because it stopped being one match.
   *
   * Named side and stated reason, because "desynchronised" is not something a
   * player can act on — and because a verdict nobody can read is indistinguishable
   * from a crash.
   */
  | { type: 'abort'; reason: string; side: Faction | null }
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
  /**
   * Hold fire for the other side's turn.
   *
   * An intent like any other, and notably *only* an intent: the reactions it
   * provokes are resolved by both peers from the path the mover declares, so
   * nothing about a reaction ever travels.
   */
  | { type: 'overwatch'; faction: Faction; squadIndex: number }
  | { type: 'endUnitTurn'; faction: Faction; squadIndex: number }
  // The target is optional because most uses are on the carrier: a frame with
  // no target named, or naming a unit this side cannot find, is a self-use.
  | { type: 'useItem'; faction: Faction; squadIndex: number; itemId: ItemId; targetFaction?: Faction; targetIndex?: number }
  | { type: 'endTurn'; faction: Faction }
  | { type: 'rightClickFacing'; faction: Faction; squadIndex: number; x: number; z: number }
  /**
   * This side has finished equipping: its people, and what they are carrying.
   *
   * The kit rides along because a referee refights the match from its intents
   * and a loadout is not one of them — it reaches a *peer* as replicated
   * component state, which is state its owner is authoritative for rather than
   * something anybody declared. Both sides know who they brought at exactly
   * this moment, and not before.
   */
  | { type: 'ready'; sheets: CharacterSheet[]; loadout: SquadLoadout }

export class NetworkManager {
  /** The channel this side plays over, once there is one. */
  transport: Transport | null = null
  /** A peer waiting to be joined, which outlives a channel that never came. */
  private hosting: DataChannelHost | null = null
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
  private readonly peerReady = Promise.withResolvers<PeerSquad>()

  /**
   * A joiner's wait for the frame that opens the match, while there is one.
   *
   * Held here rather than passed around because the gate that can refuse the
   * match sits at the edge, and this promise has to learn its verdict: a
   * mismatch is owed to the join screen as a failure to join, not as a match
   * that silently never starts.
   */
  private opening: PromiseWithResolvers<{ seed: number; seedLabel: string }> | null = null

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

  /**
   * Play over `transport`: every channel arrives here.
   *
   * A data channel between two peers, a socket to a referee, or a linked pair
   * in a test — nothing below this line knows which, because the version gate
   * and the refusal latch are properties of this manager and not of the
   * medium. That is what makes "a mismatched build cannot start a match" true
   * on all three
   * ([RFC-0001](../../docs/design/rfc/0001-referee-and-transports.md) §6).
   */
  attach(transport: Transport): void {
    this.transport = transport
    transport.onFrame((frame) => this.handleIncomingRpc(frame))
    transport.onClosed((reason) => {
      // A channel that dropped is not a peer that was turned away, so this
      // does not go through `refuse`: a player told the build was refused
      // would go looking for a version to fix.
      this.opening?.reject(new Error(reason))
      this.onDisconnected?.(reason)
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
    console.warn(`[net] Refusing the connection: ${reason}`)
    this.onDisconnected?.(reason)
    this.opening?.reject(new Error(reason))
    this.transport?.close()
    this.transport = null
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
      // Only now, past the gate: the seed is the first thing a match is built
      // from, and a joiner is waiting on exactly this frame to have arrived
      // from a build it can play against.
      if (typeof params.seed === 'number' && typeof params.seedLabel === 'string') {
        this.opening?.resolve({ seed: params.seed, seedLabel: params.seedLabel })
      }
    }

    // Never forwarded as a command: `ready` can land before this side has left
    // its loadout screen, when there is no `onMessage` to receive it. The
    // sheets are checked here, at the edge, so nothing downstream has to wonder
    // whether a peer's numbers are numbers.
    if (method === RpcMethods.ready) {
      const raw = Array.isArray(params.sheets) ? params.sheets : []
      const sheets = raw.slice(0, SQUAD_SIZE).map(sanitizeSheet)
      // The kit is *refused* rather than defaulted, unlike the sheets: a wrong
      // sheet costs display accuracy, a wrong weapon changes what every shot
      // does. A peer that cannot state its loadout deploys on the stock spread,
      // which is what this side already assumed.
      let loadout: SquadLoadout | null = null
      try {
        loadout = squadLoadoutFrom(params.loadout, "a peer's loadout")
      } catch (err) {
        console.warn('[net] ignoring a peer loadout this build cannot read:', err)
      }
      this.peerReady.resolve({ sheets, loadout })
      return
    }

    const msg = this.rpcToMessage(method, params)
    if (msg) {
      console.info(`%c[NET 📥 IN: ${msg.type}]`, 'color: #a855f7; font-weight: bold;', msg)
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

  /**
   * Play through a referee at `url`, as the side that opens the match.
   *
   * The referee relays between clients as well as watching, so the handshake
   * below is the same one two peers do directly — which is the point of the
   * transport port: a socket to a referee and a data channel to a peer are the
   * same match from here. What a referee adds is that a third recomputation is
   * watching, that the log outlives the tab, and that a client which loses its
   * tab can come back.
   */
  hostOnServer(url: string, seed: number, seedLabel: string): void {
    this.attach(new SocketTransport(new WebSocket(url)))
    this.hostMatch(seed, seedLabel)
  }

  /** Join a refereed match at `url`, and wait for its opening frame. */
  joinOnServer(url: string): Promise<{ seed: number; seedLabel: string }> {
    this.attach(new SocketTransport(new WebSocket(url)))
    return this.joinMatch()
  }

  /**
   * Open the match this side is hosting, over whatever is attached.
   *
   * The host is Blue and Blue moves first, which is why the role comes with
   * the announcement rather than with the channel: a socket to a referee and a
   * data channel to a peer are the same match from here.
   */
  hostMatch(seed: number, seedLabel: string): void {
    this.mode = 'host'
    this.myFaction = Faction.Blue
    this.send({ type: 'init', seed, seedLabel, ...MY_VERSION })
  }

  /**
   * Take the joining side over whatever is attached, and wait for the match.
   *
   * Resolves with the seed the opening frame carried, and rejects on anything
   * that makes a match impossible: a build this side will not play against, or
   * a channel that died before the opening frame ever came. The second is the
   * ordinary way an unreachable referee shows up, since an intent stream has
   * no acknowledgements to time out against.
   */
  joinMatch(): Promise<{ seed: number; seedLabel: string }> {
    this.mode = 'join'
    this.myFaction = Faction.Red
    this.opening = Promise.withResolvers()
    // Sent past the recorder rather than through `send`: a version is a fact
    // about this bundle, not an intent the match can replay.
    this.sendRpc(this.messageToRpc({ type: 'hello', ...MY_VERSION }))
    return this.opening.promise
  }

  isMyTurn(activeFaction: Faction): boolean {
    if (this.mode === 'local') return true
    return activeFaction === this.myFaction
  }

  /**
   * Host a peer-to-peer match: returns the id to hand the other player, and
   * opens the match once somebody joins with it.
   */
  async initHost(seed: number, seedLabel: string): Promise<string> {
    const hosting = await hostDataChannel()
    this.hosting = hosting
    this.myId = hosting.id

    void hosting.joined.then(
      (transport) => {
        console.info('[p2p] Client connected, sending init seed')
        this.attach(transport)
        this.hostMatch(seed, seedLabel)
        this.onConnected?.()
      },
      (err: Error) => {
        // Nothing is attached yet, so there is no channel whose close could
        // report this: the menu waiting for a joiner is all there is to tell.
        console.warn(`[p2p] Hosting failed: ${err.message}`)
        this.onDisconnected?.(err.message)
      },
    )

    return hosting.id
  }

  /** Join a peer-to-peer match by the host's broker id. */
  async initJoin(hostId: string): Promise<{ seed: number; seedLabel: string }> {
    const transport = await joinDataChannel(hostId)
    this.myId = transport.localId
    console.info('[p2p] Connected to host')
    this.attach(transport)
    const opening = this.joinMatch()
    this.onConnected?.()
    return opening
  }

  sendRpc(frame: JsonRpcFrame): void {
    this.transport?.send(frame)
  }

  send(msg: NetworkMessage): void {
    // Before the local-mode return: a recording is made of what this side did,
    // and in local play nothing is transmitted but everything still happened.
    this.recorder?.record(msg)
    if (this.mode === 'local') return
    console.info(`%c[NET 📤 OUT: ${msg.type}]`, 'color: #38bdf8; font-weight: bold;', msg)
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
  waitForPeerReady(): Promise<PeerSquad | null> {
    return this.mode === 'local' ? Promise.resolve(null) : this.peerReady.promise
  }

  dispose(): void {
    this.transport?.close()
    // The broker peer too, which is still waiting when nobody ever joined.
    this.hosting?.close()
  }
}
