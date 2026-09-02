import { Component } from '../Component'
import { RULES } from '../../config'
import { applyTunables, snapshotTunables } from '../tunables'

/**
 * The live {@link RULES} table itself.
 *
 * Every system already reads `RULES` directly; wrapping the same object keeps
 * one store and means a debug edit needs no separate propagation step.
 */
export class MatchRulesComponent extends Component {
  static readonly componentName = 'matchRules'
  get name(): string {
    return MatchRulesComponent.componentName
  }

  constructor(readonly rules: typeof RULES = RULES) {
    super()
  }

  serialize(): Record<string, unknown> {
    return snapshotTunables(this.rules)
  }

  deserialize(data: Record<string, unknown>): void {
    applyTunables(this.rules, data)
  }
}
