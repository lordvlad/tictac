import { System } from '../System'
import type { World } from '../World'
import { Faction } from '../../config'
import { ActionPointsComponent } from '../components/ActionPointsComponent'
import { HealthComponent } from '../components/HealthComponent'
import { IdentityComponent } from '../components/IdentityComponent'

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

  endTurn(world: World): void {
    this.activeFaction = this.activeFaction === Faction.Blue ? Faction.Red : Faction.Blue
    if (this.activeFaction === Faction.Blue) this.turnNumber++

    for (const entityId of world.query([
      IdentityComponent,
      ActionPointsComponent,
      HealthComponent,
    ])) {
      const identity = world.getComponent(entityId, IdentityComponent)!
      const health = world.getComponent(entityId, HealthComponent)!
      if (health.hp <= 0 || identity.faction !== this.activeFaction) continue
      const ap = world.getComponent(entityId, ActionPointsComponent)!
      ap.ap = ap.maxAp
    }
  }
}
