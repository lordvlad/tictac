import { Component } from '../Component'

/**
 * What a unit's traits work out to: the one place anything reads them from.
 *
 * The soldier folds its sheet, wounds, role and carried gear into these numbers
 * (`Soldier.refreshTraits`) and nothing reads the fold itself, so a rewind or a
 * peer's update that puts this component back puts every trait-driven number
 * back with it. Evasion, crit immunity and the rest an *enemy* consults come
 * from gear — loadout, private to the peer that chose it — so the owner
 * resolves them and this component carries the answer; a shooter reads the
 * target's word for it and never inspects the other side's kit.
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
    /** Accuracy added to every shot with the unit's own weapon. */
    public accuracy: number = 0,
    /** Accuracy added only while crouched, as `evasionCrouched` is. */
    public accuracyCrouched: number = 0,
    /** Extra fraction on the weapon's range falloff. */
    public rangeFalloff: number = 0,
    /** Firing does not give the unit's position away. */
    public silenced: boolean = false,
    /** Percentage points added to the unit's own crit chance. */
    public critChance: number = 0,
    /** Added to the multiplier the unit's own crits apply. */
    public critMultiplier: number = 0,
    /** Carried gear slows the unit: what Strength learns from. */
    public gearDrag: boolean = false,
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
      accuracy: this.accuracy,
      accuracyCrouched: this.accuracyCrouched,
      rangeFalloff: this.rangeFalloff,
      silenced: this.silenced,
      critChance: this.critChance,
      critMultiplier: this.critMultiplier,
      gearDrag: this.gearDrag,
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
    if (typeof data.accuracy === 'number') this.accuracy = data.accuracy
    if (typeof data.accuracyCrouched === 'number') this.accuracyCrouched = data.accuracyCrouched
    if (typeof data.rangeFalloff === 'number') this.rangeFalloff = data.rangeFalloff
    if (typeof data.silenced === 'boolean') this.silenced = data.silenced
    if (typeof data.critChance === 'number') this.critChance = data.critChance
    if (typeof data.critMultiplier === 'number') this.critMultiplier = data.critMultiplier
    if (typeof data.gearDrag === 'boolean') this.gearDrag = data.gearDrag
  }
}
