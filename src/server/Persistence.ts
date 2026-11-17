import { type AccountStore, accountStoreOverDb, type RelyingParty } from './AccountStore'
import type { AccountsPort } from './AccountsPort'
import type { ServerClock } from './Clock'
import type { Db } from './db/Db'
import { type RegionStore, regionStoreOverDb } from './RegionStore'

/**
 * What `createMatchServer` is handed from a process that holds both stores:
 * the accounts and the region, and the passkeys' relying party the account
 * store was opened with.
 */
export function portsOf({ accounts, region }: Persistence): { accounts: AccountsPort; region: RegionStore; party: RelyingParty } {
  return { accounts: accounts.accounts, region, party: accounts.party }
}

/**
 * Both stores of a host that holds the directory and a region in one process:
 * the Bun server, and the singleton Durable Object, which is the directory and
 * the region `singleton` at once (RFC-0002 §4). A region Durable Object that is
 * not the directory has only a `RegionStore` and reaches accounts through
 * `AccountsPort` (`workers/AccountsRpc.ts`).
 *
 * The two stores run over two `Db`s, or over one: a database written before
 * the split holds both stores' tables, and the singleton keeps it as it is.
 * Neither store may care which (`store_migrations` keeps their ledgers apart,
 * and no region table refers to an account table).
 */
export interface Persistence {
  accounts: AccountStore
  region: RegionStore
  close(): Promise<void>
}

export interface PersistenceOptions {
  /** The passkeys' relying party; `LOCAL_RELYING_PARTY` unless set. */
  party?: RelyingParty
  /** A second database for the region to keep its own in; unset, both stores live in the first. */
  regionDb?: Db
  /** The region this is, as an owner column names it; the singleton unless set. */
  self?: string
}

/** Both stores, wired and migrated. */
export async function persistenceOverDb(db: Db, clock: ServerClock, options: PersistenceOptions = {}): Promise<Persistence> {
  const regionDb = options.regionDb ?? db
  const accounts = await accountStoreOverDb(db, clock, options.party)
  const region = await regionStoreOverDb(regionDb, clock, accounts.accounts, options.self)
  return {
    accounts,
    region,
    close: async () => {
      await region.close()
      if (regionDb !== db) await accounts.db.close()
    },
  }
}
