import { type Faction, MORALE } from '../config'
import type { Combatant } from './Combatant'
import type { Roll } from './rng'

/**
 * What a unit does when its nerve goes.
 *
 * - **Panic**: the rules take it over and it runs (`game/Breakdown`).
 * - **Frenzy**: the rules take it over and it charges (`game/Breakdown`).
 * - **Freeze**: its points drop to zero, and it does nothing.
 *
 * Which of them is rolled evenly; the character deciding panic or frenzy is
 * ITEM-033. A broken unit takes no orders — from the player, the wire or a
 * file — until it steadies.
 */
export const MoraleBreak = {
  Panic: 'panic',
  Frenzy: 'frenzy',
  Freeze: 'freeze',
} as const
export type MoraleBreak = (typeof MoraleBreak)[keyof typeof MoraleBreak]

/** In the order a break's kind is drawn from, which is part of the match's dice. */
const BREAKS: readonly MoraleBreak[] = [MoraleBreak.Panic, MoraleBreak.Frenzy, MoraleBreak.Freeze]

/** A unit that broke or steadied at a handover: the view says so, the rules already have. */
export interface MoraleChange<T extends Combatant = Combatant> {
  unit: T
  /** The break it went into, or null when it steadied. */
  broke: MoraleBreak | null
}

/** One unit's share of an attack, as resolved: what the attack did to its nerve is read off it. */
export interface Harm {
  soldier: Combatant
  damage: number
  killed: boolean
}

/**
 * Percent chance a unit with `morale` breaks when it rolls: nothing at steady
 * and above, then a fixed step per point short, so certain at zero.
 */
export function breakChance(morale: number): number {
  return Math.min(100, Math.max(0, MORALE.steady - morale) * MORALE.breakPerPoint)
}

/** Percent chance a unit broken for `turns` of its own turns steadies now. */
export function steadyChance(turns: number): number {
  return Math.min(100, MORALE.snapFirst + MORALE.snapStep * (turns - 1))
}

function shift(unit: Combatant, by: number): void {
  unit.morale = Math.min(MORALE.max, Math.max(0, unit.morale + by))
}

/**
 * What an attack by `by` did to everyone's nerve.
 *
 * Read off the resolved hits, so every path that hurts somebody — a shot, a
 * reaction, a blow, a blast — reports it the same way. A wound costs the
 * wounded in proportion to how much of them it took; a death costs every
 * squadmate and pays the killer and theirs. A round's `killed` stays true for
 * every later round on the corpse, so each death is counted once. `misses` is
 * the rounds that went past `target`, the count suppression already uses.
 */
export function shake(
  units: readonly Combatant[],
  by: Combatant,
  hits: readonly Harm[],
  target?: Combatant,
  misses = 0,
): void {
  const dead = new Set<Combatant>()
  for (const hit of hits) {
    const victim = hit.soldier
    if (hit.killed) {
      if (dead.has(victim)) continue
      dead.add(victim)
      for (const other of units) {
        if (other.isDead) continue
        if (other.faction === victim.faction) shift(other, -MORALE.mateDown)
        // Killing your own is not a kill. The victim's side is `by`'s side
        // exactly when it was friendly fire.
        else if (by.faction !== victim.faction) shift(other, other === by ? MORALE.kill : MORALE.enemyDown)
      }
    } else if (!victim.isDead && hit.damage > 0) {
      shift(victim, -Math.round((hit.damage * MORALE.wound) / victim.maxHp))
    }
  }
  if (target && !target.isDead && misses > 0) shift(target, -misses * MORALE.nearMiss)
}

/**
 * `incoming` is up: each of its units rolls, in squad order, from the match's
 * dice — a broken one to steady, anyone else short of steady to break.
 *
 * Draws only where the answer is in doubt: nobody rolls at full nerve, so a
 * match in which nobody was shaken draws exactly what it drew before morale
 * existed. A break is two draws, whether and which; steadying is one.
 *
 * Called after the incoming side's points are handed back, because a freeze
 * takes them away again. Returns what changed, in the order it happened.
 */
export function rollMorale<T extends Combatant>(units: readonly T[], incoming: Faction, roll: Roll): MoraleChange<T>[] {
  const changes: MoraleChange<T>[] = []
  for (const unit of units) {
    if (unit.isDead || unit.faction !== incoming) continue
    if (unit.broken) {
      unit.brokenTurns += 1
      const chance = steadyChance(unit.brokenTurns)
      if (chance >= 100 || roll() * 100 < chance) {
        unit.broken = null
        unit.brokenTurns = 0
        // Pulled together: back to where nothing is rolled, or it would be
        // rolling to break again on the turn it steadied.
        unit.morale = Math.max(unit.morale, MORALE.steady)
        changes.push({ unit, broke: null })
      }
    } else {
      const chance = breakChance(unit.morale)
      if (chance > 0 && (chance >= 100 || roll() * 100 < chance)) {
        const kind = BREAKS[Math.min(BREAKS.length - 1, Math.floor(roll() * BREAKS.length))]!
        unit.broken = kind
        unit.brokenTurns = 0
        changes.push({ unit, broke: kind })
      }
    }
    if (!unit.broken) shift(unit, MORALE.rally)
  }

  // Squadmates see it after every roll is made: one unit going is a blow to the
  // rest, but not one that can tip them this same handover.
  for (const { unit, broke } of changes) {
    if (!broke) continue
    for (const mate of units) {
      if (mate !== unit && !mate.isDead && mate.faction === unit.faction) shift(mate, -MORALE.mateBroke)
    }
  }
  for (const unit of units) {
    if (unit.isDead || unit.faction !== incoming || unit.broken !== MoraleBreak.Freeze) continue
    // Taken, not spent: freezing is not running yourself into the ground, so
    // the exhaustion count must not see it (as `forfeitTurn` does).
    const spent = unit.spentThisTurn
    unit.ap = 0
    unit.spentThisTurn = spent
  }
  return changes
}
