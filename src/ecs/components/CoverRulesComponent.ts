import { Component } from '../Component'
import { COVER } from '../../config'
import { applyTunables, snapshotTunables } from '../tunables'

/** The live {@link COVER} table itself — accuracy lost to cover and stance. */
export class CoverRulesComponent extends Component {
  static readonly componentName = 'coverRules'
  get name(): string {
    return CoverRulesComponent.componentName
  }

  constructor(readonly cover: typeof COVER = COVER) {
    super()
  }

  serialize(): Record<string, unknown> {
    return snapshotTunables(this.cover)
  }

  deserialize(data: Record<string, unknown>): void {
    applyTunables(this.cover, data)
  }
}
