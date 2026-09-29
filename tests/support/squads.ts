import { Faction } from '../../src/config'
import type { CharacterSheet } from '../../src/core/Characters'
import type { Deployment } from '../../src/game/Recording'

/**
 * Sheets, wrapped with no kit — the raw-stock deploy path `Squads` already
 * takes for a deployment with no `loadout`, the same as passing no loadout at
 * all. What most tests want: specific people, on the stock spread.
 */
export function stockSquads(
  sheets: Record<Faction, readonly CharacterSheet[]>,
): Record<Faction, Deployment[]> {
  const build = (faction: Faction): Deployment[] => sheets[faction].map((sheet) => ({ sheet }))
  return { [Faction.Blue]: build(Faction.Blue), [Faction.Red]: build(Faction.Red) }
}
