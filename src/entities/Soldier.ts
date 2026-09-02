import Entity3D from '@mavonengine/core/World/Entity3D'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { LoopOnce, LoopRepeat, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import type { EngineContext } from '../engine'
import { Faction, RULES } from '../config'
import {
  type AmmoSpec,
  AmmoId,
  type GrenadeSpec,
  GrenadeId,
  Weapon,
  WeaponId,
} from '../core/Arsenal'
import type { StatusState } from '../core/Ballistics'
import type { Grid, Tile } from '../core/Grid'
import { soldierColor } from './palette'
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
  StatusesComponent,
  WeaponComponent,
} from '../ecs/components'

/**
 * Ground speed in m/s that each locomotion clip is authored at, measured from
 * the root-motion variant of the source pack (UAL1_Standard_RM.glb) by taking
 * the `root` node's total translation over the clip duration.
 *
 * The shipped clips are in-place, so playback rate is scaled by
 * MOVE_SPEED / <clip speed> to keep the stride matched to actual travel.
 */
const CLIP_GROUND_SPEED = {
  walk: 0.97,
  run: 5.36,
  crouchWalk: 0.75,
} as const

/**
 * A soldier on the field: its 3D asset, its animation state, and typed access
 * to the components that hold its gameplay state.
 *
 * Nothing here stores game state of its own. Every property below reads and
 * writes the entity's components, so a mutation from combat resolution, the
 * turn manager or the debug panel lands in exactly one place and is picked up
 * by {@link World.syncDirty} without the writer having to announce it.
 */
export class Soldier extends Entity3D {
  readonly faction: Faction
  readonly squadIndex: number // 0..3
  readonly name: string
  readonly entityId: number

  private readonly health: HealthComponent
  private readonly actionPoints: ActionPointsComponent
  private readonly armorComponent: ArmorComponent
  private readonly weaponComponent: WeaponComponent
  private readonly ammoComponent: AmmoComponent
  private readonly grenadeSpecsComponent: GrenadeSpecsComponent
  private readonly inventory: InventoryComponent
  private readonly stance: StanceComponent
  private readonly statusesComponent: StatusesComponent
  private readonly positionComponent: PositionComponent

  /** Render-only yaw smoothing. Never networked: the peer smooths its own. */
  currentYaw = 0

  constructor(
    world: World,
    faction: Faction,
    squadIndex: number,
    name: string,
    initialTile: Tile,
    grid: Grid,
    private readonly engine: EngineContext,
  ) {
    super()
    this.faction = faction
    this.squadIndex = squadIndex
    this.name = name

    grid.tileToWorld(initialTile, this.position)
    // Blue team faces North (+Z), Red team faces South (-Z)
    const initialYaw = faction === Faction.Blue ? 0 : Math.PI
    this.currentYaw = initialYaw
    this.rotation.y = initialYaw

    this.entityId = world.createEntity()
    world.addComponent(this.entityId, new IdentityComponent(faction, squadIndex, name))
    this.positionComponent = world.addComponent(
      this.entityId,
      new PositionComponent({ ...initialTile }, this.position.clone(), initialYaw),
    )
    this.health = world.addComponent(this.entityId, new HealthComponent(RULES.maxHp, RULES.maxHp))
    this.actionPoints = world.addComponent(
      this.entityId,
      new ActionPointsComponent(RULES.maxAp, RULES.maxAp),
    )
    this.armorComponent = world.addComponent(
      this.entityId,
      new ArmorComponent(RULES.maxArmor, RULES.maxArmor),
    )
    this.weaponComponent = world.addComponent(this.entityId, new WeaponComponent())
    this.ammoComponent = world.addComponent(this.entityId, new AmmoComponent())
    this.grenadeSpecsComponent = world.addComponent(this.entityId, new GrenadeSpecsComponent())
    this.inventory = world.addComponent(this.entityId, new InventoryComponent())
    this.stance = world.addComponent(this.entityId, new StanceComponent())
    this.statusesComponent = world.addComponent(this.entityId, new StatusesComponent())

    this.initGraphics()
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
    this.actionPoints.ap = value
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

  /** Logical target position in world space. */
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

  /** Re-stamp the loadout from the shared templates. */
  equip(weaponId: WeaponId, ammoId: AmmoId): void {
    this.weaponComponent.equip(weaponId)
    this.ammoComponent.load(ammoId)
  }

  // --- graphics --------------------------------------------------------------

  private initGraphics(): void {
    const gltf = this.engine.assets['character'] as GLTF | undefined
    if (!gltf) return

    // Entity3D.initModel clones gltf.scene via SkeletonUtils.clone
    this.initModel(gltf)

    if (this.instance) {
      // character.glb is authored at 1.829 m tall in default scale (1,1,1).
      // Note: Entity3D.initModel inflates geometry.boundingBox by 400x for
      // frustum culling, so Box3.setFromObject must not be used for height.
      this.instance.scale.set(1, 1, 1)

      // Tint per soldier, not per faction: squadmates get neighbouring hues so
      // they can be told apart on the field and in their portraits.
      const tint = soldierColor(this.faction, this.squadIndex)
      this.instance.traverse((child) => {
        if (child instanceof Mesh && child.material) {
          const mat = (child.material as MeshStandardMaterial).clone()
          mat.color.copy(tint)
          child.material = mat
        }
      })

      // Tag mesh for picking
      this.instance.userData.type = 'soldier'
      this.instance.userData.soldier = this

      // Set initial transform
      this.instance.position.copy(this.position)
      this.instance.rotation.y = this.currentYaw
    }

    // 4. Play idle animation.
    // Must go through fadeToAction so that activeAction is set. Calling
    // action.play() directly leaves activeAction undefined, and fadeToAction
    // only fades out `previousAction = activeAction` -- so idle would keep
    // running at full weight and blend into every later clip.
    this.playLoop('idle')

    // One-shot clips (shoot / hit) hand control back to the appropriate loop.
    // The death clip is excluded so the corpse holds its final frame.
    this.animationMixer?.addEventListener('finished', () => {
      if (this.isDead) return
      this.playStanceClip()
    })
  }

  /** Play a looping clip, restoring the loop mode a one-shot may have changed. */
  private playLoop(key: string, timeScale = 1): void {
    const action = this.animationsMap.get(key)
    if (!action) return
    action.setLoop(LoopRepeat, Infinity)
    action.clampWhenFinished = false
    this.fadeToAction(action, 0.15)
    // fadeToAction() calls setEffectiveTimeScale(1), so any rate adjustment
    // has to be applied after it, not before.
    action.setEffectiveTimeScale(timeScale)
  }

  /** Locomotion clip synced so its stride matches MOVE_SPEED (no foot sliding). */
  private playLocomotion(key: 'walk' | 'run' | 'crouchWalk'): void {
    this.playLoop(key, RULES.moveSpeed / CLIP_GROUND_SPEED[key])
  }

  /**
   * Play whichever loop the current stance calls for.
   *
   * Driven by {@link RenderSystem} on stance changes, so movement and cover are
   * decided by components and merely reflected here.
   */
  playStanceClip(): void {
    if (this.isDead) return
    if (this.isMoving) this.playLocomotion('run')
    else if (this.isCrouching) this.playLoop('crouch')
    else this.playLoop('idle')
  }

  /** Play a clip once and hold its final frame. */
  private playOnce(key: string): void {
    const action = this.animationsMap.get(key)
    if (!action) return
    action.setLoop(LoopOnce, 1)
    action.clampWhenFinished = true
    this.fadeToAction(action, 0.1)
  }

  /** Fire pose. Returns to idle/walk via the mixer's 'finished' event. */
  playShoot(): void {
    if (this.isDead) return
    this.playOnce('shoot')
  }

  /** Flinch on taking non-fatal damage. */
  playHit(): void {
    if (this.isDead) return
    this.playOnce('hit')
  }

  /** Hunker down into a crouch cover stance. */
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
   * Collapse and stay down. Halts movement without the idle fade, so the death
   * clip is not immediately replaced.
   */
  playDeath(): void {
    this.stance.isMoving = false
    this.stance.movingPath = []
    this.playOnce('death')
  }

  /**
   * Called every frame in the rAF loop to lerp the graphical mesh smoothly
   * toward its logical simulation target.
   */
  renderUpdate(delta: number): void {
    if (!this.instance) return

    const k = 1 - Math.exp(-20 * delta)
    this.position.lerp(this.targetPos, k)

    let diff = this.targetYaw - this.currentYaw
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    this.currentYaw += diff * k

    this.instance.position.copy(this.position)
    this.instance.rotation.y = this.currentYaw
  }
}
