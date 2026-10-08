/**
 * Travel on the world map (GDD-WORLD §2, §3): a squad's waypoint list, where
 * that list puts the squad at a given moment, and the orders that change it.
 *
 * Shared by the server, which schedules arrivals and checkpoints from it
 * (`ITEM-064`), and the client, which draws the squad moving (`ITEM-065`). Both
 * call the same functions with their own reading of the clock. They agree to
 * within the last bits of a float — JavaScript trigonometry is not correctly
 * rounded, so two engines may differ there — which is why anything that must
 * agree exactly is the server's figure, written into the list: an arrival
 * time once recorded (`settle`) is the same number on every side. Nothing here
 * reads the clock or changes a list it is handed: every moment is an
 * argument, and every order returns a new list.
 *
 * **What the maths is.** Distances are great-circle (haversine). Positions
 * along a leg are not: a squad moves in a straight line in latitude and
 * longitude, interpolated linearly from one waypoint to the next. At walking
 * distances the two cannot be told apart; over a continental leg or near a
 * pole they can, and nothing may rely on the path being a geodesic. A leg
 * that crosses the antimeridian goes the short way round rather than across
 * the whole map.
 */

const HOUR_MS = 3_600_000
const EARTH_RADIUS_KM = 6371

export interface LatLng {
  lat: number
  lng: number
}

/** What carries a squad. Vehicles join this once they exist. */
export type TravelMode = 'foot'

/** How hard a squad pushes: slower is quieter (fewer encounters, `ITEM-048`). */
export type Pace = 'cautious' | 'normal' | 'flatOut'

/** How a squad travels on a leg. */
export interface Gait {
  mode: TravelMode
  pace: Pace
}

/**
 * Speed by mode and pace, in km/h (GDD-WORLD §3). Every leg reads its speed
 * from here by the gait it states; there is no default speed to fall back to.
 */
export const SPEED_KMH: Record<TravelMode, Record<Pace, number>> = {
  foot: { cautious: 3, normal: 5, flatOut: 7 },
}

/**
 * The longest stretch between two checkpoints of a trip: the server's alarms
 * are never set further apart than this (GDD-WORLD §3).
 */
export const CHECKPOINT_INTERVAL_MS = HOUR_MS

/**
 * Leaving a waypoint: when, on which trip, and how fast.
 *
 * `trip` is minted by whoever gives the order (the server); this module only
 * carries it. Setting off from rest and "go here now" start a trip; arriving
 * somewhere on the way and "go here first" carry the one in progress on.
 */
export interface Departure {
  at: number
  trip: string
  gait: Gait
}

/** Where the squad has been. `departed` is null at the waypoint it is resting at now. */
export interface PastWaypoint extends LatLng {
  kind: 'past'
  /** When it got here: when it was due, not when anybody noticed (`settle`). */
  arrival: number
  departed: Departure | null
}

/** Where the squad has been told to go. */
export interface FutureWaypoint extends LatLng {
  kind: 'future'
}

/**
 * A squad's route: past waypoints, then future ones. Whenever there is a
 * future waypoint, the last past one has `departed` set — the leg the squad is
 * on starts there.
 */
export type Waypoint = PastWaypoint | FutureWaypoint

/** Progress along the leg a travelling squad is on. */
export interface LegProgress {
  from: LatLng
  to: LatLng
  /** Which of the route's future waypoints this leg ends at, from 0. */
  index: number
  /** From 0 at `from` to 1 at `to`. */
  progress: number
  distanceKm: number
  remainingKm: number
  /** When it reaches `to`. */
  eta: number
}

export type TravelState =
  | { travelling: false; position: LatLng }
  | {
      travelling: true
      position: LatLng
      trip: string
      gait: Gait
      leg: LegProgress
      /** When it reaches the end of its route. */
      arrival: number
    }

/**
 * A moment at which the server weighs what happened on the stretch of a trip
 * just travelled (`ITEM-048`): every whole interval since the trip set off,
 * and the moment the trip ended.
 *
 * `(trip, index)` names it for good: a checkpoint that has passed depends only
 * on waypoints that have passed, so no later order renumbers it. The end
 * counts because a trip may end early — stopped, or turned elsewhere — and a
 * stretch that ended before its hour was up must still be weighed, or
 * stopping every 59 minutes would never meet anything.
 */
export interface Checkpoint {
  trip: string
  index: number
  at: number
  /** The trip's last checkpoint: where it ended, or is planned to. */
  end: boolean
}

/** Great-circle distance in kilometres. */
export function distanceKm(from: LatLng, to: LatLng): number {
  const lat1 = (from.lat * Math.PI) / 180
  const lat2 = (to.lat * Math.PI) / 180
  const dLat = lat2 - lat1
  const dLng = ((to.lng - from.lng) * Math.PI) / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * The point `progress` of the way from `from` to `to`, linear in latitude and
 * longitude (see the module comment). Longitude takes the shorter way round.
 */
export function interpolate(from: LatLng, to: LatLng, progress: number): LatLng {
  const t = Math.max(0, Math.min(1, progress))
  let dLng = to.lng - from.lng
  if (dLng > 180) dLng -= 360
  else if (dLng < -180) dLng += 360
  let lng = from.lng + dLng * t
  if (lng > 180) lng -= 360
  else if (lng < -180) lng += 360
  return { lat: from.lat + (to.lat - from.lat) * t, lng }
}

/** True when the squad has nowhere to go: no route, or it has finished one. */
export function isAtRest(waypoints: readonly Waypoint[]): boolean {
  const last = waypoints.at(-1)
  return last === undefined || (last.kind === 'past' && last.departed === null)
}

/**
 * When the squad reaches each of its future waypoints, in order — if nothing
 * changes its orders. Empty for a squad at rest.
 */
export function plannedArrivals(waypoints: readonly Waypoint[]): number[] {
  return (timedRoute(waypoints)?.legs ?? []).map((leg) => leg.end)
}

/** Where the squad is at `now`, and how far along its route. */
export function positionAt(waypoints: readonly Waypoint[], now: number): TravelState {
  const route = timedRoute(waypoints)
  if (!route) {
    const here = waypoints.at(-1)
    if (here?.kind !== 'past') throw new Error('A squad with no past waypoint has no position.')
    return { travelling: false, position: { lat: here.lat, lng: here.lng } }
  }
  const { legs, departed } = route
  const unfinished = legs.findIndex((leg) => now < leg.end)
  const index = unfinished === -1 ? legs.length - 1 : unfinished
  const leg = legs[index]!
  const span = leg.end - leg.start
  const progress = span > 0 ? Math.max(0, Math.min(1, (now - leg.start) / span)) : 1
  return {
    travelling: true,
    position: interpolate(leg.from, leg.to, progress),
    trip: departed.trip,
    gait: departed.gait,
    leg: {
      from: leg.from,
      to: leg.to,
      index,
      progress,
      distanceKm: leg.distanceKm,
      remainingKm: leg.distanceKm * (1 - progress),
      eta: leg.end,
    },
    arrival: legs.at(-1)!.end,
  }
}

/**
 * Record every arrival due by `now`, each at the moment it was due — so an
 * alarm that fires late, or a server that was asleep, never makes a trip
 * longer than its arithmetic. A waypoint arrived at on the way departs at
 * once, on the same trip at the same gait; the last one is where the squad
 * rests.
 *
 * Settling never moves the squad: `positionAt` gives the same answer for the
 * list before and after. Returns `waypoints` itself when nothing was due.
 */
export function settle(waypoints: readonly Waypoint[], now: number): readonly Waypoint[] {
  const route = timedRoute(waypoints)
  if (!route) return waypoints
  const reached = route.legs.filter((leg) => leg.end <= now).length
  if (reached === 0) return waypoints
  const { past, future } = split(waypoints)
  const { trip, gait } = route.departed
  const recorded = future.slice(0, reached).map((to, i): PastWaypoint => {
    const arrival = route.legs[i]!.end
    return {
      kind: 'past',
      lat: to.lat,
      lng: to.lng,
      arrival,
      departed: i < future.length - 1 ? { at: arrival, trip, gait } : null,
    }
  })
  return [...past, ...recorded, ...future.slice(reached)]
}

/** "Go here": set off from rest. Null when the squad is already travelling. */
export function setOff(
  waypoints: readonly Waypoint[],
  destination: LatLng,
  gait: Gait,
  now: number,
  trip: string,
): Waypoint[] | null {
  if (!isAtRest(waypoints)) return null
  const here = waypoints.at(-1)
  if (here?.kind !== 'past') throw new Error('A squad with no past waypoint has nowhere to set off from.')
  return [...waypoints.slice(0, -1), { ...here, departed: { at: now, trip, gait } }, futureAt(destination)]
}

/** Stop where the squad is. Null when it is not travelling. */
export function stop(waypoints: readonly Waypoint[], now: number): Waypoint[] | null {
  const settled = settle(waypoints, now)
  const state = positionAt(settled, now)
  if (!state.travelling) return null
  return [...split(settled).past, pastAt(state.position, now, null)]
}

/**
 * "Go here now": abandon the route and head for `destination` from where the
 * squad is, on a new trip. Null when it is not travelling — that is `setOff`.
 */
export function redirect(
  waypoints: readonly Waypoint[],
  destination: LatLng,
  gait: Gait,
  now: number,
  trip: string,
): Waypoint[] | null {
  const settled = settle(waypoints, now)
  const state = positionAt(settled, now)
  if (!state.travelling) return null
  return [...split(settled).past, pastAt(state.position, now, { at: now, trip, gait }), futureAt(destination)]
}

/**
 * "Go here first": detour to `destination` from where the squad is, then
 * carry on with the rest of the route — the same trip, at the same gait.
 * Null when it is not travelling.
 */
export function detour(waypoints: readonly Waypoint[], destination: LatLng, now: number): Waypoint[] | null {
  const settled = settle(waypoints, now)
  const state = positionAt(settled, now)
  if (!state.travelling) return null
  const { past, future } = split(settled)
  const turn = pastAt(state.position, now, { at: now, trip: state.trip, gait: state.gait })
  return [...past, turn, futureAt(destination), ...future]
}

/**
 * "Go here next": add `destination` at the end of the route. Null when the
 * squad is not travelling, including one that has already arrived.
 */
export function addStop(waypoints: readonly Waypoint[], destination: LatLng, now: number): Waypoint[] | null {
  const settled = settle(waypoints, now)
  if (isAtRest(settled)) return null
  return [...settled, futureAt(destination)]
}

/**
 * Every checkpoint of `trip`, passed and planned, in order. The planned ones
 * hold only while the orders do; the passed ones hold for good. Empty for a
 * trip this route does not contain.
 */
export function checkpoints(waypoints: readonly Waypoint[], trip: string): Checkpoint[] {
  const { past } = split(waypoints)
  let start: number | null = null
  let end: number | null = null
  for (let i = 0; i < past.length; i++) {
    const departed = past[i]!.departed
    if (departed?.trip !== trip) continue
    start ??= departed.at
    const next = past[i + 1]
    end = next ? next.arrival : (plannedArrivals(waypoints).at(-1) ?? null)
  }
  if (start === null || end === null) return []
  const times: number[] = []
  for (let k = 1; start + k * CHECKPOINT_INTERVAL_MS < end; k++) times.push(start + k * CHECKPOINT_INTERVAL_MS)
  times.push(end)
  return times.map((at, index) => ({ trip, index, at, end: index === times.length - 1 }))
}

/** A leg of the route being travelled, timed. */
interface TimedLeg {
  from: LatLng
  to: LatLng
  start: number
  end: number
  distanceKm: number
}

/** The route ahead, timed from the last departure; null for a squad at rest. */
function timedRoute(waypoints: readonly Waypoint[]): { departed: Departure; legs: TimedLeg[] } | null {
  const { past, future } = split(waypoints)
  const origin = past.at(-1)
  if (!origin?.departed || future.length === 0) return null
  const { departed } = origin
  const msPerKm = HOUR_MS / SPEED_KMH[departed.gait.mode][departed.gait.pace]
  let from: LatLng = origin
  let start = departed.at
  const legs = future.map((to): TimedLeg => {
    const km = distanceKm(from, to)
    const leg = {
      from: { lat: from.lat, lng: from.lng },
      to: { lat: to.lat, lng: to.lng },
      start,
      end: start + km * msPerKm,
      distanceKm: km,
    }
    from = to
    start = leg.end
    return leg
  })
  return { departed, legs }
}

function split(waypoints: readonly Waypoint[]): { past: PastWaypoint[]; future: FutureWaypoint[] } {
  const first = waypoints.findIndex((waypoint) => waypoint.kind === 'future')
  const cut = first === -1 ? waypoints.length : first
  return {
    past: waypoints.slice(0, cut) as PastWaypoint[],
    future: waypoints.slice(cut) as FutureWaypoint[],
  }
}

function pastAt(position: LatLng, now: number, departed: Departure | null): PastWaypoint {
  return { kind: 'past', lat: position.lat, lng: position.lng, arrival: now, departed }
}

function futureAt(destination: LatLng): FutureWaypoint {
  return { kind: 'future', lat: destination.lat, lng: destination.lng }
}
