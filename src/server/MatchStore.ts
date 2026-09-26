import { Faction } from '../config'
import type { NetworkMessage } from '../game/NetworkManager'
import {
  RECORDING_VERSION,
  type CombatRecording,
  type RecordedEvent,
  type RecordingHeader,
} from '../game/Recording'
import type { Db } from './db/Db'

/**
 * Where matches are kept, as the intents that produced them.
 *
 * A match *is* an event log. Since `ITEM-023` the wire carries what a player
 * decided and nothing about what it produced, so writing the log down writes
 * the match down: the outcome is whatever `MatchHost` derives from the header's
 * seed and the same intents, every time (`ITEM-022`). Nothing resolved is
 * stored, because a stored outcome is a second copy of something derivable —
 * and a second copy is something that can disagree with the log.
 *
 * That log is also the evidence. A foul aborts the match (RFC-0001 §8.3), and
 * the log is the only way to tell a foul from a bug in the rules — so there is
 * no update and no delete for an event anywhere in this file, and the triggers
 * migration 1 installs refuse both at the database level rather than merely
 * omitting them from the API. A log that can be rewritten is not evidence.
 *
 * The three uses RFC-0001 §9 names fall out of one table: a client that lost
 * its tab rejoins by asking for the tail after the last sequence number it
 * holds, a roster is derived by replaying a whole log, and a disputed match is
 * audited by replaying it in front of somebody.
 *
 * The store is handed a migrated {@link Db} rather than opening one: where the
 * database lives is `Persistence`'s business, and this class works the same on
 * SQLite and on Postgres because every query in it obeys the portability rules
 * in `db/Db.ts`.
 */

/**
 * An event on its way in, before it has a place in a log.
 *
 * `seq` is absent on purpose: see {@link MatchStore.append}.
 */
export type UnsequencedEvent = Omit<RecordedEvent, 'seq'>

/** A stored match is a recording with a name, so it replays as it comes out. */
export interface StoredMatch extends CombatRecording {
  id: string
}

/** One line of a match list, without reading anybody's log. */
export interface MatchSummary {
  id: string
  createdAt: string
  seedLabel: string
  events: number
}

interface MatchRow {
  header: string
}

interface EventRow {
  seq: number
  turn: number
  faction: number
  command: string
}

interface SeqRow {
  seq: number
}

export class MatchStore {
  constructor(private readonly db: Db) {}

  /**
   * Start a log.
   *
   * An id may be supplied when the caller already has a name for the match — a
   * room, say — and is otherwise drawn from `crypto.randomUUID`. No match
   * randomness is drawn here or anywhere else in this file: the seed is the
   * header's, and it comes from the handshake.
   *
   * `created_at` and `seed_label` are copied out of the header rather than
   * derived from it in SQL, because a generated column is SQLite's alone. The
   * header itself goes in whole: it is a document, and decomposing sheets and
   * loadouts into columns would restate a shape `parseRecording` already owns.
   */
  async create(header: RecordingHeader, id: string = crypto.randomUUID()): Promise<string> {
    // The refusal `parseRecording` already makes, for the same reason: a log
    // this build cannot replay is not a store of record, it is a diary.
    if (header.version !== RECORDING_VERSION) {
      throw new Error(
        `cannot store a version ${String(header.version)} recording ` +
          `(this build writes version ${RECORDING_VERSION})`,
      )
    }
    await this.db.query`INSERT INTO matches (id, header, created_at, seed_label)
                        VALUES (${id}, ${JSON.stringify(header)}, ${header.createdAt}, ${header.seedLabel})`
    return id
  }

  /**
   * Add one intent to the end of a log, and say where it landed.
   *
   * **The sequence number belongs to the store, not to the caller.** A caller
   * cannot name one — {@link UnsequencedEvent} has no `seq` — because the
   * numbering is what a rejoin counts in, and a store that took a number on
   * trust would let a client say where its own evidence goes. The numbered
   * event comes back so a referee can tell peers how far the log has got.
   *
   * @throws if the match does not exist. An event with nowhere to belong is
   * evidence about to be lost, and losing it quietly is worse than refusing.
   */
  async append(id: string, event: UnsequencedEvent): Promise<RecordedEvent> {
    await this.requireMatch(id)
    return this.insert(this.db, id, event)
  }

  /**
   * Add several intents under one commit.
   *
   * For the bulk paths — archiving a finished recording, or writing down a log
   * a rejoining client has caught up on — where the commit per intent is the
   * cost rather than the insert.
   */
  async appendAll(id: string, events: readonly UnsequencedEvent[]): Promise<RecordedEvent[]> {
    await this.requireMatch(id)
    return this.db.transaction(async (tx) => {
      const written: RecordedEvent[] = []
      for (const event of events) written.push(await this.insert(tx, id, event))
      return written
    })
  }

  /**
   * The log, or the tail of it.
   *
   * `afterSeq` is **exclusive**, and named for it: a rejoining client holds the
   * last sequence number it saw and wants what came after, and an off-by-one in
   * that answer is a desynchronised client rather than a cosmetic bug.
   */
  async events(id: string, afterSeq = -1): Promise<RecordedEvent[]> {
    const rows = await this.db.query<EventRow>`SELECT seq, turn, faction, command
                                                 FROM events
                                                WHERE match_id = ${id} AND seq > ${afterSeq}
                                                ORDER BY seq`
    return rows.map((row) => ({
      seq: Number(row.seq),
      turn: Number(row.turn),
      faction: Number(row.faction) === Faction.Red ? Faction.Red : Faction.Blue,
      command: JSON.parse(row.command) as NetworkMessage,
    }))
  }

  /**
   * The header, or null for a match this store has never heard of.
   *
   * Reads answer "nothing" where {@link append} refuses: a reader asking about
   * a match that is not here has its answer, whereas a writer naming one has a
   * bug that costs evidence.
   */
  async header(id: string): Promise<RecordingHeader | null> {
    const rows = await this.db.query<MatchRow>`SELECT header FROM matches WHERE id = ${id}`
    const row = rows[0]
    return row ? (JSON.parse(row.header) as RecordingHeader) : null
  }

  /** A whole match, shaped so it can be handed straight to `replay()`. */
  async match(id: string): Promise<StoredMatch | null> {
    const header = await this.header(id)
    return header ? { id, header, events: await this.events(id) } : null
  }

  /** Matches newest first, by the time each header claims it started. */
  async recent(limit = 20): Promise<MatchSummary[]> {
    const rows = await this.db.query<MatchSummary>`
      SELECT m.id AS id, m.created_at AS "createdAt", m.seed_label AS "seedLabel",
             CAST((SELECT COUNT(*) FROM events e WHERE e.match_id = m.id) AS INTEGER) AS events
        FROM matches m
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${limit}`
    return rows.map((row) => ({ ...row, events: Number(row.events) }))
  }

  /**
   * The one place a row is written, so {@link append} and {@link appendAll}
   * cannot disagree about how an event is numbered.
   *
   * The sequence number is chosen inside the statement, so there is no window
   * between reading the end of a log and writing to it. `MAX(seq) + 1` cannot
   * leave a gap, the primary key cannot take a duplicate, and together that is
   * the whole guarantee.
   */
  private async insert(db: Db, id: string, event: UnsequencedEvent): Promise<RecordedEvent> {
    // Serialised rather than kept, so a caller is free to reuse the command
    // object it handed over — the same reason `Recorder.record` clones.
    const command = JSON.stringify(event.command)
    const rows = await db.query<SeqRow>`
      INSERT INTO events (match_id, seq, turn, faction, command)
      VALUES (${id}, (SELECT COALESCE(MAX(seq) + 1, 0) FROM events WHERE match_id = ${id}),
              ${event.turn}, ${event.faction}, ${command})
      RETURNING seq`
    const row = rows[0]
    if (!row) throw new Error(`match ${id}: the log refused an event`)
    return { seq: Number(row.seq), turn: event.turn, faction: event.faction, command: event.command }
  }

  private async requireMatch(id: string): Promise<void> {
    const rows = await this.db.query<{ id: string }>`SELECT id FROM matches WHERE id = ${id}`
    if (rows.length === 0) {
      throw new Error(`no match ${id} in this store: create the match before appending to its log`)
    }
  }
}
