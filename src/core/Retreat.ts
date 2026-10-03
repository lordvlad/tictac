import { Faction, MORALE, RETREAT } from '../config'
import type { Combatant } from './Combatant'
import type { Grid, Tile } from './Grid'
import { eyesOf, sees } from './Visibility'

/**
 * Getting out of a fight (GDD combat §2.8, `ITEM-051`).
 *
 * A side's way out is the rows it deployed in, across the whole width of the
 * map: Blue's along the low-Y edge, Red's along the high-Y one. Worked out from
 * the map's size and the two constants deployment itself is drawn with, so the
 * client, a replay and the referee all agree without anything being stored —
 * `generateMap` throws its deployment zones away once the squads are placed.
 */

/** Rows between the map's edge and the first row a squad deploys in. */
export const DEPLOY_INSET = 2
/** Rows a deployment zone is deep. */
export const DEPLOY_ROWS = 3

/** The first and last row of `faction`'s way out, inclusive. */
export function wayOutRows(faction: Faction, size: number): { first: number; last: number } {
  if (faction === Faction.Blue) return { first: DEPLOY_INSET, last: DEPLOY_INSET + DEPLOY_ROWS - 1 }
  const last = size - 1 - DEPLOY_INSET
  return { first: last - DEPLOY_ROWS + 1, last }
}

/** Whether `tile` is on `faction`'s way out. */
export function onWayOut(faction: Faction, tile: Tile, size: number): boolean {
  const { first, last } = wayOutRows(faction, size)
  return tile.y >= first && tile.y <= last
}

/** Rows between `tile` and `faction`'s way out: zero on it. */
export function rowsFromWayOut(faction: Faction, tile: Tile, size: number): number {
  const { first, last } = wayOutRows(faction, size)
  if (tile.y < first) return first - tile.y
  if (tile.y > last) return tile.y - last
  return 0
}

/** Who would go if `faction` retreated now: everyone alive standing on its way out. */
export function leaversOf<T extends Combatant>(units: readonly T[], faction: Faction, size: number): T[] {
  return units.filter((unit) => unit.faction === faction && !unit.isDead && onWayOut(faction, unit.tile, size))
}

/** Why `faction` cannot retreat now, or null when it can. */
export function cannotRetreat(units: readonly Combatant[], faction: Faction, size: number): string | null {
  return leaversOf(units, faction, size).length === 0 ? 'nobody is standing on the way out' : null
}

/** Enemies of the leavers that can see at least one of them, each counted once. */
export function watchersOf(grid: Grid, units: readonly Combatant[], leavers: readonly Combatant[]): number {
  if (leavers.length === 0) return 0
  const faction = leavers[0]!.faction
  let watchers = 0
  for (const enemy of units) {
    if (enemy.isDead || enemy.faction === faction) continue
    const eyes = eyesOf(grid, enemy)
    if (leavers.some((leaver) => sees(grid, enemy.tile, eyes, leaver.tile))) watchers++
  }
  return watchers
}

/**
 * Percent chance an attempt succeeds: steadier and healthier leavers get away
 * more often, and every enemy watching them makes it harder. Whole numbers,
 * so both peers land on the same figure.
 */
export function retreatChance(leavers: readonly Combatant[], watchers: number): number {
  if (leavers.length === 0) return 0
  let morale = 0
  let hp = 0
  let maxHp = 0
  for (const unit of leavers) {
    morale += unit.morale
    hp += Math.max(0, unit.hp)
    maxHp += unit.maxHp
  }
  const moraleTerm = Math.round((RETREAT.morale * (2 * morale - leavers.length * MORALE.max)) / (leavers.length * MORALE.max))
  const healthTerm = maxHp > 0 ? Math.round((RETREAT.health * (2 * hp - maxHp)) / maxHp) : -RETREAT.health
  const chance = RETREAT.base + moraleTerm + healthTerm - RETREAT.perWatcher * watchers
  return Math.min(RETREAT.max, Math.max(RETREAT.min, chance))
}
