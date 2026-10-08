import { distanceKm, type LatLng } from '../core/Travel'
import type { Squad } from '../game/Rpc'
import type { Db } from './db/Db'

/**
 * Where a player's squad is on the world map (GDD-WORLD §2, §4).
 *
 * A squad is a row of its own, holding its waypoint list (`src/core/Travel.ts`),
 * not a column on the player: captives, alien squads and a player with
 * several squads can then have positions without reshaping players. One row
 * per player for now, enforced by `squads_player`.
 *
 * Where a squad starts is drawn here, once: a point uniform over the disc of
 * `START_RADIUS_KM` around where Cloudflare places the connection, or around
 * `DEFAULT_ANCHOR` when it places it nowhere (the Bun server, always). Only
 * the drawn point is kept; the reported one is never written down. The draw
 * is setup randomness from the system, never a match's dice.
 */

/** Where a squad starts when the connection's location is unknown: Stuttgart centre (GDD-WORLD §4, D3). */
export const DEFAULT_ANCHOR: LatLng = { lat: 48.7775, lng: 9.18 }

/** How far from the reported location a start may land. */
export const START_RADIUS_KM = 50

/** The least distance between two players' starts (D4). */
export const START_SEPARATION_KM = 1

/**
 * How many draws a start gets before the last one is taken anyway. The disc
 * holds thousands of separated starts, so this is never expected to be hit;
 * if it is, the anchor is crowded and that is worth a line in the log.
 */
const MAX_DRAWS = 100

/** Stored as integer millionths of a degree (about 0.1 m): the database takes TEXT and INTEGER only (`Db.ts`). */
const MICRODEGREES = 1_000_000

/** A float in [0, 1) from the system's randomness. */
function systemRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296
}

/**
 * A point uniform over the disc of `radiusKm` around `anchor`: a distance of
 * `radiusKm·√u` (so the density per area is flat, not crowded at the centre)
 * along a uniform bearing, walked along the great circle. Rounded to the
 * stored precision.
 */
export function drawAround(anchor: LatLng, radiusKm: number, random: () => number): LatLng {
  const distance = (radiusKm * Math.sqrt(random())) / 6371
  const bearing = 2 * Math.PI * random()
  const lat1 = (anchor.lat * Math.PI) / 180
  const lng1 = (anchor.lng * Math.PI) / 180
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing))
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1),
      Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2),
    )
  let lng = (lng2 * 180) / Math.PI
  if (lng > 180) lng -= 360
  else if (lng < -180) lng += 360
  return {
    lat: Math.round(((lat2 * 180) / Math.PI) * MICRODEGREES) / MICRODEGREES,
    lng: Math.round(lng * MICRODEGREES) / MICRODEGREES,
  }
}

export class Squads {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = systemRandom,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** The player's squad, or null for one who has none yet. */
  async of(playerId: string): Promise<Squad | null> {
    const rows = await this.db.query<{ id: string; waypoints: string }>`
      SELECT id, waypoints FROM squads WHERE player_id = ${playerId}`
    const row = rows[0]
    return row ? { id: row.id, waypoints: JSON.parse(row.waypoints) as Squad['waypoints'] } : null
  }

  /** A squad by its id, with the player it belongs to; null for one that does not exist. */
  async byId(id: string): Promise<{ playerId: string; squad: Squad } | null> {
    const rows = await this.db.query<{ player_id: string; waypoints: string }>`
      SELECT player_id, waypoints FROM squads WHERE id = ${id}`
    const row = rows[0]
    return row ? { playerId: row.player_id, squad: { id, waypoints: JSON.parse(row.waypoints) as Squad['waypoints'] } } : null
  }

  /** Every squad, for a starting server to schedule what each has due. */
  async all(): Promise<{ playerId: string; squad: Squad }[]> {
    const rows = await this.db.query<{ id: string; player_id: string; waypoints: string }>`
      SELECT id, player_id, waypoints FROM squads`
    return rows.map((row) => ({
      playerId: row.player_id,
      squad: { id: row.id, waypoints: JSON.parse(row.waypoints) as Squad['waypoints'] },
    }))
  }

  /** Write `squad`'s route. The start columns never change: a start is where it began. */
  async save(squad: Squad): Promise<void> {
    await this.db.query`UPDATE squads SET waypoints = ${JSON.stringify(squad.waypoints)} WHERE id = ${squad.id}`
  }

  /**
   * Give `playerId` a squad at a start drawn around `anchor` (or
   * `DEFAULT_ANCHOR`), inside `tx` — registration's transaction, so a player
   * never exists without one.
   */
  async place(tx: Db, playerId: string, anchor: LatLng | null): Promise<Squad> {
    const start = await this.drawStart(tx, anchor ?? DEFAULT_ANCHOR)
    const created = this.now()
    const squad: Squad = {
      id: crypto.randomUUID(),
      waypoints: [{ kind: 'past', lat: start.lat, lng: start.lng, arrival: created.getTime(), departed: null }],
    }
    await tx.query`INSERT INTO squads (id, player_id, waypoints, start_lat_e6, start_lng_e6, created_at)
                   VALUES (${squad.id}, ${playerId}, ${JSON.stringify(squad.waypoints)},
                           ${Math.round(start.lat * MICRODEGREES)}, ${Math.round(start.lng * MICRODEGREES)},
                           ${created.toISOString()})
                   ON CONFLICT (player_id) DO NOTHING`
    // Two windows of a player that had no squad may both get here; the one
    // that lost the race reads the winner's.
    return (await this.of(playerId)) ?? squad
  }

  /**
   * The player's squad, placed now if they have none — which is every player
   * registered before squads existed, the first time anything asks.
   */
  async ensure(playerId: string, anchor: LatLng | null): Promise<Squad> {
    return (await this.of(playerId)) ?? this.place(this.db, playerId, anchor)
  }

  private async drawStart(tx: Db, anchor: LatLng): Promise<LatLng> {
    let start = drawAround(anchor, START_RADIUS_KM, this.random)
    for (let draw = 1; draw < MAX_DRAWS && (await this.crowded(tx, start)); draw++) {
      start = drawAround(anchor, START_RADIUS_KM, this.random)
    }
    if (await this.crowded(tx, start)) {
      this.log(
        `[squads] no start ${START_SEPARATION_KM} km clear of the others in ${MAX_DRAWS} draws ` +
          `around ${anchor.lat}, ${anchor.lng}; taking the last`,
      )
    }
    return start
  }

  /**
   * Whether another player's start lies within `START_SEPARATION_KM` of
   * `point`: a box on the indexed columns, then the true distance. A box
   * that crosses the antimeridian is not wrapped; starts are drawn around
   * where people are, and the worst case is two starts closer than a
   * kilometre.
   */
  private async crowded(tx: Db, point: LatLng): Promise<boolean> {
    const dLat = START_SEPARATION_KM / 111.2
    const dLng = dLat / Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01)
    const rows = await tx.query<{ lat: number; lng: number }>`
      SELECT start_lat_e6 AS lat, start_lng_e6 AS lng FROM squads
       WHERE start_lat_e6 BETWEEN ${Math.floor((point.lat - dLat) * MICRODEGREES)} AND ${Math.ceil((point.lat + dLat) * MICRODEGREES)}
         AND start_lng_e6 BETWEEN ${Math.floor((point.lng - dLng) * MICRODEGREES)} AND ${Math.ceil((point.lng + dLng) * MICRODEGREES)}`
    return rows.some(
      (row) =>
        distanceKm(point, { lat: Number(row.lat) / MICRODEGREES, lng: Number(row.lng) / MICRODEGREES }) <
        START_SEPARATION_KM,
    )
  }
}
