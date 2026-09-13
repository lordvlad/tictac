import type { Vector3 } from 'three'
import type { CombatFx, UnitRef } from '../core/Combatant'
import type { Squads } from '../game/Squads'
import type { Tracers } from './Tracers'

/**
 * Draws what combat announces.
 *
 * The one place that knows a resolved event has a picture: tracers into the
 * scene, and the fire, flinch and death poses onto the unit that earned them.
 *
 * Units are looked up by identity rather than handed over as objects, because
 * a resolved event deliberately carries no mesh. That indirection is the
 * seam a view layer wants anyway — the same lookup serves whatever owns the
 * animation once a unit is data and its body is somewhere else.
 */
export class SceneCombatFx implements CombatFx {
  constructor(
    private readonly tracers: Tracers,
    private readonly squads: Squads,
  ) {}

  tracer(from: Vector3, to: Vector3, hit: boolean): void {
    this.tracers.spawnTracer(from, to, hit)
  }

  shoot(unit: UnitRef): void {
    this.viewOf(unit)?.playShoot()
  }

  hit(unit: UnitRef): void {
    this.viewOf(unit)?.playHit()
  }

  death(unit: UnitRef): void {
    this.viewOf(unit)?.playDeath()
  }

  private viewOf(unit: UnitRef) {
    return this.squads.byFaction[unit.faction][unit.squadIndex]
  }
}
