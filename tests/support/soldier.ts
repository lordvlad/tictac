import { Faction } from '../../src/config'
import { AmmoId, GRENADES, type GrenadeId, WeaponId } from '../../src/core/Arsenal'
import type { AttachmentId } from '../../src/core/Attachments'
import { type CharacterSheet, characterSheet } from '../../src/core/Characters'
import { Grid, type Tile } from '../../src/core/Grid'
import { ItemId } from '../../src/core/Items'
import { MeleeId } from '../../src/core/Melee'
import { Rng } from '../../src/core/rng'
import { World } from '../../src/ecs/World'
import { Soldier } from '../../src/entities/Soldier'
import { applyUnitLoadout } from '../../src/game/Loadout'

export interface SoldierSpec {
  faction?: Faction
  squadIndex?: number
  sheet?: CharacterSheet
  weapon?: WeaponId
  ammo?: AmmoId
  tile?: Tile
  grenades?: Partial<Record<GrenadeId, number>>
  items?: Partial<Record<ItemId, number>>
  attachments?: AttachmentId[]
  sidearm?: MeleeId
}

/**
 * One real soldier, alone in a world of its own, with no scene.
 *
 * The rules have one carrier — the ECS soldier a match plays with — so a rule
 * is tested on that and nothing else. Each call builds its own world: tests
 * that want two units in one fight should build a `Squads` instead.
 */
export function headlessSoldier(spec: SoldierSpec = {}): Soldier {
  const world = new World()
  const grid = new Grid(16)
  const soldier = new Soldier(
    world,
    spec.faction ?? Faction.Blue,
    spec.squadIndex ?? 0,
    'Test',
    spec.tile ?? { x: 1, y: 1 },
    grid,
    spec.sheet ?? characterSheet(new Rng(21)),
  )
  applyUnitLoadout(soldier, {
    weaponId: spec.weapon ?? WeaponId.Rifle,
    ammoId: spec.ammo ?? AmmoId.Standard,
    grenades: Object.fromEntries(
      Object.keys(GRENADES).map((kind) => [kind, spec.grenades?.[kind as GrenadeId] ?? 0]),
    ) as Record<GrenadeId, number>,
    items: Object.fromEntries(
      Object.values(ItemId).map((id) => [id, spec.items?.[id] ?? 0]),
    ) as Record<ItemId, number>,
    attachments: [...(spec.attachments ?? [])],
    sidearm: spec.sidearm ?? MeleeId.Fists,
  })
  return soldier
}
