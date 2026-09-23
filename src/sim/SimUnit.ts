import { AMMO, type AmmoId, type AmmoSpec, GRENADES, GrenadeId, type GrenadeSpec, WEAPONS, type Weapon, type WeaponId } from '../core/Arsenal'
import { effectiveMaxAp, type StatusState } from '../core/Ballistics'
import type { Combatant } from '../core/Combatant'
import { type CharacterSheet, derive, type DerivedStats, UtilityId } from '../core/Characters'
import type { Tile } from '../core/Grid'
import { ATTACHMENTS, type AttachmentId } from '../core/Attachments'
import { ITEMS, ItemId } from '../core/Items'
import {
  NO_TRAITS,
  type ResolvedTraits,
  resolveSourcedInto,
  type SourcedTrait,
  TraitSource,
  type TraitId,
  woundTraits,
} from '../core/Traits'
import { RULES, type Faction } from '../config'

/**
 * A fighter with no body.
 *
 * The same {@link Combatant} the resolvers see in a real match, with none of
 * the scene: no glTF, no mixer, no materials, no engine. Everything a shot
 * reads comes from here, so a simulated fight and a played one go through
 * exactly the same rules — which is the only reason a balance number measured
 * out here means anything in there.
 *
 * It deliberately mirrors `Soldier`'s trait handling rather than sharing it,
 * because sharing it today would mean depending on `Soldier`, which is the
 * thing that needs a scene.
 */
export class SimUnit implements Combatant {
  readonly weapon: Weapon
  ammo: AmmoSpec
  maxHp = 0
  private hpLeft = 0
  maxAp = 0
  private apLeft = 0
  armor: number
  isCrouching = false
  spentThisTurn = 0
  exhaustedTurns = 0
  firedThisTurn = false
  watching = false
  known = false
  readonly isMoving = false
  targetYaw = 0
  statuses: StatusState[] = []
  tile: Tile
  readonly grenades: Record<GrenadeId, number>
  readonly items: Record<ItemId, number>
  /**
   * This unit's own grenades, not the shared table.
   *
   * Copied because Strength is stamped onto the throw range here exactly as a
   * real soldier stamps it onto their component: mutating `GRENADES` would
   * hand one character's arm to every unit in the sweep.
   */
  readonly grenadeSpecs: Record<GrenadeId, GrenadeSpec>

  private readonly derived: DerivedStats
  private readonly resolved: ResolvedTraits = { ...NO_TRAITS }
  /** Gear's share alone, so Strength can cancel that and leave a limp. */
  private readonly gearResolved: ResolvedTraits = { ...NO_TRAITS }
  private readonly sourcedTraits: SourcedTrait[] = []

  constructor(
    readonly faction: Faction,
    readonly squadIndex: number,
    readonly name: string,
    readonly sheet: CharacterSheet,
    weaponId: WeaponId,
    ammoId: AmmoId,
    tile: Tile,
    grenades: Record<GrenadeId, number>,
    items: Record<ItemId, number>,
    attachments: readonly AttachmentId[] = [],
  ) {
    // Cloned, because a clip is per-unit state and `WEAPONS` is the shared table.
    this.weapon = WEAPONS[weaponId].clone()
    // Fitted before the first fold, so the rail is in force from the off. The
    // weapon refuses anything its class has no room for, exactly as it does in
    // a match.
    for (const id of attachments) this.weapon.fit(id)
    this.ammo = AMMO[ammoId]
    this.tile = { ...tile }
    this.grenades = { ...grenades }
    this.items = { ...items }
    this.armor = RULES.maxArmor + this.resolved.armor
    this.derived = derive(sheet)
    this.grenadeSpecs = {} as Record<GrenadeId, GrenadeSpec>
    const demolitions = 1 + (sheet.utility[UtilityId.Demolitions] ?? 0) / 100
    for (const kind of Object.values(GrenadeId)) {
      const base = GRENADES[kind]
      this.grenadeSpecs[kind] = {
        ...base,
        throwRange: Math.max(1, base.throwRange + this.derived.throwRange),
        areaRadius: Math.max(1, Math.round(base.areaRadius * demolitions)),
        armorShred: Math.max(0, Math.round(base.armorShred * demolitions)),
      }
    }
    // Twice, and the order is the point: the first pass resolves the sheet's
    // own traits so `maxHp` can be worked out, the second judges wounds against
    // a unit that is actually at full health rather than at zero.
    this.refreshTraits()
    this.maxHp = this.derived.maxHp + this.resolved.maxHp
    this.hpLeft = this.maxHp
    this.refreshTraits()
    this.apLeft = this.maxAp
  }

  /**
   * Points left, counting what gets spent on the way down.
   *
   * A soldier counts spending in the same setter for the same reason: the rule
   * about exhaustion asks what a unit *used*, not what it has left.
   */
  get ap(): number {
    return this.apLeft
  }
  set ap(value: number) {
    if (value < this.apLeft) this.spentThisTurn += this.apLeft - value
    this.apLeft = value
  }

  /** Sheet plus carried gear, exactly as a real unit folds them. */
  refreshTraits(): void {
    this.sourcedTraits.length = 0
    for (const id of this.sheet.traits) {
      this.sourcedTraits.push({ id, source: TraitSource.Innate })
    }
    for (const id of woundTraits(this.hpLeft, this.maxHp)) {
      this.sourcedTraits.push({ id, source: TraitSource.Wound })
    }
    for (const id of Object.values(ItemId)) {
      if ((this.items[id] ?? 0) <= 0) continue
      const granted = ITEMS[id].traits
      if (granted) for (const trait of granted) {
        this.sourcedTraits.push({ id: trait, source: TraitSource.Gear })
      }
    }
    for (const id of this.weapon.attachments) {
      for (const trait of ATTACHMENTS[id]?.traits ?? []) {
        this.sourcedTraits.push({ id: trait, source: TraitSource.Gear })
      }
    }
    resolveSourcedInto(this.resolved, this.sourcedTraits)
    resolveSourcedInto(this.gearResolved, this.sourcedTraits, TraitSource.Gear)

    // Re-priced here rather than once at kit-up, because wounds are traits: a
    // soldier whose arm stops working carries a `maxAp` penalty, and
    // `Soldier.refreshTraits` recomputes its allowance the moment that lands.
    // Computed once, this runner handed wounded units their whole turn back
    // every round — a difference a replay of a recorded match found, and one
    // that made every balance number about wounds a statement about the
    // harness rather than the game.
    const apRelief = Math.round(
      -Math.min(0, this.gearResolved.maxAp) * (this.derived.gearRelief / 100),
    )
    const maxAp = this.derived.maxAp + this.resolved.maxAp + apRelief
    if (maxAp !== this.maxAp) {
      // A unit standing at full keeps standing at full; one mid-turn loses only
      // what the ceiling dropped by. The same clamp a soldier applies.
      const wasFull = this.apLeft >= this.maxAp
      this.maxAp = maxAp
      this.apLeft = wasFull ? maxAp : Math.min(this.apLeft, maxAp)
    }
  }

  get traits(): ResolvedTraits {
    return this.resolved
  }

  get hp(): number {
    return this.hpLeft
  }
  set hp(value: number) {
    const before = woundTraits(this.hpLeft, this.maxHp).length
    this.hpLeft = value
    if (woundTraits(value, this.maxHp).length !== before) this.refreshTraits()
  }

  get moveCostMul(): number {
    const relieved = Math.max(0, this.gearResolved.moveCost) * (this.derived.gearRelief / 100)
    return 1 + this.resolved.moveCost - relieved
  }

  get isDead(): boolean {
    return this.hp <= 0
  }

  get effectiveMaxAp(): number {
    return effectiveMaxAp(this.maxAp, this.statuses)
  }

  get proficiency(): number {
    const braced = this.isCrouching ? this.resolved.accuracyCrouched : 0
    return this.sheet.proficiency[this.weapon.id] + this.resolved.accuracy + braced
  }

  get rangeFalloff(): number {
    return this.resolved.rangeFalloff
  }

  /** Fraction added to the damage this unit takes. Negative is plate helping. */
  get damageTaken(): number {
    return this.resolved.damageTaken
  }

  get silenced(): boolean {
    return this.resolved.silenced
  }

  get unreadable(): boolean {
    return this.resolved.unreadable
  }

  /** Consumables this character can carry into a match. */
  get carrySlots(): number {
    return this.derived.carrySlots
  }

  get itemApDelta(): number {
    return this.derived.itemApDelta
  }

  get utility(): Record<UtilityId, number> {
    return this.sheet.utility
  }

  get gearOnlyTraits(): ResolvedTraits {
    return this.gearResolved
  }

  get healBonus(): number {
    return this.derived.healBonus
  }

  get evasion(): number {
    const braced = this.isCrouching ? this.resolved.evasionCrouched : 0
    return Math.max(0, this.derived.evasion + this.resolved.evasion + braced)
  }

  get critImmune(): boolean {
    return this.resolved.critImmune
  }

  get critChanceBonus(): number {
    return this.resolved.critChance
  }

  get critMultiplierBonus(): number {
    return this.resolved.critMultiplier
  }

  enterCover(): void {
    if (this.isDead) return
    this.isCrouching = true
  }

  exitCover(): void {
    this.isCrouching = false
  }
}
