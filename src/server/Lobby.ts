import { Faction } from '../config'
import { toBase64Url } from '../game/Base64Url'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../game/JsonRpc'
import type { LobbyView, ServerIntent } from '../game/Lobby'
import type { Transport } from '../game/Transport'
import { MY_VERSION, SERVER_VOICES, versionRefusal } from '../version'
import type { Player } from './Accounts'
import type { MatchStore } from './MatchStore'
import { Room, type Client, type RefereeVerdict, type RoomOptions } from './Room'
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
 * All of this is in memory. A room is a live `MatchHost` and a set of open
 * sockets, and neither survives the process; what does survive is every log a
 * room started, in the `MatchStore`, under the room's id.
 */

/** How long a signed-in player's seat is held after their socket drops mid-match. */
export const GRACE_MS = 120_000

export interface LobbyOptions {
  /** Where matches are written. Already migrated: see `Persistence`. */
  matches: MatchStore
  /** The rosters to check squads against and settle onto; without them nothing is kept. */
  rosters?: Rosters
  /** Called when a match is aborted on the referee's judgement. */
  onVerdict?: (verdict: RefereeVerdict) => void
  /** Called for anything worth a line in a server log. */
  log?: (message: string) => void
  /** How long a dropped signed-in seat is held; `GRACE_MS` unless a test says otherwise. */
  graceMs?: number
  /** Run `fn` after `ms`, answering a cancel. `setTimeout` unless a test is the clock. */
  schedule?: (fn: () => void, ms: number) => () => void
}

export class Lobby {
  /** Every room not yet swept: listed while it is not over, kept until its sockets and writes are done. */
  private readonly rooms = new Map<string, Room>()
  /** Each signed-in player's live window: the socket they were last placed with. */
  private readonly windows = new Map<string, Client>()
  /** What every room is opened with: the lobby's own options, and the way back to it. */
  private readonly roomOptions: RoomOptions
  private readonly log: (message: string) => void
  private disposed = false

  constructor(options: LobbyOptions) {
    this.log = options.log ?? ((message) => console.info(`[lobby] ${message}`))
    this.roomOptions = {
      matches: options.matches,
      rosters: options.rosters,
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
    const client: Client = { transport, player, room: null, faction: null, gone: false }
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
   * Stop serving: every socket is closed and every held seat let go.
   *
   * The database is not closed here: it belongs to whoever opened the
   * `Persistence`, and the lobby is one of several things reading it.
   */
  dispose(): void {
    // Latched first: the sockets closed below report closing afterwards, and a
    // lobby that has stopped must not read that as players walking out — it
    // would start holding their seats on a clock nobody is left to stop.
    this.disposed = true
    for (const room of this.rooms.values()) room.dispose()
    this.rooms.clear()
    this.windows.clear()
  }

  private receive(client: Client, intent: ServerIntent | null, frame: JsonRpcFrame): void {
    if (client.gone || this.disposed) return
    if (client.room) return client.room.receive(client, frame)
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
    const reason = versionRefusal((frame as JsonRpcNotification).params, MY_VERSION, SERVER_VOICES)
    if (reason) return this.refuse(client, reason)
    if (frame.method === RpcMethods.hello) this.place(client, intent)
  }

  /**
   * Resolve a socket's intent, once its build has been accepted.
   *
   * The previous window goes first, so that a match it abandoned is over —
   * and its player free — before the new intent is weighed against the one
   * match they are allowed.
   */
  private place(client: Client, intent: ServerIntent | null): void {
    if (!intent) return this.refuse(client, 'That link does not say which match to open, join or watch.')
    const player = client.player
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
          const room = new Room(this.freshId(), this.roomOptions)
          this.rooms.set(room.id, room)
          room.open(client)
          this.log(`room ${room.id} opened by ${player?.name ?? 'an anonymous player'}`)
          break
        }
        case 'join': {
          const room = this.rooms.get(intent.roomId)
          if (!room || room.over) return this.refuse(client, 'That match is gone.')
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
          if (!room || room.over) return this.refuse(client, 'That match is gone.')
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
   * Retire a player's previous window in favour of `client`.
   *
   * It is told why, in words it can show, and closed. A seat it held in a match
   * still being set up ends that room for whoever else is in it (`Room.leave`);
   * a seat in a match that is playing is left empty for `client` to take.
   */
  private supersede(player: Player, client: Client): void {
    const previous = this.windows.get(player.id)
    if (!previous || previous === client) return
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
