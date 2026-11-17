import { WALL_CLOCK } from '../../src/server/Clock'
import type { Db } from '../../src/server/db/Db'
import { openDb, openPersistence } from '../../src/server/db/BunSqlDb'
import type { Persistence } from '../../src/server/Persistence'

/** An empty in-memory SQLite database, open and unmigrated. */
export function freshDb(): Promise<Db> {
  return openDb(':memory:')
}

/** An empty in-memory database, open, migrated and behind every store. */
export function freshPersistence(): Promise<Persistence> {
  return openPersistence(WALL_CLOCK, ':memory:')
}
