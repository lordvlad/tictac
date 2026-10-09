import { Faction } from '../config'
import type { LatLng } from '../core/Travel'
import type { EncounterEntry, PassedFor } from '../game/Encounter'
import type { Db } from './db/Db'

/**
 * What found each squad on the road, and what came of it (`ITEM-048`,
 * GDD-WORLD §5).
 *
 * A row is written only for a contact — a fight opened or a squad passed by —
 * never for a roll that found nothing: that is reproducible from its key
 * (`rollEncounter`), so a row for it would only be a second copy of the truth.
 * `UNIQUE (squad_id, trip, checkpoint)` is what makes a checkpoint handled
 * once: a server that restarts between a contact and the end of the work
 * around it finds the row and does not open a second fight.
 *
 * The room's id is the match's id, so the outcome is read from `match_results`
 * rather than copied here. An encounter whose match has no result yet is in
 * progress.
 */

/** Stored as integer millionths of a degree, as `Squads` keeps a start. */
const MICRODEGREES = 1_000_000

/** A contact as it is recorded. */
export interface EncounterRecord {
  squadId: string
  playerId: string
  trip: string
  checkpoint: number
  /** The server's clock, in ms, when the squad was found. */
  at: number
  place: LatLng
  /** How many aliens came; 0 when the squad was passed by. */
  aliens: number
  /** The fight's room, which is its match; null when the squad was passed by. */
  roomId: string | null
  passedFor: PassedFor | null
}

interface RecordRow {
  room_id: string | null
  passed_for: string | null
}

interface FeedRow {
  id: string
  found_at: number
  lat_e6: number
  lng_e6: number
  aliens: number
  room_id: string | null
  passed_for: string | null
  played_by_you: number
  winner: number | null
}

export class Encounters {
  /**
   * Rooms a player took before their row was written: the room is opened and
   * the player told before the row exists, so a quick window can beat it.
   */
  private readonly taken = new Set<string>()

  constructor(private readonly db: Db) {}

  /** What was done about the contact at this checkpoint, or null when nothing was: it is new. */
  async find(squadId: string, trip: string, checkpoint: number): Promise<Pick<EncounterRecord, 'roomId' | 'passedFor'> | null> {
    const rows = await this.db.query<RecordRow>`
      SELECT room_id, passed_for FROM encounters
       WHERE squad_id = ${squadId} AND trip = ${trip} AND checkpoint = ${checkpoint}`
    const row = rows[0]
    return row ? { roomId: row.room_id, passedFor: row.passed_for as PassedFor | null } : null
  }

  /** Write a contact down. A second write of the same checkpoint changes nothing. */
  async record(contact: EncounterRecord): Promise<void> {
    const takenAlready = contact.roomId !== null && this.taken.delete(contact.roomId)
    await this.db.query`
      INSERT INTO encounters (id, squad_id, player_id, trip, checkpoint, found_at, lat_e6, lng_e6,
                              aliens, room_id, passed_for, played_by_you)
      VALUES (${crypto.randomUUID()}, ${contact.squadId}, ${contact.playerId}, ${contact.trip}, ${contact.checkpoint},
              ${contact.at}, ${Math.round(contact.place.lat * MICRODEGREES)}, ${Math.round(contact.place.lng * MICRODEGREES)},
              ${contact.aliens}, ${contact.roomId}, ${contact.passedFor}, ${takenAlready ? 1 : 0})
      ON CONFLICT (squad_id, trip, checkpoint) DO NOTHING`
  }

  /** The player took this room's seat themselves: it was theirs, not the AI's, who played their side. */
  async markTaken(roomId: string): Promise<void> {
    this.taken.add(roomId)
    await this.db.query`UPDATE encounters SET played_by_you = 1 WHERE room_id = ${roomId}`
  }

  /** `playerId`'s encounters, newest first. */
  async feed(playerId: string, limit: number): Promise<EncounterEntry[]> {
    const rows = await this.db.query<FeedRow>`
      SELECT e.id, e.found_at, e.lat_e6, e.lng_e6, e.aliens, e.room_id, e.passed_for, e.played_by_you, r.winner
        FROM encounters e
        LEFT JOIN match_results r ON r.match_id = e.room_id
       WHERE e.player_id = ${playerId}
       ORDER BY e.found_at DESC, e.id DESC
       LIMIT ${limit}`
    return rows.map((row): EncounterEntry => {
      const passedFor = row.passed_for as PassedFor | null
      const fought = row.room_id !== null && passedFor === null
      return {
        id: row.id,
        at: Number(row.found_at),
        place: { lat: Number(row.lat_e6) / MICRODEGREES, lng: Number(row.lng_e6) / MICRODEGREES },
        result: !fought ? 'passedBy' : row.winner === null ? 'inProgress' : Number(row.winner) === Faction.Blue ? 'won' : 'lost',
        passedFor,
        playedBy: fought ? (Number(row.played_by_you) === 1 ? 'you' : 'ai') : null,
        matchId: fought ? row.room_id : null,
        aliens: Number(row.aliens),
      }
    })
  }

  /**
   * Whether `playerId` was in the match, to watch it back: it settled with
   * them on a side, its room is live with them in a seat, or it is their
   * encounter's fight — which covers a seat the AI took from them.
   */
  async involved(playerId: string, matchId: string): Promise<boolean> {
    const rows = await this.db.query<{ one: number }>`
      SELECT 1 AS one FROM match_results
       WHERE match_id = ${matchId} AND (blue_player = ${playerId} OR red_player = ${playerId})
      UNION ALL
      SELECT 1 AS one FROM rooms
       WHERE id = ${matchId} AND (blue_player_id = ${playerId} OR red_player_id = ${playerId})
      UNION ALL
      SELECT 1 AS one FROM encounters WHERE room_id = ${matchId} AND player_id = ${playerId}`
    return rows.length > 0
  }
}
