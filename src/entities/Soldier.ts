import Entity3D from '@mavonengine/core/World/Entity3D'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { LoopOnce, LoopRepeat, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import type { EngineContext } from '../engine'
import { Faction, RULES, SOLDIER_HEIGHT } from '../config'
import {
  AMMO,
  type AmmoSpec,
  AmmoId,
  GRENADES,
  type GrenadeSpec,
  GrenadeId,
  WEAPONS,
  Weapon,
  WeaponId,
} from '../core/Arsenal'
import type { StatusState } from '../core/Ballistics'
import type { Grid, Tile } from '../core/Grid'
import { soldierColor } from './palette'

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

export class Soldier extends Entity3D {
  readonly faction: Faction
  readonly squadIndex: number // 0..3
  readonly name: string

  hp = RULES.maxHp
  maxHp = RULES.maxHp
  ap = RULES.maxAp
  maxAp = RULES.maxAp
  /** Armour points. Subtracts flat damage; stripped by shred effects. */
  armor = RULES.maxArmor
  maxArmor = RULES.maxArmor

  // --- loadout ---------------------------------------------------------------
  /**
   * Own copies of the specs, not references into the shared tables: stats are
   * per character, so tuning one unit's rifle must not re-arm the whole map.
   * The tables in {@link Arsenal} are the templates these are stamped from.
   */
  weaponId: WeaponId = WeaponId.Rifle
  weapon: Weapon = WEAPONS[WeaponId.Rifle].clone()
  ammoId: AmmoId = AmmoId.Standard
  ammo: AmmoSpec = { ...AMMO[AmmoId.Standard] }
  /** Per-unit grenade specs, so throw range and blast are tunable per soldier. */
  grenadeSpecs: Record<GrenadeId, GrenadeSpec> = {
    [GrenadeId.Frag]: { ...GRENADES[GrenadeId.Frag] },
    [GrenadeId.Flash]: { ...GRENADES[GrenadeId.Flash] },
    [GrenadeId.Smoke]: { ...GRENADES[GrenadeId.Smoke] },
  }
  /** Grenades still in the pouch, by kind. */
  readonly grenades: Record<GrenadeId, number> = {
    [GrenadeId.Frag]: 1,
    [GrenadeId.Flash]: 1,
    [GrenadeId.Smoke]: 1,
  }

  /**
   * Corner peeking. A unit that peeks also sees from the free tiles beside the
   * wall it is standing against, so its view reaches around the corner instead
   * of stopping at it.
   */
  peek = false

  /** Live status effects (flashed, smoked, shredded). */
  statuses: StatusState[] = []

  /** Re-stamp the loadout from the shared templates. */
  equip(weaponId: WeaponId, ammoId: AmmoId): void {
    this.weaponId = weaponId
    this.weapon = WEAPONS[weaponId].clone()
    this.ammoId = ammoId
    this.ammo = { ...AMMO[ammoId] }
  }

  tile: Tile

  /** Logical target position in world space. */
  readonly targetPos = new Vector3()
  targetYaw = 0
  currentYaw = 0

  // Movement execution
  movingPath: Tile[] = []
  movePathIndex = 0
  isMoving = false

  /** Hunkered-down cover stance. Persists across turns until the unit moves or stands. */
  isCrouching = false

  constructor(
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
    this.tile = { ...initialTile }

    grid.tileToWorld(initialTile, this.position)
    this.targetPos.copy(this.position)

    // Blue team faces North (+Z), Red team faces South (-Z)
    this.targetYaw = faction === Faction.Blue ? 0 : Math.PI
    this.currentYaw = this.targetYaw
    this.rotation.y = this.currentYaw

    this.initGraphics()
  }

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
      if (this.isMoving) this.playLocomotion('run')
      else if (this.isCrouching) this.playLoop('crouch')
      else this.playLoop('idle')
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
    this.isCrouching = true
    this.playLoop('crouch')
  }

  /** Stand back up out of cover. */
  exitCover(): void {
    if (!this.isCrouching) return
    this.isCrouching = false
    if (!this.isDead && !this.isMoving) this.playLoop('idle')
  }

  /**
   * Collapse and stay down. Halts movement without the idle fade that
   * stopMovement() would apply, so the death clip is not immediately replaced.
   */
  playDeath(): void {
    this.isMoving = false
    this.movingPath = []
    this.movePathIndex = 0
    this.playOnce('death')
  }

  get isDead(): boolean {
    return this.hp <= 0
  }

  startMovement(path: Tile[]): void {
    if (path.length <= 1) return
    this.movingPath = path
    this.movePathIndex = 1
    // Moving breaks cover — stand up to run.
    this.isCrouching = false
    this.isMoving = true

    this.playLocomotion('run')
  }

  /** Halt on the current tile and fall back to the idle clip. */
  stopMovement(): void {
    if (!this.isMoving) return
    this.isMoving = false
    this.movingPath = []
    this.movePathIndex = 0
    const idleAction = this.animationsMap.get('idle')
    if (idleAction) this.fadeToAction(idleAction, 0.15)
  }

  updateMovement(delta: number, grid: Grid, onStep?: (tile: Tile) => void): boolean {
    if (!this.isMoving || this.movePathIndex >= this.movingPath.length) {
      this.stopMovement()
      return false
    }

    // Distance budget for this tick. Leftover carries across tile boundaries,
    // otherwise the remainder is discarded on every arrival and the unit
    // travels measurably slower than MOVE_SPEED.
    let budget = RULES.moveSpeed * delta

    while (budget > 0) {
      if (this.movePathIndex >= this.movingPath.length) {
        this.stopMovement()
        return false
      }

      const nextTile = this.movingPath[this.movePathIndex]!

      // Safety net: never enter a tile the unit cannot pay for. Movement always
      // halts on a tile boundary, so stopping here leaves a valid grid position.
      const prev = this.movingPath[this.movePathIndex - 1]!
      const stepCost =
        prev.x !== nextTile.x && prev.y !== nextTile.y ? RULES.stepDiagonal : RULES.stepOrthogonal
      if (this.ap < stepCost) {
        this.stopMovement()
        return false
      }

      const targetWorld = grid.tileToWorld(nextTile)

      // Measured against targetPos (the logical position), not position, which
      // renderUpdate lags behind by design for smoothing. Testing arrival
      // against the lagging value made every tile cost an extra ~50 ms.
      const dx = targetWorld.x - this.targetPos.x
      const dz = targetWorld.z - this.targetPos.z
      const dist = Math.hypot(dx, dz)

      if (dist > 0.001) {
        this.targetYaw = Math.atan2(dx, dz)
      }

      if (dist > budget) {
        this.targetPos.x += (dx / dist) * budget
        this.targetPos.z += (dz / dist) * budget
        break
      }

      // Arrived. Only the logical position snaps; the mesh keeps lerping.
      this.targetPos.copy(targetWorld)
      budget -= dist

      this.tile = { ...nextTile }
      this.ap = Math.max(0, this.ap - stepCost)

      onStep?.(nextTile)

      this.movePathIndex++
      if (this.movePathIndex >= this.movingPath.length) {
        this.stopMovement()
        return false
      }
    }

    return true
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
