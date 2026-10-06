import { FACTION_INFO, Faction, SQUAD_SIZE } from '../config'
import { AmmoId, GRENADES, GrenadeId, WeaponId } from '../core/Arsenal'
import type { Grid, Tile } from '../core/Grid'
import { Soldier } from '../entities/Soldier'
import { applyUnitLoadout, type SquadLoadout } from './Loadout'
import type { Deployment } from './Recording'
import type { World } from '../ecs/World'

export class Squads {
  readonly soldiers: Soldier[] = []
  readonly byFaction: Record<Faction, Soldier[]> = {
    [Faction.Blue]: [],
    [Faction.Red]: [],
  }

  /**
   * `squads` is both sides, fully formed: who is deploying, what they are
   * carrying, and what state they start in — the shape a header or a `ready`
   * states a squad in. Absent entirely for a debug scratch world or a test
   * that wants nobody's business but the map: that spawns the stock full
   * squad on both sides, own-rolled sheets included, the same as ever.
   *
   * A side fields exactly as many units as it has deployments for, up to
   * `SQUAD_SIZE`: a kept roster with an empty slot deploys short-handed
   * rather than being topped up with somebody nobody enlisted. No
   * deployments stated at all for a side (a sweep, a stock match) is the
   * stock full squad on that side.
   *
   * A deployment with no `loadout` — a peer's kit this build could not read —
   * deploys on the stock spread, exactly as if nobody had equipped it at all.
   */
  constructor(
    world: World,
    grid: Grid,
    spawns: Record<Faction, Tile[]>,
    squads?: Partial<Record<Faction, readonly Deployment[]>>,
  ) {
    const weapons = [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun] as const
    const sizeOf = (faction: Faction): number => {
      const stated = squads?.[faction]?.length ?? 0
      return stated > 0 ? Math.min(stated, SQUAD_SIZE) : SQUAD_SIZE
    }
    const sides = [
      { faction: Faction.Blue, size: sizeOf(Faction.Blue), fallbackRow: 2 },
      { faction: Faction.Red, size: sizeOf(Faction.Red), fallbackRow: grid.size - 3 },
    ]

    // Blue then Red at each index, as it has always been: creation order is
    // entity-id order and `soldiers` order, which a full squad must not see move.
    for (let i = 0; i < SQUAD_SIZE; i++) {
      for (const { faction, size, fallbackRow } of sides) {
        if (i >= size) continue
        const deployment = squads?.[faction]?.[i]
        const soldier = new Soldier(
          world,
          faction,
          i,
          FACTION_INFO[faction].squadNames[i]!,
          spawns[faction][i] ?? { x: 2 + i * 2, y: fallbackRow },
          grid,
          deployment?.sheet,
          deployment?.state?.hp,
          deployment?.characterId,
          deployment?.state?.fatigue,
        )
        if (deployment?.loadout) applyUnitLoadout(soldier, deployment.loadout)
        else soldier.equip(weapons[i]!, AmmoId.Standard)
        this.soldiers.push(soldier)
        this.byFaction[faction].push(soldier)
      }
    }
  }

  /**
   * The kit a squad is currently holding, as a loadout.
   *
   * Read off the soldiers rather than remembered from the constructor: the
   * debug panel and the loadout screen both write kit straight onto a unit, so
   * what a squad *has* is the only thing worth writing down.
   *
   * A loadout is what was *packed*, and the grenades every soldier is issued
   * regardless (`GrenadeSpec.issued`, the stones) are added on top when one is
   * applied (`applyUnitLoadout`). So they come off again here, or a loadout
   * read back and applied once more would issue them twice — which is what a
   * refereed match did: the header stated each soldier's stones as packed, the
   * referee issued them again, and the first digest at the first handover
   * disagreed on every unit's pouch and aborted the match.
   */
  loadoutOf(faction: Faction): SquadLoadout {
    return this.byFaction[faction].map((soldier) => ({
      weaponId: soldier.weaponId,
      ammoId: soldier.ammoId,
      grenades: Object.fromEntries(
        Object.values(GrenadeId).map((kind) => [kind, Math.max(0, soldier.grenades[kind] - GRENADES[kind].issued)]),
      ) as Record<GrenadeId, number>,
      items: { ...soldier.items },
      // Every unit carries a clone of the weapon template with its own rail,
      // so this array is already exactly what is fitted to this gun. Copied,
      // never handed out: the rail is live state.
      attachments: [...soldier.weapon.attachments],
      sidearm: soldier.sidearm,
      role: soldier.role,
    }))
  }

  /**
   * This squad exactly as it stands, in the shape a header or a `ready`
   * states a squad in: each soldier's sheet, the kit {@link loadoutOf}
   * already reads back live, and its current HP as the starting state — which
   * is what "current" already means the moment a squad is built, before any
   * turn has run.
   */
  deploymentsOf(faction: Faction): Deployment[] {
    const kits = this.loadoutOf(faction)
    return this.byFaction[faction].map((soldier, i) => ({
      ...(soldier.characterId !== undefined ? { characterId: soldier.characterId } : {}),
      sheet: soldier.sheet,
      loadout: kits[i]!,
      state: { hp: soldier.hp, fatigue: soldier.fatigue },
    }))
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
