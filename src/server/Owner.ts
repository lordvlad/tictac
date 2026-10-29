import type { LatLng } from '../core/Travel'
import { positionAt } from '../core/Travel'
import type { Squad } from '../game/Rpc'

/**
 * Which match server owns what (RFC-0002 §5 / tictac-dwq):
 * The spatial partition registry that routes squads and connections
 * across region-sharded Durable Objects.
 *
 * In single-instance mode, everything routes to `MATCH_SERVER = 'singleton'`.
 * In region-sharded mode, regions are defined by bounding boxes or polygons
 * mapping coordinates to Durable Object instance names.
 */

/** The default Durable Object instance name. */
export const MATCH_SERVER = 'singleton'

export interface RegionPartition {
  /** Canonical region ID, e.g. "region-west" or "region-east". */
  id: string
  /** The Durable Object instance name for this partition. */
  durableObjectName: string
  /** Bounding box [minLat, maxLat, minLng, maxLng] */
  bounds?: {
    minLat: number
    maxLat: number
    minLng: number
    maxLng: number
  }
}

/** Active spatial partition table. Defaults to a single world partition. */
let partitions: RegionPartition[] = [
  {
    id: 'singleton',
    durableObjectName: MATCH_SERVER,
  },
]

/** Override or configure region partitions (used in tests and multi-region deployment). */
export function setPartitions(configured: readonly RegionPartition[]): void {
  partitions = [...configured]
}

/** Reset partitions to default single-region mode. */
export function resetPartitions(): void {
  partitions = [{ id: 'singleton', durableObjectName: MATCH_SERVER }]
}

/** Get all currently registered region partitions. */
export function getPartitions(): readonly RegionPartition[] {
  return partitions
}

/** Find which Durable Object owns a specific world coordinate. */
export function ownerOfCoord(coord: LatLng): string {
  for (const part of partitions) {
    if (!part.bounds) return part.durableObjectName
    const { minLat, maxLat, minLng, maxLng } = part.bounds
    if (coord.lat >= minLat && coord.lat <= maxLat && coord.lng >= minLng && coord.lng <= maxLng) {
      return part.durableObjectName
    }
  }
  return partitions[0]?.durableObjectName ?? MATCH_SERVER
}

/**
 * The match server that owns `squad`:
 * Inspects the squad's current position (or fallback resting position) against
 * the region partition table.
 */
export function ownerOf(squad: { waypoints?: Squad['waypoints']; id: string }, now: number = Date.now()): string {
  if (!squad.waypoints || squad.waypoints.length === 0) return partitions[0]?.durableObjectName ?? MATCH_SERVER
  try {
    const state = positionAt(squad.waypoints, now)
    return ownerOfCoord(state.position)
  } catch {
    return partitions[0]?.durableObjectName ?? MATCH_SERVER
  }
}
