import type { Faction } from '../config'
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
 */

/** A seat as the store keeps it. */
export interface StoredSeat {
  /** The signed-in player holding it, or null for an anonymous one. */
  playerId: string | null
  name: string | null
  /** SHA-256 of the seat's key, base64url. The key itself is never stored. */
  keyHash: string
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
}

export class RoomStore {
  constructor(private readonly db: Db) {}

  /** Write a room as it stands now, whether or not it was written before. */
  async save(room: StoredRoom): Promise<void> {
    const { blue, red } = room
    await this.db.query`
      INSERT INTO rooms (id, build, protocol, phase, created_at, judged, sides,
                         blue_player_id, blue_name, blue_key_hash, red_player_id, red_name, red_key_hash)
      VALUES (${room.id}, ${room.version.build}, ${room.version.protocol}, ${room.phase}, ${room.createdAt},
              ${room.judged ? 1 : 0}, ${JSON.stringify(room.sides)},
              ${blue.playerId}, ${blue.name}, ${blue.keyHash},
              ${red?.playerId ?? null}, ${red?.name ?? null}, ${red?.keyHash ?? null})
      ON CONFLICT (id) DO UPDATE SET
        phase = excluded.phase, judged = excluded.judged, sides = excluded.sides,
        blue_player_id = excluded.blue_player_id, blue_name = excluded.blue_name,
        blue_key_hash = excluded.blue_key_hash, red_player_id = excluded.red_player_id,
        red_name = excluded.red_name, red_key_hash = excluded.red_key_hash`
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
      sides: JSON.parse(row.sides) as Record<Faction, VerifiedSide | null>,
      blue: { playerId: row.blue_player_id, name: row.blue_name, keyHash: row.blue_key_hash },
      red:
        row.red_key_hash === null
          ? null
          : { playerId: row.red_player_id, name: row.red_name, keyHash: row.red_key_hash },
    }))
  }
}
