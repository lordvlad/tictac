import { DOORS } from '../config'
import { HEADINGS } from './Facing'
import { type Grid, Side, type Tile } from './Grid'
import { ITEMS, ItemId } from './Items'
import { WallKind } from './Walls'

/**
 * Doors: a wall segment with a state a unit can change by standing at it.
 *
 * A door is one of three wall kinds — shut ({@link WallKind.Door}), open
 * ({@link WallKind.DoorOpen}) and locked ({@link WallKind.Locked}) — so its
 * state is the wall's `kind`, replicated, digested and rewound with every
 * other wall, and every reader of walls (sight, cover, fire, the renderer)
 * already knows what it is. Kicked in, it is no door at all
 * ({@link WallKind.None}).
 *
 * Walking through a shut door opens it, for {@link DOORS.openAp} on the step
 * (`Grid.getStepCost`). Everything else is a verb a unit works on a door on a
 * side of the tile it stands on.
 */
export type DoorVerb = 'open' | 'close' | 'unlock' | 'force'

/** Is this wall kind a door, in whatever state? */
export function isDoor(kind: WallKind): boolean {
  return kind === WallKind.Door || kind === WallKind.DoorOpen || kind === WallKind.Locked
}

/** What can be done to a door in this state. A kicked-in door is not a door. */
export function doorVerbs(kind: WallKind): readonly DoorVerb[] {
  switch (kind) {
    case WallKind.Door:
      return ['open']
    case WallKind.DoorOpen:
      return ['close']
    case WallKind.Locked:
      return ['unlock', 'force']
    default:
      return []
  }
}

/** Action points a verb costs. */
export function doorApCost(verb: DoorVerb): number {
  switch (verb) {
    case 'open':
      return DOORS.openAp
    case 'close':
      return DOORS.closeAp
    case 'unlock':
      return DOORS.unlockAp
    case 'force':
      return DOORS.forceAp
  }
}

/**
 * The door after `verb`, when it worked. Unlocking opens the door as well: a
 * unit that went to the trouble is going through. A forced door is broken
 * off its hinges and never shuts again.
 */
export function doorAfter(verb: DoorVerb): WallKind {
  switch (verb) {
    case 'open':
    case 'unlock':
      return WallKind.DoorOpen
    case 'close':
      return WallKind.Door
    case 'force':
      return WallKind.None
  }
}

const SIDES: readonly { side: Side; dx: number; dy: number }[] = [
  { side: Side.North, dx: 0, dy: -1 },
  { side: Side.East, dx: 1, dy: 0 },
  { side: Side.South, dx: 0, dy: 1 },
  { side: Side.West, dx: -1, dy: 0 },
]

/**
 * The door a unit standing on `tile` and facing `heading` would work: of the
 * doors on its tile's sides, the one most nearly in front of it, north first
 * on a tie. Null with no door at hand. Turning costs nothing, so facing is how
 * a unit between two doors picks one — "the door in front of you".
 */
export function doorAhead(grid: Grid, tile: Tile, heading: number): number | null {
  const [hx, hy] = HEADINGS[heading] ?? HEADINGS[0]!
  let best: number | null = null
  let bestDot = -Infinity
  for (const { side, dx, dy } of SIDES) {
    if (!isDoor(grid.wallAt(tile.x, tile.y, side))) continue
    const dot = dx * hx + dy * hy
    if (dot > bestDot) {
      best = grid.edgeId(tile.x, tile.y, side)
      bestDot = dot
    }
  }
  return best
}

/** Who may work a door: where they stand, what they have left, what they carry. */
export interface DoorWorker {
  tile: Tile
  ap: number
  items: Partial<Record<ItemId, number>>
}

/** Is `who` carrying anything that unlocks a door ({@link ItemSpec.unlocks})? */
export function carriesKeys(who: DoorWorker): boolean {
  return Object.values(ItemId).some((id) => ITEMS[id].unlocks === true && (who.items[id] ?? 0) > 0)
}

/**
 * Why `who` cannot work `verb` on the door at `edge`, or null when it can.
 *
 * Asked by the rules on both peers, not only by the side that sent it: a
 * door changes what both sides see, so a door that opened on one screen and
 * not the other is a desynchronisation, not a disagreement about reach.
 */
export function cannotWorkDoor(grid: Grid, who: DoorWorker, edge: number, verb: DoorVerb): string | null {
  const beside = SIDES.some(({ side }) => grid.edgeId(who.tile.x, who.tile.y, side) === edge)
  if (!beside) return 'the door is not beside the unit'
  const { x, y, side } = grid.edgeTile(edge)
  if (!doorVerbs(grid.wallAt(x, y, side)).includes(verb)) return `cannot ${verb} that`
  if (verb === 'unlock' && !carriesKeys(who)) return 'no keys'
  if (who.ap < doorApCost(verb)) return 'not enough action points'
  return null
}
