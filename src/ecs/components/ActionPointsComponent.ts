import { Component } from '../Component'
import { RULES } from '../../config'

export class ActionPointsComponent extends Component {
  static readonly componentName = 'actionPoints'
  get name(): string {
    return ActionPointsComponent.componentName
  }

  constructor(
    public ap: number = RULES.maxAp,
    public maxAp: number = RULES.maxAp
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { ap: this.ap, maxAp: this.maxAp }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.ap === 'number') this.ap = data.ap
    if (typeof data.maxAp === 'number') this.maxAp = data.maxAp
  }
}
