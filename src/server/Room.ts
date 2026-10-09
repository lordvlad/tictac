import { ENCOUNTER, Faction, FACTION_INFO, FACTIONS, SQUAD_SIZE } from '../config'
import { sanitizeSheet } from '../core/Characters'
import { isCommand } from '../ecs/systems/CommandSystem'
import { toBase64Url } from '../game/Base64Url'
import type { SeatControl } from '../game/Encounter'
import { frameOf, messageOf, type JsonRpcFrame, type JsonRpcNotification } from '../game/JsonRpc'
import type { LobbyRoom, LobbySeat, RoomPhase, Seated } from '../game/Lobby'
import { carriedOut, settlement, winnerOf, type UnitFate } from '../game/MatchEnd'
import type { NetworkMessage } from '../game/NetworkManager'
import type { RecordedEvent, RecordingHeader } from '../game/Recording'
import type { Player } from '../game/Rpc'
import { compareDigests, type Divergence, type StateDigest } from '../game/StateDigest'
import { loopback, type Transport } from '../game/Transport'
import { MatchHost } from '../sim/MatchHost'
import type { PeerVersion } from '../version'
import { AiSeat } from './AiSeat'
import type { MatchStore, StoredMatch } from './MatchStore'
import type { RoomStore, StoredRoom, StoredSeat, VerifiedSide } from './RoomStore'
import type { Rosters } from './Rosters'

/**
 * One room of the lobby (`Lobby.ts`): two seats, any number of spectators, and
 * a third recomputation of the match they play.
 *
 * **A witness, not an authority.** Clients resolve every intent themselves,
 * locally and instantly, exactly as they do in an unrefereed match; the referee
 * refights the same stream at its own pace. It is not in the data path, so it
 * costs no latency, and a match plays on unwatched when there is no referee at
 * all ([RFC-0001](../../docs/design/rfc/0001-referee-and-transports.md) §2).
 *
 * What a third party adds is **attribution**. Two peers can already notice that
 * they disagree — the state digest exchanged at every handover says so — but
 * neither can prove which of them is wrong, because a disagreement is
 * symmetric. A third recomputation makes it two against one.
 *
 * What it cannot see is worth stating as plainly: a maphack is a *read*, and no
 * recomputation observes a read. Nor can it see anything that happened before
 * the first intent. Both are accepted costs of the decision that nothing is
 * secret at the protocol level.
 *
 * It also does the jobs that have nothing to do with cheating, and are the
 * reason to want one anyway: the log outlives the tab it was played in
 * (persistence), a player who lost their tab is rebuilt from that log (a seat
 * taken back), and anybody else can be rebuilt from it too (a spectator).
 *
 * Who sits where is settled by the lobby before a socket ever reaches a room,
 * so a room never has to guess: a seat is a socket, and nothing a seat says is
 * accepted from anywhere else. A seat that loses its socket is held for the
 * window that had it, which proves itself with the seat's key.
 *
 * **A room outlives its server.** Every transition is written down
 * (`RoomStore`) behind the match log, so a restarted server — or a new build
 * of it, deployed while the match was being played — holds the same seats
 * again (`restore`) and rebuilds its referee by refighting the log. A server
 * on another build than the room's cannot tell a foul from a rules change, so
 * it judges such a room only until the first disagreement and witnesses it
 * from then on (`witness`).
 *
 * **An encounter room** is the one a server opens itself, for a fight on the
 * road (`openEncounter`, `ITEM-048`): already playing, unlisted, and never
 * ended for want of a human. Every seat has a controller (`SeatControl`) —
 * the player's window, the AI, or *reserved*: kept for a player who has not
 * arrived, until a deadline — and the AI sits down in any seat nobody is
 * going to. It is a client of the room like any window (`AiSeat`), so what it
 * sends is judged the way a human's is. Whose a seat *is* stays on the seat
 * (`player`) whoever moves it, because that is whose roster the match settles.
 */

/** What the referee decided about a match, for a caller that wants to watch. */
export interface RefereeVerdict {
  /** The room's id, which is also the match's id in the `MatchStore`. */
  matchId: string
  /** The side whose state disagreed, or null when the referee cannot tell. */
  side: Faction | null
  reason: string
  found: readonly Divergence[]
}

/**
 * One socket, as the server sees it.
 *
 * Made by the session layer when the socket connects (`Session.ts`), and in
 * at most one room at a time: it can sit in the lobby, take a seat or watch,
 * stand up again and stay connected. `gone` latches the moment the server
 * stops listening to it — it closed, it was turned away at the version gate,
 * or a newer window of the same player replaced it — because a socket the
 * server closed itself may still report closing afterwards, and that late
 * report must not be read as the player walking out of their match.
 */
export interface Client {
  readonly transport: Transport
  /**
   * The player behind the socket: the one it signed in as, or the one whose
   * seat it proved its own by presenting that seat's key. Null for an
   * anonymous socket.
   */
  player: Player | null
  /** What its first `hello` stated, once that passed the gate; null before. */
  version: PeerVersion | null
  room: Room | null
  /** The seat this socket holds in `room`, or null for a spectator. */
  faction: Faction | null
  gone: boolean
}

export interface RoomOptions {
  /** Where matches are written. Already migrated: see `Persistence`. */
  matches: MatchStore
  /** Where the room itself is written, so that a restarted server can hold it again. */
  rooms: RoomStore
  /**
   * The rosters to check squads against and write results onto.
   *
   * Optional: a referee without one still watches, relays and records, it
   * simply keeps nobody's squad. That is what an anonymous match is.
   */
  rosters?: Rosters
  /** The build this server runs: a room opened under any other is witnessed rather than judged once it disagrees. */
  serverVersion: PeerVersion
  /** Called when a match is aborted on the referee's judgement, after everybody in it has been told. */
  onVerdict?: (verdict: RefereeVerdict) => void
  /** Called for anything worth a line in a server log. */
  log: (message: string) => void
  /** How long a seat is held for its window after its socket drops. */
  graceMs: number
  /** Run `fn` after `ms`; the answer cancels it. Injected so a test can be the clock. */
  schedule: (fn: () => void, ms: number) => () => void
  /** The server's clock, in ms (`clock/now`): what a reserved seat's deadline is read against. */
  now: () => number
  /** Called when what a lobby view shows changes without a frame to say so: a seat passing to the AI on a timer. */
  onChanged: () => void
  /**
   * Called the moment the room is over (settled or aborted), and once more
   * if a settled room is then aborted — which sends its sockets out of it.
   */
  onOver: (room: Room) => void
}

interface Seat {
  readonly player: Player | null
  /** Null while the seat is held open for its window to come back to. */
  client: Client | null
  /** Cancels the hold, while one is running. */
  grace: (() => void) | null
  /**
   * What takes the seat back. The key itself from the moment this server
   * mints it; for a seat restored from the store only the hash the store
   * kept, until the window holding the key presents it.
   */
  key: { readonly plain: string } | { readonly hash: string }
  /** Who moves it now. The seat's `player` is whose it *is*, whoever that is. */
  control: SeatControl
  /** The server's clock, in ms, when a `reserved` seat passes to the AI; null otherwise. */
  joinBy: number | null
  /** Cancels the deadline of a reserved seat, while one is running. */
  deadline: (() => void) | null
  /** The AI sitting in the seat, while `control` is `ai`; its end of the loopback is `client`. */
  ai: AiSeat | null
}

export class Room {
  private phaseNow: RoomPhase = 'waiting'
  private readonly seats: Record<Faction, Seat | null> = { [Faction.Blue]: null, [Faction.Red]: null }
  private readonly spectators = new Set<Client>()

  private host: MatchHost | null = null
  private header: RecordingHeader | null = null
  private aborted = false
  private settled = false
  private judging = true
  private encounterRoom = false

  /**
   * Every intent the referee accepted, numbered as the store numbers them.
   *
   * The store has the same list, and this copy exists only for timing: a
   * socket that is handed the log has to receive it *before* the next intent
   * relayed to it, and a read from the database is asynchronous while a relay
   * is not. The numbering cannot drift from the store's, because the store
   * numbers an event by counting the ones before it and the writes drain in
   * the order the events were accepted (`enqueue`); a write that fails ends
   * the match, so a log the store did not keep is never handed out for long.
   * A restored room starts from the store's own list.
   */
  private readonly events: RecordedEvent[] = []

  /**
   * Who is playing which side, once their squad has been checked against the
   * roster this server keeps. Null for a side that is anonymous, or whose
   * squad has not been vouched for.
   */
  private sides: Record<Faction, VerifiedSide | null> = {
    [Faction.Blue]: null,
    [Faction.Red]: null,
  }

  /**
   * Everything this referee has to write, in the order it decided to write it.
   *
   * The database is asynchronous and `MatchHost` is not, which is the whole
   * reason this exists: judging a frame must not wait on a disk, and two
   * writes must not race each other into a log whose numbering is its meaning.
   * So frames are judged synchronously, in arrival order, and every write is
   * appended to one chain that drains in that same order.
   *
   * A write that fails ends the match. A referee that could not write down
   * what it saw has no evidence, and a match with no evidence is one nobody
   * can adjudicate afterwards.
   */
  private work: Promise<void> = Promise.resolve()

  constructor(
    readonly id: string,
    /** The build and protocol the room was opened under; only a page on the same build plays in it. */
    readonly version: PeerVersion,
    private readonly options: RoomOptions,
    readonly createdAt: string = new Date().toISOString(),
  ) {}

  get phase(): RoomPhase {
    return this.phaseNow
  }

  /**
   * Settled or aborted: unlisted, and nobody's seat any more.
   *
   * A settled room keeps its sockets — both clients are on their end screens,
   * worked out locally — and keeps relaying and recording whatever they still
   * say, because nothing about a result depends on the referee going deaf. An
   * aborted one listens to nothing.
   */
  get over(): boolean {
    return this.settled || this.aborted
  }

  /** False once a room opened under another build has disagreed with this server's rules (`witness`). */
  get judged(): boolean {
    return this.judging
  }

  /** True once no window is left in the room, seated or watching: the AI is the server's own and keeps nothing alive. */
  get empty(): boolean {
    const seated = FACTIONS.some((faction) => {
      const seat = this.seats[faction]
      return seat?.client && !seat.ai
    })
    return !seated && this.spectators.size === 0
  }

  /** A fight the server opened for a player on the road (`openEncounter`): unlisted, and the AI plays on where a human leaves. */
  get encounter(): boolean {
    return this.encounterRoom
  }

  /** Who moves `faction`'s seat now, or null when nobody sits there. */
  controlOf(faction: Faction): SeatControl | null {
    return this.seats[faction]?.control ?? null
  }

  /** When a reserved seat passes to the AI, on the server's clock; null for a seat that is not reserved. */
  joinByOf(faction: Faction): number | null {
    return this.seats[faction]?.joinBy ?? null
  }

  /** The seat a signed-in player holds here, while the room is not over. */
  seatOf(playerId: string): Faction | null {
    if (this.over) return null
    for (const faction of FACTIONS) {
      if (this.seats[faction]?.player?.id === playerId) return faction
    }
    return null
  }

  /**
   * The seat `key` takes back, or null when it fits neither. `hash` is the
   * key's own (`hashSeatKey`), which is all a restored seat can be checked
   * against until its key has been presented once.
   */
  seatFor(key: string, hash: string): Faction | null {
    for (const faction of FACTIONS) {
      const held = this.seats[faction]?.key
      if (held && ('plain' in held ? same(held.plain, key) : same(held.hash, hash))) return faction
    }
    return null
  }

  /** The referee's own fingerprint of the match, for tests and for an audit. */
  digest(): StateDigest | null {
    return this.host?.digest() ?? null
  }

  /**
   * Resolves once everything decided so far has been written — including
   * whatever those writes decided in turn, such as the delete a failed write
   * queues by ending the room.
   *
   * For a caller that wants to read what the referee wrote — a test, or a
   * shutdown — rather than for the referee itself, which never waits.
   */
  async idle(): Promise<void> {
    let work: Promise<void>
    do {
      work = this.work
      await work
    } while (work !== this.work)
  }

  /** The turn in force, once the match is playing. */
  get turn(): number | null {
    return this.host ? this.host.turnNumber : null
  }

  /** The room as the lobby lists it. */
  listing(): LobbyRoom {
    const seat = (faction: Faction): LobbySeat | null => {
      const held = this.seats[faction]
      return held ? { name: held.player?.name ?? null, connected: held.client !== null } : null
    }
    return {
      id: this.id,
      phase: this.phaseNow,
      blue: seat(Faction.Blue)!,
      red: seat(Faction.Red),
      spectators: this.spectators.size,
      turn: this.turn,
      createdAt: this.createdAt,
    }
  }

  /**
   * Seat the player who opened the room. The opener is always Blue, because
   * the opener is the side that announces the match (`hostMatch`).
   */
  open(client: Client): Seated {
    const seated = this.take(client, Faction.Blue, false, mintSeatKey())
    this.persist()
    return seated
  }

  /** Take the Red seat. The lobby has already checked the room is `waiting`. */
  join(client: Client): Seated {
    this.phaseNow = 'deploying'
    const seated = this.take(client, Faction.Red, false, mintSeatKey())
    this.persist()
    return seated
  }

  /**
   * Open a fight the server composed on the road (`ITEM-048`): the match
   * already playing from `header`, with `player` as Blue and the game's own
   * aliens as Red.
   *
   * Blue is kept for `player` until `joinBy` (the server's clock, in ms) and
   * the AI plays it after; null is a player who is not here to be asked, and
   * the AI sits down at once. Red is the AI's from the start. Both seats are
   * set before the match starts, and the room never waits for a host to state
   * its opening (`start` is otherwise Blue's `matchHeader`): nobody's window
   * is in it, so there is nobody to ask.
   */
  openEncounter(header: RecordingHeader, player: Player, joinBy: number | null): void {
    this.encounterRoom = true
    this.seats[Faction.Blue] = newSeat(player, { plain: mintSeatKey() })
    this.seats[Faction.Red] = newSeat(null, { plain: mintSeatKey() })
    this.start(header)
    this.sitAi(Faction.Red)
    if (joinBy === null) this.sitAi(Faction.Blue)
    else this.reserve(Faction.Blue, joinBy)
  }

  /**
   * Take up a room a previous server wrote down, with nobody in it yet: every
   * seat a player held is held from now for the grace period, for its window
   * to come back to with its key (`reclaim`). A seat the AI held is the AI's
   * again, from the log, and one kept for a player (`reserved`) is kept until
   * the deadline it had (`resume`).
   *
   * A match already playing is rebuilt the way a rejoining client rebuilds
   * it, by refighting the log the store kept — which also becomes the copy a
   * socket is handed. An intent in that log this server's rules refuse is
   * judged like one arriving live: a verdict in a room of this server's own
   * build, the end of judging in a room of another (`foul`).
   */
  restore(stored: StoredRoom, match: StoredMatch | null): void {
    this.judging = stored.judged
    this.encounterRoom = stored.encounter
    this.sides = { [Faction.Blue]: stored.sides[Faction.Blue], [Faction.Red]: stored.sides[Faction.Red] }
    const seat = (held: StoredSeat): Seat => ({
      ...newSeat(held.playerId ? { id: held.playerId, name: held.name ?? held.playerId } : null, { hash: held.keyHash }),
      control: held.control,
      joinBy: held.joinBy,
    })
    this.seats[Faction.Blue] = seat(stored.blue)
    this.seats[Faction.Red] = stored.red && seat(stored.red)
    // The match is written before the row says it is playing, so a match in
    // the store is the better witness of the two.
    this.phaseNow = match ? 'playing' : stored.phase
    if (match) {
      this.header = match.header
      this.host = new MatchHost(match.header)
      this.events.push(...match.events)
      for (const event of match.events) {
        this.apply(event.command)
        if (this.aborted) return
      }
    }
    if (this.over) return
    for (const faction of FACTIONS) this.resume(faction)
    this.options.log(
      `room ${this.id}: restored, ${this.phaseNow}, build ${this.version.build}${this.judging ? '' : ', witnessed'}`,
    )
  }

  /**
   * Watch. A spectator of a match already playing is handed the log so far
   * (`catchUp`); one who arrives earlier is handed it the moment the match
   * starts (`start`).
   */
  watch(client: Client): Seated {
    client.room = this
    client.faction = null
    this.spectators.add(client)
    this.options.log(`room ${this.id}: a spectator arrived (${this.spectators.size} watching)`)
    return { roomId: this.id, faction: null, phase: this.phaseNow, redirected: false, seatKey: null }
  }

  /**
   * Put a signed-in player back in the seat they hold in a match that is
   * playing, from a new window — after their tab was lost, from another
   * window, or because they asked for something else while they still had a
   * match (`redirected`).
   *
   * A new window, not a reconnection: the window it replaces is retired, and
   * so is that window's key. The seat gets a fresh one, so the old window
   * cannot take the seat back from under the new one.
   *
   * Rejoin is replay: the client rebuilds the match by re-running the log,
   * which is the same thing `src/sim/Replay.ts` does to a file and the same
   * thing the referee did to the live stream. It is also why the determinism
   * work is load-bearing rather than tidy — a client that cannot reproduce the
   * log cannot come back.
   */
  takeBack(client: Client, faction: Faction, redirected: boolean): Seated {
    const seated = this.take(client, faction, redirected, mintSeatKey())
    this.persist()
    const name = this.seats[faction]!.player?.name ?? 'a player'
    this.options.log(`room ${this.id}: ${name} took ${FACTION_INFO[faction].name} back`)
    return seated
  }

  /**
   * Put the window that holds a seat's key back in that seat (`seatFor`), in
   * any phase.
   *
   * A reconnection, not a new window: nothing is abandoned, the key stays the
   * key, and the socket becomes whoever the seat belongs to.
   */
  reclaim(client: Client, faction: Faction, key: string): Seated {
    const seat = this.seats[faction]!
    client.player = seat.player
    const seated = this.take(client, faction, false, key)
    this.options.log(`room ${this.id}: ${seat.player?.name ?? 'a player'} reconnected to ${FACTION_INFO[faction].name}`)
    return seated
  }

  /**
   * Hand a socket just seated or watching here the match so far, if there is
   * one yet. Called straight after it has been told where it sits, before
   * anything else is relayed to it, so the log is always the first thing of
   * the match it hears.
   */
  catchUp(client: Client): void {
    if (this.host && client.room === this) this.send(client, this.logSoFar())
  }

  /**
   * A socket stopped being part of this room: it dropped, stood up, or was
   * replaced by a newer window of its player.
   *
   * A spectator simply goes. A seat is held, in every phase and whoever holds
   * it, for the window to come back to — with its key, or as its player's
   * newest window (`takeBack`, `abandon`); to the window at the other end a
   * dropped connection is a stall, not a choice. A room that is over holds
   * nothing: the socket is only let off its end screen.
   */
  leave(client: Client): void {
    client.room = null
    if (this.spectators.delete(client)) return
    const faction = client.faction
    client.faction = null
    const seat = faction === null ? null : this.seats[faction]
    if (faction === null || !seat || seat.client !== client) return
    seat.client = null
    if (!this.over) this.hold(faction)
  }

  /**
   * A signed-in player's newest window asked for something while their seat
   * here — in a room still being set up — was held for a window they have
   * since replaced. The room is abandoned rather than carried over: a
   * half-equipped loadout lives in the window that was equipping it, and is
   * not worth moving between windows.
   */
  abandon(faction: Faction): void {
    const seat = this.seats[faction]
    if (!seat || this.over || this.phaseNow === 'playing') return
    this.end(departure(seat, this.phaseNow))
  }

  /**
   * One frame from a socket in this room.
   *
   * The setup conversation — `hello`, `init`, `ready` — is the two seats'
   * business and goes to the other seat only: it is how a host restates its
   * opening to a joiner who arrived late, or to either seat after it
   * reconnected, and it means nothing to a spectator, who is handed the log
   * instead. Intents go to the other seat and to every spectator. Nothing a
   * spectator sends is acted on or passed on.
   */
  receive(client: Client, frame: JsonRpcFrame): void {
    if (this.aborted || client.faction === null) return
    if (!('method' in frame)) return
    const params = (frame as JsonRpcNotification).params as Record<string, unknown>
    const message = messageOf(frame.method, params)
    if (!message) return

    switch (message.type) {
      case 'hello':
      case 'init':
      case 'ready':
        this.relayToOpponent(client, frame)
        return
      case 'matchHeader': {
        // The host of a match is always Blue (`NetworkManager.hostMatch`),
        // and it states the opening position once both sides have deployed.
        if (client.faction !== Faction.Blue || this.phaseNow !== 'deploying') return
        this.start(message.header)
        this.relayToOpponent(client, frame)
        return
      }
      case 'digest': {
        if (!this.host) return
        this.check(client, message.digest)
        this.relayToOpponent(client, frame)
        return
      }
      default: {
        // `log`, `seated` and `abort` are the server's to say, never a
        // client's; anything else that is not an intent has no business here.
        if (!isCommand(message) || !this.host) return
        // Recorded first and resolved second, so a match that desynchronises
        // still has the stream that produced it.
        this.record(message)
        this.apply(message)
        if (this.aborted) return
        this.relayToOpponent(client, frame)
        for (const spectator of this.spectators) spectator.transport.send(frame)
        return
      }
    }
  }

  /**
   * Let go of every hold, for a server shutting down, and of every AI seat: it
   * is the server's own, and plays on when the next one restores the room.
   * Nothing is written: the room is still live in the store, for the next
   * server to take up. The sockets are the lobby's to close.
   */
  dispose(): void {
    for (const faction of FACTIONS) {
      const seat = this.seats[faction]
      seat?.grace?.()
      seat?.deadline?.()
      this.standAi(faction)
    }
  }

  /**
   * Put `client` in a seat — a new one, or one already held — under `key`,
   * which is what its `Seated` tells it to keep.
   *
   * A different socket still sitting in the seat is that seat's previous
   * connection: the window reconnecting before the server noticed the old one
   * was dead, or a socket that has since signed out. It is told why, in case
   * something is still listening on it, and stands up; the socket itself is
   * left open, since only its seat was taken.
   */
  private take(client: Client, faction: Faction, redirected: boolean, key: string): Seated {
    client.room = this
    client.faction = faction
    const seat = this.seats[faction]
    if (seat) {
      const previous = seat.client
      if (previous && previous !== client) {
        this.send(previous, { type: 'abort', reason: 'This seat was taken back by another connection.', side: null })
        previous.room = null
        previous.faction = null
      }
      seat.grace?.()
      seat.grace = null
      // Kept for this player and taken by them: the AI will not sit in it.
      seat.deadline?.()
      seat.deadline = null
      seat.joinBy = null
      seat.control = 'player'
      seat.client = client
      seat.key = { plain: key }
    } else {
      this.seats[faction] = newSeat(client.player, { plain: key }, client)
    }
    return { roomId: this.id, faction, phase: this.phaseNow, redirected, seatKey: key }
  }

  /**
   * Hold a seat whose socket dropped, and end the room if its window does not
   * come back in time — with the reason the phase it ends in calls for. A
   * room with an AI to fall back on (an encounter) hands the seat to it
   * instead: a fight is never ended by a human leaving it.
   */
  private hold(faction: Faction): void {
    const seat = this.seats[faction]
    if (!seat) return
    this.options.log(
      `room ${this.id}: holding ${seat.player?.name ?? 'an anonymous player'}'s seat for ${this.options.graceMs} ms`,
    )
    seat.grace = this.options.schedule(() => {
      seat.grace = null
      if (this.encounterRoom) this.passToAi(faction)
      else this.end(departure(seat, this.phaseNow))
    }, this.options.graceMs)
  }

  /**
   * A seat a previous server wrote down, taken up as what it was: the AI sat
   * down again in a seat it held, a reserved seat left to run out its
   * deadline (already past, the AI has it at once), and a player's held for
   * their window to come back to.
   */
  private resume(faction: Faction): void {
    const seat = this.seats[faction]
    if (!seat) return
    if (seat.control === 'ai') this.sitAi(faction)
    else if (seat.control === 'reserved') this.reserve(faction, seat.joinBy ?? this.options.now())
    else this.hold(faction)
  }

  /** Keep `faction`'s seat for its player until `joinBy` on the server's clock, and then pass it to the AI. */
  private reserve(faction: Faction, joinBy: number): void {
    const seat = this.seats[faction]!
    seat.control = 'reserved'
    seat.joinBy = joinBy
    const left = joinBy - this.options.now()
    if (left <= 0) {
      this.passToAi(faction)
      return
    }
    seat.deadline = this.options.schedule(() => {
      seat.deadline = null
      this.passToAi(faction)
    }, left)
  }

  /** The player's seat goes to the AI, for good: they did not come, or did not come back. */
  private passToAi(faction: Faction): void {
    const seat = this.seats[faction]
    if (!seat || this.over || seat.control === 'ai') return
    this.options.log(`room ${this.id}: the AI takes ${seat.player?.name ?? 'a player'}'s seat`)
    this.sitAi(faction)
    this.options.onChanged()
  }

  /**
   * Sit the AI in `faction`'s seat and hand it the match so far, which it
   * plays on from if it is that side's turn. Its socket is the other end of a
   * loopback, so from here on the seat is an ordinary client of the room.
   */
  private sitAi(faction: Faction): void {
    // An AI that could not carry on has called the fight off (`stuck`): the
    // seat that was next to be sat has nothing left to play.
    if (this.over) return
    const seat = this.seats[faction]!
    seat.grace?.()
    seat.grace = null
    seat.deadline?.()
    seat.deadline = null
    seat.joinBy = null
    seat.control = 'ai'
    const [mine, theirs] = loopback()
    seat.ai = new AiSeat(faction, mine, {
      log: this.options.log,
      turnLimit: ENCOUNTER.turnLimit,
      // A bug, and one that would hold the player to a seat nothing moves for
      // good — every other request of theirs is refused while the AI has it.
      stuck: () => this.end(CALLED_OFF),
    })
    const ai: Client = { transport: theirs, player: null, version: this.options.serverVersion, room: this, faction, gone: false }
    seat.client = ai
    // What a window's socket gets from the session layer (`Lobby.receive`),
    // this seat gets straight from its loopback.
    theirs.onFrame((frame) => this.receive(ai, frame))
    this.catchUp(ai)
    this.persist()
  }

  /** Stand the AI up from `faction`'s seat, if it sits there: the room is over or the server stopping. */
  private standAi(faction: Faction): void {
    const seat = this.seats[faction]
    if (!seat?.ai) return
    seat.ai.dispose()
    seat.ai = null
    if (seat.client) {
      seat.client.room = null
      seat.client.faction = null
      seat.client = null
    }
  }

  /** The match so far, as a socket arriving now is handed it. */
  private logSoFar(): NetworkMessage {
    return { type: 'log', matchId: this.id, header: this.header!, events: [...this.events] }
  }

  /** Every socket in the room, seated or watching. */
  private *sockets(): Iterable<Client> {
    for (const faction of FACTIONS) {
      const client = this.seats[faction]?.client
      if (client) yield client
    }
    yield* this.spectators
  }

  /**
   * Put a write on the chain.
   *
   * The result is deliberately not returned: nothing that judges a match may
   * come to depend on a write having landed.
   */
  private enqueue(task: () => Promise<void>): void {
    this.work = this.work.then(task).catch((error: unknown) => {
      this.abort({
        matchId: this.id,
        side: null,
        reason: `the match server could not write the match down: ${
          error instanceof Error ? error.message : String(error)
        }`,
        found: [],
      })
    })
  }

  /** Write the room down as it stands when the write comes up (`RoomStore.save`). */
  private persist(): void {
    this.enqueue(async () => {
      // An ended room has deleted its row, or queued the delete; saving it
      // again would bring it back for the next server to restore.
      if (this.over) return
      await this.options.rooms.save(await this.stored())
    })
  }

  private async stored(): Promise<StoredRoom> {
    const seat = async (faction: Faction): Promise<StoredSeat | null> => {
      const held = this.seats[faction]
      if (!held) return null
      return {
        playerId: held.player?.id ?? null,
        name: held.player?.name ?? null,
        keyHash: 'plain' in held.key ? await hashSeatKey(held.key.plain) : held.key.hash,
        control: held.control,
        joinBy: held.joinBy,
      }
    }
    return {
      id: this.id,
      version: this.version,
      phase: this.phaseNow,
      createdAt: this.createdAt,
      judged: this.judging,
      encounter: this.encounterRoom,
      sides: { [Faction.Blue]: this.sides[Faction.Blue], [Faction.Red]: this.sides[Faction.Red] },
      blue: (await seat(Faction.Blue))!,
      red: await seat(Faction.Red),
    }
  }

  private send(client: Client, message: NetworkMessage): void {
    client.transport.send(frameOf(message))
  }

  /** To the other seat, never back to the sender and never to a spectator. */
  private relayToOpponent(from: Client, frame: JsonRpcFrame): void {
    const other = from.faction === Faction.Blue ? Faction.Red : Faction.Blue
    this.seats[other]?.client?.transport.send(frame)
  }

  /**
   * Begin watching a match, from the opening position its host states.
   *
   * The header and the world are set here and now, because everything that
   * judges a frame needs them immediately; only the writes are queued. The
   * match is written under the room's id, so the room a player was in and the
   * match they can look up afterwards are the same name — and before the room
   * says it is playing, so a room that says so always has a match to restore.
   */
  private start(header: RecordingHeader): void {
    this.host = new MatchHost(header)
    this.header = header
    this.phaseNow = 'playing'
    this.options.log(`room ${this.id}: watching the match, seed ${header.seedLabel}`)

    this.enqueue(async () => {
      await this.options.matches.create(header, this.id)
      await this.verifyRosters()
    })
    this.persist()
    for (const spectator of this.spectators) this.send(spectator, this.logSoFar())
  }

  /**
   * Check both squads against the rosters this server keeps.
   *
   * This is what makes a kept match mean anything. A client states its squad
   * in the header, and a client may state anything; so before a result is
   * allowed to touch a roster, the squad deployed has to *be* that roster —
   * character for character, in slot order. Anything else is a match played
   * with somebody else's people, and it is aborted rather than settled
   * wrongly.
   *
   * An anonymous side is skipped, not refused: an unregistered opponent is a
   * perfectly good opponent, they simply have nothing to keep.
   */
  private async verifyRosters(): Promise<void> {
    const rosters = this.options.rosters
    const header = this.header
    if (!rosters || !header) return

    const blue = this.seats[Faction.Blue]?.player?.id ?? null
    const red = this.seats[Faction.Red]?.player?.id ?? null
    if (blue && red && blue === red) {
      // Otherwise a player could farm growth off their own losses, and the
      // dead would be theirs to choose. The lobby's seating already makes
      // this impossible (one match per player, one window per player); the
      // check stays here because this is where a result meets a roster.
      return this.foul({
        matchId: this.id,
        side: null,
        reason: 'one player cannot play both sides of a kept match',
        found: [],
      })
    }

    for (const [faction, playerId] of [
      [Faction.Blue, blue],
      [Faction.Red, red],
    ] as const) {
      if (!playerId) continue
      const members = await rosters.active(playerId)
      const deployed = header.squads[faction]
      // Nobody left is not a squad: a side of zero would lose on turn one and
      // settle nothing, and a header stating no sheets means the stock squad
      // to `Squads` — somebody nobody enlisted. Recruit first.
      if (members.length === 0) {
        return this.foul({
          matchId: this.id,
          side: faction,
          reason: `the ${FACTION_INFO[faction].name} player has nobody left on their roster to deploy`,
          found: [],
        })
      }
      if (!Array.isArray(deployed) || deployed.length < 1 || deployed.length > SQUAD_SIZE) {
        return this.foul({
          matchId: this.id,
          side: faction,
          reason: `the ${FACTION_INFO[faction].name} squad is not a squad of 1 to ${SQUAD_SIZE}`,
          found: [],
        })
      }
      // The squad is these *stated* members of the active roster — not "the
      // whole roster in slot order", now that a roster is bigger than a
      // squad (`[ITEM-042]`) and a player picks who deploys. Every id has to
      // belong to this player, be active, and appear once; its sheet and
      // starting HP have to be exactly that member's, so a client cannot heal
      // or misrepresent whoever it names.
      const byId = new Map(members.map((member) => [member.characterId, member]))
      const seen = new Set<string>()
      const characterIds: string[] = []
      for (const unit of deployed) {
        const id = unit.characterId
        if (typeof id !== 'string') {
          return this.foul({
            matchId: this.id,
            side: faction,
            reason: `the ${FACTION_INFO[faction].name} squad names a character that is not this player's, is not active, or repeats`,
            found: [],
          })
        }
        const member = byId.get(id)
        if (!member || seen.has(id)) {
          return this.foul({
            matchId: this.id,
            side: faction,
            reason: `the ${FACTION_INFO[faction].name} squad names a character that is not this player's, is not active, or repeats`,
            found: [],
          })
        }
        // A member in the medical bay cannot be picked: `[ITEM-039]` refuses
        // it here rather than trusting the roster screen to have kept them
        // off the list, the same way every other roster rule refuses rather
        // than assumes.
        if (member.downtime > 0) {
          return this.foul({
            matchId: this.id,
            side: faction,
            reason: `the ${FACTION_INFO[faction].name} squad deploys a character still in the medical bay`,
            found: [],
          })
        }
        if (JSON.stringify(sanitizeSheet(unit.sheet)) !== JSON.stringify(member.sheet)) {
          return this.foul({
            matchId: this.id,
            side: faction,
            reason: `the ${FACTION_INFO[faction].name} squad is not the roster this server keeps for its player`,
            found: [],
          })
        }
        // A wound is as much part of the roster as the sheet is: a client
        // that omitted it, or stated a different one, would otherwise deploy
        // a signed-in player's character healthier than the roster says.
        if (unit.state?.hp !== member.hp) {
          return this.foul({
            matchId: this.id,
            side: faction,
            reason: `the ${FACTION_INFO[faction].name} squad's starting health is not what the roster this server keeps for its player says`,
            found: [],
          })
        }
        // Fatigue is read off the same roster, the same way `state.hp` is: a
        // client cannot deploy rested, or hide how tired it already is, any
        // more than it can deploy healed (`[ITEM-039]`).
        if (unit.state?.fatigue !== member.fatigue) {
          return this.foul({
            matchId: this.id,
            side: faction,
            reason: `the ${FACTION_INFO[faction].name} squad's stated fatigue is not what the roster this server keeps for its player says`,
            found: [],
          })
        }
        seen.add(id)
        characterIds.push(id)
      }
      this.sides[faction] = { playerId, characterIds }
    }
  }

  private record(command: NetworkMessage): void {
    if (!this.host) return
    const event = {
      turn: this.host.turnNumber,
      faction: this.host.turnManager.activeFaction,
      command,
    }
    this.events.push({ seq: this.events.length, ...event })
    this.enqueue(() => this.options.matches.append(this.id, event).then(() => undefined))
  }

  private apply(command: NetworkMessage): void {
    if (!this.host) return
    const result = this.host.apply(command)
    // Once a room is only witnessed, the referee's world is a best effort that
    // may already have parted from the players', and one more intent it
    // cannot carry out says nothing new.
    if (!result.applied && this.judging) {
      // The referee could not carry out something a client did. That is a
      // disagreement about what was *possible*, which is larger than any
      // disagreement about a number, so it ends the match rather than being
      // logged and shrugged at.
      this.foul({
        matchId: this.id,
        side: null,
        reason: `a ${command.type} the referee could not carry out: ${result.reason}`,
        found: [],
      })
    }
    if (!this.aborted) this.settle()
  }

  /**
   * If that intent ended the match, write what it did to both rosters.
   *
   * The outcome is read out of the referee's *own* world, straight away and
   * synchronously, because the world keeps moving: a later intent could kill
   * the unit whose survival is being recorded. The write itself goes on the
   * queue behind the verification, which is how a settlement can be sure the
   * squads it credits were the ones checked against the roster. A room that
   * stopped being judged ends here too, and keeps nobody's squad.
   */
  private settle(): void {
    const host = this.host
    const header = this.header
    if (this.over || !host || !header) return
    const winner = winnerOf(host.squads)
    if (winner === null) return

    this.settled = true
    const loser = winner === Faction.Blue ? Faction.Red : Faction.Blue
    const carried = carriedOut(host.squads, loser, host.grid, header.seed)
    const fates = settlement(host.squads, winner, carried)
    const rosters = this.options.rosters

    this.enqueue(async () => {
      if (this.aborted || !this.judging || !rosters) return
      const side = (faction: Faction) => {
        const known = this.sides[faction]
        return known ? { ...known, fates: fates[faction] as readonly UnitFate[] } : null
      }
      const sides = { [Faction.Blue]: side(Faction.Blue), [Faction.Red]: side(Faction.Red) }
      if (!sides[Faction.Blue] && !sides[Faction.Red]) return
      await rosters.settle({ matchId: this.id, winner, sides })
      this.options.log(`settled ${this.id}: ${FACTION_INFO[winner].name} won`)
    })
    this.closeDoors()
  }

  /**
   * Compare a client's fingerprint with the referee's own.
   *
   * This is the whole point of a third party. The client is not being asked
   * whether it agrees with its opponent — it is being asked whether it agrees
   * with a recomputation neither player controls.
   */
  private check(client: Client, theirs: StateDigest): void {
    if (!this.host || !this.judging) return
    const mine = this.host.digest()
    const found = compareDigests(mine, theirs, (entityId) => `#${entityId}`)
    if (found.length === 0) return

    this.foul({
      matchId: this.id,
      side: client.faction,
      reason: `a client's state disagrees with the referee at turn ${theirs.turn}`,
      found,
    })
  }

  /**
   * The referee found against the match: a verdict, from a server that runs
   * the room's own build; from any other, the end of judging it (`witness`).
   */
  private foul(verdict: RefereeVerdict): void {
    if (this.version.build === this.options.serverVersion.build) this.abort(verdict)
    else this.witness(verdict)
  }

  /**
   * Stop judging a room opened under another build, rather than abort it.
   *
   * After a deploy, this server refights the match with rules that may not be
   * the ones its players are running, so a disagreement is as likely a rules
   * change as a foul and the server cannot tell which. The match carries on,
   * relayed and recorded exactly as before; the referee says why once, checks
   * no further digest, and settles nobody's roster — an unwatched match keeps
   * nobody's squad either (RFC-0001 §8.6).
   */
  private witness(verdict: RefereeVerdict): void {
    if (!this.judging) return
    this.judging = false
    this.options.log(
      `room ${this.id}: opened under build ${this.version.build}, so this server (build ` +
        `${this.options.serverVersion.build}) stops judging it rather than abort it: ${verdict.reason}`,
    )
    this.persist()
  }

  /**
   * End the match on the referee's judgement, and keep the log.
   *
   * The log is evidence: it is the only way to tell a foul from a bug in the
   * rules, and deleting it would destroy the thing that makes a verdict
   * checkable. Per RFC-0001 §8.3 an abort is the verdict a refereed match
   * reaches — an unwatched match can only notice, never attribute.
   */
  private abort(verdict: RefereeVerdict): void {
    if (this.aborted) return
    this.end(verdict.reason, verdict.side)
    this.options.onVerdict?.(verdict)
  }

  /**
   * End the room for everybody still in it, with a reason they can read.
   *
   * Not every end is a verdict: a player walking out is nobody's foul, so a
   * departure ends the room through here without a verdict being recorded.
   * A settled match can still be aborted — a digest that disagrees after the
   * deciding intent is as much a foul as one before it, and the queued
   * settlement checks for exactly that before it touches a roster.
   *
   * Everybody told is also sent out of the room: an abort ends a socket's
   * part in this match, never its connection to the server, which goes on
   * serving the window in the lobby.
   */
  private end(reason: string, side: Faction | null = null): void {
    if (this.aborted) return
    const wasOver = this.over
    this.aborted = true
    this.options.log(`aborting room ${this.id}: ${reason}`)
    for (const client of [...this.sockets()]) {
      this.send(client, { type: 'abort', reason, side })
      client.room = null
      client.faction = null
    }
    for (const faction of FACTIONS) {
      const seat = this.seats[faction]
      if (seat) seat.client = null
    }
    this.spectators.clear()
    if (wasOver) this.options.onOver(this)
    else this.closeDoors()
  }

  /**
   * The room has just become over: nobody's seat is held any more, its row
   * goes from the store behind everything it still had to write, and the
   * lobby is told, once.
   */
  private closeDoors(): void {
    for (const faction of FACTIONS) {
      const seat = this.seats[faction]
      if (!seat) continue
      seat.grace?.()
      seat.grace = null
      seat.deadline?.()
      seat.deadline = null
      this.standAi(faction)
    }
    this.enqueue(() => this.options.rooms.end(this.id))
    this.options.onOver(this)
  }
}

/**
 * SHA-256 of a seat key, base64url: the only form of it the store keeps.
 * Asynchronous because WebCrypto is.
 */
export async function hashSeatKey(key: string): Promise<string> {
  return toBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
}

/** 18 random bytes: unguessable, and short enough to sit in a url. */
function mintSeatKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(18)))
}

/** Equal strings, compared in a time that does not say where they first differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

/** What the players are told when the AI playing a fight cannot carry on. The detail is in the server's log. */
const CALLED_OFF = 'This fight has been called off: the AI playing it could not carry on.'

/** Why a room ends when `seat` is gone from it for good, in the phase it ends in. */
function departure(seat: Seat, phase: RoomPhase): string {
  const who = seat.player?.name ?? 'The other player'
  return phase === 'playing' ? `${who} left the match.` : `${who} left before the match began.`
}

/** A seat nobody has taken yet, for `player`; `client` is who sits in it already, if anybody. */
function newSeat(player: Player | null, key: Seat['key'], client: Client | null = null): Seat {
  return { player, client, grace: null, key, control: 'player', joinBy: null, deadline: null, ai: null }
}
