import type { Faction } from '../config'
import type { UnitRef } from '../core/Combatant'
import type { RenderSystem } from './RenderSystem'
import type { EngineContext } from '../engine'
import type { World } from '../ecs/World'
import type { Squads } from '../entities/Squads'
import { SoldierView } from './SoldierView'
import { soldierModel } from './SoldierModel'

/**
 * The squad's bodies, and the way back from a unit to the one that is its.
 *
 * Built after the squads themselves, and separately: a match is units, a
 * *rendered* match is units plus these. Anything that needs a mesh — the
 * animations, the camera, the picking — goes through here, so nothing else has
 * to hold both halves of a soldier at once. Each body is handed a model built
 * from the unit's components (`soldierModel`), never the unit.
 */
export class SquadViews {
  private readonly byEntity = new Map<number, SoldierView>()

  constructor(engine: EngineContext, world: World, squads: Squads, render: RenderSystem) {
    const registry: Record<string, SoldierView> = {}
    for (const unit of squads.soldiers) {
      const view = new SoldierView(engine, soldierModel(world, unit.entityId))
      this.byEntity.set(unit.entityId, view)
      render.bind(view)
      registry[view.id] = view
    }
    // Registered into the engine's own entity map in one call: it is a table of
    // things to draw, and every body belongs in it.
    engine.world.add(registry)
  }

  /** The body of `unit`, or nothing if this match is not being drawn. */
  viewOf(unit: UnitRef & { entityId: number }): SoldierView | undefined {
    return this.byEntity.get(unit.entityId)
  }

  /** Every body on a side, for the passes that sweep a whole squad. */
  forFaction(faction: Faction): SoldierView[] {
    return [...this.byEntity.values()].filter((view) => view.unit.faction === faction)
  }

  dispose(): void {
    for (const view of this.byEntity.values()) view.destroy()
    this.byEntity.clear()
  }
}
