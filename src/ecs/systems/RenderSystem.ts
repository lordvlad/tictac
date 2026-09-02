import { System } from '../System'
import type { World } from '../World'
import { StanceComponent } from '../components/StanceComponent'
import { HealthComponent } from '../components/HealthComponent'
import type { Soldier } from '../../entities/Soldier'

/**
 * Reflects component state in the scene: mesh transforms every frame, and the
 * looping animation clip whenever a unit's stance changes.
 *
 * Reading only — the renderer never decides anything, so a unit driven by a
 * peer's component updates animates exactly like a local one.
 */
export class RenderSystem extends System {
  private readonly soldiers = new Map<number, Soldier>()
  /** Last stance rendered, so a clip change is played once rather than per frame. */
  private readonly lastStance = new Map<number, string>()

  bind(soldier: Soldier): void {
    this.soldiers.set(soldier.entityId, soldier)
  }

  unbind(entityId: number): void {
    this.soldiers.delete(entityId)
    this.lastStance.delete(entityId)
  }

  update(delta: number, world: World): void {
    for (const [entityId, soldier] of this.soldiers) {
      const stance = world.getComponent(entityId, StanceComponent)
      const health = world.getComponent(entityId, HealthComponent)

      if (stance && health) {
        const key = health.hp <= 0 ? 'dead' : stance.isMoving ? 'move' : stance.isCrouching ? 'crouch' : 'idle'
        if (this.lastStance.get(entityId) !== key) {
          this.lastStance.set(entityId, key)
          if (key === 'dead') soldier.playDeath()
          else soldier.playStanceClip()
        }
      }

      soldier.renderUpdate(delta)
    }
  }
}
