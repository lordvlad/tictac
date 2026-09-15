import { Component } from '../Component'
import { RULES } from '../../config'

export class ActionPointsComponent extends Component {
  static readonly componentName = 'actionPoints'
  get name(): string {
    return ActionPointsComponent.componentName
  }

  constructor(
    public ap: number = RULES.maxAp,
    public maxAp: number = RULES.maxAp,
    /**
     * Points consumed by this unit's own actions since its last refill.
     *
     * Counted rather than inferred from what is left, because a unit that ends
     * its turn early is *given* nothing remaining without having run anywhere —
     * and exhaustion is about how hard it ran.
     */
    public spentThisTurn: number = 0,
    /** Consecutive turns it has spent every point it had. */
    public exhaustedTurns: number = 0,
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return {
      ap: this.ap,
      maxAp: this.maxAp,
      spentThisTurn: this.spentThisTurn,
      exhaustedTurns: this.exhaustedTurns,
    }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.ap === 'number') this.ap = data.ap
    if (typeof data.maxAp === 'number') this.maxAp = data.maxAp
    if (typeof data.spentThisTurn === 'number') this.spentThisTurn = data.spentThisTurn
    if (typeof data.exhaustedTurns === 'number') this.exhaustedTurns = data.exhaustedTurns
  }
}
