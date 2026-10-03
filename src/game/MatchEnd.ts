import { Faction } from '../config'
import { STATUSES } from '../core/Arsenal'
import type { Grid } from '../core/Grid'
import type { CharacterSheet } from '../core/Characters'
import { copyDeeds, type Deeds, grown, growthFrom, type Growth } from '../core/Progression'
import { Rng } from '../core/rng'
import type { Soldier } from '../entities/Soldier'

/** Anything that knows who is on which side. */
interface Sides {
  readonly byFaction: Record<Faction, readonly Soldier[]>
}

/**
 * The side left on the field once the other has nobody there, or null while
 * both still have somebody. A side leaves the field by being killed or by
 * retreating (`core/Retreat`): either way the side that stays has won. A match
 * with nobody left on either side (a blast that took the last of both) has no
 * winner either.
 */
export function winnerOf(squads: Sides): Faction | null {
  const standing = (faction: Faction) => squads.byFaction[faction].some((unit) => unit.onField)
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

/**
 * The losing side's units that retreated, and what the match taught them: the
 * one exception to "a side that lost learns nothing" (GDD combat §2.8). Empty
 * when the side was wiped out.
 */
export function escaped(squads: Sides, loser: Faction): Debrief[] {
  return squads.byFaction[loser]
    .filter((unit) => unit.withdrawn)
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
 * exists). When everyone was, anyone. Null when the side has nobody at all,
 * and null when it retreated: those who reached the edge got out on their own
 * feet, and whoever was left behind is lost.
 */
export function carriedOut(squads: Sides, loser: Faction, grid: Grid, seed: number): Soldier | null {
  const fallen = squads.byFaction[loser]
  if (fallen.length === 0 || fallen.some((unit) => unit.withdrawn)) return null
  const steady = fallen.filter(
    (unit) =>
      grid.fireAt(unit.tile.x, unit.tile.y) === 0 && !unit.statuses.some((state) => STATUSES[state.kind].ailment),
  )
  return new Rng((seed ^ SURVIVOR_STREAM) >>> 0).pick(steady.length > 0 ? steady : fallen)
}

/**
 * What became of one unit, in the squad order the roster is kept in.
 *
 * Four things worth knowing, not three: somebody who walked away and learned
 * from it, the one the losing side carried out, the dead — and, for every one
 * of them, this match's own service record and the hit points the match left
 * them with, which a roster stores regardless of who won.
 */
export type UnitFate =
  | { kind: 'survived'; sheet: CharacterSheet; hp: number; deeds: Deeds }
  | { kind: 'carried'; deeds: Deeds }
  | { kind: 'died'; hp: number; deeds: Deeds }

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
 * which is what permadeath costs (ITEM-004, ITEM-035) — unless it retreated:
 * then whoever got away comes back grown from what they did (`escaped`), and
 * whoever was left behind is gone.
 */
export function settlement(
  squads: Sides,
  winner: Faction,
  carried: Soldier | null,
): Record<Faction, UnitFate[]> {
  const loser = winner === Faction.Blue ? Faction.Red : Faction.Blue
  const growthByUnit = new Map<Soldier, Growth[]>()
  for (const { unit, growth } of debrief(squads, winner)) growthByUnit.set(unit, growth)
  for (const { unit, growth } of escaped(squads, loser)) growthByUnit.set(unit, growth)

  const fates = (faction: Faction): UnitFate[] =>
    squads.byFaction[faction].map((unit) => {
      const deeds = copyDeeds(unit.deeds)
      if (unit === carried) return { kind: 'carried', deeds }
      const growth = growthByUnit.get(unit)
      return growth
        ? { kind: 'survived', sheet: grown(unit.sheet, growth), hp: unit.hp, deeds }
        : { kind: 'died', hp: unit.hp, deeds }
    })

  return { [Faction.Blue]: fates(Faction.Blue), [Faction.Red]: fates(Faction.Red) }
}
