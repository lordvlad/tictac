import { Component } from '../Component'
import { GRENADES, type GrenadeSpec, GrenadeId } from '../../core/Arsenal'
import { applyTunables, snapshotTunables } from '../tunables'

/** Per-unit grenade specs, so blast and throw range are tunable per soldier. */
export class GrenadeSpecsComponent extends Component {
  static readonly componentName = 'grenadeSpecs'
  get name(): string {
    return GrenadeSpecsComponent.componentName
  }

  constructor(
    public specs: Record<GrenadeId, GrenadeSpec> = {
      [GrenadeId.Frag]: { ...GRENADES[GrenadeId.Frag] },
      [GrenadeId.Flash]: { ...GRENADES[GrenadeId.Flash] },
      [GrenadeId.Smoke]: { ...GRENADES[GrenadeId.Smoke] },
    }
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const kind of Object.values(GrenadeId)) out[kind] = snapshotTunables(this.specs[kind])
    return out
  }

  deserialize(data: Record<string, unknown>): void {
    for (const kind of Object.values(GrenadeId)) applyTunables(this.specs[kind], data[kind])
  }
}
