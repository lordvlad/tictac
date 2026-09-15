import { System } from '../System'
import type { World } from '../World'
import { StanceComponent } from '../components/StanceComponent'
import { HealthComponent } from '../components/HealthComponent'
import type { SoldierView } from '../../render/SoldierView'

/**
 * Reflects component state in the scene: mesh transforms every frame, and the
 * looping animation clip whenever a unit's stance changes.
 *
 * Reading only — the renderer never decides anything, so a unit driven by a
 * peer's component updates animates exactly like a local one. It drives
 * {@link SoldierView}s rather than units, which is what lets a match run with
 * no views bound at all.
 */
export class RenderSystem extends System {
  private readonly views = new Map<number, SoldierView>()
  /** Last stance rendered, so a clip change is played once rather than per frame. */
  private readonly lastStance = new Map<number, string>()

  bind(view: SoldierView): void {
    this.views.set(view.unit.entityId, view)
  }

  unbind(entityId: number): void {
    this.views.delete(entityId)
    this.lastStance.delete(entityId)
  }

  update(delta: number, world: World): void {
    for (const [entityId, view] of this.views) {
      const stance = world.getComponent(entityId, StanceComponent)
      const health = world.getComponent(entityId, HealthComponent)

      if (stance && health) {
        const key = health.hp <= 0 ? 'dead' : stance.isMoving ? 'move' : stance.isCrouching ? 'crouch' : 'idle'
        if (this.lastStance.get(entityId) !== key) {
          this.lastStance.set(entityId, key)
          if (key === 'dead') view.playDeath()
          else view.playStanceClip()
        }
      }

      view.renderUpdate(delta)
    }
  }
}
