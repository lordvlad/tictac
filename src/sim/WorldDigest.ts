import { foldHashes, hashData, hashString } from '../core/digest'
import type { Rng } from '../core/rng'
import { GLOBAL_ENTITY_ID, type World } from '../ecs/World'
import type { StateDigest } from '../rules/StateDigest'

/**
 * Fingerprint the world.
 *
 * `unitIds` names the entities worth reporting in detail — the soldiers. They
 * are named by the caller rather than discovered here because "which entities
 * are units" is a game question, and this file is about hashing. The dice are
 * not in the world at all — they are a stream beside it — so they come in
 * separately.
 *
 * Lives beside the host rather than with the digest's shape and comparison
 * (`rules/StateDigest`): reading a world needs `World`, and the wire carries
 * the shape without ever holding one.
 */
export function digestWorld(world: World, unitIds: Iterable<number>, turn: number, dice: Rng): StateDigest {
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

  const diceState = dice.snapshot()

  return {
    turn,
    units,
    terrain,
    rules,
    dice: diceState,
    total: foldHashes([...unitHashes, terrain, rules, hashString(`dice:${diceState}`)]),
  }
}
