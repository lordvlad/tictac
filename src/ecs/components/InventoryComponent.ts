import { Component } from '../Component'
import { GrenadeId } from '../../core/Arsenal'

/** Grenades still in the pouch, by kind. */
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
    }
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { grenades: { ...this.grenades } }
  }

  deserialize(data: Record<string, unknown>): void {
    if (!data.grenades || typeof data.grenades !== 'object') return
    for (const kind of Object.values(GrenadeId)) {
      const value = (data.grenades as Record<string, unknown>)[kind]
      if (typeof value === 'number') this.grenades[kind] = value
    }
  }
}
