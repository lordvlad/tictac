import type { Vector3 } from 'three'
import type { MeleeId } from '../core/Melee'
import type { Awareness } from '../core/Awareness'
import { clamp } from '../core/math'
import { type MoraleBreak, type Predisposition, predispositionOf, type Temperament } from '../core/Morale'
import { Faction, FATIGUE, MORALE, RULES } from '../config'
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
import { type CharacterSheet, type DerivedStats, UtilityId } from '../core/Characters'
import {
  NO_TRAITS,
  type ResolvedTraits,
  resolveSourcedInto,
  type SourcedTrait,
  TraitSource,
  woundTraits,
} from '../core/Traits'
import { ATTACHMENTS, type AttachmentId } from '../core/Attachments'
import { ITEMS, ItemId } from '../core/Items'
import { ROLES, RoleId } from '../core/Roles'
import type { Grid, Tile } from '../core/Grid'
import type { World } from '../ecs/World'
import {
  ActionPointsComponent,
  CharacterComponent,
  AmmoComponent,
  ArmorComponent,
  GrenadeSpecsComponent,
  HealthComponent,
  IdentityComponent,
  InventoryComponent,
  PositionComponent,
  StanceComponent,
  SightedComponent,
  AwarenessComponent,
  MoraleComponent,
  DeedsComponent,
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
 * turn manager or the debug panel lands in exactly one place, where the state
 * digest and a rewind both read it.
 */
export class Soldier {
  readonly faction: Faction
  readonly squadIndex: number // 0..3
  readonly name: string
  readonly entityId: number
  /** Present only for a kept roster (`[ITEM-042]`); absent for a rolled squad. */
  readonly characterId?: string

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
  private readonly awarenessComponent: AwarenessComponent
  private readonly moraleComponent: MoraleComponent
  private readonly deedsComponent: DeedsComponent
  private readonly positionComponent: PositionComponent

  private readonly character: CharacterComponent
  private readonly traitsComponent: TraitsComponent

  // Scratch for the fold in `refreshTraits`, kept to spare it an allocation per
  // call. Nothing else reads these: every trait-driven number is read back
  // from `traitsComponent`, which is what a rewind and a peer's update restore.
  private readonly resolvedTraits: ResolvedTraits = { ...NO_TRAITS }
  private readonly gearTraits: ResolvedTraits = { ...NO_TRAITS }
  private readonly sourcedTraits: SourcedTrait[] = []

  constructor(
    world: World,
    faction: Faction,
    squadIndex: number,
    name: string,
    initialTile: Tile,
    grid: Grid,
    /**
     * Who this soldier is. Required: a missing sheet is a bug in whatever read
     * the wire or the roster, and rolling a stand-in here would hide it as two
     * peers agreeing on the wrong person.
     */
    sheet: CharacterSheet,
    /**
     * HP to deploy at, clamped to this sheet's derived ceiling. Absent (the
     * default) is full health — every match today, and every match outside a
     * server that keeps rosters. A kept match's referee and both its peers
     * all read this off the same `RecordingHeader.startingHp`, so nobody's
     * digest disagrees about where a wounded unit started.
     */
    startingHp?: number,
    /** Present only for a kept roster (`[ITEM-042]`); absent for a rolled squad. */
    characterId?: string,
    /**
     * Consecutive deployments without rest, as the roster stored it
     * (`[ITEM-039]`). Absent (the default) is zero — every match outside a
     * server that keeps one.
     */
    startingFatigue?: number,
  ) {
    this.faction = faction
    this.squadIndex = squadIndex
    this.name = name
    this.characterId = characterId
    const fatigue = startingFatigue ?? 0

    // Blue team faces North (+Z), Red team faces South (-Z): the same facing as
    // a yaw for the view and as a heading for the rules.
    const initialYaw = faction === Faction.Blue ? 0 : Math.PI
    const initialHeading = faction === Faction.Blue ? 0 : 4

    this.entityId = world.createEntity()
    world.addComponent(this.entityId, new IdentityComponent(faction, squadIndex, name))
    this.character = world.addComponent(this.entityId, new CharacterComponent(sheet, RoleId.Rifleman, fatigue))
    this.positionComponent = world.addComponent(
      this.entityId,
      new PositionComponent({ ...initialTile }, grid.tileToWorld(initialTile), initialYaw, 0, initialHeading),
    )
    // The sheet's own trait bonuses are in these ceilings from the start; gear
    // picked up later lifts them through `refreshTraits`.
    const { derived } = this
    const hp = startingHp === undefined ? derived.maxHp : clamp(startingHp, 1, derived.maxHp)
    this.health = world.addComponent(this.entityId, new HealthComponent(hp, derived.maxHp))
    this.actionPoints = world.addComponent(
      this.entityId,
      new ActionPointsComponent(derived.maxAp, derived.maxAp),
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
    this.awarenessComponent = world.addComponent(this.entityId, new AwarenessComponent())
    // The first back-to-back deployment is free; only the level past it costs
    // starting morale, the same step `refreshTraits` prices in AP.
    const fatigueSteps = Math.max(0, fatigue - 1)
    this.moraleComponent = world.addComponent(
      this.entityId,
      new MoraleComponent(MORALE.max - FATIGUE.moralePerStep * fatigueSteps),
    )
    this.deedsComponent = world.addComponent(this.entityId, new DeedsComponent())
    this.traitsComponent = world.addComponent(this.entityId, new TraitsComponent())
    this.stampGrenades()
    this.refreshTraits()
    // A restore writes components one at a time, and the traits are a fold of
    // several of them: refold once they are all back.
    world.onRestored(this.entityId, () => this.refreshTraits())
  }

  /** What the sheet's attributes work out to; see `CharacterComponent.derived`. */
  private get derived(): DerivedStats {
    return this.character.derived
  }

  /** Who this soldier is, as a peer or a roster stated it. */
  get sheet(): CharacterSheet {
    return this.character.sheet
  }

  /**
   * Consecutive deployments without rest, as stored on the roster this match
   * started (`[ITEM-039]`) — 0 for every match outside a server that keeps one.
   */
  get fatigue(): number {
    return this.character.fatigue
  }

  /**
   * Refold the sheet's traits with whatever is being carried, and publish the
   * result to the {@link TraitsComponent}, the one place anything reads it from.
   *
   * Called on every change to the pouch rather than computed per read: a shot
   * preview runs every frame the panel is open, and the answer only moves when
   * gear does. Also the world's post-restore hook, so a rewound unit's wound
   * bands, ceilings and traits are a fresh fold of its restored state.
   */
  refreshTraits(): void {
    const { sheet, derived, role, fatigue } = this.character
    const sourced = this.sourcedTraits
    sourced.length = 0
    for (const id of sheet.traits) {
      sourced.push({ id, source: TraitSource.Innate })
    }
    for (const id of woundTraits(this.health.hp, this.health.maxHp)) {
      sourced.push({ id, source: TraitSource.Wound })
    }
    const roleTrait = ROLES[role].trait
    if (roleTrait) sourced.push({ id: roleTrait, source: TraitSource.Role })
    for (const id of Object.values(ItemId)) {
      if ((this.items[id] ?? 0) <= 0) continue
      const granted = ITEMS[id].traits
      if (granted) for (const trait of granted) {
        sourced.push({ id: trait, source: TraitSource.Gear })
      }
    }
    // Whatever is bolted to the weapon in its hands, which travels with the
    // weapon rather than with the soldier.
    for (const id of this.weapon.attachments) {
      for (const trait of ATTACHMENTS[id]?.traits ?? []) {
        sourced.push({ id: trait, source: TraitSource.Gear })
      }
    }
    const resolved = resolveSourcedInto(this.resolvedTraits, sourced)
    // Gear's share on its own, because Strength cancels that and not a limp.
    const gear = resolveSourcedInto(this.gearTraits, sourced, TraitSource.Gear)

    // Only the unfavourable share of gear's drag is Strength's to carry: kit
    // that *helps* a unit move is not something being strong should undo.
    const gearMoveRelief = Math.max(0, gear.moveCost) * (derived.gearRelief / 100)
    const gearApRelief = Math.round(-Math.min(0, gear.maxAp) * (derived.gearRelief / 100))

    const traits = this.traitsComponent
    traits.evasion = Math.max(0, derived.evasion + resolved.evasion)
    traits.critImmune = resolved.critImmune
    traits.moveCostMul = 1 + resolved.moveCost - gearMoveRelief
    traits.evasionCrouched = resolved.evasionCrouched
    traits.damageTaken = resolved.damageTaken
    traits.unreadable = resolved.unreadable
    traits.bleedImmune = resolved.bleedImmune
    traits.accuracy = resolved.accuracy
    traits.accuracyCrouched = resolved.accuracyCrouched
    traits.rangeFalloff = resolved.rangeFalloff
    traits.silenced = resolved.silenced
    traits.critChance = resolved.critChance
    traits.critMultiplier = resolved.critMultiplier
    traits.gearDrag = gear.moveCost > 0

    // Trait ceilings sit on top of the sheet's own, and a unit at full health
    // keeps being at full health when the source of the lift changes.
    const maxHp = derived.maxHp + resolved.maxHp
    if (this.health.maxHp !== maxHp) {
      const wasFull = this.health.hp >= this.health.maxHp
      this.health.maxHp = maxHp
      this.health.hp = wasFull ? maxHp : Math.min(this.health.hp, maxHp)
    }
    const maxArmor = RULES.maxArmor + resolved.armor
    if (this.armorComponent.maxArmor !== maxArmor) {
      const wasFull = this.armorComponent.armor >= this.armorComponent.maxArmor
      this.armorComponent.maxArmor = maxArmor
      this.armorComponent.armor = wasFull
        ? maxArmor
        : Math.min(this.armorComponent.armor, maxArmor)
    }

    const fatigueApPenalty = FATIGUE.apPerStep * Math.max(0, fatigue - 1)
    const maxAp = derived.maxAp + resolved.maxAp + gearApRelief - fatigueApPenalty
    if (this.actionPoints.maxAp !== maxAp) {
      const wasFull = this.actionPoints.ap >= this.actionPoints.maxAp
      this.actionPoints.maxAp = maxAp
      this.actionPoints.ap = wasFull ? maxAp : Math.min(this.actionPoints.ap, maxAp)
    }
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

  /** True when carried gear drags on this unit: what Strength learns from. */
  get gearDrag(): boolean {
    return this.traitsComponent.gearDrag
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

  /**
   * Multiplier on the distance this soldier hears anything at; 1 is ordinary.
   * From the sheet, which both sides hold, so both agree about who heard what.
   */
  get hearing(): number {
    return 1 + this.derived.hearing / 100
  }

  /**
   * Accuracy this soldier adds with the weapon in their hands: what the sheet
   * says about that class, plus anything a trait adds to every shot.
   */
  get proficiency(): number {
    const braced = this.isCrouching ? this.traitsComponent.accuracyCrouched : 0
    return this.sheet.proficiency[this.weaponId] + this.traitsComponent.accuracy + braced
  }

  /** Extra fraction on the weapon's range falloff, from carried gear. */
  get rangeFalloff(): number {
    return this.traitsComponent.rangeFalloff
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

  /** True when firing does not give this unit's position away. */
  get silenced(): boolean {
    return this.traitsComponent.silenced
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

  get watching(): boolean {
    return this.stance.watching
  }
  set watching(value: boolean) {
    this.stance.watching = value
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

  /** True when no hit on this unit can start it bleeding. Replicated, as above. */
  get bleedImmune(): boolean {
    return this.traitsComponent.bleedImmune
  }

  /**
   * What every step costs this unit, as a multiple of the terrain's own price.
   *
   * One when whole and standing. A wound adds to it, so the same route across
   * the same ground costs a limping soldier more, and crouching multiplies it:
   * a crouched unit moves crouched.
   */
  get moveCostMul(): number {
    return this.traitsComponent.moveCostMul * (this.isCrouching ? RULES.crouchStepCost : 1)
  }

  /** Percentage points this soldier's traits add to its own crit chance. */
  get critChanceBonus(): number {
    return this.traitsComponent.critChance
  }

  /** What its traits add to the multiplier its own crits apply. */
  get critMultiplierBonus(): number {
    return this.traitsComponent.critMultiplier
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
  /** What is in the sidearm slot; fists when it is empty. */
  get sidearm(): MeleeId {
    return this.inventory.sidearm
  }
  set sidearm(value: MeleeId) {
    this.inventory.sidearm = value
  }
  /** What this soldier trained for; refolds traits, since a role can grant one. */
  get role(): RoleId {
    return this.character.role
  }
  set role(value: RoleId) {
    if (this.character.role === value) return
    this.character.role = value
    this.refreshTraits()
  }
  get meleeSkill(): number {
    return this.derived.meleeSkill
  }
  get meleePower(): number {
    return this.derived.meleePower
  }
  /** Percent chance a shoulder to a locked door gives. */
  get shoulder(): number {
    return this.derived.shoulder
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

  /** Which way the unit faces for the rules: an index into `HEADINGS`. */
  get heading(): number {
    return this.positionComponent.heading
  }
  set heading(value: number) {
    this.positionComponent.heading = value
  }

  get movingPath(): Tile[] {
    return this.stance.movingPath
  }
  get isMoving(): boolean {
    return this.stance.isMoving
  }
  /** Crouched: in cover when still, moving low when not. Persists across turns until the unit stands. */
  get isCrouching(): boolean {
    return this.stance.isCrouching
  }

  get isDead(): boolean {
    return this.health.hp <= 0
  }

  /** Got off the field alive by retreating: out of the fight, not dead. */
  get withdrawn(): boolean {
    return this.health.withdrawn
  }
  set withdrawn(value: boolean) {
    this.health.withdrawn = value
  }

  /** Still in the fight: neither dead nor withdrawn. What ends a match is a side with nobody on the field. */
  get onField(): boolean {
    return !this.isDead && !this.health.withdrawn
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

  /** What it knows is going on around it (`core/Awareness`). */
  get awareness(): Awareness {
    return this.awarenessComponent.state
  }
  set awareness(value: Awareness) {
    this.awarenessComponent.state = value
  }

  get quietTurns(): number {
    return this.awarenessComponent.quietTurns
  }
  set quietTurns(value: number) {
    this.awarenessComponent.quietTurns = value
  }

  /** What it has done this match that it can learn from (`core/Progression`). */
  get deeds(): DeedsComponent {
    return this.deedsComponent
  }

  /** Nerve left (`core/Morale`). */
  get morale(): number {
    return this.moraleComponent.morale
  }
  set morale(value: number) {
    this.moraleComponent.morale = value
  }

  /** The break it is in, or null while it holds. */
  get broken(): MoraleBreak | null {
    return this.moraleComponent.broken
  }
  set broken(value: MoraleBreak | null) {
    this.moraleComponent.broken = value
  }

  get brokenTurns(): number {
    return this.moraleComponent.brokenTurns
  }
  set brokenTurns(value: number) {
    this.moraleComponent.brokenTurns = value
  }

  /** Which way it goes when a break is more than a freeze: the sheet's. */
  get temperament(): Temperament {
    return this.sheet.temperament
  }

  /** Its predisposition, off the sheet's traits. */
  get predisposition(): Predisposition | null {
    return predispositionOf(this.sheet.traits)
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

  /** Get low. A unit mid-stride has not stopped to do it. */
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
