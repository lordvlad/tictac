import { Component } from '../Component'
import { WEAPONS, Weapon, WeaponId } from '../../core/Arsenal'
import { applyTunables, snapshotTunables } from '../tunables'

/**
 * The unit's own weapon instance — not a copy of it.
 *
 * Ballistics reads `Soldier.weapon` directly, and the debug panel edits that
 * same object, so the component holds the instance rather than mirroring its
 * numbers. There is one store, and this is the wire adapter over it.
 */
export class WeaponComponent extends Component {
  static readonly componentName = 'weapon'
  get name(): string {
    return WeaponComponent.componentName
  }

  weaponId: WeaponId
  weapon: Weapon

  constructor(weaponId: WeaponId = WeaponId.Rifle, weapon?: Weapon) {
    super()
    this.weaponId = weaponId
    this.weapon = weapon ?? WEAPONS[weaponId].clone()
  }

  /** Re-stamp from the shared template, discarding per-unit tuning. */
  equip(weaponId: WeaponId): void {
    this.weaponId = weaponId
    this.weapon = WEAPONS[weaponId].clone()
  }

  serialize(): Record<string, unknown> {
    return { weaponId: this.weaponId, stats: snapshotTunables(this.weapon) }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.weaponId === 'string' && data.weaponId !== this.weaponId) {
      this.equip(data.weaponId as WeaponId)
    }
    applyTunables(this.weapon, data.stats)
  }
}
