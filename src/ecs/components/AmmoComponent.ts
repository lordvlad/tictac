import { Component } from '../Component'
import { AMMO, type AmmoSpec, AmmoId } from '../../core/Arsenal'
import { applyTunables, snapshotTunables } from '../tunables'

/** The unit's own loaded round. Holds the live spec, not a copy of it. */
export class AmmoComponent extends Component {
  static readonly componentName = 'ammo'
  get name(): string {
    return AmmoComponent.componentName
  }

  ammoId: AmmoId
  ammo: AmmoSpec

  constructor(ammoId: AmmoId = AmmoId.Standard, ammo?: AmmoSpec) {
    super()
    this.ammoId = ammoId
    this.ammo = ammo ?? { ...AMMO[ammoId] }
  }

  load(ammoId: AmmoId): void {
    this.ammoId = ammoId
    this.ammo = { ...AMMO[ammoId] }
  }

  serialize(): Record<string, unknown> {
    return { ammoId: this.ammoId, stats: snapshotTunables(this.ammo) }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.ammoId === 'string' && data.ammoId !== this.ammoId) {
      this.load(data.ammoId as AmmoId)
    }
    applyTunables(this.ammo, data.stats)
  }
}
