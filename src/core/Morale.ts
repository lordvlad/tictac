import { type Faction, MORALE } from '../config'
import type { Combatant } from './Combatant'
import type { Roll } from './rng'
import { TraitId } from './Traits'

/**
 * What a unit does when its nerve goes.
 *
 * - **Panic**: the rules take it over and it runs (`game/Breakdown`).
 * - **Frenzy**: the rules take it over and it charges (`game/Breakdown`).
 * - **Freeze**: its points drop to zero, and it does nothing.
 *
 * A freeze is the mild end; further gone, a unit runs or charges as its
 * temperament takes it (see {@link breakKind}). A broken unit takes no
 * orders — from the player, the wire or a file — until it steadies.
 */
export const MoraleBreak = {
  Panic: 'panic',
  Frenzy: 'frenzy',
  Freeze: 'freeze',
} as const
export type MoraleBreak = (typeof MoraleBreak)[keyof typeof MoraleBreak]

/**
 * Which way a character goes when a break is more than a freeze: a hothead
 * charges, a skittish one runs. Dealt with the sheet, like the attributes.
 */
export const Temperament = {
  Hothead: 'hothead',
  Skittish: 'skittish',
} as const
export type Temperament = (typeof Temperament)[keyof typeof Temperament]

/** What a temperament is called, and what it means, as the loadout card says it. */
export const TEMPERAMENTS: Record<Temperament, { name: string; description: string }> = {
  [Temperament.Hothead]: {
    name: 'Hothead',
    description: 'Broken past a freeze, charges the nearest enemy it can see.',
  },
  [Temperament.Skittish]: {
    name: 'Skittish',
    description: 'Broken past a freeze, runs from the enemies it can see.',
  },
}

/**
 * The innate traits that change how morale moves rather than any combat
 * number (GDD §3). A character has at most one, rolled apart from the combat
 * trait.
 */
export const PREDISPOSITIONS = [TraitId.Daredevil, TraitId.Teamplayer, TraitId.Loner] as const
export type Predisposition = (typeof PREDISPOSITIONS)[number]

/** The unit's predisposition among `traits`, the first if a sheet names more than one. */
export function predispositionOf(traits: readonly TraitId[]): Predisposition | null {
  for (const id of traits) {
    if ((PREDISPOSITIONS as readonly TraitId[]).includes(id)) return id as Predisposition
  }
  return null
}

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
 * Which way a unit that breaks goes. Not rolled: the mild break is a freeze,
 * and a unit further gone than {@link MORALE.freezeAbove} runs or charges as
 * its temperament takes it. A daredevil always charges.
 */
export function breakKind(unit: Combatant): MoraleBreak {
  if (unit.predisposition === TraitId.Daredevil) return MoraleBreak.Frenzy
  if (unit.morale >= MORALE.freezeAbove) return MoraleBreak.Freeze
  return unit.temperament === Temperament.Hothead ? MoraleBreak.Frenzy : MoraleBreak.Panic
}

/**
 * A predisposition's pull at the start of the unit's own turn, before it
 * rolls: a daredevil lifted by long odds or its own wounds and bored by an
 * easy win; a teamplayer steadied by a squad that is still whole.
 */
function lean(unit: Combatant, units: readonly Combatant[]): void {
  if (unit.predisposition === TraitId.Daredevil) {
    let ours = 0
    let theirs = 0
    for (const other of units) {
      if (other.isDead) continue
      if (other.faction === unit.faction) ours++
      else theirs++
    }
    if (ours < theirs || unit.hp * 2 < unit.maxHp) shift(unit, MORALE.daredevilDire)
    else if (ours >= theirs + MORALE.daredevilBoredBy) shift(unit, -MORALE.daredevilBored)
  } else if (unit.predisposition === TraitId.Teamplayer) {
    const whole = units.every(
      (mate) => mate.isDead || mate.faction !== unit.faction || mate.hp * 2 > mate.maxHp,
    )
    if (whole) shift(unit, MORALE.teamplayerWhole)
  }
}

/**
 * Whether a squadmate who is a teamplayer, holding and within reach, is
 * steadying `unit`. Once however many there are: company, not a sum. A
 * loner takes nothing from it.
 */
function steadiedBy(unit: Combatant, units: readonly Combatant[]): boolean {
  if (unit.predisposition === TraitId.Loner) return false
  return units.some(
    (mate) =>
      mate !== unit &&
      !mate.isDead &&
      !mate.broken &&
      mate.faction === unit.faction &&
      mate.predisposition === TraitId.Teamplayer &&
      Math.max(Math.abs(mate.tile.x - unit.tile.x), Math.abs(mate.tile.y - unit.tile.y)) <= MORALE.teamplayerReach,
  )
}

/**
 * What an attack by `by` — or by nobody, for a fire — did to everyone's nerve.
 *
 * Read off the resolved hits, so every path that hurts somebody — a shot, a
 * reaction, a blow, a blast — reports it the same way. A wound costs the
 * wounded in proportion to how much of them it took; a death costs every
 * squadmate and pays the killer and theirs — except a loner, who feels
 * nothing of what happens to the squad and takes no share of its kills. A
 * round's `killed` stays true for every later round on the corpse, so each
 * death is counted once. `misses` is the rounds that went past `target`, the
 * count suppression already uses.
 */
export function shake(
  units: readonly Combatant[],
  by: Combatant | null,
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
        if (other.faction === victim.faction) {
          if (other.predisposition !== TraitId.Loner) shift(other, -MORALE.mateDown)
        }
        // Killing your own is not a kill, and nor is dying in a fire: `by` is
        // null for harm nobody did in person. A loner's own kill counts; the
        // squad's does not.
        else if (by && by.faction !== victim.faction) {
          if (other === by) shift(other, MORALE.kill)
          else if (other.predisposition !== TraitId.Loner) shift(other, MORALE.enemyDown)
        }
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
 * existed. A break is one draw, whether; which way it goes is the unit's
 * ({@link breakKind}). Steadying is one draw.
 *
 * Called after the incoming side's points are handed back, because a freeze
 * takes them away again. Returns what changed, in the order it happened.
 */
export function rollMorale<T extends Combatant>(units: readonly T[], incoming: Faction, roll: Roll): MoraleChange<T>[] {
  const changes: MoraleChange<T>[] = []
  for (const unit of units) {
    if (unit.isDead || unit.faction !== incoming) continue
    lean(unit, units)
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
        const kind = breakKind(unit)
        unit.broken = kind
        unit.brokenTurns = 0
        changes.push({ unit, broke: kind })
      }
    }
    if (!unit.broken) shift(unit, MORALE.rally + (steadiedBy(unit, units) ? MORALE.teamplayerAura : 0))
  }

  // Squadmates see it after every roll is made: one unit going is a blow to the
  // rest, but not one that can tip them this same handover.
  for (const { unit, broke } of changes) {
    if (!broke) continue
    for (const mate of units) {
      if (mate === unit || mate.isDead || mate.faction !== unit.faction) continue
      if (mate.predisposition !== TraitId.Loner) shift(mate, -MORALE.mateBroke)
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
