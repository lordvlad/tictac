import { Faction } from '../config'
import { type Growth, growthFrom } from '../core/Progression'
import type { Soldier } from '../entities/Soldier'

/** Anything that knows who is on which side. */
interface Sides {
  readonly byFaction: Record<Faction, readonly Soldier[]>
}

/**
 * The side left standing once the other has nobody, or null while both
 * still have somebody. A match with nobody left on either side (a blast
 * that took the last of both) has no winner either.
 */
export function winnerOf(squads: Sides): Faction | null {
  const standing = (faction: Faction) => squads.byFaction[faction].some((unit) => !unit.isDead)
  const blue = standing(Faction.Blue)
  const red = standing(Faction.Red)
  if (blue === red) return null
  return blue ? Faction.Blue : Faction.Red
}

/** One survivor and what the match taught them. */
export interface Debrief {
  unit: Soldier
  growth: Growth[]
}

/**
 * What the match taught the winning side's survivors (`core/Progression`):
 * worked out from state both peers hold, so each side can show it without
 * anything travelling. The dead learn nothing, and the losing side's
 * survivors are not grown in this pass (ITEM-004).
 */
export function debrief(squads: Sides, winner: Faction): Debrief[] {
  return squads.byFaction[winner]
    .filter((unit) => !unit.isDead)
    .map((unit) => ({ unit, growth: growthFrom(unit.sheet, unit.deeds) }))
}
