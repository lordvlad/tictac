import type { Db } from '../../src/server/db/Db'
import { openDb, openPersistence } from '../../src/server/db/BunSqlDb'
import type { Persistence } from '../../src/server/Persistence'

/**
 * Which databases the persistence tests run against.
 *
 * SQLite in memory always, because it needs nothing and it is what a developer
 * runs. Postgres as well whenever `TICTAC_TEST_POSTGRES_URL` points at one —
 * that is the only way the portability rules in `Db.ts` stay a fact rather than
 * an intention. A suite that only ever ran on SQLite would prove that SQLite
 * works.
 */
export const DATABASE_URLS: string[] = [
  ':memory:',
  ...(process.env.TICTAC_TEST_POSTGRES_URL ? [process.env.TICTAC_TEST_POSTGRES_URL] : []),
]

/**
 * An empty database at `url`.
 *
 * A fresh `:memory:` is empty by construction. A Postgres database is not, so
 * its public schema is dropped and remade — which is also why the url is an
 * opt-in environment variable and not a default: this is destructive.
 */
export async function resetDatabase(url: string): Promise<void> {
  if (url === ':memory:' || url.startsWith('sqlite:') || url.startsWith('file:')) return
  const db = await openDb(url)
  await db.exec('DROP SCHEMA public CASCADE')
  await db.exec('CREATE SCHEMA public')
  await db.close()
}

/** A reset database, open and unmigrated. */
export async function freshDb(url: string): Promise<Db> {
  await resetDatabase(url)
  return openDb(url)
}

/** A reset database, open, migrated and behind every store. */
export async function freshPersistence(url: string): Promise<Persistence> {
  await resetDatabase(url)
  return openPersistence(url)
}
