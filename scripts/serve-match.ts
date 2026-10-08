/**
 * Host refereed matches: a lobby of rooms.
 *
 * Usage:
 *   bun scripts/serve-match.ts
 *   bun scripts/serve-match.ts --db=sqlite://matches.sqlite --rp-id=localhost --origins=http://localhost:5173
 *   bun scripts/serve-match.ts --tiles=out/tiles/planet-z8-20261007.pmtiles
 *
 * A thin CLI: it reads flags, opens the database and starts the server. What it
 * knows about the game it knows through `GameServer`, which knows it through
 * `Lobby` and its `Room`s, which know it through `MatchHost` — the same
 * systems a match uses.
 *
 * Rooms are kept in the database as well as their matches, and taken up again
 * when the server starts, so restarting it over a file (`--db=sqlite://…`) or
 * a Postgres costs no match in progress: every window reconnects to its seat.
 * The default, `:memory:`, has nothing to take up.
 *
 * `--tiles` serves `/tiles/{z}/{x}/{y}.mvt` from a local PMTiles archive, as
 * the Worker does from R2 (`scripts/build-planet-tiles.ts` makes one); without
 * it the server has no tile route.
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
import { blobSource, tileHandler } from '../src/server/Tiles'
import { BUILD_ID, PROTOCOL_VERSION } from '../src/version'

const arg = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

const port = Number(arg('port') ?? 5174)
const databaseUrl = arg('db') ?? process.env.TICTAC_DB ?? ':memory:'
const party: RelyingParty = {
  id: arg('rp-id') ?? 'localhost',
  origins: (arg('origins') ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()),
}

const tilesPath = arg('tiles')
if (tilesPath && !(await Bun.file(tilesPath).exists())) {
  console.error(`[referee] no tile archive at ${tilesPath}`)
  process.exit(1)
}
const tiles = tilesPath ? tileHandler(blobSource(Bun.file(tilesPath), tilesPath)) : undefined

const persistence = await openPersistence(databaseUrl, party)
const server = await startGameServer({ persistence, port, tiles })

console.info(`[referee] watching on ${server.url} — build ${BUILD_ID}, protocol ${PROTOCOL_VERSION}`)
console.info(`[referee] database: ${databaseUrl}`)
console.info(`[referee] passkeys for ${party.id}, from ${party.origins.join(', ')}`)
console.info(`[referee] map tiles: ${tilesPath ?? 'none (--tiles=<archive.pmtiles>)'}`)

process.on('SIGINT', () => {
  void (async () => {
    await server.stop()
    await persistence.close()
    process.exit(0)
  })()
})
