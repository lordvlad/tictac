import { Faction, FACTION_INFO, SQUAD_SIZE } from '../config'
import { sanitizeSheet } from '../core/Characters'
import { isCommand } from '../ecs/systems/CommandSystem'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../game/JsonRpc'
import type { LobbyRoom, LobbySeat, RoomPhase } from '../game/Lobby'
import { carriedOut, settlement, winnerOf, type UnitFate } from '../game/MatchEnd'
import type { NetworkMessage } from '../game/NetworkManager'
import type { RecordedEvent, RecordingHeader } from '../game/Recording'
import { compareDigests, type Divergence, type StateDigest } from '../game/StateDigest'
import type { Transport } from '../game/Transport'
import { MatchHost } from '../sim/MatchHost'
import type { Player } from './Accounts'
import type { MatchStore } from './MatchStore'
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
 * accepted from anywhere else.
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
 * Made by the lobby when the socket connects, and placed in at most one room,
 * once, when its intent has been resolved. `gone` latches the moment the server
 * stops listening to it — it closed, it was turned away, or a newer window of
 * the same player replaced it — because a socket the server closed itself may
 * still report closing afterwards, and that late report must not be read as the
 * player walking out of their match.
 */
export interface Client {
  readonly transport: Transport
  /** The signed-in player behind the socket, or null for an anonymous one. */
  readonly player: Player | null
  room: Room | null
  /** The seat this socket holds in `room`, or null for a spectator. */
  faction: Faction | null
  gone: boolean
}

export interface RoomOptions {
  /** Where matches are written. Already migrated: see `Persistence`. */
  matches: MatchStore
  /**
   * The rosters to check squads against and write results onto.
   *
   * Optional: a referee without one still watches, relays and records, it
   * simply keeps nobody's squad. That is what an anonymous match is.
   */
  rosters?: Rosters
  /** Called when a match is aborted on the referee's judgement, after everybody in it has been told. */
  onVerdict?: (verdict: RefereeVerdict) => void
  /** Called for anything worth a line in a server log. */
  log: (message: string) => void
  /** How long a signed-in player's seat is held for them after their socket drops mid-match. */
  graceMs: number
  /** Run `fn` after `ms`; the answer cancels it. Injected so a test can be the clock. */
  schedule: (fn: () => void, ms: number) => () => void
  /** Called once, the moment the room is over (settled or aborted). */
  onOver: (room: Room) => void
}

interface Seat {
  readonly player: Player | null
  /** Null while a signed-in player's seat is held open for them to come back to. */
  client: Client | null
  /** Cancels the hold, while one is running. */
  grace: (() => void) | null
}

export class Room {
  private phaseNow: RoomPhase = 'waiting'
  private readonly seats: Record<Faction, Seat | null> = { [Faction.Blue]: null, [Faction.Red]: null }
  private readonly spectators = new Set<Client>()

  private host: MatchHost | null = null
  private header: RecordingHeader | null = null
  private aborted = false
  private settled = false

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
   */
  private readonly events: RecordedEvent[] = []

  /**
   * Who is playing which side, once their squad has been checked against the
   * roster this server keeps. Null for a side that is anonymous, or whose
   * squad has not been vouched for.
   */
  private sides: Record<Faction, { playerId: string; characterIds: string[] } | null> = {
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

  /** True once no socket is left in the room, seated or watching. */
  get empty(): boolean {
    return !this.seats[Faction.Blue]?.client && !this.seats[Faction.Red]?.client && this.spectators.size === 0
  }

  /** The seat a signed-in player holds here, while the room is not over. */
  seatOf(playerId: string): Faction | null {
    if (this.over) return null
    for (const faction of [Faction.Blue, Faction.Red]) {
      if (this.seats[faction]?.player?.id === playerId) return faction
    }
    return null
  }

  /** The referee's own fingerprint of the match, for tests and for an audit. */
  digest(): StateDigest | null {
    return this.host?.digest() ?? null
  }

  /**
   * Resolves once everything decided so far has been written.
   *
   * For a caller that wants to read what the referee wrote — a test, or a
   * shutdown — rather than for the referee itself, which never waits.
   */
  idle(): Promise<void> {
    return this.work
  }

  /** The room as `GET /api/lobby` shows it. */
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
      turn: this.host ? this.host.turnNumber : null,
      createdAt: this.createdAt,
    }
  }

  /**
   * Seat the player who opened the room. The opener is always Blue, because
   * the opener is the side that announces the match (`hostMatch`).
   */
  open(client: Client): void {
    this.take(client, Faction.Blue, false)
  }

  /** Take the Red seat. The lobby has already checked the room is `waiting`. */
  join(client: Client): void {
    this.phaseNow = 'deploying'
    this.take(client, Faction.Red, false)
  }

  /**
   * Watch. A spectator of a match already playing is handed the log so far;
   * one who arrives earlier is handed it the moment the match starts (`start`).
   */
  watch(client: Client): void {
    client.room = this
    client.faction = null
    this.spectators.add(client)
    this.send(client, { type: 'seated', roomId: this.id, faction: null, phase: this.phaseNow, redirected: false })
    if (this.host) this.send(client, this.logSoFar())
    this.options.log(`room ${this.id}: a spectator arrived (${this.spectators.size} watching)`)
  }

  /**
   * Put a player back in the seat they hold in a match that is playing, from a
   * new socket — after a dropped connection, from another window, or because
   * they asked for something else while they still had a match (`redirected`).
   *
   * Rejoin is replay: the client rebuilds the match by re-running the log,
   * which is the same thing `src/sim/Replay.ts` does to a file and the same
   * thing the referee did to the live stream. It is also why the determinism
   * work is load-bearing rather than tidy — a client that cannot reproduce the
   * log cannot come back.
   */
  takeBack(client: Client, faction: Faction, redirected: boolean): void {
    const seat = this.seats[faction]
    if (!seat) return
    seat.grace?.()
    seat.grace = null
    this.take(client, faction, redirected)
    this.send(client, this.logSoFar())
    this.options.log(`room ${this.id}: ${seat.player?.name ?? 'a player'} took ${FACTION_INFO[faction].name} back`)
  }

  /**
   * A socket stopped being part of this room.
   *
   * `superseded` is a newer window of the same player taking over: for a seat
   * in a match that is playing, the lobby hands the seat to that window next,
   * so there is nothing to hold and nobody to tell.
   *
   * Otherwise a seat leaving a match nobody has started yet ends the room —
   * there is nothing to come back to that the other side could wait for — and
   * a seat leaving a match in progress ends it for an anonymous player, who
   * cannot prove they are the one coming back, and holds it open for a
   * signed-in one, who can (`resume`).
   */
  leave(client: Client, superseded: boolean): void {
    client.room = null
    if (this.spectators.delete(client)) return
    const seat = client.faction === null ? null : this.seats[client.faction]
    if (!seat || seat.client !== client) return
    seat.client = null
    if (this.over) return

    const name = seat.player?.name
    if (this.phaseNow !== 'playing') {
      this.end(`${name ?? 'The other player'} left before the match began.`)
      return
    }
    if (superseded) return
    if (!name) {
      this.end('The other player left the match.')
      return
    }
    this.options.log(`room ${this.id}: holding ${name}'s seat for ${this.options.graceMs} ms`)
    seat.grace = this.options.schedule(() => {
      seat.grace = null
      this.end(`${name} left the match.`)
    }, this.options.graceMs)
  }

  /**
   * One frame from a socket in this room.
   *
   * The setup conversation — `hello`, `init`, `ready` — is the two seats'
   * business and goes to the other seat only: it is how a host restates its
   * opening to a joiner who arrived late, and it means nothing to a spectator,
   * who is handed the log instead. Intents go to the other seat and to every
   * spectator. Nothing a spectator sends is acted on or passed on.
   */
  receive(client: Client, frame: JsonRpcFrame): void {
    if (this.aborted || client.faction === null) return
    if (!('method' in frame)) return
    const params = (frame as JsonRpcNotification).params as Record<string, unknown>
    const message = toMessage(frame.method, params)
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

  /** Close every socket in the room. For a server shutting down. */
  dispose(): void {
    for (const faction of [Faction.Blue, Faction.Red]) {
      const seat = this.seats[faction]
      seat?.grace?.()
      seat?.client?.transport.close()
    }
    for (const spectator of this.spectators) spectator.transport.close()
  }

  private take(client: Client, faction: Faction, redirected: boolean): void {
    client.room = this
    client.faction = faction
    const seat = this.seats[faction]
    if (seat) seat.client = client
    else this.seats[faction] = { player: client.player, client, grace: null }
    this.send(client, { type: 'seated', roomId: this.id, faction, phase: this.phaseNow, redirected })
  }

  /** The match so far, as a socket arriving now is handed it. */
  private logSoFar(): NetworkMessage {
    return { type: 'log', matchId: this.id, header: this.header!, events: [...this.events] }
  }

  /** Every socket in the room, seated or watching. */
  private *sockets(): Iterable<Client> {
    for (const faction of [Faction.Blue, Faction.Red]) {
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

  private send(client: Client, message: NetworkMessage): void {
    const params = { ...message } as Record<string, unknown>
    delete params.type
    client.transport.send({ jsonrpc: '2.0', method: RpcMethods[message.type], params })
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
   * judges a frame needs them immediately; only the write is queued. The match
   * is written under the room's id, so the room a player was in and the match
   * they can look up afterwards are the same name.
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
      return this.abort({
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
        return this.abort({
          matchId: this.id,
          side: faction,
          reason: `the ${FACTION_INFO[faction].name} player has nobody left on their roster to deploy`,
          found: [],
        })
      }
      if (!Array.isArray(deployed) || deployed.length < 1 || deployed.length > SQUAD_SIZE) {
        return this.abort({
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
          return this.abort({
            matchId: this.id,
            side: faction,
            reason: `the ${FACTION_INFO[faction].name} squad names a character that is not this player's, is not active, or repeats`,
            found: [],
          })
        }
        const member = byId.get(id)
        if (!member || seen.has(id)) {
          return this.abort({
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
          return this.abort({
            matchId: this.id,
            side: faction,
            reason: `the ${FACTION_INFO[faction].name} squad deploys a character still in the medical bay`,
            found: [],
          })
        }
        if (JSON.stringify(sanitizeSheet(unit.sheet)) !== JSON.stringify(member.sheet)) {
          return this.abort({
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
          return this.abort({
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
          return this.abort({
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
    if (!result.applied) {
      // The referee could not carry out something a client did. That is a
      // disagreement about what was *possible*, which is larger than any
      // disagreement about a number, so it ends the match rather than being
      // logged and shrugged at.
      this.abort({
        matchId: this.id,
        side: null,
        reason: `a ${command.type} the referee could not carry out: ${result.reason}`,
        found: [],
      })
      return
    }
    this.settle()
  }

  /**
   * If that intent ended the match, write what it did to both rosters.
   *
   * The outcome is read out of the referee's *own* world, straight away and
   * synchronously, because the world keeps moving: a later intent could kill
   * the unit whose survival is being recorded. The write itself goes on the
   * queue behind the verification, which is how a settlement can be sure the
   * squads it credits were the ones checked against the roster.
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
      if (this.aborted || !rosters) return
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
    if (!this.host) return
    const mine = this.host.digest()
    const found = compareDigests(mine, theirs, (entityId) => `#${entityId}`)
    if (found.length === 0) return

    this.abort({
      matchId: this.id,
      side: client.faction,
      reason: `a client's state disagrees with the referee at turn ${theirs.turn}`,
      found,
    })
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
   */
  private end(reason: string, side: Faction | null = null): void {
    if (this.aborted) return
    const wasOver = this.over
    this.aborted = true
    this.options.log(`aborting room ${this.id}: ${reason}`)
    for (const client of this.sockets()) this.send(client, { type: 'abort', reason, side })
    if (!wasOver) this.closeDoors()
  }

  /** The room has just become over: nobody's seat is held any more, and the lobby is told, once. */
  private closeDoors(): void {
    for (const faction of [Faction.Blue, Faction.Red]) {
      const seat = this.seats[faction]
      seat?.grace?.()
      if (seat) seat.grace = null
    }
    this.options.onOver(this)
  }
}

function toMessage(method: string, params: Record<string, unknown>): NetworkMessage | null {
  for (const [type, name] of Object.entries(RpcMethods)) {
    if (name === method) return { ...params, type } as NetworkMessage
  }
  return null
}
