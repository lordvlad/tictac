import type { ServerClock } from './Clock'
import { Refusal } from './Lobby'
import type { RegionDirectory } from './Owner'
import type { SquadBundle } from './RegionStore'
import type { Squads } from './Squads'
import { RPC_ERRORS, type RpcErrorCode } from '../wire/Rpc'

/**
 * Two-Phase Commit Handover bookkeeping (RFC-0002 / tictac-dwq).
 *
 * Coordinates cross-region handovers between Durable Objects; `Crossings`
 * (`Crossings.ts`) drives it. When a squad crosses a regional boundary:
 * 1. Source DO creates an in-flight handover reservation and calls Target DO (`prepareHandover`), which
 *    writes the squad's rows as a copy it does not yet keep.
 * 2. Source DO pushes `handoverOffer` (with the squad's id) to client with a temporary ticket.
 * 3. Client connects second socket to Target DO and calls `region/arrive`, the first staying open.
 * 4. Target DO commits itself as the keeper and confirms arrival to Source DO via `confirmArrival`.
 * 5. Source DO commits the new keeper (`Squads.setOwner`, the durable fact `RegionDirectory.ownerOfSquad`
 *    reads), deletes its own rows for the squad (`RegionStore.deleteSquad`) and ends the session with `session/ended`
 *    `{ reconnect: 'elsewhere', url }` on the primary socket.
 * 6. Client moves onto the second socket in place and lets the primary go without redialling it
 *    (`ServerConnection.moveOver`).
 *
 * If Target DO fails or client times out, the handover aborts and Source DO remains authoritative,
 * retrying according to `HANDOVER_RETRY_DELAYS_MS` up to `HANDOVER_MAX_ATTEMPTS`.
 *
 * **In doubt.** Once the offer is out the source cannot tell a window that never came from a target that
 * committed whose `confirmArrival` was lost, so it does not guess: it asks the target (`handoverStatus`), which
 * answers `committed` — the source then completes — or `dropped`, having forgotten the handover so that it can
 * never commit it, which is what lets the source keep the squad and try again. A source that decides to give up
 * (`abort`) keeps the reservation, as `cancelled`, until the target has let go: from then on the handover cannot be
 * completed, whatever the target says. Both sides keep what they hold in the region's database
 * (`HandoverStore`), so a restart on either side resumes the resolution (`Crossings.restore`).
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
  /** State on source DO: `offered`, `confirmed` while the keeper is being committed, or `cancelled` — decided against, kept until the target has let go. */
  state: 'offered' | 'confirmed' | 'cancelled'
}

export interface PreparedHandover {
  handoverId: string
  playerId: string
  squadId: string
  /** The region the squad is coming from: the one `region/arrive` has confirmed with. */
  sourceRegion: string
  /** The region the squad is going to: the one that prepared this must be it. */
  targetRegion: string
  token: string
  expiresAt: number
}

/** What the source sends the target to prepare: the reservation, and the squad's rows the target writes as a copy it does not yet keep. */
export interface PrepareRequest extends PreparedHandover {
  bundle: SquadBundle
}

/** A refusal: the code and words a region answers another with when it will not. */
export type PeerRefusal = { ok: false; code: RpcErrorCode; message: string }

/**
 * What a region answers another: done (with what it was asked, if it was
 * asked something), or refused. A refusal is data because an exception loses
 * its class crossing a Durable Object boundary (`AccountsRpc.ts`); a call that
 * fails outright — the other region is down — rejects, which the caller
 * treats as a refusal too.
 */
export type PeerAnswer<Reply extends object = object> = ({ ok: true } & Reply) | PeerRefusal

/** What a target keeps of a handover the source asks about: it committed to the squad, or it holds nothing of it any more and never will. */
export type HandoverStatus = 'committed' | 'dropped'

/**
 * What a region answers of another region's handover, over DO RPC
 * (`MatchDurableObject`'s methods of the same names) or in process (tests).
 */
export interface HandoverPeer {
  /** Target: write the squad as a copy not yet kept, and hold the ticket until `expiresAt`. */
  prepareHandover(request: PrepareRequest): Promise<PeerAnswer>
  /** Source: the window has arrived at the target, which keeps the squad now; commit it, let go, end the window's session. */
  confirmArrival(handoverId: string): Promise<PeerAnswer>
  /**
   * Target: the handover will not happen; drop the copy — and, if the target had committed, give the squad back.
   * Only the source says so, once it has decided.
   */
  cancelHandover(handoverId: string): Promise<PeerAnswer>
  /**
   * Target: what became of the handover. `committed` is final; anything else is answered only after the target has
   * made sure it can no longer commit it (a copy it still held is dropped), so the source may keep the squad.
   */
  handoverStatus(handoverId: string): Promise<PeerAnswer<{ status: HandoverStatus }>>
}

/** The other regions, as this host reaches them. */
export interface RegionPeers {
  /** The region's server for DO-to-DO calls. */
  peer(region: string): HandoverPeer
  /** Where a window dials to reach the region: the `targetUrl` of an offer. */
  urlOf(region: string): string
}

export class HandoverCoordinator {
  /** Active outgoing handovers where this server is the Source DO. */
  private readonly outgoing = new Map<string, HandoverReservation>()
  /** Active incoming reservations where this server is the Target DO. */
  private readonly incoming = new Map<string, PreparedHandover>()
  /** Incoming handovers whose window has come: this region has committed to the squad, and answers for it until the source has confirmed. */
  private readonly arrived = new Map<string, PreparedHandover>()
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
   * Invoked via DO-to-DO RPC or internal bridge. It is held until `arrive`
   * claims it or `withdraw` takes it back; an offer nobody claimed is the
   * caller's to withdraw once `expiresAt` has passed, which is why nothing
   * here forgets one on its own: the rows written for it are what is left to
   * drop.
   */
  prepare(handover: PreparedHandover): { prepared: boolean } {
    if (handover.targetRegion !== this.directory.self) {
      throw new Refusal(RPC_ERRORS.badInput, `Handover ${handover.handoverId} is for ${handover.targetRegion}, not ${this.directory.self}.`)
    }
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
    const currentAttempts = (this.attemptCount.get(options.squadId) ?? 0) + 1
    this.attemptCount.set(options.squadId, currentAttempts)

    const { ttlMs, ...offer } = options
    const expiresAt = this.clock.now() + (ttlMs ?? HANDOVER_TIMEOUT_MS)
    const reservation: HandoverReservation = { ...offer, attempts: currentAttempts, expiresAt, state: 'offered' }
    this.outgoing.set(options.handoverId, reservation)
    this.log(`Handover ${options.handoverId} offered to player ${options.playerId} (attempt ${currentAttempts})`)
    return reservation
  }

  /**
   * Called on Target DO when client invokes `tictac/api/region/arrive`.
   * Verifies the reservation is `playerId`'s and the ticket is the one it was
   * given for this squad, claims it, and returns what was prepared.
   *
   * `gone` for a handover this region never prepared (or has already taken
   * back), `notYours` for another player's or a ticket that does not match,
   * `conflict` for one whose time has run out.
   */
  arrive(handoverId: string, token: string, squadId: string, playerId: string): PreparedHandover {
    const prepared = this.incoming.get(handoverId)
    if (!prepared) {
      throw new Refusal(RPC_ERRORS.gone, 'Invalid or expired handover ID.')
    }
    if (prepared.playerId !== playerId) {
      throw new Refusal(RPC_ERRORS.notYours, 'That handover is another player\'s.')
    }
    if (prepared.token !== token) {
      throw new Refusal(RPC_ERRORS.notYours, 'Handover ticket mismatch.')
    }
    if (prepared.squadId !== squadId) {
      throw new Refusal(RPC_ERRORS.notYours, 'Handover squad ID mismatch.')
    }
    if (this.clock.now() > prepared.expiresAt) {
      throw new Refusal(RPC_ERRORS.conflict, 'Handover offer has expired.')
    }
    this.incoming.delete(handoverId)
    this.arrived.set(handoverId, prepared)
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
   * Decide against an outgoing handover that is in doubt: from now on it cannot
   * be confirmed, whatever the target says, and it stays — `cancelled` — until
   * the target has let go and `cancel` finishes it. A handover already being
   * confirmed cannot be given up.
   */
  abort(handoverId: string): HandoverReservation {
    const out = this.outgoing.get(handoverId)
    if (!out) throw new Refusal(RPC_ERRORS.gone, 'Unknown handover reservation.')
    if (out.state === 'confirmed') {
      throw new Refusal(RPC_ERRORS.conflict, `Handover ${handoverId} is already confirmed; it cannot be cancelled.`)
    }
    out.state = 'cancelled'
    return out
  }

  /**
   * Cancel an outgoing handover, calculating the next backoff delay if retryable.
   * Returns `{ retryable: boolean, nextDelayMs: number }`. A handover already
   * being confirmed cannot be cancelled: its keeper is being committed.
   * `gone` for one this region is not the source of.
   */
  cancel(
    handoverId: string,
    reason: string,
  ): { retryable: boolean; nextDelayMs: number; attempts: number } {
    const out = this.outgoing.get(handoverId)
    if (!out) throw new Refusal(RPC_ERRORS.gone, 'Unknown handover reservation.')
    if (out.state === 'confirmed') {
      throw new Refusal(RPC_ERRORS.conflict, `Handover ${handoverId} is already confirmed; it cannot be cancelled.`)
    }

    const { attempts } = out
    out.state = 'cancelled'
    this.outgoing.delete(handoverId)
    this.log(`Outgoing handover ${handoverId} cancelled (attempt ${attempts}): ${reason}`)

    if (attempts >= HANDOVER_MAX_ATTEMPTS) {
      this.attemptCount.delete(out.squadId)
      return { retryable: false, nextDelayMs: 0, attempts }
    }

    const delayIndex = Math.min(attempts - 1, HANDOVER_RETRY_DELAYS_MS.length - 1)
    const nextDelayMs = HANDOVER_RETRY_DELAYS_MS[delayIndex] ?? 60_000
    return { retryable: true, nextDelayMs, attempts }
  }

  /**
   * Take back what this region prepared for an incoming handover, which will
   * not be claimed: the rows written for it are the caller's to drop. Null for
   * one this region holds no longer (claimed, or taken back already).
   */
  withdraw(handoverId: string): PreparedHandover | null {
    const prepared = this.incoming.get(handoverId)
    if (!prepared) return null
    this.incoming.delete(handoverId)
    this.log(`Incoming handover ${handoverId} withdrawn`)
    return prepared
  }

  /** The window arrived but the commit was not made after all: the offer is held again, as it was. */
  unclaim(handoverId: string): void {
    const prepared = this.arrived.get(handoverId)
    if (!prepared) return
    this.arrived.delete(handoverId)
    this.incoming.set(handoverId, prepared)
  }

  /** The source has settled an arrival this region committed to, or the commit has been given back: nothing is left to remember of it. */
  settle(handoverId: string): void {
    this.arrived.delete(handoverId)
  }

  /** The arrival this region committed to under `handoverId`, until the source has settled it. */
  arrivedAt(handoverId: string): PreparedHandover | undefined {
    return this.arrived.get(handoverId)
  }

  /** The outgoing reservation `handoverId` names, if this region is its source and it is still open. */
  reservation(handoverId: string): HandoverReservation | undefined {
    return this.outgoing.get(handoverId)
  }

  /** The incoming reservation `handoverId` names, if this region is its target and it is still held. */
  prepared(handoverId: string): PreparedHandover | undefined {
    return this.incoming.get(handoverId)
  }

  /** The open outgoing reservation of `squadId`, if a handover of it is in flight. */
  reservationOf(squadId: string): HandoverReservation | undefined {
    for (const reservation of this.outgoing.values()) if (reservation.squadId === squadId) return reservation
    return undefined
  }

  /** Current attempt count for squadId. */
  attemptsFor(squadId: string): number {
    return this.attemptCount.get(squadId) ?? 0
  }

  /** Reset attempt counter when squad gives an explicit manual order or rests. */
  resetAttempts(squadId: string): void {
    this.attemptCount.delete(squadId)
  }

  /** The squad's attempts so far, as a restart finds them in the database. */
  setAttempts(squadId: string, attempts: number): void {
    this.attemptCount.set(squadId, attempts)
  }

  /** Whether `playerId` has a window expected here: an offer this region holds for them that nobody has claimed and whose time has not run out. */
  expects(playerId: string): boolean {
    const now = this.clock.now()
    for (const prepared of this.incoming.values()) if (prepared.playerId === playerId && now <= prepared.expiresAt) return true
    return false
  }

  /** Hold what a restarted source found in its database: its open reservations, with the attempts they were. */
  restoreOutgoing(reservations: readonly HandoverReservation[]): void {
    for (const reservation of reservations) {
      this.outgoing.set(reservation.handoverId, reservation)
      this.attemptCount.set(reservation.squadId, Math.max(this.attemptCount.get(reservation.squadId) ?? 0, reservation.attempts))
    }
  }

  /** Hold what a restarted target found in its database: the offers it prepared and the arrivals it committed to. */
  restoreIncoming(prepared: readonly PreparedHandover[], arrived: readonly PreparedHandover[]): void {
    for (const handover of prepared) this.incoming.set(handover.handoverId, handover)
    for (const handover of arrived) this.arrived.set(handover.handoverId, handover)
  }
}
