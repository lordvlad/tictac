import { Faction } from '../config'
import type { Grid } from '../core/Grid'
import { computeFactionVisibility, createVisibilityMap, VisState } from '../core/Visibility'
import type { Blocks } from '../render/Blocks'
import type { Ground } from '../render/Ground'
import type { Squads } from './Squads'

/**
 * Fog of war: what the active faction can see, and everything that follows from
 * it — floor and block dimming plus which enemy models are rendered at all.
 *
 * One map per faction is kept alive across turns (784 bytes each), because
 * "explored" is a memory: tiles drop from visible back to explored rather than
 * to unknown.
 */
export class FogOfWar {
  private readonly maps: Record<Faction, Uint8Array>

  constructor(
    private readonly grid: Grid,
    private readonly ground: Ground,
    private readonly blocks: Blocks,
  ) {
    this.maps = {
      [Faction.Blue]: createVisibilityMap(grid.size),
      [Faction.Red]: createVisibilityMap(grid.size),
    }
  }

  mapFor(faction: Faction): Uint8Array {
    return this.maps[faction]
  }

  recompute(activeFaction: Faction, squads: Squads): void {
    const tiles = squads.getLiving(activeFaction).map((s) => s.tile)
    const visMap = computeFactionVisibility(this.grid, tiles, this.maps[activeFaction])

    this.ground.setFogFromVisibility(visMap)
    this.blocks.applyVisibility(visMap)

    // Hide/show enemies based on whether their tile is visible. Corpses stay
    // rendered so the death clip's final frame reads as a body on the ground;
    // enemy corpses are still subject to fog of war.
    for (const soldier of squads.soldiers) {
      if (!soldier.instance) continue
      if (soldier.faction === activeFaction) {
        soldier.instance.visible = true
        continue
      }
      const tileVis = visMap[this.grid.index(soldier.tile.x, soldier.tile.y)] ?? VisState.Unknown
      soldier.instance.visible = tileVis === VisState.Visible
    }
  }
}
