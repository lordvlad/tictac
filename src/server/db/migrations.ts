import type { Migration } from './migrate'

/**
 * Every schema change this build knows, in the order they happened.
 *
 * Append only, and never edit one that has shipped: a migration is identified
 * by its number *and* its name, and `migrate` refuses a database whose record
 * of migration 2 disagrees with this file's. Renaming one is therefore a
 * deliberate breaking change, not a tidy-up.
 *
 * The tables here fall into three groups, which is why there are three
 * migrations rather than one: the intent log a referee keeps, the accounts a
 * player signs in with, and the roster those accounts own.
 */

/**
 * The append-only guard, spelled for both engines.
 *
 * The log is evidence: it is the only way to tell a foul from a bug in the
 * rules, so the refusal lives in the database rather than in the class in front
 * of it. A guard a caller can route around guards nothing.
 *
 * SQLite needs one trigger per operation; Postgres needs a function and one
 * trigger covering both. They are paired so each engine runs two statements.
 */
const APPEND_ONLY_FUNCTION = `
CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the intent log is append-only: an event cannot be %',
    CASE TG_OP WHEN 'UPDATE' THEN 'rewritten' ELSE 'deleted' END;
END $$`

const APPEND_ONLY_TRIGGER = `
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only()`

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'match log',
    up: [
      // The header goes in whole because it is a document: decomposing sheets
      // and loadouts into columns would restate a shape `parseRecording`
      // already owns. `created_at` and `seed_label` are copied out of it at
      // write time rather than derived in SQL — a generated column is SQLite's
      // alone — so a list can sort and label itself without parsing a header.
      `CREATE TABLE matches (
         id         TEXT PRIMARY KEY,
         header     TEXT NOT NULL,
         created_at TEXT NOT NULL,
         seed_label TEXT NOT NULL
       )`,
      'CREATE INDEX matches_created_at ON matches (created_at)',
      // `seq` is dense and per match, which is what a rejoining client counts
      // in, and the insert itself chooses it — see `MatchStore.append`.
      `CREATE TABLE events (
         match_id TEXT    NOT NULL REFERENCES matches(id),
         seq      INTEGER NOT NULL,
         turn     INTEGER NOT NULL,
         faction  INTEGER NOT NULL,
         command  TEXT    NOT NULL,
         PRIMARY KEY (match_id, seq)
       )`,
      {
        sqlite: `CREATE TRIGGER events_append_only_update
                   BEFORE UPDATE ON events
                   BEGIN SELECT RAISE(ABORT, 'the intent log is append-only: an event cannot be rewritten'); END`,
        postgres: APPEND_ONLY_FUNCTION,
      },
      {
        sqlite: `CREATE TRIGGER events_append_only_delete
                   BEFORE DELETE ON events
                   BEGIN SELECT RAISE(ABORT, 'the intent log is append-only: an event cannot be deleted'); END`,
        postgres: APPEND_ONLY_TRIGGER,
      },
    ],
  },
  {
    id: 2,
    name: 'accounts',
    up: [
      `CREATE TABLE players (
         id         TEXT PRIMARY KEY,
         name       TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
      // `public_key` is the SPKI bytes as base64url, because binary columns are
      // where the two engines differ most. `sign_count` is the authenticator's
      // u32 counter; Postgres returns a BIGINT as a string, so every read of it
      // goes through `Number`.
      `CREATE TABLE credentials (
         id         TEXT   PRIMARY KEY,
         player_id  TEXT   NOT NULL REFERENCES players(id),
         public_key TEXT   NOT NULL,
         algorithm  INTEGER NOT NULL,
         sign_count BIGINT NOT NULL,
         created_at TEXT   NOT NULL
       )`,
      'CREATE INDEX credentials_player ON credentials (player_id)',
      // The token itself is never stored, only its hash: a stolen database is
      // then not a drawer full of working sessions.
      `CREATE TABLE sessions (
         token_hash TEXT PRIMARY KEY,
         player_id  TEXT NOT NULL REFERENCES players(id),
         created_at TEXT NOT NULL,
         expires_at TEXT NOT NULL
       )`,
      // In the database rather than in memory, so a challenge issued by one
      // instance can be answered at another.
      `CREATE TABLE auth_challenges (
         id         TEXT PRIMARY KEY,
         purpose    TEXT NOT NULL,
         challenge  TEXT NOT NULL,
         user_id    TEXT,
         name       TEXT,
         expires_at TEXT NOT NULL
       )`,
    ],
  },
  {
    id: 3,
    name: 'rosters',
    up: [
      // A dead character is kept, not deleted: permadeath is the point, and the
      // row is the history of somebody who was. `status` is 'active' or 'dead'.
      `CREATE TABLE roster (
         character_id TEXT    PRIMARY KEY,
         player_id    TEXT    NOT NULL REFERENCES players(id),
         slot         INTEGER NOT NULL,
         sheet        TEXT    NOT NULL,
         status       TEXT    NOT NULL,
         matches      INTEGER NOT NULL,
         created_at   TEXT    NOT NULL,
         died_in      TEXT    REFERENCES matches(id)
       )`,
      // Partial, so one *living* character holds a slot while every previous
      // occupant of it stays in the table.
      "CREATE UNIQUE INDEX roster_active_slot ON roster (player_id, slot) WHERE status = 'active'",
      // One row per settled match, and the reason settling is idempotent: a
      // referee that is asked twice writes the growth once.
      `CREATE TABLE match_results (
         match_id    TEXT PRIMARY KEY REFERENCES matches(id),
         winner      INTEGER NOT NULL,
         blue_player TEXT REFERENCES players(id),
         red_player  TEXT REFERENCES players(id),
         settled_at  TEXT NOT NULL
       )`,
    ],
  },
]
