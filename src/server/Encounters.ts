import { Faction } from '../config'
import type { LatLng } from '../core/Travel'
import type { EncounterEntry, PassedFor } from '../wire/Encounter'
import { Batch, type Db } from './db/Db'

/**
 * What found each squad on the road, and what came of it (`ITEM-048`,
 * `ITEM-053`, GDD-WORLD §5).
 *
 * A row is written only for a contact — a fight opened or a squad passed by —
 * never for a roll that found nothing: that is reproducible from its key
 * (`rollEncounter`), so a row for it would only be a second copy of the truth.
 * `UNIQUE (squad_id, trip, checkpoint)` is what makes a checkpoint handled
 * once: a server that restarts between a contact and the end of the work
 * around it finds the row and does not open a second fight.
 *
 * **The row comes first** (`begin`), unsettled and with the id its room will
 * have already on it (`room_id`). The room is opened under that id — a lobby
 * that finds a match under it has already opened this fight — and only then
 * is the outcome written (`settle`). A crash anywhere in between leaves the
 * row, so a restart finds the same room instead of rolling a second one.
 * What was not settled is not shown (`feed`).
 *
 * **A meeting of two players is a row for each of them**, each squad's own,
 * with `opponent_player_id` naming the other. It has no trip's checkpoint to
 * be keyed by, so its `trip` is the pair and the moment (`meetingKey`) and its
 * `checkpoint` is 0: the same UNIQUE then makes a meeting recorded once per
 * squad. Both rows are begun in one transaction and settled in one, so a
 * meeting is never written down for one player only. A meeting that cannot
 * happen (a squad is busy, or has nobody fit) is settled as a pass for both.
 *
 * The room's id is the match's id, so the outcome is read from the roster
 * store's `match_results` rather than copied here. An encounter whose match
 * has no result yet is in progress. This store reads only its own table: what
 * lives in the others is asked of the store that owns it.
 */

/** Stored as integer millionths of a degree, as `Squads` keeps a start. */
const MICRODEGREES = 1_000_000

/** A contact as it is first written down, before anything is done about it. */
export interface EncounterIntent {
  squadId: string
  playerId: string
  trip: string
  checkpoint: number
  /** The server's clock, in ms, when the squad was found. */
  at: number
  place: LatLng
  /** The other player, when the squad met theirs (`ITEM-053`); absent for aliens. */
  opponentPlayerId?: string
}

/** What was done about a contact. */
export interface EncounterOutcome {
  /** The fight's room, which is its match; null when the squad was passed by. */
  roomId: string | null
  passedFor: PassedFor | null
  /** How many aliens came; 0 when the squad was passed by, and for a fight against another player. */
  aliens: number
}

/** A contact that is begun: the room it will be fought in, and what became of it if that is already known. */
export interface Handling {
  /** The id the contact's room is to be opened under. */
  roomId: string
  /** Every row begun for it, in the order the intents were given. */
  ids: readonly string[]
  /** Null while the contact is still to be carried out. */
  outcome: EncounterOutcome | null
}

/** What the feed reads from other stores' tables, by the stores that own them. */
export interface EncounterNeighbours {
  /** How a match settled (`Rosters.result`). */
  results: { result(matchId: string): Promise<{ winner: number; bluePlayer: string | null; redPlayer: string | null } | null> }
  /** Who holds a seat in a live room (`RoomStore.holdsSeat`). */
  rooms: { holdsSeat(roomId: string, playerId: string): Promise<boolean> }
  /** A player by id (`Accounts.player`). */
  players: { player(id: string): Promise<{ name: string } | null> }
}

/** What identifies one meeting of two squads: the pair, as `Journeys` keys it, and the moment they came within range. */
export function meetingKey(pair: string, at: number): string {
  return `${pair}@${at}`
}

interface HandlingRow {
  id: string
  room_id: string | null
  aliens: number
  passed_for: string | null
  settled: number
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
  opponent_player_id: string | null
}

export class Encounters {
  constructor(
    private readonly db: Db,
    private readonly neighbours: EncounterNeighbours,
  ) {}

  /**
   * Write contacts down before anything is done about them: one row each, in
   * one transaction, all with the room id this call reserves. Idempotent: a
   * contact already written keeps its row, whatever became of it.
   *
   * A row already there decides: when the first intent's row is settled its
   * outcome is returned, and a sibling that was left unsettled (a meeting
   * that an older build wrote one side at a time) is made to agree.
   */
  async begin(intents: readonly [EncounterIntent, ...EncounterIntent[]]): Promise<Handling> {
    const reserved = crypto.randomUUID()
    const batch = new Batch()
    for (const intent of intents) {
      batch.query`
        INSERT INTO encounters (id, squad_id, player_id, trip, checkpoint, found_at, lat_e6, lng_e6,
                                aliens, room_id, passed_for, played_by_you, opponent_player_id, settled)
        VALUES (${crypto.randomUUID()}, ${intent.squadId}, ${intent.playerId}, ${intent.trip}, ${intent.checkpoint},
                ${intent.at}, ${Math.round(intent.place.lat * MICRODEGREES)}, ${Math.round(intent.place.lng * MICRODEGREES)},
                0, ${reserved}, NULL, 0, ${intent.opponentPlayerId ?? null}, 0)
        ON CONFLICT (squad_id, trip, checkpoint) DO NOTHING`
    }
    await this.db.transaction(batch)

    const rows: HandlingRow[] = []
    for (const intent of intents) {
      const found = await this.db.query<HandlingRow>`
        SELECT id, room_id, aliens, passed_for, settled FROM encounters
         WHERE squad_id = ${intent.squadId} AND trip = ${intent.trip} AND checkpoint = ${intent.checkpoint}`
      rows.push(found[0]!)
    }
    const lead = rows[0]!
    const handling: Handling = {
      roomId: lead.room_id ?? reserved,
      ids: rows.map((row) => row.id),
      outcome:
        Number(lead.settled) === 1
          ? { roomId: lead.room_id, passedFor: lead.passed_for as PassedFor | null, aliens: Number(lead.aliens) }
          : null,
    }
    if (handling.outcome && rows.some((row) => Number(row.settled) !== 1)) await this.settle(handling, handling.outcome)
    return handling
  }

  /** Write what was done about a contact onto every row begun for it, in one transaction. A second write changes nothing. */
  async settle(handling: Handling, outcome: EncounterOutcome): Promise<void> {
    const batch = new Batch()
    for (const id of handling.ids) {
      batch.query`
        UPDATE encounters SET settled = 1, aliens = ${outcome.aliens}, room_id = ${outcome.roomId}, passed_for = ${outcome.passedFor}
         WHERE id = ${id} AND settled = 0`
    }
    await this.db.transaction(batch)
  }

  /** Forget contacts that came to nothing, for every row begun for them: a meeting that could not happen is kept for neither player. */
  async discard(handling: Handling): Promise<void> {
    const batch = new Batch()
    for (const id of handling.ids) batch.query`DELETE FROM encounters WHERE id = ${id} AND settled = 0`
    await this.db.transaction(batch)
  }

  /**
   * `playerId` took their seat in this room themselves: it was theirs, not the
   * AI's, who played their side. The row exists before the room does (`begin`),
   * so this always has one to mark.
   */
  async markTaken(roomId: string, playerId: string): Promise<void> {
    await this.db.query`UPDATE encounters SET played_by_you = 1 WHERE room_id = ${roomId} AND player_id = ${playerId}`
  }

  /** `playerId`'s settled encounters, newest first. */
  async feed(playerId: string, limit: number): Promise<EncounterEntry[]> {
    const rows = await this.db.query<FeedRow>`
      SELECT id, found_at, lat_e6, lng_e6, aliens, room_id, passed_for, played_by_you, opponent_player_id
        FROM encounters
       WHERE player_id = ${playerId} AND settled = 1
       ORDER BY found_at DESC, id DESC
       LIMIT ${limit}`
    const names = new Map<string, Promise<string | null>>()
    const nameOf = (id: string): Promise<string | null> => {
      let name = names.get(id)
      if (!name) {
        name = this.neighbours.players.player(id).then((player) => player?.name ?? null)
        names.set(id, name)
      }
      return name
    }
    return Promise.all(
      rows.map(async (row): Promise<EncounterEntry> => {
        const passedFor = row.passed_for as PassedFor | null
        const matchId = row.room_id !== null && passedFor === null ? row.room_id : null
        const [settled, against] = await Promise.all([
          matchId === null ? null : this.neighbours.results.result(matchId),
          row.opponent_player_id === null ? null : nameOf(row.opponent_player_id),
        ])
        // The player's own side decides won or lost: Blue in every fight
        // against aliens, and either in a meeting of two players. A side that
        // did not settle onto a roster (no red player) is Blue by elimination.
        const side = settled?.redPlayer === playerId ? Faction.Red : Faction.Blue
        return {
          id: row.id,
          at: Number(row.found_at),
          place: { lat: Number(row.lat_e6) / MICRODEGREES, lng: Number(row.lng_e6) / MICRODEGREES },
          result: matchId === null ? 'passedBy' : !settled ? 'inProgress' : settled.winner === side ? 'won' : 'lost',
          passedFor,
          playedBy: matchId === null ? null : Number(row.played_by_you) === 1 ? 'you' : 'ai',
          matchId,
          aliens: Number(row.aliens),
          against,
        }
      }),
    )
  }

  /**
   * Whether `playerId` was in the match, to watch it back: it settled with
   * them on a side, its room is live with them in a seat, or it is their
   * encounter's fight — which covers a seat the AI took from them.
   */
  async involved(playerId: string, matchId: string): Promise<boolean> {
    const settled = await this.neighbours.results.result(matchId)
    if (settled?.bluePlayer === playerId || settled?.redPlayer === playerId) return true
    if (await this.neighbours.rooms.holdsSeat(matchId, playerId)) return true
    const rows = await this.db.query<{ one: number }>`
      SELECT 1 AS one FROM encounters WHERE room_id = ${matchId} AND player_id = ${playerId}`
    return rows.length > 0
  }
}
