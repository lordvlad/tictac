import { distanceKm, isAtRest, type LatLng, positionAt, settle } from '../core/Travel'
import { RPC_ERRORS } from '../wire/Rpc'
import type { AccountsPort } from './AccountsPort'
import type { ServerClock } from './Clock'
import {
  HANDOVER_MAX_ATTEMPTS,
  HANDOVER_RETRY_DELAYS_MS,
  HANDOVER_TIMEOUT_MS,
  HandoverCoordinator,
  type HandoverPeer,
  type HandoverReservation,
  type HandoverStatus,
  type PeerAnswer,
  type PeerRefusal,
  type PreparedHandover,
  type PrepareRequest,
  type RegionPeers,
} from './Handover'
import { Refusal, type Lobby } from './Lobby'
import type { RegionDirectory } from './Owner'
import type { RegionStore } from './RegionStore'
import type { Schedule } from './Schedule'
import type { Serially } from './Serial'

/**
 * A squad crossing from one region to another (RFC-0002 §2, `tictac-dwq.2`):
 * the whole of the two-phase handover that `HandoverCoordinator` keeps the
 * books of, as the region on either end plays its part.
 *
 * **The source** is the region that keeps the squad. A `crossBorder` order
 * walks the squad to the border checkpoint (`Journeys`), and its arrival there
 * — the schedule's `HANDOVER` moment — starts the crossing: the squad's rows
 * are exported and sent to the target to hold as a copy it does not yet keep
 * (`prepareHandover`), and the player's window is offered the way across
 * (`handoverOffer`). Until the target says it has the window, the source is
 * the keeper and nothing about the squad changes here: a refusal, a target
 * that does not answer, a window that does not come before the offer lapses,
 * and a window that says it will not come all end the same way — the target is
 * told to drop its copy, and the next attempt is scheduled by
 * `HANDOVER_RETRY_DELAYS_MS`. After `HANDOVER_MAX_ATTEMPTS` the squad rests at
 * the checkpoint and the player is told why (`handoverFailed`).
 *
 * **The target** commits itself as the keeper when the window arrives
 * (`region/arrive`), and only then asks the source to confirm. The source
 * commits the new keeper, deletes its rows and ends the window's session with
 * `elsewhere` — the one word the client moves on — and a source that will not
 * confirm (the player was seated in a match meanwhile) makes the target undo
 * its commit.
 *
 * **A seated player does not cross.** A match never spans two regions
 * (RFC-0002 §6.4), so a squad whose player holds a seat in a room that is not
 * over waits at the checkpoint: the crossing starts when the room is over,
 * checked every `HANDOVER_RECHECK_MS`. The same wait covers a player with no
 * window open: an offer is for a window to take.
 *
 * **In doubt, and recovery** (`tictac-dwq.7`). Once an offer is out, the
 * source cannot tell a window that never came from a target that committed
 * whose confirmation was lost, and deleting its rows on a guess could leave
 * the squad with nobody. So it does not guess, and neither side forgets what it
 * holds across a restart (`HandoverStore`): when the offer lapses, and when
 * the server is restored, the source asks the target (`handoverStatus`) —
 * `committed` and the source completes the crossing, `dropped` and the target
 * has made sure it never will, so the source keeps the squad and tries again;
 * no answer and the source stays the keeper and asks again, on the same
 * backoff. A source that decides against the handover (the window said it will
 * not come, the player sat down in a match) keeps the reservation, as
 * `cancelled`, until the target has let go of a commit it may already have made,
 * and never completes it. The target, for its part, asks the source to confirm
 * again until it hears: `ok`, or that the source holds nothing of it (it has
 * completed), settles it; a refusal makes the target give the squad back. Between
 * them the squad is kept by exactly one region once both have heard the other.
 *
 * What a crossing *intends* is kept too: the order, the attempts it has had and
 * the moment of the next are restored onto the schedule (`restore`), so a restart
 * between the order and the squad's arrival crosses it at its moment.
 */

/** The schedule's kind for "a squad that was sent across the border is due to start crossing", keyed by squad. */
export const HANDOVER = 'handover'
/**
 * The schedule's kind for "a handover needs resolving", keyed by handover, on the source and the target alike: an
 * offer's time has run out, or an answer that did not come is asked for again.
 */
export const HANDOVER_LAPSE = 'handover-lapse'
/** The schedule's kind for "a target that committed to a squad asks its source again to confirm", keyed by handover. */
export const HANDOVER_SETTLE = 'handover-settle'
/** How long a crossing that cannot start yet (the player is seated, or has no window) waits before looking again. */
export const HANDOVER_RECHECK_MS = 30_000
/** How close to the checkpoint a squad must be to cross from it: a route's end is exact, a squad stopped elsewhere is not there. */
export const AT_CHECKPOINT_KM = 0.01

const NO_PEERS = 'This server has no other region to send a squad to.'
/** What an order to a squad that is crossing is refused with. */
export const CROSSING_IN_FLIGHT = 'Your squad is crossing the border: wait for the crossing to finish.'
const SEATED = 'Your squad is in a match, and a match does not cross the border: it can go when the match is over.'
const NOT_TAKEN = 'The target server did not take the squad in time.'
const CALLED_OFF = 'The crossing was called off.'

/** Where a squad was sent across the border, and for whom. */
interface Intent {
  playerId: string
  region: string
  /** The checkpoint. */
  to: LatLng
}

/** What a target learns of an arrival it committed to, by asking the source to confirm it. */
type Settlement = { kind: 'kept' } | { kind: 'returned'; reason: string } | { kind: 'unknown' }

export interface CrossingsOptions {
  clock: ServerClock
  /** Who keeps which squad: a crossing starts only from the region that keeps the squad. */
  directory: RegionDirectory
  region: Pick<RegionStore, 'squads' | 'exportSquad' | 'importSquad' | 'deleteSquad' | 'handovers'>
  /** Where a player's home is moved when a squad of theirs is kept here: the target's commit, and its undoing. */
  accounts: Pick<AccountsPort, 'moveHome'>
  schedule: Schedule
  /** The queue every writer of a squad's route shares (`Journeys`). */
  serially: Serially
  lobby: Pick<Lobby, 'tell' | 'hasWindow' | 'holdsSeat' | 'endWindow'>
  /** The other regions; unset on a host that has none, which then neither sends nor takes a squad. */
  peers?: RegionPeers
  /** A squad has become this region's: whatever it has due is scheduled (`Journeys.adopt`). */
  adopt: (squadId: string) => Promise<void>
  log?: (message: string) => void
}

export class Crossings implements HandoverPeer {
  readonly coordinator: HandoverCoordinator
  private readonly intents = new Map<string, Intent>()
  /** The arrivals this region is writing the commit of, so a question about one waits for what it will answer. */
  private readonly arriving = new Map<string, Promise<void>>()
  /** How many times each handover's resolution (the source's) or settlement (the target's) has had to be asked again. */
  private readonly asks = new Map<string, number>()
  private readonly options: CrossingsOptions
  private readonly log: (message: string) => void

  constructor(options: CrossingsOptions) {
    this.options = options
    this.log = options.log ?? ((message) => console.warn(`[crossings] ${message}`))
    this.coordinator = new HandoverCoordinator({
      clock: options.clock,
      directory: options.directory,
      squads: options.region.squads,
      log: this.log,
    })
    options.schedule.handle(HANDOVER, (squadId) =>
      options.serially(async () => {
        try {
          await this.depart(squadId)
        } catch (error) {
          // The squad rests where it is; the player may send it across again.
          await this.forget(squadId)
          this.log(`crossing of squad ${squadId} failed: ${error instanceof Error ? error.stack : String(error)}`)
        }
      }),
    )
    options.schedule.handle(HANDOVER_LAPSE, (handoverId) => this.lapse(handoverId))
    options.schedule.handle(HANDOVER_SETTLE, (handoverId) => this.settleArrival(handoverId))
  }

  /**
   * Take up what this region was doing when it last stopped, before a socket
   * is let in and before the squads' own schedule is restored
   * (`Journeys.restore`, which adopts the squads committed here):
   *
   * - **Crossings** go back on the schedule at their moment, with the attempts
   *   they had had.
   * - **Offers this region made as the source** are in doubt: each is
   *   resolved at once, by asking the target.
   * - **Offers it prepared as the target** lapse at their time; and **arrivals
   *   it committed to** are written again as its own (the commit may have been
   *   cut short) and asked of the source until the source has settled them.
   */
  async restore(): Promise<void> {
    const { clock, directory, region: store, schedule } = this.options
    const [intents, outgoing, incoming] = await Promise.all([store.handovers.intents(), store.handovers.outgoing(), store.handovers.incoming()])
    const now = clock.now()

    for (const intent of intents) this.coordinator.setAttempts(intent.squadId, intent.attempts)
    this.coordinator.restoreOutgoing(outgoing)
    const out = new Set(outgoing.map((reservation) => reservation.squadId))
    for (const { squadId, playerId, region, to, nextAt } of intents) {
      this.intents.set(squadId, { playerId, region, to })
      // A squad with an offer out is crossing already: resolving the offer schedules its next attempt.
      if (!out.has(squadId)) schedule.set(HANDOVER, squadId, nextAt)
    }
    for (const reservation of outgoing) schedule.set(HANDOVER_LAPSE, reservation.handoverId, now)

    const prepared = incoming.filter(({ state }) => state === 'prepared')
    const committed = incoming.filter(({ state }) => state === 'committed')
    this.coordinator.restoreIncoming(prepared, committed)
    for (const handover of prepared) schedule.set(HANDOVER_LAPSE, handover.handoverId, handover.expiresAt + 1)
    for (const handover of committed) {
      await store.squads.setOwner(handover.squadId, directory.self)
      schedule.set(HANDOVER_SETTLE, handover.handoverId, now)
    }
  }

  // --- The source: what `Journeys` asks -------------------------------------------------------

  /** Refuse an order to cross to `region` that this server cannot carry out. */
  check(region: string): void {
    const { directory, peers } = this.options
    if (!peers || !directory.isRegion(region) || region === directory.self) throw new Refusal(RPC_ERRORS.conflict, NO_PEERS)
  }

  /**
   * `squadId` was sent to the checkpoint `to` to cross into `region`: it
   * crosses when it gets there, `at`. Replaces whatever it was going to do, and
   * starts its attempts from the first.
   */
  async intend(playerId: string, squadId: string, region: string, to: LatLng, at: number): Promise<void> {
    await this.options.region.handovers.saveIntent({ squadId, playerId, region, to, attempts: 0, nextAt: at })
    this.intents.set(squadId, { playerId, region, to })
    this.coordinator.resetAttempts(squadId)
    // Cleared first so it is the last of the squad's moments at `at`: the arrival and the checkpoints due then are handled before it crosses.
    this.options.schedule.clear(HANDOVER, squadId)
    this.options.schedule.set(HANDOVER, squadId, at)
  }

  /** The squad was given another order, or was found by one: it is not going to cross. */
  async withdraw(squadId: string): Promise<void> {
    this.options.schedule.clear(HANDOVER, squadId)
    this.coordinator.resetAttempts(squadId)
    // Nothing is written for a squad that was never going to cross: most orders are not crossings.
    if (this.intents.has(squadId)) await this.forget(squadId)
  }

  /** Whether a handover of `squadId` is out: its rows are copied at another region, and neither may change before it is settled. */
  inFlight(squadId: string): boolean {
    return this.coordinator.reservationOf(squadId) !== undefined
  }

  /**
   * Whether `playerId`'s window is expected here, as the target of a handover:
   * an offer held for them that nobody has claimed and whose time has not run
   * out. It signs in here before it arrives, while the squad is still the
   * source's.
   */
  expects(playerId: string): boolean {
    return this.coordinator.expects(playerId)
  }

  /**
   * The squad has reached its checkpoint, or this is a retry: offer its player
   * the way across. Runs on the squads' queue.
   */
  private async depart(squadId: string): Promise<void> {
    const { clock, directory, lobby, peers, region: store, schedule } = this.options
    const intent = this.intents.get(squadId)
    if (!intent || !peers) return
    const row = await store.squads.byId(squadId)
    if (!row || (await directory.ownerOfSquad(squadId)) !== directory.self) {
      await this.forget(squadId)
      return
    }
    const now = clock.now()
    const settled = settle(row.squad.waypoints, now)
    if (!isAtRest(settled) || distanceKm(positionAt(settled, now).position, intent.to) > AT_CHECKPOINT_KM) {
      // Something else moved the squad off its route: the order is spent.
      await this.forget(squadId)
      return
    }
    if (lobby.holdsSeat(intent.playerId) || !lobby.hasWindow(intent.playerId)) {
      schedule.set(HANDOVER, squadId, now + HANDOVER_RECHECK_MS)
      return
    }
    const bundle = await store.exportSquad(squadId)
    if (!bundle) {
      await this.forget(squadId)
      return
    }

    const handoverId = crypto.randomUUID()
    const token = crypto.randomUUID()
    const targetUrl = peers.urlOf(intent.region)
    const reservation = await this.coordinator.initiate({
      handoverId,
      playerId: intent.playerId,
      squadId,
      sourceRegion: directory.self,
      targetRegion: intent.region,
      targetUrl,
      token,
    })
    schedule.set(HANDOVER_LAPSE, handoverId, reservation.expiresAt + 1)
    let answer: PeerAnswer
    try {
      answer = await this.asked(() =>
        peers.peer(intent.region).prepareHandover({
          handoverId,
          playerId: intent.playerId,
          squadId,
          sourceRegion: directory.self,
          targetRegion: intent.region,
          token,
          expiresAt: reservation.expiresAt,
          bundle,
        }),
      )
    } catch (error) {
      await this.failedBeforeOffer(reservation, `${intent.region} could not be reached: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!answer.ok) {
      await this.failedBeforeOffer(reservation, answer.message)
      return
    }
    // Written before the window is told: from the moment it has the ticket the target may commit, and a restart must find the handover in doubt.
    try {
      await store.handovers.saveOutgoing(reservation)
    } catch (error) {
      await this.failedBeforeOffer(reservation, `the offer could not be recorded: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    lobby.tell(intent.playerId, 'tictac/api/region/handoverOffer', {
      handoverId,
      squadId,
      targetRegion: intent.region,
      targetUrl,
      token,
      expiresAt: reservation.expiresAt,
    })
  }

  /**
   * `playerId`'s window will not take handover `handoverId` (`region/cancelHandover`).
   * Whether another attempt is scheduled comes back. `gone` for a handover
   * this server holds no longer, `notYours` for another player's, `conflict`
   * for one already confirmed.
   */
  async cancel(playerId: string, handoverId: string, reason: string): Promise<{ cancelled: boolean; retry: boolean }> {
    const outgoing = this.coordinator.reservation(handoverId)
    if (outgoing) {
      if (outgoing.playerId !== playerId) throw new Refusal(RPC_ERRORS.notYours, 'That handover is another player\'s.')
      await this.abort(handoverId)
      // The window is waiting to hear that the target let go.
      const { retry } = await this.letGo(outgoing, reason)
      return { cancelled: true, retry }
    }
    // The window may also say so to the region it was going to.
    const incoming = this.coordinator.prepared(handoverId)
    if (!incoming) throw new Refusal(RPC_ERRORS.gone, 'Unknown handover reservation.')
    if (incoming.playerId !== playerId) throw new Refusal(RPC_ERRORS.notYours, 'That handover is another player\'s.')
    await this.dropCopy(handoverId)
    return { cancelled: true, retry: false }
  }

  /**
   * Decide against handover `handoverId`, which is out: from now on it cannot
   * be completed, whatever the target says. It stays, `cancelled`, until the
   * target has let go (`letGo`). `gone` for one this server holds no longer,
   * `conflict` for one already being completed.
   */
  private async abort(handoverId: string): Promise<void> {
    const reservation = this.coordinator.abort(handoverId)
    // A restart that does not find this finds the offer in doubt and asks the target: if it committed, the crossing completes, which is a decision too.
    await this.recorded(this.options.region.handovers.saveOutgoing(reservation), `that handover ${handoverId} was called off`)
  }

  /**
   * Make the target let go of a handover this region has decided against, and
   * only then finish it: until the target says so it may hold a commit, and
   * the squad must not be kept by both. A target that cannot be asked is asked
   * again on the backoff.
   */
  private async letGo(reservation: HandoverReservation, reason: string): Promise<{ retry: boolean }> {
    const { peers } = this.options
    const { handoverId, squadId, targetRegion } = reservation
    try {
      if (!peers) throw new Refusal(RPC_ERRORS.conflict, NO_PEERS)
      const answer = await this.asked(() => peers.peer(targetRegion).cancelHandover(handoverId))
      if (answer.ok) return await this.failed(handoverId, reason)
      this.log(`${targetRegion} would not let go of ${squadId}: ${answer.message}`)
    } catch (error) {
      this.log(`could not tell ${targetRegion} to let go of ${squadId}: ${String(error)}`)
    }
    this.askAgain(HANDOVER_LAPSE, handoverId)
    return { retry: reservation.attempts < HANDOVER_MAX_ATTEMPTS }
  }

  /**
   * End this attempt of handover `handoverId`, which this region is the
   * source of and which the target is known not to hold: the next attempt is
   * scheduled, or the squad rests. Nothing for one that is settled already.
   */
  private async failed(handoverId: string, reason: string): Promise<{ retry: boolean }> {
    const { clock, lobby, region: store, schedule } = this.options
    const reservation = this.coordinator.reservation(handoverId)
    if (!reservation) return { retry: false }
    const outcome = this.coordinator.cancel(handoverId, reason)
    schedule.clear(HANDOVER_LAPSE, handoverId)
    this.asks.delete(handoverId)
    const { squadId, playerId, targetRegion } = reservation
    const intent = this.intents.get(squadId)
    await this.recorded(store.handovers.remove(handoverId), `the end of handover ${handoverId}`)
    if (outcome.retryable) {
      const nextAt = clock.now() + outcome.nextDelayMs
      schedule.set(HANDOVER, squadId, nextAt)
      if (intent) await this.recorded(store.handovers.saveIntent({ squadId, ...intent, attempts: outcome.attempts, nextAt }), `attempt ${outcome.attempts} of ${squadId}`)
      this.log(`crossing of squad ${squadId} to ${targetRegion} failed (${reason}); next attempt in ${outcome.nextDelayMs} ms`)
      return { retry: true }
    }
    await this.forget(squadId)
    this.log(`crossing of squad ${squadId} to ${targetRegion} given up after ${outcome.attempts} attempts (${reason})`)
    const row = await store.squads.byId(squadId)
    if (row) lobby.tell(playerId, 'tictac/api/squad/changed', { squad: row.squad })
    lobby.tell(playerId, 'tictac/api/region/handoverFailed', { squadId, targetRegion, reason })
    return { retry: false }
  }

  /**
   * An attempt that failed before the offer was out: the target cannot have
   * been given a window that could commit, so it is simply over, and the
   * target told to drop its copy — it would anyway when the offer lapses, so
   * a failure to say so is only worth a line, and the schedule's firing does
   * not wait on the answer.
   */
  private async failedBeforeOffer(reservation: HandoverReservation, reason: string): Promise<void> {
    await this.failed(reservation.handoverId, reason)
    void this.tellTarget(reservation)
  }

  private tellTarget(reservation: HandoverReservation): Promise<void> {
    const { peers } = this.options
    if (!peers) return Promise.resolve()
    return this.asked(() => peers.peer(reservation.targetRegion).cancelHandover(reservation.handoverId)).then(
      (answer) => {
        if (!answer.ok) this.log(`${reservation.targetRegion} would not drop its copy of ${reservation.squadId}: ${answer.message}`)
      },
      (error: unknown) => this.log(`could not tell ${reservation.targetRegion} to drop ${reservation.squadId}: ${String(error)}`),
    )
  }

  /** The time of handover `handoverId` ran out, or a question about it is asked again, on whichever side this region is. */
  private async lapse(handoverId: string): Promise<void> {
    const now = this.options.clock.now()
    try {
      if (this.coordinator.reservation(handoverId)) await this.resolve(handoverId)
      const incoming = this.coordinator.prepared(handoverId)
      if (incoming && now > incoming.expiresAt) await this.dropCopy(handoverId)
    } catch (error) {
      this.log(`lapse of handover ${handoverId} failed: ${error instanceof Error ? error.stack : String(error)}`)
    }
  }

  /**
   * An offer this region made is in doubt: the target says what became of
   * it. Whatever it commits to is final — `committed` completes the crossing,
   * and `dropped` means it holds nothing and never will, so the squad is kept
   * and the attempt over — and a target that does not answer changes nothing:
   * the source is still the keeper, and asks again.
   */
  private async resolve(handoverId: string): Promise<void> {
    const { peers, serially } = this.options
    const reservation = this.coordinator.reservation(handoverId)
    if (!reservation) return
    if (reservation.state === 'cancelled') {
      await this.letGo(reservation, CALLED_OFF)
      return
    }
    let answer: PeerAnswer<{ status: HandoverStatus }>
    try {
      if (!peers) throw new Refusal(RPC_ERRORS.conflict, NO_PEERS)
      // Not on the squads' queue: the target may be waiting on this region's confirmation to answer.
      answer = await this.asked(() => peers.peer(reservation.targetRegion).handoverStatus(handoverId))
    } catch (error) {
      this.log(`${reservation.targetRegion} did not say what became of handover ${handoverId}: ${String(error)}`)
      this.askAgain(HANDOVER_LAPSE, handoverId)
      return
    }
    if (!answer.ok) {
      this.log(`${reservation.targetRegion} refused to say what became of handover ${handoverId}: ${answer.message}`)
      this.askAgain(HANDOVER_LAPSE, handoverId)
      return
    }
    const { status } = answer
    await serially(async () => {
      const current = this.coordinator.reservation(handoverId)
      if (!current) return
      if (status === 'dropped') {
        await this.failed(handoverId, NOT_TAKEN)
      } else if (current.state === 'offered') {
        await this.complete(current)
      } else {
        // The target committed, and this region has decided against it: it is told to give the squad back.
        await this.letGo(current, CALLED_OFF)
      }
    })
  }

  /** Ask again after the next of the backoff's delays: `kind`'s handler runs for `handoverId` then. */
  private askAgain(kind: string, handoverId: string): void {
    const asked = this.asks.get(handoverId) ?? 0
    this.asks.set(handoverId, asked + 1)
    const delay = HANDOVER_RETRY_DELAYS_MS[Math.min(asked, HANDOVER_RETRY_DELAYS_MS.length - 1)]!
    this.options.schedule.set(kind, handoverId, this.options.clock.now() + delay)
  }

  // --- The target: what `Sessions` and the source ask -----------------------------------------

  /** The source asks this region to hold a squad for a window about to arrive. */
  async prepareHandover({ bundle, ...prepared }: PrepareRequest): Promise<PeerAnswer> {
    const { directory, region: store, schedule } = this.options
    try {
      const { squad } = bundle
      if (squad.id !== prepared.squadId || squad.playerId !== prepared.playerId || squad.owner !== prepared.sourceRegion) {
        throw new Refusal(RPC_ERRORS.badInput, 'The squad sent is not the one the handover names.')
      }
      if (prepared.sourceRegion === directory.self) {
        throw new Refusal(RPC_ERRORS.badInput, `A handover from ${directory.self} to itself is no handover.`)
      }
      if ((await directory.ownerOfSquad(prepared.squadId)) === directory.self) {
        throw new Refusal(RPC_ERRORS.conflict, 'This region already keeps that squad.')
      }
      this.coordinator.prepare(prepared)
      try {
        // The record first: one without a copy is dropped at its lapse, a copy without a record would be nobody's to drop.
        await store.handovers.saveIncoming(prepared, 'prepared')
        await store.importSquad(bundle)
      } catch (error) {
        this.coordinator.withdraw(prepared.handoverId)
        await this.recorded(store.handovers.remove(prepared.handoverId), `that handover ${prepared.handoverId} was not prepared`)
        throw error
      }
      schedule.set(HANDOVER_LAPSE, prepared.handoverId, prepared.expiresAt + 1)
      return { ok: true }
    } catch (error) {
      return this.answered(error)
    }
  }

  /**
   * `playerId`'s window arrived (`region/arrive`): this region commits itself
   * as the squad's keeper, and has the source confirm — and let go — before it
   * answers. A source that refuses leaves the squad its own, as it was.
   */
  async arrive(playerId: string, handoverId: string, token: string, squadId: string): Promise<{ committed: boolean; targetRegion: string }> {
    const { adopt, directory, schedule } = this.options
    const prepared = this.coordinator.arrive(handoverId, token, squadId, playerId)
    schedule.clear(HANDOVER_LAPSE, handoverId)
    const committing = this.commit(prepared)
    this.arriving.set(handoverId, committing)
    try {
      await committing
    } catch (error) {
      // Not committed after all: the offer is held again, and lapses at its time.
      this.coordinator.unclaim(handoverId)
      schedule.set(HANDOVER_LAPSE, handoverId, prepared.expiresAt + 1)
      throw error
    } finally {
      this.arriving.delete(handoverId)
    }

    const settlement = await this.settlement(prepared)
    if (settlement.kind === 'returned') throw new Refusal(RPC_ERRORS.conflict, settlement.reason)
    // This region keeps the squad from here whatever the source says: a lost confirmation settles later.
    await adopt(squadId)
    if (settlement.kind === 'unknown') {
      this.askAgain(HANDOVER_SETTLE, handoverId)
      throw new Refusal(RPC_ERRORS.conflict, 'The source server did not answer; the crossing is being settled.')
    }
    return { committed: true, targetRegion: directory.self }
  }

  /**
   * Write this region down as the squad's keeper, and the player's home with
   * it. The record goes first: a keeper nobody can say is a keeper is the one
   * way the source could be told `dropped` while a squad is kept here.
   */
  private async commit(prepared: PreparedHandover): Promise<void> {
    const { accounts, directory, region: store } = this.options
    await store.handovers.saveIncoming(prepared, 'committed')
    try {
      await store.squads.setOwner(prepared.squadId, directory.self)
      await accounts.moveHome(prepared.playerId, directory.self)
    } catch (error) {
      await store.squads.setOwner(prepared.squadId, prepared.sourceRegion)
      await store.handovers.saveIncoming(prepared, 'prepared')
      throw error
    }
  }

  /**
   * Ask the source to confirm an arrival this region committed to, and take
   * its word. `ok` settles it, and so does `gone`: a source that holds
   * nothing of it has completed — one that decided against it keeps the
   * reservation until this region has let go. A refusal is definite: the
   * source keeps the squad, and this region's copy goes. Anything else, and a
   * source that cannot be reached, leaves the commit as it is: the source
   * deletes its rows on confirming, and a squad kept by neither is lost where
   * one kept by both is only a conflict to settle.
   */
  private async settlement(prepared: PreparedHandover): Promise<Settlement> {
    const { peers, region: store, schedule } = this.options
    const { handoverId, squadId, sourceRegion } = prepared
    let answer: PeerAnswer
    try {
      if (!peers) throw new Refusal(RPC_ERRORS.conflict, NO_PEERS)
      answer = await this.asked(() => peers.peer(sourceRegion).confirmArrival(handoverId))
    } catch (error) {
      this.log(`${sourceRegion} did not answer the arrival of ${squadId}: ${String(error)}`)
      return { kind: 'unknown' }
    }
    // The source decided against it and has been let go of it meanwhile (`cancelHandover`): there is nothing to settle.
    if (!this.coordinator.arrivedAt(handoverId)) return { kind: 'returned', reason: CALLED_OFF }
    if (answer.ok || answer.code === RPC_ERRORS.gone) {
      this.coordinator.settle(handoverId)
      schedule.clear(HANDOVER_SETTLE, handoverId)
      this.asks.delete(handoverId)
      await this.recorded(store.handovers.remove(handoverId), `that handover ${handoverId} is settled`)
      return { kind: 'kept' }
    }
    if (answer.code === RPC_ERRORS.conflict) {
      await this.giveBack(prepared)
      return { kind: 'returned', reason: answer.message }
    }
    this.log(`${sourceRegion} would not settle the arrival of ${squadId}: ${answer.message}`)
    return { kind: 'unknown' }
  }

  /** The source has not confirmed an arrival this region committed to: ask again. */
  private async settleArrival(handoverId: string): Promise<void> {
    const { accounts } = this.options
    const prepared = this.coordinator.arrivedAt(handoverId)
    if (!prepared) return
    try {
      // The player's home was moved with the commit; a restart may have cut that short, and it is as much a part of the commit as the keeper.
      await accounts.moveHome(prepared.playerId, this.options.directory.self)
      const settlement = await this.settlement(prepared)
      if (settlement.kind === 'unknown') this.askAgain(HANDOVER_SETTLE, handoverId)
    } catch (error) {
      this.log(`settling the arrival of ${prepared.squadId} failed: ${error instanceof Error ? error.stack : String(error)}`)
      this.askAgain(HANDOVER_SETTLE, handoverId)
    }
  }

  /** Undo a commit this region made: the squad is the source's, and nothing of it is kept here. */
  private async giveBack(prepared: PreparedHandover): Promise<void> {
    const { accounts, region: store, schedule } = this.options
    const { handoverId, squadId, playerId, sourceRegion } = prepared
    // Whoever gets here first undoes it, and the other finds nothing left to undo.
    if (!this.coordinator.arrivedAt(handoverId)) return
    this.coordinator.settle(handoverId)
    schedule.clear(HANDOVER_SETTLE, handoverId)
    this.asks.delete(handoverId)
    await accounts.moveHome(playerId, sourceRegion)
    await store.squads.setOwner(squadId, sourceRegion)
    await store.deleteSquad(squadId)
    await store.handovers.remove(handoverId)
  }

  /** Drop what this region wrote for an offer that will not be taken, unless it has since become the squad's keeper. */
  private async dropCopy(handoverId: string): Promise<void> {
    const { directory, region: store, schedule } = this.options
    const prepared = this.coordinator.withdraw(handoverId)
    if (!prepared) return
    schedule.clear(HANDOVER_LAPSE, handoverId)
    if ((await directory.ownerOfSquad(prepared.squadId)) !== directory.self) await store.deleteSquad(prepared.squadId)
    await store.handovers.remove(handoverId)
  }

  /**
   * The source has decided against the handover: the copy goes, and so does a
   * commit this region made, which is given back. Only the source says so.
   */
  async cancelHandover(handoverId: string): Promise<PeerAnswer> {
    try {
      await this.arriving.get(handoverId)?.catch(() => {})
      const arrived = this.coordinator.arrivedAt(handoverId)
      if (arrived) await this.giveBack(arrived)
      else await this.dropCopy(handoverId)
      return { ok: true }
    } catch (error) {
      return this.answered(error)
    }
  }

  /**
   * What became of the handover, for a source that is in doubt: `committed` if
   * this region keeps the squad for it, and otherwise `dropped` — said only
   * after the copy it may still hold is gone, so that it can never commit it.
   * A commit being written waits to be answered for.
   */
  async handoverStatus(handoverId: string): Promise<PeerAnswer<{ status: HandoverStatus }>> {
    try {
      await this.arriving.get(handoverId)?.catch(() => {})
      if (this.coordinator.arrivedAt(handoverId)) return { ok: true, status: 'committed' }
      await this.dropCopy(handoverId)
      return { ok: true, status: 'dropped' }
    } catch (error) {
      return this.answered(error)
    }
  }

  /**
   * The target says the window arrived and keeps the squad: commit the new
   * keeper, let go of the rows, and end the window's session so it moves.
   * Refused while the player holds a seat, which they may have taken since the
   * offer: the target then puts the squad back. Not refused for an offer whose
   * time has run out: the target committed before it did, which is why it asks.
   */
  confirmArrival(handoverId: string): Promise<PeerAnswer> {
    const { lobby } = this.options
    return this.options.serially(async () => {
      try {
        const reservation = this.coordinator.reservation(handoverId)
        if (!reservation) throw new Refusal(RPC_ERRORS.gone, 'Unknown handover reservation.')
        if (reservation.state === 'cancelled') throw new Refusal(RPC_ERRORS.conflict, 'Handover was cancelled.')
        if (lobby.holdsSeat(reservation.playerId)) {
          // Decided: the lapse tells the target to let go if its commit survives this refusal.
          await this.abort(handoverId)
          throw new Refusal(RPC_ERRORS.conflict, SEATED)
        }
        await this.complete(reservation)
        return { ok: true }
      } catch (error) {
        return this.answered(error)
      }
    })
  }

  /**
   * The target keeps the squad: commit the new keeper, let go of the rows, and
   * end the window's session. On the squads' queue.
   */
  private async complete(reservation: HandoverReservation): Promise<void> {
    const { lobby, region: store, schedule } = this.options
    const { handoverId, squadId } = reservation
    await this.coordinator.confirm(handoverId)
    schedule.clear(HANDOVER_LAPSE, handoverId)
    this.asks.delete(handoverId)
    await this.forget(squadId)
    // The keeper is committed: a failure to tidy up what was left is a line in the log, not a crossing undone.
    await store.deleteSquad(squadId).catch((error: unknown) => {
      this.log(`could not delete squad ${squadId} after it crossed: ${String(error)}`)
    })
    await this.recorded(store.handovers.remove(handoverId), `that handover ${handoverId} is complete`)
    lobby.endWindow(reservation.playerId, {
      reason: `Your squad crossed into ${reservation.targetRegion}.`,
      reconnect: 'elsewhere',
      url: reservation.targetUrl,
    })
  }

  // --- Both ----------------------------------------------------------------------------------

  /** The squad is not going to cross: forget its order, here and in the database. */
  private async forget(squadId: string): Promise<void> {
    this.intents.delete(squadId)
    await this.recorded(this.options.region.handovers.removeIntent(squadId), `that squad ${squadId} is not crossing`)
  }

  /**
   * A write that records what happened, which does not decide it: when it
   * fails the crossing goes on, and the line says what a restart will find.
   */
  private async recorded(write: Promise<void>, what: string): Promise<void> {
    try {
      await write
    } catch (error) {
      this.log(`could not record ${what}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** A refusal as the answer to a peer; anything else is this region's failure and is told as one. */
  private answered(error: unknown): PeerRefusal {
    if (error instanceof Refusal) return { ok: false, code: error.code, message: error.message }
    this.log(`a handover call failed: ${error instanceof Error ? error.stack : String(error)}`)
    return { ok: false, code: RPC_ERRORS.serverFailed, message: 'the server failed' }
  }

  /**
   * A call to another region, which answers within `HANDOVER_TIMEOUT_MS` on the
   * host's clock or is taken as failed: a region that never answers must not
   * hold the schedule's one firing, and so every squad's arrival, for good.
   * A region that does not answer, or whose call fails, rejects: not knowing
   * what it did is not the same as being refused.
   */
  private async asked<Reply extends object>(call: () => Promise<PeerAnswer<Reply>>): Promise<PeerAnswer<Reply>> {
    const { promise, resolve, reject } = Promise.withResolvers<PeerAnswer<Reply>>()
    const cancel = this.options.clock.schedule(() => reject(new Error('the other region did not answer in time')), HANDOVER_TIMEOUT_MS)
    Promise.resolve().then(call).then(resolve, reject)
    try {
      return await promise
    } finally {
      cancel()
    }
  }
}
