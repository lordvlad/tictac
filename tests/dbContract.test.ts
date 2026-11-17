import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { WALL_CLOCK } from '../src/server/Clock'
import { Batch, type Db, type SqlValue } from '../src/server/db/Db'
import { migrate, type Migration } from '../src/server/db/migrate'
import { dbOverStorage, type DoStorage } from '../workers/DoSqliteDb'
import { DATABASE_URLS, freshDb } from './support/db'

/**
 * What `Db.transaction` promises, asserted once and run against every adapter.
 *
 * The Durable Object adapter cannot be started here (that takes `workerd`,
 * `tests/cloudflare.test.ts`), so it runs over a fake `ctx.storage` that keeps
 * the one property of `transactionSync` the adapter relies on: a throw inside
 * the closure rolls back every write the closure made. The fake counts its
 * closures, so a batch that ran outside `transactionSync` would not pass.
 */

interface FakeStorage extends DoStorage {
  /** How many times `transactionSync` was entered. */
  transactions: number
}

function fakeStorage(): FakeStorage {
  const sqlite = new Database(':memory:')
  const storage: FakeStorage = {
    transactions: 0,
    sql: {
      exec: (query: string, ...bindings: SqlValue[]) => {
        const rows = sqlite.query(query).all(...bindings)
        return { toArray: () => rows }
      },
    },
    transactionSync<T>(closure: () => T): T {
      storage.transactions++
      return sqlite.transaction(closure)()
    },
  }
  return storage
}

const adapters: (readonly [string, () => Promise<Db>])[] = [
  ...DATABASE_URLS.map((url) => [`Bun.SQL on ${url}`, () => freshDb(url)] as const),
  ['Durable Object storage (fake transactionSync)', async () => dbOverStorage(fakeStorage())],
]

describe.each(adapters)('Db.transaction on %s', (_name, open) => {
  async function table(): Promise<Db> {
    const db = await open()
    await db.exec('CREATE TABLE things (id TEXT PRIMARY KEY, n INTEGER NOT NULL)')
    return db
  }

  const rowsOf = (db: Db) => db.query<{ id: string; n: number }>`SELECT id, n FROM things ORDER BY id`

  test('every step commits together, in order', async () => {
    const db = await table()
    const batch = new Batch()
    batch.query`INSERT INTO things (id, n) VALUES (${'a'}, ${1})`
    batch.query`INSERT INTO things (id, n) VALUES (${'b'}, ${2})`
    batch.query`UPDATE things SET n = n + ${10} WHERE id = ${'a'}`
    await db.transaction(batch)
    expect((await rowsOf(db)).map((row) => [row.id, Number(row.n)])).toEqual([
      ['a', 11],
      ['b', 2],
    ])
    await db.close()
  })

  test('a step that fails after the first write leaves no rows', async () => {
    const db = await table()
    const batch = new Batch()
    batch.query`INSERT INTO things (id, n) VALUES (${'a'}, ${1})`
    batch.query`INSERT INTO things (id, n) VALUES (${'b'}, ${2})`
    // The primary key refuses the third: the first two were already written.
    batch.query`INSERT INTO things (id, n) VALUES (${'a'}, ${3})`
    await expect(db.transaction(batch)).rejects.toThrow()
    expect(await rowsOf(db)).toEqual([])
    await db.close()
  })

  test('a statement the engine cannot run rolls back what ran before it, DDL included', async () => {
    const db = await open()
    const batch = new Batch()
    batch.exec('CREATE TABLE half (id TEXT PRIMARY KEY)')
    batch.query`INSERT INTO half (id) VALUES (${'x'})`
    batch.exec('NOT A STATEMENT')
    await expect(db.transaction(batch)).rejects.toThrow()
    await expect(db.query`SELECT id FROM half`).rejects.toThrow()
    await db.close()
  })

  test('a rolled-back batch leaves the database usable: the same writes go through on a retry', async () => {
    const db = await table()
    const failing = new Batch()
    failing.query`INSERT INTO things (id, n) VALUES (${'a'}, ${1})`
    failing.query`INSERT INTO things (id, n) VALUES (${'b'}, ${null})`
    await expect(db.transaction(failing)).rejects.toThrow()

    const retry = new Batch()
    retry.query`INSERT INTO things (id, n) VALUES (${'a'}, ${1})`
    retry.query`INSERT INTO things (id, n) VALUES (${'b'}, ${2})`
    await db.transaction(retry)
    expect((await rowsOf(db)).map((row) => row.id)).toEqual(['a', 'b'])
    await db.close()
  })

  test('a migration that fails part way is not half applied (what a Durable Object used to keep)', async () => {
    const db = await open()
    const list: Migration[] = [
      { id: 1, name: 'first', up: ['CREATE TABLE alpha (id TEXT PRIMARY KEY)'] },
      { id: 2, name: 'second', up: ['CREATE TABLE beta (id TEXT PRIMARY KEY)', 'CREATE TABLE beta (this is not sql)'] },
    ]
    await expect(migrate(db, WALL_CLOCK, { store: 'test', migrations: list })).rejects.toThrow(/migration 2 \(second\) failed/)
    await expect(db.query`SELECT id FROM beta`).rejects.toThrow()
    expect((await db.query<{ id: number }>`SELECT id FROM store_migrations WHERE store = 'test' ORDER BY id`).map((row) => Number(row.id))).toEqual([1])
    await db.close()
  })

  test('an empty batch does nothing', async () => {
    const db = await table()
    await db.transaction(new Batch())
    expect(await rowsOf(db)).toEqual([])
    await db.close()
  })
})

describe('the Durable Object adapter runs a batch inside transactionSync', () => {
  test('once per batch, and not at all for a bare query or exec', async () => {
    const storage = fakeStorage()
    const db = dbOverStorage(storage)
    await db.exec('CREATE TABLE things (id TEXT PRIMARY KEY, n INTEGER NOT NULL)')
    await db.query`INSERT INTO things (id, n) VALUES (${'a'}, ${1})`
    expect(storage.transactions).toBe(0)

    const batch = new Batch()
    batch.query`INSERT INTO things (id, n) VALUES (${'b'}, ${2})`
    batch.query`INSERT INTO things (id, n) VALUES (${'c'}, ${3})`
    await db.transaction(batch)
    expect(storage.transactions).toBe(1)
  })
})
