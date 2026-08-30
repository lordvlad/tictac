import type { EngineContext } from '../engine'
import { Faction, SQUAD_SIZE } from '../config'
import type { Grid, Tile } from '../core/Grid'
import { Soldier } from '../entities/Soldier'

export class Squads {
  readonly soldiers: Soldier[] = []
  readonly byFaction: Record<Faction, Soldier[]> = {
    [Faction.Blue]: [],
    [Faction.Red]: [],
  }

  constructor(grid: Grid, spawns: Record<Faction, Tile[]>, engine: EngineContext) {
    const blueNames = ['Viper', 'Ghost', 'Spectre', 'Reaper']
    const redNames = ['Cobalt', 'Crimson', 'Razor', 'Shadow']

    for (let i = 0; i < SQUAD_SIZE; i++) {
      const tileB = spawns[Faction.Blue][i] ?? { x: 2 + i * 2, y: 2 }
      const solB = new Soldier(Faction.Blue, i, blueNames[i]!, tileB, grid, engine)
      this.soldiers.push(solB)
      this.byFaction[Faction.Blue].push(solB)

      const tileR = spawns[Faction.Red][i] ?? { x: 2 + i * 2, y: grid.size - 3 }
      const solR = new Soldier(Faction.Red, i, redNames[i]!, tileR, grid, engine)
      this.soldiers.push(solR)
      this.byFaction[Faction.Red].push(solR)

      // Register into MavonEngine BaseWorld entity map
      engine.world.add({
        [solB.id]: solB,
        [solR.id]: solR,
      })
    }
  }

  getSoldierAt(tile: Tile): Soldier | undefined {
    return this.soldiers.find((s) => !s.isDead && s.tile.x === tile.x && s.tile.y === tile.y)
  }

  getLiving(faction: Faction): Soldier[] {
    return this.byFaction[faction].filter((s) => !s.isDead)
  }

  renderUpdate(delta: number): void {
    for (const s of this.soldiers) {
      s.renderUpdate(delta)
    }
  }

  dispose(): void {
    for (const s of this.soldiers) {
      s.destroy()
    }
  }
}
