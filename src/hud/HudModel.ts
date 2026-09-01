import { FACTION_INFO, Faction, RULES } from '../config'
import { GrenadeId, ShotMode } from '../core/Arsenal'
import { effectiveWeapon } from '../core/Ballistics'
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
  | { type: 'reload' }
  | { type: 'armGrenade'; kind: GrenadeId }
  | { type: 'confirmThrow' }
  | { type: 'cancelGrenade' }
  | { type: 'toggleCover' }
  | { type: 'toggleWaypoints' }
  | { type: 'endUnitTurn' }
  | { type: 'requestTurnSwitch' }
  | { type: 'confirmTurnSwitch' }
  | { type: 'toggleFreelook' }
  | { type: 'toggleUnitView' }
  | { type: 'openDebug' }

/** One button in the selected unit's action panel. */
export interface HudAction {
  id: string
  label: string
  tag: string
  active: boolean
  disabled: boolean
  intent: HudIntent
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
}

/** One enemy in the target strip. */
export interface HudTargetIcon {
  index: number
  name: string
  portrait: string
  hpFraction: number
  armorFraction: number
  hitChance: number
  selected: boolean
}

/** One line of the "why is my chance this bad" breakdown. */
export interface HudShotTerm {
  label: string
  value: string
  /** Negative terms are drawn in the danger colour. */
  penalty: boolean
}

/** One shot option, rendered as a card that fires when clicked. */
export interface HudShotCard {
  mode: ShotMode
  name: string
  hitChance: number
  damage: number
  armorShred: number
  apCost: number
  bullets: number
  available: boolean
  outOfRange: boolean
  terms: HudShotTerm[]
}

/** The target being aimed at, and a card per way of shooting it. */
export interface HudShotPanel {
  targetName: string
  targetHp: number
  targetArmor: number
  weaponName: string
  ammoName: string
  currentClip: number
  maxClip: number
  cards: HudShotCard[]
}

/** The throw lined up and awaiting confirmation. */
export interface HudThrowPanel {
  name: string
  apCost: number
  radius: number
  remaining: number
  affordable: boolean
  inRange: boolean
  statusName: string | null
  caught: { name: string; friendly: boolean; damage: number; armorShred: number; lethal: boolean }[]
}

/** Immutable snapshot of what the HUD should show right now. */
export interface HudModel {
  factionName: string
  networkBadge: string
  factionIsBlue: boolean
  turnNumber: number
  seedLabel: string
  squad: HudSquadCard[]
  selectedName: string | null
  actions: HudAction[]
  /** Populated only in shoot mode; drives the strip above the squad bar. */
  targets: HudTargetIcon[]
  /** Populated when a target is lined up; replaces the action list. */
  shotPanel: HudShotPanel | null
  /** Populated while a grenade is armed; also replaces the action list. */
  throwPanel: HudThrowPanel | null
  freelookActive: boolean
  unitViewActive: boolean
  unitViewEnabled: boolean
  nextFactionName: string
}

export interface HudModelSources {
  turnManager: TurnManager
  squads: Squads
  rig: OrbitRig
  portraits: OffscreenPortraits
  seedLabel: string
  shootActive: boolean
  waypointActive: boolean
  /** Shoot-mode state, when shoot mode is on. */
  shoot: ShootSnapshot | null
  /** The armed grenade and its aimed blast, when one is armed. */
  grenade: { armed: GrenadeId | null; pending: PendingThrow | null }
  networkMode?: string
  myFaction?: Faction
}

/** What the model builder needs from the shoot planner. */
export interface ShootSnapshot {
  targets: { soldier: Soldier; hitChance: number }[]
  pending: PendingShot | null
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
    maxAp: soldier.maxAp,
    armor: soldier.armor,
    maxArmor: soldier.maxArmor,
    portrait: portraits.getPortrait(displayFaction, index),
    selected: soldier === selected,
    dead: soldier.isDead,
  }))

  const shootApCost = selected ? weaponApCost(selected, ShotMode.Snap) : 0
  const actions: HudAction[] = []
  if (selected && !selected.isDead) {
    actions.push({
      id: 'shoot',
      label: shootActive ? 'Cancel Shoot ✕' : 'Shoot',
      tag: `${shootApCost} AP`,
      active: shootActive,
      disabled: selected.ap < shootApCost,
      intent: shootActive ? { type: 'cancelShoot' } : { type: 'shoot' },
    })
    actions.push({
      id: 'cover',
      label: selected.isCrouching ? 'Stand Up' : 'Take Cover',
      tag: selected.isCrouching ? 'Free' : `${RULES.coverApCost} AP`,
      active: selected.isCrouching,
      disabled: !selected.isCrouching && selected.ap < RULES.coverApCost,
      intent: { type: 'toggleCover' },
    })
    actions.push({
      id: 'waypoints',
      label: 'Waypoints',
      tag: waypointActive ? 'On' : 'Off',
      active: waypointActive,
      disabled: false,
      intent: { type: 'toggleWaypoints' },
    })
    for (const kind of Object.values(GrenadeId)) {
      const spec = selected.grenadeSpecs[kind]
      const count = selected.grenades[kind] ?? 0
      actions.push({
        id: `grenade-${kind}`,
        label: spec.name,
        tag: count > 0 ? `${spec.apCost} AP · x${count}` : 'none left',
        active: sources.grenade.armed === kind,
        disabled: count <= 0 || selected.ap < spec.apCost,
        intent: { type: 'armGrenade', kind },
      })
    }
    actions.push({
      id: 'reload',
      label: 'Reload',
      tag: `${RULES.reloadApCost} AP · ${selected.weapon.currentClip}/${selected.weapon.maxClip}`,
      active: false,
      disabled: selected.weapon.currentClip === selected.weapon.maxClip || selected.ap < RULES.reloadApCost,
      intent: { type: 'reload' },
    })
    actions.push({
      id: 'endUnitTurn',
      label: 'End Unit Turn',
      tag: '0 AP',
      active: false,
      disabled: false,
      intent: { type: 'endUnitTurn' },
    })
    actions.push({
      id: 'debug',
      label: 'Debug…',
      tag: 'Dev',
      active: false,
      disabled: false,
      intent: { type: 'openDebug' },
    })
  }

  const enemyIndex = new Map(squads.byFaction[nextFaction].map((s, i) => [s, i]))
  const targets: HudTargetIcon[] = (shoot?.targets ?? []).map(({ soldier, hitChance }) => ({
    index: enemyIndex.get(soldier) ?? 0,
    name: soldier.name,
    portrait: portraits.getPortrait(nextFaction, enemyIndex.get(soldier) ?? 0),
    hpFraction: soldier.maxHp > 0 ? soldier.hp / soldier.maxHp : 0,
    armorFraction: soldier.maxArmor > 0 ? soldier.armor / soldier.maxArmor : 0,
    hitChance,
    selected: soldier === shoot?.pending?.target,
  }))

  let networkBadge = FACTION_INFO[faction].name
  if (sources.networkMode && sources.networkMode !== 'local') {
    const isMyTurn = faction === sources.myFaction
    const myRole = sources.myFaction === Faction.Blue ? 'BLUE / HOST' : 'RED / GUEST'
    networkBadge = isMyTurn
      ? `${myRole} — YOUR TURN`
      : `${myRole} — OPPONENT'S TURN`
  }

  return {
    factionName: FACTION_INFO[faction].name,
    networkBadge,
    factionIsBlue: faction === Faction.Blue,
    turnNumber: turnManager.turnNumber,
    seedLabel,
    squad,
    selectedName: selected && !selected.isDead ? selected.name : null,
    actions,
    targets,
    shotPanel: shoot?.pending ? shotPanelOf(shoot.pending) : null,
    throwPanel: sources.grenade.pending ? throwPanelOf(sources.grenade.pending) : null,
    freelookActive: rig.isFreeLookActive && !rig.isCharacterViewActive,
    unitViewActive: rig.isCharacterViewActive,
    unitViewEnabled: selected !== null,
    nextFactionName: FACTION_INFO[nextFaction].name,
  }
}

function weaponApCost(soldier: Soldier, mode: ShotMode): number {
  return effectiveWeapon(soldier, mode).apCost
}

/** Turn a pending shot into one card per option, each with its own breakdown. */
function shotPanelOf(pending: PendingShot): HudShotPanel {
  return {
    targetName: pending.target.name,
    targetHp: pending.target.hp,
    targetArmor: pending.target.armor,
    weaponName: pending.weaponName,
    ammoName: pending.ammoName,
    currentClip: pending.currentClip,
    maxClip: pending.maxClip,
    cards: pending.options.map((option) => {
      const b = option.breakdown
      const terms: HudShotTerm[] = [
        { label: 'Weapon base', value: `${Math.round(b.base)}%`, penalty: false },
        {
          label: `Range ${b.distance.toFixed(1)} m`,
          value: `-${b.rangePenalty}%`,
          penalty: b.rangePenalty > 0,
        },
        { label: 'Cover', value: `-${b.coverPenalty}%`, penalty: b.coverPenalty > 0 },
      ]
      if (b.shooterPenalty > 0) {
        terms.push({ label: 'Blinded', value: `-${b.shooterPenalty}%`, penalty: true })
      }
      if (b.targetDefence > 0) {
        terms.push({ label: 'Concealment', value: `-${b.targetDefence}%`, penalty: true })
      }
      if (b.modeMultiplier !== 1) {
        terms.push({ label: 'Aimed', value: `x${b.modeMultiplier}`, penalty: false })
      }
      return {
        mode: option.mode,
        name: option.name,
        hitChance: b.chance,
        damage: option.damage,
        armorShred: option.armorShred,
        apCost: option.apCost,
        bullets: option.bullets,
        available: option.available,
        outOfRange: b.outOfRange,
        terms,
      }
    }),
  }
}

/** Turn a pending throw into display rows, friendlies flagged. */
function throwPanelOf(pending: PendingThrow): HudThrowPanel {
  return {
    name: pending.name,
    apCost: pending.apCost,
    radius: pending.radius,
    remaining: pending.remaining,
    affordable: pending.affordable,
    inRange: pending.inRange,
    statusName: pending.statusName,
    caught: pending.caught,
  }
}
