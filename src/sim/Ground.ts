import { Faction } from '../config'
import type { Grid, Tile } from '../core/Grid'
import { distance } from '../core/math'

/**
 * How much of the map one side used in a match.
 *
 * Measured because the win rates cannot say *how* a fight was fought, and a
 * policy that always meets the enemy head-on looks, in every other number,
 * exactly like one that flanks. "Forward" is along the line from this side's
 * spawn centroid to the enemy's; "sideways" is perpendicular to it.
 */
export interface GroundCovered {
  /** Tiles walked, summed over the squad. */
  walked: number
  /** Distinct tiles the squad stood on, spawns included. */
  tiles: number
  /** Share of the map's walkable ground those tiles are. */
  share: number
  /** Mean over units of the furthest each got towards the enemy spawn, in tiles. */
  forward: number
  /** Mean over units of the furthest each got sideways of its own spawn, in tiles. */
  sideways: number
}

interface UnitReach {
  spawn: Tile
  forward: number
  sideways: number
}

/** Keeps the tally for both sides as the policy walks units about. */
export class GroundTracker {
  private readonly walked: Record<Faction, number> = { [Faction.Blue]: 0, [Faction.Red]: 0 }
  private readonly visited: Record<Faction, Set<number>> = {
    [Faction.Blue]: new Set(),
    [Faction.Red]: new Set(),
  }
  private readonly reach: Record<Faction, UnitReach[]> = { [Faction.Blue]: [], [Faction.Red]: [] }
  /** Unit vector towards the enemy, per side. */
  private readonly axis: Record<Faction, { x: number; y: number }>
  private readonly walkable: number

  constructor(
    private readonly grid: Grid,
    spawns: Record<Faction, readonly Tile[]>,
  ) {
    const centre = (tiles: readonly Tile[]) => ({
      x: tiles.reduce((sum, t) => sum + t.x, 0) / tiles.length,
      y: tiles.reduce((sum, t) => sum + t.y, 0) / tiles.length,
    })
    const blue = centre(spawns[Faction.Blue])
    const red = centre(spawns[Faction.Red])
    const length = distance(red.x - blue.x, red.y - blue.y) || 1
    const towardsRed = { x: (red.x - blue.x) / length, y: (red.y - blue.y) / length }
    this.axis = {
      [Faction.Blue]: towardsRed,
      [Faction.Red]: { x: -towardsRed.x, y: -towardsRed.y },
    }
    for (const faction of [Faction.Blue, Faction.Red] as const) {
      for (const spawn of spawns[faction]) {
        this.reach[faction].push({ spawn: { ...spawn }, forward: 0, sideways: 0 })
        this.visited[faction].add(grid.index(spawn.x, spawn.y))
      }
    }
    let walkable = 0
    grid.forEach((x, y) => {
      if (grid.isWalkable(x, y)) walkable++
    })
    this.walkable = walkable
  }

  /** A unit of `faction`, `squadIndex`, arrived on `tile`. */
  step(faction: Faction, squadIndex: number, tile: Tile): void {
    this.walked[faction] += 1
    this.visited[faction].add(this.grid.index(tile.x, tile.y))
    const unit = this.reach[faction][squadIndex]
    if (!unit) return
    const axis = this.axis[faction]
    const dx = tile.x - unit.spawn.x
    const dy = tile.y - unit.spawn.y
    unit.forward = Math.max(unit.forward, dx * axis.x + dy * axis.y)
    unit.sideways = Math.max(unit.sideways, Math.abs(dx * axis.y - dy * axis.x))
  }

  of(faction: Faction): GroundCovered {
    const units = this.reach[faction]
    const mean = (pick: (u: UnitReach) => number) =>
      units.length === 0 ? 0 : units.reduce((sum, u) => sum + pick(u), 0) / units.length
    return {
      walked: this.walked[faction],
      tiles: this.visited[faction].size,
      share: this.walkable === 0 ? 0 : this.visited[faction].size / this.walkable,
      forward: mean((u) => u.forward),
      sideways: mean((u) => u.sideways),
    }
  }
}
