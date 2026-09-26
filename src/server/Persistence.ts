import { Accounts } from './Accounts'
import { openDb, type Db } from './db/Db'
import { migrate } from './db/migrate'
import { MatchStore } from './MatchStore'
import { Rosters } from './Rosters'

/**
 * One open database, migrated, with every store that reads it.
 *
 * Nothing else in the server opens a database. A store is handed one, which is
 * what lets the referee, the HTTP API and the tests share a transaction-capable
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
  accounts: Accounts
  rosters: Rosters
  close(): Promise<void>
}

export async function openPersistence(
  url = ':memory:',
  party: RelyingParty = LOCAL_RELYING_PARTY,
): Promise<Persistence> {
  const db = await openDb(url)
  // Every process that opens the database migrates it on the way in. That is
  // safe because `migrate` is idempotent and refuses a database from a newer
  // build, and it means there is no separate deploy step to forget.
  await migrate(db)
  const rosters = new Rosters(db)
  return {
    db,
    matches: new MatchStore(db),
    accounts: new Accounts(db, rosters, party),
    rosters,
    close: () => db.close(),
  }
}
