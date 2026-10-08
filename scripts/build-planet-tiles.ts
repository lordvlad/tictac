/**
 * Build the planet's map archive and put it in R2 (`[ITEM-061]`,
 * docs/architecture/deployment.md §6).
 *
 *   bun scripts/build-planet-tiles.ts [--build=20261007] [--maxzoom=8]
 *     [--pmtiles=<path to the pmtiles CLI>] [--out=<dir>] [--force]
 *
 * 1. `pmtiles extract` cuts zooms 0..maxzoom out of a Protomaps daily build.
 *    It reads the 138 GB planet by range requests, so only the extract
 *    (558 MB for z0–8) is ever downloaded. An archive already at the output
 *    path is reused.
 * 2. The archive's own header is checked: the whole planet, z0 to the cap.
 * 3. It is streamed to the `map-tiles` bucket through R2's S3 API as a
 *    multipart upload — a failed part is retried on its own, and memory is
 *    bounded by the parts in flight, not the archive. The key names what it
 *    holds (`planet-z8-20261007.pmtiles`); nothing is overwritten unless
 *    `--force`, and the Worker serves whichever key `MAP_TILES_KEY` in
 *    `wrangler.jsonc` names, so switching builds is a config change.
 *
 * The CLI is https://github.com/protomaps/go-pmtiles (a single binary); the
 * credentials are `R2_S3_API`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`
 * from `.env`, which Bun loads by itself.
 */
import { S3Client, spawn } from 'bun'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { blobSource } from '../src/server/Tiles'
import { PMTiles } from 'pmtiles'

const BUCKET = 'map-tiles'
const PART_SIZE = 16 * 1024 * 1024

const { values } = parseArgs({
  options: {
    build: { type: 'string', default: '20261007' },
    maxzoom: { type: 'string', default: '8' },
    pmtiles: { type: 'string', default: 'pmtiles' },
    out: { type: 'string', default: 'out/tiles' },
    force: { type: 'boolean', default: false },
  },
})

const maxZoom = Number(values.maxzoom)
if (!/^\d{8}$/.test(values.build) || !Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > 15) {
  console.error('[tiles] --build is a Protomaps build date (YYYYMMDD) and --maxzoom a zoom from 0 to 15')
  process.exit(1)
}

const key = `planet-z${maxZoom}-${values.build}.pmtiles`
const path = join(values.out, key)
const archive = Bun.file(path)

if (await archive.exists()) {
  console.info(`[tiles] reusing ${path}`)
} else {
  await mkdir(values.out, { recursive: true })
  const url = `https://build.protomaps.com/${values.build}.pmtiles`
  console.info(`[tiles] extracting z0–${maxZoom} of ${url}`)
  const extract = spawn([values.pmtiles, 'extract', url, path, `--maxzoom=${maxZoom}`], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await extract.exited) !== 0) {
    console.error('[tiles] pmtiles extract failed')
    process.exit(1)
  }
}

const header = await new PMTiles(blobSource(archive, path)).getHeader()
const planet = header.minLon <= -179.9 && header.maxLon >= 179.9 && header.minLat <= -85 && header.maxLat >= 85
if (header.minZoom !== 0 || header.maxZoom !== maxZoom || !planet) {
  console.error(
    `[tiles] ${path} is not the planet at z0–${maxZoom}: z${header.minZoom}–${header.maxZoom}, ` +
      `lon ${header.minLon}..${header.maxLon}, lat ${header.minLat}..${header.maxLat}`,
  )
  process.exit(1)
}
console.info(`[tiles] ${path}: ${archive.size} bytes, z0–${maxZoom}, ${header.numAddressedTiles} tiles`)

const endpoint = process.env.R2_S3_API
const accessKeyId = process.env.R2_ACCESS_KEY_ID
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
if (!endpoint || !accessKeyId || !secretAccessKey) {
  console.error('[tiles] R2_S3_API, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set (see .env)')
  process.exit(1)
}
const bucket = new S3Client({ endpoint, accessKeyId, secretAccessKey, bucket: BUCKET })
const object = bucket.file(key)

if (!values.force && (await object.exists())) {
  const { size, etag } = await bucket.stat(key)
  if (size !== archive.size) {
    console.error(`[tiles] ${BUCKET}/${key} exists with ${size} bytes, not ${archive.size}; --force replaces it`)
    process.exit(1)
  }
  console.info(`[tiles] ${BUCKET}/${key} is already there: ${size} bytes, etag ${etag}`)
  process.exit(0)
}

console.info(`[tiles] uploading to ${BUCKET}/${key} in ${PART_SIZE / 1024 / 1024} MB parts`)
const writer = object.writer({ type: 'application/vnd.pmtiles', partSize: PART_SIZE, queueSize: 4, retry: 3 })
let sent = 0
let flushedAt = 0
for await (const chunk of archive.stream()) {
  await writer.write(chunk)
  sent += chunk.byteLength
  // Waiting on a flush every part is the back-pressure: it keeps the parts in
  // flight, not the whole archive, in memory.
  if (sent - flushedAt >= PART_SIZE) {
    await writer.flush()
    flushedAt = sent
    process.stdout.write(`\r[tiles] ${((100 * sent) / archive.size).toFixed(0)}%`)
  }
}
await writer.end()
process.stdout.write('\n')

const { size, etag } = await bucket.stat(key)
if (size !== archive.size) {
  console.error(`[tiles] ${BUCKET}/${key} holds ${size} bytes after the upload, not ${archive.size}`)
  process.exit(1)
}
console.info(`[tiles] ${BUCKET}/${key}: ${size} bytes, etag ${etag}`)
