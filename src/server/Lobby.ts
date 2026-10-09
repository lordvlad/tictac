import { ENCOUNTER, Faction, SQUAD_SIZE } from '../config'
import { dealAliens } from '../core/Encounters'
import { toBase64Url } from '../game/Base64Url'
import { RpcMethods, type JsonRpcNotification } from '../game/JsonRpc'
import { defaultLoadout } from '../game/Loadout'
import type { LobbyRoom, LobbyView, Seated, ServerIntent } from '../game/Lobby'
import { RECORDING_VERSION, type Deployment, type RecordingHeader } from '../game/Recording'
import {
  RPC_ERRORS,
  SESSION_REPLACED,
  type Player,
  type RpcErrorCode,
  type RpcPush,
  type RpcPushes,
} from '../game/Rpc'
import { MY_VERSION, SERVER_VOICES, versionRefusal, type PeerVersion } from '../version'
import type { EncounterContact, EncounterOpened } from './EncounterPort'
import type { MatchStore } from './MatchStore'
import { hashSeatKey, Room, type Client, type RefereeVerdict, type RoomOptions } from './Room'
import type { RoomStore } from './RoomStore'
import type { Rosters } from './Rosters'

/**
 * The match server's rooms, and who is in which.
 *
 * A window holds one socket to the server for as long as it is on it
 * (`Session.ts`), and asks over it to enter a room — open one, join one,
 * watch one, or take back a seat (`src/game/Lobby.ts`) — and to leave it
 * again. Entering puts the socket in one room, as one seat or as a spectator,
 * and answers where (`Seated`); everything after that is the room's
 * (`Room.ts`): the same refereed conversation a match always had. A request
 * this lobby turns down is a `Refusal`, answered in words; the socket stays
 * where it was, connected.
 *
 * What the lobby owns is the two rules that span rooms, both about signed-in
 * players, since an anonymous socket has no identity to hold anything to:
 *
 * - **One match per player.** Whatever a player with a match in progress asks
 *   for, they are put back in their own seat (`redirected`).
 * - **One live window per player.** A socket signing in replaces the socket
 *   that player signed in with last, wherever it was (`bind`). The seat that
 *   socket held is held for the player like any dropped seat, and what
 *   happens to it next is the new window's to decide: taken back with its key
 *   — the same window, reconnecting — or, the moment the new window asks for
 *   anything else, carried over if it is being played (rebuilt from the log)
 *   and abandoned if it is still being set up, because a half-equipped
 *   loadout lives in the window that was equipping it and is not worth
 *   carrying between windows.
 *
 * A window that merely lost its connection is not a new window. Every seat
 * comes with a key (`Seated.seatKey`), and a socket presenting it takes that
 * seat back — signed in or not, in any phase — while the seat is held for it
 * after a drop.
 *
 * Anybody subscribed to the lobby is sent its view whenever anything in it
 * changes (`subscribe`), so no window polls.
 *
 * **Rooms survive the server.** Every room is written down as it changes
 * (`RoomStore`), and a server starting over the same database takes them all
 * up again (`restore`) before it accepts a socket: the seats are held, the
 * match is refought from its log, and each window reconnects with its key as
 * if its wifi had dropped for a moment. That server may be a newer build. A
 * room keeps the build it was opened under, and only a page on that build can
 * take a seat in it back, so a deploy lets every match in progress finish on
 * the bundle it started on, while opening, joining and watching require the
 * server's own build.
 *
 * **A fight on the road is a room the server opens** (`openEncounter`): the
 * player's seat in it is *reserved* for them until the join window closes and
 * then the AI's, a seat they hold is the AI's the moment its grace runs out,
 * and nobody but the player ever sees the room. While the AI has their seat
 * the player is refused it, and may only watch.
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
  /** The server's clock, in ms (`clock/now`); the wall clock unless a test turns it. */
  now?: () => number
  /** The seed of a fight's map: system randomness, unless a test needs the fight to be the same one twice. */
  mapSeed?: () => number
  /** Called when a player takes a fight the server kept for them, before the AI did (`room`'s id). */
  onEncounterTaken?: (roomId: string) => void
}

/**
 * A request turned down, in words the player reads, under the code its
 * window acts on (`RPC_ERRORS`). Thrown by the lobby and the session alike,
 * and answered as the request's error.
 */
export class Refusal extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
  ) {
    super(message)
  }
}

const GONE = 'That match is gone.'
const NOT_YOURS = 'That seat is not yours.'
const OTHER_BUILD = 'That match was started on another version of TicTac, and only its own players can finish it.'
const IN_A_ROOM = 'Leave the match you are in first.'
const AI_HAS_IT = 'The AI is playing that seat now.'

const LOBBY_CHANGED = 'tictac/api/lobby/changed' satisfies RpcPush
const SESSION_REPLACED_PUSH = 'tictac/api/session/replaced' satisfies RpcPush

export class Lobby {
  /** The build this server runs, which opening, joining and watching require. */
  readonly version: PeerVersion
  /** Every room not yet swept: listed while it is not over, kept until its sockets and writes are done. */
  private readonly rooms = new Map<string, Room>()
  /** Every socket being served, in a room or not: what a shutdown closes. */
  private readonly clients = new Set<Client>()
  /** Each signed-in player's live window: the socket bound to them last. */
  private readonly windows = new Map<string, Client>()
  /**
   * Every socket subscribed to the lobby, with the view it was sent last, as
   * sent: a change that leaves somebody's view as it was is not sent again.
   */
  private readonly subscribers = new Map<Client, string>()
  /** True while a push is waiting for the current burst of changes to finish. */
  private pushing = false
  /** What every room is opened with: the lobby's own options, and the way back to it. */
  private readonly roomOptions: RoomOptions
  private readonly store: { matches: MatchStore; rooms: RoomStore }
  private readonly rosters: Rosters | undefined
  private readonly now: () => number
  private readonly mapSeed: () => number
  private readonly onEncounterTaken: ((roomId: string) => void) | undefined
  private readonly log: (message: string) => void
  private disposed = false

  constructor(options: LobbyOptions) {
    this.log = options.log ?? ((message) => console.info(`[lobby] ${message}`))
    this.version = options.version ?? MY_VERSION
    this.store = { matches: options.matches, rooms: options.rooms }
    this.rosters = options.rosters
    this.now = options.now ?? (() => Date.now())
    this.mapSeed = options.mapSeed ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]!)
    this.onEncounterTaken = options.onEncounterTaken
    this.roomOptions = {
      matches: options.matches,
      rooms: options.rooms,
      rosters: options.rosters,
      serverVersion: this.version,
      onVerdict: options.onVerdict,
      now: this.now,
      log: this.log,
      graceMs: options.graceMs ?? GRACE_MS,
      schedule:
        options.schedule ??
        ((fn, ms) => {
          const timer = setTimeout(fn, ms)
          return () => clearTimeout(timer)
        }),
      onChanged: () => this.changed(),
      onOver: (room) => {
        this.sweep(room)
        this.changed()
      },
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
   * Open the fight a contact on the road makes (`ITEM-048`, GDD-WORLD §5.4),
   * or say why there is none; resolves once the room exists and the player,
   * if they are online, has been told.
   *
   * The party is the first `SQUAD_SIZE` active members by slot who are not in
   * the medical bay. A member deployed in a live room would be excluded too,
   * but a player holds one seat at a time (`seatOf`), so such a member can
   * only belong to a player who is busy, and that is a pass in itself. The
   * header is composed *from* the roster rows, which is what lets the room's
   * check of the squad against the roster (`Room.verifyRosters`) pass byte
   * for byte; nothing can change a row between the two, since no live room
   * holds these members and what the player's last match decided has landed
   * (`idle`).
   *
   * The seed of the map comes from system randomness, not from the aliens'
   * seed: the map is not part of what the contact rolled. A player with a
   * window bound is told and has `ENCOUNTER.joinWindowMs` to take the fight;
   * one without has none, and the AI plays their side from the start.
   */
  async openEncounter(contact: EncounterContact): Promise<EncounterOpened> {
    const { player } = contact
    if (!this.rosters) throw new Error('this lobby keeps no rosters, so there is no squad to find on the road')
    await this.idle()
    const party = (await this.rosters.active(player.id))
      .filter((member) => member.downtime === 0)
      .slice(0, SQUAD_SIZE)
    if (this.disposed) throw new Error('the lobby has stopped')
    // Weighed after every wait, and acted on without another: nothing may
    // seat the player between this check and the room being in the map.
    if (this.seatOf(player.id)) return { opened: false, passedFor: 'busy' }
    if (party.length === 0) return { opened: false, passedFor: 'nobodyFit' }

    const kit = defaultLoadout(party.length)
    const humans: Deployment[] = party.map((member, i) => ({
      characterId: member.characterId,
      sheet: member.sheet,
      loadout: kit[i]!,
      state: { hp: member.hp, fatigue: member.fatigue },
    }))
    const aliens = dealAliens(contact.alienSeed, Math.min(SQUAD_SIZE, Math.max(1, party.length + contact.sizeOffset)))
    const seed = this.mapSeed()
    const header: RecordingHeader = {
      version: RECORDING_VERSION,
      seed,
      seedLabel: String(seed),
      source: 'live',
      createdAt: new Date(this.now()).toISOString(),
      turnCap: null,
      squads: { [Faction.Blue]: humans, [Faction.Red]: aliens },
      controllers: { [Faction.Blue]: 'human', [Faction.Red]: 'ai' },
    }

    const window = this.windows.get(player.id)
    const joinBy = window && !window.gone ? this.now() + ENCOUNTER.joinWindowMs : null
    const room = new Room(this.freshId(), this.version, this.roomOptions)
    this.rooms.set(room.id, room)
    room.openEncounter(header, player, joinBy)
    this.log(
      `room ${room.id}: ${player.name} met ${aliens.length} aliens on the road with ${party.length}, ` +
        (joinBy === null ? 'offline, the AI plays their side' : `online, theirs to take until ${joinBy}`),
    )
    if (joinBy !== null) {
      this.tell(player.id, 'tictac/api/encounter/started', {
        roomId: room.id,
        joinBy,
        at: contact.at,
        place: contact.place,
      })
    }
    this.changed()
    return { opened: true, roomId: room.id, aliens: aliens.length, joinBy }
  }

  /** A socket connected: served from now on, and closed with the server, whatever it goes on to ask. */
  arrive(client: Client): void {
    if (this.disposed) {
      client.gone = true
      client.transport.close()
      return
    }
    this.clients.add(client)
  }

  /**
   * Turn a socket away for good, closing it with a reason it can show.
   *
   * Only the version gate does this (`Session.ts`), and a protocol-6 page
   * whose seat cannot be taken back, which knows no other way to be told:
   * everything asked over a socket that passed the gate is answered in-band
   * and leaves it open.
   */
  turnAway(client: Client, reason: string): void {
    this.log(`turning a client away: ${reason}`)
    client.transport.send({ jsonrpc: '2.0', method: RpcMethods.abort, params: { reason, side: null } })
    this.forget(client)
    client.transport.close()
  }

  /** The socket closed, for whatever reason: a seat it held is held for its window. */
  closed(client: Client, reason: string): void {
    if (client.gone || this.disposed) return
    this.forget(client)
    this.log(`a client left: ${reason}`)
  }

  /**
   * Bind a socket to the player it just signed in as, retiring that player's
   * previous window (`replace`).
   *
   * Refused when the player has a match being played in a room this page's
   * build cannot carry on (`fits`): retiring the window that can would leave
   * that match to nobody. The page stays as it was, and is told why.
   */
  bind(client: Client, player: Player): void {
    if (client.gone || this.disposed) return
    const kept = this.seatOf(player.id)
    if (kept?.room.phase === 'playing') {
      const reason = this.fits(client, kept.room)
      if (reason) throw new Refusal(RPC_ERRORS.conflict, reason)
    }
    this.unbind(client)
    client.player = player
    this.replace(player, client)
    this.windows.set(player.id, client)
    this.changed()
  }

  /** A socket signed out: anonymous again. A seat it holds stays its player's. */
  unbind(client: Client): void {
    const player = client.player
    if (!player) return
    if (this.windows.get(player.id) === client) this.windows.delete(player.id)
    client.player = null
    this.changed()
  }

  /**
   * Push `params` to `playerId`'s window, if one is bound to them: the one
   * window a player has (`replace`), which is where their squad is shown.
   */
  tell<P extends RpcPush>(playerId: string, method: P, params: RpcPushes[P]): void {
    const window = this.windows.get(playerId)
    if (!window || window.gone) return
    window.transport.send({ jsonrpc: '2.0', method, params: { ...params } })
  }

  /** The lobby as `player` (or nobody) sees it: open rooms newest first, and their own seat. */
  view(player: Player | null): LobbyView {
    return { rooms: this.listings(), you: this.youOf(player) }
  }

  /**
   * The lobby's view for `client`, and from now on the view again whenever
   * it changes (`tictac/api/lobby/changed`), until `unsubscribe` or the
   * socket goes.
   */
  subscribe(client: Client): LobbyView {
    const view = this.view(client.player)
    this.subscribers.set(client, JSON.stringify(view))
    return view
  }

  unsubscribe(client: Client): void {
    this.subscribers.delete(client)
  }

  /**
   * Put a socket where `intent` asks — a seat, or a spectator's place — and
   * tell it where with `answer`, before anything of the room reaches it.
   *
   * A refusal is thrown (`Refusal`), and leaves the socket where it was.
   * Opening, joining and watching start something on this server, so they
   * take its own build; taking a seat back may finish something started on
   * the build before a deploy, and the room it names decides (`fits`).
   */
  async enter(client: Client, intent: ServerIntent, answer: (seated: Seated) => void): Promise<void> {
    const current = client.room
    if (current && !current.over) throw new Refusal(RPC_ERRORS.conflict, IN_A_ROOM)
    // Off the end screen of a match that is over, which is as good as left.
    if (current) this.leave(client)
    if (intent.kind === 'resume' && intent.roomId && intent.seatKey) {
      return this.reclaim(client, intent.roomId, intent.seatKey, answer)
    }
    if (intent.kind !== 'resume') {
      const refusal = versionRefusal(client.version, this.version, SERVER_VOICES)
      if (refusal) throw new Refusal(RPC_ERRORS.conflict, refusal)
    }
    this.place(client, intent, answer)
  }

  /**
   * Stand a socket up from its room. A spectator goes; a seat in a room still
   * live is held for its window, exactly as if the socket had dropped
   * (`Room.leave`). The socket stays connected, in the lobby.
   */
  leave(client: Client): void {
    const room = client.room
    if (!room) return
    room.leave(client)
    this.sweep(room)
    this.changed()
  }

  /** A match frame from a socket: its room's business (`Room.receive`), when it is in one. */
  receive(client: Client, frame: JsonRpcNotification): void {
    const room = client.room
    if (!room || client.gone || this.disposed) return
    const { phase, turn } = room
    room.receive(client, frame)
    if (room.phase !== phase || room.turn !== turn) this.changed()
  }

  /**
   * A room by id, while the server still holds it — including a room that is
   * over but whose sockets are still on their end screens, or whose writes
   * are still draining.
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
    for (const client of this.clients) client.transport.close()
    this.clients.clear()
    this.subscribers.clear()
    this.windows.clear()
    this.rooms.clear()
    await Promise.all(rooms.map((room) => room.idle()))
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
   * Resolve any intent but a keyed `resume`.
   *
   * From a signed-in player this is their newest window asking for
   * something, so their previous window goes first (`supersede`): a match
   * it abandoned is over — and its player free — before the intent is
   * weighed against the one match they are allowed.
   */
  private place(client: Client, intent: ServerIntent, answer: (seated: Seated) => void): void {
    const player = client.player
    // Weighed before the previous window is retired: a page that cannot play
    // in its player's match must not cut off the window that can.
    const kept = player ? this.seatOf(player.id) : null
    if (kept?.room.phase === 'playing') {
      const reason = this.fits(client, kept.room)
      if (reason) throw new Refusal(RPC_ERRORS.conflict, reason)
    }
    // A takeover that names a match is for that match. Its prompt may be
    // stale — the fight it offered is over and another has begun — and the
    // player is not put in a fight they were never asked about.
    if (kept && intent.kind === 'resume' && intent.roomId && intent.roomId !== kept.room.id) {
      throw new Refusal(RPC_ERRORS.gone, GONE)
    }
    // Turned down before their previous window is retired, like a build that
    // cannot play: the fight is the AI's now, and is not taken back from it.
    // Watching it is all that is left to ask for.
    if (
      kept &&
      kept.room.controlOf(kept.faction) === 'ai' &&
      !(intent.kind === 'watch' && intent.roomId === kept.room.id)
    ) {
      throw new Refusal(RPC_ERRORS.conflict, AI_HAS_IT)
    }
    if (player) this.supersede(player, client)

    const held = player ? this.seatOf(player.id) : null
    let room: Room
    let seated: Seated
    if (held) {
      room = held.room
      const control = room.controlOf(held.faction)
      if (control === 'ai') {
        seated = room.watch(client)
      } else {
        seated = room.takeBack(client, held.faction, intent.kind !== 'resume')
        if (control === 'reserved') this.onEncounterTaken?.(room.id)
      }
    } else {
      switch (intent.kind) {
        case 'open': {
          // In the map before anybody is seated, so that a socket which
          // vanishes the moment it is told where it sits leaves a room the
          // lobby can already find and sweep.
          room = new Room(this.freshId(), this.version, this.roomOptions)
          this.rooms.set(room.id, room)
          seated = room.open(client)
          this.log(`room ${room.id} opened by ${player?.name ?? 'an anonymous player'}`)
          break
        }
        case 'join': {
          room = this.joinable(intent.roomId)
          if (room.phase !== 'waiting') {
            throw new Refusal(RPC_ERRORS.conflict, 'That match already has two players — watch it instead.')
          }
          // Out of reach while the window rule holds — a player's newest
          // window abandons the room their previous one opened before this
          // line is reached — and kept because a kept match with one player
          // on both sides is the one thing the rosters must never see.
          if (player && room.seatOf(player.id) !== null) {
            throw new Refusal(RPC_ERRORS.conflict, 'You cannot play both sides of a match.')
          }
          seated = room.join(client)
          break
        }
        case 'watch':
          room = this.joinable(intent.roomId)
          seated = room.watch(client)
          break
        case 'resume':
          throw new Refusal(RPC_ERRORS.gone, 'You have no match in progress.')
      }
    }
    if (player) this.windows.set(player.id, client)
    answer(seated)
    room.catchUp(client)
    this.changed()
  }

  /** The room `id` names, for joining or watching: still going, and of this server's build. */
  private joinable(id: string): Room {
    const room = this.rooms.get(id)
    if (!room || room.over || room.encounter) throw new Refusal(RPC_ERRORS.gone, GONE)
    if (room.version.build !== this.version.build) throw new Refusal(RPC_ERRORS.conflict, OTHER_BUILD)
    return room
  }

  /**
   * Put a socket back in the seat whose key it presents: the same window,
   * reconnecting after its connection dropped or its server restarted.
   *
   * Not a new window, so no rule about new windows applies and nothing is
   * abandoned. The key is the proof, and it is checked against the seat's
   * hash after an `await`, so everything is weighed again once the hash is
   * in: the socket or the lobby may be gone, the room over.
   */
  private async reclaim(
    client: Client,
    roomId: string,
    key: string,
    answer: (seated: Seated) => void,
  ): Promise<void> {
    const hash = await hashSeatKey(key)
    if (client.gone || this.disposed) return
    const room = this.rooms.get(roomId)
    if (!room || room.over) throw new Refusal(RPC_ERRORS.gone, GONE)
    const faction = room.seatFor(key, hash)
    if (faction === null) throw new Refusal(RPC_ERRORS.notYours, NOT_YOURS)
    if (room.controlOf(faction) === 'ai') throw new Refusal(RPC_ERRORS.conflict, AI_HAS_IT)
    const reason = this.fits(client, room)
    if (reason) throw new Refusal(RPC_ERRORS.conflict, reason)
    const seated = room.reclaim(client, faction, key)
    if (client.player) this.windows.set(client.player.id, client)
    answer(seated)
    room.catchUp(client)
    this.changed()
  }

  /**
   * Retire a player's previous window in favour of `client`: it is told why,
   * in words it can show, and closed — and it must not reconnect, since its
   * player is playing somewhere else now. A seat it held is held for the
   * player like any dropped seat (`Room.leave`), for the window that replaced
   * it to take back with its key if it is that same window reconnecting
   * (`reclaim`), or to carry over or abandon as the player's newest window
   * once it asks for something (`supersede`).
   */
  private replace(player: Player, client: Client): void {
    const previous = this.windows.get(player.id)
    if (!previous || previous === client) return
    this.windows.delete(player.id)
    if (previous.version && previous.version.protocol < this.version.protocol) {
      // Protocol 6 has no `session/replaced`, and is told the way it always
      // was. Goes with the protocol-6 path in `Session.ts`.
      previous.transport.send({
        jsonrpc: '2.0',
        method: RpcMethods.abort,
        params: { reason: SESSION_REPLACED, side: null },
      })
    } else {
      previous.transport.send({ jsonrpc: '2.0', method: SESSION_REPLACED_PUSH, params: { reason: SESSION_REPLACED } })
    }
    this.forget(previous)
    previous.transport.close()
    this.log(`${player.name} moved to a new window`)
  }

  /**
   * A player's newest window asked for a room: their previous window, if one
   * is somehow still bound, is retired, and a seat in a match still being set
   * up that no window of theirs holds any more is abandoned (`Room.abandon`).
   * A seat in a match being played is left for `place` to put them back in.
   */
  private supersede(player: Player, client: Client): void {
    this.replace(player, client)
    const held = this.seatOf(player.id)
    if (held && held.room.phase !== 'playing') {
      held.room.abandon(held.faction)
      this.sweep(held.room)
    }
  }

  /** Stop serving a socket — it closed, was turned away or was replaced — and hold a seat it had. */
  private forget(client: Client): void {
    client.gone = true
    this.clients.delete(client)
    this.subscribers.delete(client)
    if (client.player && this.windows.get(client.player.id) === client) this.windows.delete(client.player.id)
    const room = client.room
    if (room) {
      room.leave(client)
      this.sweep(room)
    }
    this.changed()
  }

  /** Open rooms, newest first, as the lobby lists them. */
  private listings(): LobbyRoom[] {
    return [...this.rooms.values()]
      .filter((room) => !room.over && !room.encounter)
      .reverse()
      .map((room) => room.listing())
  }

  /** The seat `player` holds, as their own view of the lobby shows it. */
  private youOf(player: Player | null): LobbyView['you'] {
    const held = player ? this.seatOf(player.id) : null
    if (!held) return null
    const { room, faction } = held
    return { roomId: room.id, faction, phase: room.phase, control: room.controlOf(faction)!, joinBy: room.joinByOf(faction) }
  }

  /**
   * Something a lobby view shows may have changed. Every subscriber whose
   * view did is sent it once the burst of changes this is part of is over —
   * one window replacing another retires a socket, holds a seat and ends a
   * room in one go, and that is one push rather than three.
   */
  private changed(): void {
    if (this.pushing || this.subscribers.size === 0) return
    this.pushing = true
    queueMicrotask(() => {
      this.pushing = false
      this.push()
    })
  }

  private push(): void {
    if (this.disposed) return
    const rooms = this.listings()
    for (const [client, last] of this.subscribers) {
      const view: LobbyView = { rooms, you: this.youOf(client.player) }
      const shown = JSON.stringify(view)
      if (shown === last) continue
      this.subscribers.set(client, shown)
      client.transport.send({ jsonrpc: '2.0', method: LOBBY_CHANGED, params: { ...view } })
    }
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
