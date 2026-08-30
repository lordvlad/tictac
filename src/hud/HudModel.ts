import { COVER_AP_COST, FACTION_INFO, Faction, MAX_AP, MAX_HP, SHOOT_AP_COST } from '../config'
import type { OrbitRig } from '../camera/OrbitRig'
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
  | { type: 'toggleCover' }
  | { type: 'toggleWaypoints' }
  | { type: 'endUnitTurn' }
  | { type: 'requestTurnSwitch' }
  | { type: 'confirmTurnSwitch' }
  | { type: 'toggleFreelook' }
  | { type: 'toggleUnitView' }

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
  ap: number
  portrait: string
  selected: boolean
  dead: boolean
}

/** Immutable snapshot of what the HUD should show right now. */
export interface HudModel {
  factionName: string
  factionIsBlue: boolean
  turnNumber: number
  seedLabel: string
  maxHp: number
  maxAp: number
  squad: HudSquadCard[]
  selectedName: string | null
  actions: HudAction[]
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
}

/**
 * Project game state into the HUD's snapshot.
 *
 * Action availability lives here rather than in the markup: whether "Shoot" is
 * affordable is a game rule, and the previous template asked the question with a
 * literal `ap < 4` of its own.
 */
export function buildHudModel(sources: HudModelSources): HudModel {
  const { turnManager, squads, rig, portraits, seedLabel, shootActive, waypointActive } = sources
  const faction = turnManager.activeFaction
  const selected = turnManager.selectedSoldier
  const nextFaction = faction === Faction.Blue ? Faction.Red : Faction.Blue

  const squad: HudSquadCard[] = squads.byFaction[faction].map((soldier, index) => ({
    index,
    name: soldier.name,
    hp: soldier.hp,
    ap: soldier.ap,
    portrait: portraits.getPortrait(faction, index),
    selected: soldier === selected,
    dead: soldier.isDead,
  }))

  const actions: HudAction[] = []
  if (selected && !selected.isDead) {
    actions.push({
      id: 'shoot',
      label: shootActive ? 'Cancel Shoot ✕' : 'Shoot',
      tag: `${SHOOT_AP_COST} AP`,
      active: shootActive,
      disabled: selected.ap < SHOOT_AP_COST,
      intent: shootActive ? { type: 'cancelShoot' } : { type: 'shoot' },
    })
    actions.push({
      id: 'cover',
      label: selected.isCrouching ? 'Stand Up' : 'Take Cover',
      tag: selected.isCrouching ? 'Free' : `${COVER_AP_COST} AP`,
      active: selected.isCrouching,
      disabled: !selected.isCrouching && selected.ap < COVER_AP_COST,
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
    actions.push({
      id: 'endUnitTurn',
      label: 'End Unit Turn',
      tag: '0 AP',
      active: false,
      disabled: false,
      intent: { type: 'endUnitTurn' },
    })
  }

  return {
    factionName: FACTION_INFO[faction].name,
    factionIsBlue: faction === Faction.Blue,
    turnNumber: turnManager.turnNumber,
    seedLabel,
    maxHp: MAX_HP,
    maxAp: MAX_AP,
    squad,
    selectedName: selected && !selected.isDead ? selected.name : null,
    actions,
    freelookActive: rig.isFreeLookActive && !rig.isCharacterViewActive,
    unitViewActive: rig.isCharacterViewActive,
    unitViewEnabled: selected !== null,
    nextFactionName: FACTION_INFO[nextFaction].name,
  }
}
