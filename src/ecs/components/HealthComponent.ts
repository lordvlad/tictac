import { Component } from '../Component'
import { RULES } from '../../config'

export class HealthComponent extends Component {
  static readonly componentName = 'health'
  get name(): string {
    return HealthComponent.componentName
  }

  constructor(
    public hp: number = RULES.maxHp,
    public maxHp: number = RULES.maxHp,
    /**
     * Got off the field alive by retreating (`core/Retreat`): neither dead nor
     * still in the fight. Replicated and digested like the hit points beside
     * it, because who is still standing is what ends a match.
     */
    public withdrawn: boolean = false,
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { hp: this.hp, maxHp: this.maxHp, withdrawn: this.withdrawn }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.hp === 'number') this.hp = data.hp
    if (typeof data.maxHp === 'number') this.maxHp = data.maxHp
    if (typeof data.withdrawn === 'boolean') this.withdrawn = data.withdrawn
  }
}
