import { describe, expect, test } from 'bun:test'
import { Rng } from '../src/core/rng'
import { distanceKm, type LatLng } from '../src/core/Travel'
import type { Db } from '../src/server/db/Db'
import { DEFAULT_ANCHOR, drawAround, Squads, START_RADIUS_KM, START_SEPARATION_KM } from '../src/server/Squads'
import { DATABASE_URLS, freshPersistence } from './support/db'

/**
 * Where squads start (`src/server/Squads.ts`, GDD-WORLD §4): uniform over the
 * disc around the reported location, and never within a kilometre of another
 * player's start.
 */

describe('A start is drawn uniformly over the disc', () => {
  // Seeded, so the statistics below are a fixed sample rather than a flaky one.
  const rng = new Rng(20261008)
  const draws = Array.from({ length: 4000 }, () => drawAround(DEFAULT_ANCHOR, START_RADIUS_KM, () => rng.next()))
  const radii = draws.map((point) => distanceKm(DEFAULT_ANCHOR, point))

  test('never outside it', () => {
    expect(Math.max(...radii)).toBeLessThanOrEqual(START_RADIUS_KM + 1e-6)
  })

  test('as many in each ring of equal area — not crowded at the centre', () => {
    // Five rings of equal area have edges at R·√(k/5). A χ² over them, four
    // degrees of freedom: 13.28 is the 1% critical value. Drawing the radius
    // uniformly (no square root) puts 45% in the inner ring and fails this.
    const rings = [0, 0, 0, 0, 0]
    for (const r of radii) rings[Math.min(4, Math.floor(5 * (r / START_RADIUS_KM) ** 2))]!++
    const expected = draws.length / 5
    const chiSquared = rings.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0)
    expect(chiSquared).toBeLessThan(13.28)
  })

  test('in every direction alike', () => {
    const quadrants = [0, 0, 0, 0]
    for (const point of draws) {
      quadrants[(point.lat >= DEFAULT_ANCHOR.lat ? 0 : 2) + (point.lng >= DEFAULT_ANCHOR.lng ? 0 : 1)]!++
    }
    for (const count of quadrants) expect(Math.abs(count / draws.length - 0.25)).toBeLessThan(0.03)
  })

  test('across the antimeridian, a longitude that stays on the map', () => {
    const near: LatLng = { lat: -17.7, lng: 179.9 }
    for (let i = 0; i < 200; i++) {
      const point = drawAround(near, START_RADIUS_KM, () => rng.next())
      expect(Math.abs(point.lng)).toBeLessThanOrEqual(180)
      expect(distanceKm(near, point)).toBeLessThanOrEqual(START_RADIUS_KM + 1e-6)
    }
  })
})

describe.each(DATABASE_URLS)('Starts kept apart on %s', (url) => {
  /** `count` players, each given a squad around `anchor` by `squads`. */
  async function placed(squads: Squads, db: Db, count: number, anchor: LatLng | null) {
    const starts: LatLng[] = []
    for (let i = 0; i < count; i++) {
      const id = `p${i}`
      await db.query`INSERT INTO players (id, name, created_at) VALUES (${id}, ${id}, ${new Date(0).toISOString()})`
      const squad = await squads.place(db, id, anchor)
      starts.push(squad.waypoints[0]!)
    }
    return starts
  }

  test('three hundred players from one anchor: all within the disc, none within a kilometre of another', async () => {
    const persistence = await freshPersistence(url)
    const starts = await placed(persistence.squads, persistence.db, 300, null)

    for (const start of starts) expect(distanceKm(DEFAULT_ANCHOR, start)).toBeLessThanOrEqual(START_RADIUS_KM + 1e-6)
    let closest = Infinity
    for (let i = 0; i < starts.length; i++) {
      for (let j = i + 1; j < starts.length; j++) closest = Math.min(closest, distanceKm(starts[i]!, starts[j]!))
    }
    expect(closest).toBeGreaterThanOrEqual(START_SEPARATION_KM)

    await persistence.close()
  }, 60_000)

  test('an anchor with no room left takes the last draw rather than refusing the player, and says so', async () => {
    const persistence = await freshPersistence(url)
    const lines: string[] = []
    // Every draw lands on the same spot, so the second player can never be
    // a kilometre clear of the first.
    const stuck = new Squads(persistence.db, () => new Date(0), () => 0.5, (line) => lines.push(line))
    const starts = await placed(stuck, persistence.db, 2, null)

    expect(starts[1]).toEqual(starts[0])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/no start 1 km clear/)

    await persistence.close()
  })
})
