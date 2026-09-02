import type { EngineContext } from '../engine'
import { Faction, SQUAD_SIZE } from '../config'
import { AmmoId, WeaponId } from '../core/Arsenal'
import type { Grid, Tile } from '../core/Grid'
import { Soldier } from '../entities/Soldier'
import type { World } from '../ecs/World'

export class Squads {
  readonly soldiers: Soldier[] = []
  readonly byFaction: Record<Faction, Soldier[]> = {
    [Faction.Blue]: [],
    [Faction.Red]: [],
  }

  constructor(
    world: World,
    grid: Grid,
    spawns: Record<Faction, Tile[]>,
    engine: EngineContext,
  ) {
    const blueNames = ['Cobalt', 'Azure', 'Sapphire', 'Indigo']
    const redNames = ['Crimson', 'Scarlet', 'Ruby', 'Garnet']

    const weapons = [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun] as const

    for (let i = 0; i < SQUAD_SIZE; i++) {
      const tileB = spawns[Faction.Blue][i] ?? { x: 2 + i * 2, y: 2 }
      const solB = new Soldier(world, Faction.Blue, i, blueNames[i]!, tileB, grid, engine)
      solB.equip(weapons[i]!, AmmoId.Standard)
      this.soldiers.push(solB)
      this.byFaction[Faction.Blue].push(solB)

      const tileR = spawns[Faction.Red][i] ?? { x: 2 + i * 2, y: grid.size - 3 }
      const solR = new Soldier(world, Faction.Red, i, redNames[i]!, tileR, grid, engine)
      solR.equip(weapons[i]!, AmmoId.Standard)
      this.soldiers.push(solR)
      this.byFaction[Faction.Red].push(solR)
      // Register into MavonEngine BaseWorld entity map
      engine.world.add({
        [solB.id]: solB,
        [solR.id]: solR,
      })
    }
  }

  /** Look a soldier up by the ECS entity it owns. */
  byEntityId(entityId: number): Soldier | undefined {
    return this.soldiers.find((s) => s.entityId === entityId)
  }

  getSoldierAt(tile: Tile): Soldier | undefined {
    return this.soldiers.find((s) => !s.isDead && s.tile.x === tile.x && s.tile.y === tile.y)
  }

  getLiving(faction: Faction): Soldier[] {
    return this.byFaction[faction].filter((s) => !s.isDead)
  }

  dispose(): void {
    for (const s of this.soldiers) {
      s.destroy()
    }
  }
}
