import type { Faction } from '../config'
import { RULES } from '../config'
import { StatusKind } from '../core/Arsenal'
import type { Combatant } from '../core/Combatant'
import { applyStatus, tickStatuses } from './Combat'

/**
 * Everything that happens when a side hands over.
 *
 * One door, for the same reason `fireWeapon` is one: a match and a simulation
 * disagreeing about what a turn boundary does would make every balance number
 * a statement about the harness. The order matters and is not arbitrary —
 * exhaustion is judged on the side going out, *then* statuses tick, so a
 * penalty earned this handover is already counting down.
 */
export function settleTurn(units: readonly Combatant[], incoming: Faction): void {
  for (const unit of units) {
    if (unit.isDead || unit.faction === incoming) continue
    accountExhaustion(unit)
  }

  tickStatuses(units)

  // The incoming side starts its allowance fresh. Its points are handed back
  // elsewhere — this only forgets what the last one cost, and that the unit
  // gave its position away by shooting.
  for (const unit of units) {
    if (unit.faction !== incoming) continue
    unit.spentThisTurn = 0
    unit.firedThisTurn = false
    // A watch is held for somebody else's turn. Coming round to your own is
    // the end of it — the points are yours to spend again.
    unit.watching = false
  }
}

/**
 * A unit's own turn ends: whatever it did not spend is gone.
 *
 * Forfeited is not the same as spent, and the difference is exhaustion —
 * standing still with points in hand is the opposite of running yourself into
 * the ground, so the count must not move. `TurnSystem.endUnitTurn` gets that
 * for free by writing the component behind the accounting; anything holding a
 * {@link Combatant} has to say so.
 */
export function forfeitTurn(unit: Combatant): void {
  const spent = unit.spentThisTurn
  unit.ap = 0
  unit.spentThisTurn = spent
}

/**
 * Charge a unit for running itself into the ground.
 *
 * Spending the lot once is a commitment; doing it again without a breather is
 * what costs. A unit that stopped short of its allowance has had its breather,
 * so the count resets rather than decaying — two hard turns in a row is the
 * thing being punished, not two hard turns in a match.
 */
function accountExhaustion(unit: Combatant): void {
  if (unit.spentThisTurn < unit.effectiveMaxAp) {
    unit.exhaustedTurns = 0
    return
  }

  unit.exhaustedTurns += 1
  if (unit.exhaustedTurns < RULES.exhaustionTurns) return

  applyStatus(unit, StatusKind.Winded)
  // Reset rather than left to climb: the status is the punishment, and leaving
  // the count high would re-apply it every turn from here on.
  unit.exhaustedTurns = 0
}
