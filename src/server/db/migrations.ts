import type { Migration } from './migrate'

/**
 * Every schema change this build knows, in the order they happened.
 *
 * Append only, and never edit one that has shipped: a migration is identified
 * by its number *and* its name, and `migrate` refuses a database whose record
 * of migration 2 disagrees with this file's. Renaming one is therefore a
 * deliberate breaking change, not a tidy-up.
 *
 * The tables here fall into five groups: the intent log a referee keeps, the
 * accounts a player signs in with, the roster those accounts own, the rooms a
 * lobby holds open across a restart, and where each squad is on the map.
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
  {
    id: 4,
    name: 'lasting wounds',
    up: [
      // A sentinel rather than a real health value, on purpose: every existing
      // active row predates HP tracking, and `Soldier`'s own clamp
      // (`clamp(startingHp, 1, maxHp)`) turns any value at or above a
      // character's ceiling into full health — so a row from before this
      // migration backfills to exactly what it already deployed at, with no
      // per-row computation and no JSON operator in SQL.
      'ALTER TABLE roster ADD COLUMN hp INTEGER NOT NULL DEFAULT 9999',
      // A frozen snapshot of `noDeeds()`'s shape, the way every migration
      // freezes what was true when it was written: an empty service record,
      // one count per weapon class this build had. Never edited afterwards —
      // a WeaponId added later gets its own zero here from `Rosters` code,
      // not from an edited migration.
      `ALTER TABLE roster ADD COLUMN deeds TEXT NOT NULL DEFAULT '${JSON.stringify({
        hits: { rifle: 0, shotgun: 0, sniper: 0, gatling: 0 },
        crits: { rifle: 0, shotgun: 0, sniper: 0, gatling: 0 },
        kills: 0,
        wounds: 0,
        unseen: 0,
        pushed: 0,
        blows: 0,
        forced: 0,
        heavy: 0,
        kit: 0,
      })}'`,
    ],
  },
  {
    id: 5,
    name: 'fatigue and medical bay',
    up: [
      // Zero for every existing row, the same reasoning as `hp`'s backfill in
      // migration 4: a row from before fatigue was tracked never deployed
      // back-to-back under this rule, so it owes nothing and sits idle,
      // which is exactly what `fatigue = 0, downtime = 0` means.
      'ALTER TABLE roster ADD COLUMN fatigue INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE roster ADD COLUMN downtime INTEGER NOT NULL DEFAULT 0',
    ],
  },
  {
    id: 6,
    name: 'rooms',
    up: [
      // A room not yet over, as much of it as a restarted server needs to
      // hold its seats again (`RoomStore`); the match it plays is already in
      // `matches`/`events` under the same id. A room that ends deletes its
      // row, so the table holds live rooms only. A seat keeps the hash of
      // its key, never the key — the same reason `sessions` keeps no token.
      // No foreign keys: an anonymous seat names nobody, and nothing reads a
      // player through a room.
      `CREATE TABLE rooms (
         id             TEXT    PRIMARY KEY,
         build          TEXT    NOT NULL,
         protocol       INTEGER NOT NULL,
         phase          TEXT    NOT NULL,
         created_at     TEXT    NOT NULL,
         judged         INTEGER NOT NULL,
         sides          TEXT    NOT NULL,
         blue_player_id TEXT,
         blue_name      TEXT,
         blue_key_hash  TEXT    NOT NULL,
         red_player_id  TEXT,
         red_name       TEXT,
         red_key_hash   TEXT
       )`,
    ],
  },
  {
    id: 7,
    name: 'squads',
    up: [
      // Where a squad is: its waypoint list as JSON (`src/core/Travel.ts`),
      // never a stored point — the position now is computed from the list
      // and the clock. The start is kept beside it, in integer millionths of
      // a degree, so the 1 km separation between starts is a range query
      // rather than a scan of every list. No player who registered before
      // this has a row; `Squads.ensure` places them when first asked.
      `CREATE TABLE squads (
         id           TEXT    PRIMARY KEY,
         player_id    TEXT    NOT NULL REFERENCES players(id),
         waypoints    TEXT    NOT NULL,
         start_lat_e6 INTEGER NOT NULL,
         start_lng_e6 INTEGER NOT NULL,
         created_at   TEXT    NOT NULL
       )`,
      // One squad per player for now. Dropped when a player may have several.
      'CREATE UNIQUE INDEX squads_player ON squads (player_id)',
      'CREATE INDEX squads_start ON squads (start_lat_e6, start_lng_e6)',
    ],
  },
  {
    id: 8,
    name: 'encounter rooms',
    up: [
      // A room the server opened for a fight on the road (`ITEM-048`) is not
      // listed and falls back to the AI where an ordinary room would end;
      // zero for every room opened before this, which a player opened.
      'ALTER TABLE rooms ADD COLUMN encounter INTEGER NOT NULL DEFAULT 0',
      // Who moves each seat — `player`, `reserved` or `ai` (`SeatControl`) —
      // so a restarted server knows which seats to re-attach the AI to, and
      // which to keep for a player still inside the join window. Every
      // earlier seat was a player's.
      "ALTER TABLE rooms ADD COLUMN blue_control TEXT NOT NULL DEFAULT 'player'",
      "ALTER TABLE rooms ADD COLUMN red_control TEXT NOT NULL DEFAULT 'player'",
      // When a reserved seat passes to the AI, as an ISO string like every
      // timestamp here: a millisecond clock does not fit Postgres's INTEGER.
      // Null for a seat that is not reserved.
      'ALTER TABLE rooms ADD COLUMN blue_join_by TEXT',
      'ALTER TABLE rooms ADD COLUMN red_join_by TEXT',
    ],
  },
  {
    id: 9,
    name: 'encounters',
    up: [
      // What found a squad on the road (`ITEM-048`): one row per contact, a
      // fight opened or a squad passed by, never for a roll that found
      // nothing — that is reproducible from its key. The unique key is what
      // makes a checkpoint handled once across a restart. `found_at` is the
      // server's clock in ms, a BIGINT because a millisecond epoch does not
      // fit Postgres's INTEGER; the place is in millionths of a degree, as a
      // squad's start is. `room_id` is the fight's room, which is its match:
      // how it ended is read from `match_results`, not copied here.
      `CREATE TABLE encounters (
         id            TEXT    PRIMARY KEY,
         squad_id      TEXT    NOT NULL REFERENCES squads(id),
         player_id     TEXT    NOT NULL REFERENCES players(id),
         trip          TEXT    NOT NULL,
         checkpoint    INTEGER NOT NULL,
         found_at      BIGINT  NOT NULL,
         lat_e6        INTEGER NOT NULL,
         lng_e6        INTEGER NOT NULL,
         aliens        INTEGER NOT NULL,
         room_id       TEXT,
         passed_for    TEXT,
         played_by_you INTEGER NOT NULL DEFAULT 0,
         UNIQUE (squad_id, trip, checkpoint)
       )`,
      'CREATE INDEX encounters_player ON encounters (player_id, found_at)',
      'CREATE INDEX encounters_room ON encounters (room_id)',
    ],
  },
]
