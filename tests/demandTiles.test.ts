import { describe, expect, test } from 'bun:test'
import { EtagMismatch, type Source } from 'pmtiles'
import {
  blobSource,
  type DemandTiles,
  demandPrefix,
  httpSource,
  r2TileStore,
  type TileStore,
  type TileStoreBucket,
  tileHandler,
} from '../src/server/Tiles'
import { type TestTile, writePmtiles } from './support/pmtilesWriter'

/**
 * Tiles past the archive's zoom cap (`src/server/Tiles.ts`, `[ITEM-067]`):
 * built from the planet the first time they are looked at, kept, and served
 * from what was kept after that.
 *
 * The "planet" is a small archive made in memory with tiles at the zooms that
 * matter — below the cap, past it, and at the deepest one built.
 */

const text = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s)
const tile = (z: number, x: number, y: number): TestTile => ({ z, x, y, data: text(`tile ${z}/${x}/${y}`) })

const PLANET = writePmtiles([
  tile(0, 0, 0),
  tile(8, 134, 88),
  tile(9, 268, 176),
  tile(12, 2144, 1408),
  tile(14, 8576, 5632),
])
/** What the Worker's own archive holds: the planet's tiles to zoom 8. */
const ARCHIVE = writePmtiles([tile(0, 0, 0), tile(8, 134, 88)])

const get = (path: string, method = 'GET') => new Request(`https://tiles.test${path}`, { method })

function counting(source: Source): Source & { reads: number; failing: boolean } {
  const counted = {
    reads: 0,
    failing: false,
    getKey: () => source.getKey(),
    getBytes: async (offset: number, length: number, signal?: AbortSignal, etag?: string) => {
      counted.reads++
      if (counted.failing) throw new Error('the planet is unreachable')
      return source.getBytes(offset, length, signal, etag)
    },
  }
  return counted
}

function memoryStore(): TileStore & { kept: Map<string, { data: ArrayBuffer; encoding: string | null }>; refusing: boolean } {
  const store = {
    kept: new Map<string, { data: ArrayBuffer; encoding: string | null }>(),
    refusing: false,
    get: async (key: string) => store.kept.get(key) ?? null,
    put: async (key: string, data: ArrayBuffer, encoding: string | null) => {
      if (store.refusing) throw new Error('the store is full')
      store.kept.set(key, { data, encoding })
    },
  }
  return store
}

function setup(over: Partial<DemandTiles> = {}) {
  const planet = counting(blobSource(new Blob([PLANET]), 'planet'))
  const archive = counting(blobSource(new Blob([ARCHIVE]), 'archive'))
  const store = memoryStore()
  const handler = tileHandler(archive, { source: planet, store, prefix: 'demand/20261007/', maxZoom: 14, ...over })
  return { planet, archive, store, handler }
}

const gunzip = async (response: Response | null) => new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response!.arrayBuffer())))

describe('A tile past the archive', () => {
  test('is built from the planet the first time, served as the planet stores it, and kept', async () => {
    const { handler, store, planet } = setup()
    const response = await handler(get('/tiles/12/2144/1408.mvt'))

    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-encoding')).toBe('gzip')
    expect(response?.headers.get('access-control-allow-origin')).toBe('*')
    expect(await gunzip(response)).toBe('tile 12/2144/1408')
    expect(planet.reads).toBeGreaterThan(0)
    // Kept as the bytes it was served as, under a key that names the build.
    expect([...store.kept.keys()]).toEqual(['demand/20261007/12/2144/1408.mvt'])
    expect(store.kept.get('demand/20261007/12/2144/1408.mvt')?.encoding).toBe('gzip')
  })

  test('is served from what was kept the second time, without asking the planet', async () => {
    const { handler, planet } = setup()
    await handler(get('/tiles/12/2144/1408.mvt'))
    const reads = planet.reads

    const again = await handler(get('/tiles/12/2144/1408.mvt'))
    expect(await gunzip(again)).toBe('tile 12/2144/1408')
    expect(again?.headers.get('content-encoding')).toBe('gzip')
    expect(planet.reads).toBe(reads)
  })

  test('that the planet does not have is kept as nothing, and is not asked for twice', async () => {
    const { handler, planet, store } = setup()
    const first = await handler(get('/tiles/10/540/352.mvt'))
    expect(first?.status).toBe(204)
    expect(store.kept.get('demand/20261007/10/540/352.mvt')?.data.byteLength).toBe(0)
    const reads = planet.reads

    expect((await handler(get('/tiles/10/540/352.mvt')))?.status).toBe(204)
    expect(planet.reads).toBe(reads)
  })

  test('is built for a HEAD too, with no body', async () => {
    const { handler, store } = setup()
    const response = await handler(get('/tiles/14/8576/5632.mvt', 'HEAD'))
    expect(response?.status).toBe(200)
    expect(await response!.arrayBuffer()).toHaveProperty('byteLength', 0)
    expect(store.kept.size).toBe(1)
  })

  test('past the deepest zoom built is empty, and costs nothing', async () => {
    const { handler, planet, store } = setup()
    expect((await handler(get('/tiles/15/17152/11264.mvt')))?.status).toBe(204)
    expect(planet.reads).toBe(0)
    expect(store.kept.size).toBe(0)
  })

  test('requested by several at once is the same bytes under one key', async () => {
    const { handler, store } = setup()
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => handler(get('/tiles/12/2144/1408.mvt'))),
    )
    for (const answer of answers) expect(await gunzip(answer)).toBe('tile 12/2144/1408')
    expect(store.kept.size).toBe(1)
  })
})

describe('A tile within the archive', () => {
  test('is the archive\'s, and never reaches the planet or the store', async () => {
    const { handler, planet, store } = setup()
    const response = await handler(get('/tiles/8/134/88.mvt'))
    expect(await gunzip(response)).toBe('tile 8/134/88')
    expect(planet.reads).toBe(0)
    expect(store.kept.size).toBe(0)
  })
})

describe('Building is limited, and fails without poisoning anything', () => {
  test('a client over its limit is told to wait, and nothing is built or kept', async () => {
    const { handler, planet, store } = setup({ allow: async () => false })
    const response = await handler(get('/tiles/12/2144/1408.mvt'))
    expect(response?.status).toBe(429)
    expect(response?.headers.get('retry-after')).toBe('30')
    expect(response?.headers.get('cache-control')).toBe('no-store')
    expect(planet.reads).toBe(0)
    expect(store.kept.size).toBe(0)
  })

  test('is asked only for a tile that has to be built, not for one already kept', async () => {
    let asked = 0
    const { handler } = setup({ allow: async () => (asked++, true) })
    await handler(get('/tiles/12/2144/1408.mvt'))
    await handler(get('/tiles/12/2144/1408.mvt'))
    await handler(get('/tiles/8/134/88.mvt'))
    expect(asked).toBe(1)
  })

  test('a planet that cannot be reached is a 503 that is not cached, nothing kept, and the next try builds', async () => {
    const { handler, planet, store } = setup()
    planet.failing = true
    const down = await handler(get('/tiles/12/2144/1408.mvt'))
    expect(down?.status).toBe(503)
    expect(down?.headers.get('cache-control')).toBe('no-store')
    expect(store.kept.size).toBe(0)

    planet.failing = false
    expect((await handler(get('/tiles/12/2144/1408.mvt')))?.status).toBe(200)
    expect(store.kept.size).toBe(1)
  })

  test('a store that will not keep it still serves the tile', async () => {
    const { handler, store } = setup()
    store.refusing = true
    const response = await handler(get('/tiles/12/2144/1408.mvt'))
    expect(await gunzip(response)).toBe('tile 12/2144/1408')
  })
})

describe('What the server says it serves', () => {
  test('is the deepest zoom it builds, at the origin the request came to', async () => {
    const { handler } = setup()
    const response = await handler(get('/tiles/tiles.json'))
    expect(response?.headers.get('content-type')).toBe('application/json')
    expect(response?.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response!.json()).toMatchObject({
      tilejson: '3.0.0',
      tiles: ['https://tiles.test/tiles/{z}/{x}/{y}.mvt'],
      minzoom: 0,
      maxzoom: 14,
    })
  })

  test('with no planet to build from, is the archive\'s own cap', async () => {
    const handler = tileHandler(blobSource(new Blob([ARCHIVE]), 'archive'))
    expect(await (await handler(get('/tiles/tiles.json')))!.json()).toMatchObject({ maxzoom: 8 })
  })
})

describe('The planet over HTTP', () => {
  const planetBytes = PLANET
  function server(status = 206, etag = '"v1"') {
    const seen: { range: string | null; ifMatch: string | null }[] = []
    const fetcher = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      seen.push({ range: headers.get('range'), ifMatch: headers.get('if-match') })
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(headers.get('range') ?? '')!
      return new Response(planetBytes.slice(Number(from), Number(to) + 1), { status, headers: { etag } })
    }) as unknown as typeof fetch
    return { fetcher, seen }
  }

  test('asks for exactly the range, with the etag it was told to hold, and reports the etag it got', async () => {
    const { fetcher, seen } = server()
    const result = await httpSource('https://planet.test/20261007.pmtiles', fetcher).getBytes(7, 4, undefined, '"v1"')
    expect(new Uint8Array(result.data)).toEqual(PLANET.slice(7, 11))
    expect(result.etag).toBe('"v1"')
    expect(seen).toEqual([{ range: 'bytes=7-10', ifMatch: '"v1"' }])
  })

  test('refuses a server that sent the whole file, and says the archive changed when it did', async () => {
    await expect(httpSource('https://planet.test/x.pmtiles', server(200).fetcher).getBytes(0, 8)).rejects.toThrow(
      'answered 200',
    )
    await expect(httpSource('https://planet.test/x.pmtiles', server(412).fetcher).getBytes(0, 8, undefined, '"v1"')).rejects.toBeInstanceOf(
      EtagMismatch,
    )
  })

  test('is a planet the tile handler can read tiles from', async () => {
    const { fetcher } = server()
    const handler = tileHandler(blobSource(new Blob([ARCHIVE]), 'archive'), {
      source: httpSource('https://planet.test/20261007.pmtiles', fetcher),
      store: memoryStore(),
      prefix: demandPrefix('https://planet.test/20261007.pmtiles'),
      maxZoom: 14,
    })
    expect(await gunzip(await handler(get('/tiles/14/8576/5632.mvt')))).toBe('tile 14/8576/5632')
  })
})

describe('Where tiles are kept', () => {
  test('a key is named for the build, so a new build cannot read the old one\'s tiles', () => {
    expect(demandPrefix('https://build.protomaps.com/20261007.pmtiles')).toBe('demand/20261007/')
    expect(demandPrefix('https://example.org/maps/planet-b.pmtiles')).toBe('demand/planet-b/')
  })

  test('an R2 object keeps the tile\'s bytes and its encoding', async () => {
    const objects = new Map<string, { data: ArrayBuffer; contentEncoding?: string }>()
    const bucket: TileStoreBucket = {
      get: async (key) => {
        const object = objects.get(key)
        return object ? { arrayBuffer: async () => object.data, httpMetadata: { contentEncoding: object.contentEncoding } } : null
      },
      put: async (key, value, options) => {
        objects.set(key, { data: value, contentEncoding: options.httpMetadata.contentEncoding })
      },
    }
    const store = r2TileStore(bucket)

    expect(await store.get('k')).toBeNull()
    await store.put('k', text('abc').buffer as ArrayBuffer, 'gzip')
    await store.put('empty', new ArrayBuffer(0), null)
    expect(await store.get('k')).toEqual({ data: text('abc').buffer as ArrayBuffer, encoding: 'gzip' })
    expect((await store.get('empty'))?.encoding).toBeNull()
  })
})
