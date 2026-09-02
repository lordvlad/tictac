import type { Faction } from '../config'
import type { Soldier } from '../entities/Soldier'
import type { Squads } from './Squads'
import type { OrbitRig } from '../camera/OrbitRig'
import type { World } from '../ecs/World'
import type { TurnSystem } from '../ecs/systems/TurnSystem'

/**
 * Whose unit the player is commanding, and where the camera is pointed.
 *
 * The turn's *rules* — active faction, round number, action-point
 * replenishment — belong to {@link TurnSystem}, and are read through it rather
 * than tracked again here. Two copies of "how much AP does a new turn grant"
 * is how the two drift apart.
 */
export class TurnManager {
  selectedSoldier: Soldier | null = null

  onSelectionChanged?: (soldier: Soldier | null) => void

  constructor(
    private readonly world: World,
    readonly turns: TurnSystem,
    private readonly squads: Squads,
    private readonly rig: OrbitRig,
  ) {}

  get activeFaction(): Faction {
    return this.turns.activeFaction
  }

  get turnNumber(): number {
    return this.turns.turnNumber
  }

  autoSelectFirst(): void {
    const living = this.squads.getLiving(this.activeFaction)
    this.selectSoldier(living.length > 0 ? living[0]! : null)
  }

  selectSoldier(soldier: Soldier | null): void {
    if (soldier && (soldier.isDead || soldier.faction !== this.activeFaction)) return
    this.selectedSoldier = soldier
    if (soldier) {
      this.rig.focusOn(soldier.position)
    }
    this.onSelectionChanged?.(soldier)
  }

  /** Spend the unit's remaining AP and move on to one that still has some. */
  finishSoldierTurn(soldier: Soldier): void {
    this.turns.endUnitTurn(this.world, soldier.entityId)
    const next = this.squads.getLiving(this.activeFaction).find((s) => s.ap > 0)
    if (next) {
      this.selectSoldier(next)
    }
  }

  /** Hand over to the other faction, replenishing whoever is up next. */
  startNextTurn(): void {
    this.turns.endTurn(this.world)
    // Start turn with no character selected
    this.selectedSoldier = null
  }
}
