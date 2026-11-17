import type { Migration, Schema } from './migrate'

/**
 * A region's store schema (RFC-0002 §4): the intent log a referee keeps, the
 * rosters and squads a region's players own, the encounters on its roads, and
 * the rooms its lobby holds open across a restart.
 *
 * **No table here refers to the account store's.** A player is a bare id: who
 * that is, is asked of the directory (`AccountsPort`), because the directory
 * may be a different Durable Object, with a different database, from the
 * region the player is standing in. A foreign key would be a promise only one
 * database can keep.
 *
 * Append only, and never edit one that has shipped (see `migrate`).
 *
 * The intent log is evidence: it is the only way to tell a foul from a bug in
 * the rules, so its append-only refusal lives in the database (a trigger per
 * operation, in the baseline) rather than in the class in front of it. A guard
 * a caller can route around guards nothing.
 */

/**
 * The tables whose last shape is spelled once and used twice: by the baseline
 * (`IF NOT EXISTS`, which is a no-op over a database that already has them
 * from before the split) and by the rebuild that takes the player foreign keys
 * out of such a database (`create`, plain, into the name just vacated).
 */
const TABLES = {
  // A dead character is kept, not deleted: permadeath is the point, and the
  // row is the history of somebody who was. `status` is 'active' or 'dead'.
  // `died_in` names the match that killed them and is not a foreign key: the
  // match is in the region that played it, and a squad's roster travels
  // between regions (`RegionStore.exportSquad`) while the matches stay.
  // `hp` defaults to a sentinel, not a real health value, on purpose: a row
  // from before HP tracking backfills to what it already deployed at,
  // because `Soldier`'s clamp turns any value at or above a character's
  // ceiling into full health. `deeds` defaults to a frozen snapshot of
  // `noDeeds()`'s shape — never edited afterwards: a WeaponId added later
  // gets its own zero from `Rosters` code, not from an edited default.
  roster: (head: string) => `${head} roster (
         character_id TEXT    PRIMARY KEY,
         player_id    TEXT    NOT NULL,
         slot         INTEGER NOT NULL,
         sheet        TEXT    NOT NULL,
         status       TEXT    NOT NULL,
         matches      INTEGER NOT NULL,
         created_at   TEXT    NOT NULL,
         died_in      TEXT,
         hp           INTEGER NOT NULL DEFAULT 9999,
         deeds        TEXT    NOT NULL DEFAULT '{"hits":{"rifle":0,"shotgun":0,"sniper":0,"gatling":0},"crits":{"rifle":0,"shotgun":0,"sniper":0,"gatling":0},"kills":0,"wounds":0,"unseen":0,"pushed":0,"blows":0,"forced":0,"heavy":0,"kit":0}',
         fatigue      INTEGER NOT NULL DEFAULT 0,
         downtime     INTEGER NOT NULL DEFAULT 0
       )`,
  // One row per settled match, and the reason settling is idempotent: a
  // referee that is asked twice writes the growth once.
  match_results: (head: string) => `${head} match_results (
         match_id    TEXT PRIMARY KEY REFERENCES matches(id),
         winner      INTEGER NOT NULL,
         blue_player TEXT,
         red_player  TEXT,
         settled_at  TEXT NOT NULL
       )`,
  // Where a squad is: its waypoint list as JSON (`src/core/Travel.ts`), never
  // a stored point — the position now is computed from the list and the
  // clock. The start is kept beside it, in integer millionths of a degree, so
  // the 1 km separation between starts is a range query rather than a scan of
  // every list. `owner` is which region Durable Object keeps this squad
  // (RFC-0002 §4): a durable fact written when a handover commits, not
  // recomputed from where the squad stands.
  squads: (head: string) => `${head} squads (
         id           TEXT    PRIMARY KEY,
         player_id    TEXT    NOT NULL,
         waypoints    TEXT    NOT NULL,
         start_lat_e6 INTEGER NOT NULL,
         start_lng_e6 INTEGER NOT NULL,
         created_at   TEXT    NOT NULL,
         standing     TEXT    NOT NULL DEFAULT 'stand',
         owner        TEXT    NOT NULL DEFAULT 'singleton'
       )`,
  // What found a squad on the road (`ITEM-048`): one row per contact, a fight
  // opened or a squad passed by, never for a roll that found nothing — that is
  // reproducible from its key. The unique key is what makes a checkpoint
  // handled once across a restart. `found_at` is the server's clock in ms,
  // declared BIGINT because a millisecond epoch is past 32 bits; the
  // place is in millionths of a degree, as a squad's start is. `room_id` is
  // the fight's room, which is its match. `settled` is 0 while the outcome
  // is still being carried out and 1 once it is written (the contact is
  // written down *before* the fight it calls for is opened).
  encounters: (head: string) => `${head} encounters (
         id                 TEXT    PRIMARY KEY,
         squad_id           TEXT    NOT NULL REFERENCES squads(id),
         player_id          TEXT    NOT NULL,
         trip               TEXT    NOT NULL,
         checkpoint         INTEGER NOT NULL,
         found_at           BIGINT  NOT NULL,
         lat_e6             INTEGER NOT NULL,
         lng_e6             INTEGER NOT NULL,
         aliens             INTEGER NOT NULL,
         room_id            TEXT,
         passed_for         TEXT,
         played_by_you      INTEGER NOT NULL DEFAULT 0,
         opponent_player_id TEXT,
         settled            INTEGER NOT NULL DEFAULT 1,
         UNIQUE (squad_id, trip, checkpoint)
       )`,
}

const ROSTER_COLUMNS =
  'character_id, player_id, slot, sheet, status, matches, created_at, died_in, hp, deeds, fatigue, downtime'
const MATCH_RESULT_COLUMNS = 'match_id, winner, blue_player, red_player, settled_at'
const SQUAD_COLUMNS = 'id, player_id, waypoints, start_lat_e6, start_lng_e6, created_at, standing, owner'
const ENCOUNTER_COLUMNS =
  'id, squad_id, player_id, trip, checkpoint, found_at, lat_e6, lng_e6, aliens, room_id, passed_for, played_by_you, opponent_player_id, settled'

// Partial, so one *living* character holds a slot while every previous
// occupant of it stays in the table.
const ROSTER_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS roster_active_slot ON roster (player_id, slot) WHERE status = 'active'"
// One squad per player in a region for now. Dropped when a player may have several.
const SQUAD_INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS squads_player ON squads (player_id)',
  'CREATE INDEX IF NOT EXISTS squads_start ON squads (start_lat_e6, start_lng_e6)',
]
const ENCOUNTER_INDEXES = [
  'CREATE INDEX IF NOT EXISTS encounters_player ON encounters (player_id, found_at)',
  'CREATE INDEX IF NOT EXISTS encounters_room ON encounters (room_id)',
]

/**
 * Remake `table` without the foreign keys it was created with before the
 * split, in the shape `TABLES` gives it. SQLite cannot drop a constraint, so
 * the old table is set aside, the new one written from it, and the old one
 * dropped (with its indexes, which the caller then recreates). Done in one
 * transaction with the migration's own bookkeeping, so a failure leaves the
 * old table where it was.
 */
function rebuild(table: keyof typeof TABLES, columns: string): string[] {
  return [
    `ALTER TABLE ${table} RENAME TO ${table}_keyed`,
    TABLES[table]('CREATE TABLE'),
    `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table}_keyed`,
    `DROP TABLE ${table}_keyed`,
  ]
}

const BASELINE: Migration = {
  id: 1,
  name: 'region baseline',
  // `IF NOT EXISTS` throughout: this is what a database written before the
  // stores were split already holds — the old single schema's tables, with
  // every column its migrations 1–12 added — and they are adopted as they
  // are (`migrate`'s `checkMonolith` has made sure they are complete). The
  // next migration takes the player foreign keys such a database still has
  // out of them.
  up: [
    // The header goes in whole because it is a document: decomposing sheets
    // and loadouts into columns would restate a shape `parseRecording` already
    // owns. `created_at` and `seed_label` are copied out of it at write time
    // rather than derived in SQL — a generated column is SQLite's alone — so a
    // list can sort and label itself without parsing a header.
    `CREATE TABLE IF NOT EXISTS matches (
       id         TEXT PRIMARY KEY,
       header     TEXT NOT NULL,
       created_at TEXT NOT NULL,
       seed_label TEXT NOT NULL
     )`,
    'CREATE INDEX IF NOT EXISTS matches_created_at ON matches (created_at)',
    // `seq` is dense and per match, which is what a rejoining client counts
    // in, and the insert itself chooses it — see `MatchStore.append`.
    `CREATE TABLE IF NOT EXISTS events (
       match_id TEXT    NOT NULL REFERENCES matches(id),
       seq      INTEGER NOT NULL,
       turn     INTEGER NOT NULL,
       faction  INTEGER NOT NULL,
       command  TEXT    NOT NULL,
       PRIMARY KEY (match_id, seq)
     )`,
    `CREATE TRIGGER IF NOT EXISTS events_append_only_update
       BEFORE UPDATE ON events
       BEGIN SELECT RAISE(ABORT, 'the intent log is append-only: an event cannot be rewritten'); END`,
    `CREATE TRIGGER IF NOT EXISTS events_append_only_delete
       BEFORE DELETE ON events
       BEGIN SELECT RAISE(ABORT, 'the intent log is append-only: an event cannot be deleted'); END`,
    TABLES.roster('CREATE TABLE IF NOT EXISTS'),
    ROSTER_INDEX,
    TABLES.match_results('CREATE TABLE IF NOT EXISTS'),
    // A room not yet over, as much of it as a restarted server needs to hold
    // its seats again (`RoomStore`); the match it plays is already in
    // `matches`/`events` under the same id. A room that ends deletes its row,
    // so the table holds live rooms only. A seat keeps the hash of its key,
    // never the key — the same reason `sessions` keeps no token. `encounter`
    // marks a room the server opened for a fight on the road (`ITEM-048`);
    // `*_control` says who moves each seat (`player`, `reserved` or `ai`),
    // `*_join_by` when a reserved seat passes to the AI (an ISO string, like
    // every timestamp here), `*_standing` what
    // each AI seat plays to (`ITEM-053`).
    `CREATE TABLE IF NOT EXISTS rooms (
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
       red_key_hash   TEXT,
       encounter      INTEGER NOT NULL DEFAULT 0,
       blue_control   TEXT    NOT NULL DEFAULT 'player',
       red_control    TEXT    NOT NULL DEFAULT 'player',
       blue_join_by   TEXT,
       red_join_by    TEXT,
       blue_standing  TEXT    NOT NULL DEFAULT 'stand',
       red_standing   TEXT    NOT NULL DEFAULT 'stand'
     )`,
    TABLES.squads('CREATE TABLE IF NOT EXISTS'),
    ...SQUAD_INDEXES,
    TABLES.encounters('CREATE TABLE IF NOT EXISTS'),
    ...ENCOUNTER_INDEXES,
  ],
}

const WITHOUT_PLAYER_KEYS: Migration = {
  id: 2,
  name: 'no player foreign keys',
  // A database written before the split has `REFERENCES players(id)` on its
  // roster, squads, encounters and results, and one more on `roster.died_in`;
  // a region without a `players` table could not write a row under them, and
  // a squad handed over from another region would not have its player here at
  // all. A fresh region database never had them, so there this rebuilds empty
  // tables into the shape they already have.
  //
  // The rebuild is as ordered as it is because SQLite enforces keys while it
  // works: `encounters` points at `squads`, so it is set aside first and
  // remade last, and no table is renamed or dropped while another still
  // refers to it.
  up: [
    ...rebuild('roster', ROSTER_COLUMNS),
    ROSTER_INDEX,
    ...rebuild('match_results', MATCH_RESULT_COLUMNS),
    `CREATE TABLE encounters_stash AS SELECT ${ENCOUNTER_COLUMNS} FROM encounters`,
    'DROP TABLE encounters',
    ...rebuild('squads', SQUAD_COLUMNS),
    ...SQUAD_INDEXES,
    TABLES.encounters('CREATE TABLE'),
    `INSERT INTO encounters (${ENCOUNTER_COLUMNS}) SELECT ${ENCOUNTER_COLUMNS} FROM encounters_stash`,
    'DROP TABLE encounters_stash',
    ...ENCOUNTER_INDEXES,
  ],
}

const HANDOVER_RECOVERY: Migration = {
  id: 3,
  name: 'handover recovery',
  // What a restart resumes of a squad crossing the border (`HandoverStore`).
  // `crossings` is the order, one per squad; `handovers` is a handover in
  // flight as the region on either end of it keeps it, told apart by `role`
  // ('source' or 'target'). Times are the server's clock in ms, declared BIGINT
  // because a millisecond epoch is past 32 bits (SQLite stores it as the same
  // 64-bit integer either way). A squad's crossing
  // is not a foreign key to `squads`: a squad that has crossed is no longer
  // here, and its row is deleted by the crossing, not by cascade.
  up: [
    `CREATE TABLE IF NOT EXISTS crossings (
       squad_id  TEXT    PRIMARY KEY,
       player_id TEXT    NOT NULL,
       region    TEXT    NOT NULL,
       to_lat_e6 INTEGER NOT NULL,
       to_lng_e6 INTEGER NOT NULL,
       attempts  INTEGER NOT NULL,
       next_at   BIGINT  NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS handovers (
       handover_id   TEXT    PRIMARY KEY,
       role          TEXT    NOT NULL,
       squad_id      TEXT    NOT NULL,
       player_id     TEXT    NOT NULL,
       source_region TEXT    NOT NULL,
       target_region TEXT    NOT NULL,
       target_url    TEXT,
       token         TEXT    NOT NULL,
       expires_at    BIGINT  NOT NULL,
       attempts      INTEGER NOT NULL DEFAULT 0,
       state         TEXT    NOT NULL
     )`,
  ],
}

export const REGION_SCHEMA: Schema = {
  store: 'region',
  migrations: [BASELINE, WITHOUT_PLAYER_KEYS, HANDOVER_RECOVERY],
}
