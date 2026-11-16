import { REGIONS, regionMap } from '../src/server/Owner'
import { DEFAULT_ANCHOR } from '../src/server/Squads'
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
import { type MatchDurableObject, placeOf, relyingPartyOf } from './MatchDurableObject'

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
  /**
   * The trial switch for squads of different players meeting on the road
   * (`ITEM-053`, GDD-WORLD §5.5): `off` stops every meeting from the next
   * check on, anything else (unset included) allows them.
   */
  PLAYER_ENCOUNTERS?: string
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

/**
 * The same partition table every region's own directory is built from
 * (`REGIONS`, `src/server/Owner.ts`). The Worker has no database, so it asks
 * only the half of it that is a function of a place; who keeps a given squad
 * is the region's own committed row, which a Worker cannot read.
 */
const regions = regionMap(REGIONS)
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
 * to the Durable Object of the region the connection starts in: the one
 * `regions` says owns where Cloudflare placed it (or `DEFAULT_ANCHOR`, where
 * a squad is placed when nothing is known). There is one region today
 * (`[ITEM-045]`), so that is always the same instance: a match server is one
 * lobby of rooms, the same way `startGameServer` binds one port to one `Lobby`.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    tiles ??= tileHandler(r2Source(env.MAP_TILES, env.MAP_TILES_KEY), demandOf(env))
    const tile = await tiles(request)
    if (tile) return tile
    relatedOrigins ??= relatedOriginsHandler(relyingPartyOf(env))
    const related = relatedOrigins(request)
    if (related) return related
    const id = env.MATCH.idFromName(regions.ownerOfPlace(placeOf(request.cf) ?? DEFAULT_ANCHOR))
    const stub = env.MATCH.get(id)
    return stub.fetch(request)
  },
} satisfies ExportedHandler<Env>

export { MatchDurableObject } from './MatchDurableObject'
