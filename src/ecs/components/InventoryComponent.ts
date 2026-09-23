import { Component } from '../Component'
import { GrenadeId } from '../../core/Arsenal'
import { MELEE, MeleeId } from '../../core/Melee'

/** Grenades still in the pouch, by kind, and what is in the sidearm slot. */
export class InventoryComponent extends Component {
  static readonly componentName = 'inventory'
  get name(): string {
    return InventoryComponent.componentName
  }

  constructor(
    public grenades: Record<GrenadeId, number> = {
      [GrenadeId.Frag]: 1,
      [GrenadeId.Flash]: 1,
      [GrenadeId.Smoke]: 1,
    },
    /** Fists when the slot is empty: every soldier can do that much. */
    public sidearm: MeleeId = MeleeId.Fists,
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { grenades: { ...this.grenades }, sidearm: this.sidearm }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.sidearm === 'string' && Object.hasOwn(MELEE, data.sidearm)) {
      this.sidearm = data.sidearm as MeleeId
    }
    if (!data.grenades || typeof data.grenades !== 'object') return
    for (const kind of Object.values(GrenadeId)) {
      const value = (data.grenades as Record<string, unknown>)[kind]
      if (typeof value === 'number') this.grenades[kind] = value
    }
  }
}
