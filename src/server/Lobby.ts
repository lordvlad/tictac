import { Faction } from '../config'
import { toBase64Url } from '../game/Base64Url'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../game/JsonRpc'
import type { LobbyView, ServerIntent } from '../game/Lobby'
import type { Transport } from '../game/Transport'
import { MY_VERSION, OLDEST_SERVED_PROTOCOL, SERVER_VOICES, versionRefusal, type PeerVersion } from '../version'
import type { Player } from './Accounts'
import type { MatchStore } from './MatchStore'
import { hashSeatKey, Room, type Client, type RefereeVerdict, type RoomOptions } from './Room'
import type { RoomStore } from './RoomStore'
import type { Rosters } from './Rosters'

/**
 * The match server's rooms, and who is in which.
 *
 * A socket arrives with an intent in its url (`src/game/Lobby.ts`) — open a
 * room, join one, watch one, or take back a seat — states its build, and is
 * placed exactly once: into one room, as one seat or as a spectator, and told
 * so in a `seated` frame. Everything after that is the room's
 * (`Room.ts`): the same refereed conversation a match always had.
 *
 * What the lobby owns is the two rules that span rooms, both about signed-in
 * players, since an anonymous socket has no identity to hold anything to:
 *
 * - **One match per player.** Whatever a player with a match in progress asks
 *   for, they are put back in their own seat (`redirected`).
 * - **One live window per player.** Their newest socket wins, wherever the
 *   previous one was. A match already playing carries on in the new window,
 *   rebuilt from the log; a match still being set up is abandoned, because a
 *   half-equipped loadout lives in the window that was equipping it and is not
 *   worth carrying between windows.
 *
 * A window that merely lost its connection is not a new window. Every seat
 * comes with a key (`seated.seatKey`), and a socket presenting it takes that
 * seat back — signed in or not, in any phase, without a ticket — while the
 * seat is held for it after a drop.
 *
 * **Rooms survive the server.** Every room is written down as it changes
 * (`RoomStore`), and a server starting over the same database takes them all
 * up again (`restore`) before it accepts a socket: the seats are held, the
 * match is refought from its log, and each window reconnects with its key as
 * if its wifi had dropped for a moment. That server may be a newer build. A
 * room keeps the build it was opened under, and only a page on that build can
 * take a seat in it back (`OLDEST_SERVED_PROTOCOL`), so a deploy lets every
 * match in progress finish on the bundle it started on, while opening,
 * joining and watching require the server's own build.
 */

/** How long a seat is held for its window after its socket drops. */
export const GRACE_MS = 120_000

export interface LobbyOptions {
  /** Where matches are written. Already migrated: see `Persistence`. */
  matches: MatchStore
  /** Where rooms are written, and where `restore` finds them again. */
  rooms: RoomStore
  /** The rosters to check squads against and settle onto; without them nothing is kept. */
  rosters?: Rosters
  /** Called when a match is aborted on the referee's judgement. */
  onVerdict?: (verdict: RefereeVerdict) => void
  /** Called for anything worth a line in a server log. */
  log?: (message: string) => void
  /** How long a dropped seat is held; `GRACE_MS` unless a test says otherwise. */
  graceMs?: number
  /** Run `fn` after `ms`, answering a cancel. `setTimeout` unless a test is the clock. */
  schedule?: (fn: () => void, ms: number) => () => void
  /**
   * The build this server runs: `MY_VERSION`, unless a test stands up a
   * newer or older server over a database another one wrote.
   */
  version?: PeerVersion
}

const NO_INTENT = 'That link does not say which match to open, join or watch.'
const GONE = 'That match is gone.'
const NOT_YOURS = 'That seat is not yours.'
const OTHER_BUILD = 'That match was started on another version of TicTac, and only its own players can finish it.'

export class Lobby {
  /** Every room not yet swept: listed while it is not over, kept until its sockets and writes are done. */
  private readonly rooms = new Map<string, Room>()
  /** Each signed-in player's live window: the socket they were last placed with. */
  private readonly windows = new Map<string, Client>()
  /** What every room is opened with: the lobby's own options, and the way back to it. */
  private readonly roomOptions: RoomOptions
  private readonly store: { matches: MatchStore; rooms: RoomStore }
  private readonly version: PeerVersion
  private readonly log: (message: string) => void
  private disposed = false

  constructor(options: LobbyOptions) {
    this.log = options.log ?? ((message) => console.info(`[lobby] ${message}`))
    this.version = options.version ?? MY_VERSION
    this.store = { matches: options.matches, rooms: options.rooms }
    this.roomOptions = {
      matches: options.matches,
      rooms: options.rooms,
      rosters: options.rosters,
      serverVersion: this.version,
      onVerdict: options.onVerdict,
      log: this.log,
      graceMs: options.graceMs ?? GRACE_MS,
      schedule:
        options.schedule ??
        ((fn, ms) => {
          const timer = setTimeout(fn, ms)
          return () => clearTimeout(timer)
        }),
      onOver: (room) => this.sweep(room),
    }
  }

  /**
   * Take up every room a previous server left live in the store, before this
   * one accepts a socket.
   *
   * Each comes back with nobody in it and its seats held for the grace
   * period from now (`Room.restore`): a window that does not reconnect in
   * time ends its room exactly as a dropped one always did. A room from
   * another build still waiting for an opponent is not taken up: nobody can
   * join it — a page on its build is refused by this server, a page on this
   * server's build by the room — so its row is let go, and the window that
   * opened it is told the match is gone.
   */
  async restore(): Promise<void> {
    for (const stored of await this.store.rooms.live()) {
      if (this.rooms.has(stored.id)) continue
      const match = await this.store.matches.match(stored.id)
      if (!match && stored.phase === 'waiting' && stored.version.build !== this.version.build) {
        this.log(`room ${stored.id}: let go — opened under build ${stored.version.build}, still waiting, unjoinable now`)
        await this.store.rooms.end(stored.id)
        continue
      }
      const room = new Room(stored.id, stored.version, this.roomOptions, stored.createdAt)
      // In the map before it is restored: refighting the log can end the
      // room (a match that was won before the restart wrote its last row),
      // and the lobby sweeps only rooms it can find.
      this.rooms.set(room.id, room)
      room.restore(stored, match)
    }
  }

  /**
   * Take a socket.
   *
   * `player` is the account its ticket named, or null for an anonymous one —
   * which is legitimate: a match between two anonymous clients is watched and
   * written down exactly as any other, it is simply kept on nobody's roster.
   * `intent` is what its url asked for, or null for a url that asked for
   * nothing readable; that is refused in-band, after the version gate, so the
   * player reads a reason rather than a failed upgrade.
   *
   * Nothing happens until the socket's first `hello`: a client on another
   * build is turned away before it can displace anybody's window.
   */
  attach(transport: Transport, player: Player | null, intent: ServerIntent | null): void {
    const client: Client = { transport, player, version: null, room: null, faction: null, gone: false }
    transport.onFrame((frame) => this.receive(client, intent, frame))
    transport.onClosed((reason) => this.closed(client, reason))
  }

  /** `GET /api/lobby`, as `player` (or nobody) sees it: open rooms newest first, and their own seat. */
  view(player: Player | null): LobbyView {
    const rooms = [...this.rooms.values()].filter((room) => !room.over).reverse()
    const held = player ? this.seatOf(player.id) : null
    return {
      rooms: rooms.map((room) => room.listing()),
      you: held ? { roomId: held.room.id, faction: held.faction, phase: held.room.phase } : null,
    }
  }

  /**
   * A room by id, while the server still holds it — including a room that is
   * over but whose sockets are still open (a settled match's clients are on
   * their end screens) or whose writes are still draining.
   */
  room(id: string): Room | undefined {
    return this.rooms.get(id)
  }

  /** Resolves once every room has written everything it has decided so far. */
  async idle(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((room) => room.idle()))
  }

  /**
   * Stop serving: every socket is closed and every hold let go, and the
   * answer resolves once every write already decided has landed.
   *
   * Nothing is ended or written on the way out. A room still live stays live
   * in the store, for the next server over the same database to `restore`;
   * its sockets are closed without a word, because to the window at the
   * other end this is a dropped connection, which it reconnects through.
   *
   * The database is not closed here: it belongs to whoever opened the
   * `Persistence`, and the lobby is one of several things reading it.
   */
  async dispose(): Promise<void> {
    // Latched first: the sockets closed below report closing afterwards, and a
    // lobby that has stopped must not read that as players walking out — it
    // would start holding their seats on a clock nobody is left to stop.
    this.disposed = true
    const rooms = [...this.rooms.values()]
    for (const room of rooms) room.dispose()
    this.rooms.clear()
    this.windows.clear()
    await Promise.all(rooms.map((room) => room.idle()))
  }

  private receive(client: Client, intent: ServerIntent | null, frame: JsonRpcFrame): void {
    if (client.gone || this.disposed) return
    if (client.room) return client.room.receive(client, frame)
    // Admitted and on its way to a seat — a keyed one waits on a hash —
    // so there is nothing it could say yet that a room would hear.
    if (client.version) return
    if (!('method' in frame)) return
    // Before it is placed, the only thing a socket can usefully say is which
    // build it is. The gate comes before anything else: a client on another
    // build diverges for innocent reasons, and a referee that accused it would
    // be naming somebody whose browser cached yesterday's bundle. Stated in the
    // server's own voice, because the reader is the client being turned away
    // and needs to see both hashes: a Worker deployed without its build id says
    // `dev` here, which is a server to redeploy rather than a page to reload.
    // An `init` is gated too, since an older client opens with one.
    if (frame.method !== RpcMethods.hello && frame.method !== RpcMethods.init) return
    const stated = (frame as JsonRpcNotification).params
    const reason = this.admission(intent, stated)
    if (reason) return this.refuse(client, reason)
    if (frame.method !== RpcMethods.hello) return
    // Both fields were read and checked by the gate a line ago.
    client.version = { protocol: Number(stated.protocol), build: String(stated.build) }
    this.place(client, intent)
  }

  /**
   * Why a socket asking for `intent` is turned away by what it `stated`
   * about itself, before any room is weighed.
   *
   * Opening, joining and watching start something on this server, so they
   * take this server's own build and protocol. Taking a seat back finishes
   * something that may have been started on the build before a deploy: any
   * protocol this server still serves will do, and the room it names decides
   * the build (`fits`).
   */
  private admission(intent: ServerIntent | null, stated: unknown): string | null {
    const refusal = versionRefusal(stated, this.version, SERVER_VOICES)
    if (!refusal || intent?.kind !== 'resume' || typeof stated !== 'object' || stated === null) return refusal
    const { protocol, build } = stated as Partial<PeerVersion>
    const served =
      typeof protocol === 'number' && protocol >= OLDEST_SERVED_PROTOCOL && protocol <= this.version.protocol
    return served && typeof build === 'string' && build.length > 0 ? null : refusal
  }

  /**
   * Why `client` cannot be put in `room`, or null when it can: a page plays
   * only in a room of its own build, whose rules it can replay.
   */
  private fits(client: Client, room: Room): string | null {
    const build = client.version!.build
    return build === room.version.build
      ? null
      : `That match was started on another version of TicTac (build ${room.version.build}; this page is ` +
          `running build ${build}), so this page cannot carry it on.`
  }

  /**
   * Resolve a socket's intent, once its build has been accepted.
   *
   * A key in a `resume` is a reconnection and goes its own way (`reclaim`).
   * Anything else from a signed-in player is a new window: the previous
   * window goes first, so that a match it abandoned is over — and its player
   * free — before the new intent is weighed against the one match they are
   * allowed.
   */
  private place(client: Client, intent: ServerIntent | null): void {
    if (!intent) return this.refuse(client, NO_INTENT)
    if (intent.kind === 'resume' && intent.roomId && intent.seatKey) {
      void this.reclaim(client, intent.roomId, intent.seatKey)
      return
    }
    const player = client.player
    // Weighed before the previous window is retired: a page that cannot play
    // in its player's match must not cut off the window that can.
    const kept = player ? this.seatOf(player.id) : null
    if (kept?.room.phase === 'playing') {
      const reason = this.fits(client, kept.room)
      if (reason) return this.refuse(client, reason)
    }
    if (player) this.supersede(player, client)

    const held = player ? this.seatOf(player.id) : null
    if (held) {
      held.room.takeBack(client, held.faction, intent.kind !== 'resume')
    } else {
      switch (intent.kind) {
        case 'open': {
          // In the map before anybody is seated, so that a socket which
          // vanishes the moment it is told where it sits leaves a room the
          // lobby can already find and sweep.
          const room = new Room(this.freshId(), this.version, this.roomOptions)
          this.rooms.set(room.id, room)
          room.open(client)
          this.log(`room ${room.id} opened by ${player?.name ?? 'an anonymous player'}`)
          break
        }
        case 'join': {
          const room = this.rooms.get(intent.roomId)
          if (!room || room.over) return this.refuse(client, GONE)
          if (room.version.build !== this.version.build) return this.refuse(client, OTHER_BUILD)
          if (room.phase !== 'waiting') {
            return this.refuse(client, 'That match already has two players — watch it instead.')
          }
          // Out of reach while the window rule holds — a player's second
          // window abandons the room their first one opened before this line
          // is reached — and kept because a kept match with one player on both
          // sides is the one thing the rosters must never see.
          if (player && room.seatOf(player.id) !== null) {
            return this.refuse(client, 'You cannot play both sides of a match.')
          }
          room.join(client)
          break
        }
        case 'watch': {
          const room = this.rooms.get(intent.roomId)
          if (!room || room.over) return this.refuse(client, GONE)
          if (room.version.build !== this.version.build) return this.refuse(client, OTHER_BUILD)
          room.watch(client)
          break
        }
        case 'resume':
          return this.refuse(client, 'You have no match in progress.')
      }
    }
    if (player && !client.gone) this.windows.set(player.id, client)
  }

  /**
   * Put a socket back in the seat whose key it presents: the same window,
   * reconnecting after its connection dropped or its server restarted.
   *
   * Not a new window, so no rule about new windows applies — nothing is
   * abandoned and no ticket is needed. The key is the proof, and it is
   * checked against the seat's hash after an `await`, so everything is
   * weighed again once the hash is in: the socket or the lobby may be gone,
   * the room over.
   */
  private async reclaim(client: Client, roomId: string, key: string): Promise<void> {
    const hash = await hashSeatKey(key)
    if (client.gone || this.disposed) return
    const room = this.rooms.get(roomId)
    if (!room || room.over) return this.refuse(client, GONE)
    const faction = room.seatFor(key, hash)
    if (faction === null) return this.refuse(client, NOT_YOURS)
    const reason = this.fits(client, room)
    if (reason) return this.refuse(client, reason)
    room.reclaim(client, faction, key)
    if (client.player) this.windows.set(client.player.id, client)
  }

  /**
   * Retire a player's previous window in favour of `client`.
   *
   * It is told why, in words it can show, and closed. A seat it held in a match
   * still being set up ends that room for whoever else is in it (`Room.leave`);
   * a seat in a match that is playing is left empty for `client` to take. A
   * seat still being set up that was only held — its window had dropped — is
   * abandoned the same way (`Room.abandon`): the new window starts afresh
   * either way.
   */
  private supersede(player: Player, client: Client): void {
    const previous = this.windows.get(player.id)
    if (previous && previous !== client) {
      this.windows.delete(player.id)
      previous.gone = true
      previous.transport.send({
        jsonrpc: '2.0',
        method: RpcMethods.abort,
        params: { reason: 'You opened TicTac in another window; this one was disconnected.', side: null },
      })
      previous.transport.close()
      const room = previous.room
      room?.leave(previous, true)
      if (room) this.sweep(room)
      this.log(`${player.name} moved to a new window`)
    }
    const held = this.seatOf(player.id)
    if (held && held.room.phase !== 'playing') {
      held.room.abandon(held.faction)
      this.sweep(held.room)
    }
  }

  private closed(client: Client, reason: string): void {
    if (client.gone || this.disposed) return
    client.gone = true
    if (client.player && this.windows.get(client.player.id) === client) this.windows.delete(client.player.id)
    const room = client.room
    room?.leave(client, false)
    if (room) this.sweep(room)
    this.log(`a client left: ${reason}`)
  }

  private refuse(client: Client, reason: string): void {
    this.log(`refusing a client: ${reason}`)
    client.gone = true
    client.transport.send({ jsonrpc: '2.0', method: RpcMethods.abort, params: { reason, side: null } })
    client.transport.close()
  }

  /** The seat a signed-in player holds in a room that is not over, if any. */
  private seatOf(playerId: string): { room: Room; faction: Faction } | null {
    for (const room of this.rooms.values()) {
      const faction = room.seatOf(playerId)
      if (faction !== null) return { room, faction }
    }
    return null
  }

  /**
   * Forget a room once nothing can reach it any more: over, nobody left in it,
   * and every write it decided on landed — `idle` answers for rooms in this
   * map, so a room leaves it only after its evidence is down.
   */
  private sweep(room: Room): void {
    if (!room.over || !room.empty) return
    void room.idle().then(() => {
      if (this.rooms.get(room.id) === room && room.empty) this.rooms.delete(room.id)
    })
  }

  /** A short id nobody can guess, and no room already has. */
  private freshId(): string {
    let id: string
    do id = toBase64Url(crypto.getRandomValues(new Uint8Array(9)))
    while (this.rooms.has(id))
    return id
  }
}
