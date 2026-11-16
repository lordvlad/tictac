import type { LatLng } from '../core/Travel'

/**
 * Which region owns what (RFC-0002 §3–§5, tictac-dwq).
 *
 * Two different questions, answered by two different things:
 *
 * - **Where does a place go?** A pure function of the partition table: the
 *   region whose box holds the point. It decides where a crossing is handed
 *   to and where a new connection is first routed. {@link RegionMap}.
 * - **Who keeps this squad?** A durable fact, written when a handover commits
 *   (`Squads.setOwner`) and read back here — never recomputed from where the
 *   squad happens to stand, which moves every millisecond and would flip a
 *   squad's keeper in the middle of a handover. {@link RegionDirectory}.
 *
 * Nothing here is module state: a host builds its directory from its config
 * and hands it to everything that asks (`Journeys`, `Sessions`,
 * `HandoverCoordinator`, the Worker's router), so two servers in one process
 * can disagree about the world.
 */

/** The one region every deployment has today, and the owner every squad row defaults to (migration 11). */
export const SINGLETON_REGION = 'singleton'

export interface RegionPartition {
  /** Canonical region ID, e.g. "region-west" or "region-east". */
  id: string
  /** The Durable Object instance name for this partition: what an owner column holds. */
  durableObjectName: string
  /** The box this region covers. A partition without one covers everything not claimed by another. */
  bounds?: {
    minLat: number
    maxLat: number
    minLng: number
    maxLng: number
  }
}

/** The deployed partition table: one region covering the world, until there is load to shard (`tictac-dwq`). */
export const REGIONS: readonly RegionPartition[] = [{ id: SINGLETON_REGION, durableObjectName: SINGLETON_REGION }]

/** The partition table asked about places. Everything the Worker needs, which has no database. */
export interface RegionMap {
  /** The Durable Object that owns a world coordinate. A point outside every box goes to the first partition. */
  ownerOfPlace(place: LatLng): string
}

/** What a region directory reads a squad's committed keeper from: the squads this region's store holds. */
export interface SquadOwners {
  /** The region that keeps `squadId`, or null for a squad the store does not hold. */
  ownerOf(squadId: string): Promise<string | null>
}

export interface RegionDirectory extends RegionMap {
  /** This host's own region name: what `ownerOfSquad` is compared to before acting on a squad. */
  readonly self: string
  /** The region that keeps `squadId` as last committed, or null when this host holds no such squad. */
  ownerOfSquad(squadId: string): Promise<string | null>
}

/** A place → region lookup over `partitions`, which must name at least one region. */
export function regionMap(partitions: readonly RegionPartition[]): RegionMap {
  const table = [...partitions]
  const fallback = table[0]
  if (!fallback) throw new Error('a region map needs at least one partition')
  return {
    ownerOfPlace({ lat, lng }) {
      for (const part of table) {
        if (!part.bounds) return part.durableObjectName
        const { minLat, maxLat, minLng, maxLng } = part.bounds
        if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) return part.durableObjectName
      }
      return fallback.durableObjectName
    },
  }
}

export interface RegionDirectoryOptions {
  owners: SquadOwners
  /** The partition table; the deployed one unless a test says otherwise. */
  partitions?: readonly RegionPartition[]
  /** The region this host is; `SINGLETON_REGION` unless a test or a region deployment says otherwise. */
  self?: string
}

export function regionDirectory(options: RegionDirectoryOptions): RegionDirectory {
  const { owners } = options
  return {
    self: options.self ?? SINGLETON_REGION,
    ...regionMap(options.partitions ?? REGIONS),
    ownerOfSquad: (squadId) => owners.ownerOf(squadId),
  }
}
