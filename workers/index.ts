import { MATCH_SERVER } from '../src/server/Owner'
import { relatedOriginsHandler } from '../src/server/RelatedOrigins'
import { MAP_TILE_MAX_ZOOM } from '../src/config'
import {
  type DemandTiles,
  demandPrefix,
  httpSource,
  r2Source,
  r2TileStore,
  type TileHandler,
  tileHandler,
} from '../src/server/Tiles'
import { type MatchDurableObject, relyingPartyOf } from './MatchDurableObject'

export interface Env {
  MATCH: DurableObjectNamespace<MatchDurableObject>
  ASSETS: Fetcher
  /** The `map-tiles` bucket: the planet's PMTiles archive (`[ITEM-061]`). */
  MAP_TILES: R2Bucket
  /** Which object in `MAP_TILES` is the archive, so a new build is a config change, not a code change. */
  MAP_TILES_KEY: string
  /**
   * The full planet's archive, for the zooms `MAP_TILES_KEY` stops short of
   * (`[ITEM-067]`): one dated Protomaps build, which must be the build the
   * archive was cut from. Unset, nothing past the archive's cap is built.
   */
  MAP_SOURCE_URL?: string
  /** Caps how many tiles one client may cause to be built per minute; unset (local dev), no cap. */
  TILE_BUILDS?: RateLimit
  /** The domain a real deploy's passkeys are bound to. Unset until one is chosen. */
  RELYING_PARTY_ID?: string
  /**
   * Comma-separated origins the passkey ceremony checks against, and which
   * `/.well-known/webauthn` lends the relying party id to.
   */
  RELYING_PARTY_ORIGINS?: string
}

/**
 * Per isolate, so the archive's header and directories are read once and
 * every warm tile costs one R2 range read.
 */
let tiles: TileHandler | undefined

function demandOf(env: Env): DemandTiles | undefined {
  const limiter = env.TILE_BUILDS
  if (!env.MAP_SOURCE_URL) return undefined
  return {
    source: httpSource(env.MAP_SOURCE_URL),
    store: r2TileStore(env.MAP_TILES),
    prefix: demandPrefix(env.MAP_SOURCE_URL),
    maxZoom: MAP_TILE_MAX_ZOOM,
    allow: limiter
      ? async (request) => (await limiter.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' })).success
      : undefined,
  }
}
let relatedOrigins: ((request: Request) => Response | undefined) | undefined

/**
 * The Worker is a router with two destinations.
 *
 * Map tiles (`/tiles/{z}/{x}/{y}.mvt`) are answered here: they need no game
 * state, and a tile request — a map pan fires dozens — should neither wake the
 * Durable Object nor queue behind its sockets. So is `/.well-known/webauthn`,
 * which is config alone: it is what lets the GitHub Pages client use passkeys
 * bound to this host (`src/server/RelatedOrigins.ts`).
 *
 * Everything else — a page load, an asset, a WebSocket upgrade — is forwarded
 * to the same Durable Object instance (`MATCH_SERVER`, `src/server/Owner.ts`)
 * rather than one derived from the request. `[ITEM-045]` plants a single DO on purpose:
 * a match server is one lobby of rooms, so there is one of it, the same way
 * `startGameServer` binds one port to one `Lobby` today.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    tiles ??= tileHandler(r2Source(env.MAP_TILES, env.MAP_TILES_KEY), demandOf(env))
    const tile = await tiles(request)
    if (tile) return tile
    relatedOrigins ??= relatedOriginsHandler(relyingPartyOf(env))
    const related = relatedOrigins(request)
    if (related) return related
    const id = env.MATCH.idFromName(MATCH_SERVER)
    const stub = env.MATCH.get(id)
    return stub.fetch(request)
  },
} satisfies ExportedHandler<Env>

export { MatchDurableObject } from './MatchDurableObject'
