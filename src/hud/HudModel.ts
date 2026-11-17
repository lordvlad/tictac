import { DOORS, FIRE } from '../config'
import type { GrenadeId, ShotMode } from '../core/Arsenal'
import type { ItemId } from '../core/Items'
import type { MeleeId } from '../core/Melee'
import type { MoraleBreak } from '../core/Morale'
import { Block, type Grid, Side, type Tile } from '../core/Grid'
import { SURFACES } from '../core/Surfaces'
import { isDoor } from '../core/Doors'
import { WallKind } from '../core/Walls'
import type { HudIntent } from '../ui/Intent'

/**
 * What the HUD draws: plain data, and nothing it has to look anything up in.
 *
 * Built by `client/HudModelBuilder` from the session; the HUD takes these as
 * props and answers with a `HudIntent`, so it imports no game state and the
 * one thing that ever mutates the match is the session.
 */

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
  /**
   * Whether it knows anything is going on, when that is worth saying: null for
   * a squadmate, and for an enemy already in the fight — that is the ordinary
   * state, and the strip only calls out the ones a quiet approach can exploit.
   */
  awareness: 'unaware' | 'alerted' | null
  /** The break the unit is in: it takes no orders, and the other side should know. */
  broken: MoraleBreak | null
}

/** One line of the "why is my chance this bad" breakdown. */
/**
 * What every way of shooting this target shares: the odds and the damage of
 * the plainest shot. That is the whole of it on purpose — range, cover, spread,
 * training and crit are all *in* these two numbers, and laying them out as
 * terms turned every shot into arithmetic the player had to audit. What a
 * weapon is like — its spread, its pellets, its crit — is on the loadout.
 */
export interface HudShotBase {
  chance: number
  /** What a round does when it lands, after the target's armour. */
  damage: number
}

/** One way of shooting: its odds, its cost, its rounds and what they do. */
export interface HudShotOption {
  mode: ShotMode
  name: string
  hitChance: number
  /** Damage with every round landing — what the round count buys. */
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
  /** As on the target strip: called out only when it is not already in the fight. */
  targetAwareness: 'unaware' | 'alerted' | null
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
  /**
   * Whether this window may command the match right now. The session's one
   * answer (`MatchSession.canAct`): every control that spends a point is
   * enabled by this alone, so no panel works out whose turn it is on its own.
   */
  canAct: boolean
  /** Whose turn the badge marks when the match is shared with somebody; null on one screen. */
  turnMarker: 'mine' | 'theirs' | null
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
  /** Nothing can be ordered yet: the rules are still running a broken unit. */
  rulesActing: boolean
  /**
   * What retreating now would do, on this side's turn while anybody stands on
   * its way out; null otherwise. `armed` once it has been pressed once.
   */
  retreat: HudRetreat | null
  /** The last retreat attempt that failed, for the line under the turn button. */
  retreatNote: string | null
}

export interface HudRetreat {
  /** Percent chance of getting away. */
  chance: number
  leaving: number
  /** Everyone alive who is not on the way out, and would be lost. */
  leftBehind: string[]
  armed: boolean
}

/**
 * Which pieces of the HUD are showing, as data.
 *
 * The view renders a piece or renders nothing for it from these flags: there
 * is no visibility held in a DOM class that something else would have to read
 * back or keep in step.
 */
export interface HudVisibility {
  /**
   * The in-match panels away, as for a replay or a watcher, where there is
   * nothing to command: a squad bar whose buttons do nothing is worse than none.
   */
  panelsHidden: boolean
  /** The hot-seat "pass the screen" cover is up. */
  turnOverlay: boolean
}


/** One line of the tile readout. `hazard` lines are drawn as a warning. */
export interface TileReadoutLine {
  name: string
  detail: string
  tone: 'plain' | 'hazard'
}

export interface TileReadout {
  lines: TileReadoutLine[]
}

/**
 * What a tile is, for a player deciding whether to stand on it or set it
 * alight: its surface, a crate on it, and whether it is burning or smoky.
 */
export function tileReadout(grid: Grid, tile: Tile): TileReadout {
  const surface = SURFACES[grid.surfaceAt(tile.x, tile.y)]
  const lines: TileReadoutLine[] = [{ name: surface.name, detail: surface.description, tone: 'plain' }]
  if (grid.blockAt(tile.x, tile.y) === Block.Half) {
    lines.push({ name: 'Crate', detail: 'Wooden: burns, and is gone when it has.', tone: 'plain' })
  }
  const fire = grid.fireAt(tile.x, tile.y)
  if (fire > 0) {
    lines.push({
      name: 'Burning',
      detail: `${fire} more turn${fire === 1 ? '' : 's'}: ${FIRE.damage} damage, whatever the armour, to whoever steps in or starts a turn here.`,
      tone: 'hazard',
    })
  }
  const smoke = grid.smokeAt(tile.x, tile.y)
  if (smoke > 0) {
    lines.push({
      name: 'Smoke',
      detail: `${smoke} more turn${smoke === 1 ? '' : 's'}: nobody sees into it or out of it past the next tile.`,
      tone: 'hazard',
    })
  }
  for (const side of [Side.North, Side.East, Side.South, Side.West]) {
    const kind = grid.wallAt(tile.x, tile.y, side)
    if (!isDoor(kind)) continue
    lines.push({ name: `${DOOR_STATE[kind]} door, ${SIDE_NAME[side]}`, detail: DOOR_DETAIL[kind] ?? '', tone: 'plain' })
  }
  return { lines }
}

const SIDE_NAME: Record<Side, string> = {
  [Side.North]: 'north',
  [Side.East]: 'east',
  [Side.South]: 'south',
  [Side.West]: 'west',
}

const DOOR_STATE: Partial<Record<WallKind, string>> = {
  [WallKind.Door]: 'Shut',
  [WallKind.DoorOpen]: 'Open',
  [WallKind.Locked]: 'Locked',
}

const DOOR_DETAIL: Partial<Record<WallKind, string>> = {
  [WallKind.Door]: `Blocks sight and fire. Walking through opens it, ${DOORS.openAp} AP on the step.`,
  [WallKind.DoorOpen]: `Shut it again for ${DOORS.closeAp} AP, standing at it.`,
  [WallKind.Locked]: `Keys open it for ${DOORS.unlockAp} AP; a shoulder, ${DOORS.forceAp} AP, may break it in, loudly.`,
}

/** One line of what a survivor learned: what grew, from what to what, and why. */
export interface EndScreenLine {
  label: string
  from: number
  to: number
  because: string
}

/** A survivor as an end screen shows them: who, and what they learned. */
export interface EndScreenSurvivor {
  name: string
  portrait: string
  lines: EndScreenLine[]
}

/** One screen at the end of a match: the side it is for, and what it shows them. */
export type EndScreen =
  | {
      stage: 'lost'
      factionName: string
      blue: boolean
      /** The one carried out alive, on 1 HP (`carriedOut`), when there is one. */
      carried: { name: string; portrait: string } | null
      /** Those who got away by retreating, and what they learned; empty when the side was wiped out. */
      escaped: EndScreenSurvivor[]
      next: HudIntent
    }
  | {
      stage: 'won'
      factionName: string
      blue: boolean
      survivors: EndScreenSurvivor[]
      next: HudIntent
    }
