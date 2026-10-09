import type { Faction } from '../config'
import type { SeatControl } from '../game/Encounter'
import type { RoomPhase } from '../game/Lobby'
import type { PeerVersion } from '../version'
import type { Db } from './db/Db'

/**
 * The rooms a lobby holds open, written down so a restarted server can hold
 * them again.
 *
 * A room is mostly sockets and a live `MatchHost`, and neither can be written
 * down; what can is everything those are rebuilt from. Who sits where, and
 * the hash of the key that takes each seat back, so the window that held a
 * seat can reconnect to it. The build the room was opened under, because a
 * restarted server may be a newer one and only a page on the room's own build
 * can finish its match. Whether the referee is still judging it, and whose
 * squads it already checked against the rosters. The match itself is not
 * here: once it starts it is in `MatchStore` under the room's id, and
 * replaying that log *is* the `MatchHost`.
 *
 * Each row is rewritten whole (`save`) at every transition the room makes,
 * through the room's own ordered write chain, so the row is always one state
 * the room was really in rather than a mix of two. A room that ends deletes
 * its row (`end`): what is left of it is the match log, and this table holds
 * live rooms only.
 *
 * What an encounter room (`ITEM-048`) adds is who moves each seat and whether
 * the room is the server's own: a restarted server sits the AI back down in
 * the seats it held, and lets a reserved seat run out the deadline it had.
 */

/** A seat as the store keeps it. */
export interface StoredSeat {
  /** The signed-in player holding it, or null for an anonymous one. */
  playerId: string | null
  name: string | null
  /** SHA-256 of the seat's key, base64url. The key itself is never stored. */
  keyHash: string
  /** Who moves it: the player's window, the AI, or the server keeping it for a player until `joinBy`. */
  control: SeatControl
  /** The server's clock, in ms, when a `reserved` seat passes to the AI; null otherwise. */
  joinBy: number | null
}

/** A side whose squad the referee checked against the roster, which is who a settlement credits. */
export interface VerifiedSide {
  playerId: string
  characterIds: string[]
}

export interface StoredRoom {
  id: string
  /** The build and protocol the room was opened under. */
  version: PeerVersion
  /** As written. A room whose match the `MatchStore` holds is playing, whatever this says. */
  phase: RoomPhase
  createdAt: string
  /** False once the referee stopped judging a room opened under another build (`Room.witness`). */
  judged: boolean
  /** A fight the server opened on the road: unlisted, and the AI plays on where a human leaves. */
  encounter: boolean
  sides: Record<Faction, VerifiedSide | null>
  blue: StoredSeat
  /** Null while the room waits for somebody to join. */
  red: StoredSeat | null
}

interface RoomRow {
  id: string
  build: string
  protocol: number
  phase: string
  created_at: string
  judged: number
  sides: string
  blue_player_id: string | null
  blue_name: string | null
  blue_key_hash: string
  red_player_id: string | null
  red_name: string | null
  red_key_hash: string | null
  encounter: number
  blue_control: string
  red_control: string
  blue_join_by: string | null
  red_join_by: string | null
}

export class RoomStore {
  constructor(private readonly db: Db) {}

  /** Write a room as it stands now, whether or not it was written before. */
  async save(room: StoredRoom): Promise<void> {
    const { blue, red } = room
    await this.db.query`
      INSERT INTO rooms (id, build, protocol, phase, created_at, judged, sides,
                         blue_player_id, blue_name, blue_key_hash, red_player_id, red_name, red_key_hash,
                         encounter, blue_control, red_control, blue_join_by, red_join_by)
      VALUES (${room.id}, ${room.version.build}, ${room.version.protocol}, ${room.phase}, ${room.createdAt},
              ${room.judged ? 1 : 0}, ${JSON.stringify(room.sides)},
              ${blue.playerId}, ${blue.name}, ${blue.keyHash},
              ${red?.playerId ?? null}, ${red?.name ?? null}, ${red?.keyHash ?? null},
              ${room.encounter ? 1 : 0}, ${blue.control}, ${red?.control ?? 'player'},
              ${isoOf(blue.joinBy)}, ${isoOf(red?.joinBy ?? null)})
      ON CONFLICT (id) DO UPDATE SET
        phase = excluded.phase, judged = excluded.judged, sides = excluded.sides,
        blue_player_id = excluded.blue_player_id, blue_name = excluded.blue_name,
        blue_key_hash = excluded.blue_key_hash, red_player_id = excluded.red_player_id,
        red_name = excluded.red_name, red_key_hash = excluded.red_key_hash,
        encounter = excluded.encounter, blue_control = excluded.blue_control,
        red_control = excluded.red_control, blue_join_by = excluded.blue_join_by,
        red_join_by = excluded.red_join_by`
  }

  /** The room is over: settled or aborted. Its match, if it had one, stays in the `MatchStore`. */
  async end(id: string): Promise<void> {
    await this.db.query`DELETE FROM rooms WHERE id = ${id}`
  }

  /** Every room not yet over, oldest first — the order a lobby lists them in, reversed. */
  async live(): Promise<StoredRoom[]> {
    const rows = await this.db.query<RoomRow>`SELECT * FROM rooms ORDER BY created_at, id`
    return rows.map((row) => ({
      id: row.id,
      version: { build: row.build, protocol: Number(row.protocol) },
      phase: row.phase as RoomPhase,
      createdAt: row.created_at,
      judged: Number(row.judged) === 1,
      encounter: Number(row.encounter) === 1,
      sides: JSON.parse(row.sides) as Record<Faction, VerifiedSide | null>,
      blue: {
        playerId: row.blue_player_id,
        name: row.blue_name,
        keyHash: row.blue_key_hash,
        control: row.blue_control as SeatControl,
        joinBy: msOf(row.blue_join_by),
      },
      red:
        row.red_key_hash === null
          ? null
          : {
              playerId: row.red_player_id,
              name: row.red_name,
              keyHash: row.red_key_hash,
              control: row.red_control as SeatControl,
              joinBy: msOf(row.red_join_by),
            },
    }))
  }
}

/** A deadline as it is written: an ISO string, like every timestamp here, because a millisecond clock does not fit Postgres's INTEGER. */
function isoOf(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

function msOf(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso)
}
