import { Component } from '../Component'

/**
 * The part of a unit's traits an *enemy* has to be able to read.
 *
 * Evasion and crit immunity are consulted by whoever is shooting, and both can
 * come from gear — which is loadout, private to the peer that chose it. So the
 * owner resolves them and this component replicates the answer. The shooter
 * reads these two numbers and never inspects the other side's kit, which is the
 * same contract the resolved damage numbers already travel under.
 *
 * Everything a trait does to its *own* unit (accuracy, crit chance, HP, AP)
 * stays local: it is folded into numbers that are either replicated in their
 * own component or sent with the attack that used them.
 */
export class TraitsComponent extends Component {
  static readonly componentName = 'traits'
  get name(): string {
    return TraitsComponent.componentName
  }

  constructor(
    public evasion: number = 0,
    public critImmune: boolean = false,
    /**
     * What a step costs this unit, as a multiple of the terrain's own price.
     *
     * Here rather than folded on demand because the mover works on components
     * and never sees a unit object — and because it travels for the same
     * reason evasion does: a wound is visible in the hit points a peer already
     * has, but gear that slowed a unit down would not be.
     */
    public moveCostMul: number = 1,
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { evasion: this.evasion, critImmune: this.critImmune, moveCostMul: this.moveCostMul }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.evasion === 'number') this.evasion = data.evasion
    if (typeof data.critImmune === 'boolean') this.critImmune = data.critImmune
    if (typeof data.moveCostMul === 'number' && data.moveCostMul > 0) {
      this.moveCostMul = data.moveCostMul
    }
  }
}
