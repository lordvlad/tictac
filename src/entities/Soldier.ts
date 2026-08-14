import Entity3D from '@mavonengine/core/World/Entity3D'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { LoopOnce, LoopRepeat, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import Game from '@mavonengine/core/Game'
import { Faction, FACTION_INFO, MAX_AP, MAX_HP, MOVE_SPEED, SOLDIER_HEIGHT, STEP_DIAGONAL, STEP_ORTHOGONAL } from '../config'
import type { Grid, Tile } from '../core/Grid'

export class Soldier extends Entity3D {
  readonly faction: Faction
  readonly squadIndex: number // 0..3
  readonly name: string

  hp = MAX_HP
  ap = MAX_AP
  tile: Tile

  /** Logical target position in world space. */
  readonly targetPos = new Vector3()
  targetYaw = 0
  currentYaw = 0

  // Movement execution
  movingPath: Tile[] = []
  movePathIndex = 0
  isMoving = false

  constructor(
    faction: Faction,
    squadIndex: number,
    name: string,
    initialTile: Tile,
    grid: Grid,
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
    const gltf = Game.instance().resources.items['character'] as GLTF | undefined
    if (!gltf) return

    // Entity3D.initModel clones gltf.scene via SkeletonUtils.clone
    this.initModel(gltf)

    if (this.instance) {
      // character.glb is authored at 1.829 m tall in default scale (1,1,1).
      // Note: Entity3D.initModel inflates geometry.boundingBox by 400x for
      // frustum culling, so Box3.setFromObject must not be used for height.
      this.instance.scale.set(1, 1, 1)

      // Tint material according to faction
      const info = FACTION_INFO[this.faction]
      this.instance.traverse((child) => {
        if (child instanceof Mesh && child.material) {
          const mat = (child.material as MeshStandardMaterial).clone()
          mat.color.setHex(info.color)
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
      this.playLoop(this.isMoving ? 'walk' : 'idle')
    })
  }

  /** Play a looping clip, restoring the loop mode a one-shot may have changed. */
  private playLoop(key: string): void {
    const action = this.animationsMap.get(key)
    if (!action) return
    action.setLoop(LoopRepeat, Infinity)
    action.clampWhenFinished = false
    this.fadeToAction(action, 0.15)
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
    this.isMoving = true

    const walkAction = this.animationsMap.get('walk')
    if (walkAction) {
      this.fadeToAction(walkAction, 0.15)
    }
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

    const nextTile = this.movingPath[this.movePathIndex]!

    // Safety net: never enter a tile the unit cannot pay for. Movement always
    // halts on a tile boundary, so stopping here leaves a valid grid position.
    const prev = this.movingPath[this.movePathIndex - 1]!
    const stepCost =
      prev.x !== nextTile.x && prev.y !== nextTile.y ? STEP_DIAGONAL : STEP_ORTHOGONAL
    if (this.ap < stepCost) {
      this.stopMovement()
      return false
    }

    const targetWorld = grid.tileToWorld(nextTile)

    const dx = targetWorld.x - this.position.x
    const dz = targetWorld.z - this.position.z
    const dist = Math.hypot(dx, dz)

    if (dist > 0.001) {
      this.targetYaw = Math.atan2(dx, dz)
    }

    const stepDist = MOVE_SPEED * delta

    if (dist <= stepDist) {
      this.position.copy(targetWorld)
      this.targetPos.copy(targetWorld)

      this.tile = { ...nextTile }
      this.ap = Math.max(0, this.ap - stepCost)

      onStep?.(nextTile)

      this.movePathIndex++
      if (this.movePathIndex >= this.movingPath.length) {
        this.stopMovement()
        return false
      }
    } else {
      this.targetPos.x += (dx / dist) * stepDist
      this.targetPos.z += (dz / dist) * stepDist
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
