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
  /**
   * Put a weapon in these hands.
   *
   * `serial` identifies the instance. Passed in rather than counted, because a
   * counter is per-process and two peers must reach the same number for the
   * same gun: a soldier's weapon is numbered after the soldier, not after how
   * many times a screen cloned a template.
   */
  equip(weaponId: WeaponId, serial?: number): void {
    this.weaponId = weaponId
    this.weapon = WEAPONS[weaponId].clone(serial)
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
