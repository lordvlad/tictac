import { AMMO, type AmmoId, type AmmoSpec, GRENADES, type GrenadeId, type GrenadeSpec, WEAPONS, type Weapon, type WeaponId } from '../core/Arsenal'
import { effectiveMaxAp, type StatusState } from '../core/Ballistics'
import type { Combatant } from '../core/Combatant'
import type { CharacterSheet } from '../core/Characters'
import type { Tile } from '../core/Grid'
import { ITEMS, ItemId } from '../core/Items'
import { NO_TRAITS, type ResolvedTraits, resolveTraitsInto, type TraitId } from '../core/Traits'
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
  hp: number
  maxHp: number
  ap: number
  maxAp: number
  armor: number
  isCrouching = false
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
  ) {
    // Cloned, because a clip is per-unit state and `WEAPONS` is the shared table.
    this.weapon = WEAPONS[weaponId].clone()
    this.ammo = AMMO[ammoId]
    this.tile = { ...tile }
    this.grenades = { ...grenades }
    this.items = { ...items }
    this.armor = RULES.maxArmor
    this.refreshTraits()
    this.maxHp = sheet.maxHp + this.resolved.maxHp
    this.maxAp = sheet.maxAp + this.resolved.maxAp
    this.hp = this.maxHp
    this.ap = this.maxAp
  }

  /** Sheet plus carried gear, exactly as a real unit folds them. */
  refreshTraits(): void {
    this.traitIds.length = 0
    for (const id of this.sheet.traits) this.traitIds.push(id)
    for (const id of Object.values(ItemId)) {
      if ((this.items[id] ?? 0) <= 0) continue
      const granted = ITEMS[id].traits
      if (granted) for (const trait of granted) this.traitIds.push(trait)
    }
    resolveTraitsInto(this.resolved, this.traitIds)
  }

  get traits(): ResolvedTraits {
    return this.resolved
  }

  get isDead(): boolean {
    return this.hp <= 0
  }

  get effectiveMaxAp(): number {
    return effectiveMaxAp(this.maxAp, this.statuses)
  }

  get proficiency(): number {
    return this.sheet.proficiency[this.weapon.id] + this.resolved.accuracy
  }

  get evasion(): number {
    return Math.max(0, this.sheet.evasion + this.resolved.evasion)
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
