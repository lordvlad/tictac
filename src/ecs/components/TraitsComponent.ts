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
    /**
     * Evasion that only applies while the unit is crouched.
     *
     * Separate from `evasion` because it comes and goes with stance, and
     * replicated for the same reason the flat part is: a shooter asks the
     * *target* how hard it is to hit, and a bipod on the far side is fitted to
     * a weapon this side only has a stock copy of.
     */
    public evasionCrouched: number = 0,
    /** Fraction added to incoming damage — worn plate taking a share off. */
    public damageTaken: number = 0,
    /**
     * Being shot at does not reveal this unit's sheet.
     *
     * Replicated for the same reason the numbers beside it are: the peer
     * shooting decides what it has learned, and it is reading the *target*.
     * Left local, this side would consult its stock copy of the other squad
     * and read a unit that gives nothing away.
     */
    public unreadable: boolean = false,
    /**
     * No hit on this unit can start it bleeding. Replicated like `critImmune`:
     * the shooter's side rolls against the target's word for it.
     */
    public bleedImmune: boolean = false,
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return {
      evasion: this.evasion,
      critImmune: this.critImmune,
      moveCostMul: this.moveCostMul,
      evasionCrouched: this.evasionCrouched,
      damageTaken: this.damageTaken,
      unreadable: this.unreadable,
      bleedImmune: this.bleedImmune,
    }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.evasion === 'number') this.evasion = data.evasion
    if (typeof data.critImmune === 'boolean') this.critImmune = data.critImmune
    if (typeof data.moveCostMul === 'number' && data.moveCostMul > 0) {
      this.moveCostMul = data.moveCostMul
    }
    if (typeof data.evasionCrouched === 'number') this.evasionCrouched = data.evasionCrouched
    if (typeof data.damageTaken === 'number') this.damageTaken = data.damageTaken
    if (typeof data.unreadable === 'boolean') this.unreadable = data.unreadable
    if (typeof data.bleedImmune === 'boolean') this.bleedImmune = data.bleedImmune
  }
}
