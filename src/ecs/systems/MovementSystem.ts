import { System } from '../System'
import type { World } from '../World'
import { PositionComponent } from '../components/PositionComponent'
import { StanceComponent } from '../components/StanceComponent'
import { ActionPointsComponent } from '../components/ActionPointsComponent'
import { HealthComponent } from '../components/HealthComponent'
import { RULES } from '../../config'
import type { Grid, Tile } from '../../core/Grid'

/**
 * Walks units along their planned route, one tile at a time.
 *
 * Owns the whole of movement execution: the distance budget, the AP charged
 * per tile, and the yaw the unit turns to. Nothing else advances a position.
 */
export class MovementSystem extends System {
  /** How far into `movingPath` each unit has walked. Not networked: the peer replays its own route. */
  private readonly pathIndices = new Map<number, number>()

  /** Fired on each tile boundary crossed, for visibility and HUD refreshes. */
  onStep?: (entityId: number, tile: Tile) => void
  /** Fired when a unit stops, whether it arrived or ran out of AP. */
  onArrived?: (entityId: number) => void

  constructor(private readonly grid: Grid) {
    super()
  }

  startMovement(world: World, entityId: number, path: Tile[]): boolean {
    if (path.length <= 1) return false
    const stance = world.getComponent(entityId, StanceComponent)
    if (!stance) return false

    stance.movingPath = path.map((t) => ({ x: t.x, y: t.y }))
    stance.isMoving = true
    // Moving breaks cover — stand up to run.
    stance.isCrouching = false
    this.pathIndices.set(entityId, 1)
    return true
  }

  stopMovement(world: World, entityId: number): void {
    const stance = world.getComponent(entityId, StanceComponent)
    if (stance) {
      stance.isMoving = false
      stance.movingPath = []
    }
    this.pathIndices.delete(entityId)
    this.onArrived?.(entityId)
  }

  update(delta: number, world: World): void {
    for (const entityId of world.query([
      PositionComponent,
      StanceComponent,
      ActionPointsComponent,
      HealthComponent,
    ])) {
      const stance = world.getComponent(entityId, StanceComponent)!
      if (!stance.isMoving) continue

      const health = world.getComponent(entityId, HealthComponent)!
      if (health.hp <= 0) {
        this.stopMovement(world, entityId)
        continue
      }

      const pos = world.getComponent(entityId, PositionComponent)!
      const ap = world.getComponent(entityId, ActionPointsComponent)!

      // Distance budget for this tick. Leftover carries across tile boundaries,
      // otherwise the remainder is discarded on every arrival and the unit
      // travels measurably slower than moveSpeed.
      let budget = RULES.moveSpeed * delta

      while (budget > 0) {
        let index = this.pathIndices.get(entityId) ?? 1
        const nextTile = stance.movingPath[index]
        if (!nextTile) {
          this.stopMovement(world, entityId)
          break
        }

        // Never enter a tile the unit cannot pay for. Movement always halts on
        // a tile boundary, so stopping here leaves a valid grid position.
        const prev = stance.movingPath[index - 1] ?? pos.tile
        const stepCost =
          prev.x !== nextTile.x && prev.y !== nextTile.y ? RULES.stepDiagonal : RULES.stepOrthogonal
        if (ap.ap < stepCost) {
          this.stopMovement(world, entityId)
          break
        }

        const targetWorld = this.grid.tileToWorld(nextTile)

        // Measured against targetPos (the logical position), not the mesh,
        // which lags behind by design for smoothing.
        const dx = targetWorld.x - pos.targetPos.x
        const dz = targetWorld.z - pos.targetPos.z
        const dist = Math.hypot(dx, dz)

        if (dist > 0.001) pos.targetYaw = Math.atan2(dx, dz)

        if (dist > budget) {
          pos.targetPos.x += (dx / dist) * budget
          pos.targetPos.z += (dz / dist) * budget
          break
        }

        // Arrived. Only the logical position snaps; the mesh keeps lerping.
        pos.targetPos.copy(targetWorld)
        budget -= dist

        pos.tile = { x: nextTile.x, y: nextTile.y }
        ap.ap = Math.max(0, ap.ap - stepCost)

        this.onStep?.(entityId, nextTile)

        index += 1
        this.pathIndices.set(entityId, index)
        if (index >= stance.movingPath.length) {
          this.stopMovement(world, entityId)
          break
        }
      }
    }
  }
}
