import { Faction, GRID_SIZE, SQUAD_SIZE } from '../config'
import {
  Block,
  faceToward,
  Grid,
  ORTHOGONAL,
  Side,
  StairDirection,
  type Tile,
} from './Grid'
import { Surface } from './Surfaces'
import { WallKind } from './Walls'
import { clamp } from './math'
import { Rng } from './rng'

export interface GeneratedMap {
  grid: Grid
  spawns: Record<Faction, Tile[]>
  /** Building footprints, so callers can ask what is indoors. */
  buildings: readonly Rect[]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
/** Smallest room side. Below this a "room" is a cupboard nobody can fight in. */
const MIN_ROOM_SIDE = 3

/** Grid-space step from a tile toward each of its faces. */
const SIDE_OFFSET: Record<Side, readonly [number, number]> = {
  [Side.North]: [0, -1],
  [Side.East]: [1, 0],
  [Side.South]: [0, 1],
  [Side.West]: [-1, 0],
}

/** Storeys above the ground a building may reach. */
const MAX_EXTRA_STOREYS = 2

/**
 * One storey of one building: the rooms it is divided into.
 *
 * A storey above the ground is always made of *whole rooms of the storey
 * below*, never an arbitrary region. That is what keeps a wall standing on a
 * wall — the outline of an upper storey is, by construction, a set of edges
 * that already carry walls from the storey underneath.
 */
interface Storey {
  level: number
  rooms: Rect[]
}

interface Building {
  footprint: Rect
  storeys: Storey[]
}

function rectsOverlap(a: Rect, b: Rect, padding: number): boolean {
  return (
    a.x - padding < b.x + b.w &&
    a.x + a.w + padding > b.x &&
    a.y - padding < b.y + b.h &&
    a.y + a.h + padding > b.y
  )
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

function rectArea(r: Rect): number {
  return r.w * r.h
}

/**
 * Procedural urban battlefield, generated one storey at a time.
 *
 * Each storey is laid out in three rounds — outer walls, then rooms, then
 * openings — and each storey above the ground takes the storey below as its
 * constraint. Vertical access is fitted last, once there is a finished
 * building to fit it into, because a stair needs to know what it lands on.
 *
 * No border pass: the map edge is solid by construction, so there is nothing
 * to draw and no ring of tiles lost to it.
 */
/**
 * How a map is laid out, beyond its seed.
 *
 * Both default to the game as it is played; the options exist so the sweep can
 * ask what a different battlefield does to the fight. They travel in a
 * recording's header, because the terrain is regenerated from the seed and the
 * same seed with different options is a different map.
 */
export interface MapOptions {
  /** Tiles per side. The furniture — buildings, wall runs, crates — scales with the area. */
  size?: number
  /**
   * Where the squads deploy along their own edge. `edge` is the game's.
   *
   * - `edge`: anywhere along the edge, each side drawn independently — so the
   *   two squads can start well off each other's line and the fight has to be
   *   found before it can be had. Chosen over `centre` on measurement: facing
   *   squads 29 tiles apart meet on the first mover's walk every time, and the
   *   side that walks into view loses — the second mover won 62% of mirror
   *   matches centred and 53% along the edge.
   * - `centre`: facing each other across the middle, a few tiles of jitter
   *   apart. Kept so the sweep can still ask the question.
   */
  spawns?: 'centre' | 'edge'
}

export function generateMap(seed: number, options: MapOptions = {}): GeneratedMap {
  const size = options.size ?? GRID_SIZE
  const rng = new Rng(seed)
  const grid = new Grid(size)
  // How much more map there is than the one the furniture counts were tuned
  // on. Exactly 1 at the default size, so the default draws are unchanged.
  const area = (size / GRID_SIZE) ** 2
  const scaled = (count: number): number => Math.round(count * area)

  // --- Deployment zones -----------------------------------------------------
  // Blue deploys along the low-Y edge, Red along the high-Y edge: anywhere
  // along it by default, or centred with a few tiles of jitter when asked.
  const zoneW = SQUAD_SIZE + 3
  const zoneH = 3
  const alongEdge = (): number => rng.int(2, size - 2 - zoneW)
  const centred = (): number => Math.round(size / 2 - zoneW / 2 + rng.range(-4, 4))
  const blueX = options.spawns === 'centre' ? centred() : alongEdge()
  const redX = options.spawns === 'centre' ? centred() : alongEdge()
  const blueZone: Rect = { x: clamp(blueX, 2, size - 2 - zoneW), y: 2, w: zoneW, h: zoneH }
  const redZone: Rect = {
    x: clamp(redX, 2, size - 2 - zoneW),
    y: size - 2 - zoneH,
    w: zoneW,
    h: zoneH,
  }
  const zones = [blueZone, redZone]

  // --- Building footprints --------------------------------------------------
  const buildings: Building[] = []
  const target = scaled(rng.int(5, 8))
  for (let attempt = 0; attempt < scaled(500) && buildings.length < target; attempt++) {
    const w = rng.int(7, 13)
    const h = rng.int(7, 13)
    const footprint: Rect = {
      x: rng.int(2, size - 2 - w),
      y: rng.int(2, size - 2 - h),
      w,
      h,
    }

    if (zones.some((z) => rectsOverlap(footprint, z, 2))) continue
    if (buildings.some((b) => rectsOverlap(footprint, b.footprint, 2))) continue

    buildings.push(planBuilding(footprint, rng))
  }

  // --- Raise the storeys ----------------------------------------------------
  // Ascending, so a tile ends up at the level of the highest storey covering
  // it: the ground floor is the part of the footprint nothing was raised over.
  for (const building of buildings) {
    for (const storey of building.storeys) {
      for (const room of storey.rooms) {
        forEachTile(room, (x, y) => {
          grid.setBlock(x, y, Block.None)
          grid.setLevel(x, y, storey.level)
        })
      }
    }
  }

  // Tiles that later passes must leave alone. A crate dropped on the far side
  // of a building's only door seals the whole ground floor, and a stair whose
  // landing gets flattened stops being a stair.
  const reserved = new Set<number>()
  const reserve = (x: number, y: number): void => {
    reserved.add(grid.index(x, y))
  }

  const doorways: Doorway[] = []
  // --- Build each storey, in three rounds -----------------------------------
  for (const building of buildings) {
    for (const storey of building.storeys) {
      raiseOuterWalls(grid, storey, rng)
      raisePartitions(grid, storey)
      openDoorsAndWindows(grid, rng, storey, buildings, reserve, doorways)
    }
  }

  // --- Roof every room, bar the one you walk on -----------------------------
  // Settling re-roofs from scratch once the terrain is final, so this is the
  // provisional pass the access fitters read.
  roofBuildings(
    grid,
    buildings.map((building) => building.footprint),
  )

  // --- Vertical access ------------------------------------------------------
  for (const building of buildings) {
    fitStairs(grid, rng, building, reserve)
    fitLadders(grid, building, buildings, reserve)
  }

  // --- Free-standing wall runs ---------------------------------------------
  // A run lies along one lattice line: a horizontal run is a row of north-side
  // edges, a vertical run a column of west-side edges. It costs no floor, so
  // both sides of it stay playable.
  const runCount = scaled(rng.int(5, 10))
  for (let i = 0; i < runCount; i++) {
    const horizontal = rng.chance(0.5)
    const length = rng.int(3, 9)
    const w = horizontal ? length : 1
    const h = horizontal ? 1 : length
    const x = rng.int(2, Math.max(2, size - 2 - w))
    const y = rng.int(2, Math.max(2, size - 2 - h))
    const rect: Rect = { x, y, w, h }
    if (zones.some((z) => rectsOverlap(rect, z, 2))) continue
    if (buildings.some((b) => rectsOverlap(rect, b.footprint, 1))) continue

    const side = horizontal ? Side.North : Side.West
    const kind = rng.chance(0.35) ? WallKind.Parapet : WallKind.Solid
    for (let step = 0; step < length; step++) {
      const tx = horizontal ? x + step : x
      const ty = horizontal ? y : y + step
      if (reserved.has(grid.index(tx, ty))) continue
      grid.setWall(tx, ty, side, kind)
    }
  }

  // --- Crate clusters (half cover) -----------------------------------------
  const clusterCount = scaled(rng.int(10, 18))
  for (let i = 0; i < clusterCount; i++) {
    const cx = rng.int(2, size - 3)
    const cy = rng.int(2, size - 3)
    if (zones.some((z) => inRect(z, cx, cy))) continue
    const crates = rng.int(1, 4)
    for (let c = 0; c < crates; c++) {
      const x = cx + rng.int(-1, 1)
      const y = cy + rng.int(-1, 1)
      if (x < 2 || y < 2 || x >= size - 2 || y >= size - 2) continue
      if (zones.some((z) => inRect(z, x, y))) continue
      if (reserved.has(grid.index(x, y))) continue
      if (grid.blockAt(x, y) !== Block.None) continue
      grid.setBlock(x, y, Block.Half)
    }
  }

  // --- Clear the deployment zones ------------------------------------------
  // Both the floor and every edge around it: a squad that starts walled in has
  // nowhere to deploy to.
  for (const zone of zones) {
    forEachTile(zone, (x, y) => {
      grid.setBlock(x, y, Block.None)
      grid.setLevel(x, y, 0)
      grid.setRoof(x, y, 0)
      for (const face of [Side.North, Side.East, Side.South, Side.West]) {
        grid.setWall(x, y, face, WallKind.None)
      }
    })
  }

  // --- Settle the structure, then guarantee connectivity -------------------
  // The repairs below are deliberately crude — they flatten tiles, demote
  // storeys and knock walls through. Settling afterwards puts the invariants
  // back, and the two alternate until both hold.
  const footprints = buildings.map((b) => b.footprint)
  for (let pass = 0; pass < 3; pass++) {
    settleStructures(grid, footprints)
    repairConnectivity(grid, reserved)
  }
  settleStructures(grid, footprints)

  // Last, because settling is what strips a roof back to a bare deck.
  dressRooftops(grid, footprints, rng)

  const spawns: Record<Faction, Tile[]> = {
    [Faction.Blue]: pickSpawns(grid, rng, blueZone),
    [Faction.Red]: pickSpawns(grid, rng, redZone),
  }

  laySurfaces(grid, buildings, new Rng((seed ^ SURFACE_STREAM) >>> 0), scaled)
  hangDoors(grid, doorways, new Rng((seed ^ DOOR_STREAM) >>> 0), spawns[Faction.Blue][0]!)

  return { grid, spawns, buildings: footprints }
}

/**
 * Mixed into the seed for the surfaces' own stream. Their draws come after
 * everything else and from a stream of their own, so giving the ground a
 * material moved no wall, crate or spawn of any seed that existed before.
 */
const SURFACE_STREAM = 0x9e3779b9

/** The doors' own stream, for the same reason as {@link SURFACE_STREAM}. */
const DOOR_STREAM = 0x85ebca6b

/** A doorway round 3 cut, and whether it leads outside. */
interface Doorway {
  x: number
  y: number
  side: Side
  exterior: boolean
}

/** Share of doorways that get a door, inside a building and into one. */
const DOOR_CHANCE = { interior: 0.6, exterior: 0.8 }

/** Share of hung doors that are locked, inside a building and into one. */
const LOCK_CHANCE = { interior: 0.1, exterior: 0.35 }

/**
 * Hang doors in the doorways round 3 cut, once the terrain is final, and
 * lock some of them.
 *
 * Only in a doorway that is still one — the repairs may have walled one up
 * or moved a floor — between two walkable tiles on one floor. A door hangs
 * shut: whoever wants the room opens it, and until then it is a wall to
 * anybody looking. Walking through a shut door is always possible, so a shut
 * door changes nothing about what can be reached.
 *
 * A locked door can: it wants keys or a shoulder. So a door is locked only
 * where every tile reachable from `from` stays reachable without going
 * through it — a lock is a reason to go round, never a room nobody without
 * keys can get into. Mostly the way in from outside, which is where a lock
 * is a decision about how to enter a building.
 */
function hangDoors(grid: Grid, doorways: readonly Doorway[], rng: Rng, from: Tile): void {
  const hung: Doorway[] = []
  for (const doorway of doorways) {
    const { x, y, side } = doorway
    const [dx, dy] = SIDE_OFFSET[side]!
    const nx = x + dx
    const ny = y + dy
    // Drawn for every doorway, valid or not, so one repair cannot shift which
    // of the others get a door, or a lock.
    const hang = rng.chance(doorway.exterior ? DOOR_CHANCE.exterior : DOOR_CHANCE.interior)
    const lock = rng.chance(doorway.exterior ? LOCK_CHANCE.exterior : LOCK_CHANCE.interior)
    if (!hang || !grid.inBounds(nx, ny)) continue
    if (grid.wallAt(x, y, side) !== WallKind.None) continue
    if (!grid.isWalkable(x, y) || !grid.isWalkable(nx, ny)) continue
    if (grid.levelAt(x, y) !== grid.levelAt(nx, ny)) continue
    grid.setWall(x, y, side, WallKind.Door)
    if (lock) hung.push(doorway)
  }

  const reached = (): number => grid.reachableMask(from).reduce((sum, bit) => sum + bit, 0)
  const everywhere = reached()
  for (const { x, y, side } of hung) {
    grid.setWall(x, y, side, WallKind.Locked)
    if (reached() < everywhere) grid.setWall(x, y, side, WallKind.Door)
  }
}

/**
 * Say what every floor is made of (`core/Surfaces`), once the terrain is final.
 *
 * Outdoors is paving, with patches of dry grass. A room is timber or concrete
 * as a whole — a fire that gets into a wooden room has the room — and a flat
 * roof, open to the sky, is concrete. Only tiles whose floor really is the
 * room's storey are laid: connectivity repairs may have lowered some.
 */
function laySurfaces(grid: Grid, buildings: readonly Building[], rng: Rng, scaled: (count: number) => number): void {
  const inside = new Uint8Array(grid.size * grid.size)
  for (const building of buildings) forEachTile(building.footprint, (x, y) => (inside[grid.index(x, y)] = 1))

  const patches = scaled(rng.int(5, 9))
  for (let p = 0; p < patches; p++) {
    const cx = rng.int(1, grid.size - 2)
    const cy = rng.int(1, grid.size - 2)
    const radius = rng.int(1, 3)
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (!grid.inBounds(x, y) || inside[grid.index(x, y)]) continue
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius + 1) continue
        // Ragged at the rim, so a patch reads as growth rather than a disc.
        if (!rng.chance(0.8)) continue
        grid.setSurface(x, y, Surface.Grass)
      }
    }
  }

  for (const building of buildings) {
    for (const storey of building.storeys) {
      for (const room of storey.rooms) {
        const floor = rng.chance(0.55) ? Surface.Timber : Surface.Concrete
        forEachTile(room, (x, y) => {
          if (grid.levelAt(x, y) === storey.level) grid.setSurface(x, y, floor)
        })
      }
    }
    forEachTile(building.footprint, (x, y) => {
      if (grid.roofAt(x, y) === 0 && grid.levelAt(x, y) > 0) grid.setSurface(x, y, Surface.Concrete)
    })
  }
}

/**
 * Restore the structural invariants after the connectivity repairs have had
 * their way with the map.
 *
 * Three things have to hold however the repairs left it. A floor that steps
 * down has masonry on the step, or it is a floor hanging in the air. A stair
 * spans exactly one storey and is enterable from both ends, or it is a ramp to
 * nowhere that also severs the floor it stands on. And every tile indoors is
 * roofed.
 */
function settleStructures(grid: Grid, footprints: readonly Rect[]): void {
  // Masonry first. Validating access before the walls are final would approve
  // a stair that this very pass then seals.
  grid.forEach((x, y) => {
    const level = grid.levelAt(x, y)
    if (level === 0) return
    if (grid.blockAt(x, y) === Block.Stair) return
    for (const [dx, dy] of ORTHOGONAL) {
      const n = { x: x + dx, y: y + dy }
      if (!grid.inBounds(n.x, n.y)) continue
      if (grid.levelAt(n.x, n.y) >= level) continue
      if (grid.blockAt(n.x, n.y) === Block.Stair) continue
      const side = faceToward({ x, y }, n)
      if (side === 0) continue
      if (grid.wallAt(x, y, side) === WallKind.None) {
        grid.setWall(x, y, side, WallKind.Solid)
      }
    }
  })

  // A stair that no longer spans one step, or whose ends are now pockets, is
  // worse than no stair: it severs the floor it stands on. Give the tile back.
  grid.forEach((x, y, block) => {
    if (block !== Block.Stair) return
    const access = grid.getStairAccessTiles(x, y)
    const lower = grid.levelAt(access.lower.x, access.lower.y)
    const upper = grid.levelAt(access.upper.x, access.upper.y)
    const usable =
      upper - lower === 1 &&
      grid.levelAt(x, y) === lower &&
      grid.canTraverse({ x, y }, access.lower) &&
      grid.canTraverse({ x, y }, access.upper) &&
      leadsOnward(grid, access.lower, { x, y }) &&
      leadsOnward(grid, access.upper, { x, y })
    if (!usable) grid.setBlock(x, y, Block.None)
  })

  // A ladder whose footing went away is no longer a ladder. The ones that keep
  // their footing keep their masonry too: the climb passes through a single
  // opening, at the storey it lands on.
  grid.forEach((x, y) => {
    const faces = grid.ladderFacesAt(x, y)
    if (faces === 0) return
    const level = grid.levelAt(x, y)
    const kept: Side[] = []
    for (const side of [Side.North, Side.East, Side.South, Side.West]) {
      if ((faces & side) === 0) continue
      const [dx, dy] = SIDE_OFFSET[side]!
      const foot = { x: x + dx, y: y + dy }
      // Any drop will do — a ladder is climbed in one go however tall it is —
      // but there has to be somewhere to stand at the bottom.
      const drop = level - grid.levelAt(foot.x, foot.y)
      if (drop >= 1 && grid.isWalkable(foot.x, foot.y)) {
        kept.push(side)
      } else {
        // No ladder, no hole: the opening would be a gap onto nothing.
        grid.clearWallOpenings(x, y, side)
      }
    }
    // Faces are only clearable as a set, so drop them all and put back those
    // that still have a footing.
    grid.clearLadderFaces(x, y)
    for (const side of kept) {
      grid.setLadderFace(x, y, side)
      if (grid.wallAt(x, y, side) === WallKind.None) grid.setWall(x, y, side, WallKind.Solid)
      grid.setWallOpening(x, y, side, level)
    }
  })

  // Everything indoors is covered, bar the deck...
  roofBuildings(grid, footprints)

  // ...except stairs, which require ceiling tiles over the ramp to be removed (stairwell cutout).
  grid.forEach((x, y, block) => {
    if (block === Block.Stair) grid.setRoof(x, y, 0)
  })
}

/**
 * Cover every indoor tile, bar the deck.
 *
 * The deck is the highest floor inside the footprint. With one floor per tile
 * that floor *is* the roof, so roofing it would put a slab over the very
 * surface the player is meant to stand on. A footprint that never leaves the
 * ground has no deck: taking its roof off would leave a roofless shed rather
 * than somewhere to stand.
 *
 * Derived from the settled grid rather than from the building record, because
 * settling can lower a storey that nothing could reach.
 */
function roofBuildings(grid: Grid, footprints: readonly Rect[]): void {
  for (const footprint of footprints) {
    let deck = 0
    forEachTile(footprint, (x, y) => {
      deck = Math.max(deck, grid.levelAt(x, y))
    })

    forEachTile(footprint, (x, y) => {
      const level = grid.levelAt(x, y)
      if (deck > 0 && level === deck) return
      grid.setRoof(x, y, level + 1)
    })

    if (deck > 0) openDeckEdges(grid, footprint, deck)
  }
}

/**
 * Take the masonry off the roof's rim, leaving the facade under it standing.
 *
 * A flat roof is bare: walking to the edge and looking down is the point of
 * being up there. The wall cannot simply be cleared, though — it is one column
 * keyed to the higher of the two tiles it divides, so clearing it would take
 * the whole face of the building down to the street with it. Opening the deck's
 * own storey leaves the facade and removes only the rim.
 */
function openDeckEdges(grid: Grid, footprint: Rect, deck: number): void {
  forEachTile(footprint, (x, y) => {
    if (grid.levelAt(x, y) !== deck) return
    for (const [dx, dy] of ORTHOGONAL) {
      const side = faceToward({ x: 0, y: 0 }, { x: dx, y: dy })
      if (side === 0) continue
      // The rim is where the roof runs out, which means a drop. A face onto
      // ground at the same height is a step across, not an edge, and opening
      // it would be opening the wall between two things you can walk between.
      if (grid.levelAt(x + dx, y + dy) >= deck) continue
      if (grid.wallAt(x, y, side) === WallKind.None) continue
      grid.setWallOpening(x, y, side, deck)
    }
  })
}

/**
 * Give a roof something to fight over.
 *
 * A deck stripped to a bare slab is a shooting gallery, so a few stretches of
 * rim keep their parapet and the odd hoarding stands on the roof itself. Run
 * after settling, which is the pass that strips a rim back to bare.
 */
function dressRooftops(grid: Grid, footprints: readonly Rect[], rng: Rng): void {
  for (const footprint of footprints) {
    let deck = 0
    forEachTile(footprint, (x, y) => {
      deck = Math.max(deck, grid.levelAt(x, y))
    })
    if (deck === 0) continue

    keepSomeParapets(grid, footprint, deck, rng)
    raiseHoardings(grid, footprint, deck, rng)
  }
}

/**
 * Let a few stretches of rim keep their wall, as a chest-high parapet.
 *
 * Parapet rather than the facade's own masonry: at roof height solid walling
 * tops out over the eye of anyone up there, and a rim you can neither see nor
 * shoot over is just a smaller roof. A face a ladder lands at is always left
 * open — that gap is how the climb arrives.
 */
function keepSomeParapets(grid: Grid, footprint: Rect, deck: number, rng: Rng): void {
  forEachTile(footprint, (x, y) => {
    if (grid.levelAt(x, y) !== deck) return
    for (const [dx, dy] of ORTHOGONAL) {
      const side = faceToward({ x: 0, y: 0 }, { x: dx, y: dy })
      if (side === 0) continue
      if (!grid.wallOpenAt(x, y, side, deck)) continue
      if (grid.hasLadderFace(x, y, side)) continue
      if (!rng.chance(0.08)) continue

      // A run, not a single tile: one metre of parapet on its own reads as
      // rubble rather than as the edge of a roof.
      const length = rng.int(2, 5)
      for (let step = 0; step < length; step++) {
        // Along the rim, which is the axis the face does not point down.
        const rx = x + (dx === 0 ? step : 0)
        const ry = y + (dy === 0 ? step : 0)
        if (!inRect(footprint, rx, ry) || grid.levelAt(rx, ry) !== deck) break
        if (grid.hasLadderFace(rx, ry, side)) break
        if (grid.wallAt(rx, ry, side) === WallKind.None) break
        grid.clearWallOpenings(rx, ry, side)
        grid.setWall(rx, ry, side, WallKind.Parapet)
      }
    }
  })
}

/**
 * Stand the odd hoarding on a roof: a head-high panel to break the sightline.
 *
 * Openings below the deck keep it to a panel. The wall is one column from the
 * ground up, and the space under a deck is not modelled, so without them the
 * hoarding would hang down through thin air inside the building.
 *
 * Anything that costs the map a walkable tile is taken straight back out. The
 * check is the whole map before against the whole map after, not the two tiles
 * either side: a panel strands a pocket of roof around the corner from itself
 * just as easily as it seals its own edge.
 */
function raiseHoardings(grid: Grid, footprint: Rect, deck: number, rng: Rng): void {
  const tiles: Tile[] = []
  forEachTile(footprint, (x, y) => {
    if (grid.levelAt(x, y) === deck && grid.isWalkable(x, y)) tiles.push({ x, y })
  })
  if (tiles.length < 4) return

  let before = grid.reachableMask(tiles[0]!)

  for (let i = rng.int(0, 2); i > 0; i--) {
    const from = tiles[rng.int(0, tiles.length - 1)]!
    const [dx, dy] = ORTHOGONAL[rng.int(0, ORTHOGONAL.length - 1)]!
    const side = faceToward({ x: 0, y: 0 }, { x: dx, y: dy })
    if (side === 0) continue

    const raised: Tile[] = []
    const length = rng.int(1, 3)
    for (let step = 0; step < length; step++) {
      const x = from.x + (dx === 0 ? step : 0)
      const y = from.y + (dy === 0 ? step : 0)
      const beyond = { x: x + dx, y: y + dy }
      // Both sides have to be roof, or this is the rim rather than the middle.
      if (grid.levelAt(x, y) !== deck || grid.levelAt(beyond.x, beyond.y) !== deck) break
      if (!inRect(footprint, beyond.x, beyond.y)) break
      if (grid.wallAt(x, y, side) !== WallKind.None) break

      grid.setWall(x, y, side, WallKind.Solid)
      for (let level = 0; level < deck; level++) grid.setWallOpening(x, y, side, level)
      raised.push({ x, y })
    }
    if (raised.length === 0) continue

    const after = grid.reachableMask(tiles[0]!)
    if (before.every((seen, index) => seen === 0 || after[index] !== 0)) {
      before = after
      continue
    }

    for (const tile of raised) {
      grid.setWall(tile.x, tile.y, side, WallKind.None)
      grid.clearWallOpenings(tile.x, tile.y, side)
    }
  }
}

/** Can a unit on `tile` step anywhere except back to `from`? */
function leadsOnward(grid: Grid, tile: Tile, from: Tile): boolean {
  for (const [dx, dy] of ORTHOGONAL) {
    const n = { x: tile.x + dx, y: tile.y + dy }
    if (n.x === from.x && n.y === from.y) continue
    if (grid.canTraverse(tile, n)) return true
  }
  return false
}
/** The room of `building` covering a tile on `level`, or null. */
function roomAt(building: Building, level: number, x: number, y: number): Rect | null {
  const storey = building.storeys.find((s) => s.level === level)
  if (storey === undefined) return null
  return storey.rooms.find((room) => inRect(room, x, y)) ?? null
}


function forEachTile(rect: Rect, fn: (x: number, y: number) => void): void {
  for (let dy = 0; dy < rect.h; dy++) {
    for (let dx = 0; dx < rect.w; dx++) fn(rect.x + dx, rect.y + dy)
  }
}

/**
 * Plan a building bottom-up.
 *
 * The footprint is cut into rooms once, as a tree. A storey is then a *node*
 * of that tree: level 0 owns the root, level 1 owns one of the root's two
 * halves, level 2 one half of that. Each storey keeps the rooms of its own
 * node that the storey above did not take.
 *
 * Working from the tree has two properties worth the indirection. Every
 * storey's outline runs along cuts that already carry walls, so a wall always
 * stands on a wall. And every storey's region is a rectangle minus a
 * sub-rectangle — an L, a U or a ring — which is always in one piece, so no
 * storey can strand part of itself.
 */
function planBuilding(footprint: Rect, rng: Rng): Building {
  const root = subdivide(footprint, rng)

  // The nested regions each storey is drawn from, narrowing as they rise.
  const regions: BspNode[] = [root]
  for (let level = 1; level <= MAX_EXTRA_STOREYS; level++) {
    const below = regions[level - 1]!
    if (below.children === undefined) break
    if (!rng.chance(level === 1 ? 0.95 : 0.75)) break
    regions.push(rng.pick(below.children))
  }

  const storeys: Storey[] = []
  for (let level = 0; level < regions.length; level++) {
    const mine = leavesOf(regions[level]!)
    const above = regions[level + 1]
    const rooms =
      above === undefined
        ? mine
        : mine.filter((room) => !leavesOf(above).some((r) => r === room))
    if (rooms.length === 0) continue
    storeys.push({ level, rooms })
  }

  return { footprint, storeys }
}

interface BspNode {
  rect: Rect
  children?: readonly [BspNode, BspNode]
}

function leavesOf(node: BspNode): Rect[] {
  if (node.children === undefined) return [node.rect]
  return [...leavesOf(node.children[0]), ...leavesOf(node.children[1])]
}

/** Recursively halve `rect` until every part is a plausible room. */
function subdivide(rect: Rect, rng: Rng): BspNode {
  const canSplitX = rect.w >= MIN_ROOM_SIDE * 2
  const canSplitY = rect.h >= MIN_ROOM_SIDE * 2
  if (!canSplitX && !canSplitY) return { rect }

  // Stop early now and then, so a building has the odd hall among its cells.
  if (rectArea(rect) <= MIN_ROOM_SIDE * MIN_ROOM_SIDE * 2 && rng.chance(0.35)) return { rect }

  const splitX =
    canSplitX && (!canSplitY || (rect.w >= rect.h ? rng.chance(0.75) : rng.chance(0.25)))

  if (splitX) {
    const cut = rng.int(MIN_ROOM_SIDE, rect.w - MIN_ROOM_SIDE)
    return {
      rect,
      children: [
        subdivide({ x: rect.x, y: rect.y, w: cut, h: rect.h }, rng),
        subdivide({ x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h }, rng),
      ],
    }
  }

  const cut = rng.int(MIN_ROOM_SIDE, rect.h - MIN_ROOM_SIDE)
  return {
    rect,
    children: [
      subdivide({ x: rect.x, y: rect.y, w: rect.w, h: cut }, rng),
      subdivide({ x: rect.x, y: rect.y + cut, w: rect.w, h: rect.h - cut }, rng),
    ],
  }
}

// ---------------------------------------------------------------------------
// Round 1 & 2 — walls
// ---------------------------------------------------------------------------

/** Round 1: the outer wall of a storey, around the union of its rooms. */
function raiseOuterWalls(grid: Grid, storey: Storey, rng: Rng): void {
  for (const room of storey.rooms) {
    for (const [dx, dy] of ORTHOGONAL) {
      const side = faceToward({ x: 0, y: 0 }, { x: dx, y: dy })
      if (side === 0) continue
      const kind = storey.level > 0 && rng.chance(0.35) ? WallKind.Parapet : WallKind.Solid
      walkBoundary(room, dx, dy, (x, y) => {
        // An edge shared with another room of this storey is interior; it is
        // round 2's business.
        if (storey.rooms.some((other) => other !== room && inRect(other, x + dx, y + dy))) return
        grid.setWall(x, y, side, kind)
      })
    }
  }
}

/**
 * Round 2: the walls between rooms, each spanning its shared edge end to end.
 *
 * A partition that stops short of the outer wall leaves a gap that reads as a
 * doorway nobody placed, which is how rooms ended up joined at a corner.
 */
function raisePartitions(grid: Grid, storey: Storey): void {
  for (let i = 0; i < storey.rooms.length; i++) {
    for (let j = i + 1; j < storey.rooms.length; j++) {
      const shared = sharedEdge(storey.rooms[i]!, storey.rooms[j]!)
      if (shared === null) continue
      for (const { x, y, side } of shared.edges) grid.setWall(x, y, side, WallKind.Solid)
    }
  }
}

/** Every tile of `rect` on the side facing `(dx, dy)`. */
function walkBoundary(
  rect: Rect,
  dx: number,
  dy: number,
  fn: (x: number, y: number) => void,
): void {
  if (dx !== 0) {
    const x = dx > 0 ? rect.x + rect.w - 1 : rect.x
    for (let y = rect.y; y < rect.y + rect.h; y++) fn(x, y)
    return
  }
  const y = dy > 0 ? rect.y + rect.h - 1 : rect.y
  for (let x = rect.x; x < rect.x + rect.w; x++) fn(x, y)
}

interface SharedEdge {
  edges: { x: number; y: number; side: Side }[]
}

/** The run of edges two rooms share, or null when they do not touch. */
function sharedEdge(a: Rect, b: Rect): SharedEdge | null {
  const edges: { x: number; y: number; side: Side }[] = []

  // Vertical seam: `a` ends where `b` begins on X, with overlapping rows.
  for (const [left, right] of [
    [a, b],
    [b, a],
  ] as const) {
    if (left.x + left.w !== right.x) continue
    const y0 = Math.max(left.y, right.y)
    const y1 = Math.min(left.y + left.h, right.y + right.h)
    for (let y = y0; y < y1; y++) edges.push({ x: right.x, y, side: Side.West })
  }

  // Horizontal seam.
  for (const [top, bottom] of [
    [a, b],
    [b, a],
  ] as const) {
    if (top.y + top.h !== bottom.y) continue
    const x0 = Math.max(top.x, bottom.x)
    const x1 = Math.min(top.x + top.w, bottom.x + bottom.w)
    for (let x = x0; x < x1; x++) edges.push({ x, y: bottom.y, side: Side.North })
  }

  return edges.length === 0 ? null : { edges }
}

// ---------------------------------------------------------------------------
// Round 3 — doors and windows
// ---------------------------------------------------------------------------

/**
 * Round 3: openings.
 *
 * Interior doors first, along a spanning tree over the rooms, so every room
 * connects to at least one other and the whole storey is one space. Then
 * exterior doors, scaled to how many rooms there are to serve. Then windows,
 * scaled to how big each room is — a storage cupboard gets none, a hall gets
 * several.
 */
function openDoorsAndWindows(
  grid: Grid,
  rng: Rng,
  storey: Storey,
  all: readonly Building[],
  reserve: (x: number, y: number) => void,
  /** Every doorway cut, for the doors hung in them once the map is final. */
  doorways: Doorway[],
): void {
  const rooms = storey.rooms

  // --- interior doors: spanning tree over the room adjacency graph ---------
  const parent = rooms.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]!
    while (parent[i] !== root) {
      const next = parent[i]!
      parent[i] = root
      i = next
    }
    return root
  }

  const pairs: { i: number; j: number; shared: SharedEdge }[] = []
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const shared = sharedEdge(rooms[i]!, rooms[j]!)
      if (shared !== null) pairs.push({ i, j, shared })
    }
  }
  rng.shuffle(pairs)

  for (const pair of pairs) {
    const ri = find(pair.i)
    const rj = find(pair.j)
    // One door per tree edge joins the rooms; a few extra make the plan less
    // of a corridor crawl.
    const joinsNewRooms = ri !== rj
    if (!joinsNewRooms && !rng.chance(0.25)) continue
    if (joinsNewRooms) parent[ri] = rj

    const spot = rng.pick(pair.shared.edges)
    grid.setWall(spot.x, spot.y, spot.side, WallKind.None)
    doorways.push({ x: spot.x, y: spot.y, side: spot.side, exterior: false })
  }

  // --- exterior doors: one per four rooms, give or take --------------------
  const outer = exteriorEdges(grid, storey, all)
  if (outer.length > 0) {
    const min = Math.max(1, Math.floor(rooms.length / 4))
    const doors = Math.min(outer.length, rng.int(min, min + 1))
    rng.shuffle(outer)
    for (let i = 0; i < doors; i++) {
      const spot = outer[i]!
      grid.setWall(spot.x, spot.y, spot.side, WallKind.None)
      doorways.push({ ...spot, exterior: true })
      // A door is no use if the next pass drops a crate against it.
      const [dx, dy] = SIDE_OFFSET[spot.side]!
      reserve(spot.x, spot.y)
      reserve(spot.x + dx, spot.y + dy)
    }
  }

  // --- windows: by room size, on that room's own outside walls ------------
  for (const room of rooms) {
    const mine = outer.filter((e) => inRect(room, e.x, e.y))
    if (mine.length === 0) continue

    // A cupboard can do without; a hall wants a couple.
    const target = Math.floor(rectArea(room) / 9)
    const count = Math.min(mine.length, Math.max(0, target + (rng.chance(0.5) ? 1 : 0)))
    rng.shuffle(mine)
    let placed = 0
    for (const spot of mine) {
      if (placed >= count) break
      // Never glaze over a doorway that was just cut.
      if (grid.wallAt(spot.x, spot.y, spot.side) !== WallKind.Solid) continue
      grid.setWall(spot.x, spot.y, spot.side, WallKind.Glass)
      placed++
    }
  }
}

/**
 * Edges of a storey that face the open air.
 *
 * "Open" means the tile beyond belongs to no building at all — a seam against
 * a neighbouring structure is not a frontage and must not be glazed or holed.
 */
function exteriorEdges(
  grid: Grid,
  storey: Storey,
  all: readonly Building[],
): { x: number; y: number; side: Side }[] {
  const result: { x: number; y: number; side: Side }[] = []

  for (const room of storey.rooms) {
    for (const [dx, dy] of ORTHOGONAL) {
      const side = faceToward({ x: 0, y: 0 }, { x: dx, y: dy })
      if (side === 0) continue
      walkBoundary(room, dx, dy, (x, y) => {
        const ox = x + dx
        const oy = y + dy
        if (!grid.inBounds(ox, oy)) return
        // Interior to this storey, so not a frontage.
        if (storey.rooms.some((other) => inRect(other, ox, oy))) return
        // Frontage is open air only: a seam against any building — including a
        // storey step in this one — is not somewhere to cut a door or a window.
        if (all.some((b) => inRect(b.footprint, ox, oy))) return
        result.push({ x, y, side })
      })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Vertical access
// ---------------------------------------------------------------------------

/**
 * Fit a stair inside a building for every storey step it has.
 *
 * A stair needs a straight run of three tiles: the floor it leaves, the ramp
 * itself, and the floor it arrives on. Both ends must be somewhere a unit can
 * actually stand and move on from, or the stair is a hole in a cupboard.
 *
 * One per step, not one per building: a three-storey block needs a way from
 * the ground to the first floor *and* from there to the second.
 */
function fitStairs(
  grid: Grid,
  rng: Rng,
  building: Building,
  reserve: (x: number, y: number) => void,
): void {
  const { footprint } = building
  const topLevel = building.storeys.reduce((top, s) => Math.max(top, s.level), 0)

  for (let level = 0; level < topLevel; level++) {
    const candidates: { stair: Tile; dir: StairDirection; lower: Tile; upper: Tile }[] = []

    forEachTile(footprint, (x, y) => {
      if (grid.levelAt(x, y) !== level) return
      for (const [dx, dy] of ORTHOGONAL) {
        const lower = { x: x - dx, y: y - dy }
        const upper = { x: x + dx, y: y + dy }
        if (!inRect(footprint, lower.x, lower.y)) continue
        if (!inRect(footprint, upper.x, upper.y)) continue
        if (grid.levelAt(lower.x, lower.y) !== level) continue
        if (grid.levelAt(upper.x, upper.y) !== level + 1) continue

        // A stair may only be entered along its own axis, so a ramp dropped on
        // a doorway severs the route through it. Open floor inside a room is
        // fine — a room has parallel paths — but a gap in a wall is not.
        const flanks = [
          { x: dy, y: dx },
          { x: -dy, y: -dx },
        ]
        const onDoorway = flanks.some((off) => {
          const side = faceToward({ x: 0, y: 0 }, off)
          if (side === 0) return false
          if (grid.wallAt(x, y, side) !== WallKind.None) return false
          // The face is open: only a problem when it leads out of this room.
          return roomAt(building, level, x, y) !== roomAt(building, level, x + off.x, y + off.y)
        })
        if (onDoorway) continue

        const dir = stairDirectionFor(dx, dy)
        if (dir === null) continue
        candidates.push({ stair: { x, y }, dir, lower, upper })
      }
    })

    rng.shuffle(candidates)

    for (const option of candidates) {
      if (!hasRoomToMove(grid, option.lower, option.stair)) continue
      if (!hasRoomToMove(grid, option.upper, option.stair)) continue

      grid.setStair(option.stair.x, option.stair.y, option.dir, level)
      // The ramp's two ends are doorways: the walls it needs through.
      const toLower = faceToward(option.stair, option.lower)
      const toUpper = faceToward(option.stair, option.upper)
      if (toLower !== 0) grid.setWall(option.stair.x, option.stair.y, toLower, WallKind.None)
      if (toUpper !== 0) grid.setWall(option.stair.x, option.stair.y, toUpper, WallKind.None)

      // Stairs require ceiling tiles over the ramp to be removed (stairwell cutout).
      grid.setRoof(option.stair.x, option.stair.y, 0)

      reserve(option.stair.x, option.stair.y)
      reserve(option.lower.x, option.lower.y)
      reserve(option.upper.x, option.upper.y)
      break
    }
  }
}
/**
 * The direction whose *upper* access lies at `(dx, dy)` from the ramp.
 *
 * {@link Grid.getStairAccessTiles} names a stair by where its head points, so
 * these read inverted next to a plain offset: North's head is at `+y`.
 */
function stairDirectionFor(dx: number, dy: number): StairDirection | null {
  if (dx === 0 && dy === 1) return StairDirection.North
  if (dx === 0 && dy === -1) return StairDirection.South
  if (dx === 1 && dy === 0) return StairDirection.East
  if (dx === -1 && dy === 0) return StairDirection.West
  return null
}

/**
 * Can a unit stand on `tile` and go somewhere other than back down the stair?
 *
 * Checks the tile itself and demands at least one onward step, so a stair
 * never lands in a pocket a unit cannot leave.
 */
function hasRoomToMove(grid: Grid, tile: Tile, from: Tile): boolean {
  if (!grid.isWalkable(tile.x, tile.y)) return false
  for (const [dx, dy] of ORTHOGONAL) {
    const onward = { x: tile.x + dx, y: tile.y + dy }
    if (onward.x === from.x && onward.y === from.y) continue
    if (grid.canTraverse(tile, onward)) return true
  }
  return false
}

/**
 * Bolt a ladder to a building's outside wall.
 *
 * A ladder is only useful where it has somewhere to stand at the bottom, so it
 * goes on an outside face whose upper storey opens onto the air and whose
 * ground below is open, walkable and at least one storey down. The masonry
 * stays where it is: the climb shows through a single opening, at the storey
 * the ladder lands on.
 *
 * The drop need not be a single storey, and where several faces qualify the
 * tallest climb wins — a building whose upper storeys reach its own outline
 * carries a ladder to the roof, not a stub onto the first floor.
 */
function fitLadders(
  grid: Grid,
  building: Building,
  all: readonly Building[],
  reserve: (x: number, y: number) => void,
): void {
  // drop 0 means nothing qualified: a real candidate always climbs a storey.
  const best = { x: 0, y: 0, side: Side.North as Side, level: 0, drop: 0 }

  for (const storey of building.storeys) {
    if (storey.level === 0) continue

    for (const room of storey.rooms) {
      for (const [dx, dy] of ORTHOGONAL) {
        const side = faceToward({ x: 0, y: 0 }, { x: dx, y: dy })
        if (side === 0) continue

        walkBoundary(room, dx, dy, (x, y) => {
          const ox = x + dx
          const oy = y + dy
          if (!grid.inBounds(ox, oy)) return
          // The foot has to be open ground, not another building's floor.
          if (all.some((b) => inRect(b.footprint, ox, oy))) return
          if (!grid.isWalkable(ox, oy)) return
          const level = grid.levelAt(x, y)
          const drop = level - grid.levelAt(ox, oy)
          if (drop < 1 || drop <= best.drop) return
          // Only where the storey actually opens onto the air.
          if (grid.wallAt(x, y, side) !== WallKind.None) return

          best.x = x
          best.y = y
          best.side = side
          best.level = level
          best.drop = drop
        })
      }
    }
  }

  if (best.drop === 0) return
  grid.setLadderFace(best.x, best.y, best.side)
  grid.setWallOpening(best.x, best.y, best.side, best.level)
  const [dx, dy] = SIDE_OFFSET[best.side]!
  reserve(best.x, best.y)
  reserve(best.x + dx, best.y + dy)
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/**
 * Reduce the map to a single region a unit can actually walk around.
 *
 * Components are grown through {@link Grid.canTraverse}, so a raised storey is
 * only "connected" when a stair or ladder truly joins it. Judging adjacency by
 * walkability alone reports storeys as connected that nothing can reach.
 *
 * Three repairs, cheapest first: cut a door between two regions that already
 * touch; lower a raised region nothing can climb to, rather than inventing an
 * access it should not have; and only then carve a corridor across open ground.
 */
function repairConnectivity(grid: Grid, reserved: Set<number>): void {
  const size = grid.size
  const tileOf = (idx: number): Tile => ({ x: idx % size, y: (idx / size) | 0 })

  for (let guard = 0; guard < 128; guard++) {
    const components = labelComponents(grid)
    if (components.length <= 1) return

    let main = components[0]!
    for (const c of components) if (c.count > main.count) main = c

    const satellite = components.find((c) => c !== main)
    if (satellite === undefined) return

    const inMain = new Set(main.tiles)
    if (cutDoorInto(grid, satellite, inMain, tileOf)) continue
    if (clearBlockingStair(grid, satellite, inMain, tileOf)) continue
    if (dropUnreachableStorey(grid, satellite, inMain, tileOf)) continue

    // Corridor carving is a ground-plane operation, so pick the closest pair
    // of tiles that share a storey.
    let from: Tile | null = null
    let to: Tile | null = null
    let bestDist = Infinity
    for (const sIdx of satellite.tiles) {
      const s = tileOf(sIdx)
      for (const mIdx of main.tiles) {
        const m = tileOf(mIdx)
        if (grid.levelAt(s.x, s.y) !== grid.levelAt(m.x, m.y)) continue
        const d = Math.abs(s.x - m.x) + Math.abs(s.y - m.y)
        if (d < bestDist) {
          bestDist = d
          from = s
          to = m
        }
      }
    }

    if (from === null || to === null) return
    carveCorridor(grid, from, to, grid.levelAt(from.x, from.y), reserved)
  }
}

/**
 * Open a doorway where a cut-off region already touches the main one on the
 * same storey. A sealed room only ever needed a door.
 */
function cutDoorInto(
  grid: Grid,
  satellite: Component,
  inMain: ReadonlySet<number>,
  tileOf: (idx: number) => Tile,
): boolean {
  for (const idx of satellite.tiles) {
    const s = tileOf(idx)
    for (const [dx, dy] of ORTHOGONAL) {
      const n = { x: s.x + dx, y: s.y + dy }
      if (!grid.inBounds(n.x, n.y)) continue
      if (!inMain.has(grid.index(n.x, n.y))) continue
      if (grid.levelAt(s.x, s.y) !== grid.levelAt(n.x, n.y)) continue
      const side = faceToward(s, n)
      if (side === 0 || grid.wallAt(s.x, s.y, side) === WallKind.None) continue
      grid.setWall(s.x, s.y, side, WallKind.None)
      return true
    }
  }
  return false
}

/**
 * Demote a ramp that is severing the floor it stands on.
 *
 * A stair is only enterable along its axis, so one sitting where a route
 * crosses it sideways cuts that route — and the edge is already open, so no
 * door will fix it. The floor matters more than the stair: turn the ramp back
 * into plain floor and let the storey it served be re-judged, and demoted if
 * nothing else reaches it.
 */
function clearBlockingStair(
  grid: Grid,
  satellite: Component,
  inMain: ReadonlySet<number>,
  tileOf: (idx: number) => Tile,
): boolean {
  for (const idx of satellite.tiles) {
    const s = tileOf(idx)
    for (const [dx, dy] of ORTHOGONAL) {
      const n = { x: s.x + dx, y: s.y + dy }
      if (!grid.inBounds(n.x, n.y)) continue
      if (!inMain.has(grid.index(n.x, n.y))) continue
      if (grid.levelAt(s.x, s.y) !== grid.levelAt(n.x, n.y)) continue
      if (grid.blockAt(n.x, n.y) !== Block.Stair) continue
      if (grid.canTraverse(s, n)) continue
      grid.setBlock(n.x, n.y, Block.None)
      return true
    }
  }
  return false
}

/**
 * Lower a raised region that nothing can climb to.
 *
 * A storey with no stair and no ladder is exactly the floating room this
 * generator exists to avoid; putting it back on the ground is honest, where
 * bolting on an access it was never planned to have is not.
 */
function dropUnreachableStorey(
  grid: Grid,
  satellite: Component,
  inMain: ReadonlySet<number>,
  tileOf: (idx: number) => Tile,
): boolean {
  let target: number | null = null
  for (const idx of satellite.tiles) {
    const s = tileOf(idx)
    for (const [dx, dy] of ORTHOGONAL) {
      const n = { x: s.x + dx, y: s.y + dy }
      if (!grid.inBounds(n.x, n.y)) continue
      if (!inMain.has(grid.index(n.x, n.y))) continue
      const below = grid.levelAt(n.x, n.y)
      if (below >= grid.levelAt(s.x, s.y)) continue
      target = below
      break
    }
    if (target !== null) break
  }
  if (target === null) return false

  for (const idx of satellite.tiles) {
    const s = tileOf(idx)
    grid.setLevel(s.x, s.y, target)
    grid.setRoof(s.x, s.y, target + 1)
    grid.clearLadderFaces(s.x, s.y)
    // The ladder is gone with the storey, so its landing hole goes too — the
    // settling pass only revisits faces that still carry a ladder.
    for (const side of [Side.North, Side.East, Side.South, Side.West]) {
      grid.clearWallOpenings(s.x, s.y, side)
    }
  }
  return true
}

interface Component {
  label: number
  count: number
  tiles: number[]
}

function labelComponents(grid: Grid): Component[] {
  const size = grid.size
  const labels = new Int32Array(size * size).fill(-1)
  const components: Component[] = []
  let nextLabel = 0

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const start = grid.index(x, y)
      if (labels[start] !== -1 || !grid.isWalkable(x, y)) continue

      const label = nextLabel++
      const tiles: number[] = [start]
      labels[start] = label

      for (let head = 0; head < tiles.length; head++) {
        const from = { x: tiles[head]! % size, y: (tiles[head]! / size) | 0 }
        for (const [dx, dy] of ORTHOGONAL) {
          const to = { x: from.x + dx, y: from.y + dy }
          if (!grid.inBounds(to.x, to.y)) continue
          const nIdx = grid.index(to.x, to.y)
          if (labels[nIdx] !== -1) continue
          if (!grid.canTraverse(from, to)) continue
          labels[nIdx] = label
          tiles.push(nIdx)
        }
      }

      components.push({ label, count: tiles.length, tiles })
    }
  }

  return components
}

/**
 * Clear an L-shaped corridor between two tiles, leaving the border intact.
 *
 * Corridor tiles are flattened to `level`, or the run would be cut by the very
 * storey change it is meant to bypass. Tiles a vertical link depends on are
 * left alone: flattening a stair landing would undo the link. Walls along the
 * run always come down — a corridor whose boundaries still stand is not a
 * corridor.
 */
function carveCorridor(
  grid: Grid,
  from: Tile,
  to: Tile,
  level: number,
  reserved: Set<number>,
): void {
  const size = grid.size
  let prev = from

  const advance = (x: number, y: number) => {
    const curr = { x, y }
    const side = faceToward(prev, curr)
    if (side !== 0) grid.setWall(prev.x, prev.y, side, WallKind.None)

    const onBorder = x <= 0 || y <= 0 || x >= size - 1 || y >= size - 1
    if (!onBorder && !reserved.has(grid.index(x, y))) {
      grid.setBlock(x, y, Block.None)
      grid.setLevel(x, y, level)
    }
    prev = curr
  }

  const stepX = Math.sign(to.x - from.x)
  let x = from.x
  while (x !== to.x) {
    x += stepX
    advance(x, from.y)
  }
  const stepY = Math.sign(to.y - from.y)
  let y = from.y
  while (y !== to.y) {
    y += stepY
    advance(to.x, y)
  }
}

/** Pick `SQUAD_SIZE` distinct walkable tiles inside a deployment zone. */
function pickSpawns(grid: Grid, rng: Rng, zone: Rect): Tile[] {
  const candidates: Tile[] = []
  forEachTile(zone, (x, y) => {
    if (grid.isWalkable(x, y)) candidates.push({ x, y })
  })
  rng.shuffle(candidates)

  const chosen: Tile[] = []
  for (const tile of candidates) {
    if (chosen.length >= SQUAD_SIZE) break
    // Prefer spread-out spawns.
    if (chosen.some((c) => Math.abs(c.x - tile.x) + Math.abs(c.y - tile.y) < 2)) continue
    chosen.push(tile)
  }
  // Fall back to any remaining walkable tile if the spread rule was too strict.
  for (const tile of candidates) {
    if (chosen.length >= SQUAD_SIZE) break
    if (chosen.some((c) => c.x === tile.x && c.y === tile.y)) continue
    chosen.push(tile)
  }
  return chosen
}
