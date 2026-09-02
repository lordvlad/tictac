import { describe, expect, test } from 'bun:test'
import { createLadderWallGeometry, createSteppedStairGeometry } from '../src/render/Blocks'
import { LEVEL_HEIGHT } from '../src/config'

interface Triangle {
  /** Face normal, from the winding order. */
  normal: { x: number; y: number; z: number }
  /** Lowest and highest corner, to tell a tread from the underside. */
  minY: number
  maxY: number
  minZ: number
  maxZ: number
  area: number
}

/**
 * Face normals derived from vertex order, exactly as the GPU derives facing.
 *
 * A backwards face is invisible from one side and shows the inside of the
 * solid from the other, so winding is worth asserting rather than eyeballing.
 */
function triangles(positions: Float32Array): Triangle[] {
  const out: Triangle[] = []
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i]!, ay = positions[i + 1]!, az = positions[i + 2]!
    const bx = positions[i + 3]!, by = positions[i + 4]!, bz = positions[i + 5]!
    const cx = positions[i + 6]!, cy = positions[i + 7]!, cz = positions[i + 8]!

    const abx = bx - ax, aby = by - ay, abz = bz - az
    const acx = cx - ax, acy = cy - ay, acz = cz - az

    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    const length = Math.hypot(nx, ny, nz)

    out.push({
      normal: { x: nx / length, y: ny / length, z: nz / length },
      minY: Math.min(ay, by, cy),
      maxY: Math.max(ay, by, cy),
      minZ: Math.min(az, bz, cz),
      maxZ: Math.max(az, bz, cz),
      area: length / 2,
    })
  }
  return out
}

function positionsOf(geometry: { getAttribute(name: string): { array: ArrayLike<number> } }): Float32Array {
  return geometry.getAttribute('position').array as Float32Array
}

describe('Stepped stair geometry', () => {
  const geometry = createSteppedStairGeometry(4)
  const tris = triangles(positionsOf(geometry))
  const floorY = LEVEL_HEIGHT / -2

  test('is built from non-degenerate triangles', () => {
    expect(tris.length).toBeGreaterThan(0)
    for (const tri of tris) expect(tri.area).toBeGreaterThan(0)
  })

  test('every face is axis aligned', () => {
    for (const { normal } of tris) {
      const axes = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)]
      expect(Math.max(...axes)).toBeCloseTo(1, 5)
    }
  })

  test('treads face up, so the flight reads as steps from above', () => {
    const horizontal = tris.filter((t) => Math.abs(t.normal.y) > 0.9)
    const treads = horizontal.filter((t) => t.minY > floorY + 1e-6)

    // Two triangles per tread, four treads.
    expect(treads.length).toBe(8)
    for (const tread of treads) expect(tread.normal.y).toBeCloseTo(1, 5)
  })

  test('the only downward face is the underside', () => {
    const downward = tris.filter((t) => t.normal.y < -0.9)
    expect(downward.length).toBe(2)
    for (const face of downward) expect(face.maxY).toBeCloseTo(floorY, 5)
  })

  test('risers face the approach, not into the solid', () => {
    const risers = tris.filter((t) => Math.abs(t.normal.z) > 0.9 && t.maxZ < LEVEL_HEIGHT)
    const backward = risers.filter((t) => t.normal.z < -0.9)
    expect(backward.length).toBeGreaterThanOrEqual(8)
  })

  test('the back wall faces away from the flight', () => {
    const top = (0.98 * 1) / 2
    const atBack = tris.filter((t) => t.minZ > top - 1e-6 && Math.abs(t.normal.z) > 0.9)
    expect(atBack.length).toBe(2)
    for (const face of atBack) expect(face.normal.z).toBeCloseTo(1, 5)
  })

  test('rises exactly one storey', () => {
    let highest = -Infinity
    for (const tri of tris) highest = Math.max(highest, tri.maxY)
    expect(highest - floorY).toBeCloseTo(LEVEL_HEIGHT, 5)
  })
})

describe('Ladder wall geometry', () => {
  const geometry = createLadderWallGeometry(5)
  const tris = triangles(positionsOf(geometry))

  test('is built from non-degenerate, axis-aligned faces', () => {
    expect(tris.length).toBeGreaterThan(0)
    for (const tri of tris) {
      expect(tri.area).toBeGreaterThan(0)
      const axes = [Math.abs(tri.normal.x), Math.abs(tri.normal.y), Math.abs(tri.normal.z)]
      expect(Math.max(...axes)).toBeCloseTo(1, 5)
    }
  })

  test('spans one storey so it links two floors', () => {
    let lowest = Infinity
    let highest = -Infinity
    for (const tri of tris) {
      lowest = Math.min(lowest, tri.minY)
      highest = Math.max(highest, tri.maxY)
    }
    expect(highest - lowest).toBeCloseTo(LEVEL_HEIGHT, 5)
  })

  test('stays within the wall plane rather than filling the tile', () => {
    const positions = positionsOf(geometry)
    let maxDepth = 0
    for (let i = 2; i < positions.length; i += 3) {
      maxDepth = Math.max(maxDepth, Math.abs(positions[i]!))
    }
    // A tile is 1 m across; the ladder is a thin wall fixture.
    expect(maxDepth).toBeLessThan(0.1)
  })

  test('has both rails and every rung', () => {
    const positions = positionsOf(geometry)
    const railXs = new Set<number>()
    for (let i = 0; i < positions.length; i += 3) {
      railXs.add(Math.round(positions[i]! * 1000) / 1000)
    }
    // Two rails plus the rung ends give a small, fixed set of x planes.
    expect(railXs.size).toBeGreaterThanOrEqual(4)
    // 2 rails + 5 rungs, 12 triangles each.
    expect(positions.length / 9).toBe(7 * 12)
  })
})
