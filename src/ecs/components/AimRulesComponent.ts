import { Component } from '../Component'
import { AIM } from '../../config'
import { applyTunables, snapshotTunables } from '../tunables'

/** The live {@link AIM} table itself — global aim clamps and offsets. */
export class AimRulesComponent extends Component {
  static readonly componentName = 'aimRules'
  get name(): string {
    return AimRulesComponent.componentName
  }

  constructor(readonly aim: typeof AIM = AIM) {
    super()
  }

  serialize(): Record<string, unknown> {
    return snapshotTunables(this.aim)
  }

  deserialize(data: Record<string, unknown>): void {
    applyTunables(this.aim, data)
  }
}
