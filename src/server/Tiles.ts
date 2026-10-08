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
 * (`[ITEM-061]`, `docs/architecture/deployment.md` §6).
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

export function tileHandler(source: Source): TileHandler {
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

  async function tile(z: number, x: number, y: number, signal: AbortSignal): Promise<{ header: Header; bytes: RangeResponse | null }> {
    try {
      return { bytes: await locate(z, x, y, signal), header: await cache.getHeader(source) }
    } catch (error) {
      if (!(error instanceof EtagMismatch)) throw error
      // The archive changed under the cached header: forget it and look again, once.
      await cache.invalidate(source)
      return { bytes: await locate(z, x, y, signal), header: await cache.getHeader(source) }
    }
  }

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

    const match = TILE_PATH.exec(path)
    if (!match) return plain(404, 'not a tile: expected /tiles/{z}/{x}/{y}.mvt')
    const [z, x, y] = [Number(match[1]), Number(match[2]), Number(match[3])]
    const side = 2 ** z
    if (x >= side || y >= side) return plain(400, `tile ${z}/${x}/${y} is outside the world`)

    // Past the archive's zoom cap, or nothing drawn there: MapLibre draws it empty.
    const { header, bytes } = await tile(z, x, y, request.signal)
    if (!bytes) {
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': CACHE_CONTROL, 'Access-Control-Allow-Origin': '*' },
      })
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/vnd.mapbox-vector-tile',
      'Cache-Control': CACHE_CONTROL,
      'Access-Control-Allow-Origin': '*',
    }
    const encoding = CONTENT_ENCODING[header.tileCompression]
    if (encoding) headers['Content-Encoding'] = encoding
    // `encodeBody: 'manual'` tells the Worker runtime the body is already
    // encoded as the header says; without it, it would gzip the gzip. Bun
    // ignores the field and sends the bytes as given.
    const init: ResponseInit & { encodeBody?: 'manual' } = { headers, encodeBody: 'manual' }
    return new Response(request.method === 'HEAD' ? null : bytes.data, init)
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
