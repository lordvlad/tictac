import type { LatLng } from '../core/Travel'
import type { Transport } from '../wire/Transport'
import { BUILD_ID, PROTOCOL_VERSION } from '../version'
import type { AccountsPort } from './AccountsPort'
import type { RelyingParty } from './AccountStore'
import type { ServerClock } from './Clock'
import { Crossings } from './Crossings'
import type { RegionPeers } from './Handover'
import { Journeys, type JourneysOptions } from './Journeys'
import { Lobby, type LobbyOptions } from './Lobby'
import { regionDirectory, type RegionDirectory, type RegionPartition } from './Owner'
import { relatedOriginsHandler } from './RelatedOrigins'
import type { RegionStore } from './RegionStore'
import { Schedule } from './Schedule'
import { serial } from './Serial'
import { Sessions } from './Session'
import type { TileHandler } from './Tiles'

/**
 * The match server, assembled once.
 *
 * Two hosts run it — `startGameServer` (`GameServer.ts`) on Bun, and
 * `MatchDurableObject` (`workers/`) on Cloudflare — and each used to assemble
 * its own lobby, sessions, journeys and schedule, which is how the two came to
 * differ: a clock here, a place there, a status route on one only, so every
 * test of the Bun host exercised wiring production did not run. Now both call
 * {@link createMatchServer} with the same {@link MatchServerPorts}, and what a
 * host adds is only what its platform is: where a socket comes from, how the
 * alarm is armed, where the stores live.
 *
 * Nothing in here may name a platform. A platform's difference is a port.
 */

/** The host's one alarm, which the travel schedule arms for the earliest moment any squad has due. */
export interface AlarmPort {
  /**
   * Arm the alarm for `at` (ms on the host's clock), replacing any other; null
   * disarms it. `fire` runs whatever is due and re-arms for the next moment.
   * A host whose runtime delivers the alarm itself (a Durable Object, which
   * keeps it in storage so it fires even to an evicted instance) ignores
   * `fire` and calls {@link MatchServer.alarm} when the runtime does; a host
   * with a timer calls `fire` when the timer goes off.
   */
  arm(at: number | null, fire: () => Promise<void>): void
}

export interface MatchServerPorts {
  /** The host's one clock: squads travel by it, handovers expire by it, sessions last by it. */
  clock: ServerClock
  /**
   * Who a player is. The directory's accounts: in this process when the host
   * holds the directory, over RPC to the directory's Durable Object when it
   * does not (`AccountsPort`).
   */
  accounts: AccountsPort
  /** This region's database. */
  region: RegionStore
  alarm: AlarmPort
  /**
   * Where the connection that opened `request` came from, if the platform can
   * tell (`request.cf` on Cloudflare): what a new player's squad is placed
   * near. Null where it cannot — and a host that wants a place for every
   * connection, a test, says it here.
   */
  placeOf(request: Request): LatLng | null
  /** The passkeys' relying party, which the server also publishes the related origins of (`RelatedOrigins.ts`). */
  party: RelyingParty
  /** The partition table this host routes places by; the deployed one (`REGIONS`) unless set. */
  regions?: readonly RegionPartition[]
  /**
   * Whether squads of different players can meet (`ITEM-053`): the trial
   * switch, read at every check; on unless this says otherwise.
   */
  playerEncounters?: () => boolean
  /** How long a dropped seat is held; the lobby's default unless a test says otherwise. */
  graceMs?: number
  /** Map tiles at `/tiles/{z}/{x}/{y}.mvt` (`ITEM-061`); none when unset. On Cloudflare the Worker answers them before a request gets here. */
  tiles?: TileHandler
  /**
   * What a test replaces of the lobby the factory builds — a match seed, a
   * build, who hears a verdict — over its own choices. Hosts leave it unset.
   * `matches`, `rooms` and `clock` stay the host's: they are what makes it
   * this server's lobby.
   */
  lobby?: Partial<Omit<LobbyOptions, 'matches' | 'rooms' | 'clock'>>
  /**
   * What a test replaces of the journeys the factory builds: who opens a fight
   * when a squad is found or two meet (an explicit `undefined` turns that
   * off, as on a host with no lobby), and how a trip is named. Hosts leave it unset.
   */
  journeys?: Partial<Pick<JourneysOptions, 'openEncounter' | 'openMeeting' | 'mintTrip'>>
  /**
   * The other regions, as this host reaches them: DO RPC to the region's
   * object on Cloudflare, the server itself in a test. Unset on a host with no
   * other region, which then neither sends squads across a border nor takes
   * one (RFC-0002 §2).
   */
  peers?: RegionPeers
  log?: (message: string) => void
}

export interface MatchServer {
  lobby: Lobby
  journeys: Journeys
  sessions: Sessions
  crossings: Crossings
  directory: RegionDirectory
  /** Take a socket the platform has accepted for `request`: everything it says from now on goes to the sessions. */
  accept(transport: Transport, request: Request): void
  /**
   * The HTTP the match server answers itself: map tiles when it has them, the
   * passkeys' related origins, and the status document at `/status` — the one
   * question a client needs answered before it commits to a match: are we
   * running the same build? Null for anything else, which is the host's own
   * (the built client, on the Durable Object).
   */
  http(request: Request): Promise<Response | null>
  /** The alarm went off: whatever is due runs, and the next moment is armed. */
  alarm(): Promise<void>
  /** Stop serving. Rooms still live stay in the database for the next server to restore; the database is the caller's. */
  dispose(): Promise<void>
}

export async function createMatchServer(ports: MatchServerPorts): Promise<MatchServer> {
  const { clock, accounts, region, alarm } = ports
  const log = ports.log ?? ((message: string) => console.info(`[referee] ${message}`))

  const lobby = new Lobby({
    matches: region.matches,
    rooms: region.rooms,
    rosters: region.rosters,
    log,
    graceMs: ports.graceMs,
    // The same clock the squads travel by: a fight found on the road keeps a
    // seat for its player until a moment on it.
    clock,
    onEncounterTaken: (roomId, playerId) => {
      region.encounters
        .markTaken(roomId, playerId)
        .catch((error: unknown) => log(`could not record that ${roomId} was taken: ${String(error)}`))
    },
    onVerdict: (verdict) => {
      log(`verdict on ${verdict.matchId}: ${verdict.reason}`)
      for (const found of verdict.found) {
        log(`  ${found.unit ?? ''} ${found.what}: referee ${found.mine}, client ${found.theirs}`)
      }
    },
    ...ports.lobby,
  })
  // Before a socket is let in: a window reconnecting to its seat the moment
  // this server is up has to find the room already held for it.
  await lobby.restore()

  const schedule: Schedule = new Schedule(
    {
      now: () => clock.now(),
      arm: (at) => alarm.arm(at, () => schedule.fire()),
    },
    (message) => log(`[schedule] ${message}`),
  )
  const directory = regionDirectory({ owners: region.squads, partitions: ports.regions, self: region.self })
  // One queue for everything that writes a squad's route: an order, an arrival, a crossing.
  const serially = serial()
  const crossings: Crossings = new Crossings({
    clock,
    directory,
    region,
    accounts,
    schedule,
    serially,
    lobby,
    peers: ports.peers,
    adopt: (squadId) => journeys.adopt(squadId),
    log,
  })
  const journeys: Journeys = new Journeys({
    serially,
    crossings,
    directory,
    squads: region.squads,
    accounts,
    encounters: region.encounters,
    schedule,
    clock,
    tell: (playerId, squad) => lobby.tell(playerId, 'tictac/api/squad/changed', { squad }),
    openEncounter: (contact) => lobby.openEncounter(contact),
    openMeeting: (meeting) => lobby.openMeeting(meeting),
    playerEncounters: ports.playerEncounters,
    log,
    ...ports.journeys,
  })
  // Before the squads' own schedule: a crossing's squads that were committed here are this region's to adopt.
  await crossings.restore()
  await journeys.restore()

  const sessions = new Sessions({ lobby, accounts, region, journeys, crossings, peers: ports.peers, clock, log })
  const relatedOrigins = relatedOriginsHandler(ports.party)

  return {
    lobby,
    journeys,
    sessions,
    crossings,
    directory,
    accept(transport, request) {
      sessions.attach(transport, { place: ports.placeOf(request) })
      log('a client connected')
    },
    async http(request) {
      const tile = await ports.tiles?.(request)
      if (tile) return tile
      const related = relatedOrigins(request)
      if (related) return related
      if (new URL(request.url).pathname !== '/status') return null
      return Response.json({
        referee: 'tictac',
        protocol: PROTOCOL_VERSION,
        build: BUILD_ID,
        rooms: lobby.view(null).rooms.length,
        recent: await region.matches.recent(5),
      })
    },
    alarm: () => schedule.fire(),
    async dispose() {
      alarm.arm(null, () => schedule.fire())
      await lobby.dispose()
    },
  }
}
