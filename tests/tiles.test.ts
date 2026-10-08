import { describe, expect, test } from 'bun:test'
import { EtagMismatch, PMTiles } from 'pmtiles'
import { blobSource, r2Source, type TileBucket, tileHandler } from '../src/server/Tiles'

/** Zoom 0 of the Protomaps planet build the deployment serves: one tile, the whole world. */
const FIXTURE = new URL('./fixtures/planet-z0-20261007.pmtiles', import.meta.url).pathname
const archive = Bun.file(FIXTURE)
const fromFile = tileHandler(blobSource(archive, FIXTURE))

function get(path: string, method = 'GET'): Request {
  return new Request(`http://tiles.test${path}`, { method })
}

/** A bucket over the fixture's bytes, answering ranges the way R2 does. */
function bucketOver(bytes: Uint8Array, etag = 'fixture'): TileBucket & { reads: number } {
  return {
    reads: 0,
    async get(_key, { range, onlyIf }) {
      this.reads++
      if (onlyIf && onlyIf.etagMatches !== etag) return { etag }
      const slice = bytes.slice(range.offset, range.offset + range.length)
      return { etag, body: new Blob([slice]).stream() }
    },
  }
}

describe('the tile route', () => {
  test('serves a stored tile as stored, gzip-encoded, to any origin', async () => {
    const response = await fromFile(get('/tiles/0/0/0.mvt'))
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toBe('application/vnd.mapbox-vector-tile')
    expect(response?.headers.get('content-encoding')).toBe('gzip')
    expect(response?.headers.get('access-control-allow-origin')).toBe('*')
    expect(response?.headers.get('cache-control')).toContain('max-age=')

    // The bytes are the archive's own tile, still compressed — not inflated
    // and re-deflated on the way through.
    const body = new Uint8Array(await response!.arrayBuffer())
    const tile = await new PMTiles(blobSource(archive, FIXTURE)).getZxy(0, 0, 0)
    expect(Bun.gunzipSync(body)).toEqual(new Uint8Array(tile!.data))
  })

  test('a HEAD carries the headers without the tile', async () => {
    const response = await fromFile(get('/tiles/0/0/0.mvt', 'HEAD'))
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-encoding')).toBe('gzip')
    expect((await response!.arrayBuffer()).byteLength).toBe(0)
  })

  test('a tile past the archive’s zoom cap is absent (204), and still cross-origin', async () => {
    const response = await fromFile(get('/tiles/1/1/0.mvt'))
    expect(response?.status).toBe(204)
    expect(response?.headers.get('access-control-allow-origin')).toBe('*')
    expect((await fromFile(get('/tiles/40/0/0.mvt')))?.status).toBe(204)
  })

  test('a tile outside the world is a bad request', async () => {
    expect((await fromFile(get('/tiles/0/1/0.mvt')))?.status).toBe(400)
    expect((await fromFile(get('/tiles/2/0/4.mvt')))?.status).toBe(400)
  })

  test('anything else under /tiles/ is not found', async () => {
    for (const path of ['/tiles/0/0/0.png', '/tiles/0/0.mvt', '/tiles/a/b/c.mvt', '/tiles/', '/tiles/-1/0/0.mvt']) {
      expect((await fromFile(get(path)))?.status).toBe(404)
    }
  })

  test('paths outside /tiles are left to the host', async () => {
    expect(await fromFile(get('/'))).toBeNull()
    expect(await fromFile(get('/tilesets/0/0/0.mvt'))).toBeNull()
  })

  test('a preflight is answered for any origin; writes are refused', async () => {
    const preflight = await fromFile(get('/tiles/0/0/0.mvt', 'OPTIONS'))
    expect(preflight?.status).toBe(204)
    expect(preflight?.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight?.headers.get('access-control-allow-methods')).toContain('GET')
    expect((await fromFile(get('/tiles/0/0/0.mvt', 'POST')))?.status).toBe(405)
  })
})

describe('the R2 source', () => {
  test('serves the same tile from a bucket as from a file', async () => {
    const bucket = bucketOver(await archive.bytes())
    const fromBucket = tileHandler(r2Source(bucket, 'planet.pmtiles'))
    const [a, b] = await Promise.all([fromBucket(get('/tiles/0/0/0.mvt')), fromFile(get('/tiles/0/0/0.mvt'))])
    expect(new Uint8Array(await a!.arrayBuffer())).toEqual(new Uint8Array(await b!.arrayBuffer()))
  })

  test('an archive replaced under a warm handler is re-read, not mixed with the old one', async () => {
    const bytes = await archive.bytes()
    let etag = 'first'
    const bucket: TileBucket = {
      async get(_key, { range, onlyIf }) {
        if (onlyIf && onlyIf.etagMatches !== etag) return { etag }
        return { etag, body: new Blob([bytes.slice(range.offset, range.offset + range.length)]).stream() }
      },
    }
    const handler = tileHandler(r2Source(bucket, 'planet.pmtiles'))
    expect((await handler(get('/tiles/0/0/0.mvt')))?.status).toBe(200)
    etag = 'second'
    expect((await handler(get('/tiles/0/0/0.mvt')))?.status).toBe(200)
  })

  test('a failed precondition is an etag mismatch', async () => {
    const source = r2Source(bucketOver(new Uint8Array(8), 'now'), 'planet.pmtiles')
    await expect(source.getBytes(0, 4, undefined, 'before')).rejects.toBeInstanceOf(EtagMismatch)
  })

  test('a missing archive says which', async () => {
    const source = r2Source({ get: async () => null }, 'gone.pmtiles')
    await expect(source.getBytes(0, 4)).rejects.toThrow('gone.pmtiles')
  })

  test('an already aborted read never reaches the bucket', async () => {
    const bucket = bucketOver(new Uint8Array(8))
    const source = r2Source(bucket, 'planet.pmtiles')
    const controller = new AbortController()
    controller.abort()
    await expect(source.getBytes(0, 4, controller.signal)).rejects.toThrow()
    expect(bucket.reads).toBe(0)
  })

  test('an abort during the read cancels the body instead of buffering the rest', async () => {
    const controller = new AbortController()
    let cancelled = false
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        pulls++
        stream.enqueue(new Uint8Array(1024))
        // The client goes away after the first chunk of a long range.
        if (pulls === 1) controller.abort()
      },
      cancel() {
        cancelled = true
      },
    })
    const source = r2Source({ get: async () => ({ etag: 'x', body }) }, 'planet.pmtiles')
    const read = source.getBytes(0, 1 << 30, controller.signal)
    await expect(read).rejects.toThrow()
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(4)
  })
})
