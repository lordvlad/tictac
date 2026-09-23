import { System } from '../System'
import type { World } from '../World'
import { PositionComponent } from '../components/PositionComponent'
import { StanceComponent } from '../components/StanceComponent'
import { TraitsComponent } from '../components/TraitsComponent'
import { ActionPointsComponent } from '../components/ActionPointsComponent'
import { HealthComponent } from '../components/HealthComponent'
import { RULES } from '../../config'
import { stepCost } from '../../game/Movement'
import type { Grid, Tile } from '../../core/Grid'
import { distance, facingYaw } from '../../core/math'
import { headingToward } from '../../core/Facing'

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
    // A crouched unit moves crouched. It used to be stood up to run, which
    // made crouching a thing you did between moves and never while making one.
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

  /**
   * Forget every in-flight route.
   *
   * `pathIndices` is the one piece of movement state that is not a component,
   * so a replay jumping to another moment has to clear it by hand or the next
   * tick would resume walking a path the restored units are no longer on.
   */
  clearRoutes(world: World, entityIds: Iterable<number>): void {
    for (const entityId of entityIds) this.stopMovement(world, entityId)
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
      const traits = world.getComponent(entityId, TraitsComponent)

      // Distance budget for this tick. Leftover carries across tile boundaries,
      // otherwise the remainder is discarded on every arrival and the unit
      // travels measurably slower than moveSpeed.
      let budget = (stance.isCrouching ? RULES.crouchMoveSpeed : RULES.moveSpeed) * delta

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
        // Read per step: a watcher can wound a unit mid-walk now, and a limp
        // changes what the next step costs. Absent for anything that is not a
        // soldier, and whole units cost 1. The crouch premium is the same one
        // `Soldier.moveCostMul` plans with.
        const mul = (traits?.moveCostMul ?? 1) * (stance.isCrouching ? RULES.crouchStepCost : 1)
        const cost = stepCost(this.grid, prev, nextTile, mul)
        if (ap.ap < cost) {
          this.stopMovement(world, entityId)
          break
        }

        const targetWorld = this.grid.tileToWorld(nextTile)

        // Measured against targetPos (the logical position), not the mesh,
        // which lags behind by design for smoothing.
        const dx = targetWorld.x - pos.targetPos.x
        const dy = targetWorld.y - pos.targetPos.y
        const dz = targetWorld.z - pos.targetPos.z
        const dist = distance(dx, dy, dz)

        if (distance(dx, dz) > 0.001) pos.targetYaw = facingYaw(dx, dz)

        if (dist > budget) {
          pos.targetPos.x += (dx / dist) * budget
          pos.targetPos.y += (dy / dist) * budget
          pos.targetPos.z += (dz / dist) * budget
          break
        }

        // Arrived. Only the logical position snaps; the mesh keeps lerping.
        pos.targetPos.copy(targetWorld)
        budget -= dist

        pos.tile = { x: nextTile.x, y: nextTile.y }
        pos.level = this.grid.levelAt(nextTile.x, nextTile.y)
        // Facing the way it walked, from the tiles rather than the yaw.
        pos.heading = headingToward(nextTile.x - prev.x, nextTile.y - prev.y, pos.heading)
        // Counted, not just deducted. Exhaustion asks what a unit *used*, and
        // writing the component behind `Soldier`'s accounting meant walking a
        // squad into the ground cost it nothing while firing from cover did —
        // the opposite of the rule, and a difference the headless runner did
        // not share.
        const spent = Math.min(ap.ap, cost)
        ap.ap -= spent
        ap.spentThisTurn += spent

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
