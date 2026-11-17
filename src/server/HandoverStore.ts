import type { LatLng } from '../core/Travel'
import type { Db } from './db/Db'
import type { HandoverReservation, PreparedHandover } from './Handover'

/**
 * What a region remembers of the squads crossing its border, so a restart
 * resumes them (RFC-0002 §2; `tictac-dwq.7`, `tictac-dwq.8`).
 *
 * **Crossings** are what a player *intends*: a squad sent to a checkpoint to
 * cross into another region, how many attempts it has had, and when the next
 * is due. One row per squad, written when the order is given and rewritten
 * when an attempt fails; deleted when the squad crosses, rests or is given
 * another order. `Crossings.restore` puts them back on the schedule.
 *
 * **Handovers** are what a region is *in the middle of*, on either side of one
 * handover id (`role`). The source's row is written when the offer goes out
 * and deleted when the squad has crossed or the target has let go; the
 * target's is written when it prepares a copy, rewritten when the window
 * arrives and it commits to the squad, and deleted when the source has
 * settled it. What each says on its own is what lets the other, after a lost
 * reply or a restart, ask and be answered (`HandoverPeer.handoverStatus`).
 *
 * The ticket's token is kept as it is, unlike a seat's key (`RoomStore`): it is
 * good for one arrival, for as long as the offer lives, and the row goes with
 * it.
 */

/** A squad sent to the checkpoint `to` to cross into `region`, as stored. */
export interface CrossingIntent {
  squadId: string
  playerId: string
  region: string
  to: LatLng
  /** Handovers attempted so far: a crossing gives up after `HANDOVER_MAX_ATTEMPTS`. */
  attempts: number
  /** The server's clock, in ms, when the crossing is next due. */
  nextAt: number
}

/** What the target holds of a handover: an offer it prepared, or an arrival it has committed to. */
export type IncomingState = 'prepared' | 'committed'

export interface IncomingHandover extends PreparedHandover {
  state: IncomingState
}

/** Stored in integer millionths of a degree (about 0.1 m), as a squad's start is: the database takes TEXT and INTEGER only (`Db.ts`). */
const MICRODEGREES = 1_000_000

interface HandoverRow {
  handover_id: string
  squad_id: string
  player_id: string
  source_region: string
  target_region: string
  target_url: string | null
  token: string
  expires_at: number | string
  attempts: number
  state: string
}

export class HandoverStore {
  constructor(private readonly db: Db) {}

  async intents(): Promise<CrossingIntent[]> {
    const rows = await this.db.query<{
      squad_id: string
      player_id: string
      region: string
      to_lat_e6: number
      to_lng_e6: number
      attempts: number
      next_at: number | string
    }>`SELECT squad_id, player_id, region, to_lat_e6, to_lng_e6, attempts, next_at FROM crossings`
    return rows.map((row) => ({
      squadId: row.squad_id,
      playerId: row.player_id,
      region: row.region,
      to: { lat: Number(row.to_lat_e6) / MICRODEGREES, lng: Number(row.to_lng_e6) / MICRODEGREES },
      attempts: Number(row.attempts),
      nextAt: Number(row.next_at),
    }))
  }

  /** Write the squad's crossing, replacing the one it had. */
  async saveIntent(intent: CrossingIntent): Promise<void> {
    const { squadId, playerId, region, to, attempts, nextAt } = intent
    await this.db.query`
      INSERT INTO crossings (squad_id, player_id, region, to_lat_e6, to_lng_e6, attempts, next_at)
      VALUES (${squadId}, ${playerId}, ${region}, ${Math.round(to.lat * MICRODEGREES)}, ${Math.round(to.lng * MICRODEGREES)}, ${attempts}, ${nextAt})
      ON CONFLICT (squad_id) DO UPDATE SET player_id = excluded.player_id, region = excluded.region,
        to_lat_e6 = excluded.to_lat_e6, to_lng_e6 = excluded.to_lng_e6, attempts = excluded.attempts, next_at = excluded.next_at`
  }

  async removeIntent(squadId: string): Promise<void> {
    await this.db.query`DELETE FROM crossings WHERE squad_id = ${squadId}`
  }

  /** The handovers this region is the source of that are not over: offered, or cancelled and waiting for the target to let go. */
  async outgoing(): Promise<HandoverReservation[]> {
    const rows = await this.db.query<HandoverRow>`
      SELECT handover_id, squad_id, player_id, source_region, target_region, target_url, token, expires_at, attempts, state
        FROM handovers WHERE role = 'source'`
    return rows.map((row) => ({
      handoverId: row.handover_id,
      playerId: row.player_id,
      squadId: row.squad_id,
      sourceRegion: row.source_region,
      targetRegion: row.target_region,
      targetUrl: row.target_url ?? '',
      token: row.token,
      expiresAt: Number(row.expires_at),
      attempts: Number(row.attempts),
      state: row.state === 'cancelled' ? 'cancelled' : 'offered',
    }))
  }

  /** Write a reservation as `offered` or `cancelled`, replacing what was written under its id. */
  async saveOutgoing(reservation: HandoverReservation): Promise<void> {
    const { handoverId, squadId, playerId, sourceRegion, targetRegion, targetUrl, token, expiresAt, attempts, state } = reservation
    await this.db.query`
      INSERT INTO handovers (handover_id, role, squad_id, player_id, source_region, target_region, target_url, token, expires_at, attempts, state)
      VALUES (${handoverId}, 'source', ${squadId}, ${playerId}, ${sourceRegion}, ${targetRegion}, ${targetUrl}, ${token}, ${expiresAt}, ${attempts}, ${state})
      ON CONFLICT (handover_id) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at, attempts = excluded.attempts`
  }

  /** The handovers this region is the target of that are not settled. */
  async incoming(): Promise<IncomingHandover[]> {
    const rows = await this.db.query<HandoverRow>`
      SELECT handover_id, squad_id, player_id, source_region, target_region, target_url, token, expires_at, attempts, state
        FROM handovers WHERE role = 'target'`
    return rows.map((row) => ({
      handoverId: row.handover_id,
      playerId: row.player_id,
      squadId: row.squad_id,
      sourceRegion: row.source_region,
      targetRegion: row.target_region,
      token: row.token,
      expiresAt: Number(row.expires_at),
      state: row.state === 'committed' ? 'committed' : 'prepared',
    }))
  }

  /** Write what the target holds under the handover's id, replacing what was written. */
  async saveIncoming(handover: PreparedHandover, state: IncomingState): Promise<void> {
    const { handoverId, squadId, playerId, sourceRegion, targetRegion, token, expiresAt } = handover
    await this.db.query`
      INSERT INTO handovers (handover_id, role, squad_id, player_id, source_region, target_region, target_url, token, expires_at, attempts, state)
      VALUES (${handoverId}, 'target', ${squadId}, ${playerId}, ${sourceRegion}, ${targetRegion}, NULL, ${token}, ${expiresAt}, 0, ${state})
      ON CONFLICT (handover_id) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at`
  }

  /** The handover is over, on this side: nothing is left to resume. */
  async remove(handoverId: string): Promise<void> {
    await this.db.query`DELETE FROM handovers WHERE handover_id = ${handoverId}`
  }
}
