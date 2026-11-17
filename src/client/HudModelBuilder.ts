import { FACTION_INFO, Faction, RULES } from '../config'
import { GrenadeId, ShotMode, STATUSES, WEAPONS } from '../core/Arsenal'
import { ITEMS, type ItemEffect, ItemId, itemApCost, itemTargetsAlly } from '../core/Items'
import { UtilityId } from '../core/Characters'
import { effectiveWeapon, statusStacks } from '../core/Ballistics'
import type { MeleeId } from '../core/Melee'
import { Awareness } from '../core/Awareness'
import { breakChance, type MoraleBreak, steadyChance } from '../core/Morale'
import type { Grid } from '../core/Grid'
import { cannotWorkDoor, doorAhead, doorApCost, type DoorVerb, doorVerbs } from '../core/Doors'
import { TRAITS, woundTraits } from '../core/Traits'
import type { Attribute } from '../core/Progression'
import { leaversOf, retreatChance, watchersOf } from '../core/Retreat'
import type { OrbitRig } from '../camera/OrbitRig'
import type { Soldier } from '../entities/Soldier'
import type { Squads } from '../entities/Squads'
import type { TurnManager } from '../sim/TurnManager'
import type { OffscreenPortraits } from '../render/Portraits'
import { canWatch, watchCost } from '../rules/Overwatch'
import type { Debrief } from '../rules/MatchEnd'
import type {
  EndScreen,
  EndScreenSurvivor,
  HudAction,
  HudItemPanel,
  HudModel,
  HudRetreat,
  HudShotPanel,
  HudStatusChip,
  HudSquadCard,
  HudTargetIcon,
  HudThrowPanel,
} from '../hud/HudModel'
import type { HudIntent } from '../ui/Intent'
import type { PendingThrow } from './GrenadePlanner'
import type { PendingShot } from './ShootPlanner'

/**
 * Projects the match into what the HUD draws.
 *
 * The HUD (`src/hud`) takes plain view data (`HudModel`) and imports nothing of
 * the match; the knowing-about-soldiers half lives here, with the presenter
 * that calls it.
 */

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
  /** The session's turn gate (`MatchSession.canAct`): whether this window may command now. */
  canAct: boolean
  /** The side this window plays when the match is shared; null on one screen and for a watcher. */
  seat: Faction | null
  /** The player's unit-view toggle. Aiming moves the camera without setting it. */
  unitViewRequested: boolean
  selectedLevelFilter: number
  topLevel: number
  debugMapOpen: boolean
  /**
   * The rules are still running a broken unit at the start of the turn. The
   * applier refuses every order until they finish, so nothing is offered.
   */
  rulesActing: boolean
  /** The map, for the door in front of the selected unit. */
  grid: Grid
  /** The player has pressed Retreat once and the next press goes. */
  retreatArmed: boolean
  /** The last retreat attempt that failed, if the player should still be told. */
  retreatNote: string | null
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

  const displayFaction = sources.seat ?? faction

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
  // A broken unit takes no orders, so it is offered none; nobody is offered
  // any while the rules are still running one.
  if (selected && !selected.isDead && !selected.broken && !sources.rulesActing) {
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
      label: selected.isCrouching ? 'Stand Up' : 'Crouch',
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
    // The door the unit is facing, beside it: what can be done to it is a
    // row each, priced, greyed when the unit cannot (no keys, no points).
    const door = doorAhead(sources.grid, selected.tile, selected.heading)
    if (door !== null) {
      const { x, y, side } = sources.grid.edgeTile(door)
      for (const verb of doorVerbs(sources.grid.wallAt(x, y, side))) {
        const cost = doorApCost(verb)
        actions.push({
          id: `door-${verb}`,
          label: DOOR_LABEL[verb],
          icon: `door-${verb}`,
          // The odds are the character's, so they are on the button.
          tag: verb === 'force' ? `${cost} AP · ${selected.shoulder}%` : `${cost} AP`,
          active: false,
          disabled: cannotWorkDoor(sources.grid, selected, door, verb) !== null,
          intent: { type: 'operateDoor', verb },
        })
      }
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
      awareness: null,
      broken: soldier.broken,
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
      awareness: awarenessLabel(soldier.awareness),
      broken: soldier.broken,
    }))
  }

  // The badge is text: the turn's own glyph is the view's business, drawn from
  // the icon set rather than as an emoji the platform picks a typeface for.
  let networkBadge = FACTION_INFO[faction].name
  let turnMarker: HudModel['turnMarker'] = null
  if (sources.seat !== null) {
    const activeRole = faction === Faction.Blue ? 'BLUE (HOST)' : 'RED (GUEST)'
    turnMarker = faction === sources.seat ? 'mine' : 'theirs'
    networkBadge = turnMarker === 'mine' ? `YOUR TURN — ${activeRole}` : `OPPONENT'S TURN — ${activeRole}`
  }

  return {
    canAct: sources.canAct,
    turnMarker,
    rulesActing: sources.rulesActing,
    retreat: sources.canAct && !sources.rulesActing ? retreatOffer(squads, faction, sources.grid, sources.retreatArmed) : null,
    retreatNote: sources.retreatNote,
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
    if (spec.damagePerTurn) terms.push(`-${spec.damagePerTurn * stacks} HP at the start of each turn`)

    chips.push({
      name: stacks > 1 ? `${spec.name} x${stacks}` : spec.name,
      detail: `${terms.join(', ')} · ${state.turnsLeft} turn${state.turnsLeft === 1 ? '' : 's'} left`,
      // Judged by what it does rather than listed per kind, so a status added
      // later is coloured right without being registered anywhere.
      good: spec.apBonus > 0 || spec.defenceBonus > 0,
    })
  }
  const morale = moraleChip(soldier)
  if (morale) chips.push(morale)
  return chips
}

const BROKEN_CHIP: Record<MoraleBreak, { name: string; does: string }> = {
  panic: { name: 'Panicking', does: 'Runs from the enemy its side can see; takes no orders' },
  frenzy: { name: 'Frenzied', does: 'Charges the nearest enemy its side can see; takes no orders' },
  freeze: { name: 'Frozen', does: 'No action points; takes no orders' },
}

/**
 * The unit's nerve, when it says anything: the break it is in, or how likely
 * it is to break. A unit at steady or above has nothing to report.
 */
function moraleChip(soldier: Soldier): HudStatusChip | null {
  if (soldier.broken) {
    const { name, does } = BROKEN_CHIP[soldier.broken]
    // The chance it will be rolled against at the start of its next turn.
    const chance = steadyChance(soldier.brokenTurns + 1)
    return { name, detail: `${does} · ${chance}% to steady next turn`, good: false }
  }
  const chance = breakChance(soldier.morale)
  if (chance <= 0) return null
  return {
    name: 'Shaken',
    detail: `Morale ${soldier.morale} · ${chance}% to break at the start of its turn`,
    good: false,
  }
}

const DOOR_LABEL: Record<DoorVerb, string> = {
  open: 'Open Door',
  close: 'Close Door',
  unlock: 'Unlock Door',
  force: 'Force Door',
}

/**
 * What the strip and the panel call out about an enemy's awareness. Engaged
 * is the ordinary state of a fight and says nothing; the other two are what a
 * quiet approach or a knife is planned around.
 */
function awarenessLabel(state: Awareness): 'unaware' | 'alerted' | null {
  if (state === Awareness.Unaware) return 'unaware'
  if (state === Awareness.Alerted) return 'alerted'
  return null
}

/** Turn a pending shot into the panel: the plainest shot's numbers, then one row per mode. */
function shotPanelOf(pending: PendingShot): HudShotPanel {
  const first = pending.options[0]
  return {
    targetName: pending.target.name,
    targetHp: pending.target.hp,
    targetArmor: pending.target.armor,
    targetKnown: pending.target.known,
    targetAwareness: awarenessLabel(pending.target.awareness),
    weaponName: pending.weaponName,
    ammoName: pending.ammoName,
    currentClip: pending.currentClip,
    maxClip: pending.maxClip,
    base: { chance: first?.odds.chance ?? 0, damage: first?.damage ?? 0 },
    options: pending.options.map((option) => ({
      mode: option.mode,
      name: option.name,
      hitChance: option.odds.chance,
      damageAtBest: option.damage * option.bullets,
      apCost: option.apCost,
      bullets: option.bullets,
      available: option.available,
      outOfRange: option.odds.outOfRange,
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

/** The names of every ailment a kit can treat, as `treatAilments` reads in words. */
const AILMENTS: readonly string[] = Object.values(STATUSES)
  .filter((spec) => spec.ailment)
  .map((spec) => spec.name)

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
    case 'treatAilments':
      return `Stops ${AILMENTS.join(' and ').toLowerCase()}`
    case 'applyStatus':
      return `Applies ${STATUSES[effect.status].name}`
  }
}

const ATTRIBUTE_NAME: Record<Attribute, string> = {
  health: 'Health',
  agility: 'Agility',
  strength: 'Strength',
  intelligence: 'Intelligence',
}

/**
 * The screens a finished match shows, in order.
 *
 * `viewer` is the side this screen belongs to online; null in a local match,
 * where both sides share it: the loser's "you lost" first — with the one of
 * them carried out alive, or those who got away, when there are any — then
 * the winner's survivors and what they learned. Online each side sees only
 * its own.
 */
export function endScreens(
  winner: Faction,
  viewer: Faction | null,
  debriefs: readonly Debrief<Soldier>[],
  escapees: readonly Debrief<Soldier>[],
  carried: Soldier | null,
  portraits: Pick<OffscreenPortraits, 'getPortrait'>,
): EndScreen[] {
  const loser = winner === Faction.Blue ? Faction.Red : Faction.Blue
  const done: HudIntent = { type: 'backToMenu' }
  const survivorOf = ({ unit, growth }: Debrief<Soldier>): EndScreenSurvivor => ({
    name: unit.name,
    portrait: portraits.getPortrait(unit.faction, unit.squadIndex),
    lines: growth.map((change) => ({
      label: change.kind === 'attribute' ? ATTRIBUTE_NAME[change.attribute] : `${WEAPONS[change.weapon].name} proficiency`,
      from: change.from,
      to: change.to,
      because: change.because,
    })),
  })
  const lost = (next: HudIntent): EndScreen => ({
    stage: 'lost',
    factionName: FACTION_INFO[loser].name,
    blue: loser === Faction.Blue,
    carried: carried ? { name: carried.name, portrait: portraits.getPortrait(carried.faction, carried.squadIndex) } : null,
    escaped: escapees.map(survivorOf),
    next,
  })
  const won: EndScreen = {
    stage: 'won',
    factionName: FACTION_INFO[winner].name,
    blue: winner === Faction.Blue,
    survivors: debriefs.map(survivorOf),
    next: done,
  }
  if (viewer === null) return [lost({ type: 'endScreenNext' }), won]
  return viewer === winner ? [won] : [lost(done)]
}

/**
 * What retreating now would do for `faction`: who goes, who is lost, and the
 * chance — the same figures the rules will roll against. Null while nobody is
 * on the way out.
 */
function retreatOffer(squads: Squads, faction: Faction, grid: Grid, armed: boolean): HudRetreat | null {
  const leavers = leaversOf(squads.soldiers, faction, grid.size)
  if (leavers.length === 0) return null
  const going = new Set(leavers)
  return {
    chance: retreatChance(leavers, watchersOf(grid, squads.soldiers, leavers)),
    leaving: leavers.length,
    leftBehind: squads.byFaction[faction].filter((unit) => !unit.isDead && !going.has(unit)).map((unit) => unit.name),
    armed,
  }
}
