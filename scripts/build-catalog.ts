/**
 * Generate the status, trait and worn-kit catalogue from the tables that
 * actually decide the game.
 *
 * Usage:
 *   bun run docs:catalog          # rewrite the catalogue
 *   bun run docs:catalog --check  # fail if the checked-in copy has drifted
 *
 * A hand-written catalogue is a second source of truth that starts wrong the
 * first time a number changes - which had already happened twice by the time
 * this existed: the docs named a wound trait that is a status, and quoted a
 * flat AP allowance that has been a range for weeks. This reads `STATUSES`,
 * `TRAITS`, `ITEMS` and the tunables, so the only way for it to be wrong is for
 * the game to be wrong.
 */
import { SHOT_MODES, STATUSES, type StatusSpec, WEAPONS, WeaponId } from '../src/core/Arsenal'
import { LONG_GUN_PARRY, MELEE, MeleeId } from '../src/core/Melee'
import { AIM, CHARACTER, COVER, CRIT, RULES, WOUNDS } from '../src/config'
import { ATTACHMENTS, AttachmentId } from '../src/core/Attachments'
import { ITEMS, ItemId } from '../src/core/Items'
import {
  TRAITS,
  type TraitEffects,
  type TraitId,
  resolveTraits,
  woundTraits,
} from '../src/core/Traits'
import { characterSheet } from '../src/core/Characters'
import { Rng } from '../src/core/rng'

const OUT = 'docs/design/gdd/status-and-trait-catalog.md'

/** Percentage points, signed, as a reader expects to see them. */
function points(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`
}

/** A fraction as a signed percentage: -0.25 becomes -25%. */
function percent(value: number): string {
  return `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`
}

/** A fraction as a plain percentage, for shares and chances where a sign is noise. */
function share(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** An inclusive range, spelled out, because "-8–+6" is unreadable. */
function range(min: number, max: number, signed = false): string {
  const show = signed ? points : (value: number): string => `${value}`
  return `${show(min)} to ${show(max)}`
}

function statusRow(spec: StatusSpec): string {
  const effects: string[] = []
  if (spec.accuracyPenalty) effects.push(`${points(-spec.accuracyPenalty)} to hit`)
  if (spec.defenceBonus) effects.push(`${points(-spec.defenceBonus)} to be hit`)
  if (spec.damageTakenBonus) effects.push(`${percent(spec.damageTakenBonus)} damage taken`)
  if (spec.apBonus) effects.push(`${percent(spec.apBonus)} AP`)
  return `| \`${spec.kind}\` | ${spec.name} | ${effects.join(', ') || '—'} | ${spec.turns} | ${spec.maxStacks} |`
}

/** Everything a trait changes, in the order a reader cares about. */
function traitEffects(effects: TraitEffects): string {
  const parts: string[] = []
  if (effects.accuracy) parts.push(`${points(effects.accuracy)} accuracy`)
  if (effects.accuracyCrouched) parts.push(`${points(effects.accuracyCrouched)} accuracy crouched`)
  if (effects.evasion) parts.push(`${points(effects.evasion)} evasion`)
  if (effects.evasionCrouched) parts.push(`${points(effects.evasionCrouched)} evasion crouched`)
  if (effects.critChance) parts.push(`${points(effects.critChance)} crit chance`)
  if (effects.critMultiplier) parts.push(`${effects.critMultiplier > 0 ? '+' : ''}${effects.critMultiplier} crit multiplier`)
  if (effects.critImmune) parts.push('cannot be crit')
  if (effects.maxHp) parts.push(`${points(effects.maxHp)} max HP`)
  if (effects.maxAp) parts.push(`${points(effects.maxAp)} max AP`)
  if (effects.armor) parts.push(`${points(effects.armor)} armour`)
  if (effects.damageTaken) parts.push(`${percent(effects.damageTaken)} damage taken`)
  if (effects.moveCost) parts.push(`${percent(effects.moveCost)} step cost`)
  if (effects.rangeFalloff) parts.push(`${percent(effects.rangeFalloff)} range falloff`)
  if (effects.silenced) parts.push('firing does not reveal')
  if (effects.unreadable) parts.push('being shot at does not reveal')
  return parts.join(', ') || '—'
}

/** Which traits a character can be born with, read off the roller. */
function innateTraitIds(): Set<TraitId> {
  const innate = new Set<TraitId>()
  // The roller picks from its own private list, so this asks it rather than
  // restating it: any trait it can deal turns up here within a few thousand
  // draws, and a trait it cannot never will.
  for (let seed = 1; seed <= 4000; seed++) {
    for (const id of characterSheet(new Rng(seed)).traits) innate.add(id)
  }
  return innate
}

function wornTraitIds(): Map<TraitId, ItemId> {
  const worn = new Map<TraitId, ItemId>()
  for (const id of Object.values(ItemId)) {
    for (const trait of ITEMS[id].traits ?? []) worn.set(trait, id)
  }
  return worn
}

function fittedTraitIds(): Map<TraitId, AttachmentId> {
  const fitted = new Map<TraitId, AttachmentId>()
  for (const id of Object.values(AttachmentId)) {
    for (const trait of ATTACHMENTS[id].traits) fitted.set(trait, id)
  }
  return fitted
}

function woundTraitIds(): Set<TraitId> {
  const wounds = new Set<TraitId>()
  for (const id of woundTraits(1, 100)) wounds.add(id)
  for (const id of woundTraits(40, 100)) wounds.add(id)
  return wounds
}

function build(): string {
  const innate = innateTraitIds()
  const worn = wornTraitIds()
  const fitted = fittedTraitIds()
  const wounds = woundTraitIds()

  const source = (id: TraitId): string => {
    const from: string[] = []
    if (innate.has(id)) from.push('born with')
    if (wounds.has(id)) from.push('wound')
    const item = worn.get(id)
    if (item) from.push(`worn (${ITEMS[item].name})`)
    const mod = fitted.get(id)
    if (mod) from.push(`fitted (${ATTACHMENTS[mod].name})`)
    return from.join(', ') || 'unreachable'
  }

  const lines: string[] = []
  lines.push('---')
  lines.push('title: "GDD: Status, Trait & Worn Kit Catalogue"')
  lines.push('id: "GDD-CATALOG"')
  lines.push('type: "gdd"')
  lines.push('status: "active"')
  lines.push(`lastReviewed: "${new Date().toISOString().slice(0, 10)}"`)
  lines.push('appliesTo:')
  lines.push('  - "src/core/Arsenal.ts"')
  lines.push('  - "src/core/Traits.ts"')
  lines.push('  - "src/core/Attachments.ts"')
  lines.push('  - "src/core/Items.ts"')
  lines.push('  - "src/core/Melee.ts"')
  lines.push('  - "src/config.ts"')
  lines.push('relatedDocs:')
  lines.push('  - "docs/architecture/combat-and-rules.md"')
  lines.push('  - "docs/design/gdd/combat-mechanics.md"')
  lines.push('tags: ["statuses", "traits", "equipment", "attachments", "reference", "generated"]')
  lines.push('---')
  lines.push('')
  lines.push('# GDD: Status, Trait & Worn Kit Catalogue')
  lines.push('')
  lines.push(
    '> **Generated** by `bun run docs:catalog` from `STATUSES`, `TRAITS`, `ITEMS` and the',
  )
  lines.push(
    '> tunables in `src/config.ts`. Do not edit by hand — `bun test tests/catalog.test.ts`',
  )
  lines.push('> fails when this file and the code disagree.')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 1. Statuses')
  lines.push('')
  lines.push(
    'Temporary, and they tick down. One tick happens per handover, so a status lasting',
  )
  lines.push(
    'two covers roughly one full round. Every number is **per stack**, and a status that',
  )
  lines.push('is not meant to pile up says `1`.')
  lines.push('')
  lines.push('| Id | Name | Per stack | Turns | Max stacks |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const spec of Object.values(STATUSES)) lines.push(statusRow(spec))
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 2. Traits')
  lines.push('')
  lines.push(
    'Lasting, and additive: numbers from every source add, flags are true if any source',
  )
  lines.push(
    'sets them. A trait never records where it came from, which is what lets a character',
  )
  lines.push('be born with the same property a piece of kit grants.')
  lines.push('')
  lines.push('| Id | Name | Effects | Source |')
  lines.push('| --- | --- | --- | --- |')
  for (const spec of Object.values(TRAITS)) {
    lines.push(`| \`${spec.id}\` | ${spec.name} | ${traitEffects(spec.effects)} | ${source(spec.id)} |`)
  }
  lines.push('')
  lines.push('### 2.1 Conditional effects')
  lines.push('')
  lines.push(
    'The `crouched` effects apply only while the unit is crouching, and are added by the',
  )
  lines.push(
    "unit's own accessors rather than folded into the replicated numbers, because stance",
  )
  lines.push('changes constantly and already replicates.')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 3. Weapon rails and fitted kit')
  lines.push('')
  lines.push(
    'A rail belongs to a weapon, not to a soldier: hand the rifle over and its glass goes',
  )
  lines.push(
    'with it. Rail space is a property of the weapon class - a service rifle is built as a',
  )
  lines.push('platform, a hunting shotgun has a bead and a barrel.')
  lines.push('')
  lines.push('| Weapon | Slots |')
  lines.push('| --- | --- |')
  for (const id of Object.values(WeaponId)) {
    lines.push(`| ${WEAPONS[id].name} | ${WEAPONS[id].slots} |`)
  }
  lines.push('')
  lines.push('| Attachment | Slots | Grants | Net effect |')
  lines.push('| --- | --- | --- | --- |')
  for (const id of Object.values(AttachmentId)) {
    const spec = ATTACHMENTS[id]
    lines.push(
      `| ${spec.name} | ${spec.slots} | ${spec.traits.map((t) => TRAITS[t].name).join(', ')} | ${traitEffects(resolveTraits(spec.traits))} |`,
    )
  }
  lines.push('')
  lines.push('A weapon refuses a duplicate as well as an overflow: two scopes is not twice the')
  lines.push('glass, and the additive fold would count it twice.')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 4. Body-worn kit')
  lines.push('')
  lines.push(
    'Marked `passive`: no action of its own, never listed in the action panel, and it',
  )
  lines.push(
    'earns its pouch slot by what carrying it does. Nothing worn or fitted is',
  )
  lines.push(
    'unconditionally free — each piece either costs something outright or pays only in one',
  )
  lines.push('stance.')
  lines.push('')
  lines.push('| Item | Grants | Net effect |')
  lines.push('| --- | --- | --- |')
  for (const id of Object.values(ItemId)) {
    const spec = ITEMS[id]
    if (!spec.passive) continue
    const granted = spec.traits ?? []
    lines.push(
      `| ${spec.name} | ${granted.map((t) => TRAITS[t].name).join(', ')} | ${traitEffects(resolveTraits(granted))} |`,
    )
  }
  lines.push('')
  lines.push('### 4.1 Consumables, for contrast')
  lines.push('')
  lines.push('| Item | AP | Needs | Effects |')
  lines.push('| --- | --- | --- | --- |')
  for (const id of Object.values(ItemId)) {
    const spec = ITEMS[id]
    if (spec.passive) continue
    const effects = spec.effects.map((effect) => effect.kind).join(', ')
    // A requirement nobody can read is a + that refuses for no stated reason,
    // which is the same class of drift as an effect the generator forgets.
    const needs =
      spec.minIntelligence === undefined ? '—' : `Intelligence ${spec.minIntelligence}`
    lines.push(`| ${spec.name} | ${spec.apCost} | ${needs} | ${effects || '—'} |`)
  }
  lines.push('')
  lines.push('### 4.2 Utility proficiencies')
  lines.push('')
  lines.push(
    'Training rather than physique, rolled per character and scaling exactly one thing each.',
  )
  lines.push('')
  lines.push('| Discipline | Scales | Whose |')
  lines.push('| --- | --- | --- |')
  lines.push(
    `| Medical | HP an item restores, when used on somebody else | the user's |`,
  )
  lines.push(`| Demolitions | Blast radius and armour shred of ordnance thrown | the thrower's |`)
  lines.push(`| Mechanics | Armour repaired, and what a repair costs in AP | the user's |`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 5. Weapons')
  lines.push('')
  // The model in one paragraph, with the constants it quotes read from the
  // tables that decide it, so a retune cannot leave the prose behind.
  lines.push(
    'Every round is one or more straight lines. A projectile lands with probability',
  )
  lines.push(
    '`w² / (w² + e²)`, where `e = (sway + spread × distance) × mode multiplier × training`',
  )
  lines.push(
    `(each point of training takes ${share(AIM.trainingTighten)} off, \`AIM.trainingTighten\`) and \`w\` is the target's`,
  )
  lines.push(
    `half-width: ${AIM.targetSize} m (\`AIM.targetSize\`) times the share cover and stance leave showing —`,
  )
  lines.push(
    `\`COVER\`: ${share(COVER.openCrouch)} crouched in the open, ${share(COVER.lowStand)} / ${share(COVER.lowCrouch)} standing / crouched behind low cover,`,
  )
  lines.push(
    `${share(COVER.tallStand)} / ${share(COVER.tallCrouch)} behind tall. A round lands if any of its projectiles does, and armour is`,
  )
  lines.push('subtracted once per round, not per projectile.')
  lines.push('')
  lines.push(
    '| Weapon | AP | Damage | Pellets | Armour pen | Sway (m) | Spread (m per m) | Max range | Clip | Crit | Crit × | Modes (error ×, AP ×) |',
  )
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const id of Object.values(WeaponId)) {
    const w = WEAPONS[id]
    const modes = w.availableModes
      .map((mode) => `${SHOT_MODES[mode].name} (×${SHOT_MODES[mode].spreadMul}, ×${SHOT_MODES[mode].apMul})`)
      .join(', ')
    lines.push(
      `| ${w.name} | ${w.apCost} | ${w.damage} | ${w.pellets} | ${share(w.armorPen)} | ${w.sway} | ${w.spread} | ${w.maxRange} m | ${w.maxClip} | ${w.critChance}% | ${w.critMultiplier} | ${modes} |`,
    )
  }
  lines.push('')
  lines.push(
    `Overwatch fires as ${SHOT_MODES.reaction.name} (×${SHOT_MODES.reaction.spreadMul} error, ×${SHOT_MODES.reaction.apMul} AP), which no weapon lists as a mode of its own.`,
  )
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 6. Sidearms')
  lines.push('')
  lines.push(
    'Carried in their own slot beside the primary weapon; an empty slot is fists. A blow reaches a',
  )
  lines.push(
    'neighbouring tile on the same level, and its chance has no range and no cover term. The',
  )
  lines.push("defender's parry is their sidearm's plus their primary weapon's handling. From behind")
  lines.push("the defender's parry, evasion and status defence do not count, and the damage is")
  lines.push('multiplied by the sidearm\'s own "From behind".')
  lines.push('')
  lines.push('| Sidearm | AP | Chance | Parry | Damage | From behind | Armour pen | Shred | Crit | Crit × | Loud |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const id of Object.values(MeleeId)) {
    const m = MELEE[id]
    lines.push(
      `| ${m.name} | ${m.apCost} | ${m.accuracy}% | ${points(m.parry)} | ${m.damage} | ×${m.fromBehind} | ${share(m.armorPen)} | ${m.armorShred} | ${m.critChance}% | ${m.critMultiplier} | ${m.loud ? 'yes' : 'no'} |`,
    )
  }
  lines.push('')
  lines.push('| Primary weapon | Parry when held |')
  lines.push('| --- | --- |')
  for (const id of Object.values(WeaponId)) lines.push(`| ${WEAPONS[id].name} | ${points(LONG_GUN_PARRY[id])} |`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 7. Where the numbers come from')
  lines.push('')
  lines.push('| Rule | Value | Source |')
  lines.push('| --- | --- | --- |')
  lines.push(`| Wound: limping at or below | ${share(WOUNDS.limping)} of max HP | \`WOUNDS.limping\` |`)
  lines.push(
    `| Wound: concussed at or below | ${share(WOUNDS.concussed)} of max HP | \`WOUNDS.concussed\` |`,
  )
  lines.push(
    `| Exhaustion after | ${RULES.exhaustionTurns} consecutive turns spending every point | \`RULES.exhaustionTurns\` |`,
  )
  lines.push(`| Hit points rolled | ${range(CHARACTER.hp.min, CHARACTER.hp.max)} | \`CHARACTER.hp\` |`)
  lines.push(`| Action points rolled | ${range(CHARACTER.ap.min, CHARACTER.ap.max)} | \`CHARACTER.ap\` |`)
  lines.push(
    `| Evasion rolled | ${range(CHARACTER.evasion.min, CHARACTER.evasion.max)} | \`CHARACTER.evasion\` |`,
  )
  lines.push(
    `| Weapon-class accuracy rolled | ${range(CHARACTER.proficiency.min, CHARACTER.proficiency.max, true)}, ${points(CHARACTER.specialistBonus)} for the trained class | \`CHARACTER.proficiency\` |`,
  )
  lines.push(
    `| Chance of an innate trait | ${share(CHARACTER.traitChance)} | \`CHARACTER.traitChance\` |`,
  )
  lines.push(
    `| Utility proficiency rolled | ${range(CHARACTER.utility.min, CHARACTER.utility.max, true)}% | \`CHARACTER.utility\` |`,
  )
  lines.push(
    `| Gear penalty Strength cancels | ${range(CHARACTER.gearRelief.min, CHARACTER.gearRelief.max)}% | \`CHARACTER.gearRelief\` |`,
  )
  lines.push(
    `| Blow chance Strength adds | ${range(CHARACTER.meleeSkill.min, CHARACTER.meleeSkill.max, true)} points | \`CHARACTER.meleeSkill\` |`,
  )
  lines.push(
    `| Blow damage Strength adds | ${range(CHARACTER.meleePower.min, CHARACTER.meleePower.max, true)}% | \`CHARACTER.meleePower\` |`,
  )
  lines.push(`| Crit chance clamp | ${range(CRIT.min, CRIT.max)}% | \`CRIT\` |`)
  lines.push(
    `| Crit range swing | ${points(CRIT.rangeSwing)} at either end of a weapon's reach | \`CRIT.rangeSwing\` |`,
  )
  lines.push('')
  return lines.join('\n')
}

const rendered = build()

if (process.argv.includes('--check')) {
  const current = await Bun.file(OUT).text().catch(() => '')
  // The review date is stamped on generation, so comparing it would fail every
  // day. Everything else has to match.
  const strip = (text: string): string => text.replace(/^lastReviewed: .*$/m, '')
  if (strip(current) !== strip(rendered)) {
    console.error(`[docs:catalog] ${OUT} is out of date — run: bun run docs:catalog`)
    process.exit(1)
  }
  console.info(`[docs:catalog] ${OUT} is in step with the code`)
} else {
  await Bun.write(OUT, rendered)
  console.info(`[docs:catalog] wrote ${OUT}`)
}
