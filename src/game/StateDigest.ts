import { foldHashes, hashData, hashString } from '../core/digest'
import { GLOBAL_ENTITY_ID, type World } from '../ecs/World'
import type { Divergence } from './Divergence'

/**
 * A fingerprint of a whole world, taken at a handover.
 *
 * `ITEM-020` catches an attack two peers resolve differently. It cannot catch
 * *drift*: two states that diverged with no single action revealing it, which
 * is what a desynchronised match actually feels like — everything is fine until
 * nothing is. This is the check for that, and it is also the checkpoint that
 * rejoin and an audit stand on
 * ([ADR-0004](../../docs/design/adr/0004-full-knowledge-lockstep.md)).
 *
 * Taken at a handover rather than per frame, which is what makes it free: once
 * a turn, over a few hundred serialised components.
 *
 * ### Why the shape is uneven
 *
 * Units carry a hash *per component*, so a mismatch names the entity and the
 * component — "the states differ" is not a debuggable message. Everything else
 * folds into one number each, because there are hundreds of wall entities and
 * sending a hash per wall per turn to diagnose a thing that has never drifted
 * would be paying every turn for a report nobody has needed yet. A mismatch in
 * `terrain` still says *that* terrain differs, which is enough to start.
 */
export interface StateDigest {
  /** The turn this was taken at the end of. */
  turn: number
  /** Per unit entity, per component. Keyed by entity id as a string, for JSON. */
  units: Record<string, Record<string, number>>
  /** Everything that is not a unit and not the rule tables, folded. */
  terrain: number
  /** The global entity: rule tables, tunables. */
  rules: number
  /** The whole world in one number, so agreement is a single comparison. */
  total: number
}

/**
 * Fingerprint the world.
 *
 * `unitIds` names the entities worth reporting in detail — the soldiers. They
 * are named by the caller rather than discovered here because "which entities
 * are units" is a game question, and this file is about hashing.
 */
export function digestWorld(world: World, unitIds: Iterable<number>, turn: number): StateDigest {
  const units: Record<string, Record<string, number>> = {}
  const detailed = new Set(unitIds)
  const terrainHashes: number[] = []
  let rules = 0

  for (const entityId of world.entityIds()) {
    const data = world.componentData(entityId)
    if (!data) continue

    if (detailed.has(entityId)) {
      const perComponent: Record<string, number> = {}
      for (const [name, state] of Object.entries(data)) perComponent[name] = hashData(state)
      units[String(entityId)] = perComponent
      continue
    }

    // Identity matters as much as content: two walls that swapped their kinds
    // hold the same set of component states between them.
    const entityHash = hashString(`${entityId}:${hashData(data)}`)
    if (entityId === GLOBAL_ENTITY_ID) rules = entityHash
    else terrainHashes.push(entityHash)
  }

  const unitHashes = Object.entries(units).map(([entityId, components]) =>
    hashString(`${entityId}:${foldHashes(Object.values(components))}`),
  )
  const terrain = foldHashes(terrainHashes)

  return {
    turn,
    units,
    terrain,
    rules,
    total: foldHashes([...unitHashes, terrain, rules]),
  }
}

/**
 * What the two sides disagree about, in the order worth reading it.
 *
 * Returns nothing when the totals match: that is the common case and it costs
 * one comparison. Everything below it only runs once something is already
 * wrong.
 */
export function compareDigests(
  mine: StateDigest,
  theirs: StateDigest,
  nameOf: (entityId: number) => string,
): Divergence[] {
  if (mine.total === theirs.total) return []

  const out: Divergence[] = []
  if (mine.turn !== theirs.turn) {
    // Comparing different turns is not a divergence, it is a mis-timed check —
    // worth saying plainly rather than reporting every component as differing.
    return [{ what: 'digestTurn', mine: mine.turn, theirs: theirs.turn }]
  }

  for (const entityId of new Set([...Object.keys(mine.units), ...Object.keys(theirs.units)])) {
    const a = mine.units[entityId]
    const b = theirs.units[entityId]
    const unit = nameOf(Number(entityId))
    if (!a || !b) {
      out.push({ what: 'unitMissing', unit, mine: a ? 'present' : null, theirs: b ? 'present' : null })
      continue
    }
    for (const component of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[component] !== b[component]) {
        out.push({
          what: `component ${component}`,
          unit,
          mine: a[component] ?? null,
          theirs: b[component] ?? null,
        })
      }
    }
  }

  if (mine.terrain !== theirs.terrain) {
    out.push({ what: 'terrain', mine: mine.terrain, theirs: theirs.terrain })
  }
  if (mine.rules !== theirs.rules) {
    out.push({ what: 'rules', mine: mine.rules, theirs: theirs.rules })
  }

  // Totals differ but nothing named did: the fold has lost something the parts
  // did not, which is a bug in this file rather than in the match.
  if (out.length === 0) {
    out.push({ what: 'digestTotal', mine: mine.total, theirs: theirs.total })
  }
  return out
}
