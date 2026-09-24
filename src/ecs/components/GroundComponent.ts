import { Component } from '../Component'

/**
 * What has happened to the ground since the map was made: where it is burning,
 * where there is smoke, what burned to ash, and which crates burned away.
 *
 * One entity for the whole map, holding only the tiles that differ from the
 * generated ground, so it replicates and digests like any component while
 * the grid keeps the dense index the rules read (`GroundSystem` writes both).
 * Sorted by tile index, so two peers holding the same ground serialise it the
 * same way.
 */
export class GroundComponent extends Component {
  static readonly componentName = 'ground'
  get name(): string {
    return GroundComponent.componentName
  }

  /** Tile index → handovers left to burn. */
  fire = new Map<number, number>()
  /** Tile index → handovers of smoke left. */
  smoke = new Map<number, number>()
  /** Tiles whose floor burned to ash. */
  ash = new Set<number>()
  /** Tiles whose crate burned away. */
  razed = new Set<number>()
  /**
   * Bumped whenever the state arrives from outside the rules — a peer's
   * replication, a replay put back to an earlier moment — so the system
   * knows to rebuild the grid's index from it.
   */
  revision = 0

  serialize(): Record<string, unknown> {
    const pairs = (map: Map<number, number>) => [...map].sort((a, b) => a[0] - b[0])
    return {
      fire: pairs(this.fire),
      smoke: pairs(this.smoke),
      ash: [...this.ash].sort((a, b) => a - b),
      razed: [...this.razed].sort((a, b) => a - b),
    }
  }

  deserialize(data: Record<string, unknown>): void {
    const pairs = (value: unknown): Map<number, number> =>
      new Map(
        Array.isArray(value)
          ? value.filter(
              (p): p is [number, number] =>
                Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number' && p[1] > 0,
            )
          : [],
      )
    const indices = (value: unknown): Set<number> =>
      new Set(Array.isArray(value) ? value.filter((i): i is number => typeof i === 'number') : [])
    this.fire = pairs(data.fire)
    this.smoke = pairs(data.smoke)
    this.ash = indices(data.ash)
    this.razed = indices(data.razed)
    this.revision++
  }
}
