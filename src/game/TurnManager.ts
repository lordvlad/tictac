import { Faction, MAX_AP } from '../config'
import type { Soldier } from '../entities/Soldier'
import type { Squads } from './Squads'
import type { OrbitRig } from '../camera/OrbitRig'

export class TurnManager {
  activeFaction: Faction = Faction.Blue
  turnNumber = 1
  selectedSoldier: Soldier | null = null

  onSelectionChanged?: (soldier: Soldier | null) => void

  private readonly squads: Squads
  private readonly rig: OrbitRig

  constructor(squads: Squads, rig: OrbitRig) {
    this.squads = squads
    this.rig = rig
    // Scene starts with no character selected
    this.selectedSoldier = null
  }

  autoSelectFirst(): void {
    const living = this.squads.getLiving(this.activeFaction)
    if (living.length > 0) {
      this.selectSoldier(living[0]!)
    } else {
      this.selectSoldier(null)
    }
  }

  selectSoldier(soldier: Soldier | null): void {
    if (soldier && (soldier.isDead || soldier.faction !== this.activeFaction)) return
    this.selectedSoldier = soldier
    if (soldier) {
      this.rig.focusOn(soldier.position)
    }
    this.onSelectionChanged?.(soldier)
  }

  finishSoldierTurn(soldier: Soldier): void {
    soldier.ap = 0
    const living = this.squads.getLiving(this.activeFaction)
    const next = living.find((s) => s.ap > 0)
    if (next) {
      this.selectSoldier(next)
    }
  }

  startNextTurn(): void {
    this.activeFaction = this.activeFaction === Faction.Blue ? Faction.Red : Faction.Blue
    if (this.activeFaction === Faction.Blue) {
      this.turnNumber++
    }

    for (const soldier of this.squads.getLiving(this.activeFaction)) {
      soldier.ap = MAX_AP
    }

    // Start turn with no character selected
    this.selectedSoldier = null
  }
}
