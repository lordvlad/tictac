import { Faction } from '../config'
import { STATUSES } from '../core/Arsenal'
import type { Grid } from '../core/Grid'
import type { CharacterSheet } from '../core/Characters'
import { grown, growthFrom, type Growth } from '../core/Progression'
import { Rng } from '../core/rng'
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
 * anything travelling. The dead learn nothing, and a side that lost learns
 * nothing either: losing is what permadeath is for (ITEM-004).
 */
export function debrief(squads: Sides, winner: Faction): Debrief[] {
  return squads.byFaction[winner]
    .filter((unit) => !unit.isDead)
    .map((unit) => ({ unit, growth: growthFrom(unit.sheet, unit.deeds) }))
}

/** Mixed into the match seed for the pick below: a stream of its own, not the match's dice. */
const SURVIVOR_STREAM = 0xc2b2ae35

/**
 * The one of the losing side who is carried out alive, on 1 HP: what a lost
 * match leaves its side, besides the lesson it cannot learn (ITEM-035).
 *
 * Drawn at random from a stream of the match seed — both peers pick the same
 * one without anything travelling, and the match's dice are the rules' alone.
 * Preferably somebody whose condition was not still getting worse when they
 * fell: lying in fire, or with an ailment on them (bleeding; poison when it
 * exists). When everyone was, anyone. Null when the
 * side has nobody at all, which does not happen in a squad.
 */
export function carriedOut(squads: Sides, loser: Faction, grid: Grid, seed: number): Soldier | null {
  const fallen = squads.byFaction[loser]
  if (fallen.length === 0) return null
  const steady = fallen.filter(
    (unit) =>
      grid.fireAt(unit.tile.x, unit.tile.y) === 0 && !unit.statuses.some((state) => STATUSES[state.kind].ailment),
  )
  return new Rng((seed ^ SURVIVOR_STREAM) >>> 0).pick(steady.length > 0 ? steady : fallen)
}

/**
 * What became of one unit, in the squad order the roster is kept in.
 *
 * Three outcomes, because there are three: somebody who walked away and
 * learned from it, the one the losing side carried out, and the dead.
 */
export type UnitFate =
  | { kind: 'survived'; sheet: CharacterSheet }
  | { kind: 'carried' }
  | { kind: 'died' }

/**
 * What the match did to both squads, as the roster has to record it.
 *
 * Pure, and derived from the same state both peers hold, so a client can show
 * it and the server can write it down without either taking the other's word.
 * The arrays are in squad-index order, which is roster slot order: `Squads`
 * builds `byFaction[f][i]` from `sheets[f][i]`.
 *
 * The winner's survivors come back {@link grown}; their dead do not come back.
 * The loser learns nothing, and keeps only whoever was {@link carriedOut} —
 * which is what permadeath costs (ITEM-004, ITEM-035).
 */
export function settlement(
  squads: Sides,
  winner: Faction,
  carried: Soldier | null,
): Record<Faction, UnitFate[]> {
  const growthByUnit = new Map<Soldier, Growth[]>()
  for (const { unit, growth } of debrief(squads, winner)) growthByUnit.set(unit, growth)

  const fates = (faction: Faction): UnitFate[] =>
    squads.byFaction[faction].map((unit) => {
      if (faction !== winner) return unit === carried ? { kind: 'carried' } : { kind: 'died' }
      const growth = growthByUnit.get(unit)
      return growth ? { kind: 'survived', sheet: grown(unit.sheet, growth) } : { kind: 'died' }
    })

  return { [Faction.Blue]: fates(Faction.Blue), [Faction.Red]: fates(Faction.Red) }
}
