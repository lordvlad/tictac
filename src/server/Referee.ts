import { Faction, FACTION_INFO, SQUAD_SIZE } from '../config'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../game/JsonRpc'
import type { NetworkMessage } from '../game/NetworkManager'
import type { RecordedEvent, RecordingHeader } from '../game/Recording'
import { compareDigests, type Divergence, type StateDigest } from '../game/StateDigest'
import type { Transport } from '../game/Transport'
import { sanitizeSheet } from '../core/Characters'
import { MatchHost } from '../sim/MatchHost'
import { MY_VERSION, versionRefusal } from '../version'
import { carriedOut, settlement, winnerOf, type UnitFate } from '../game/MatchEnd'
import type { MatchStore } from './MatchStore'
import type { Rosters } from './Rosters'

/**
 * A third recomputation of the same match.
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
 * It also does the two jobs that have nothing to do with cheating, and are the
 * reason to want one anyway: the log outlives the tab it was played in
 * (persistence), and a client that lost its tab can be rebuilt from that log
 * (rejoin).
 */

/** What the referee decided about a match, for a caller that wants to watch. */
export interface RefereeVerdict {
  matchId: string
  /** The side whose state disagreed, or null when the referee cannot tell. */
  side: Faction | null
  reason: string
  found: readonly Divergence[]
}

export interface RefereeOptions {
  /** Where matches are written. Already migrated: see `Persistence`. */
  matches: MatchStore
  /**
   * The rosters to check squads against and write results onto.
   *
   * Optional: a referee without one still watches, relays and records, it
   * simply keeps nobody's squad. That is what an anonymous match is.
   */
  rosters?: Rosters
  /** Called when a match is aborted, after both clients have been told. */
  onVerdict?: (verdict: RefereeVerdict) => void
  /** Called for anything worth a line in a server log. */
  log?: (message: string) => void
}

/** One connected client, as the referee sees it. */
interface Client {
  transport: Transport
  /** The faction whose intents this client is entitled to send, once known. */
  faction: Faction | null
  build: string | null
  /** The signed-in player behind the socket, or null for an anonymous one. */
  playerId: string | null
}

export class Referee {
  private readonly clients = new Set<Client>()
  private readonly matches: MatchStore
  private readonly rosters?: Rosters
  private readonly onVerdict?: (verdict: RefereeVerdict) => void
  private readonly log: (message: string) => void

  private host: MatchHost | null = null
  private header: RecordingHeader | null = null
  private matchId: string | null = null
  private aborted = false
  private settled = false

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

  constructor(options: RefereeOptions) {
    this.matches = options.matches
    this.rosters = options.rosters
    this.onVerdict = options.onVerdict
    this.log = options.log ?? ((message) => console.info(`[referee] ${message}`))
  }

  /** The match being watched, or null before anybody has opened one. */
  get openMatchId(): string | null {
    return this.matchId
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

  /**
   * Take a client.
   *
   * Nothing is assumed about who it is: a client states its build, and may then
   * open a match, resume one, or send intents for a match already open.
   *
   * `playerId` is the account the socket signed in as, and null for an
   * anonymous one — which is legitimate: a match between two anonymous clients
   * is watched and written down exactly as before, it is simply not kept on
   * anybody's roster.
   */
  attach(transport: Transport, playerId: string | null = null): void {
    const client: Client = { transport, faction: null, build: null, playerId }
    this.clients.add(client)

    transport.onFrame((frame) => this.receive(client, frame))
    transport.onClosed((reason) => {
      this.clients.delete(client)
      this.log(`a client left: ${reason}`)
    })
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
        matchId: this.matchId ?? 'unknown',
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

  /** Everything the referee forwards goes to the other clients, never back. */
  private relay(from: Client, frame: JsonRpcFrame): void {
    for (const client of this.clients) {
      if (client !== from) client.transport.send(frame)
    }
  }

  private refuse(client: Client, reason: string): void {
    this.log(`refusing a client: ${reason}`)
    this.send(client, { type: 'abort', reason, side: null })
    client.transport.close()
    this.clients.delete(client)
  }

  private receive(client: Client, frame: JsonRpcFrame): void {
    if (this.aborted) return
    if (!('method' in frame)) return
    const params = (frame as JsonRpcNotification).params as Record<string, unknown>
    const message = this.toMessage(frame.method, params)
    if (!message) return

    switch (message.type) {
      case 'hello':
      case 'init': {
        // The gate, before anything else: a client on another build diverges
        // for innocent reasons, and a referee that accused it would be naming
        // somebody whose browser cached yesterday's bundle.
        const reason = versionRefusal(params)
        if (reason) return this.refuse(client, reason)
        client.build = MY_VERSION.build
        this.relay(client, frame)
        return
      }
      case 'matchHeader': {
        this.open(message.header, client)
        this.relay(client, frame)
        return
      }
      case 'resume': {
        this.resume(client, message.matchId, message.afterSeq)
        return
      }
      case 'digest': {
        this.check(client, message.digest)
        this.relay(client, frame)
        return
      }
      case 'log':
      case 'abort':
        // A client does not get to tell the referee what the log is, or that
        // the match is over. Both are the referee's to say.
        return
      default: {
        // An intent. Recorded first and resolved second, so a match that
        // desynchronises still has the stream that produced it.
        this.record(message)
        this.apply(message)
        this.relay(client, frame)
        return
      }
    }
  }

  private toMessage(method: string, params: Record<string, unknown>): NetworkMessage | null {
    for (const [type, name] of Object.entries(RpcMethods)) {
      if (name === method) return { ...params, type } as NetworkMessage
    }
    return null
  }

  /**
   * Begin watching a match, from the opening position its host states.
   *
   * The id, the header and the world are set here and now, because everything
   * that judges a frame needs them immediately; only the write is queued. The
   * host of a match is always Blue (`NetworkManager.hostMatch`), so the client
   * that opened it is Blue and everybody else is Red — which is how the
   * referee knows whose roster is on which side.
   */
  private open(header: RecordingHeader, from: Client): void {
    if (this.host) return
    this.matchId = crypto.randomUUID()
    this.header = header
    this.host = new MatchHost(header)
    for (const client of this.clients) {
      client.faction = client === from ? Faction.Blue : Faction.Red
    }
    this.log(`watching match ${this.matchId}, seed ${header.seedLabel}`)

    const id = this.matchId
    this.enqueue(async () => {
      await this.matches.create(header, id)
      await this.verifyRosters()
    })
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
    const rosters = this.rosters
    const header = this.header
    if (!rosters || !header) return

    const playerOf = (faction: Faction): string | null => {
      for (const client of this.clients) {
        if (client.faction === faction && client.playerId) return client.playerId
      }
      return null
    }
    const blue = playerOf(Faction.Blue)
    const red = playerOf(Faction.Red)
    if (blue && red && blue === red) {
      // Otherwise a player could farm growth off their own losses, and the
      // dead would be theirs to choose.
      return this.abort({
        matchId: this.matchId ?? 'unknown',
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
          matchId: this.matchId ?? 'unknown',
          side: faction,
          reason: `the ${FACTION_INFO[faction].name} player has nobody left on their roster to deploy`,
          found: [],
        })
      }
      if (!Array.isArray(deployed) || deployed.length < 1 || deployed.length > SQUAD_SIZE) {
        return this.abort({
          matchId: this.matchId ?? 'unknown',
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
            matchId: this.matchId ?? 'unknown',
            side: faction,
            reason: `the ${FACTION_INFO[faction].name} squad names a character that is not this player's, is not active, or repeats`,
            found: [],
          })
        }
        const member = byId.get(id)
        if (!member || seen.has(id)) {
          return this.abort({
            matchId: this.matchId ?? 'unknown',
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
            matchId: this.matchId ?? 'unknown',
            side: faction,
            reason: `the ${FACTION_INFO[faction].name} squad deploys a character still in the medical bay`,
            found: [],
          })
        }
        if (JSON.stringify(sanitizeSheet(unit.sheet)) !== JSON.stringify(member.sheet)) {
          return this.abort({
            matchId: this.matchId ?? 'unknown',
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
            matchId: this.matchId ?? 'unknown',
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
            matchId: this.matchId ?? 'unknown',
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
    if (!this.matchId || !this.host) return
    const event = {
      turn: this.host.turnNumber,
      faction: this.host.turnManager.activeFaction,
      command,
    }
    const id = this.matchId
    this.enqueue(() => this.matches.append(id, event).then(() => undefined))
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
        matchId: this.matchId ?? 'unknown',
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
    const matchId = this.matchId
    if (this.settled || this.aborted || !host || !header || !matchId) return
    const winner = winnerOf(host.squads)
    if (winner === null) return

    this.settled = true
    const loser = winner === Faction.Blue ? Faction.Red : Faction.Blue
    const carried = carriedOut(host.squads, loser, host.grid, header.seed)
    const fates = settlement(host.squads, winner, carried)

    this.enqueue(async () => {
      if (this.aborted || !this.rosters) return
      const side = (faction: Faction) => {
        const known = this.sides[faction]
        return known ? { ...known, fates: fates[faction] as readonly UnitFate[] } : null
      }
      const sides = { [Faction.Blue]: side(Faction.Blue), [Faction.Red]: side(Faction.Red) }
      if (!sides[Faction.Blue] && !sides[Faction.Red]) return
      await this.rosters.settle({ matchId, winner, sides })
      this.log(`settled ${matchId}: ${FACTION_INFO[winner].name} won`)
    })
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
      matchId: this.matchId ?? 'unknown',
      side: client.faction,
      reason: `a client's state disagrees with the referee at turn ${theirs.turn}`,
      found,
    })
  }

  /**
   * End the match, and keep the log.
   *
   * The log is evidence: it is the only way to tell a foul from a bug in the
   * rules, and deleting it would destroy the thing that makes a verdict
   * checkable. Per RFC-0001 §8.3 an abort is the verdict a refereed match
   * reaches — an unwatched match can only notice, never attribute.
   */
  private abort(verdict: RefereeVerdict): void {
    if (this.aborted) return
    this.aborted = true
    this.log(`aborting ${verdict.matchId}: ${verdict.reason}`)
    for (const client of this.clients) {
      this.send(client, { type: 'abort', reason: verdict.reason, side: verdict.side })
    }
    this.onVerdict?.(verdict)
  }

  /**
   * Hand a returning client the rest of the log.
   *
   * Rejoin is replay: the client rebuilds the match by re-running the intents,
   * which is the same thing `src/sim/Replay.ts` does to a file and the same
   * thing the referee did to the live stream. It is also why the determinism
   * work is load-bearing rather than tidy — a client that cannot reproduce the
   * log cannot come back.
   */
  private resume(client: Client, matchId: string, afterSeq: number): void {
    this.enqueue(async () => {
      const header = await this.matches.header(matchId)
      if (!header) return this.refuse(client, `no such match: ${matchId}`)

      const events: RecordedEvent[] = await this.matches.events(matchId, afterSeq)
      this.send(client, { type: 'log', matchId, header, events })
      this.log(`resumed a client into ${matchId} from seq ${afterSeq}: ${events.length} intents`)
    })
  }

  /**
   * Stop watching.
   *
   * The database is not closed here: it belongs to whoever opened the
   * `Persistence`, and a referee is one of several things reading it.
   */
  dispose(): void {
    for (const client of this.clients) client.transport.close()
    this.clients.clear()
  }
}
