import {
  addStop,
  detour,
  type Gait,
  isAtRest,
  type LatLng,
  plannedArrivals,
  redirect,
  setOff,
  settle,
  stop,
  type Waypoint,
} from '../core/Travel'
import { RPC_ERRORS, type Squad, type SquadOrder } from '../game/Rpc'
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

const ALREADY_MOVING = 'Your squad is already on the move: send it somewhere now, first or next instead.'
const NOT_MOVING = 'Your squad is not on the move.'
const NOT_HERE = 'That squad is kept by another match server.'

export interface JourneysOptions {
  squads: Squads
  schedule: Schedule
  now: () => number
  /** Tell `playerId`'s window its squad has a new route (`squad/changed`). */
  tell: (playerId: string, squad: Squad) => void
  /** This match server's name, for `ownerOf`. */
  self?: string
  /** A new trip's id. */
  mintTrip?: () => string
}

export class Journeys {
  private readonly squads: Squads
  private readonly schedule: Schedule
  private readonly now: () => number
  private readonly tell: (playerId: string, squad: Squad) => void
  private readonly self: string
  private readonly mintTrip: () => string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: JourneysOptions) {
    this.squads = options.squads
    this.schedule = options.schedule
    this.now = options.now
    this.tell = options.tell
    this.self = options.self ?? MATCH_SERVER
    this.mintTrip = options.mintTrip ?? (() => crypto.randomUUID())
    this.schedule.handle(ARRIVAL, (id) => this.serially(() => this.arrive(id)))
  }

  /**
   * Schedule every squad's next arrival from the database, as a server does
   * before it lets anybody in. An arrival that fell due while no server was
   * running is due at once, and recorded at the time it should have happened.
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
      const squad = await this.squads.ensure(playerId, near)
      this.owned(squad)
      const now = this.now()
      const waypoints = this.apply(squad.waypoints, order, now)
      if (!waypoints) throw new Refusal(RPC_ERRORS.conflict, order.kind === 'goHere' ? ALREADY_MOVING : NOT_MOVING)
      const next: Squad = { id: squad.id, waypoints }
      await this.squads.save(next)
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

  /** The alarm reached a squad's next arrival: record what is due, and schedule what is next. */
  private async arrive(id: string): Promise<void> {
    const found = await this.squads.byId(id)
    if (!found) return
    this.owned(found.squad)
    const settled = settle(found.squad.waypoints, this.now())
    if (settled === found.squad.waypoints) {
      this.plan(found.squad)
      return
    }
    const next: Squad = { id, waypoints: [...settled] }
    await this.squads.save(next)
    this.plan(next)
    this.tell(found.playerId, next)
  }

  /** Schedule `squad`'s next arrival, or nothing for a squad at rest. */
  private plan(squad: Squad): void {
    if (isAtRest(squad.waypoints)) this.schedule.clear(ARRIVAL, squad.id)
    else this.schedule.set(ARRIVAL, squad.id, plannedArrivals(squad.waypoints)[0]!)
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

/** Every squad walks until vehicles exist. */
function onFoot(pace: Gait['pace']): Gait {
  return { mode: 'foot', pace }
}
