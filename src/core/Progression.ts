import { CHARACTER, PROGRESSION } from '../config'
import { WeaponId } from './Arsenal'
import type { Attributes, CharacterSheet } from './Characters'

/**
 * What a unit did in a match that it can learn from: its service record.
 *
 * Kept by the rules as the match is played (`DeedsComponent`, on both peers
 * from the same commands) and turned into growth once it is over — never
 * during it. Inside a match the part of a character that moves is morale.
 */
export interface Deeds {
  /** Rounds landed, by the weapon class that fired them: shots and reactions. */
  hits: Record<WeaponId, number>
  /** Of those, the ones that landed as criticals. */
  crits: Record<WeaponId, number>
  /** Enemies it killed, however. */
  kills: number
  /** Hit points it lost, to anything, fire included. */
  wounds: number
  /** Shots and blows landed on a target that was not in the fight yet, or from behind it. */
  unseen: number
  /** Its own turns spent to the last point without being winded. */
  pushed: number
  /** Blows landed with a sidearm. */
  blows: number
  /** Locked doors a shoulder of its broke in. */
  forced: number
  /** Tiles walked carrying gear that drags. */
  heavy: number
  /** Advanced kit worked: an item that asks for Intelligence, or the keys in a lock. */
  kit: number
}

const perWeapon = (): Record<WeaponId, number> =>
  Object.fromEntries(Object.values(WeaponId).map((id) => [id, 0])) as Record<WeaponId, number>

/** A record with nothing in it: how every unit starts a match. */
export function noDeeds(): Deeds {
  return { hits: perWeapon(), crits: perWeapon(), kills: 0, wounds: 0, unseen: 0, pushed: 0, blows: 0, forced: 0, heavy: 0, kit: 0 }
}

/** A plain copy of a record, detached from whatever holds it. */
export function copyDeeds(deeds: Deeds): Deeds {
  return { ...deeds, hits: { ...deeds.hits }, crits: { ...deeds.crits } }
}

export type Attribute = keyof Attributes

/** One thing that grew, from what to what, and why. */
export type Growth =
  | { kind: 'attribute'; attribute: Attribute; from: number; to: number; because: string }
  | { kind: 'proficiency'; weapon: WeaponId; from: number; to: number; because: string }

/**
 * How fast a character learns: Intelligence scaled onto
 * {@link PROGRESSION.learning}, a multiplier on every mark it earned. The
 * learning attribute of the GDD, and the one place it acts after a match.
 */
export function learningRate(intelligence: number): number {
  const { min, max } = CHARACTER.attribute
  const t = (Math.min(max, Math.max(min, intelligence)) - min) / (max - min)
  return PROGRESSION.learning.min + t * (PROGRESSION.learning.max - PROGRESSION.learning.min)
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`

/**
 * The marks each attribute earned from `deeds`, before the learning rate, and
 * what earned them — the sentence the end screen shows.
 */
function attributeMarks(deeds: Deeds): Record<Attribute, { marks: number; because: string }> {
  const heavyMarks = Math.floor(deeds.heavy / PROGRESSION.heavyTilesPerMark)
  return {
    health: { marks: deeds.wounds / PROGRESSION.woundsPerMark, because: `took ${deeds.wounds} damage and lived` },
    agility: {
      marks: deeds.unseen + deeds.pushed,
      because: [
        deeds.unseen > 0 ? `${plural(deeds.unseen, 'attack')} on the unaware or from behind` : '',
        deeds.pushed > 0 ? `${plural(deeds.pushed, 'turn')} spent to the last point` : '',
      ]
        .filter(Boolean)
        .join(', '),
    },
    strength: {
      marks: deeds.blows + PROGRESSION.forcedMarks * deeds.forced + heavyMarks,
      because: [
        deeds.blows > 0 ? plural(deeds.blows, 'blow') + ' landed' : '',
        deeds.forced > 0 ? plural(deeds.forced, 'door') + ' forced' : '',
        heavyMarks > 0 ? `${deeds.heavy} tiles in heavy kit` : '',
      ]
        .filter(Boolean)
        .join(', '),
    },
    intelligence: { marks: deeds.kit, because: `advanced kit worked ${plural(deeds.kit, 'time')}` },
  }
}

/**
 * What a match taught one survivor: a pure function of who they were going in
 * and what they did.
 *
 * An attribute rises a point when its marks, sped by Intelligence, reach
 * {@link PROGRESSION.marksPerPoint}; never more than one a match, never past
 * the top of the scale. A weapon class's proficiency rises a point for every
 * {@link PROGRESSION.hitsPerProficiency} rounds landed with it (a critical
 * counting as {@link PROGRESSION.critHits}), up to
 * {@link PROGRESSION.proficiencyPerMatch} a match and the top of its band.
 * The learning rate is read off the sheet going in, so what a match taught
 * does not depend on the order it is written down in.
 */
export function growthFrom(sheet: CharacterSheet, deeds: Deeds): Growth[] {
  const rate = learningRate(sheet.attributes.intelligence)
  const growth: Growth[] = []

  for (const weapon of Object.values(WeaponId)) {
    const landed = deeds.hits[weapon] + deeds.crits[weapon] * (PROGRESSION.critHits - 1)
    const earned = Math.min(PROGRESSION.proficiencyPerMatch, Math.floor((landed * rate) / PROGRESSION.hitsPerProficiency))
    const from = sheet.proficiency[weapon]
    const to = Math.min(CHARACTER.proficiency.max, from + earned)
    if (to <= from) continue
    const crits = deeds.crits[weapon]
    growth.push({
      kind: 'proficiency',
      weapon,
      from,
      to,
      because: `${plural(deeds.hits[weapon], 'round')} landed${crits > 0 ? `, ${crits} critical` : ''}`,
    })
  }

  const marks = attributeMarks(deeds)
  for (const attribute of ['health', 'agility', 'strength', 'intelligence'] as const) {
    const { marks: raw, because } = marks[attribute]
    if (raw * rate < PROGRESSION.marksPerPoint[attribute]) continue
    const from = sheet.attributes[attribute]
    if (from >= CHARACTER.attribute.max) continue
    growth.push({ kind: 'attribute', attribute, from, to: from + 1, because })
  }
  return growth
}

/** The sheet after `growth`: a new sheet, the one given untouched. */
export function grown(sheet: CharacterSheet, growth: readonly Growth[]): CharacterSheet {
  const attributes = { ...sheet.attributes }
  const proficiency = { ...sheet.proficiency }
  for (const change of growth) {
    if (change.kind === 'attribute') attributes[change.attribute] = change.to
    else proficiency[change.weapon] = change.to
  }
  return { ...sheet, attributes, proficiency }
}
