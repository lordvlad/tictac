import { zxyToTileId } from 'pmtiles'

/**
 * A PMTiles v3 archive made in memory, so a test can have a planet with tiles
 * at any zoom without a fixture file or the Go CLI. One root directory, no
 * leaves, nothing compressed but the tiles (gzip, as Protomaps' are) — which
 * is all the reader needs to find a tile and say how it is encoded.
 * Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */

export interface TestTile {
  z: number
  x: number
  y: number
  /** The tile's decoded bytes; stored gzipped. */
  data: Uint8Array<ArrayBuffer>
}

function varint(value: number): number[] {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return bytes
}

export function writePmtiles(tiles: TestTile[]): Uint8Array<ArrayBuffer> {
  const sorted = tiles
    .map((tile) => ({ id: zxyToTileId(tile.z, tile.x, tile.y), body: Bun.gzipSync(tile.data) }))
    .sort((a, b) => a.id - b.id)

  let offset = 0
  const entries = sorted.map((tile) => {
    const entry = { id: tile.id, offset, length: tile.body.length }
    offset += tile.body.length
    return entry
  })

  const directory: number[] = [...varint(entries.length)]
  let previous = 0
  for (const entry of entries) {
    directory.push(...varint(entry.id - previous))
    previous = entry.id
  }
  for (let i = 0; i < entries.length; i++) directory.push(...varint(1))
  for (const entry of entries) directory.push(...varint(entry.length))
  entries.forEach((entry, i) => {
    const before = entries[i - 1]
    // Offsets are stored plus one; zero means "straight after the one before".
    directory.push(...varint(before && entry.offset === before.offset + before.length ? 0 : entry.offset + 1))
  })

  const metadata = new TextEncoder().encode('{}')
  const rootOffset = 127
  const metadataOffset = rootOffset + directory.length
  const dataOffset = metadataOffset + metadata.length
  const zooms = tiles.map((tile) => tile.z)

  const out = new Uint8Array(dataOffset + offset)
  const view = new DataView(out.buffer)
  out.set(new TextEncoder().encode('PMTiles'), 0)
  out[7] = 3
  const u64 = (at: number, value: number) => view.setBigUint64(at, BigInt(value), true)
  u64(8, rootOffset)
  u64(16, directory.length)
  u64(24, metadataOffset)
  u64(32, metadata.length)
  u64(40, dataOffset) // leaf directories: none
  u64(48, 0)
  u64(56, dataOffset)
  u64(64, offset)
  u64(72, entries.length)
  u64(80, entries.length)
  u64(88, entries.length)
  out[96] = 1 // clustered
  out[97] = 1 // internal compression: none
  out[98] = 2 // tile compression: gzip
  out[99] = 1 // tile type: mvt
  out[100] = Math.min(...zooms)
  out[101] = Math.max(...zooms)
  view.setInt32(102, -1_800_000_000, true)
  view.setInt32(106, -850_000_000, true)
  view.setInt32(110, 1_800_000_000, true)
  view.setInt32(114, 850_000_000, true)
  out.set(directory, rootOffset)
  out.set(metadata, metadataOffset)
  let at = dataOffset
  for (const tile of sorted) {
    out.set(tile.body, at)
    at += tile.body.length
  }
  return out
}
