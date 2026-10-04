import { LEVEL_HEIGHT, THROW } from '../config'
import { type Grid, isIndoors, Side, type Tile } from './Grid'
import type { Roll } from './rng'
import { WALLS, WallKind } from './Walls'
import { clamp, distance } from './math'

/**
 * A thrown grenade's flight: a ground track that turns back off walls, judged
 * at the height of a parabolic arc, ending where the arc comes down.
 *
 * The rules (`throwGrenade`), the aiming preview and the animation all read
 * this one flight, so where the preview says a grenade lands, where the rules
 * land it and where the player watches it land are the same place by
 * construction. Arithmetic and square roots only: both peers fly every throw,
 * and `Math.sin` / `Math.atan2` are not guaranteed to agree across engines.
 */

/** Where a throw is aimed, relative to the thrower, in tiles. */
export interface Aim {
  dx: number
  dy: number
}

/** A point on the ground track, in continuous tile coordinates: a tile's centre is `x + 0.5`. */
export interface TrackPoint {
  x: number
  y: number
  /** Distance flown to get here, in tiles. */
  s: number
}

/** A stretch of the flight spent under a roof, which holds the arc down. */
export interface Ceiling {
  /** Distances flown, in tiles, between which the roof is overhead. */
  from: number
  to: number
  /** Height of the roof's underside, metres. */
  y: number
}

export interface ThrowFlight {
  /** The hand, every wall the grenade glanced off, and where it came down, in order. */
  track: TrackPoint[]
  /** Tile it came to rest on. */
  landed: Tile
  /** Height in metres of what it came to rest on: that tile's floor, or the roof over it. */
  landedY: number
  /** Distance flown before it came down, in tiles. */
  length: number
  /**
   * Distance at which it last met a tile edge. Nothing stands in its way after
   * this, which is what lets the drawn flight settle onto the ground there
   * without contradicting anything the rules decided.
   */
  lastCrossing: number
  /** Glazed edges (`Grid.edgeId`) it crossed, in order: each one breaks. */
  panes: number[]
  /** Height of the hand at release, metres. */
  releaseY: number
  /** How far the arc rises above the release at the middle of the throw, metres. */
  apex: number
  /** Length the arc is laid out over: the throw as aimed, capped at the arm's reach. */
  reach: number
  /** Where a roof was overhead, in order of distance flown. */
  ceilings: Ceiling[]
}

/**
 * What a throw is aimed at: a tile, and the storey of it the thrower means —
 * the same tile is a room to throw into from its own floor and a roof to lob
 * onto from the storey above.
 */
export interface ThrowTarget extends Tile {
  level: number
}

/**
 * Is a throw from `from` at `target` thrown low ({@link THROW} `apexLow`)?
 * From under a roof, always: the ceiling allows nothing else. Otherwise when
 * a roof stands over the storey aimed at, so the throw gets in under it.
 */
export function throwsLow(grid: Grid, from: Tile, target: ThrowTarget): boolean {
  return isIndoors(grid, from) || grid.roofAt(target.x, target.y) > target.level
}

/**
 * Where a throw actually goes: `aim` swung sideways and pulled short or long,
 * by up to {@link THROW} `across` / `along` of its length times `error`
 * (`aimError`: the thrower's training and condition). Two draws, sideways
 * first.
 *
 * Swung by a sideways offset rather than an angle, so the direction needs a
 * square root and no trigonometry. The length is scaled on its own, so a
 * sideways miss does not also throw long. A throw at the thrower's own feet
 * has no direction to miss in, and draws nothing.
 */
export function scatterAim(aim: Aim, error: number, roll: Roll): Aim {
  const asked = distance(aim.dx, aim.dy)
  if (asked === 0) return aim
  const across = (roll() * 2 - 1) * THROW.across * error
  const along = (roll() * 2 - 1) * THROW.along * error
  const swungX = aim.dx - aim.dy * across
  const swungY = aim.dy + aim.dx * across
  const scale = (asked * (1 + along)) / distance(swungX, swungY)
  return { dx: swungX * scale, dy: swungY * scale }
}

/** The part of a flight its height is worked out from. */
type Shape = Pick<ThrowFlight, 'releaseY' | 'apex' | 'reach' | 'ceilings'>

/** Height of the free arc `s` tiles in: release height plus a parabola peaking mid-throw. */
function arcHeight(shape: Shape, s: number): number {
  if (shape.reach <= 0) return shape.releaseY
  const u = s / shape.reach
  return shape.releaseY + shape.apex * 4 * u * (1 - u)
}

/** Height the grenade is at `s` tiles in, as the rules judge it: the arc, held under any roof overhead. */
function flownHeight(shape: Shape, s: number): number {
  let height = arcHeight(shape, s)
  for (const ceiling of shape.ceilings) {
    if (s >= ceiling.from && s <= ceiling.to && ceiling.y < height) height = ceiling.y
  }
  return height
}

/**
 * Fly a throw from the centre of `from` along `aim`, for its length but no
 * further than `maxReach` tiles; `low` for a flat throw ({@link throwsLow}).
 *
 * The track is walked edge by edge. At each edge the grenade is at
 * {@link flownHeight}: a wall that is not see-through and stands at least that
 * tall turns it back (mirroring the crossing axis), and the map's edge always
 * does. Glass, open doorways, a hole in the masonry at the storey it is
 * flying through, and anything lower are flown over or through — glass breaks
 * on the way, at any height. Under a roof the arc is held below it, so a lob
 * that went in through a door cannot clear the walls of the room.
 *
 * It comes down at the end of its length, or earlier where the falling arc
 * meets the surface below it, or straight away where it meets a ledge it is
 * already below. The surface is the floor, unless the grenade is up over a
 * roof — it gets above one only from open sky, and stays under one it went in
 * beneath.
 *
 * Through an exact corner it crosses the x face first, then the y face of
 * wherever that left it.
 */
export function flyThrow(grid: Grid, from: Tile, aim: Aim, maxReach: number, low: boolean): ThrowFlight {
  const asked = distance(aim.dx, aim.dy)
  const reach = Math.min(asked, maxReach)
  const apex = low ? THROW.apexLow : THROW.apex
  const shape: Shape = {
    releaseY: grid.levelAt(from.x, from.y) * LEVEL_HEIGHT + THROW.release,
    apex: clamp(reach * apex.perTile, apex.min, apex.max),
    reach,
    ceilings: [],
  }
  const panes: number[] = []

  let x = from.x + 0.5
  let y = from.y + 0.5
  let tileX = from.x
  let tileY = from.y
  let s = 0
  let lastCrossing = 0
  let underRoof = isIndoors(grid, from)
  const track: TrackPoint[] = [{ x, y, s }]

  // Unit heading. A zero-length throw never moves, so it never reads these.
  let vx = asked > 0 ? aim.dx / asked : 0
  let vy = asked > 0 ? aim.dy / asked : 0

  /** What it would come down on over the current tile. */
  const surface = (): number => {
    const floor = grid.levelAt(tileX, tileY) * LEVEL_HEIGHT
    const roof = grid.roofAt(tileX, tileY) * LEVEL_HEIGHT
    return roof > floor && !underRoof ? roof : floor
  }

  /** Note the roof over the current tile as overhead from `from` to `to` flown. */
  const overhead = (from: number, to: number): void => {
    if (!underRoof) return
    const roof = grid.roofAt(tileX, tileY) * LEVEL_HEIGHT
    const last = shape.ceilings[shape.ceilings.length - 1]
    if (last && last.to === from && last.y === roof) last.to = to
    else shape.ceilings.push({ from, to, y: roof })
  }

  /** Does it get across the `side` face of the current tile at `height`? */
  const crosses = (side: Side, nextX: number, nextY: number, height: number): boolean => {
    if (!grid.inBounds(nextX, nextY)) return false
    const kind = grid.wallAt(tileX, tileY, side)
    if (kind === WallKind.Glass) panes.push(grid.edgeId(tileX, tileY, side))
    if (WALLS[kind].transparent) return true
    // The storey it is flying through; skimming a ceiling is still the storey below it.
    if (grid.wallOpenAt(tileX, tileY, side, Math.ceil(height / LEVEL_HEIGHT) - 1)) return true
    return height > grid.wallTop(tileX, tileY, side)
  }

  for (;;) {
    const toX = vx > 0 ? (tileX + 1 - x) / vx : vx < 0 ? (tileX - x) / vx : Infinity
    const toY = vy > 0 ? (tileY + 1 - y) / vy : vy < 0 ? (tileY - y) / vy : Infinity
    const step = Math.min(toX, toY)
    const exit = Math.min(s + step, reach)

    const ground = surface()
    const down = touchdown(shape, ground, s, exit)
    if (down !== null || s + step >= reach) {
      const end = down ?? reach
      overhead(s, end)
      x += vx * (end - s)
      y += vy * (end - s)
      track.push({ x, y, s: end })
      return {
        ...shape,
        track,
        landed: { x: tileX, y: tileY },
        landedY: ground,
        length: end,
        lastCrossing,
        panes,
      }
    }

    overhead(s, s + step)
    x += vx * step
    y += vy * step
    s += step
    lastCrossing = s
    const height = flownHeight(shape, s)
    const wasRoofed = isIndoors(grid, { x: tileX, y: tileY })
    let bounced = false

    if (toX - toY < CORNER) {
      const ahead = tileX + Math.sign(vx)
      // Snap onto the grid line, so rounding cannot drift the walk off it.
      x = vx > 0 ? tileX + 1 : tileX
      if (crosses(vx > 0 ? Side.East : Side.West, ahead, tileY, height)) tileX = ahead
      else {
        vx = -vx
        bounced = true
      }
    }
    if (toY - toX < CORNER) {
      const ahead = tileY + Math.sign(vy)
      y = vy > 0 ? tileY + 1 : tileY
      if (crosses(vy > 0 ? Side.South : Side.North, tileX, ahead, height)) tileY = ahead
      else {
        vy = -vy
        bounced = true
      }
    }
    if (bounced) track.push({ x, y, s })

    // Open sky lets it out from under a roof; a roof is only gone under from
    // open sky, by coming in below it.
    if (!isIndoors(grid, { x: tileX, y: tileY })) underRoof = false
    else if (!wasRoofed || !underRoof) underRoof = height < grid.roofAt(tileX, tileY) * LEVEL_HEIGHT
  }
}

/** Two crossings this close together are one, through a lattice corner. */
const CORNER = 1e-9

/**
 * Distance at which the arc, between `from` and `to` tiles flown, comes down
 * to `ground` — or null when it stays above it. A grenade already at or below
 * it on arrival has met a ledge, and drops there.
 *
 * The free arc is enough: under a roof the ground is the floor, which a held
 * down arc never reaches before the end of the throw either.
 */
function touchdown(shape: Shape, ground: number, from: number, to: number): number | null {
  if (arcHeight(shape, from) <= ground) return from
  // Below the hand the arc only comes back down at the end of the throw.
  const rise = (ground - shape.releaseY) / shape.apex
  if (rise <= 0) return null
  // The falling root of releaseY + apex·4u(1−u) = ground. Still above it on
  // arrival means `from` lies between the roots, so this is ahead of it.
  const s = (shape.reach * (1 + Math.sqrt(1 - rise))) / 2
  return s <= to ? s : null
}

/**
 * The flight's height `s` tiles along it: the height the rules judged it at,
 * and after its last crossing a fall onto what it landed on. Presentation
 * reads this; the rules never ask for a height past the last crossing, so the
 * fall cannot contradict them.
 */
export function heightAt(flight: ThrowFlight, s: number): number {
  const span = flight.length - flight.lastCrossing
  const settled = span > 0 ? clamp((s - flight.lastCrossing) / span, 0, 1) : s >= flight.length ? 1 : 0
  const fall = flight.landedY - flownHeight(flight, flight.length)
  return flownHeight(flight, s) + fall * settled * settled
}
