import { Faction, SQUAD_SIZE } from '../config'
import { sanitizeSheet } from '../core/Characters'
import type { GrenadeId, ShotMode } from '../core/Arsenal'
import type { DoorVerb } from '../core/Doors'
import type { ItemId } from '../core/Items'
import type { World } from '../ecs/World'
import { isCommand } from '../ecs/systems/CommandSystem'
import {
  deploymentStateFrom,
  parseRecording,
  unitLoadoutFrom,
  type Deployment,
  type RecordedEvent,
  type RecordingHeader,
} from './Recording'
import type { UnitLoadout } from './Loadout'
import { intentQuery, type RoomPhase, type Seated, type ServerIntent } from './Lobby'
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
import {
  hostDataChannel,
  joinDataChannel,
  type DataChannelHost,
} from './DataChannelTransport'
import type { Transport } from './Transport'

/**
 * Which side of a match this manager speaks for.
 *
 * `spectate` is a socket to a match server that holds no seat: it hears the
 * match and says nothing, so nothing it might send — a command, a digest, a
 * component update — ever leaves it (`sendRpc`).
 */
export type NetworkMode = 'local' | 'host' | 'join' | 'spectate'

/** A match so far, as a match server states it to a socket taking a seat in it or watching it. */
export interface MatchLog {
  matchId: string
  header: RecordingHeader
  events: RecordedEvent[]
}

const ROOM_PHASES: readonly RoomPhase[] = ['waiting', 'deploying', 'playing']

/** What a peer brought: one entry per soldier, its kit absent where this build could not read it. */
export interface PeerSquad {
  squad: Deployment[]
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
   * The match so far: its opening position and every intent the referee has
   * accepted. Sent by a match server to a socket that is seated in a match
   * already playing, or watching one — which is how a second window takes a
   * match over and how a spectator catches up (`src/game/Lobby.ts`). Asked
   * for by the socket's url (`intent=resume`/`watch`), not by a frame.
   */
  | { type: 'log'; matchId: string; header: RecordingHeader; events: RecordedEvent[] }
  /**
   * Which room this socket is in and as whom (`src/game/Lobby.ts`). The
   * server's first frame, sent once the client's `hello` has passed the
   * version gate; a seat in a match already playing, and any spectator, is
   * sent the `log` next.
   */
  | { type: 'seated'; roomId: string; faction: Faction | null; phase: RoomPhase; redirected: boolean }
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
  /** `targetLevel`: the storey of the tile aimed at, so a roofed tile is a room or its roof (`throwsLow`). */
  | {
      type: 'throwGrenade'
      shooterFaction: Faction
      shooterIndex: number
      kind: GrenadeId
      targetTile: { x: number; y: number }
      targetLevel: number
    }
  | { type: 'reload'; faction: Faction; squadIndex: number }
  /** Strike an adjacent enemy with the sidearm. Intent only, like a shot. */
  | {
      type: 'meleeAttack'
      attackerFaction: Faction
      attackerIndex: number
      targetFaction: Faction
      targetIndex: number
    }
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
  /**
   * The whole side tries to get out (`core/Retreat`): everyone on its way out
   * goes, everyone else is left behind. Intent only — the roll is the rules',
   * from the match's dice, on every side.
   */
  | { type: 'retreat'; faction: Faction }
  /** Work the door on `edge`, beside the unit: open, close, unlock or force it (`core/Doors`). */
  | { type: 'operateDoor'; faction: Faction; squadIndex: number; edge: number; verb: DoorVerb }
  | { type: 'rightClickFacing'; faction: Faction; squadIndex: number; x: number; z: number }
  /**
   * This side has finished equipping: its people, what they are carrying, and
   * what state they start in — one entry per soldier.
   *
   * The kit rides along because a referee refights the match from its intents
   * and a loadout is not one of them — it reaches a *peer* as replicated
   * component state, which is state its owner is authoritative for rather than
   * something anybody declared. Both sides know who they brought at exactly
   * this moment, and not before.
   *
   * State's `hp` is the same reasoning applied to wounds: absent everywhere
   * except a kept server match, where a starting HP has to be something both
   * peers and the referee agree on before the first digest, or the referee
   * accuses an honest client of a foul.
   */
  | { type: 'ready'; squad: Deployment[] }

export class NetworkManager {
  /** The channel this side plays over, once there is one. */
  transport: Transport | null = null
  /** A peer waiting to be joined, which outlives a channel that never came. */
  private hosting: DataChannelHost | null = null
  mode: NetworkMode = 'local'
  myId: string = ''
  myFaction: Faction = Faction.Blue

  /**
   * Where the other side's commands go, once something is ready to apply them.
   *
   * Until then they are held, in order, and handed over the moment a handler
   * is assigned. A side that takes over a match in progress learns the match
   * from the server's `log` and then spends a moment building the world from
   * it; the other player does not stop playing for that, and a command
   * relayed in between, dropped, would be a step this side never took.
   */
  get onMessage(): ((msg: NetworkMessage) => void) | null {
    return this.handler
  }
  set onMessage(handler: ((msg: NetworkMessage) => void) | null) {
    this.handler = handler
    // Shifted one at a time, re-reading the handler each round, so a handler
    // that replaces itself (a one-shot wait for the next message) leaves the
    // rest for whoever comes next rather than swallowing them.
    while (this.handler && this.held.length > 0) this.handler(this.held.shift()!)
  }
  private handler: ((msg: NetworkMessage) => void) | null = null
  private readonly held: NetworkMessage[] = []
  onConnected: (() => void) | null = null
  onDisconnected: ((reason?: string) => void) | null = null
  /** Fired after peer state has been written into the world. */
  onComponentUpdate: (() => void) | null = null

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
   * The opening this side announced as host, kept so a joiner that connects
   * after it was announced can still be told (`restate`).
   */
  private opened: { seed: number; seedLabel: string } | null = null
  /** The squad this side has already deployed, for the same reason. */
  private deployed: Deployment[] | null = null

  /**
   * A socket's wait for the server to say where it sits (`connectToServer`),
   * while there is one. Held here for the same reason `opening` is: an abort
   * or a dropped socket before the seat is a failure to connect, owed to the
   * menu with its reason.
   */
  private seating: PromiseWithResolvers<Seated> | null = null

  /**
   * The match so far, once a server has stated it. Kept rather than passed on,
   * because it can arrive before whoever needs it has asked: straight after
   * the seat, while the menu is still deciding what to show.
   */
  private readonly matchLog = Promise.withResolvers<MatchLog>()

  constructor() {
    // A log that never comes is only a failure to whoever waits for one;
    // most managers never do.
    this.matchLog.promise.catch(() => {})
  }

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
      this.disappoint(reason)
      this.onDisconnected?.(reason)
    })
  }

  /**
   * Tell everything still waiting on the other side — the opening, the seat,
   * the log — that it is not coming, and why.
   */
  private disappoint(reason: string): void {
    const error = new Error(reason)
    this.opening?.reject(error)
    this.seating?.reject(error)
    this.matchLog.reject(error)
  }

  /**
   * End the match with a reason a player can act on: a build this side will
   * not play against, or an `abort` the other side stated.
   *
   * Closing the connection is the whole enforcement: there is no partial
   * compatibility to negotiate, and playing on would produce a match whose
   * result cannot be trusted or stored.
   */
  private refuse(reason: string): void {
    // Latched: a peer that has been refused does not get to carry on by
    // sending an acceptable frame afterwards. The closed channel is the
    // enforcement in practice, but the decision is this side's and it is not
    // re-litigated per frame. Closing here is also what keeps the *stated*
    // reason: this side's own `close` fires no close handler, so the socket
    // shutting a moment later cannot overwrite "build mismatch" with "the
    // connection was lost".
    this.refused = true
    console.warn(`[net] The match cannot go on: ${reason}`)
    this.onDisconnected?.(reason)
    this.disappoint(reason)
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

    // An abort is the referee (or a peer) saying the match has stopped being
    // one match, and it is the only frame that arrives already carrying its
    // own explanation. Taken at the edge rather than forwarded as a command,
    // because it can land before there is a controller to forward it to —
    // during the handshake, or while this side is still on the loadout
    // screen — and that is exactly when a refusal is most worth reading. Left
    // to the socket, the player would be told "the connection was lost"
    // instead of why.
    if (method === RpcMethods.abort) {
      const stated = typeof params.reason === 'string' && params.reason.length > 0
        ? params.reason
        : 'The match server ended the match without saying why.'
      this.refuse(stated)
      return
    }

    // Where the server put this socket. Taken at the edge because it decides
    // what this manager *is* — a seat speaks for its side, a spectator speaks
    // for nobody — before anything downstream exists to be told.
    if (method === RpcMethods.seated) {
      const faction = params.faction === Faction.Blue || params.faction === Faction.Red ? params.faction : null
      const phase = ROOM_PHASES.find((known) => known === params.phase)
      if (typeof params.roomId !== 'string' || (faction === null && params.faction !== null) || !phase) {
        this.refuse('The match server sent a seat this build cannot read.')
        return
      }
      if (faction === null) {
        this.mode = 'spectate'
      } else {
        this.mode = faction === Faction.Blue ? 'host' : 'join'
        this.myFaction = faction
      }
      this.seating?.resolve({ roomId: params.roomId, faction, phase, redirected: params.redirected === true })
      return
    }

    // The match so far, for a side that was not there for it. Kept until it
    // is asked for (`waitForLog`), and checked the way a recording file is:
    // it is the same thing, and the world is about to be built from it.
    if (method === RpcMethods.log) {
      if (typeof params.matchId !== 'string') {
        this.refuse('The match server sent a match this build cannot read.')
        return
      }
      try {
        const { header, events } = parseRecording({ header: params.header, events: params.events })
        this.matchLog.resolve({ matchId: params.matchId, header, events })
      } catch (err) {
        this.refuse(`The match server sent a match this build cannot read: ${(err as Error).message}`)
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
      // `hello` states a version and nothing else, so there is nothing left
      // to forward once it has been accepted — but it is also the only sign
      // this side gets that somebody has arrived who may have missed what it
      // already said. A referee relays live and keeps nothing for a latecomer
      // (its `log` is only for a match that is already playing), so
      // a host whose opponent connects after it opened the match would
      // otherwise sit on the loadout screen forever, each side waiting for
      // the other.
      if (method === RpcMethods.hello) {
        this.restate()
        return
      }
      // Only now, past the gate: the seed is the first thing a match is built
      // from, and a joiner is waiting on exactly this frame to have arrived
      // from a build it can play against.
      if (typeof params.seed === 'number' && typeof params.seedLabel === 'string') {
        this.opening?.resolve({ seed: params.seed, seedLabel: params.seedLabel })
      }
    }

    // Never forwarded as a command: `ready` can land before this side has left
    // its loadout screen, when there is no `onMessage` to receive it. Checked
    // here, at the edge, so nothing downstream has to wonder whether a peer's
    // numbers are numbers.
    if (method === RpcMethods.ready) {
      const rawSquad = (Array.isArray(params.squad) ? params.squad : []).slice(0, SQUAD_SIZE)
      const entries = rawSquad.map((entry) =>
        entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {},
      )
      const sheets = entries.map((entry) => sanitizeSheet(entry.sheet))
      // The kit is *refused* rather than defaulted, unlike the sheet beside
      // it: a wrong sheet costs display accuracy, a wrong weapon changes what
      // every shot does. One unit's kit this build cannot read costs the
      // whole squad's — the other side then deploys on the stock spread it
      // had already assumed, rather than a mix of real and invented gear.
      let loadouts: UnitLoadout[] | null = null
      try {
        loadouts = entries.map((entry, i) => unitLoadoutFrom(entry.loadout, `a peer's loadout[${i}]`))
      } catch (err) {
        console.warn('[net] ignoring a peer loadout this build cannot read:', err)
      }
      const squad: Deployment[] = sheets.map((sheet, i) => {
        const state = deploymentStateFrom(entries[i]!.state)
        return {
          sheet,
          ...(loadouts ? { loadout: loadouts[i]! } : {}),
          ...(state ? { state } : {}),
          // Who on the peer's roster this is, when it brought a roster: the
          // host states the opening to the referee, and a referee settles a
          // signed-in squad only on the characters it names.
          ...(typeof entries[i]!.characterId === 'string' ? { characterId: entries[i]!.characterId } : {}),
        }
      })
      this.peerReady.resolve({ squad })
      return
    }

    const msg = this.rpcToMessage(method, params)
    if (!msg) return
    console.info(`%c[NET 📥 IN: ${msg.type}]`, 'color: #a855f7; font-weight: bold;', msg)
    if (this.handler) this.handler(msg)
    // Only what the match is made of is held for a handler still to come: a
    // command, and the digest that checks the commands before it. An opening
    // said again to a side already past it means nothing later, and handing
    // it to the next listener would pass it off as news.
    else if (isCommand(msg) || msg.type === 'digest') this.held.push(msg)
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
   * Connect to the match server at `url`, asking it for `intent`, and wait to
   * be told where this socket sits.
   *
   * The intent rides in the url (`intentQuery`) rather than in a frame because
   * the server has to know who is asking for what before it reads a word —
   * which room, which seat, which window this player had open before. Added
   * through `searchParams`, so a ticket the url already carries is kept.
   *
   * Resolves with the seat, and rejects with the server's own reason on an
   * `abort` (a build it will not play, a room that is gone or full) or with
   * the socket's on a connection that died first. What follows depends on the
   * seat: a room still being set up goes on with `hostMatch`/`joinMatch`
   * exactly as a data channel would; a match already playing, or any room
   * watched, is stated as a `log` (`waitForLog`).
   *
   * The server relays between clients as well as watching, so a socket to it
   * and a data channel to a peer are the same match from here. What it adds is
   * a third recomputation watching, a log that outlives the tab, and a seat
   * that a player who loses their tab can come back to.
   */
  connectToServer(url: string, intent: ServerIntent): Promise<Seated> {
    const target = new URL(url)
    for (const [key, value] of new URLSearchParams(intentQuery(intent))) target.searchParams.set(key, value)
    this.seating = Promise.withResolvers()
    this.attach(new SocketTransport(new WebSocket(target.href)))
    // Straight to the transport rather than through `send`: this side has no
    // mode yet, and a version is a fact about this bundle, not an intent.
    this.sendRpc(this.messageToRpc({ type: 'hello', ...MY_VERSION }))
    return this.seating.promise
  }

  /**
   * The match so far, once the server has stated it: straight after the seat
   * for a match already playing, or when a watched room starts. Rejects if the
   * connection ends first.
   */
  waitForLog(): Promise<MatchLog> {
    return this.matchLog.promise
  }

  /**
   * Open the match this side is hosting, over whatever is attached.
   *
   * The host is Blue and Blue moves first, which is why the role comes with
   * the announcement rather than with the channel: a socket to a referee and a
   * data channel to a peer are the same match from here.
   *
   * Announced immediately *and* remembered, because the two transports differ
   * in when the other side exists. A data channel only exists once a peer has
   * joined it, so the announcement always has a listener; a socket to a
   * referee exists the moment the host opens the match, and the opponent
   * connects minutes later. The referee relays rather than replays, so an
   * `init` spoken into an empty room is simply gone — which is why `hello`
   * is answered with it again (see `restate`).
   */
  hostMatch(seed: number, seedLabel: string): void {
    this.mode = 'host'
    this.myFaction = Faction.Blue
    this.opened = { seed, seedLabel }
    this.send({ type: 'init', seed, seedLabel, ...MY_VERSION })
  }

  /**
   * Say again, to a side that has just announced itself, everything this side
   * said before it could hear.
   *
   * Both frames are statements of position rather than events, so repeating
   * them is harmless where it is redundant: a joiner resolves its opening
   * once, and a `ready` is the squad this side brought, which does not change.
   * Neither is an intent, so neither reaches the recorded stream — a referee
   * has not even opened the match until `matchHeader`, which comes after
   * both sides have deployed.
   */
  private restate(): void {
    if (this.opened) {
      this.send({ type: 'init', ...this.opened, ...MY_VERSION })
    }
    if (this.deployed) this.send({ type: 'ready', squad: this.deployed })
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
    // Straight to the transport rather than through `send`: a version is a
    // fact about this bundle, not an intent the match can replay.
    this.sendRpc(this.messageToRpc({ type: 'hello', ...MY_VERSION }))
    return this.opening.promise
  }

  isMyTurn(activeFaction: Faction): boolean {
    if (this.mode === 'local') return true
    if (this.mode === 'spectate') return false
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

  /**
   * Put a frame on the wire — unless this side holds no seat. A spectator's
   * only word is the `hello` it connected with, which went out before the
   * server said it was one; after that the one gate every frame passes is the
   * one place a watcher's command, digest or replicated state is stopped.
   */
  sendRpc(frame: JsonRpcFrame): void {
    if (this.mode === 'spectate') return
    this.transport?.send(frame)
  }

  send(msg: NetworkMessage): void {
    // Not recorded here: a recording is of every command the world applied,
    // from either side, and only the applier sees both. When this recorded,
    // a match's file held this side's moves and none of the opponent's.
    if (this.mode === 'local') return
    // Kept so a side that connects afterwards can still be told (`restate`).
    if (msg.type === 'ready') this.deployed = msg.squad
    console.info(`%c[NET 📤 OUT: ${msg.type}]`, 'color: #38bdf8; font-weight: bold;', msg)
    this.sendRpc(this.messageToRpc(msg))
  }

  /**
   * Resolves with the peer's squad sheets once it has sent its `ready`, or
   * `null` in local play, where there is no peer and both squads were rolled
   * on this side.
   *
   * Blue moves first and the host is Blue, so without this barrier the host
   * could fire while the joiner is still on the loadout screen, at a squad
   * this side has never been told about. The
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
