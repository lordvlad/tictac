import type { Vector3 } from 'three'
import { Faction, RULES } from '../config'
import {
  type AmmoSpec,
  AmmoId,
  GRENADES,
  type GrenadeSpec,
  GrenadeId,
  Weapon,
  WeaponId,
  weaponSerial,
} from '../core/Arsenal'
import { effectiveMaxAp, type StatusState } from '../core/Ballistics'
import {
  characterSheet,
  type CharacterSheet,
  derive,
  type DerivedStats,
  UtilityId,
} from '../core/Characters'
import { Rng } from '../core/rng'
import {
  NO_TRAITS,
  type ResolvedTraits,
  resolveSourcedInto,
  type SourcedTrait,
  TraitSource,
  type TraitId,
  woundTraits,
} from '../core/Traits'
import { ATTACHMENTS, type AttachmentId } from '../core/Attachments'
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

  /**
   * What the sheet's attributes work out to.
   *
   * Recomputed only when the sheet itself changes - on construction and when a
   * peer's real sheet arrives - because it is a pure function of four numbers
   * that do not move during a match. Trait bonuses are *not* in here: they
   * land on top of these, and they change whenever the pouch does.
   */
  private derived: DerivedStats

  /** Sheet plus carried gear, refolded whenever either could have changed. */
  private readonly resolvedTraits: ResolvedTraits = { ...NO_TRAITS }
  /** The same fold over gear alone, for the rules that must tell it apart. */
  private readonly gearTraits: ResolvedTraits = { ...NO_TRAITS }
  private readonly sourcedTraits: SourcedTrait[] = []
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
    this.derived = derive(sheet)

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
    this.health = world.addComponent(
      this.entityId,
      new HealthComponent(this.derived.maxHp, this.derived.maxHp),
    )
    this.actionPoints = world.addComponent(
      this.entityId,
      new ActionPointsComponent(this.derived.maxAp, this.derived.maxAp),
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
    this.stampGrenades()
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
    this.sourcedTraits.length = 0
    for (const id of this.sheet.traits) {
      this.sourcedTraits.push({ id, source: TraitSource.Innate })
    }
    for (const id of woundTraits(this.health.hp, this.health.maxHp)) {
      this.sourcedTraits.push({ id, source: TraitSource.Wound })
    }
    for (const id of Object.values(ItemId)) {
      if ((this.items[id] ?? 0) <= 0) continue
      const granted = ITEMS[id].traits
      if (granted) for (const trait of granted) {
        this.sourcedTraits.push({ id: trait, source: TraitSource.Gear })
      }
    }
    // Whatever is bolted to the weapon in its hands, which travels with the
    // weapon rather than with the soldier.
    for (const id of this.weapon.attachments) {
      for (const trait of ATTACHMENTS[id]?.traits ?? []) {
        this.sourcedTraits.push({ id: trait, source: TraitSource.Gear })
      }
    }
    resolveSourcedInto(this.resolvedTraits, this.sourcedTraits)
    // Gear's share on its own, because Strength cancels that and not a limp.
    resolveSourcedInto(this.gearTraits, this.sourcedTraits, TraitSource.Gear)

    const evasion = Math.max(0, this.derived.evasion + this.resolvedTraits.evasion)
    if (this.traitsComponent.evasion !== evasion) this.traitsComponent.evasion = evasion
    if (this.traitsComponent.critImmune !== this.resolvedTraits.critImmune) {
      this.traitsComponent.critImmune = this.resolvedTraits.critImmune
    }
    const moveCostMul = 1 + this.resolvedTraits.moveCost - this.gearMoveRelief
    if (this.traitsComponent.moveCostMul !== moveCostMul) {
      this.traitsComponent.moveCostMul = moveCostMul
    }
    if (this.traitsComponent.evasionCrouched !== this.resolvedTraits.evasionCrouched) {
      this.traitsComponent.evasionCrouched = this.resolvedTraits.evasionCrouched
    }
    if (this.traitsComponent.damageTaken !== this.resolvedTraits.damageTaken) {
      this.traitsComponent.damageTaken = this.resolvedTraits.damageTaken
    }
    if (this.traitsComponent.unreadable !== this.resolvedTraits.unreadable) {
      this.traitsComponent.unreadable = this.resolvedTraits.unreadable
    }

    // Trait ceilings sit on top of the sheet's own, and a unit at full health
    // keeps being at full health when the source of the lift changes.
    const maxHp = this.derived.maxHp + this.resolvedTraits.maxHp
    if (this.health.maxHp !== maxHp) {
      const wasFull = this.health.hp >= this.health.maxHp
      this.health.maxHp = maxHp
      this.health.hp = wasFull ? maxHp : Math.min(this.health.hp, maxHp)
    }
    const maxArmor = RULES.maxArmor + this.resolvedTraits.armor
    if (this.armorComponent.maxArmor !== maxArmor) {
      const wasFull = this.armorComponent.armor >= this.armorComponent.maxArmor
      this.armorComponent.maxArmor = maxArmor
      this.armorComponent.armor = wasFull
        ? maxArmor
        : Math.min(this.armorComponent.armor, maxArmor)
    }

    const maxAp = this.derived.maxAp + this.resolvedTraits.maxAp + this.gearApRelief
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
    this.derived = derive(sheet)
    this.stampGrenades()
    this.refreshTraits()
    this.health.hp = this.health.maxHp
    this.actionPoints.ap = this.actionPoints.maxAp
  }

  /**
   * Write this character's reach and training onto their own grenades.
   *
   * Stamped into the per-unit specs rather than added at the throw site, so
   * the one number every consumer already reads - the planner's preview, the
   * range check in `throwGrenade`, the debug panel - is the number this
   * soldier can actually reach. It replicates with the component, so a peer
   * sees the arm it is up against rather than its own stock copy.
   *
   * Floored at a tile: the weakest character can still throw, badly.
   */
  private stampGrenades(): void {
    const demolitions = 1 + (this.sheet.utility[UtilityId.Demolitions] ?? 0) / 100
    for (const kind of Object.values(GrenadeId)) {
      const base = GRENADES[kind]
      const spec = this.grenadeSpecsComponent.specs[kind]
      spec.throwRange = Math.max(1, base.throwRange + this.derived.throwRange)
      // Demolitions is training, so it shapes the charge rather than the arm.
      // A radius is tiles on a grid: rounded, and never below the tile the
      // grenade landed on, or a trained thrower could produce a dud.
      spec.areaRadius = Math.max(1, Math.round(base.areaRadius * demolitions))
      spec.armorShred = Math.max(0, Math.round(base.armorShred * demolitions))
    }
  }

  /**
   * How much of gear's drag this soldier's shoulders take.
   *
   * Only the unfavourable share: kit that *helps* a unit move is not something
   * being strong should undo, so a negative gear `moveCost` is left alone.
   */
  private get gearMoveRelief(): number {
    return Math.max(0, this.gearTraits.moveCost) * (this.derived.gearRelief / 100)
  }

  /** The same allowance spent on the action points heavy kit costs. */
  private get gearApRelief(): number {
    return Math.round(-Math.min(0, this.gearTraits.maxAp) * (this.derived.gearRelief / 100))
  }

  /** What gear alone is doing to this unit, before Strength argues with it. */
  get gearOnlyTraits(): ResolvedTraits {
    return this.gearTraits
  }

  /** Percent each utility discipline adds to what it governs. */
  get utility(): Record<UtilityId, number> {
    return this.sheet.utility
  }

  /** Consumables this character can carry into a match. */
  get carrySlots(): number {
    return this.derived.carrySlots
  }

  /** Action points on top of an item's own price, from Intelligence. */
  get itemApDelta(): number {
    return this.derived.itemApDelta
  }

  /** Percent on top of HP an item restores to this unit, from Health. */
  get healBonus(): number {
    return this.derived.healBonus
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
    const braced = this.isCrouching ? this.resolvedTraits.accuracyCrouched : 0
    return this.sheet.proficiency[this.weaponId] + this.resolvedTraits.accuracy + braced
  }

  /** Extra fraction on the weapon's range falloff, from carried gear. */
  get rangeFalloff(): number {
    return this.resolvedTraits.rangeFalloff
  }

  /**
   * Fraction added to the damage this unit takes. Negative is plate helping.
   *
   * Replicated, like evasion: the peer shooting at this unit resolves the
   * damage, so it has to be able to see the plate.
   */
  get damageTaken(): number {
    return this.traitsComponent.damageTaken
  }

  /**
   * True when firing does not give this unit's position away.
   *
   * Read from the local fold, not the component: it governs what *this* unit's
   * own shot does, and a shot is always resolved by the side that owns it.
   */
  get silenced(): boolean {
    return this.resolvedTraits.silenced
  }

  /**
   * True when being shot at tells the shooter nothing about this unit.
   *
   * Replicated, unlike `silenced`: the side pulling the trigger is the one
   * deciding what it learned, and this is a property of its target.
   */
  get unreadable(): boolean {
    return this.traitsComponent.unreadable
  }

  /**
   * Whether this unit has fired since the last handover.
   *
   * On the stance rather than in a component of its own: it is a fact about
   * what the unit is doing this turn, it is cleared at the handover, and it is
   * read by fog, which already reads stance.
   */
  get firedThisTurn(): boolean {
    return this.stance.firedThisTurn
  }
  set firedThisTurn(value: boolean) {
    this.stance.firedThisTurn = value
  }

  /**
   * Percentage points off an attacker's hit chance.
   *
   * Read from the replicated component, not recomputed: for an enemy unit this
   * is the only copy this side is allowed to trust.
   */
  get evasion(): number {
    // Both halves come from the replicated component, not from the local fold:
    // for an enemy unit the fold is over this side's *stock* copy of their kit,
    // so reading it would quietly ignore a bipod they are actually braced on.
    const crouched = this.isCrouching ? this.traitsComponent.evasionCrouched : 0
    return this.traitsComponent.evasion + crouched
  }

  /** True when no hit on this unit can be a critical. Replicated, as above. */
  get critImmune(): boolean {
    return this.traitsComponent.critImmune
  }

  /**
   * What every step costs this unit, as a multiple of the terrain's own price.
   *
   * One when whole. A wound adds to it, so the same route across the same
   * ground costs a limping soldier more.
   */
  get moveCostMul(): number {
    return this.traitsComponent.moveCostMul
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
    // Wounds are a function of condition, so crossing a threshold has to refold
    // the traits. Checked against the bands rather than on every point of
    // damage: the fold is cheap but it is not free, and nothing changes in
    // between.
    const before = woundTraits(this.health.hp, this.health.maxHp).length
    this.health.hp = value
    if (woundTraits(value, this.health.maxHp).length !== before) this.refreshTraits()
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

  /**
   * Whether the other side has worked this unit out.
   *
   * Sticky for the match: once an opponent has been shot at by a unit, or has
   * hit it, they know what they are dealing with and do not forget.
   */
  get known(): boolean {
    return this.sighted.known
  }
  set known(value: boolean) {
    this.sighted.known = value
  }

  /** Re-stamp the loadout from the shared templates. */
  equip(weaponId: WeaponId, ammoId: AmmoId): void {
    // Numbered after its carrier, so both peers reach the same serial for the
    // same gun without it having to travel: `Blue 2's rifle` is the same weapon
    // on either side of the wire, and re-equipping changes the number because
    // it is a different weapon.
    this.weaponComponent.equip(weaponId, weaponSerial(this.faction, this.squadIndex, weaponId))
    this.ammoComponent.load(ammoId)
    // A different weapon is a different rail: what was fitted to the last one
    // is not in force any more.
    this.refreshTraits()
  }

  /**
   * Bolt an attachment onto the weapon in this soldier's hands.
   *
   * Returns false when the rail is full or one is already fitted. The trait
   * fold follows immediately, so the effect is in force from the moment it
   * goes on.
   */
  fitAttachment(id: AttachmentId): boolean {
    if (!this.weapon.fit(id)) return false
    this.refreshTraits()
    return true
  }

  /** Take one off again, and stop its effect. */
  unfitAttachment(id: AttachmentId): boolean {
    if (!this.weapon.unfit(id)) return false
    this.refreshTraits()
    return true
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
