import { FACTION_INFO, Faction, SQUAD_SIZE } from '../config'
import { AmmoId, WeaponId } from '../core/Arsenal'
import type { Grid, Tile } from '../core/Grid'
import type { CharacterSheet } from '../core/Characters'
import { Soldier } from '../entities/Soldier'
import { applyUnitLoadout, type SquadLoadout } from './Loadout'
import type { World } from '../ecs/World'

export class Squads {
  readonly soldiers: Soldier[] = []
  readonly byFaction: Record<Faction, Soldier[]> = {
    [Faction.Blue]: [],
    [Faction.Red]: [],
  }

  /**
   * `loadout` is what the player put together on the pre-combat screen, one
   * entry per squad index, and `loadoutFaction` names the squad it belongs to —
   * each peer equips the team it commands. The other squad keeps the stock
   * spread; nothing ever resolves damage from it, because a peer's attacks
   * arrive with their numbers already resolved.
   *
   * `sheets` are the people. This side rolls its own squad's; the enemy's
   * arrive in the start handshake and land through {@link adoptSheets}, so
   * whatever is passed for them here is a placeholder that exists only so the
   * match can be built before the message lands.
   */
  constructor(
    world: World,
    grid: Grid,
    spawns: Record<Faction, Tile[]>,
    loadout?: SquadLoadout,
    loadoutFaction: Faction = Faction.Blue,
    sheets?: Record<Faction, CharacterSheet[]>,
  ) {
    const blueNames = FACTION_INFO[Faction.Blue].squadNames
    const redNames = FACTION_INFO[Faction.Red].squadNames

    const weapons = [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun] as const

    for (let i = 0; i < SQUAD_SIZE; i++) {
      const unit = loadout?.[i]

      const tileB = spawns[Faction.Blue][i] ?? { x: 2 + i * 2, y: 2 }
      const solB = new Soldier(
        world,
        Faction.Blue,
        i,
        blueNames[i]!,
        tileB,
        grid,
        sheets?.[Faction.Blue][i],
      )
      if (unit && loadoutFaction === Faction.Blue) applyUnitLoadout(solB, unit)
      else solB.equip(weapons[i]!, AmmoId.Standard)
      this.soldiers.push(solB)
      this.byFaction[Faction.Blue].push(solB)

      const tileR = spawns[Faction.Red][i] ?? { x: 2 + i * 2, y: grid.size - 3 }
      const solR = new Soldier(
        world,
        Faction.Red,
        i,
        redNames[i]!,
        tileR,
        grid,
        sheets?.[Faction.Red][i],
      )
      if (unit && loadoutFaction === Faction.Red) applyUnitLoadout(solR, unit)
      else solR.equip(weapons[i]!, AmmoId.Standard)
      this.soldiers.push(solR)
      this.byFaction[Faction.Red].push(solR)
    }
  }

  /**
   * Take a peer's squad as they rolled it.
   *
   * Applied before the first turn, from the sheets that arrived with their
   * `ready`. Short arrays leave the remaining units on their placeholder, which
   * is the safe direction: a missing sheet costs display accuracy, never a
   * resolver reading a number that was never sent.
   */
  adoptSheets(faction: Faction, sheets: readonly CharacterSheet[]): void {
    const squad = this.byFaction[faction]
    for (let i = 0; i < squad.length && i < sheets.length; i++) squad[i]!.adoptSheet(sheets[i]!)
  }

  /**
   * The kit a squad is currently holding, as a loadout.
   *
   * Read off the soldiers rather than remembered from the constructor: the
   * debug panel and the loadout screen both write kit straight onto a unit, so
   * what a squad *has* is the only thing worth writing down.
   */
  loadoutOf(faction: Faction): SquadLoadout {
    return this.byFaction[faction].map((soldier) => ({
      weaponId: soldier.weaponId,
      ammoId: soldier.ammoId,
      grenades: { ...soldier.grenades },
      items: { ...soldier.items },
      // Every unit carries a clone of the weapon template with its own rail,
      // so this array is already exactly what is fitted to this gun. Copied,
      // never handed out: the rail is live state.
      attachments: [...soldier.weapon.attachments],
    }))
  }

  /**
   * Stamp a whole squad's kit.
   *
   * The constructor equips one faction from a loadout and leaves the other on
   * the stock spread, which is right for a match — a peer's attacks arrive
   * already resolved, so this side never reads their weapon. A replay has no
   * sender and resolves nothing, but it does have both squads' recorded kit,
   * and the panels read from it.
   */
  equipFaction(faction: Faction, loadout: SquadLoadout): void {
    const squad = this.byFaction[faction]
    for (let i = 0; i < squad.length && i < loadout.length; i++) {
      applyUnitLoadout(squad[i]!, loadout[i]!)
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

  /**
   * Nothing to tear down.
   *
   * A squad is state now. The bodies are disposed by whatever built them, which
   * in a rendered match is `SquadViews`.
   */
  dispose(): void {
    this.soldiers.length = 0
    this.byFaction[Faction.Blue].length = 0
    this.byFaction[Faction.Red].length = 0
  }
}
