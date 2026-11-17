import type { Schema } from './migrate'

/**
 * The account store's schema (RFC-0002 §4): who a player is and how they prove
 * it. Lives in the directory — the one Durable Object (or Bun process) that
 * answers for every region — and nothing in it names a region's data: a
 * region's tables refer to a player by id alone, and ask this store who that is.
 *
 * Append only, and never edit one that has shipped (see `migrate`).
 */
export const ACCOUNT_SCHEMA: Schema = {
  store: 'accounts',
  migrations: [
    {
      id: 1,
      name: 'accounts',
      // `IF NOT EXISTS` because this is also what a database written before
      // the stores were split already holds: its accounts tables were created
      // by the old single migration 2 in exactly this shape, and are adopted
      // as they are (`migrate`'s `checkMonolith` has made sure they are
      // complete).
      up: [
        `CREATE TABLE IF NOT EXISTS players (
           id         TEXT PRIMARY KEY,
           name       TEXT NOT NULL,
           created_at TEXT NOT NULL
         )`,
        // `public_key` is the SPKI bytes as base64url, because the port binds
        // only TEXT and INTEGER. `sign_count` is the authenticator's u32
        // counter, declared BIGINT; it is read through `Number` all the same.
        `CREATE TABLE IF NOT EXISTS credentials (
           id         TEXT   PRIMARY KEY,
           player_id  TEXT   NOT NULL REFERENCES players(id),
           public_key TEXT   NOT NULL,
           algorithm  INTEGER NOT NULL,
           sign_count BIGINT NOT NULL,
           created_at TEXT   NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS credentials_player ON credentials (player_id)',
        // The token itself is never stored, only its hash: a stolen database is
        // then not a drawer full of working sessions.
        `CREATE TABLE IF NOT EXISTS sessions (
           token_hash TEXT PRIMARY KEY,
           player_id  TEXT NOT NULL REFERENCES players(id),
           created_at TEXT NOT NULL,
           expires_at TEXT NOT NULL
         )`,
        // In the database rather than in memory, so a challenge issued by one
        // instance can be answered at another.
        `CREATE TABLE IF NOT EXISTS auth_challenges (
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
      id: 2,
      name: 'player home region',
      // Which region keeps the player's squad: where a sign-in is let in, and
      // where every other region sends them (RFC-0002 §3). Everyone who exists
      // before this has only ever had one region, `singleton` (`SINGLETON_REGION`,
      // spelled out because a migration must not change meaning when a constant does).
      up: [`ALTER TABLE players ADD COLUMN home_region TEXT NOT NULL DEFAULT 'singleton'`],
    },
  ],
}
