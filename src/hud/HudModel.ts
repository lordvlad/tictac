import { AIM, FACTION_INFO, Faction, RULES } from '../config'
import { GrenadeId, ShotMode, STATUSES } from '../core/Arsenal'
import { ITEMS, type ItemEffect, ItemId, itemApCost, itemTargetsAlly } from '../core/Items'
import { UtilityId } from '../core/Characters'
import { effectiveWeapon, type HitChanceBreakdown, statusStacks } from '../core/Ballistics'
import type { MeleeId } from '../core/Melee'
import { clamp } from '../core/math'
import { canWatch, watchCost } from '../game/Overwatch'
import { TRAITS, woundTraits } from '../core/Traits'
import type { OrbitRig } from '../camera/OrbitRig'
import type { Soldier } from '../entities/Soldier'
import type { PendingThrow } from '../game/GrenadePlanner'
import type { PendingShot } from '../game/ShootPlanner'
import type { Squads } from '../game/Squads'
import type { TurnManager } from '../game/TurnManager'
import type { OffscreenPortraits } from '../render/Portraits'
/**
 * Everything the player can ask for by touching the HUD. The HUD emits these;
 * it never carries them out, so game state has exactly one mutator.
 */
export type HudIntent =
  | { type: 'selectUnit'; index: number }
  | { type: 'shoot' }
  | { type: 'cancelShoot' }
  | { type: 'selectTarget'; index: number }
  | { type: 'fireShot'; mode: ShotMode }
  /** The sidearm blow at the target being aimed at; offered only in reach. */
  | { type: 'meleeAttack' }
  /** Start aiming a blow at the best enemy in reach. */
  | { type: 'strike' }
  | { type: 'reload' }
  | { type: 'armGrenade'; kind: GrenadeId }
  | { type: 'useItem'; itemId: ItemId }
  | { type: 'confirmItem' }
  | { type: 'cancelItem' }
  | { type: 'confirmThrow' }
  | { type: 'cancelGrenade' }
  | { type: 'toggleCover' }
  | { type: 'overwatch' }
  | { type: 'toggleWaypoints' }
  | { type: 'endUnitTurn' }
  | { type: 'requestTurnSwitch' }
  | { type: 'confirmTurnSwitch' }
  | { type: 'toggleFreelook' }
  | { type: 'toggleUnitView' }
  | { type: 'openDebug' }
  | { type: 'selectLevel'; level: number }
  | { type: 'toggleDebugMap' }
/** One button in the selected unit's action panel. */
export interface HudAction {
  id: string
  label: string
  /** Icon name under public/icons, without the extension. */
  icon: string
  tag: string
  active: boolean
  disabled: boolean
  /**
   * Rows the panel folds into one submenu. Consumables always; grenades only
   * when the unit carries more than one kind, since a submenu holding a single
   * row is a tap for nothing.
   */
  group?: 'items' | 'grenades'
  /**
   * Pressing this starts by picking who it is used on, rather than doing it.
   * Shown on the row so the player knows before pressing.
   */
  targeted?: boolean
  intent: HudIntent
}

/** A status in force on a unit, as the card shows it. */
export interface HudStatusChip {
  name: string
  /** What it is doing, for the tooltip: a name alone explains nothing. */
  detail: string
  /** Drawn as a benefit rather than a warning. */
  good: boolean
}

export interface HudSquadCard {
  index: number
  name: string
  hp: number
  maxHp: number
  ap: number
  maxAp: number
  armor: number
  maxArmor: number
  portrait: string
  selected: boolean
  dead: boolean
  /** Whatever is currently in force on the unit, ordered as applied. */
  statuses: HudStatusChip[]
}

/** One unit in the target strip: an enemy to shoot, or a squadmate to treat. */
export interface HudTargetIcon {
  index: number
  name: string
  portrait: string
  hpFraction: number
  armorFraction: number
  /** Null when the strip is picking a patient: nothing is being rolled for. */
  hitChance: number | null
  selected: boolean
  /** False until this side has worked the unit out. */
  known: boolean
}

/** One line of the "why is my chance this bad" breakdown. */
export interface HudShotTerm {
  label: string
  value: string
  /** Icon name under public/icons, when the term has one of its own. */
  icon?: string
  /** Negative terms are drawn in the danger colour. */
  penalty: boolean
}

/**
 * What every way of shooting this target shares.
 *
 * Split out because it used to be repeated on every option card: the same
 * weapon, the same range, the same cover, five times over, with one line
 * between them that actually differed.
 */
export interface HudShotBase {
  /** Chance with no shot mode applied. */
  chance: number
  /** Damage a single hit does, which no mode changes. */
  damage: number
  armorShred: number
  /** Chance a hit lands as a critical, after range and the target's armour. */
  critChance: number
  /** What a critical multiplies the round by. */
  critMultiplier: number
  /**
   * The target cannot be crit at all. Stated rather than folded into a zero
   * chance, because a 0% with a multiplier beside it reads as bad luck when it
   * is actually a rule.
   */
  critImmune: boolean
  /** Damage a critical does, after the target's armour. */
  critDamage: number
  terms: HudShotTerm[]
}

/** One way of shooting, and only what choosing it changes. */
export interface HudShotOption {
  mode: ShotMode
  name: string
  hitChance: number
  /** Percentage points this mode puts on, or takes off, the base chance. */
  chanceDelta: number
  /** Damage with every bullet landing — what the bullet count buys. */
  damageAtBest: number
  apCost: number
  bullets: number
  available: boolean
  outOfRange: boolean
}

/** The sidearm blow, as the row beside the shot modes shows it. */
export interface HudStrikeOption {
  /** Which sidearm, so the row can show its icon. */
  sidearm: MeleeId
  name: string
  hitChance: number
  apCost: number
  /** Damage a landed blow does, after the target's armour. */
  damage: number
}

/** The target being aimed at: the shared picture, then a row per way to shoot. */
export interface HudShotPanel {
  targetName: string
  targetHp: number
  targetArmor: number
  /**
   * Whether this side has worked the target out.
   *
   * False hides what the *sheet* says - how hard it is to hit - while leaving
   * the resolved chance and the observable damage alone. Guessing a number and
   * showing it would be worse than admitting to not knowing: the player would
   * act on it.
   */
  targetKnown: boolean
  weaponName: string
  ammoName: string
  currentClip: number
  maxClip: number
  base: HudShotBase
  options: HudShotOption[]
  /**
   * The blow, when the target is in reach. Its own row rather than another
   * {@link HudShotOption}: none of the shared picture above it — range, cover,
   * the rifle's crit — has anything to do with a knife, so it carries its
   * whole answer on the row.
   */
  strike: HudStrikeOption | null
}

/** The throw lined up and awaiting confirmation. */
export interface HudThrowPanel {
  name: string
  /** Which grenade, so the panel can show its icon. */
  kind: GrenadeId
  apCost: number
  radius: number
  remaining: number
  affordable: boolean
  inRange: boolean
  statusName: string | null
  caught: { name: string; friendly: boolean; damage: number; armorShred: number; lethal: boolean }[]
}

/** The item being aimed at a squadmate, and who it would be used on. */
export interface HudItemPanel {
  name: string
  /** Which item, so the panel can show its icon. */
  itemId: ItemId
  apCost: number
  remaining: number
  affordable: boolean
  /** The squadmate picked, or null while the player is still choosing. */
  targetName: string | null
  /**
   * What it would do, in words rather than figures: how much a kit restores
   * is scaled by the user's training, so a number here would not be the
   * number applied.
   */
  effects: string[]
}

/** Immutable snapshot of what the HUD should show right now. */
export interface HudModel {
  isMyTurn: boolean
  networkMode: string
  factionName: string
  networkBadge: string
  factionIsBlue: boolean
  turnNumber: number
  seedLabel: string
  squad: HudSquadCard[]
  selectedName: string | null
  actions: HudAction[]
  /** Enemies to shoot, or squadmates to treat; drives the strip above the squad bar. */
  targets: HudTargetIcon[]
  /** Populated when a target is lined up; replaces the action list. */
  shotPanel: HudShotPanel | null
  /** Populated while a grenade is armed; also replaces the action list. */
  throwPanel: HudThrowPanel | null
  /** Populated while an item is aimed at a squadmate; also replaces it. */
  itemPanel: HudItemPanel | null
  freelookActive: boolean
  unitViewActive: boolean
  selectedLevelFilter: number
  /** Highest storey the map has, so the selector can offer one button each. */
  topLevel: number
  waypointActive: boolean
  unitViewEnabled: boolean
  nextFactionName: string
  debugMapOpen: boolean
}

export interface HudModelSources {
  turnManager: TurnManager
  squads: Squads
  rig: OrbitRig
  portraits: OffscreenPortraits
  seedLabel: string
  shootActive: boolean
  /**
   * Whether pressing Shoot would do anything: a round affordable, or an enemy
   * in reach of the sidearm. The planner's answer, because the second half
   * needs the map.
   */
  shootReady: boolean
  /**
   * The sidearm, when an enemy is in reach of it — the only time a Strike
   * button is worth a row in the panel.
   */
  strikeReady: { sidearm: MeleeId; name: string; apCost: number } | null
  waypointActive: boolean
  /** Shoot-mode state, when shoot mode is on. */
  shoot: ShootSnapshot | null
  /** The armed grenade and its aimed blast, when one is armed. */
  grenade: { armed: GrenadeId | null; pending: PendingThrow | null }
  /** The item awaiting a patient, when one is being aimed. */
  item: ItemTargetSnapshot | null
  networkMode?: string
  /** The player's unit-view toggle. Aiming moves the camera without setting it. */
  unitViewRequested: boolean
  myFaction?: Faction
  selectedLevelFilter: number
  topLevel: number
  debugMapOpen: boolean
}

/** What the model builder needs from the shoot planner. */
export interface ShootSnapshot {
  targets: { soldier: Soldier; hitChance: number }[]
  pending: PendingShot | null
}

/** What the model builder needs about an item being aimed at a squadmate. */
export interface ItemTargetSnapshot {
  itemId: ItemId
  /** Squadmates the user can reach, the user included. */
  candidates: readonly Soldier[]
  /** The one picked, or null while the player is still choosing. */
  target: Soldier | null
}

/**
 * Project game state into the HUD's snapshot.
 *
 * Action availability lives here rather than in the markup: whether "Shoot" is
 * affordable is a game rule, and the previous template asked the question with a
 * literal `ap < 4` of its own.
 */
export function buildHudModel(sources: HudModelSources): HudModel {
  const { turnManager, squads, rig, portraits, seedLabel, shootActive, waypointActive, shoot } =
    sources
  const faction = turnManager.activeFaction
  const selected = turnManager.selectedSoldier
  const nextFaction = faction === Faction.Blue ? Faction.Red : Faction.Blue

  const displayFaction =
    sources.networkMode && sources.networkMode !== 'local' && sources.myFaction !== undefined
      ? sources.myFaction
      : faction

  const squad: HudSquadCard[] = squads.byFaction[displayFaction].map((soldier, index) => ({
    index,
    name: soldier.name,
    hp: soldier.hp,
    maxHp: soldier.maxHp,
    ap: soldier.ap,
    maxAp: soldier.effectiveMaxAp,
    armor: soldier.armor,
    maxArmor: soldier.maxArmor,
    portrait: portraits.getPortrait(displayFaction, index),
    selected: soldier === selected,
    dead: soldier.isDead,
    statuses: statusChips(soldier),
  }))

  const shootApCost = selected ? weaponApCost(selected, ShotMode.Snap) : 0
  const actions: HudAction[] = []
  if (selected && !selected.isDead) {
    actions.push({
      id: 'shoot',
      label: shootActive ? 'Cancel Shoot' : 'Shoot',
      icon: shootActive ? 'ui-cancel' : 'ui-shoot',
      tag: `${shootApCost} AP`,
      active: shootActive,
      // Cancelling is never refused; only starting to aim can be pointless.
      disabled: !shootActive && !sources.shootReady,
      intent: shootActive ? { type: 'cancelShoot' } : { type: 'shoot' },
    })
    // Beside Shoot and only while somebody is in reach: melee is a thing to do
    // when standing next to an enemy, not a mode to go looking for. It opens
    // the same panel as Shoot, on the enemy in reach, so the chance is read
    // before anything is committed.
    if (sources.strikeReady) {
      actions.push({
        id: 'strike',
        label: `Strike · ${sources.strikeReady.name}`,
        icon: `melee-${sources.strikeReady.sidearm}`,
        tag: `${sources.strikeReady.apCost} AP`,
        active: false,
        disabled: false,
        intent: { type: 'strike' },
      })
    }
    actions.push({
      id: 'cover',
      label: selected.isCrouching ? 'Stand Up' : 'Take Cover',
      icon: 'ui-cover',
      tag: selected.isCrouching ? 'Free' : `${RULES.coverApCost} AP`,
      active: selected.isCrouching,
      disabled: !selected.isCrouching && selected.ap < RULES.coverApCost,
      intent: { type: 'toggleCover' },
    })
    actions.push({
      id: 'overwatch',
      label: selected.watching ? 'On Watch' : 'Overwatch',
      icon: 'ui-overwatch',
      // The cost is the shot being reserved, which is why it is the snap
      // price and not a number of its own.
      tag: selected.watching ? 'Holding fire' : `${watchCost(selected)} AP`,
      active: selected.watching,
      disabled: !canWatch(selected),
      intent: { type: 'overwatch' },
    })
    // Only what the unit is actually carrying. A row for kit left in the crate
    // is a row the player has to read past every turn to find what they have.
    for (const kind of Object.values(GrenadeId)) {
      const spec = selected.grenadeSpecs[kind]
      const count = selected.grenades[kind] ?? 0
      if (count <= 0) continue
      actions.push({
        id: `grenade-${kind}`,
        label: spec.name,
        icon: `grenade-${kind}`,
        tag: `${spec.apCost} AP · x${count}`,
        active: sources.grenade.armed === kind,
        group: 'grenades',
        disabled: selected.ap < spec.apCost,
        intent: { type: 'armGrenade', kind },
      })
    }
    for (const id of Object.values(ItemId)) {
      const spec = ITEMS[id]
      const count = selected.items[id] ?? 0
      // Worn kit has no action, so a row for it would be a button that does
      // nothing. What the unit carries is shown on the loadout screen.
      if (count <= 0 || spec.passive) continue
      // Through the shared rule, because `ItemSystem` charges the same figure:
      // a clever soldier's stim is cheaper, a trained mechanic's repair is
      // cheaper still, and a row advertising the table's price would be a
      // button whose cost is not the cost.
      const apCost = itemApCost(spec, selected.itemApDelta, selected.utility[UtilityId.Mechanics])
      // Technical kit nobody on this card can operate: greyed rather than
      // hidden, so the reason a repair kit sits unused is legible.
      const gated =
        spec.minIntelligence !== undefined &&
        selected.sheet.attributes.intelligence < spec.minIntelligence
      actions.push({
        id: `item-${id}`,
        label: spec.name,
        icon: `item-${id}`,
        tag: `${apCost} AP · x${count}`,
        active: sources.item?.itemId === id,
        disabled: gated || selected.ap < apCost,
        group: 'items',
        targeted: itemTargetsAlly(spec),
        intent: { type: 'useItem', itemId: id },
      })
    }
    actions.push({
      id: 'reload',
      label: 'Reload',
      icon: 'ui-reload',
      tag: `${RULES.reloadApCost} AP · ${selected.weapon.currentClip}/${selected.weapon.maxClip}`,
      active: false,
      disabled: selected.weapon.currentClip === selected.weapon.maxClip || selected.ap < RULES.reloadApCost,
      intent: { type: 'reload' },
    })
    actions.push({
      id: 'endUnitTurn',
      label: 'End Unit Turn',
      icon: 'ui-unit-turn',
      tag: '0 AP',
      active: false,
      disabled: false,
      intent: { type: 'endUnitTurn' },
    })
  }

  const item = sources.item
  let targets: HudTargetIcon[]
  if (item) {
    // One strip, two jobs: an item awaiting a patient borrows shoot mode's row
    // of portraits rather than growing a second one beside it.
    const mateIndex = new Map(squads.byFaction[faction].map((s, i) => [s, i]))
    targets = item.candidates.map((soldier) => ({
      index: mateIndex.get(soldier) ?? 0,
      name: soldier.name,
      portrait: portraits.getPortrait(faction, mateIndex.get(soldier) ?? 0),
      hpFraction: soldier.maxHp > 0 ? soldier.hp / soldier.maxHp : 0,
      armorFraction: soldier.maxArmor > 0 ? soldier.armor / soldier.maxArmor : 0,
      hitChance: null,
      selected: soldier === item.target,
      // Own squad: there is nothing about a squadmate left to work out.
      known: true,
    }))
  } else {
    const enemyIndex = new Map(squads.byFaction[nextFaction].map((s, i) => [s, i]))
    targets = (shoot?.targets ?? []).map(({ soldier, hitChance }) => ({
      index: enemyIndex.get(soldier) ?? 0,
      name: soldier.name,
      portrait: portraits.getPortrait(nextFaction, enemyIndex.get(soldier) ?? 0),
      hpFraction: soldier.maxHp > 0 ? soldier.hp / soldier.maxHp : 0,
      armorFraction: soldier.maxArmor > 0 ? soldier.armor / soldier.maxArmor : 0,
      hitChance,
      selected: soldier === shoot?.pending?.target,
      known: soldier.known,
    }))
  }

  const isMyTurn =
    sources.networkMode === 'local' ||
    (sources.networkMode !== undefined &&
      sources.myFaction !== undefined &&
      turnManager.activeFaction === sources.myFaction)

  // The badge is text: the turn's own glyph is the view's business, drawn from
  // the icon set rather than as an emoji the platform picks a typeface for.
  let networkBadge = FACTION_INFO[faction].name
  if (sources.networkMode && sources.networkMode !== 'local') {
    const activeRole = faction === Faction.Blue ? 'BLUE (HOST)' : 'RED (GUEST)'
    networkBadge = isMyTurn ? `YOUR TURN — ${activeRole}` : `OPPONENT'S TURN — ${activeRole}`
  }

  return {
    isMyTurn,
    networkMode: sources.networkMode ?? 'local',
    factionName: FACTION_INFO[faction].name,
    networkBadge,
    factionIsBlue: faction === Faction.Blue,
    turnNumber: turnManager.turnNumber,
    seedLabel,
    squad,
    selectedName: selected && !selected.isDead ? selected.name : null,
    actions,
    selectedLevelFilter: sources.selectedLevelFilter,
    topLevel: sources.topLevel,
    debugMapOpen: sources.debugMapOpen,
    targets,
    shotPanel: shoot?.pending ? shotPanelOf(shoot.pending) : null,
    throwPanel: sources.grenade.pending ? throwPanelOf(sources.grenade.pending) : null,
    itemPanel: item && selected ? itemPanelOf(item, selected) : null,
    freelookActive: rig.isFreeLookActive && !rig.isShoulderViewActive,
    unitViewActive: sources.unitViewRequested,
    waypointActive,
    unitViewEnabled: selected !== null,
    nextFactionName: FACTION_INFO[nextFaction].name,
  }
}

function weaponApCost(soldier: Soldier, mode: ShotMode): number {
  return effectiveWeapon(soldier, mode).apCost
}

/**
 * Everything currently in force on a unit, spelled out.
 *
 * Nothing surfaced these before, so a stim raising a unit's points and a shot
 * missing because the shooter was flashed both happened silently. A ceiling
 * that moves with no visible cause reads as a bug.
 */
function statusChips(soldier: Soldier): HudStatusChip[] {
  const chips: HudStatusChip[] = []

  // Wounds first: they are the reason a unit is shooting badly, and they last
  // as long as the injury rather than ticking away like a status.
  for (const id of woundTraits(soldier.hp, soldier.maxHp)) {
    const trait = TRAITS[id]
    chips.push({ name: trait.name, detail: trait.description, good: false })
  }

  for (const state of soldier.statuses) {
    if (state.turnsLeft <= 0) continue
    const spec = STATUSES[state.kind]
    if (!spec) continue

    // Every effect is per stack, so the tooltip has to be too: "-12% to hit"
    // on a unit with three stacks would be a lie the player can act on.
    const stacks = statusStacks(state)
    const terms: string[] = []
    if (spec.accuracyPenalty) terms.push(`-${spec.accuracyPenalty * stacks}% to hit`)
    if (spec.defenceBonus) terms.push(`-${spec.defenceBonus * stacks}% to be hit`)
    if (spec.damageTakenBonus) {
      terms.push(`+${Math.round(spec.damageTakenBonus * stacks * 100)}% damage taken`)
    }
    if (spec.apBonus) {
      terms.push(`${spec.apBonus > 0 ? '+' : ''}${Math.round(spec.apBonus * stacks * 100)}% AP`)
    }

    chips.push({
      name: stacks > 1 ? `${spec.name} x${stacks}` : spec.name,
      detail: `${terms.join(', ')} · ${state.turnsLeft} turn${state.turnsLeft === 1 ? '' : 's'} left`,
      // Judged by what it does rather than listed per kind, so a status added
      // later is coloured right without being registered anywhere.
      good: spec.apBonus > 0 || spec.defenceBonus > 0,
    })
  }
  return chips
}

/**
 * The chance with no shot mode applied.
 *
 * Recomputed from the terms rather than divided out of an option's chance: the
 * final figure is clamped, so dividing by the multiplier would misreport any
 * shot that hit the ceiling or the floor.
 *
 * Every term `hitChance` uses has to appear here, or the big number on the card
 * contradicts the rows printed under it: proficiency and evasion were missing
 * and a target with 22 evasion still read 64%.
 */
function neutralChance(b: HitChanceBreakdown): number {
  if (b.outOfRange) return 0
  const raw =
    b.base +
    b.proficiency -
    b.rangePenalty -
    b.coverPenalty -
    b.shooterPenalty -
    b.targetDefence -
    b.evasion
  return clamp(Math.round(raw), AIM.min, AIM.max)
}

/** Turn a pending shot into the shared picture plus what each mode changes. */
function shotPanelOf(pending: PendingShot): HudShotPanel {
  // Every option carries the same mode-independent terms, so the first one
  // speaks for all of them.
  const first = pending.options[0]?.breakdown
  const terms: HudShotTerm[] = []
  if (first) {
    terms.push({
      label: 'Weapon base',
      value: `${Math.round(first.base)}%`,
      icon: 'ui-shoot',
      penalty: false,
    })
    // The two terms that are people rather than kit. Worth their own rows: a
    // player comparing two shooters on the same target has no other way to see
    // that the rifle is not the same rifle in both pairs of hands.
    const proficiency = Math.round(first.proficiency)
    if (proficiency !== 0) {
      terms.push({
        label: `${pending.weaponName} skill`,
        value: `${proficiency > 0 ? '+' : ''}${proficiency}%`,
        icon: 'mode-aimed',
        penalty: proficiency < 0,
      })
    }
    terms.push({
      label: `Range ${first.distance.toFixed(1)} m`,
      value: `-${first.rangePenalty}%`,
      icon: 'shot-range',
      penalty: first.rangePenalty > 0,
    })
    terms.push({
      label: 'Cover',
      value: `-${first.coverPenalty}%`,
      icon: 'ui-cover',
      penalty: first.coverPenalty > 0,
    })
    if (first.shooterPenalty > 0) {
      terms.push({
        label: 'Blinded',
        value: `-${first.shooterPenalty}%`,
        icon: 'shot-blinded',
        penalty: true,
      })
    }
    if (first.targetDefence > 0) {
      terms.push({
        label: 'Concealment',
        value: `-${first.targetDefence}%`,
        icon: 'shot-conceal',
        penalty: true,
      })
    }
    if (first.evasion > 0) {
      terms.push({
        label: 'Target evasion',
        // The chance above already has it in; what is withheld is the reason.
        value: pending.target.known ? `-${Math.round(first.evasion)}%` : '-?%',
        icon: 'shot-conceal',
        penalty: true,
      })
    }
  }

  // What moved the crit chance off the weapon's own number, so a player can see
  // why closing in or backing off would change it.
  if (pending.crit.rangeTerm !== 0) {
    terms.push({
      label: pending.crit.rangeTerm > 0 ? 'Crit at this range' : 'Crit out of its range',
      value: `${pending.crit.rangeTerm > 0 ? '+' : ''}${pending.crit.rangeTerm}%`,
      icon: 'shot-range',
      penalty: pending.crit.rangeTerm < 0,
    })
  }
  if (pending.crit.armorTerm !== 0) {
    terms.push({
      label: 'Crit vs armour',
      value: `${pending.crit.armorTerm}%`,
      icon: 'shot-shred',
      penalty: true,
    })
  }

  const base = first ? neutralChance(first) : 0

  return {
    targetName: pending.target.name,
    targetHp: pending.target.hp,
    targetArmor: pending.target.armor,
    targetKnown: pending.target.known,
    weaponName: pending.weaponName,
    ammoName: pending.ammoName,
    currentClip: pending.currentClip,
    maxClip: pending.maxClip,
    base: {
      chance: base,
      damage: pending.options[0]?.damage ?? 0,
      armorShred: pending.options[0]?.armorShred ?? 0,
      critChance: pending.crit.chance,
      critMultiplier: pending.crit.multiplier,
      critImmune: pending.crit.immune,
      critDamage: pending.critDamage,
      terms,
    },
    options: pending.options.map((option) => ({
      mode: option.mode,
      name: option.name,
      hitChance: option.breakdown.chance,
      chanceDelta: option.breakdown.chance - base,
      damageAtBest: option.damage * option.bullets,
      apCost: option.apCost,
      bullets: option.bullets,
      available: option.available,
      outOfRange: option.breakdown.outOfRange,
    })),
    strike: pending.strike
      ? {
          sidearm: pending.strike.sidearm,
          name: pending.strike.name,
          hitChance: pending.strike.breakdown.chance,
          apCost: pending.strike.apCost,
          damage: pending.strike.damage,
        }
      : null,
  }
}

/** Turn a pending throw into display rows, friendlies flagged. */
function throwPanelOf(pending: PendingThrow): HudThrowPanel {
  return {
    name: pending.name,
    kind: pending.kind,
    apCost: pending.apCost,
    radius: pending.radius,
    remaining: pending.remaining,
    affordable: pending.affordable,
    inRange: pending.inRange,
    statusName: pending.statusName,
    caught: pending.caught,
  }
}

/** Turn an item awaiting a patient into the panel that picks one. */
function itemPanelOf(item: ItemTargetSnapshot, user: Soldier): HudItemPanel {
  const spec = ITEMS[item.itemId]
  const apCost = itemApCost(spec, user.itemApDelta, user.utility[UtilityId.Mechanics])
  return {
    name: spec.name,
    itemId: item.itemId,
    apCost,
    remaining: user.items[item.itemId] ?? 0,
    affordable: user.ap >= apCost,
    targetName: item.target?.name ?? null,
    effects: spec.effects.map(effectLine),
  }
}

/** One effect in words. Deliberately no figures: see {@link HudItemPanel}. */
function effectLine(effect: ItemEffect): string {
  switch (effect.kind) {
    case 'restoreHp':
      return 'Treats wounds'
    case 'restoreArmor':
      return 'Patches armour'
    case 'refillAp':
      // Always the user: the exertion is theirs, whoever they are working on.
      return "Tops up the user's points"
    case 'clearStatuses':
      return 'Clears every status'
    case 'applyStatus':
      return `Applies ${STATUSES[effect.status].name}`
  }
}
