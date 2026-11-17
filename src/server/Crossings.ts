import { distanceKm, isAtRest, type LatLng, positionAt, settle } from '../core/Travel'
import { RPC_ERRORS } from '../wire/Rpc'
import type { ServerClock } from './Clock'
import {
  HANDOVER_TIMEOUT_MS,
  HandoverCoordinator,
  type HandoverPeer,
  type HandoverReservation,
  type PeerAnswer,
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
 * What a crossing *intends* is memory only. A server that restarts between the
 * order and the squad's arrival forgets it, and the squad simply rests at the
 * checkpoint; so does one that restarts with an offer out, whose copy at the
 * target is overwritten by the next attempt. Neither loses a squad: the
 * source's rows are only ever deleted after the target has committed.
 */

/** The schedule's kind for "a squad that was sent across the border is due to start crossing", keyed by squad. */
export const HANDOVER = 'handover'
/** The schedule's kind for "an offer's time has run out", keyed by handover, on the source and the target alike. */
export const HANDOVER_LAPSE = 'handover-lapse'
/** How long a crossing that cannot start yet (the player is seated, or has no window) waits before looking again. */
export const HANDOVER_RECHECK_MS = 30_000
/** How close to the checkpoint a squad must be to cross from it: a route's end is exact, a squad stopped elsewhere is not there. */
export const AT_CHECKPOINT_KM = 0.01

const NO_PEERS = 'This server has no other region to send a squad to.'
/** What an order to a squad that is crossing is refused with. */
export const CROSSING_IN_FLIGHT = 'Your squad is crossing the border: wait for the crossing to finish.'
const SEATED = 'Your squad is in a match, and a match does not cross the border: it can go when the match is over.'

/** Where a squad was sent across the border, and for whom. */
interface Intent {
  playerId: string
  region: string
  /** The checkpoint. */
  to: LatLng
}

export interface CrossingsOptions {
  clock: ServerClock
  /** Who keeps which squad: a crossing starts only from the region that keeps the squad. */
  directory: RegionDirectory
  region: Pick<RegionStore, 'squads' | 'exportSquad' | 'importSquad' | 'deleteSquad'>
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
          this.intents.delete(squadId)
          this.log(`crossing of squad ${squadId} failed: ${error instanceof Error ? error.stack : String(error)}`)
        }
      }),
    )
    options.schedule.handle(HANDOVER_LAPSE, (handoverId) => this.lapse(handoverId))
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
  intend(playerId: string, squadId: string, region: string, to: LatLng, at: number): void {
    this.intents.set(squadId, { playerId, region, to })
    this.coordinator.resetAttempts(squadId)
    // Cleared first so it is the last of the squad's moments at `at`: the arrival and the checkpoints due then are handled before it crosses.
    this.options.schedule.clear(HANDOVER, squadId)
    this.options.schedule.set(HANDOVER, squadId, at)
  }

  /** The squad was given another order, or was found by one: it is not going to cross. */
  withdraw(squadId: string): void {
    this.intents.delete(squadId)
    this.options.schedule.clear(HANDOVER, squadId)
    this.coordinator.resetAttempts(squadId)
  }

  /** Whether a handover of `squadId` is out: its rows are copied at another region, and neither may change before it is settled. */
  inFlight(squadId: string): boolean {
    return this.coordinator.reservationOf(squadId) !== undefined
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
      this.intents.delete(squadId)
      return
    }
    const now = clock.now()
    const settled = settle(row.squad.waypoints, now)
    if (!isAtRest(settled) || distanceKm(positionAt(settled, now).position, intent.to) > AT_CHECKPOINT_KM) {
      // Something else moved the squad off its route: the order is spent.
      this.intents.delete(squadId)
      return
    }
    if (lobby.holdsSeat(intent.playerId) || !lobby.hasWindow(intent.playerId)) {
      schedule.set(HANDOVER, squadId, now + HANDOVER_RECHECK_MS)
      return
    }
    const bundle = await store.exportSquad(squadId)
    if (!bundle) {
      this.intents.delete(squadId)
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
      await this.failed(handoverId, `${intent.region} could not be reached: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!answer.ok) {
      await this.failed(handoverId, answer.message)
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
      const { retry, targetTold } = await this.failed(handoverId, reason)
      // The window is waiting to hear that the target let go.
      await targetTold
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
   * Give up this attempt of handover `handoverId`, which this region is the
   * source of: the target drops its copy, and the next attempt is scheduled or
   * the squad rests. Nothing for one that is settled already.
   */
  private async failed(handoverId: string, reason: string): Promise<{ retry: boolean; targetTold: Promise<void> }> {
    const { clock, lobby, region: store, schedule } = this.options
    const reservation = this.coordinator.reservation(handoverId)
    if (!reservation) return { retry: false, targetTold: Promise.resolve() }
    const outcome = this.coordinator.cancel(handoverId, reason)
    schedule.clear(HANDOVER_LAPSE, handoverId)
    const targetTold = this.tellTarget(reservation)
    const { squadId, playerId, targetRegion } = reservation
    if (outcome.retryable) {
      schedule.set(HANDOVER, squadId, clock.now() + outcome.nextDelayMs)
      this.log(`crossing of squad ${squadId} to ${targetRegion} failed (${reason}); next attempt in ${outcome.nextDelayMs} ms`)
      return { retry: true, targetTold }
    }
    this.intents.delete(squadId)
    this.log(`crossing of squad ${squadId} to ${targetRegion} given up after ${outcome.attempts} attempts (${reason})`)
    const row = await store.squads.byId(squadId)
    if (row) lobby.tell(playerId, 'tictac/api/squad/changed', { squad: row.squad })
    lobby.tell(playerId, 'tictac/api/region/handoverFailed', { squadId, targetRegion, reason })
    return { retry: false, targetTold }
  }

  /**
   * Tell the target to drop its copy: it would anyway when the offer lapses,
   * so a failure to say so is only worth a line, and callers that are not
   * waiting on the answer (the schedule's firing) do not wait on it.
   */
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

  /** The time of handover `handoverId` ran out, on whichever side this region is. */
  private async lapse(handoverId: string): Promise<void> {
    const now = this.options.clock.now()
    try {
      const outgoing = this.coordinator.reservation(handoverId)
      if (outgoing && now > outgoing.expiresAt) await this.failed(handoverId, 'The target server did not take the squad in time.')
      const incoming = this.coordinator.prepared(handoverId)
      if (incoming && now > incoming.expiresAt) await this.dropCopy(handoverId)
    } catch (error) {
      this.log(`lapse of handover ${handoverId} failed: ${error instanceof Error ? error.stack : String(error)}`)
    }
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
        await store.importSquad(bundle)
      } catch (error) {
        this.coordinator.withdraw(prepared.handoverId)
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
    const { adopt, directory, peers, region: store, schedule } = this.options
    const prepared = this.coordinator.arrive(handoverId, token, squadId, playerId)
    schedule.clear(HANDOVER_LAPSE, handoverId)
    await store.squads.setOwner(squadId, directory.self)
    let answer: PeerAnswer
    try {
      if (!peers) throw new Refusal(RPC_ERRORS.conflict, NO_PEERS)
      answer = await this.asked(() => peers.peer(prepared.sourceRegion).confirmArrival(handoverId))
    } catch (error) {
      // Whether the source heard of the arrival is not known: this region's
      // commit stays, because the source deletes its rows on confirming and a
      // squad kept by neither is lost, where one kept by both is only a
      // conflict to settle.
      this.log(`${prepared.sourceRegion} did not answer the arrival of ${squadId}: ${String(error)}`)
      throw new Refusal(RPC_ERRORS.conflict, 'The source server did not answer; the crossing is being settled.')
    }
    if (!answer.ok) {
      // A refusal is definite: the source keeps the squad, and this region's copy goes.
      await store.squads.setOwner(squadId, prepared.sourceRegion)
      await store.deleteSquad(squadId)
      throw new Refusal(answer.code, answer.message)
    }
    await adopt(squadId)
    return { committed: true, targetRegion: directory.self }
  }

  /** Drop what this region wrote for an offer that will not be taken, unless it has since become the squad's keeper. */
  private async dropCopy(handoverId: string): Promise<void> {
    const { directory, region: store, schedule } = this.options
    const prepared = this.coordinator.withdraw(handoverId)
    if (!prepared) return
    schedule.clear(HANDOVER_LAPSE, handoverId)
    if ((await directory.ownerOfSquad(prepared.squadId)) !== directory.self) await store.deleteSquad(prepared.squadId)
  }

  /** The target's cancel: the source will not send this squad after all. */
  async cancelHandover(handoverId: string): Promise<PeerAnswer> {
    try {
      await this.dropCopy(handoverId)
      return { ok: true }
    } catch (error) {
      return this.answered(error)
    }
  }

  /**
   * The target says the window arrived and keeps the squad: commit the new
   * keeper, let go of the rows, and end the window's session so it moves.
   * Refused while the player holds a seat, which they may have taken since the
   * offer: the target then puts the squad back.
   */
  confirmArrival(handoverId: string): Promise<PeerAnswer> {
    const { lobby, region: store, schedule } = this.options
    return this.options.serially(async () => {
      try {
        const reservation = this.coordinator.reservation(handoverId)
        if (!reservation) throw new Refusal(RPC_ERRORS.gone, 'Unknown handover reservation.')
        if (!this.coordinator.isPending(handoverId)) throw new Refusal(RPC_ERRORS.conflict, 'Handover offer has expired.')
        if (lobby.holdsSeat(reservation.playerId)) throw new Refusal(RPC_ERRORS.conflict, SEATED)
        await this.coordinator.confirm(handoverId)
        schedule.clear(HANDOVER_LAPSE, handoverId)
        this.intents.delete(reservation.squadId)
        // The keeper is committed: a failure to tidy up what was left is a line in the log, not a crossing undone.
        await store.deleteSquad(reservation.squadId).catch((error: unknown) => {
          this.log(`could not delete squad ${reservation.squadId} after it crossed: ${String(error)}`)
        })
        lobby.endWindow(reservation.playerId, {
          reason: `Your squad crossed into ${reservation.targetRegion}.`,
          reconnect: 'elsewhere',
          url: reservation.targetUrl,
        })
        return { ok: true }
      } catch (error) {
        return this.answered(error)
      }
    })
  }

  // --- Both ----------------------------------------------------------------------------------

  /** A refusal as the answer to a peer; anything else is this region's failure and is told as one. */
  private answered(error: unknown): PeerAnswer {
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
  private async asked(call: () => Promise<PeerAnswer>): Promise<PeerAnswer> {
    const { promise, resolve, reject } = Promise.withResolvers<PeerAnswer>()
    const cancel = this.options.clock.schedule(() => reject(new Error('the other region did not answer in time')), HANDOVER_TIMEOUT_MS)
    Promise.resolve().then(call).then(resolve, reject)
    try {
      return await promise
    } finally {
      cancel()
    }
  }
}
