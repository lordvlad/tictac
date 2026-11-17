import { GrenadeId } from '../core/Arsenal'
import { ItemId } from '../core/Items'
import type { UnitLoadout } from '../core/Loadout'
import { startingGrenades } from '../rules/Loadout'
import type { Soldier } from './Soldier'

/**
 * Stamp a chosen kit onto a soldier.
 *
 * It sits with the soldier rather than with the pool rules (`rules/Loadout`)
 * because it writes through `Soldier`; what the pouch holds, issue included,
 * is decided there (`startingGrenades`) and nowhere else.
 *
 * Every grenade and item kind is written, zeros included: a fresh
 * `InventoryComponent` carries one of each grenade and `ItemsComponent` starts
 * from `STARTING_ITEMS`, so anything left unwritten keeps a default the player
 * never asked for.
 *
 * Attachments go on last, and only through the soldier: `equip` hands the unit
 * a fresh clone of the weapon template with a bare rail, so nothing fitted
 * before the swap can survive it.
 */
export function applyUnitLoadout(soldier: Soldier, unit: UnitLoadout): void {
  soldier.equip(unit.weaponId, unit.ammoId)
  soldier.role = unit.role
  const pouch = startingGrenades(unit)
  for (const kind of Object.values(GrenadeId)) soldier.grenades[kind] = pouch[kind]
  for (const id of Object.values(ItemId)) soldier.items[id] = unit.items[id] ?? 0
  // The pouch decides which worn gear is in force, so the traits it grants are
  // only known once it has been stamped. `equip` and every `fitAttachment`
  // refold as well, which is why the pouch is written before the rail: each
  // refold has to see the finished kit.
  soldier.refreshTraits()
  for (const id of unit.attachments) soldier.fitAttachment(id)
  soldier.sidearm = unit.sidearm
}
