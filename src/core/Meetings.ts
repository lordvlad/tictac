/**
 * When two squads' routes bring them within reach of each other (GDD-WORLD
 * §5.5, `ITEM-053`): the first moment, solved and not sampled.
 *
 * **The model is Travel's** (`src/core/Travel.ts`): a squad that rests is a
 * point for all time; one that travels moves in a straight line in latitude
 * and longitude along each leg, timed from the route's last departure, and
 * rests at its last future waypoint once it has arrived. The route as
 * planned: a route that changes later is the caller's business, who asks
 * again with the new one. Past waypoints are history and play no part.
 *
 * **The solving.** Cut time wherever either squad's leg starts or ends. Between
 * two cuts both squads move linearly, so their separation — east and north, in
 * kilometres, in a flat frame at the pair's mean latitude (east-west scaled by
 * its cosine, longitude taken the short way round the antimeridian as
 * `interpolate` does) — is a linear function of time, and `distance = range` is
 * a quadratic whose first root is the entry. The cosine changes along a long
 * leg, so the frame is taken at the answer itself: the quadratic is solved
 * again with the cosine at its own root until the root stops moving (a few
 * rounds, since the cosine hardly depends on the root).
 *
 * **Accuracy.** What remains is the difference between the flat frame and the
 * sphere: about `(d / (6371 km · cos φ))² / 24` of the separation `d` — a few
 * micrometres at 1 km at 49°, under a millimetre up to 87° — and the rounding
 * of the moment up to a whole millisecond, which is a few millimetres of
 * walking (3.9 mm at most, for two squads closing at 14 km/h). The haversine
 * distance between the squads at the returned moment is within a centimetre of
 * the range at 1 km (`tests/meetings.test.ts` pins that), and the flat frame's
 * share grows with the square of the range: 1.6 mm at 10 km at 49°.
 *
 * **A meeting is a crossing.** The pair must have been out of range just
 * before: one already within range at `from` meets nobody until one has left
 * range and come back. Within range is `distance <= range` with a relative
 * slack of a billionth (a micrometre at 1 km), so a touch that grazes exactly —
 * the closest approach is the range, or a leg ends exactly at it — is decided
 * by the geometry and not by the last bit of a float.
 *
 * **Reproducible.** Every figure is anchored at the routes' own leg boundaries
 * and never at `from`, so the same two routes give the same moment whatever
 * `from` precedes it: asking again from a millisecond before the answer gives
 * the answer, bit for bit. Nothing here reads the clock or changes a list.
 */

import {
  EARTH_RADIUS_KM,
  HOUR_MS,
  interpolate,
  type LatLng,
  positionAt,
  type TimedLeg,
  timedRoute,
  type Waypoint,
} from './Travel'

const RADIANS = Math.PI / 180
const KM_PER_DEGREE = EARTH_RADIUS_KM * RADIANS

/**
 * How far past the range still counts as within it, relative to the range.
 * Without it an exactly constructed touch is in or out by rounding.
 */
const RANGE_SLACK = 1e-9

/** The ways round the globe a relative longitude may be read: 360 degrees either side. */
const TURNS = [-1, 0, 1]

/**
 * The frame is moved to the last answer until it moves by less than this, in
 * hours (a few microseconds), or this many times. The cosine's dependence on the
 * answer is so weak that two or three rounds is what it takes.
 */
const ANCHOR_TOLERANCE_HOURS = 1e-9
const ANCHOR_ROUNDS = 8

/** A squad's route as legs, with what it does outside them. */
interface Track {
  /** The legs, in order; none for a squad at rest. */
  legs: readonly TimedLeg[]
  /** Where it stands before its first leg starts. */
  origin: LatLng
  /** Where it stands after its last leg ends. */
  last: LatLng
}

/** Where a squad is at the start of a stretch, and how fast it moves: degrees, and degrees per hour. */
interface Motion {
  lat: number
  lng: number
  vLat: number
  vLng: number
}

/**
 * Two squads over one stretch between cuts, from the first to the second:
 * the way from one to the other and how that changes, in degrees and degrees
 * per hour, and the mean latitude that fixes the frame, moving linearly.
 */
interface Approach {
  dLat: number
  dLng: number
  vLat: number
  vLng: number
  meanLat: number
  vMeanLat: number
}

/** When the pair is within range, hours into the stretch, if it ever is on the line the stretch continues. */
interface Within {
  enter: number
  exit: number
}

/** What one solving of the quadratic found: the closest approach, and the stretch within range if there is one. */
interface Solution {
  nearest: number
  within: Within | null
}

/**
 * The first moment at or after `from` that the two squads, following their
 * routes, come within `rangeKm` of each other having been farther apart just
 * before — or null if they never do. A pair already within range at `from`
 * does not meet until one has left range and come back.
 *
 * `at` is a whole millisecond (the solved moment, rounded up, so the pair is
 * within range at it), and `place` is the midpoint of the two squads then.
 */
export function firstContact(
  a: readonly Waypoint[],
  b: readonly Waypoint[],
  from: number,
  rangeKm: number,
): { at: number; place: LatLng } | null {
  const trackA = trackOf(a)
  const trackB = trackOf(b)
  const reach = rangeKm * (1 + RANGE_SLACK)
  const cuts = cutsOf(trackA, trackB)

  // Before the first cut both squads stand still, so the stretch holding `from`
  // may be the one before it, which has no start.
  const holding = cuts.findLastIndex((cut) => cut <= from)
  const offset = holding < 0 ? 0 : (from - cuts[holding]!) / HOUR_MS
  let inRange =
    separationKm(approachAt(trackA, trackB, holding < 0 ? -Infinity : cuts[holding]!), offset) <= reach

  // After the last cut nothing moves, so nothing can change: the loop ends at the last stretch with an end.
  for (let index = Math.max(holding, 0); index < cuts.length - 1; index++) {
    const start = cuts[index]!
    const hours = (cuts[index + 1]! - start) / HOUR_MS
    const approach = approachAt(trackA, trackB, start)
    if (inRange) {
      // The stretch within range is one piece, so a pair that leaves does not return before the next cut.
      // (Except by circling the globe from one another: 360 degrees of relative longitude between two
      // cuts, more than any walk; such a pair is not seen to have left.)
      inRange = separationKm(approach, hours) <= reach
      continue
    }
    const entry = firstEntry(approach, hours, index === holding ? offset : 0, reach)
    if (entry === null) continue
    const at = Math.ceil(start + entry * HOUR_MS)
    return { at, place: interpolate(motionAt(trackA, at), motionAt(trackB, at), 0.5) }
  }
  return null
}

function trackOf(waypoints: readonly Waypoint[]): Track {
  const legs = timedRoute(waypoints)?.legs
  if (!legs) {
    const here = positionAt(waypoints, 0).position
    return { legs: [], origin: here, last: here }
  }
  const first = legs[0]!
  const final = legs.at(-1)!
  // A leg that takes no time is never the one a squad is on (`motionAt`), so it needs no special care.
  return { legs, origin: interpolate(first.from, first.to, 0), last: interpolate(final.from, final.to, 1) }
}

/** Every moment either squad's leg starts or ends, ascending. */
function cutsOf(a: Track, b: Track): number[] {
  const cuts = new Set<number>()
  for (const leg of [...a.legs, ...b.legs]) {
    cuts.add(leg.start)
    cuts.add(leg.end)
  }
  return [...cuts].sort((x, y) => x - y)
}

/** Where the squad is at `at` and how fast it moves from there to the next cut. */
function motionAt(track: Track, at: number): Motion {
  const leg = track.legs.find((candidate) => at >= candidate.start && at < candidate.end)
  if (!leg) {
    const first = track.legs[0]
    const here = first && at < first.start ? track.origin : track.last
    return { lat: here.lat, lng: here.lng, vLat: 0, vLng: 0 }
  }
  const span = leg.end - leg.start
  const hours = span / HOUR_MS
  const here = interpolate(leg.from, leg.to, (at - leg.start) / span)
  return {
    lat: here.lat,
    lng: here.lng,
    vLat: (leg.to.lat - leg.from.lat) / hours,
    vLng: shortWay(leg.to.lng - leg.from.lng) / hours,
  }
}

function approachAt(a: Track, b: Track, at: number): Approach {
  const one = motionAt(a, at)
  const other = motionAt(b, at)
  return {
    dLat: other.lat - one.lat,
    dLng: shortWay(other.lng - one.lng),
    vLat: other.vLat - one.vLat,
    vLng: other.vLng - one.vLng,
    meanLat: (one.lat + other.lat) / 2,
    vMeanLat: (one.vLat + other.vLat) / 2,
  }
}

/** A difference of longitudes the short way round: the two are 360 degrees apart at most, so one turn is enough. */
function shortWay(degrees: number): number {
  if (degrees > 180) return degrees - 360
  if (degrees < -180) return degrees + 360
  return degrees
}

/** The distance between the pair `hours` into the stretch, in the frame at that moment. */
function separationKm(approach: Approach, hours: number): number {
  const north = (approach.dLat + approach.vLat * hours) * KM_PER_DEGREE
  const east =
    shortWay(approach.dLng + approach.vLng * hours) *
    KM_PER_DEGREE *
    Math.cos((approach.meanLat + approach.vMeanLat * hours) * RADIANS)
  return Math.sqrt(north * north + east * east)
}

/**
 * When, hours into a stretch that starts out of range, the pair is first
 * within it; null if it is not before the stretch ends or if it is only
 * within it before `from` (`lo`, hours into the stretch).
 */
function firstEntry(approach: Approach, hours: number, lo: number, reach: number): number | null {
  let earliest: number | null = null
  // Two squads can close the last of 360 degrees of relative longitude within one stretch
  // (the long legs of the map), and that is the same place as zero: look at each way round.
  const end = approach.dLng + approach.vLng * hours
  for (const turns of TURNS) {
    const shift = turns * 360
    if (Math.max(approach.dLng, end) + shift < -180 || Math.min(approach.dLng, end) + shift > 180) continue
    const crossing = crossingWithin(approach, shift, hours, reach)
    if (crossing === null || crossing.exit < lo || crossing.enter > hours) continue
    const at = Math.max(crossing.enter, lo)
    if (earliest === null || at < earliest) earliest = at
  }
  return earliest
}

/**
 * The stretch within range on the line the pair moves along, the longitude
 * `shift` degrees further on. The frame is moved to where the entry is until
 * it stays put: when the pair is never within range the frame is at the closest
 * approach, which is where being within range is decided.
 */
function crossingWithin(approach: Approach, shift: number, hours: number, reach: number): Within | null {
  let anchor = 0
  let found: Within | null = null
  for (let round = 0; round < ANCHOR_ROUNDS; round++) {
    const solution = solve(approach, shift, anchor, reach)
    found = solution.within
    const next = Math.max(0, Math.min(hours, found?.enter ?? solution.nearest))
    if (Math.abs(next - anchor) <= ANCHOR_TOLERANCE_HOURS) break
    anchor = next
  }
  return found
}

/** The quadratic for `distance = reach` in the frame whose cosine is taken `anchor` hours into the stretch. */
function solve(approach: Approach, shift: number, anchor: number, reach: number): Solution {
  const east = KM_PER_DEGREE * Math.cos((approach.meanLat + approach.vMeanLat * anchor) * RADIANS)
  const x = (approach.dLng + shift) * east
  const y = approach.dLat * KM_PER_DEGREE
  const vx = approach.vLng * east
  const vy = approach.vLat * KM_PER_DEGREE
  const a = vx * vx + vy * vy
  // No relative motion: the distance is what it is, and nothing enters.
  if (a === 0) return { nearest: 0, within: null }
  const b = x * vx + y * vy
  const nearest = -b / a
  const c = x * x + y * y - reach * reach
  const discriminant = b * b - a * c
  if (discriminant < 0) return { nearest, within: null }
  // The root away from cancellation first; the other follows from the product of the roots, `c / a`.
  const root = Math.sqrt(discriminant)
  const q = -(b + (b < 0 ? -root : root))
  const one = q / a
  const other = q === 0 ? one : c / q
  return { nearest, within: { enter: Math.min(one, other), exit: Math.max(one, other) } }
}
