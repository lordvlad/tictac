import { Component } from '../Component'
import { RULES } from '../../config'

export class ArmorComponent extends Component {
  static readonly componentName = 'armor'
  get name(): string {
    return ArmorComponent.componentName
  }

  constructor(
    public armor: number = RULES.maxArmor,
    public maxArmor: number = RULES.maxArmor
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { armor: this.armor, maxArmor: this.maxArmor }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.armor === 'number') this.armor = data.armor
    if (typeof data.maxArmor === 'number') this.maxArmor = data.maxArmor
  }
}
