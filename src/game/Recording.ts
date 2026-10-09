import type { Controller } from './Encounter'
import { MELEE, MeleeId } from '../core/Melee'
import type { MapOptions } from '../core/MapGenerator'
import { Faction, SQUAD_SIZE } from '../config'
import { AMMO, type AmmoId, GRENADES, type GrenadeId, WEAPONS, type WeaponId } from '../core/Arsenal'
import { ATTACHMENTS, type AttachmentId } from '../core/Attachments'
import { type CharacterSheet, sanitizeSheet } from '../core/Characters'
import { ITEMS, type ItemId } from '../core/Items'
import { ROLES, RoleId } from '../core/Roles'
import type { ResolvedHit } from './Combat'
import { RpcMethods } from './JsonRpc'
import type { UnitLoadout } from './Loadout'
import type { NetworkMessage } from './NetworkManager'

/**
 * A match, written down as the commands that produced it.
 *
 * Nothing new is invented here: a recording *is* the wire stream, because the
 * wire stream is already a complete account of a fight. Under the
 * sender-resolved contract every attack travels with its dice and its resolved
 * hits, so a peer can replay a shot without re-rolling it — and so can a file.
 * That is what makes recording cost one array push per command, and playback
 * cost nothing beyond the replay path that already exists for peers.
 *
 * Terrain is absent on purpose: the map is a pure function of `seed` through
 * `generateMap`, so storing it would only create a second truth to disagree
 * with.
 *
 * Deliberately free of any transport, the DOM and `three` — the type imports
 * from {@link NetworkManager} are erased at build — so a headless simulation
 * can record without dragging a channel or a scene behind it.
 */
/**
 * Bumped whenever the same header would regenerate a different match.
 *
 * 2: squads deploy anywhere along their own edge rather than centred, which
 * moves every building a seed produces — so a version-1 file replayed today
 * would refight its commands on terrain it was never fought on.
 *
 * 3: a header may now carry `startingHp`, so a version-2 file — which has
 * none — is not "every unit at full health" by coincidence; it is refused,
 * because that omission used to mean something different than it does now.
 *
 * 4: a side fields exactly as many units as its header states sheets for. A
 * version-3 header with a short squad deployed a made-up unit in the empty
 * slot, so replaying one today would refight it a unit down.
 *
 * 5: `sheets`, `loadouts` and `startingHp` — three same-length arrays matched
 * by position only, with nothing tying their lengths together — are one
 * `squads: Record<Faction, Deployment[]>` (`[ITEM-043]`). A version-4 header
 * has the old three arrays; reading it as the new one would zip a sheet
 * against the wrong unit's kit the moment they disagreed, which is exactly
 * the failure that made version 4 necessary in the first place.
 *
 * 6: a `throwGrenade` carries `targetLevel`, and a throw strays and flies —
 * off walls, onto roofs, in under them. A version-5 file's throws have no
 * storey and were resolved where they were aimed; replayed today they would
 * land somewhere else.
 */
export const RECORDING_VERSION = 6

/**
 * Session state for one deployed soldier: what a match starts them on top of
 * their sheet. A bag on purpose — HP today, fatigue next (`[ITEM-039]`),
 * room for whatever comes after without another wire shape.
 */
export interface DeploymentState {
  hp?: number
  fatigue?: number
}

/**
 * One soldier, fully stated: who they are, what they carry, and what state a
 * match starts them in — sheet, kit and session state travel together rather
 * than as three arrays a caller has to keep in step by hand.
 */
export interface Deployment {
  /** Present only for a kept roster (`[ITEM-042]`); absent for a rolled squad. */
  characterId?: string
  sheet: CharacterSheet
  /**
   * Absent when this soldier's stated kit could not be read (a peer on a
   * newer build naming a weapon this one does not know): they deploy on the
   * stock spread, the same as a soldier nobody ever equipped.
   */
  loadout?: UnitLoadout
  state?: DeploymentState
}

export interface RecordingHeader {
  version: number
  /** Map seed. The terrain is regenerated from it, never stored. */
  seed: number
  seedLabel: string
  source: 'live' | 'sim'
  createdAt: string
  /** The simulation's turn cap, or null for a played match. */
  turnCap: number | null
  /**
   * Both squads, one entry per deploying soldier: who they are, what they
   * carry, and what state they start in. A played match only ever equips one
   * side from a loadout screen — the other keeps the stock spread, because a
   * peer's attacks arrive already resolved — but a replay has no sender, so
   * it needs both sides' kit regardless of which one a player chose.
   */
  squads: Record<Faction, Deployment[]>
  /**
   * Whose each side is: a player's squad (`human`) or the game's (`ai`).
   * Absent for a match two players opened, where both are human. Stated by
   * the server for a fight it opened itself (`ITEM-048`); never changes, and
   * is not who moved the side — an absent player's side is still `human`.
   */
  controllers?: Record<Faction, Controller>
  /**
   * Layout beyond the seed. Absent for every map the game plays, which is
   * the default layout; present when a sweep asked for another one, because
   * the same seed under other options is another map.
   */
  map?: MapOptions
}

export interface RecordedEvent {
  seq: number
  /** Turn number in force when the command was issued. */
  turn: number
  /** The faction whose turn it was. */
  faction: Faction
  command: NetworkMessage
}

export interface CombatRecording {
  header: RecordingHeader
  events: RecordedEvent[]
}

/** Where the recorder reads the turn context it stamps onto each event. */
export type RecordingClock = () => { turn: number; faction: Faction }

/**
 * Commands that describe the session rather than the fight.
 *
 * `init` carries the seed and `ready` carries the peer's sheets; the header
 * holds both. Replaying either would mean a handshake with nobody on the other
 * end of it.
 */
const SESSION_COMMANDS: Partial<Record<NetworkMessage['type'], true>> = {
  init: true,
  hello: true,
  ready: true,
  digest: true,
  matchHeader: true,
  log: true,
  seated: true,
  abort: true,
}

export class Recorder {
  private readonly events: RecordedEvent[] = []

  constructor(
    private readonly header: RecordingHeader,
    private readonly clock: RecordingClock,
  ) {}

  get eventCount(): number {
    return this.events.length
  }

  /**
   * Append a command.
   *
   * Copied structurally, because a caller is free to reuse the object it
   * handed over — and a recording that aliased live state would rewrite its
   * own past.
   */
  record(command: NetworkMessage): void {
    if (SESSION_COMMANDS[command.type]) return
    const { turn, faction } = this.clock()
    this.events.push({
      seq: this.events.length,
      turn,
      faction,
      command: structuredClone(command),
    })
  }

  clear(): void {
    this.events.length = 0
  }

  toJSON(): CombatRecording {
    return { header: this.header, events: this.events }
  }

  filename(): string {
    return `tictac-${this.header.source}-${this.header.seedLabel}-${this.events.length}.json`
  }
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/**
 * A count map over a fixed id table.
 *
 * Unknown keys are dropped and missing ones read as zero, the same direction
 * {@link sanitizeSheet} takes: a pouch this build has no id for is a pouch it
 * cannot honour, and a missing count is an empty one.
 */
function counts<Id extends string>(table: Record<string, unknown>, raw: unknown): Record<Id, number> {
  const source = (raw ?? {}) as Partial<Record<Id, unknown>>
  const out = {} as Record<Id, number>
  for (const id of Object.keys(table) as Id[]) {
    const value = source[id]
    out[id] =
      typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  }
  return out
}

/**
 * One soldier's kit, checked field by field.
 *
 * Weapon and ammo ids are refused rather than defaulted: a replay resolves its
 * own damage from the weapon named here, so substituting a rifle for an id
 * this build does not know would quietly show a different fight.
 *
 * Exported so a caller can decide for itself what an unreadable *unit*
 * costs — a header refuses the whole squad ({@link deploymentsFrom}), but a
 * live peer's `ready` (`NetworkManager`) falls back to the stock spread
 * instead, the same way it always has.
 */
export function unitLoadoutFrom(raw: unknown, what: string): UnitLoadout {
  if (!raw || typeof raw !== 'object') throw new Error(`${what}: not a loadout entry`)
  const unit = raw as Partial<UnitLoadout>

  // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so a file
  // naming `'toString'` would pass and then be equipped as a weapon.
  if (typeof unit.weaponId !== 'string' || !Object.hasOwn(WEAPONS, unit.weaponId)) {
    throw new Error(`${what}: unknown weapon "${String(unit.weaponId)}"`)
  }
  if (typeof unit.ammoId !== 'string' || !Object.hasOwn(AMMO, unit.ammoId)) {
    throw new Error(`${what}: unknown ammo "${String(unit.ammoId)}"`)
  }

  // Absent in files written before the slot existed, and those units fought
  // bare-handed; a name this build does not know is refused like a weapon.
  const sidearm = unit.sidearm ?? MeleeId.Fists
  if (typeof sidearm !== 'string' || !Object.hasOwn(MELEE, sidearm)) {
    throw new Error(`${what}: unknown sidearm "${String(sidearm)}"`)
  }
  const attachments = Array.isArray(unit.attachments) ? unit.attachments : []
  // Absent for the same reason `sidearm` is: files and peers older than the
  // role slot never named one, and fought as plain riflemen.
  const role = unit.role ?? RoleId.Rifleman
  if (typeof role !== 'string' || !Object.hasOwn(ROLES, role)) {
    throw new Error(`${what}: unknown role "${String(role)}"`)
  }
  return {
    weaponId: unit.weaponId as WeaponId,
    ammoId: unit.ammoId as AmmoId,
    grenades: counts<GrenadeId>(GRENADES, unit.grenades),
    items: counts<ItemId>(ITEMS, unit.items),
    attachments: attachments.filter(
      (id): id is AttachmentId => typeof id === 'string' && Object.hasOwn(ATTACHMENTS, id),
    ),
    sidearm: sidearm as MeleeId,
    role: role as RoleId,
  }
}

/**
 * One soldier's session state, read leniently: an absent or malformed field
 * is simply absent from the result, never a reason to refuse the soldier
 * beside it. Safe now in a way it could not be as a positional array — HP
 * lives next to the sheet it belongs to, so there is no neighbour for it to
 * land on by mistake.
 */
export function deploymentStateFrom(raw: unknown): DeploymentState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Partial<DeploymentState>
  const state: DeploymentState = {}
  if (typeof source.hp === 'number' && Number.isFinite(source.hp)) state.hp = source.hp
  if (typeof source.fatigue === 'number' && Number.isFinite(source.fatigue)) {
    state.fatigue = source.fatigue
  }
  return Object.keys(state).length > 0 ? state : undefined
}

/**
 * One squad, as a header states it: every soldier's sheet and kit together,
 * one entry per unit, 1 to `SQUAD_SIZE` of them.
 *
 * Throws rather than truncates or pads — a header is either the squad that
 * fought or it is refused, the same rule a command already gets. A live
 * peer's `ready` does not go through this: it needs to keep a squad's sheets
 * even when its kit cannot be read, which is a per-unit judgement this
 * function does not make (see {@link unitLoadoutFrom} instead).
 */
export function deploymentsFrom(raw: unknown, what: string): Deployment[] {
  if (!Array.isArray(raw)) throw new Error(`${what}: must be an array`)
  if (raw.length < 1 || raw.length > SQUAD_SIZE) {
    throw new Error(`${what}: a squad of ${raw.length} is not 1 to ${SQUAD_SIZE}`)
  }
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`${what}[${i}]: not a deployment entry`)
    const d = entry as Partial<Deployment>
    const state = deploymentStateFrom(d.state)
    return {
      ...(typeof d.characterId === 'string' ? { characterId: d.characterId } : {}),
      sheet: sanitizeSheet(d.sheet),
      loadout: unitLoadoutFrom(d.loadout, `${what}[${i}].loadout`),
      ...(state ? { state } : {}),
    }
  })
}

/**
 * Whose each side was (`RecordingHeader.controllers`), or null when the header
 * does not state it. Dropped rather than refused: nothing replays from it, it
 * only says who was playing, and a header from before it stated nothing.
 */
function controllersFrom(raw: unknown): Record<Faction, Controller> | null {
  const stated = raw as Partial<Record<Faction, unknown>> | null | undefined
  const blue = stated?.[Faction.Blue]
  const red = stated?.[Faction.Red]
  const known = (controller: unknown): controller is Controller => controller === 'human' || controller === 'ai'
  return known(blue) && known(red) ? { [Faction.Blue]: blue, [Faction.Red]: red } : null
}

/**
 * A header's map options, refused rather than defaulted: the terrain is
 * regenerated from them, so a value this build does not understand would
 * replay the match on a different map.
 */
function mapOptionsFrom(raw: unknown): MapOptions {
  if (!raw || typeof raw !== 'object') throw new Error('header: map must be an object')
  const map = raw as Partial<MapOptions>
  const options: MapOptions = {}
  if (map.size !== undefined) {
    if (typeof map.size !== 'number' || !Number.isInteger(map.size) || map.size < 16 || map.size > 256) {
      throw new Error(`header: map size ${String(map.size)} is not a size this build can lay out`)
    }
    options.size = map.size
  }
  if (map.spawns !== undefined) {
    if (map.spawns !== 'centre' && map.spawns !== 'edge') {
      throw new Error(`header: unknown spawn layout "${String(map.spawns)}"`)
    }
    options.spawns = map.spawns
  }
  return options
}

/**
 * Validate untrusted JSON as a recording.
 *
 * Nothing here repairs a file. A recording is replayed by re-running the rules
 * over it, so a stream with a hole in it does not degrade gracefully — it
 * desynchronises, and then shows a fight that never happened. Refusing the file
 * is the only honest failure, which is why this throws where
 * {@link sanitizeSheet} substitutes: a wrong *sheet* costs display accuracy, a
 * wrong *command* costs the whole replay.
 *
 * @throws Error with a message fit to put in front of the player.
 */
export function parseRecording(raw: unknown): CombatRecording {
  if (!raw || typeof raw !== 'object') throw new Error('not a tictac recording')
  const file = raw as Partial<CombatRecording>

  const rawHeader = file.header
  if (!rawHeader || typeof rawHeader !== 'object') {
    throw new Error('not a tictac recording: no header')
  }
  const head = rawHeader as Partial<RecordingHeader>

  if (head.version !== RECORDING_VERSION) {
    throw new Error(
      `recording version ${String(head.version)} is not supported (expected ${RECORDING_VERSION})`,
    )
  }
  if (typeof head.seed !== 'number' || !Number.isFinite(head.seed)) {
    throw new Error('header: seed must be a number')
  }
  if (typeof head.seedLabel !== 'string') throw new Error('header: seedLabel must be a string')
  if (head.source !== 'live' && head.source !== 'sim') {
    throw new Error(`header: unknown source "${String(head.source)}"`)
  }
  if (!head.squads || typeof head.squads !== 'object') throw new Error('header: squads missing')
  const rawSquads = head.squads as Partial<Record<Faction, unknown>>

  const controllers = controllersFrom(head.controllers)
  const header: RecordingHeader = {
    version: RECORDING_VERSION,
    seed: head.seed >>> 0,
    seedLabel: head.seedLabel,
    source: head.source,
    createdAt: typeof head.createdAt === 'string' ? head.createdAt : '',
    turnCap:
      typeof head.turnCap === 'number' && Number.isFinite(head.turnCap) ? head.turnCap : null,
    squads: {
      [Faction.Blue]: deploymentsFrom(rawSquads[Faction.Blue], 'header.squads.blue'),
      [Faction.Red]: deploymentsFrom(rawSquads[Faction.Red], 'header.squads.red'),
    },
    ...(controllers ? { controllers } : {}),
    ...(head.map === undefined ? {} : { map: mapOptionsFrom(head.map) }),
  }

  if (!Array.isArray(file.events)) throw new Error('not a tictac recording: no events')

  const events: RecordedEvent[] = file.events.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`event ${i}: not an event`)
    const event = entry as Partial<RecordedEvent>
    const command = event.command
    if (!command || typeof command !== 'object') throw new Error(`event ${i}: no command`)

    const type = (command as Partial<NetworkMessage>).type
    if (typeof type !== 'string' || !Object.hasOwn(RpcMethods, type)) {
      throw new Error(`event ${i}: unknown command "${String(type)}"`)
    }
    if (SESSION_COMMANDS[type as NetworkMessage['type']]) {
      throw new Error(`event ${i}: "${type}" is a session command and cannot be replayed`)
    }

    return {
      seq: i,
      turn: typeof event.turn === 'number' && Number.isFinite(event.turn) ? event.turn : 1,
      faction: event.faction === Faction.Red ? Faction.Red : Faction.Blue,
      command,
    }
  })

  return { header, events }
}
