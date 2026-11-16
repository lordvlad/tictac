import type { Combatant } from '../core/Combatant'
import type { Grid, Tile } from '../core/Grid'

/**
 * What one step costs *this* unit.
 *
 * The terrain sets a price — a diagonal is dearer than a straight, a ladder
 * dearer than either — and the unit's condition scales it. Everything that
 * charges for a step goes through here, because a route planned at one price
 * and walked at another would strand a unit mid-path.
 */
export function stepCost(grid: Grid, from: Tile, to: Tile, moveCostMul: number): number {
  return grid.getStepCost(from, to) * moveCostMul
}

/** The same price, for callers holding the unit rather than its components. */
export function stepCostFor(grid: Grid, unit: Combatant, from: Tile, to: Tile): number {
  return stepCost(grid, from, to, unit.moveCostMul)
}

/**
 * How far a unit can plan, in the terrain's own prices.
 *
 * Routes are costed in terrain points, so a unit that pays more per step
 * affords fewer of them. Dividing the budget keeps every route cost, preview
 * and reachability answer in one currency rather than multiplying costs in some
 * places and not others.
 */
export function moveBudget(unit: Combatant): number {
  return unit.ap / unit.moveCostMul
}
