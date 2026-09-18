import { Faction, SQUAD_SIZE } from '../config'
import { AMMO, type AmmoId, GRENADES, type GrenadeId, WEAPONS, type WeaponId } from '../core/Arsenal'
import { ATTACHMENTS, type AttachmentId } from '../core/Attachments'
import { type CharacterSheet, sanitizeSheet } from '../core/Characters'
import { ITEMS, type ItemId } from '../core/Items'
import type { ResolvedHit } from './Combat'
import { RpcMethods } from './JsonRpc'
import type { SquadLoadout, UnitLoadout } from './Loadout'
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
export const RECORDING_VERSION = 1

export interface RecordingHeader {
  version: number
  /** Map seed. The terrain is regenerated from it, never stored. */
  seed: number
  seedLabel: string
  source: 'live' | 'sim'
  createdAt: string
  /** The simulation's turn cap, or null for a played match. */
  turnCap: number | null
  /** The people, so playback deploys the same squads rather than rolling new ones. */
  sheets: Record<Faction, CharacterSheet[]>
  /**
   * Both squads' kit.
   *
   * A played match only ever equips one side from a loadout — the other keeps
   * the stock spread, because a peer's attacks arrive already resolved. A
   * replay has no sender, so it needs the numbers both sides fought with.
   */
  loadouts: Record<Faction, SquadLoadout>
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
  resume: true,
  log: true,
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
 * One squad's people, clamped to the squad size.
 *
 * A sheet is the one part of a recording that is substituted rather than
 * refused: {@link sanitizeSheet} plays a malformed one as an average soldier,
 * and a wrong *character* costs display accuracy where a wrong *command* would
 * cost the whole replay. Short arrays are left short, which leaves the
 * remaining units on the placeholder the squad was built with.
 */
function sheetsFrom(raw: unknown): CharacterSheet[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, SQUAD_SIZE).map(sanitizeSheet)
}

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
 * One squad's kit, checked entry by entry.
 *
 * Weapon and ammo ids are refused rather than defaulted: a replay resolves its
 * own damage from the weapon named here, so substituting a rifle for an id this
 * build does not know would quietly show a different fight.
 *
 * Exported because a *peer's* kit needs exactly the same check as a file's. It
 * arrives in `ready` now rather than only as replicated component state,
 * because a referee has to rebuild the match from its intents and a loadout is
 * not derivable from them.
 */
export function squadLoadoutFrom(raw: unknown, what: string): SquadLoadout {
  if (!Array.isArray(raw)) throw new Error(`${what}: loadout must be an array`)

  return raw.slice(0, SQUAD_SIZE).map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`${what}[${i}]: not a loadout entry`)
    const unit = entry as Partial<UnitLoadout>

    // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so a file
    // naming `'toString'` would pass and then be equipped as a weapon.
    if (typeof unit.weaponId !== 'string' || !Object.hasOwn(WEAPONS, unit.weaponId)) {
      throw new Error(`${what}[${i}]: unknown weapon "${String(unit.weaponId)}"`)
    }
    if (typeof unit.ammoId !== 'string' || !Object.hasOwn(AMMO, unit.ammoId)) {
      throw new Error(`${what}[${i}]: unknown ammo "${String(unit.ammoId)}"`)
    }

    const attachments = Array.isArray(unit.attachments) ? unit.attachments : []
    return {
      weaponId: unit.weaponId as WeaponId,
      ammoId: unit.ammoId as AmmoId,
      grenades: counts<GrenadeId>(GRENADES, unit.grenades),
      items: counts<ItemId>(ITEMS, unit.items),
      attachments: attachments.filter(
        (id): id is AttachmentId => typeof id === 'string' && Object.hasOwn(ATTACHMENTS, id),
      ),
    }
  })
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
  if (!head.sheets || typeof head.sheets !== 'object') throw new Error('header: sheets missing')
  if (!head.loadouts || typeof head.loadouts !== 'object') {
    throw new Error('header: loadouts missing')
  }

  const rawSheets = head.sheets as Partial<Record<Faction, unknown>>
  const rawLoadouts = head.loadouts as Partial<Record<Faction, unknown>>

  const header: RecordingHeader = {
    version: RECORDING_VERSION,
    seed: head.seed >>> 0,
    seedLabel: head.seedLabel,
    source: head.source,
    createdAt: typeof head.createdAt === 'string' ? head.createdAt : '',
    turnCap:
      typeof head.turnCap === 'number' && Number.isFinite(head.turnCap) ? head.turnCap : null,
    sheets: {
      [Faction.Blue]: sheetsFrom(rawSheets[Faction.Blue]),
      [Faction.Red]: sheetsFrom(rawSheets[Faction.Red]),
    },
    loadouts: {
      [Faction.Blue]: squadLoadoutFrom(rawLoadouts[Faction.Blue], 'header.loadouts.blue'),
      [Faction.Red]: squadLoadoutFrom(rawLoadouts[Faction.Red], 'header.loadouts.red'),
    },
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
