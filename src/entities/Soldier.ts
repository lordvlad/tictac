import type { Vector3 } from 'three'
import { Faction, RULES } from '../config'
import {
  type AmmoSpec,
  AmmoId,
  type GrenadeSpec,
  GrenadeId,
  Weapon,
  WeaponId,
} from '../core/Arsenal'
import { effectiveMaxAp, type StatusState } from '../core/Ballistics'
import { characterSheet, type CharacterSheet } from '../core/Characters'
import { Rng } from '../core/rng'
import {
  NO_TRAITS,
  type ResolvedTraits,
  resolveTraitsInto,
  type TraitId,
} from '../core/Traits'
import { ITEMS, ItemId } from '../core/Items'
import type { Grid, Tile } from '../core/Grid'
import type { World } from '../ecs/World'
import {
  ActionPointsComponent,
  AmmoComponent,
  ArmorComponent,
  GrenadeSpecsComponent,
  HealthComponent,
  IdentityComponent,
  InventoryComponent,
  PositionComponent,
  StanceComponent,
  SightedComponent,
  StatusesComponent,
  WeaponComponent,
  ItemsComponent,
  TraitsComponent,
} from '../ecs/components'

/**
 * A soldier on the field: its 3D asset, its animation state, and typed access
 * to the components that hold its gameplay state.
 *
 * Nothing here stores game state of its own. Every property below reads and
 * writes the entity's components, so a mutation from combat resolution, the
 * turn manager or the debug panel lands in exactly one place and is picked up
 * by {@link World.syncDirty} without the writer having to announce it.
 */
export class Soldier {
  readonly faction: Faction
  readonly squadIndex: number // 0..3
  readonly name: string
  readonly entityId: number

  private readonly health: HealthComponent
  private readonly actionPoints: ActionPointsComponent
  private readonly armorComponent: ArmorComponent
  private readonly weaponComponent: WeaponComponent
  private readonly ammoComponent: AmmoComponent
  private readonly itemsComponent: ItemsComponent
  private readonly grenadeSpecsComponent: GrenadeSpecsComponent
  private readonly inventory: InventoryComponent
  private readonly stance: StanceComponent
  private readonly statusesComponent: StatusesComponent
  private readonly sighted: SightedComponent
  private readonly positionComponent: PositionComponent

  /**
   * Who this soldier is, as opposed to what they carry.
   *
   * Rolled by whichever peer commands this squad. For the enemy squad it is
   * replaced wholesale when their sheets arrive in the start handshake, which
   * is why it is not readonly.
   */
  sheet: CharacterSheet

  /** Sheet plus carried gear, refolded whenever either could have changed. */
  private readonly resolvedTraits: ResolvedTraits = { ...NO_TRAITS }
  private readonly traitIds: TraitId[] = []
  private readonly traitsComponent: TraitsComponent

  constructor(
    world: World,
    faction: Faction,
    squadIndex: number,
    name: string,
    initialTile: Tile,
    grid: Grid,
    sheet: CharacterSheet = characterSheet(new Rng(squadIndex + 1)),
  ) {
    this.faction = faction
    this.squadIndex = squadIndex
    this.name = name
    this.sheet = sheet

    // Blue team faces North (+Z), Red team faces South (-Z)
    const initialYaw = faction === Faction.Blue ? 0 : Math.PI

    this.entityId = world.createEntity()
    world.addComponent(this.entityId, new IdentityComponent(faction, squadIndex, name))
    this.positionComponent = world.addComponent(
      this.entityId,
      new PositionComponent({ ...initialTile }, grid.tileToWorld(initialTile), initialYaw),
    )
    // The sheet's own trait bonuses are in these ceilings from the start; gear
    // picked up later lifts them through `refreshTraits`.
    this.health = world.addComponent(this.entityId, new HealthComponent(sheet.maxHp, sheet.maxHp))
    this.actionPoints = world.addComponent(
      this.entityId,
      new ActionPointsComponent(sheet.maxAp, sheet.maxAp),
    )
    this.armorComponent = world.addComponent(
      this.entityId,
      new ArmorComponent(RULES.maxArmor, RULES.maxArmor),
    )
    this.weaponComponent = world.addComponent(this.entityId, new WeaponComponent())
    this.ammoComponent = world.addComponent(this.entityId, new AmmoComponent())
    this.itemsComponent = world.addComponent(this.entityId, new ItemsComponent())
    this.grenadeSpecsComponent = world.addComponent(this.entityId, new GrenadeSpecsComponent())
    this.inventory = world.addComponent(this.entityId, new InventoryComponent())
    this.stance = world.addComponent(this.entityId, new StanceComponent())
    this.statusesComponent = world.addComponent(this.entityId, new StatusesComponent())
    this.sighted = world.addComponent(this.entityId, new SightedComponent())
    this.traitsComponent = world.addComponent(this.entityId, new TraitsComponent())
    this.refreshTraits()

  }

  /**
   * Refold the sheet's traits with whatever is being carried, and publish the
   * two an enemy needs.
   *
   * Called on every change to the pouch rather than computed per read: a shot
   * preview runs every frame the panel is open, and the answer only moves when
   * gear does.
   */
  refreshTraits(): void {
    this.traitIds.length = 0
    for (const id of this.sheet.traits) this.traitIds.push(id)
    for (const id of Object.values(ItemId)) {
      if ((this.items[id] ?? 0) <= 0) continue
      const granted = ITEMS[id].traits
      if (granted) for (const trait of granted) this.traitIds.push(trait)
    }
    resolveTraitsInto(this.resolvedTraits, this.traitIds)

    const evasion = Math.max(0, this.sheet.evasion + this.resolvedTraits.evasion)
    if (this.traitsComponent.evasion !== evasion) this.traitsComponent.evasion = evasion
    if (this.traitsComponent.critImmune !== this.resolvedTraits.critImmune) {
      this.traitsComponent.critImmune = this.resolvedTraits.critImmune
    }

    // Trait ceilings sit on top of the sheet's own, and a unit at full health
    // keeps being at full health when the source of the lift changes.
    const maxHp = this.sheet.maxHp + this.resolvedTraits.maxHp
    if (this.health.maxHp !== maxHp) {
      const wasFull = this.health.hp >= this.health.maxHp
      this.health.maxHp = maxHp
      this.health.hp = wasFull ? maxHp : Math.min(this.health.hp, maxHp)
    }
    const maxAp = this.sheet.maxAp + this.resolvedTraits.maxAp
    if (this.actionPoints.maxAp !== maxAp) {
      const wasFull = this.actionPoints.ap >= this.actionPoints.maxAp
      this.actionPoints.maxAp = maxAp
      this.actionPoints.ap = wasFull ? maxAp : Math.min(this.actionPoints.ap, maxAp)
    }
  }

  /**
   * Adopt the sheet its own peer rolled for this soldier.
   *
   * Used on the enemy squad when the peer's sheets arrive in the handshake:
   * this side rolled placeholders so the match could be built, and these are
   * the real people. Called before the first turn, so resetting to the new
   * ceilings is the right thing rather than a mid-match heal.
   */
  adoptSheet(sheet: CharacterSheet): void {
    this.sheet = sheet
    this.refreshTraits()
    this.health.hp = this.health.maxHp
    this.actionPoints.ap = this.actionPoints.maxAp
  }

  /** Every trait in force, from the sheet and from the pouch. */
  get traits(): ResolvedTraits {
    return this.resolvedTraits
  }

  /**
   * Accuracy this soldier adds with the weapon in their hands: what the sheet
   * says about that class, plus anything a trait adds to every shot.
   */
  get proficiency(): number {
    return this.sheet.proficiency[this.weaponId] + this.resolvedTraits.accuracy
  }

  /**
   * Percentage points off an attacker's hit chance.
   *
   * Read from the replicated component, not recomputed: for an enemy unit this
   * is the only copy this side is allowed to trust.
   */
  get evasion(): number {
    return this.traitsComponent.evasion
  }

  /** True when no hit on this unit can be a critical. Replicated, as above. */
  get critImmune(): boolean {
    return this.traitsComponent.critImmune
  }

  /** Percentage points this soldier's traits add to its own crit chance. */
  get critChanceBonus(): number {
    return this.resolvedTraits.critChance
  }

  /** What its traits add to the multiplier its own crits apply. */
  get critMultiplierBonus(): number {
    return this.resolvedTraits.critMultiplier
  }

  // --- component-backed state -----------------------------------------------

  get hp(): number {
    return this.health.hp
  }
  set hp(value: number) {
    this.health.hp = value
  }
  get maxHp(): number {
    return this.health.maxHp
  }
  set maxHp(value: number) {
    this.health.maxHp = value
  }

  get ap(): number {
    return this.actionPoints.ap
  }
  set ap(value: number) {
    // Counted here because every action deducts through this one setter.
    // Forfeiting a turn writes the component directly and so does not count as
    // effort — see `TurnSystem.endUnitTurn`.
    if (value < this.actionPoints.ap) this.actionPoints.spentThisTurn += this.actionPoints.ap - value
    this.actionPoints.ap = value
  }

  get spentThisTurn(): number {
    return this.actionPoints.spentThisTurn
  }
  set spentThisTurn(value: number) {
    this.actionPoints.spentThisTurn = value
  }

  get exhaustedTurns(): number {
    return this.actionPoints.exhaustedTurns
  }
  set exhaustedTurns(value: number) {
    this.actionPoints.exhaustedTurns = value
  }
  get maxAp(): number {
    return this.actionPoints.maxAp
  }
  set maxAp(value: number) {
    this.actionPoints.maxAp = value
  }

  /** Armour points. Subtracts flat damage; stripped by shred effects. */
  get armor(): number {
    return this.armorComponent.armor
  }
  set armor(value: number) {
    this.armorComponent.armor = value
  }
  get maxArmor(): number {
    return this.armorComponent.maxArmor
  }
  set maxArmor(value: number) {
    this.armorComponent.maxArmor = value
  }

  get weaponId(): WeaponId {
    return this.weaponComponent.weaponId
  }
  get weapon(): Weapon {
    return this.weaponComponent.weapon
  }
  get ammoId(): AmmoId {
    return this.ammoComponent.ammoId
  }
  get ammo(): AmmoSpec {
    return this.ammoComponent.ammo
  }
  get grenadeSpecs(): Record<GrenadeId, GrenadeSpec> {
    return this.grenadeSpecsComponent.specs
  }
  /** Consumables still in the pouch, by item. */
  get items(): Record<ItemId, number> {
    return this.itemsComponent.items
  }

  /**
   * The action-point ceiling right now, including a stim's temporary lift.
   * `maxAp` stays the unit's own baseline so the bonus can lapse.
   */
  get effectiveMaxAp(): number {
    return effectiveMaxAp(this.actionPoints.maxAp, this.statusesComponent.list)
  }
  /** Grenades still in the pouch, by kind. */
  get grenades(): Record<GrenadeId, number> {
    return this.inventory.grenades
  }

  /**
   * Corner peeking. A unit that peeks also sees from the free tiles beside the
   * wall it is standing against, so its view reaches around the corner instead
   * of stopping at it.
   */
  get peek(): boolean {
    return this.stance.peek
  }
  set peek(value: boolean) {
    this.stance.peek = value
  }

  /** Live status effects (flashed, smoked, shredded). */
  get statuses(): StatusState[] {
    return this.statusesComponent.list
  }
  set statuses(value: StatusState[]) {
    this.statusesComponent.list = value
  }

  get tile(): Tile {
    return this.positionComponent.tile
  }
  set tile(value: Tile) {
    this.positionComponent.tile = value
  }

  /**
   * Where the unit is, in world space.
   *
   * The logical position, which a body eases toward rather than defines: it is
   * the step's destination while walking and the tile's centre when standing.
   * Facing maths and the camera want this; only the mesh wants the trailing
   * one, and the mesh owns that itself.
   */
  get position(): Vector3 {
    return this.positionComponent.targetPos
  }

  /** The same vector, under the name the movement system writes through. */
  get targetPos(): Vector3 {
    return this.positionComponent.targetPos
  }

  get targetYaw(): number {
    return this.positionComponent.targetYaw
  }
  set targetYaw(value: number) {
    this.positionComponent.targetYaw = value
  }

  get movingPath(): Tile[] {
    return this.stance.movingPath
  }
  get isMoving(): boolean {
    return this.stance.isMoving
  }
  /** Hunkered-down cover stance. Persists across turns until the unit moves or stands. */
  get isCrouching(): boolean {
    return this.stance.isCrouching
  }

  get isDead(): boolean {
    return this.health.hp <= 0
  }

  /**
   * Whether the side whose turn it is can see this unit.
   *
   * Fog of war writes it; the planners and the HUD read it. A mesh's own
   * `visible` flag used to be the only copy, which made every "can I shoot
   * that" question go through the renderer.
   */
  get seen(): boolean {
    return this.sighted.seen
  }
  set seen(value: boolean) {
    this.sighted.seen = value
  }

  /** Re-stamp the loadout from the shared templates. */
  equip(weaponId: WeaponId, ammoId: AmmoId): void {
    this.weaponComponent.equip(weaponId)
    this.ammoComponent.load(ammoId)
  }

  /** Hunker down. A unit mid-stride has not stopped to do it. */
  enterCover(): void {
    if (this.isDead || this.isMoving) return
    this.stance.isCrouching = true
  }

  /** Stand back up out of cover. */
  exitCover(): void {
    if (!this.isCrouching) return
    this.stance.isCrouching = false
  }

  /**
   * Stop where you are, for good.
   *
   * The data half of dying: the route is abandoned so movement cannot carry a
   * corpse onward. What that looks like is the view's business, which plays it
   * from `hp` reaching zero.
   */
  halt(): void {
    this.stance.isMoving = false
    this.stance.movingPath = []
  }

}
