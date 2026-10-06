/**
 * Host refereed matches: a lobby of rooms.
 *
 * Usage:
 *   bun scripts/serve-match.ts
 *   bun scripts/serve-match.ts --db=sqlite://matches.sqlite --rp-id=localhost --origins=http://localhost:5173
 *
 * A thin CLI: it reads flags, opens the database and starts the server. What it
 * knows about the game it knows through `GameServer`, which knows it through
 * `Lobby` and its `Room`s, which know it through `MatchHost` — the same
 * systems a match uses.
 *
 * Reachability is the honest cost of a WebSocket. A page served over `https`
 * may not open an insecure socket, so a public referee needs a host and a
 * certificate; Chromium's loopback exception makes `ws://localhost` work from
 * the deployed site, which is enough for development and a match over a LAN.
 * The same applies to passkeys: `--rp-id` must be the domain the page is served
 * from, and `--origins` must list it.
 */
import { startGameServer } from '../src/server/GameServer'
import { openPersistence } from '../src/server/db/BunSqlDb'
import type { RelyingParty } from '../src/server/Persistence'
import { BUILD_ID, PROTOCOL_VERSION } from '../src/version'

const arg = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

const port = Number(arg('port') ?? 5174)
const databaseUrl = arg('db') ?? process.env.TICTAC_DB ?? ':memory:'
const party: RelyingParty = {
  id: arg('rp-id') ?? 'localhost',
  origins: (arg('origins') ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()),
}

const persistence = await openPersistence(databaseUrl, party)
const server = await startGameServer({ persistence, port, party })

console.info(`[referee] watching on ${server.url} — build ${BUILD_ID}, protocol ${PROTOCOL_VERSION}`)
console.info(`[referee] database: ${databaseUrl}`)
console.info(`[referee] passkeys for ${party.id}, from ${party.origins.join(', ')}`)

process.on('SIGINT', () => {
  void (async () => {
    await server.stop()
    await persistence.close()
    process.exit(0)
  })()
})
