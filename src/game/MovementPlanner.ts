import { directionalCover } from '../core/Cover'
import { type Grid, type Tile, tileEquals } from '../core/Grid'
import { findChainedPath } from '../core/Pathfinding'
import type { Soldier } from '../entities/Soldier'
import { PathMarker } from '../render/PathMarker'
import type { Squads } from './Squads'
import type { EngineContext } from '../engine'

/**
 * The movement planner: where the selected unit has been told to go, the route
 * it would take, and the 3D preview of both.
 *
 * Two input flows share this state. Without waypoint mode a tap sets the target
 * and a second tap on it confirms. With waypoint mode on, each tap on a fresh
 * tile appends a waypoint and re-tapping one walks it up: waypoint -> target ->
 * confirmed move.
 */
export class MovementPlanner {
  private readonly marker: PathMarker
  private readonly occupied = new Set<number>()

  private waypoints: Tile[] = []
  private goal: Tile | null = null
  /** Route currently previewed. Only ever executed while `pathValid`. */
  private path: Tile[] = []
  private pathValid = false
  private waypointModeOn = false
  onMovementStarted?: (soldier: Soldier, path: Tile[]) => void

  constructor(
    private readonly grid: Grid,
    private readonly squads: Squads,
    engine: EngineContext,
  ) {
    this.marker = new PathMarker(engine)
  }

  get waypointMode(): boolean {
    return this.waypointModeOn
  }

  /** Current plan, for callers that need to inspect it (tests, debug overlay). */
  get plan(): { goal: Tile | null; waypoints: readonly Tile[]; path: readonly Tile[]; valid: boolean } {
    return { goal: this.goal, waypoints: this.waypoints, path: this.path, valid: this.pathValid }
  }

  /**
   * Toggle waypoint planning. Switching it off abandons the plan outright: the
   * half-built route belongs to that mode and silently keeping it would leave a
   * stale target armed for the next single tap.
   */
  toggleWaypointMode(): boolean {
    this.waypointModeOn = !this.waypointModeOn
    if (!this.waypointModeOn) this.clear()
    return this.waypointModeOn
  }

  /**
   * Apply a tap on `tile`. `asWaypoint` forces waypoint behaviour regardless of
   * the mode (shift-click on desktop).
   *
   * @returns true when the tap started a movement.
   */
  handleClick(soldier: Soldier, tile: Tile, asWaypoint: boolean): boolean {
    if (asWaypoint) {
      this.addWaypoint(soldier, tile)
      return false
    }

    if (this.waypointModeOn) return this.handleWaypointModeClick(soldier, tile)

    if (this.goal === null) {
      // First tap sets the target and shows the route to it.
      this.goal = tile
      this.render(soldier)
      return false
    }

    if (tileEquals(this.goal, tile)) {
      // Second tap on the SAME tile confirms, but only if the route is actually
      // reachable within the unit's remaining AP. An unreachable (red) target
      // must never become walkable just because it was tapped twice.
      return this.confirm(soldier)
    }

    // Tap on a different tile abandons the plan.
    this.clear()
    return false
  }

  private handleWaypointModeClick(soldier: Soldier, tile: Tile): boolean {
    if (this.goal && tileEquals(this.goal, tile)) return this.confirm(soldier)

    const existing = this.waypoints.findIndex((w) => tileEquals(w, tile))
    if (existing >= 0) {
      // Second tap on a waypoint promotes it to the target.
      this.waypoints.splice(existing, 1)
      this.goal = tile
      this.render(soldier)
      return false
    }

    this.addWaypoint(soldier, tile)
    return false
  }

  private addWaypoint(soldier: Soldier, tile: Tile): void {
    if (!this.waypoints.some((w) => tileEquals(w, tile))) this.waypoints.push(tile)
    this.render(soldier)
  }

  private confirm(soldier: Soldier): boolean {
    const path = this.pathValid && this.path.length > 1 ? [...this.path] : null
    this.clear()
    if (!path) return false
    // Execution belongs to MovementSystem; the planner only decides the route.
    this.onMovementStarted?.(soldier, path)
    return true
  }

  /** Drop the whole plan and its preview. */
  clear(): void {
    this.waypoints = []
    this.goal = null
    this.path = []
    this.pathValid = false
    this.marker.clear()
  }

  /**
   * Rebuild the preview for `soldier`, or clear it when nothing is selected.
   *
   * Recomputing the route here (rather than at click time) keeps the previewed
   * path and the executable path the same object of truth.
   */
  render(soldier: Soldier | null): void {
    this.marker.clear()
    if (!soldier || soldier.isDead) return

    this.marker.showSelection(this.grid.tileToWorld(soldier.tile))

    // Without a target, the newest waypoint stands in as a provisional endpoint
    // so the route stays visible while it is still being tapped out.
    const provisional = this.goal === null
    const endpoint = this.goal ?? this.waypoints[this.waypoints.length - 1] ?? null
    const via = provisional ? this.waypoints.slice(0, -1) : this.waypoints

    if (!endpoint || tileEquals(soldier.tile, endpoint)) {
      this.path = []
      this.pathValid = false
      return
    }

    this.occupied.clear()
    for (const s of this.squads.soldiers) {
      if (!s.isDead) this.occupied.add(this.grid.index(s.tile.x, s.tile.y))
    }

    const result = findChainedPath(
      this.grid,
      soldier.tile,
      endpoint,
      via,
      soldier.ap,
      this.occupied,
    )

    // Two units never share a tile, but A* is allowed to finish on an occupied
    // goal so a target can be named at all — including one whose occupant the
    // player cannot see yet. Accept the tap and stop the route a tile short of
    // it instead, which is where the unit was always going to end up.
    const plan = this.stopShortOfOccupant(result.path, result.totalCost)
    const affordable = plan.path.length > 1 && plan.cost <= soldier.ap

    // A provisional endpoint is not a target: no tap may confirm it.
    this.path = provisional ? [] : plan.path
    this.pathValid = provisional ? false : affordable

    // The marker belongs on the tile the unit will actually stand on.
    const shown = plan.path[plan.path.length - 1] ?? endpoint

    this.marker.show(
      this.grid.pathToWorldPoints(plan.path),
      (provisional ? this.waypoints : via).map((t) => this.grid.tileToWorld(t)),
      this.grid.tileToWorld(shown),
      affordable,
      provisional ? undefined : directionalCover(this.grid, shown),
      // Unreachable routes report Infinity; showing the walkable prefix's cost
      // would be a lie, so the label is left off entirely.
      Number.isFinite(plan.cost) ? plan.cost : undefined,
    )
  }

  /**
   * Trim a route that ends on a tile someone else is standing on.
   *
   * Returns the route unchanged when its last tile is free. The cost of the
   * dropped step comes off with it, so the AP label and the affordability test
   * describe the move that would actually happen.
   */
  private stopShortOfOccupant(
    path: readonly Tile[],
    cost: number,
  ): { path: Tile[]; cost: number } {
    const last = path[path.length - 1]
    if (last === undefined) return { path: [], cost }
    if (!this.occupied.has(this.grid.index(last.x, last.y))) return { path: [...path], cost }

    const trimmed = path.slice(0, -1)
    const prev = trimmed[trimmed.length - 1]
    if (prev === undefined) return { path: [], cost: Infinity }
    return { path: trimmed, cost: cost - this.grid.getStepCost(prev, last) }
  }

  update(delta: number): void {
    this.marker.update(delta)
  }

  dispose(): void {
    this.marker.dispose()
  }
}
