import type { Faction } from '../config'
import type { Combatant } from './Combatant'
import { HEADINGS, headingToward } from './Facing'
import type { Grid, Tile } from './Grid'
import type { Noise } from './Noise'
import { eyesOf, sees } from './Visibility'

/**
 * What a unit knows is going on around it.
 *
 * - **Unaware**: has seen and heard nothing. Faces wherever it last turned.
 * - **Alerted**: has heard something, and turned toward it. Knows
 *   to look; does not know at what.
 * - **Engaged**: has seen an enemy, been shot at, fired, or fought. Normal
 *   combat. It does not wear off.
 *
 * State, not a view: it changes what a unit can react to (a watcher that is
 * not engaged only reacts to what is in front of it) and which way it faces
 * (hearing turns it), so both peers resolve it by the same rules from the same
 * events, and it is replicated and in the state digest like any component.
 */
export const Awareness = {
  Unaware: 0,
  Alerted: 1,
  Engaged: 2,
} as const
export type Awareness = (typeof Awareness)[keyof typeof Awareness]

/** Of its own turns an alerted unit spends hearing nothing new before it settles back down. */
export const CALM_AFTER = 2

/**
 * Whether something on `at` is in front of `unit`: strictly the half of the
 * world it faces. Level with its shoulders is not in front, and neither is
 * behind — a unit that is not engaged notices neither.
 */
export function inFront(unit: { tile: Tile; heading: number }, at: Tile): boolean {
  const [hx, hy] = HEADINGS[unit.heading] ?? HEADINGS[0]!
  return hx * (at.x - unit.tile.x) + hy * (at.y - unit.tile.y) > 0
}

/** Into the fight, for good. */
export function engage(unit: Combatant): void {
  unit.awareness = Awareness.Engaged
  unit.quietTurns = 0
}

/**
 * `unit` heard `noise`. Unless it is already fighting, it is alerted and turns
 * toward it — toward where the noise was, not at whoever made it, which is
 * the whole of what a thrown stone is for. The direction is to the nearest of
 * eight, which an ear manages; *where* along it is only ever known roughly.
 */
export function hear(unit: Combatant, noise: Noise): void {
  if (unit.awareness === Awareness.Engaged) return
  unit.awareness = Awareness.Alerted
  unit.quietTurns = 0
  unit.heading = headingToward(noise.at.x - unit.tile.x, noise.at.y - unit.tile.y, unit.heading)
}

/**
 * Who has now seen an enemy, and is engaged for it.
 *
 * Asked after everything that can change what anybody sees — every step,
 * every command, every handover. The side whose turn it is looks all round:
 * that is the player looking. The other side, waiting, notices only what is
 * in front of each unit — unless that unit is already engaged, when it is
 * watching everything. That asymmetry is what lets someone be approached from
 * behind at all: sight is otherwise all round, and a sentry would see you
 * step up beside it.
 *
 * Squad order and state both peers hold, so both reach the same answer.
 */
export function lookAround(grid: Grid, units: readonly Combatant[], active: Faction): void {
  for (const unit of units) {
    if (unit.isDead || unit.awareness === Awareness.Engaged) continue
    const eyes = eyesOf(grid, unit)
    const allRound = unit.faction === active
    for (const enemy of units) {
      if (enemy.isDead || enemy.faction === unit.faction) continue
      if (!allRound && !inFront(unit, enemy.tile)) continue
      if (!sees(grid, unit.tile, eyes, enemy.tile)) continue
      engage(unit)
      break
    }
  }
}

/**
 * A side's turn is over, and `incoming` is up: the outgoing side's alerted
 * units that heard nothing new this turn are a turn closer to settling back
 * down. Called from the one handover door, `settleTurn`.
 */
export function calmDown(units: readonly Combatant[], incoming: Faction): void {
  for (const unit of units) {
    if (unit.isDead || unit.faction === incoming || unit.awareness !== Awareness.Alerted) continue
    unit.quietTurns += 1
    if (unit.quietTurns >= CALM_AFTER) {
      unit.awareness = Awareness.Unaware
      unit.quietTurns = 0
    }
  }
}
