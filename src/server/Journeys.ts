import { rollEncounter, stretchOf } from '../core/Encounters'
import {
  addStop,
  type Checkpoint,
  checkpoints,
  type Departure,
  detour,
  type Gait,
  isAtRest,
  type LatLng,
  plannedArrivals,
  positionAt,
  redirect,
  setOff,
  settle,
  stop,
  type Waypoint,
} from '../core/Travel'
import { RPC_ERRORS, type Player, type Squad, type SquadOrder } from '../game/Rpc'
import type { Encounters } from './Encounters'
import type { OpenEncounter } from './EncounterPort'
import { Refusal } from './Lobby'
import { MATCH_SERVER, ownerOf } from './Owner'
import type { Schedule } from './Schedule'
import type { Squads } from './Squads'

/**
 * Squads on the move (GDD-WORLD §3, `ITEM-064`): orders in, arrivals out.
 *
 * An order is checked against the travel maths (`src/core/Travel.ts`) and the
 * route it makes is written, scheduled and pushed. The schedule holds each
 * travelling squad's next arrival; when the alarm reaches it, every arrival
 * due by then is recorded at the moment it was due (`settle`), and the next
 * one is scheduled. Between those moments nothing runs: the squad's position
 * is arithmetic on the route, which every window does for itself.
 *
 * Everything here — an order, an arrival, a restart — goes through one queue,
 * so an alarm and a request can never read the same route and both write it.
 */

/** The schedule's kind for "a squad reaches its next waypoint". */
const ARRIVAL = 'arrival'
/** The schedule's kind for "a stretch of a squad's trip is ready to be weighed for a contact" (`ITEM-048`). */
const CHECKPOINT = 'checkpoint'

const ALREADY_MOVING = 'Your squad is already on the move: send it somewhere now, first or next instead.'
const NOT_MOVING = 'Your squad is not on the move.'
const NOT_HERE = 'That squad is kept by another match server.'

export interface JourneysOptions {
  squads: Squads
  /** Where a contact is written down, so a checkpoint is handled once (`ITEM-048`). */
  encounters: Encounters
  schedule: Schedule
  now: () => number
  /** Tell `playerId`'s window its squad has a new route (`squad/changed`). */
  tell: (playerId: string, squad: Squad) => void
  /** This match server's name, for `ownerOf`. */
  self?: string
  /** A new trip's id. */
  mintTrip?: () => string
  /**
   * Open the fight when something finds a squad (`ITEM-048`): the lobby's
   * `openEncounter`, wired by the host. Unset on a host that has no lobby
   * to open one in; a contact is then not rolled for at all.
   */
  openEncounter?: OpenEncounter
  /** Called for anything worth a line in a server log. */
  log?: (message: string) => void
}

export class Journeys {
  private readonly squads: Squads
  private readonly encounters: Encounters
  private readonly schedule: Schedule
  private readonly now: () => number
  private readonly tell: (playerId: string, squad: Squad) => void
  private readonly self: string
  private readonly mintTrip: () => string
  private readonly openEncounter: OpenEncounter | undefined
  private readonly log: (message: string) => void
  /**
   * The last checkpoint of each squad's trip that has been weighed. Memory
   * only: after a restart a squad's checkpoints are weighed again, which is
   * harmless because a roll is a function of its key and a contact has its row.
   */
  private readonly weighed = new Map<string, { trip: string; index: number }>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: JourneysOptions) {
    this.squads = options.squads
    this.encounters = options.encounters
    this.schedule = options.schedule
    this.now = options.now
    this.tell = options.tell
    this.self = options.self ?? MATCH_SERVER
    this.mintTrip = options.mintTrip ?? (() => crypto.randomUUID())
    this.openEncounter = options.openEncounter
    this.log = options.log ?? ((message) => console.warn(`[journeys] ${message}`))
    this.schedule.handle(ARRIVAL, (id, at) => this.serially(() => this.arrive(id, at)))
    this.schedule.handle(CHECKPOINT, (id, at) =>
      this.serially(async () => {
        // A contact that cannot be opened must not stop the schedule firing the
        // rest; the checkpoint stays unweighed and the next arrival or order
        // weighs it again.
        try {
          const found = await this.weighDue(id, at)
          if (found) this.plan(found.squad)
        } catch (error) {
          this.log(`checkpoint of squad ${id} failed: ${error instanceof Error ? error.stack : String(error)}`)
        }
      }),
    )
  }

  /**
   * Schedule every squad's next arrival and checkpoint from the database, as
   * a server does before it lets anybody in. An arrival that fell due while no
   * server was running is due at once, and recorded at the time it should
   * have happened; so is a checkpoint.
   */
  restore(): Promise<void> {
    return this.serially(async () => {
      for (const { squad } of await this.squads.all()) this.plan(squad)
    })
  }

  /**
   * Give `playerId`'s squad `order`. A player from before squads is placed
   * near `near` first, as `squad/get` would. Refused for a verb that does
   * not fit where the squad is.
   */
  order(playerId: string, near: LatLng | null, order: SquadOrder): Promise<Squad> {
    return this.serially(async () => {
      const placed = await this.squads.ensure(playerId, near)
      this.owned(placed)
      const now = this.now()
      // What was due before this order is weighed on the route as it was,
      // not on the one the order is about to make.
      const { player, squad } = (await this.weighDue(placed.id, now))!
      const oldTrip = tripOf(squad.waypoints)
      const waypoints = this.apply(squad.waypoints, order, now)
      if (!waypoints) throw new Refusal(RPC_ERRORS.conflict, order.kind === 'goHere' ? ALREADY_MOVING : NOT_MOVING)
      let next: Squad = { id: squad.id, waypoints }
      await this.squads.save(next)
      // A stop or a turn ends the trip early, and its last stretch counts.
      if (this.openEncounter && oldTrip && (order.kind === 'stop' || order.kind === 'goHereNow')) {
        const ended = checkpoints(next.waypoints, oldTrip).find((checkpoint) => checkpoint.end)
        if (ended && this.unweighed(next.id, ended)) next = await this.weigh(player, next, ended)
      }
      this.plan(next)
      this.tell(playerId, next)
      return next
    })
  }

  private apply(waypoints: readonly Waypoint[], order: SquadOrder, now: number): Waypoint[] | null {
    switch (order.kind) {
      case 'goHere':
        return setOff(waypoints, order.to, onFoot(order.pace), now, this.mintTrip())
      case 'goHereNow':
        return redirect(waypoints, order.to, onFoot(order.pace), now, this.mintTrip())
      case 'goHereFirst':
        return detour(waypoints, order.to, now)
      case 'goHereNext':
        return addStop(waypoints, order.to, now)
      case 'stop':
        return stop(waypoints, now)
    }
  }

  /**
   * The alarm reached a squad's next arrival: weigh what came before it,
   * record the arrival at the moment it was due, and schedule what is next.
   * Only up to `at`: an arrival due later has its own moment, and a
   * checkpoint between the two must see the route as it was then.
   */
  private async arrive(id: string, at: number): Promise<void> {
    const weighed = await this.weighDue(id, at)
    const found = weighed ?? (await this.squads.byId(id))
    if (!found) return
    this.owned(found.squad)
    const settled = settle(found.squad.waypoints, at)
    if (settled === found.squad.waypoints) {
      this.plan(found.squad)
      return
    }
    const next: Squad = { id, waypoints: [...settled] }
    await this.squads.save(next)
    this.plan(next)
    this.tell(found.player.id, next)
  }

  /**
   * Weigh every checkpoint of the squad's trip due by `until`, earliest first,
   * each on the route as it stood at its own moment. A contact that halts
   * the squad cuts its trip short, so the loop reads the route afresh each
   * time. Returns the squad as it is after, or null for one that is gone.
   */
  private async weighDue(id: string, until: number): Promise<{ player: Player; squad: Squad } | null> {
    let found = await this.squads.byId(id)
    if (!this.openEncounter) return found
    while (found) {
      this.owned(found.squad)
      const next = this.nextCheckpoint(found.squad)
      if (!next || next.at > until) return found
      const squad = await this.weigh(found.player, found.squad, next)
      if (squad !== found.squad) this.tell(found.player.id, squad)
      found = { player: found.player, squad }
    }
    return found
  }

  /**
   * Roll one checkpoint (GDD-WORLD §5.1). Nothing found: nothing changes. A
   * fight opened: the squad is halted where it stood at the checkpoint. A
   * squad passed by carries on. Returns the squad, a new object if it was
   * halted.
   */
  private async weigh(player: Player, squad: Squad, checkpoint: Checkpoint): Promise<Squad> {
    const { trip, index } = checkpoint
    const stretch = stretchOf(squad.waypoints, trip, index)
    const roll = stretch && rollEncounter({ squad: squad.id, trip, index }, stretch)
    if (!roll?.met || !this.openEncounter) {
      this.weighed.set(squad.id, { trip, index })
      return squad
    }
    const there = settle(squad.waypoints, checkpoint.at)
    const place = positionAt(there, checkpoint.at).position
    // A contact already written down was handled before a restart: it is not
    // opened a second time, only the halt it called for is made sure of.
    let outcome = await this.encounters.find(squad.id, trip, index)
    if (!outcome) {
      const opened = await this.openEncounter({
        player,
        squadId: squad.id,
        trip,
        checkpoint: index,
        at: checkpoint.at,
        place,
        alienSeed: roll.alienSeed,
        sizeOffset: roll.sizeOffset,
      })
      outcome = opened.opened
        ? { roomId: opened.roomId, passedFor: null }
        : { roomId: null, passedFor: opened.passedFor }
      await this.encounters.record({
        squadId: squad.id,
        playerId: player.id,
        trip,
        checkpoint: index,
        at: checkpoint.at,
        place,
        aliens: opened.opened ? opened.aliens : 0,
        ...outcome,
      })
    }
    this.weighed.set(squad.id, { trip, index })
    if (outcome.roomId === null) return squad
    // Contact stops the squad where it stood. A squad that has already
    // arrived has nothing left to stop.
    const halted = stop(there, checkpoint.at)
    if (!halted) return squad
    const next: Squad = { id: squad.id, waypoints: halted }
    await this.squads.save(next)
    return next
  }

  /** The first checkpoint of the squad's trip nobody has weighed, or null. */
  private nextCheckpoint(squad: Squad): Checkpoint | null {
    const trip = tripOf(squad.waypoints)
    if (!trip) return null
    // Whatever fell due before the squad's latest departure was weighed before
    // that departure was written (`order`, `arrive`), and the route no longer
    // says where the squad stood then.
    const since = departureOf(squad.waypoints)!.at
    return (
      checkpoints(squad.waypoints, trip).find(
        (checkpoint) => checkpoint.at > since && this.unweighed(squad.id, checkpoint),
      ) ?? null
    )
  }

  private unweighed(id: string, checkpoint: Checkpoint): boolean {
    const done = this.weighed.get(id)
    return !(done?.trip === checkpoint.trip && checkpoint.index <= done.index)
  }

  /** Schedule `squad`'s next arrival and checkpoint, or nothing for a squad at rest. */
  private plan(squad: Squad): void {
    if (isAtRest(squad.waypoints)) {
      this.schedule.clear(ARRIVAL, squad.id)
      this.schedule.clear(CHECKPOINT, squad.id)
      return
    }
    this.schedule.set(ARRIVAL, squad.id, plannedArrivals(squad.waypoints)[0]!)
    const next = this.openEncounter ? this.nextCheckpoint(squad) : null
    if (next) this.schedule.set(CHECKPOINT, squad.id, next.at)
    else this.schedule.clear(CHECKPOINT, squad.id)
  }

  /**
   * Every squad request is answered by the server that owns the squad. One
   * server owns them all today; when the world is split (`ITEM-046`), this
   * is where a request for somebody else's squad is handed on.
   */
  private owned(squad: Squad): void {
    if (ownerOf(squad) !== this.self) throw new Refusal(RPC_ERRORS.conflict, NOT_HERE)
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work)
    this.queue = done.catch(() => {})
    return done
  }
}

/** The latest departure a route holds: the one its current trip, or its last, is on. */
function departureOf(waypoints: readonly Waypoint[]): Departure | null {
  for (const waypoint of waypoints.toReversed()) {
    if (waypoint.kind === 'past' && waypoint.departed) return waypoint.departed
  }
  return null
}

function tripOf(waypoints: readonly Waypoint[]): string | null {
  return departureOf(waypoints)?.trip ?? null
}

/** Every squad walks until vehicles exist. */
function onFoot(pace: Gait['pace']): Gait {
  return { mode: 'foot', pace }
}
