import { MATCH_SERVER } from '../src/server/Owner'
import { r2Source, type TileHandler, tileHandler } from '../src/server/Tiles'
import type { MatchDurableObject } from './MatchDurableObject'

export interface Env {
  MATCH: DurableObjectNamespace<MatchDurableObject>
  ASSETS: Fetcher
  /** The `map-tiles` bucket: the planet's PMTiles archive (`[ITEM-061]`). */
  MAP_TILES: R2Bucket
  /** Which object in `MAP_TILES` is the archive, so a new build is a config change, not a code change. */
  MAP_TILES_KEY: string
  /** The domain a real deploy's passkeys are bound to. Unset until one is chosen. */
  RELYING_PARTY_ID?: string
  /** Comma-separated origins the passkey ceremony checks against. */
  RELYING_PARTY_ORIGINS?: string
}

/**
 * Per isolate, so the archive's header and directories are read once and
 * every warm tile costs one R2 range read.
 */
let tiles: TileHandler | undefined

/**
 * The Worker is a router with two destinations.
 *
 * Map tiles (`/tiles/{z}/{x}/{y}.mvt`) are answered here: they need no game
 * state, and a tile request — a map pan fires dozens — should neither wake the
 * Durable Object nor queue behind its sockets.
 *
 * Everything else — a page load, an asset, a WebSocket upgrade — is forwarded
 * to the same Durable Object instance (`MATCH_SERVER`, `src/server/Owner.ts`)
 * rather than one derived from the request. `[ITEM-045]` plants a single DO on purpose:
 * a match server is one lobby of rooms, so there is one of it, the same way
 * `startGameServer` binds one port to one `Lobby` today.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    tiles ??= tileHandler(r2Source(env.MAP_TILES, env.MAP_TILES_KEY))
    const tile = await tiles(request)
    if (tile) return tile
    const id = env.MATCH.idFromName(MATCH_SERVER)
    const stub = env.MATCH.get(id)
    return stub.fetch(request)
  },
} satisfies ExportedHandler<Env>

export { MatchDurableObject } from './MatchDurableObject'
