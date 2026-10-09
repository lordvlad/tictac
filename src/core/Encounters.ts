import { ENCOUNTER } from '../config'
import { defaultLoadout } from '../game/Loadout'
import type { Deployment } from '../game/Recording'
import { rollSquadSheets } from './Characters'
import { hashSeed, Rng } from './rng'
import { checkpoints, type Pace, type Waypoint } from './Travel'

/**
 * Wild alien encounters on the road (`ITEM-048`, GDD-WORLD §5): whether a
 * stretch of travel is found by something, and what comes. Pure and headless:
 * the same key and stretch give the same answer on every machine, so a
 * checkpoint handled twice (a restart between the roll and the save) is the
 * same contact twice, never two different ones.
 */

/** A stretch of travel being weighed: how long, how hard, through how dangerous a place. */
export interface Stretch {
  hours: number
  pace: Pace
  danger: number
}

/** Names a roll for good: this squad, on this trip, at this checkpoint. */
export interface EncounterKey {
  squad: string
  trip: string
  index: number
}

export type EncounterRoll =
  | { met: false }
  | {
      met: true
      /** Seeds the aliens' squad (`dealAliens`). */
      alienSeed: number
      /** How many more or fewer aliens than the player's party; the server clamps the total. */
      sizeOffset: -1 | 0 | 1
    }

const HOUR_MS = 3_600_000

/** The chance something finds a squad over this stretch, never past the ceiling. */
export function encounterChance(stretch: Stretch): number {
  const chance = ENCOUNTER.perHour * stretch.hours * ENCOUNTER.pace[stretch.pace] * stretch.danger
  return Math.min(Math.max(chance, 0), ENCOUNTER.ceiling)
}

/**
 * Roll a stretch. The stream is seeded from the key alone: a different
 * checkpoint, trip or squad is an independent roll, and none of this touches
 * the match stream (`matchDice`) a fight's dice come from.
 */
export function rollEncounter(key: EncounterKey, stretch: Stretch): EncounterRoll {
  const rng = new Rng(hashSeed(`${key.squad}|${key.trip}|${key.index}`))
  // Always draw all three, so the seed and size of a roll do not depend on
  // how likely the contact was: tuning the odds never reshuffles who came.
  const met = rng.next() < encounterChance(stretch)
  const alienSeed = rng.int(0, 0xffffffff)
  const sizeOffset = rng.pick([-1, 0, 1] as const)
  return met ? { met, alienSeed, sizeOffset } : { met }
}

/**
 * The aliens for a fight: sheets rolled from `seed` on the stock loadout, as
 * the header's `Deployment` entries. The same seed and size always deal the
 * same squad. They belong to no roster and are written nowhere.
 */
export function dealAliens(seed: number, size: number): Deployment[] {
  const sheets = rollSquadSheets(new Rng(seed), size)
  const loadout = defaultLoadout(sheets.length)
  return sheets.map((sheet, i) => ({ sheet, loadout: loadout[i]! }))
}

/**
 * What a checkpoint weighs: the hours since the one before it (or since the
 * trip set off, for the first), at the pace the squad was walking at the
 * time. Null for a checkpoint the route does not hold.
 */
export function stretchOf(
  waypoints: readonly Waypoint[],
  trip: string,
  index: number,
  danger: number = ENCOUNTER.dangerEverywhere,
): Stretch | null {
  const all = checkpoints(waypoints, trip)
  const checkpoint = all[index]
  if (!checkpoint) return null
  const departures = waypoints.flatMap((waypoint) =>
    waypoint.kind === 'past' && waypoint.departed?.trip === trip ? [waypoint.departed] : [],
  )
  const first = departures[0]
  if (!first) return null
  const since = index === 0 ? first.at : all[index - 1]!.at
  // A trip carried on through a waypoint may change gait; the stretch is walked
  // at the gait of the last departure before it ended.
  const gait = departures.findLast((departure) => departure.at < checkpoint.at) ?? first
  return { hours: (checkpoint.at - since) / HOUR_MS, pace: gait.gait.pace, danger }
}
