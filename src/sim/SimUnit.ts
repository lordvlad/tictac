import { AMMO, type AmmoId, type AmmoSpec, GRENADES, type GrenadeId, type GrenadeSpec, WEAPONS, type Weapon, type WeaponId } from '../core/Arsenal'
import { effectiveMaxAp, type StatusState } from '../core/Ballistics'
import type { Combatant } from '../core/Combatant'
import type { CharacterSheet } from '../core/Characters'
import type { Tile } from '../core/Grid'
import { ATTACHMENTS, type AttachmentId } from '../core/Attachments'
import { ITEMS, ItemId } from '../core/Items'
import {
  NO_TRAITS,
  type ResolvedTraits,
  resolveTraitsInto,
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
  maxHp: number
  private hpLeft = 0
  maxAp: number
  private apLeft = 0
  armor: number
  isCrouching = false
  spentThisTurn = 0
  exhaustedTurns = 0
  firedThisTurn = false
  known = false
  readonly isMoving = false
  targetYaw = 0
  statuses: StatusState[] = []
  tile: Tile
  readonly grenades: Record<GrenadeId, number>
  readonly items: Record<ItemId, number>
  readonly grenadeSpecs: Record<GrenadeId, GrenadeSpec> = GRENADES

  private readonly resolved: ResolvedTraits = { ...NO_TRAITS }
  private readonly traitIds: TraitId[] = []

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
    this.refreshTraits()
    this.maxHp = sheet.maxHp + this.resolved.maxHp
    this.maxAp = sheet.maxAp + this.resolved.maxAp
    this.hp = this.maxHp
    this.ap = this.maxAp
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
    this.traitIds.length = 0
    for (const id of this.sheet.traits) this.traitIds.push(id)
    for (const id of woundTraits(this.hpLeft, this.maxHp)) this.traitIds.push(id)
    for (const id of Object.values(ItemId)) {
      if ((this.items[id] ?? 0) <= 0) continue
      const granted = ITEMS[id].traits
      if (granted) for (const trait of granted) this.traitIds.push(trait)
    }
    for (const id of this.weapon.attachments) {
      for (const trait of ATTACHMENTS[id]?.traits ?? []) this.traitIds.push(trait)
    }
    resolveTraitsInto(this.resolved, this.traitIds)
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
    return 1 + this.resolved.moveCost
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

  get evasion(): number {
    const braced = this.isCrouching ? this.resolved.evasionCrouched : 0
    return Math.max(0, this.sheet.evasion + this.resolved.evasion + braced)
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
