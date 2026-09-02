import { Component } from '../Component'
import { RULES } from '../../config'

export class HealthComponent extends Component {
  static readonly componentName = 'health'
  get name(): string {
    return HealthComponent.componentName
  }

  constructor(
    public hp: number = RULES.maxHp,
    public maxHp: number = RULES.maxHp
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { hp: this.hp, maxHp: this.maxHp }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.hp === 'number') this.hp = data.hp
    if (typeof data.maxHp === 'number') this.maxHp = data.maxHp
  }
}
