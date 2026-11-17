import type { ServerClock } from './Clock'
import { Refusal } from './Lobby'
import type { RegionDirectory } from './Owner'
import type { Squads } from './Squads'
import { RPC_ERRORS } from '../wire/Rpc'

/**
 * Two-Phase Commit Handover Coordinator (RFC-0002 / tictac-dwq).
 *
 * Coordinates cross-region handovers between Durable Objects.
 * When a squad crosses a regional boundary:
 * 1. Source DO creates an in-flight handover reservation and calls Target DO (prepare).
 * 2. Source DO pushes `handoverOffer` (with the squad's id) to client with a temporary ticket.
 * 3. Client connects second socket to Target DO and calls `region/arrive`, the first staying open.
 * 4. Target DO confirms arrival to Source DO via `confirmArrival`.
 * 5. Source DO commits the new keeper (`Squads.setOwner`, the durable fact `RegionDirectory.ownerOfSquad`
 *    reads), purges local squad simulation and ends the session with `session/ended`
 *    `{ reconnect: 'elsewhere', url }` on the primary socket.
 * 6. Client moves onto the second socket in place and lets the primary go without redialling it
 *    (`ServerConnection.moveOver`).
 *
 * If Target DO fails or client times out, the handover aborts and Source DO remains authoritative,
 * retrying according to `HANDOVER_RETRY_DELAYS_MS` up to `HANDOVER_MAX_ATTEMPTS`.
 */

export const HANDOVER_TIMEOUT_MS = 15_000

/**
 * Delays between retry attempts after a failed/cancelled handover:
 * 2s, 5s, 10s, 30s, 60s.
 */
export const HANDOVER_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000, 60_000]
export const HANDOVER_MAX_ATTEMPTS = 5

export interface HandoverReservation {
  handoverId: string
  playerId: string
  squadId: string
  sourceRegion: string
  targetRegion: string
  targetUrl: string
  token: string
  expiresAt: number
  attempts: number
  /** State on source DO: 'offered' | 'confirmed' | 'cancelled' | 'failed' */
  state: 'offered' | 'confirmed' | 'cancelled' | 'failed'
}

export interface PreparedHandover {
  handoverId: string
  playerId: string
  squadId: string
  /** The region the squad is going to: the one that prepared this must be it. */
  targetRegion: string
  token: string
  expiresAt: number
}

export class HandoverCoordinator {
  /** Active outgoing handovers where this server is the Source DO. */
  private readonly outgoing = new Map<string, HandoverReservation>()
  /** Active incoming reservations where this server is the Target DO. */
  private readonly incoming = new Map<string, PreparedHandover>()
  /** Track retry attempts per squad across sequential failures. */
  private readonly attemptCount = new Map<string, number>()
  private readonly log: (msg: string) => void
  private readonly clock: ServerClock
  private readonly directory: RegionDirectory
  private readonly squads: Pick<Squads, 'setOwner'>

  constructor(options: {
    clock: ServerClock
    /** Who keeps which squad: a handover starts only from the region that keeps the squad, and arrives only at its target. */
    directory: RegionDirectory
    /** Where the new keeper is committed when a handover is confirmed. */
    squads: Pick<Squads, 'setOwner'>
    log?: (msg: string) => void
  }) {
    this.clock = options.clock
    this.directory = options.directory
    this.squads = options.squads
    this.log = options.log ?? (() => {})
  }

  /**
   * Called on Target DO: prepare reservation for an incoming squad.
   * Invoked via DO-to-DO RPC or internal bridge.
   */
  prepare(handover: PreparedHandover): { prepared: boolean } {
    if (handover.targetRegion !== this.directory.self) {
      throw new Refusal(RPC_ERRORS.badInput, `Handover ${handover.handoverId} is for ${handover.targetRegion}, not ${this.directory.self}.`)
    }
    this.cleanupExpired()
    this.incoming.set(handover.handoverId, handover)
    this.log(`Handover ${handover.handoverId} prepared for squad ${handover.squadId}`)
    return { prepared: true }
  }

  /**
   * Called on Source DO: initiate or retry an outgoing handover for a squad.
   */
  async initiate(options: {
    handoverId: string
    playerId: string
    squadId: string
    sourceRegion: string
    targetRegion: string
    targetUrl: string
    token: string
    ttlMs?: number
  }): Promise<HandoverReservation> {
    const { self } = this.directory
    if (options.sourceRegion !== self || options.targetRegion === self) {
      throw new Refusal(RPC_ERRORS.badInput, `A handover from ${options.sourceRegion} to ${options.targetRegion} is not this region's (${self}) to start.`)
    }
    if ((await this.directory.ownerOfSquad(options.squadId)) !== self) {
      throw new Refusal(RPC_ERRORS.conflict, 'That squad is kept by another match server.')
    }
    this.cleanupExpired()
    const currentAttempts = (this.attemptCount.get(options.squadId) ?? 0) + 1
    this.attemptCount.set(options.squadId, currentAttempts)

    const expiresAt = this.clock.now() + (options.ttlMs ?? HANDOVER_TIMEOUT_MS)
    const reservation: HandoverReservation = {
      ...options,
      attempts: currentAttempts,
      expiresAt,
      state: 'offered',
    }
    this.outgoing.set(options.handoverId, reservation)
    this.log(`Handover ${options.handoverId} offered to player ${options.playerId} (attempt ${currentAttempts})`)
    return reservation
  }

  /**
   * Called on Target DO when client invokes `tictac/api/region/arrive`.
   * Verifies the reservation, marks it claimed, and returns confirmation details.
   */
  arrive(handoverId: string, token: string, squadId: string): PreparedHandover {
    this.cleanupExpired()
    const prepared = this.incoming.get(handoverId)
    if (!prepared) {
      throw new Refusal(RPC_ERRORS.badInput, 'Invalid or expired handover ID.')
    }
    if (prepared.token !== token) {
      throw new Refusal(RPC_ERRORS.signInFirst, 'Handover ticket mismatch.')
    }
    if (prepared.squadId !== squadId) {
      throw new Refusal(RPC_ERRORS.badInput, 'Handover squad ID mismatch.')
    }
    if (this.clock.now() > prepared.expiresAt) {
      this.incoming.delete(handoverId)
      throw new Refusal(RPC_ERRORS.conflict, 'Handover offer has expired.')
    }
    this.incoming.delete(handoverId)
    this.log(`Squad ${squadId} arrived at target DO under handover ${handoverId}`)
    return prepared
  }

  /**
   * Called on Source DO (via DO-to-DO confirmation or arrive completion):
   * Confirms client arrival on target DO and commits the target as the
   * squad's keeper (`Squads.setOwner`) — the 2PC's commit step.
   *
   * The reservation is claimed (`confirmed`) before the write is awaited, so
   * a `cancel` that arrives while the keeper is being written is refused
   * instead of landing between the write and the bookkeeping and leaving a
   * committed handover that was also cancelled. A failed write gives the claim
   * back, leaving the reservation to be confirmed again.
   */
  async confirm(handoverId: string): Promise<HandoverReservation> {
    const reservation = this.outgoing.get(handoverId)
    if (!reservation) {
      throw new Refusal(RPC_ERRORS.gone, 'Unknown handover reservation.')
    }
    if (reservation.state === 'cancelled') {
      throw new Refusal(RPC_ERRORS.conflict, 'Handover was cancelled.')
    }
    if (reservation.state === 'confirmed') {
      throw new Refusal(RPC_ERRORS.conflict, 'Handover is already being confirmed.')
    }
    reservation.state = 'confirmed'
    try {
      await this.squads.setOwner(reservation.squadId, reservation.targetRegion)
    } catch (error) {
      reservation.state = 'offered'
      throw error
    }
    this.outgoing.delete(handoverId)
    this.attemptCount.delete(reservation.squadId)
    this.log(`Handover ${handoverId} confirmed by target DO`)
    return reservation
  }

  /**
   * Cancel an outgoing or incoming handover, calculating the next backoff delay if retryable.
   * Returns `{ retryable: boolean, nextDelayMs: number }`. A handover already
   * being confirmed cannot be cancelled: its keeper is being committed.
   */
  cancel(
    handoverId: string,
    reason: string,
  ): { retryable: boolean; nextDelayMs: number; attempts: number } {
    const out = this.outgoing.get(handoverId)
    if (out?.state === 'confirmed') {
      throw new Refusal(RPC_ERRORS.conflict, `Handover ${handoverId} is already confirmed; it cannot be cancelled.`)
    }

    let attempts = 1
    if (out) {
      attempts = out.attempts
      out.state = 'cancelled'
      this.outgoing.delete(handoverId)
      this.log(`Outgoing handover ${handoverId} cancelled (attempt ${attempts}): ${reason}`)
    }
    this.incoming.delete(handoverId)

    if (attempts >= HANDOVER_MAX_ATTEMPTS) {
      if (out) this.attemptCount.delete(out.squadId)
      return { retryable: false, nextDelayMs: 0, attempts }
    }

    const delayIndex = Math.min(attempts - 1, HANDOVER_RETRY_DELAYS_MS.length - 1)
    const nextDelayMs = HANDOVER_RETRY_DELAYS_MS[delayIndex] ?? 60_000
    return { retryable: true, nextDelayMs, attempts }
  }

  /** Current attempt count for squadId. */
  attemptsFor(squadId: string): number {
    return this.attemptCount.get(squadId) ?? 0
  }

  /** Reset attempt counter when squad gives an explicit manual order or rests. */
  resetAttempts(squadId: string): void {
    this.attemptCount.delete(squadId)
  }

  /** Check if a handover is active on source DO. */
  isPending(handoverId: string): boolean {
    const out = this.outgoing.get(handoverId)
    return out !== undefined && out.state === 'offered' && this.clock.now() <= out.expiresAt
  }

  private cleanupExpired(): void {
    const now = this.clock.now()
    for (const [id, res] of this.outgoing.entries()) {
      if (now > res.expiresAt) {
        this.outgoing.delete(id)
        this.log(`Outgoing handover ${id} expired`)
      }
    }
    for (const [id, prep] of this.incoming.entries()) {
      if (now > prep.expiresAt) {
        this.incoming.delete(id)
        this.log(`Incoming handover ${id} expired`)
      }
    }
  }
}
