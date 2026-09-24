import { RULES } from '../config'
import type { Combatant } from '../core/Combatant'
import type { Grid, Tile } from '../core/Grid'
import { reachable } from '../core/Pathfinding'
import { type Noise, NOISE, roughly } from '../core/Noise'
import { eyesOf, sees } from '../core/Visibility'
import type { Contact } from './Tactics'

/** How long, in turns, a searched tile stays searched. */
const STALE_AFTER = 3
/** How long, in turns, a noise is worth going to look at. */
const HEARD_FOR = 2

/**
 * What one side of a headless match knows about the other.
 *
 * The policy used to read every enemy's true position, so hiding was worth
 * nothing to the side hiding and finding was free to the side looking: a
 * squad walked straight at an enemy nobody had seen. Stealth cannot be
 * measured against that. This keeps the two things a player actually has:
 *
 * - **Contacts**: each enemy where it was last seen, and whether it was
 *   watching then. Seen means what fog of war grants — any living unit of
 *   the side sees the tile, or the enemy fired this turn and gave itself away.
 *   A contact whose tile is looked at and found empty is dropped: the side
 *   knows it is not *there*, and nothing about where it went.
 * - **Searched ground**: when each tile was last in view, so a side with no
 *   contacts goes and looks where it has not, instead of standing still.
 * - **Noises heard**: roughly where (`core/Noise.roughly`), and when. With
 *   nothing seen, a side goes to look at what it heard before it looks at
 *   ground it has not seen. Hearing never makes a contact: it says that
 *   something is there, not what or exactly where.
 *
 * A policy's memory, not game state: nothing here is replicated or rolled, and
 * the rules never read it.
 */
export class Intel {
  private readonly last = new Map<Combatant, Contact>()
  /** Turn each tile was last in view, or -1 for never. */
  private readonly lastSeen: Int16Array
  /**
   * Walking cost from a tile to every other, by the source's index.
   *
   * Searching asks it twice per decision over the whole map, which made
   * pathfinding most of what a sweep spent its time on. Kept for the match
   * because the ground does not change under a headless policy; a rule that
   * opens a wall mid-match has to clear this.
   */
  private readonly walks = new Map<number, Float32Array>()
  /** Ground joined to where the squad stands, so a search never picks a goal it cannot walk to. */
  private connected: Uint8Array | null = null
  /** Noises heard and not yet looked into: roughly where, and on which turn. */
  private heard: { at: Tile; turn: number }[] = []

  constructor(
    private readonly grid: Grid,
    private readonly own: readonly Combatant[],
    private readonly enemies: readonly Combatant[],
  ) {
    this.lastSeen = new Int16Array(grid.size * grid.size).fill(-1)
  }

  private walkFrom(tile: Tile): Float32Array {
    const index = this.grid.index(tile.x, tile.y)
    let walk = this.walks.get(index)
    if (!walk) {
      walk = reachable(this.grid, tile, new Set(), Infinity).cost
      this.walks.set(index, walk)
    }
    return walk
  }

  /** Enemies believed alive, where they were last seen. */
  get contacts(): Contact[] {
    const out: Contact[] = []
    for (const enemy of this.enemies) {
      const contact = this.last.get(enemy)
      if (contact && !enemy.isDead) out.push(contact)
    }
    return out
  }

  /**
   * Look, now. Cheap enough to call after every intent — four pairs of
   * sightlines each way — which is what lets an enemy walking past between
   * two of this side's own actions still be noticed.
   */
  observe(): void {
    const eyes = this.own.filter((unit) => !unit.isDead).map((unit) => ({ at: unit.tile, eyes: eyesOf(this.grid, unit) }))
    const inView = (tile: Tile) => eyes.some(({ at, eyes }) => sees(this.grid, at, eyes, tile))

    for (const enemy of this.enemies) {
      if (enemy.isDead) {
        this.last.delete(enemy)
        continue
      }
      if (enemy.firedThisTurn || inView(enemy.tile)) {
        this.last.set(enemy, { unit: enemy, tile: { ...enemy.tile }, heading: enemy.heading, watching: enemy.watching })
        continue
      }
      const contact = this.last.get(enemy)
      if (contact && inView(contact.tile)) this.last.delete(enemy)
    }
    // A noise whose block has been looked at has been looked into.
    this.heard = this.heard.filter((noise) => !inView(noise.at))
  }

  /** One of this side's units heard `noise` on `turn`. */
  hear(noise: Noise, turn: number): void {
    const at = roughly(noise.at)
    this.heard = this.heard.filter((old) => old.at.x !== at.x || old.at.y !== at.y)
    this.heard.push({ at, turn })
  }

  /**
   * Mark everything `unit` can see as searched on `turn`.
   *
   * A full sweep of its field of view, so it is called when a unit finishes
   * rather than after every step, and for that unit alone — the others have
   * not moved since their own sweep. What matters is the ground the squad has
   * covered, not the exact moment it was covered.
   */
  survey(unit: Combatant, turn: number): void {
    if (unit.isDead) return
    const { grid } = this
    const range = RULES.sightRange
    const eyes = eyesOf(grid, unit)
    const { x: ox, y: oy } = unit.tile
    for (let y = Math.max(0, oy - range); y <= Math.min(grid.size - 1, oy + range); y++) {
      for (let x = Math.max(0, ox - range); x <= Math.min(grid.size - 1, ox + range); x++) {
        const index = grid.index(x, y)
        if (this.lastSeen[index] === turn) continue
        if (sees(grid, unit.tile, eyes, { x, y })) this.lastSeen[index] = turn
      }
    }
  }

  /**
   * Where `unit` should look next, as the walking cost from every tile to it.
   *
   * What it heard most recently, if anything is worth going to look at: a
   * noise from this turn or the last, taken to the walkable tile nearest where
   * it seemed to come from. Otherwise the nearest ground nobody has seen,
   * pulled toward the middle of the map, where an enemy that could be
   * anywhere is most likely to be passing. Ground seen long enough ago counts
   * as unseen again once everything has been looked at, because the enemy
   * moves.
   *
   * Goals are picked as the crow flies, over ground the unit can get to at
   * all; only the way there is walked. Picking them on foot too meant a
   * whole-map search from wherever the unit stood, every time, which is a
   * source that never repeats — the goals do.
   */
  searchFrom(unit: Combatant, turn: number): Float32Array | null {
    const { grid } = this
    const here = grid.index(unit.tile.x, unit.tile.y)
    if (!this.connected?.[here]) this.connected = grid.reachableMask(unit.tile)
    const connected = this.connected

    this.heard = this.heard.filter((noise) => noise.turn >= turn - HEARD_FOR + 1)
    for (let i = this.heard.length - 1; i >= 0; i--) {
      const { at } = this.heard[i]!
      let best: Tile | null = null
      let bestKey = Infinity
      for (let y = at.y - NOISE.blur; y <= at.y + NOISE.blur; y++) {
        for (let x = at.x - NOISE.blur; x <= at.x + NOISE.blur; x++) {
          if (!grid.inBounds(x, y) || !connected[grid.index(x, y)]) continue
          const key = (x - at.x) ** 2 + (y - at.y) ** 2
          if (key < bestKey) {
            bestKey = key
            best = { x, y }
          }
        }
      }
      if (best) return this.walkFrom(best)
    }

    const centre = { x: (grid.size - 1) / 2, y: (grid.size - 1) / 2 }
    for (const staleBefore of [0, turn - STALE_AFTER + 1]) {
      let best: Tile | null = null
      let bestKey = Infinity
      for (let y = 0; y < grid.size; y++) {
        for (let x = 0; x < grid.size; x++) {
          const index = grid.index(x, y)
          if (!connected[index] || this.lastSeen[index]! >= staleBefore) continue
          const at = { x, y }
          const key = grid.distance(unit.tile, at) + grid.distance(at, centre)
          if (key < bestKey) {
            bestKey = key
            best = at
          }
        }
      }
      if (best) return this.walkFrom(best)
    }
    return null
  }
}
