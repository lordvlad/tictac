import { Component } from '../Component'
import { STATUSES, type StatusKind } from '../../core/Arsenal'
import { applyTunables, snapshotTunables } from '../tunables'

/** The live {@link STATUSES} table — duration and severity of each effect. */
export class StatusSpecsComponent extends Component {
  static readonly componentName = 'statusSpecs'
  get name(): string {
    return StatusSpecsComponent.componentName
  }

  constructor(readonly specs: typeof STATUSES = STATUSES) {
    super()
  }

  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const kind of Object.keys(this.specs) as StatusKind[]) {
      out[kind] = snapshotTunables(this.specs[kind])
    }
    return out
  }

  deserialize(data: Record<string, unknown>): void {
    for (const kind of Object.keys(this.specs) as StatusKind[]) {
      applyTunables(this.specs[kind], data[kind])
    }
  }
}
