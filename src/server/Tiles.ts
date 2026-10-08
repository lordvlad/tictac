import {
  Compression,
  EtagMismatch,
  findTile,
  type Header,
  type RangeResponse,
  ResolvedValueCache,
  type Source,
  zxyToTileId,
} from 'pmtiles'

/**
 * Map tiles at `/tiles/{z}/{x}/{y}.mvt`, read out of one PMTiles archive
 * (`[ITEM-061]`, `docs/architecture/deployment.md` §6) and, past the
 * archive's own zoom cap, pulled from the full planet the first time they are
 * looked at and kept (`[ITEM-067]`, §6.4).
 *
 * The same handler runs on both hosts: the Worker reads the archive from R2
 * (`r2Source`), the Bun server from a local file (`blobSource` over
 * `Bun.file`). Tiles are static content, so the handler needs no game state
 * and answers any origin.
 */

/** What a tile URL may look like; anything else under `/tiles/` is not a tile. */
const TILE_PATH = /^\/tiles\/(\d{1,2})\/(\d{1,10})\/(\d{1,10})\.mvt$/

/**
 * A week. The URL does not name the archive, so a swapped archive reaches a
 * cached client only once this runs out — acceptable for a basemap, where a
 * new build changes little at these zooms.
 */
const CACHE_CONTROL = 'public, max-age=604800'

const CONTENT_ENCODING: Partial<Record<Compression, string>> = {
  [Compression.Gzip]: 'gzip',
  [Compression.Brotli]: 'br',
  [Compression.Zstd]: 'zstd',
}

/**
 * Answers the request if it is for a tile, or `null` so the host can route it
 * elsewhere.
 *
 * Build one per process (per isolate on the Worker) and keep it: it caches the
 * archive's header and directories, which is what keeps a tile to one range
 * read once warm.
 */
export type TileHandler = (request: Request) => Promise<Response | null>

/**
 * The closer zooms the archive does not hold, from the full planet.
 *
 * A tile past the archive's cap is looked up in `store` first; on a miss it is
 * read out of `source` (the planet, by range request: one to three reads, the
 * tile itself and a directory or two), written to `store`, and served. The
 * stored object is the tile's own bytes with its encoding, so a hit is one
 * read and the response is the same as one from the archive. A tile the
 * planet does not have is stored empty, so the question is not asked twice.
 */
export interface DemandTiles {
  /** The full planet (`httpSource`), pinned to one dated build. */
  source: Source
  store: TileStore
  /** Names the build in every stored key, so a new build cannot read the old one's tiles. */
  prefix: string
  /** The deepest zoom that is built; closer ones are stretched by the map. */
  maxZoom: number
  /**
   * Whether this request may cause a build. Asked on a miss only, so a pan
   * over cached ground is never counted. Unset: every miss builds.
   */
  allow?: (request: Request) => Promise<boolean>
}

/** Where a tile was stored: its bytes, and how they are encoded (`Content-Encoding`). */
export interface TileStore {
  get(key: string): Promise<{ data: ArrayBuffer; encoding: string | null } | null>
  put(key: string, data: ArrayBuffer, encoding: string | null): Promise<void>
}

/** How long a planet read may take before it is given up on: a build must not hold a request open. */
const SOURCE_TIMEOUT_MS = 8000

const ATTRIBUTION =
  '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>, <a href="https://protomaps.com">Protomaps</a>'

export function tileHandler(source: Source, demand?: DemandTiles): TileHandler {
  const archive = reader(source)
  const planet = demand ? reader(demand.source) : null

  return async (request) => {
    const path = new URL(request.url).pathname
    if (path !== '/tiles' && !path.startsWith('/tiles/')) return null

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(405, 'tiles are read-only', { Allow: 'GET, HEAD, OPTIONS' })
    }

    if (path === '/tiles/tiles.json') return tileJson(request, archive, demand)

    const match = TILE_PATH.exec(path)
    if (!match) return plain(404, 'not a tile: expected /tiles/{z}/{x}/{y}.mvt')
    const [z, x, y] = [Number(match[1]), Number(match[2]), Number(match[3])]
    const side = 2 ** z
    if (x >= side || y >= side) return plain(400, `tile ${z}/${x}/${y} is outside the world`)

    const header = await archive.header()
    if (demand && planet && z > header.maxZoom) {
      if (z > demand.maxZoom) return empty()
      return demandTile(request, demand, planet, z, x, y)
    }

    // Past the archive's zoom cap, or nothing drawn there: MapLibre draws it empty.
    const { header: found, bytes } = await archive.tile(z, x, y, request.signal)
    if (!bytes) return empty()
    return tileResponse(request.method, bytes.data, CONTENT_ENCODING[found.tileCompression] ?? null)
  }
}

/**
 * What the server serves, so a client does not have to know: the tile url
 * template and the deepest zoom a tile exists at. A host with no on-demand
 * source says the archive's own cap, and the map stretches the rest.
 */
async function tileJson(request: Request, archive: Reader, demand: DemandTiles | undefined): Promise<Response> {
  const header = await archive.header()
  const origin = new URL(request.url).origin
  const body = {
    tilejson: '3.0.0',
    tiles: [`${origin}/tiles/{z}/{x}/{y}.mvt`],
    minzoom: header.minZoom,
    maxzoom: Math.max(header.maxZoom, demand?.maxZoom ?? 0),
    attribution: ATTRIBUTION,
  }
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      // Short: a deploy can move the cap, and this is one small request per map opened.
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

async function demandTile(
  request: Request,
  demand: DemandTiles,
  planet: Reader,
  z: number,
  x: number,
  y: number,
): Promise<Response> {
  const key = `${demand.prefix}${z}/${x}/${y}.mvt`
  const stored = await demand.store.get(key)
  if (stored) return storedResponse(request.method, stored.data, stored.encoding)

  if (demand.allow && !(await demand.allow(request))) {
    return plain(429, 'too many tiles are being built for you right now; try again shortly', {
      'Retry-After': '30',
      'Cache-Control': 'no-store',
    })
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)])
    const { header, bytes } = await planet.tile(z, x, y, signal)
    const data = bytes?.data ?? new ArrayBuffer(0)
    const encoding = bytes ? (CONTENT_ENCODING[header.tileCompression] ?? null) : null
    // Served even if keeping it fails: the next look just builds it again.
    await demand.store.put(key, data, encoding).catch((error: unknown) => {
      console.warn(`[tiles] could not keep ${key}: ${String(error)}`)
    })
    return storedResponse(request.method, data, encoding)
  } catch (error) {
    // Not `204`: a browser would keep an empty tile for a week. The planet is
    // down, slow or has rotated; the map draws the stretched parent until then.
    console.warn(`[tiles] could not build ${key}: ${String(error)}`)
    return plain(503, 'that tile could not be built right now', { 'Retry-After': '30', 'Cache-Control': 'no-store' })
  }
}

/** A stored tile: no bytes means the planet has nothing there. */
function storedResponse(method: string, data: ArrayBuffer, encoding: string | null): Response {
  return data.byteLength === 0 ? empty() : tileResponse(method, data, encoding)
}

function empty(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': CACHE_CONTROL, 'Access-Control-Allow-Origin': '*' },
  })
}

function tileResponse(method: string, data: ArrayBuffer, encoding: string | null): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/vnd.mapbox-vector-tile',
    'Cache-Control': CACHE_CONTROL,
    'Access-Control-Allow-Origin': '*',
  }
  if (encoding) headers['Content-Encoding'] = encoding
  // `encodeBody: 'manual'` tells the Worker runtime the body is already
  // encoded as the header says; without it, it would gzip the gzip. Bun
  // ignores the field and sends the bytes as given.
  const init: ResponseInit & { encodeBody?: 'manual' } = { headers, encodeBody: 'manual' }
  return new Response(method === 'HEAD' ? null : data, init)
}

interface Reader {
  header(): Promise<Header>
  tile(z: number, x: number, y: number, signal: AbortSignal): Promise<{ header: Header; bytes: RangeResponse | null }>
}

/** One archive, read tile by tile; build one per process (per isolate on the Worker) and keep it. */
function reader(source: Source): Reader {
  // Resolved values rather than shared promises: a Worker may not await a
  // promise whose I/O another request started.
  const cache = new ResolvedValueCache()

  async function locate(z: number, x: number, y: number, signal: AbortSignal): Promise<RangeResponse | null> {
    const header = await cache.getHeader(source)
    if (z < header.minZoom || z > header.maxZoom) return null
    const id = zxyToTileId(z, x, y)
    let offset = header.rootDirectoryOffset
    let length = header.rootDirectoryLength
    // The spec bounds a lookup at the root plus three levels of leaves.
    for (let depth = 0; depth <= 3; depth++) {
      const entries = await cache.getDirectory(source, offset, length, header, signal)
      const entry = findTile(entries, id)
      if (!entry) return null
      if (entry.runLength > 0) {
        // Read straight from the source, not through `PMTiles.getZxy`, which
        // would inflate the tile only for the response to deflate it again.
        return source.getBytes(header.tileDataOffset + entry.offset, entry.length, signal, header.etag)
      }
      offset = header.leafDirectoryOffset + entry.offset
      length = entry.length
    }
    throw new Error('the tile archive nests its directories deeper than PMTiles allows')
  }

  return {
    header: () => cache.getHeader(source),
    async tile(z, x, y, signal) {
      try {
        return { bytes: await locate(z, x, y, signal), header: await cache.getHeader(source) }
      } catch (error) {
        if (!(error instanceof EtagMismatch)) throw error
        // The archive changed under the cached header: forget it and look again, once.
        await cache.invalidate(source)
        return { bytes: await locate(z, x, y, signal), header: await cache.getHeader(source) }
      }
    },
  }
}

/**
 * The planet over HTTP, read by range: `build.protomaps.com/<date>.pmtiles`,
 * or any server that answers `Range`. Not `pmtiles`' own `FetchSource`, which
 * passes `cache: 'no-store'`, a fetch option the Worker runtime refuses.
 */
export function httpSource(url: string, fetcher: typeof fetch = fetch): Source {
  return {
    getKey: () => url,
    getBytes: async (offset, length, signal, etag) => {
      const headers: Record<string, string> = { Range: `bytes=${offset}-${offset + length - 1}` }
      if (etag) headers['If-Match'] = etag
      const response = await fetcher(url, { headers, signal })
      if (response.status === 412) throw new EtagMismatch()
      // A `200` is a server that ignored `Range`: the whole archive, not a tile.
      if (response.status !== 206) throw new Error(`${url} answered ${response.status} to a range read`)
      return { data: await response.arrayBuffer(), etag: response.headers.get('etag') ?? undefined }
    },
  }
}

/** The stored tiles' key prefix for the planet at `url`: `demand/<build>/`, from `…/<build>.pmtiles`. */
export function demandPrefix(url: string): string {
  const name = new URL(url).pathname.split('/').pop() ?? ''
  return `demand/${name.replace(/\.pmtiles$/, '')}/`
}

/** The part of an R2 bucket binding the tile store uses; `R2Bucket` satisfies it. */
export interface TileStoreBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentEncoding?: string } } | null>
  put(key: string, value: ArrayBuffer, options: { httpMetadata: { contentEncoding?: string } }): Promise<unknown>
}

/** Tiles kept as R2 objects, each with its own encoding. */
export function r2TileStore(bucket: TileStoreBucket): TileStore {
  return {
    async get(key) {
      const object = await bucket.get(key)
      if (!object) return null
      return { data: await object.arrayBuffer(), encoding: object.httpMetadata?.contentEncoding ?? null }
    },
    async put(key, data, encoding) {
      await bucket.put(key, data, { httpMetadata: encoding ? { contentEncoding: encoding } : {} })
    },
  }
}

function plain(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...extra },
  })
}

/**
 * An archive held in a `Blob` — on the Bun server, `Bun.file(path)`, which
 * reads only the slice asked for. Taking the `Blob` rather than a path keeps
 * this module free of `Bun` so the Worker can import it too.
 */
export function blobSource(blob: Blob, key: string): Source {
  return {
    getKey: () => key,
    getBytes: async (offset, length, signal) => {
      signal?.throwIfAborted()
      const data = await blob.slice(offset, offset + length).arrayBuffer()
      signal?.throwIfAborted()
      return { data }
    },
  }
}

/**
 * The part of an R2 bucket binding `r2Source` uses — `R2Bucket` satisfies it;
 * a test can too.
 */
export interface TileBucket {
  get(
    key: string,
    options: { range: { offset: number; length: number }; onlyIf?: { etagMatches: string } },
  ): Promise<{ etag: string; body?: ReadableStream<Uint8Array> } | null>
}

/**
 * An archive held as one R2 object, read by range.
 *
 * Ported from the reference (`no-way-home`'s `r2-pmtiles-source.ts`), whose
 * abort check came after the whole range had been fetched and buffered: an
 * aborted request cost exactly what a finished one did. Here an abort before
 * the read skips it, and one during the read cancels the body stream.
 *
 * `R2Bucket.get` takes no signal, so the object's metadata round trip is the
 * one part an abort cannot cut short.
 */
export function r2Source(bucket: TileBucket, key: string): Source {
  return {
    getKey: () => key,
    getBytes: async (offset, length, signal, etag) => {
      signal?.throwIfAborted()
      const object = await bucket.get(key, {
        range: { offset, length },
        // R2 answers a failed precondition with the object's metadata and no body.
        onlyIf: etag ? { etagMatches: etag } : undefined,
      })
      if (!object) throw new Error(`the tile archive ${key} is not in the bucket`)
      if (!object.body) throw new EtagMismatch()
      return { data: await readAll(object.body, signal), etag: object.etag }
    },
  }
}

async function readAll(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): Promise<ArrayBuffer> {
  if (signal?.aborted) {
    await body.cancel(signal.reason)
    signal.throwIfAborted()
  }
  const reader = body.getReader()
  const stop = (): void => {
    reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', stop, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    signal?.removeEventListener('abort', stop)
  }
  // A cancelled reader ends like a finished one; only the signal tells them apart.
  signal?.throwIfAborted()
  // One chunk that is its whole buffer — the usual case for a tile — needs no copy.
  const [only] = chunks
  if (chunks.length === 1 && only && only.byteOffset === 0 && only.byteLength === only.buffer.byteLength) {
    return only.buffer as ArrayBuffer
  }
  const data = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    data.set(chunk, at)
    at += chunk.byteLength
  }
  return data.buffer
}
