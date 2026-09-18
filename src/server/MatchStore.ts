import { Database, type Statement } from 'bun:sqlite'
import { Faction } from '../config'
import type { NetworkMessage } from '../game/NetworkManager'
import {
  RECORDING_VERSION,
  type CombatRecording,
  type RecordedEvent,
  type RecordingHeader,
} from '../game/Recording'

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
 * in {@link SCHEMA} refuse both at the file level rather than merely omitting
 * them from the API. A log that can be rewritten is not evidence.
 *
 * The three uses RFC-0001 §9 names fall out of one table: a client that lost
 * its tab rejoins by asking for the tail after the last sequence number it
 * holds, a roster is derived by replaying a whole log, and a disputed match is
 * audited by replaying it in front of somebody.
 *
 * `bun:sqlite` rather than a file per match: durability, a cheap range read per
 * rejoin, and no dependency — it ships with the runtime.
 */

/**
 * The schema this build writes.
 *
 * Kept on the store, and on the file as SQLite's own `user_version`, so the two
 * cannot drift apart. A file from another version has exactly two honest
 * futures: a migration brings it forward and it is then replayed as current, or
 * opening it is **refused with a reason naming both versions**. What it may
 * never do is open quietly and be replayed as if it were current — an intent
 * log whose shape changed underneath it replays into a fight that never
 * happened, which is precisely the drift `ITEM-028` exists to guard. Until that
 * guard lands there is no migration to run, so the constructor refuses.
 */
export const STORE_VERSION = 1

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

/**
 * `created_at` and `seed_label` are generated columns rather than values
 * written beside the header: a list has to sort and label itself without
 * parsing every header, but copying two fields out of the JSON would be two
 * fields that can disagree with it. SQLite derives them from the document it is
 * already storing, so they cannot.
 *
 * The header goes in whole because it is a document — decomposing sheets and
 * loadouts into columns would restate a shape `parseRecording` already owns,
 * and no query here looks inside a character.
 *
 * `events` has no autoincrement. `seq` is dense and per match, which is what a
 * rejoining client counts in, and the insert itself chooses it — see
 * {@link MatchStore.append}.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
  id         TEXT PRIMARY KEY,
  header     TEXT NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(header, '$.createdAt')) STORED,
  seed_label TEXT GENERATED ALWAYS AS (json_extract(header, '$.seedLabel')) STORED
);

CREATE TABLE IF NOT EXISTS events (
  match_id TEXT    NOT NULL REFERENCES matches(id),
  seq      INTEGER NOT NULL,
  turn     INTEGER NOT NULL,
  faction  INTEGER NOT NULL,
  command  TEXT    NOT NULL,
  PRIMARY KEY (match_id, seq)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS events_append_only_update
  BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'the intent log is append-only: an event cannot be rewritten'); END;

CREATE TRIGGER IF NOT EXISTS events_append_only_delete
  BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'the intent log is append-only: an event cannot be deleted'); END;
`

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
  /** The schema of the open file, which this build only ever opens at {@link STORE_VERSION}. */
  readonly version = STORE_VERSION

  private readonly db: Database

  /**
   * Prepared once each, because a watched match appends one row per intent for
   * as long as it lasts and compiling the statement is the expensive half of
   * that.
   */
  private readonly insertMatch: Statement<unknown, [{ $id: string; $header: string }]>
  private readonly selectHeader: Statement<MatchRow, [{ $id: string }]>
  private readonly selectEvents: Statement<EventRow, [{ $id: string; $after: number }]>
  private readonly selectRecent: Statement<MatchSummary, [{ $limit: number }]>
  private readonly insertEvent: Statement<
    SeqRow,
    [{ $id: string; $turn: number; $faction: number; $command: string }]
  >

  /** {@link appendAll} under one commit; built here because it wraps the statements above. */
  private readonly insertMany: (id: string, events: readonly UnsequencedEvent[]) => RecordedEvent[]

  constructor(path = ':memory:') {
    this.db = new Database(path, { create: true })

    // An event may not name a match that is not there: a log with a hole in it
    // is the one failure a replay cannot survive.
    this.db.exec('PRAGMA foreign_keys = ON')
    // Readers never block the append path, which is what lets an audit read a
    // match that is still being played.
    this.db.exec('PRAGMA journal_mode = WAL')

    const found = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()
    const onDisk = found ? found.user_version : 0
    if (onDisk !== 0 && onDisk !== STORE_VERSION) {
      this.db.close()
      throw new Error(
        `match store at ${path} is schema version ${onDisk}, this build reads version ` +
          `${STORE_VERSION}: migrate it, or open it with the build that wrote it`,
      )
    }

    this.db.exec(SCHEMA)
    // Interpolated rather than bound, because a pragma takes no parameters.
    this.db.exec(`PRAGMA user_version = ${STORE_VERSION}`)

    this.insertMatch = this.db.query('INSERT INTO matches (id, header) VALUES ($id, $header)')
    this.selectHeader = this.db.query('SELECT header FROM matches WHERE id = $id')
    this.selectEvents = this.db.query(
      `SELECT seq, turn, faction, command
         FROM events
        WHERE match_id = $id AND seq > $after
        ORDER BY seq`,
    )
    this.selectRecent = this.db.query(
      `SELECT m.id AS id, m.created_at AS createdAt, m.seed_label AS seedLabel,
              (SELECT COUNT(*) FROM events e WHERE e.match_id = m.id) AS events
         FROM matches m
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT $limit`,
    )
    // The sequence number is chosen inside the statement, so there is no window
    // between reading the end of a log and writing to it. `MAX(seq) + 1` cannot
    // leave a gap, the primary key cannot take a duplicate, and together that
    // is the whole guarantee.
    this.insertEvent = this.db.query(
      `INSERT INTO events (match_id, seq, turn, faction, command)
       VALUES ($id, (SELECT COALESCE(MAX(seq) + 1, 0) FROM events WHERE match_id = $id),
               $turn, $faction, $command)
       RETURNING seq`,
    )

    this.insertMany = this.db.transaction((id: string, events: readonly UnsequencedEvent[]) =>
      events.map((event) => this.insert(id, event)),
    )
  }

  /**
   * Start a log.
   *
   * An id may be supplied when the caller already has a name for the match — a
   * room, say — and is otherwise drawn from `crypto.randomUUID`. No match
   * randomness is drawn here or anywhere else in this file: the seed is the
   * header's, and it comes from the handshake.
   */
  create(header: RecordingHeader, id: string = crypto.randomUUID()): string {
    // The refusal `parseRecording` already makes, for the same reason: a log
    // this build cannot replay is not a store of record, it is a diary.
    if (header.version !== RECORDING_VERSION) {
      throw new Error(
        `cannot store a version ${String(header.version)} recording ` +
          `(this build writes version ${RECORDING_VERSION})`,
      )
    }
    this.insertMatch.run({ $id: id, $header: JSON.stringify(header) })
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
  append(id: string, event: UnsequencedEvent): RecordedEvent {
    this.requireMatch(id)
    return this.insert(id, event)
  }

  /**
   * Add several intents under one commit.
   *
   * For the bulk paths — archiving a finished recording, or writing down a log
   * a rejoining client has caught up on — where the commit per intent is the
   * cost rather than the insert.
   */
  appendAll(id: string, events: readonly UnsequencedEvent[]): RecordedEvent[] {
    this.requireMatch(id)
    return this.insertMany(id, events)
  }

  /**
   * The log, or the tail of it.
   *
   * `afterSeq` is **exclusive**, and named for it: a rejoining client holds the
   * last sequence number it saw and wants what came after, and an off-by-one in
   * that answer is a desynchronised client rather than a cosmetic bug.
   */
  events(id: string, afterSeq = -1): RecordedEvent[] {
    return this.selectEvents.all({ $id: id, $after: afterSeq }).map((row) => ({
      seq: row.seq,
      turn: row.turn,
      faction: row.faction === Faction.Red ? Faction.Red : Faction.Blue,
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
  header(id: string): RecordingHeader | null {
    const row = this.selectHeader.get({ $id: id })
    return row ? (JSON.parse(row.header) as RecordingHeader) : null
  }

  /** A whole match, shaped so it can be handed straight to `replay()`. */
  match(id: string): StoredMatch | null {
    const header = this.header(id)
    return header ? { id, header, events: this.events(id) } : null
  }

  /** Matches newest first, by the time each header claims it started. */
  recent(limit = 20): MatchSummary[] {
    return this.selectRecent.all({ $limit: limit })
  }

  close(): void {
    this.db.close()
  }

  /**
   * The one place a row is written, so {@link append} and {@link appendAll}
   * cannot disagree about how an event is numbered.
   */
  private insert(id: string, event: UnsequencedEvent): RecordedEvent {
    const row = this.insertEvent.get({
      $id: id,
      $turn: event.turn,
      $faction: event.faction,
      // Serialised rather than kept, so a caller is free to reuse the command
      // object it handed over — the same reason `Recorder.record` clones.
      $command: JSON.stringify(event.command),
    })
    if (!row) throw new Error(`match ${id}: the log refused an event`)
    return { seq: row.seq, turn: event.turn, faction: event.faction, command: event.command }
  }

  private requireMatch(id: string): void {
    if (!this.selectHeader.get({ $id: id })) {
      throw new Error(`no match ${id} in this store: create the match before appending to its log`)
    }
  }
}
