import { Accounts } from './Accounts'
import type { Db } from './db/Db'
import { migrate } from './db/migrate'
import { Encounters } from './Encounters'
import { MatchStore } from './MatchStore'
import { RoomStore } from './RoomStore'
import { Rosters } from './Rosters'
import { Squads } from './Squads'

/**
 * One open database, migrated, with every store that reads it.
 *
 * Nothing else in the server opens a database. A store is handed one, which is
 * what lets the referee, the sessions and the tests share a transaction-capable
 * connection instead of three that can disagree — and what lets a test run the
 * whole server against `:memory:` without a file.
 */

/**
 * The site passkeys are bound to.
 *
 * WebAuthn ties a credential to a relying party id (a domain) and refuses to
 * sign for any other, which is the whole reason a passkey cannot be phished.
 * It therefore has to be configured rather than inferred: a server behind a
 * different domain than the one the page is served from is a server whose
 * passkeys do not work.
 */
export interface RelyingParty {
  readonly id: string
  readonly origins: readonly string[]
}

/** What `bun run dev` serves, and the default for a server started with no flags. */
export const LOCAL_RELYING_PARTY: RelyingParty = {
  id: 'localhost',
  origins: ['http://localhost:5173'],
}

export interface Persistence {
  db: Db
  matches: MatchStore
  rooms: RoomStore
  accounts: Accounts
  rosters: Rosters
  squads: Squads
  encounters: Encounters
  /** The passkeys' relying party, which a server also publishes the related origins of (`RelatedOrigins.ts`). */
  party: RelyingParty
  close(): Promise<void>
}

/**
 * Every store, wired onto an already-open `Db` — migrated on the way in.
 * Engine-agnostic on purpose: this file stays free of `bun`'s own types (see
 * `db/Db.ts`'s note), so `openPersistence` — the `Bun.SQL`-specific
 * convenience that opens a `Db` from a url before calling this — lives in
 * `db/BunSqlDb.ts` instead. A `Db` opened some other way (a Durable Object's
 * own SQLite storage — `workers/DoSqliteDb.ts`, `[ITEM-045]`) calls this
 * directly, and gets the same wiring rather than a second copy of it.
 */
export async function persistenceOverDb(
  db: Db,
  party: RelyingParty = LOCAL_RELYING_PARTY,
): Promise<Persistence> {
  // Every process that opens the database migrates it on the way in. That is
  // safe because `migrate` is idempotent and refuses a database from a newer
  // build, and it means there is no separate deploy step to forget.
  await migrate(db)
  const rosters = new Rosters(db)
  const squads = new Squads(db)
  return {
    db,
    matches: new MatchStore(db),
    rooms: new RoomStore(db),
    accounts: new Accounts(db, rosters, squads, party),
    rosters,
    squads,
    encounters: new Encounters(db),
    party,
    close: () => db.close(),
  }
}
