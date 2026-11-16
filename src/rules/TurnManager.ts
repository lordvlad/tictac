import type { Faction } from '../config'
import type { Soldier } from '../entities/Soldier'
import type { Squads } from './Squads'
import { settleTurn } from './Turn'
import { NO_FOCUS, type FocusPort } from '../core/Combatant'
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
    private readonly focus: FocusPort = NO_FOCUS,
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
      this.focus.focusOn(soldier.position)
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

  /**
   * Hand over to the other faction, replenishing whoever is up next.
   *
   * The settle happens here rather than in whatever noticed the switch. It
   * used to be the caller's job, and the headless host — which has no
   * `onTurnSwitched` to forget — simply never did it: statuses never expired
   * in a replay and a watch was held forever, so a recorded match and its
   * refight were two different games. A rule that every path must remember to
   * call is a rule that one path will not.
   */
  startNextTurn(): void {
    this.turns.advanceFaction()
    // Settled before the refill: statuses expire and exhaustion is charged
    // against the side going out, and a penalty that has just run out must not
    // dock the allowance handed over immediately afterwards.
    settleTurn(this.squads.soldiers, this.activeFaction)
    this.turns.replenish(this.world)
    // Start turn with no character selected
    this.selectedSoldier = null
  }
}
