import { ENCOUNTER } from '../config'
import { rollEncounter, stretchOf } from '../core/Encounters'
import { firstContact } from '../core/Meetings'
import { hashSeed, Rng } from '../core/rng'
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
import type { StandingOrder } from '../sim/Policy'
import { meetingKey, type Encounters } from './Encounters'
import type { MeetingSide, OpenEncounter, OpenMeeting } from './EncounterPort'
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
 *
 * **Two squads meeting** (`ITEM-053`, GDD-WORLD §5.5) is the third thing the
 * schedule holds, keyed by the pair. Whenever a squad's route is written the
 * earliest moment it comes within `ENCOUNTER.meetingRangeKm` of each other
 * squad is solved (`firstContact`) and scheduled, replacing what was; when the
 * moment comes it is solved again against the routes as they are then, and
 * if the two still meet the lobby opens their fight and both squads stop
 * where they stood. Finding them is a straight scan of every squad on the
 * server — O(n) a route written, O(n²) once at `restore` — which is what
 * `ITEM-046` replaces when there is something to shard.
 */

/** The schedule's kind for "a squad reaches its next waypoint". */
const ARRIVAL = 'arrival'
/** The schedule's kind for "a stretch of a squad's trip is ready to be weighed for a contact" (`ITEM-048`). */
const CHECKPOINT = 'checkpoint'
/** The schedule's kind for "two squads come within range of each other", keyed by `pairOf` (`ITEM-053`). */
const MEETING = 'meeting'

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
  /**
   * Open the fight two players' squads make when they meet (`ITEM-053`): the
   * lobby's `openMeeting`. Unset, squads never meet.
   */
  openMeeting?: OpenMeeting
  /**
   * Whether squads of different players can meet at all. The trial switch
   * (GDD-WORLD §5.3): read at the moment of every check, so turning it off
   * (`PLAYER_ENCOUNTERS=off`) stops meetings without a deploy of new code.
   * Unset, on.
   */
  playerEncounters?: () => boolean
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
  private readonly openMeeting: OpenMeeting | undefined
  private readonly playerEncounters: () => boolean
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
    this.openMeeting = options.openMeeting
    this.playerEncounters = options.playerEncounters ?? (() => true)
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
    this.schedule.handle(MEETING, (pair, at) =>
      this.serially(async () => {
        // As for a checkpoint: a meeting that cannot be opened must not stop
        // the schedule firing the rest. It is gone from the schedule, and
        // the squads carry on as if they had not met.
        try {
          await this.meet(pair, at)
        } catch (error) {
          this.log(`meeting ${pair} at ${at} failed: ${error instanceof Error ? error.stack : String(error)}`)
        }
      }),
    )
  }

  /**
   * Schedule every squad's next arrival and checkpoint from the database, as
   * a server does before it lets anybody in. An arrival that fell due while no
   * server was running is due at once, and recorded at the time it should
   * have happened; so is a checkpoint.
   *
   * Meetings are solved for every pair from now: a pair that came within
   * range while no server was running is not found, since nothing says it was
   * not already passed by or fought, and a meeting is nothing to settle
   * after the fact. Every pair is solved once, O(n²) in the squads there are.
   */
  restore(): Promise<void> {
    return this.serially(async () => {
      const squads = (await this.squads.all()).map(({ squad }) => squad)
      for (const squad of squads) this.plan(squad)
      if (!this.meetingsOn()) return
      const now = this.now()
      for (const [i, squad] of squads.entries()) {
        for (const other of squads.slice(i + 1)) this.meetingBetween(squad, other, now)
      }
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
      let next: Squad = { ...squad, waypoints }
      await this.squads.save(next)
      // A stop or a turn ends the trip early, and its last stretch counts.
      if (this.openEncounter && oldTrip && (order.kind === 'stop' || order.kind === 'goHereNow')) {
        const ended = checkpoints(next.waypoints, oldTrip).find((checkpoint) => checkpoint.end)
        if (ended && this.unweighed(next.id, ended)) next = await this.weigh(player, next, ended)
      }
      this.plan(next)
      await this.scheduleMeetings(next, now)
      this.tell(playerId, next)
      return next
    })
  }

  /**
   * Set what the AI fights to when it plays `playerId`'s squad because they
   * are away (`ITEM-053`, GDD-WORLD §5.5). Through the same queue as an order,
   * so a meeting being opened reads either the order before or the one after.
   */
  standing(playerId: string, near: LatLng | null, order: StandingOrder): Promise<Squad> {
    return this.serially(async () => {
      const placed = await this.squads.ensure(playerId, near)
      this.owned(placed)
      await this.squads.setStanding(placed.id, order)
      const next: Squad = { ...placed, standing: order }
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
    // Settling does not move a squad (`settle`), so its meetings stand as they
    // are scheduled: an arrival is not a route written in the sense a meeting
    // reads, and the scan it would cost is for nothing.
    const next: Squad = { ...found.squad, waypoints: [...settled] }
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
      if (squad !== found.squad) {
        this.tell(found.player.id, squad)
        // A squad halted at `next.at` has a new route from then.
        await this.scheduleMeetings(squad, next.at)
      }
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
    const next: Squad = { ...squad, waypoints: halted }
    await this.squads.save(next)
    return next
  }

  /**
   * The moment two squads came within range (`ITEM-053`): solved again against
   * the routes as they are now, since either may have changed after this was
   * scheduled (each change reschedules, so this is the check of a schedule
   * that is not trusted rather than a second way of finding meetings). If
   * they still meet at `at`, the lobby is asked for the fight; one that is
   * opened halts both squads where they stood, and is written down for both
   * players. One that is not — a squad is busy, or has nobody fit — is not
   * written down at all: they passed in the night, and carry on.
   *
   * Off (`playerEncounters`) it does nothing, whatever was scheduled while it
   * was on: it is read here, at the moment, so turning it off needs no deploy.
   * A meeting that fires while it is off is gone; the next route a squad is
   * given, or the next restart, finds the pair again.
   */
  private async meet(pair: string, at: number): Promise<void> {
    const { openMeeting } = this
    if (!openMeeting || !this.meetingsOn()) return
    const [first, second] = pair.split('|') as [string, string]
    // What came due for either squad before `at` is weighed first, on the
    // routes as they were: an alien that found one of them earlier has halted
    // it, which is no meeting at all.
    const a = await this.weighDue(first, at)
    const b = await this.weighDue(second, at)
    if (!a || !b) return
    const contact = firstContact(a.squad.waypoints, b.squad.waypoints, at - 1, ENCOUNTER.meetingRangeKm)
    // `firstContact` is repeatable to the millisecond, but a list that was
    // settled in between re-times its legs through other additions.
    if (!contact || Math.abs(contact.at - at) > 1) return

    // Neither the one who moved nor the one who waited: the pair and the
    // moment decide, so the choice can be audited (GDD-WORLD §5.5).
    // The first draw of a generator seeded from them, not the hash's own low
    // bit, which is the parity of the characters and says little.
    const [blue, red] = new Rng(hashSeed(`${pair}|${at}`)).next() < 0.5 ? [a, b] : [b, a]
    const key = meetingKey(pair, at)
    // A meeting already written down was handled before a restart: it is not
    // opened a second time, only the halt it called for is made sure of.
    if (!(await this.encounters.find(blue.squad.id, key, 0))) {
      const opened = await openMeeting({
        blue: sideOf(blue),
        red: sideOf(red),
        at,
        place: contact.place,
      })
      if (!opened.opened) return
      for (const [mine, theirs] of [
        [blue, red],
        [red, blue],
      ] as const) {
        await this.encounters.record({
          squadId: mine.squad.id,
          playerId: mine.player.id,
          trip: key,
          checkpoint: 0,
          at,
          place: contact.place,
          aliens: 0,
          roomId: opened.roomId,
          passedFor: null,
          opponentPlayerId: theirs.player.id,
        })
      }
    }

    // Both stop where they stood at `at`. A squad that was resting has
    // nothing to stop; one whose arrival fell due before `at` has it recorded.
    const halted: Squad[] = []
    for (const { player, squad } of [a, b]) {
      const there = settle(squad.waypoints, at)
      const waypoints = stop(there, at) ?? (there === squad.waypoints ? null : [...there])
      if (!waypoints) continue
      const next: Squad = { ...squad, waypoints }
      await this.squads.save(next)
      this.plan(next)
      this.tell(player.id, next)
      halted.push(next)
    }
    // They are static now, in range of each other and so not meeting; what
    // either was going to meet further on is gone with the route.
    const everyone = (await this.squads.all()).map((row) => row.squad)
    for (const squad of halted) await this.scheduleMeetings(squad, at, everyone)
  }

  /**
   * Replace every meeting `squad` has scheduled with the ones its route now
   * makes, from `from` on: each is the first moment it comes within range of
   * another squad it was not already within range of. `squads` is every
   * squad on this server, read here unless the caller has them.
   */
  private async scheduleMeetings(squad: Squad, from: number, squads?: readonly Squad[]): Promise<void> {
    if (!this.meetingsOn()) return
    for (const other of squads ?? (await this.squads.all()).map((row) => row.squad)) {
      if (other.id !== squad.id) this.meetingBetween(squad, other, from)
    }
  }

  /** Schedule the first moment `a` and `b` come within range of each other from `from` on, or nothing when they never do. */
  private meetingBetween(a: Squad, b: Squad, from: number): void {
    // One server owns every squad today. A squad of another is not in this
    // zone, and no match here is opened for it (RFC-0002 §6.4).
    if (ownerOf(a) !== this.self || ownerOf(b) !== this.self) return
    const pair = pairOf(a.id, b.id)
    const contact = firstContact(a.waypoints, b.waypoints, from, ENCOUNTER.meetingRangeKm)
    if (contact) this.schedule.set(MEETING, pair, contact.at)
    else this.schedule.clear(MEETING, pair)
  }

  /** Whether two squads can meet: there is a lobby to open the fight in, and the trial switch is on. */
  private meetingsOn(): boolean {
    return this.openMeeting !== undefined && this.playerEncounters()
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

/** Two squads as the schedule keys their meeting: the same whichever is named first. */
function pairOf(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** A squad as the lobby is told of one side of a meeting. */
function sideOf({ player, squad }: { player: Player; squad: Squad }): MeetingSide {
  return { player, squadId: squad.id, standing: squad.standing }
}

/** Every squad walks until vehicles exist. */
function onFoot(pace: Gait['pace']): Gait {
  return { mode: 'foot', pace }
}
