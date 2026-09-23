import { System } from '../System'
import type { World } from '../World'
import { Faction } from '../../config'
import { ActionPointsComponent } from '../components/ActionPointsComponent'
import { HealthComponent } from '../components/HealthComponent'
import { IdentityComponent } from '../components/IdentityComponent'
import { StatusesComponent } from '../components/StatusesComponent'
import { effectiveMaxAp } from '../../core/Ballistics'

/** Whose turn it is, and the AP everyone gets back when it comes round. */
export class TurnSystem extends System {
  activeFaction: Faction = Faction.Blue
  turnNumber = 1

  update(): void {
    // Turn transitions are explicit; nothing to advance per tick.
  }

  endUnitTurn(world: World, entityId: number): void {
    const ap = world.getComponent(entityId, ActionPointsComponent)
    if (ap) ap.ap = 0
  }

  /**
   * Hand the turn over, and give the incoming side its points.
   *
   * Separate halves because something has to happen *between* them: statuses
   * expire and exhaustion is charged against the side going out, and doing
   * that after the refill meant a penalty that had just run out still docked
   * the allowance it was handed. `TurnManager.startNextTurn` is the one place
   * that puts the three in order.
   */
  advanceFaction(): void {
    this.activeFaction = this.activeFaction === Faction.Blue ? Faction.Red : Faction.Blue
    if (this.activeFaction === Faction.Blue) this.turnNumber++
  }

  replenish(world: World): void {
    for (const entityId of world.query([
      IdentityComponent,
      ActionPointsComponent,
      HealthComponent,
    ])) {
      const identity = world.getComponent(entityId, IdentityComponent)!
      const health = world.getComponent(entityId, HealthComponent)!
      if (health.hp <= 0 || identity.faction !== this.activeFaction) continue
      const ap = world.getComponent(entityId, ActionPointsComponent)!
      // A live stim raises the ceiling, so the refill has to read it.
      const statuses = world.getComponent(entityId, StatusesComponent)
      ap.ap = effectiveMaxAp(ap.maxAp, statuses?.list ?? [])
    }
  }
}
