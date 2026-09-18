import type { Faction } from '../config'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../game/JsonRpc'
import type { NetworkMessage } from '../game/NetworkManager'
import type { RecordedEvent, RecordingHeader } from '../game/Recording'
import { compareDigests, type Divergence, type StateDigest } from '../game/StateDigest'
import type { Transport } from '../game/Transport'
import { MatchHost } from '../sim/MatchHost'
import { MY_VERSION, versionRefusal } from '../version'
import { MatchStore } from './MatchStore'

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
  store?: MatchStore
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
}

export class Referee {
  private readonly clients = new Set<Client>()
  private readonly store: MatchStore
  private readonly onVerdict?: (verdict: RefereeVerdict) => void
  private readonly log: (message: string) => void

  private host: MatchHost | null = null
  private matchId: string | null = null
  private aborted = false

  constructor(options: RefereeOptions = {}) {
    this.store = options.store ?? new MatchStore()
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
   * Take a client.
   *
   * Nothing is assumed about who it is: a client states its build, and may then
   * open a match, resume one, or send intents for a match already open.
   */
  attach(transport: Transport): void {
    const client: Client = { transport, faction: null, build: null }
    this.clients.add(client)

    transport.onFrame((frame) => this.receive(client, frame))
    transport.onClosed((reason) => {
      this.clients.delete(client)
      this.log(`a client left: ${reason}`)
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
        this.open(message.header)
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

  /** Begin watching a match, from the opening position its host states. */
  private open(header: RecordingHeader): void {
    if (this.host) return
    this.matchId = this.store.create(header)
    this.host = new MatchHost(header)
    this.log(`watching match ${this.matchId}, seed ${header.seedLabel}`)
  }

  private record(command: NetworkMessage): void {
    if (!this.matchId || !this.host) return
    this.store.append(this.matchId, {
      turn: this.host.turnNumber,
      faction: this.host.turnManager.activeFaction,
      command,
    })
  }

  private apply(command: NetworkMessage): void {
    if (!this.host) return
    const result = this.host.apply(command)
    if (result.applied) return
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
    const header = this.store.header(matchId)
    if (!header) return this.refuse(client, `no such match: ${matchId}`)

    const events: RecordedEvent[] = this.store.events(matchId, afterSeq)
    this.send(client, { type: 'log', matchId, header, events })
    this.log(`resumed a client into ${matchId} from seq ${afterSeq}: ${events.length} intents`)
  }

  /** Stop watching, releasing the store. */
  dispose(): void {
    for (const client of this.clients) client.transport.close()
    this.clients.clear()
    this.store.close()
  }
}
