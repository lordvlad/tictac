import { Accounts } from './Accounts'
import type { ServerClock } from './Clock'
import { ACCOUNT_SCHEMA } from './db/accountMigrations'
import type { Db } from './db/Db'
import { migrate } from './db/migrate'

/**
 * The directory's database, migrated, with the one store that reads it:
 * players, their passkeys, their sessions and the challenges in flight
 * (RFC-0002 §4).
 *
 * One per deployment, wherever the directory lives — the Bun process, or the
 * directory Durable Object. A region reaches it through `AccountsPort`, never
 * by opening it.
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

export interface AccountStore {
  db: Db
  accounts: Accounts
  /** The passkeys' relying party, which a server also publishes the related origins of (`RelatedOrigins.ts`). */
  party: RelyingParty
}

/**
 * The account store, on an already-open `Db` — migrated on the way in.
 * Engine-agnostic on purpose: this file stays free of `bun`'s own types (see
 * `db/Db.ts`'s note), so what opens a `Db` from a url lives in
 * `db/BunSqlDb.ts`, and a Durable Object's own SQLite storage
 * (`workers/DoSqliteDb.ts`) calls this directly.
 */
export async function accountStoreOverDb(
  db: Db,
  clock: ServerClock,
  party: RelyingParty = LOCAL_RELYING_PARTY,
): Promise<AccountStore> {
  // Every process that opens the database migrates it on the way in. That is
  // safe because `migrate` is idempotent and refuses a database from a newer
  // build, and it means there is no separate deploy step to forget.
  await migrate(db, clock, ACCOUNT_SCHEMA)
  return { db, accounts: new Accounts(db, party, clock), party }
}
