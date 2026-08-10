import Entity3D from '@mavonengine/core/World/Entity3D'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three'
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
      // character.glb is authored at 1.8 m tall in default scale (1,1,1).
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

    // 4. Play idle animation
    const idleAction = this.animationsMap.get('idle')
    if (idleAction) {
      idleAction.play()
    }
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

  updateMovement(delta: number, grid: Grid, onStep?: (tile: Tile) => void): boolean {
    if (!this.isMoving || this.movePathIndex >= this.movingPath.length) {
      if (this.isMoving) {
        this.isMoving = false
        const idleAction = this.animationsMap.get('idle')
        if (idleAction) {
          this.fadeToAction(idleAction, 0.15)
        }
      }
      return false
    }

    const nextTile = this.movingPath[this.movePathIndex]!
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

      const prevTile = this.movingPath[this.movePathIndex - 1]!
      const isDiagonal = prevTile.x !== nextTile.x && prevTile.y !== nextTile.y
      const apCost = isDiagonal ? STEP_DIAGONAL : STEP_ORTHOGONAL

      this.tile = { ...nextTile }
      this.ap = Math.max(0, this.ap - apCost)

      onStep?.(nextTile)

      this.movePathIndex++
      if (this.movePathIndex >= this.movingPath.length) {
        this.isMoving = false
        const idleAction = this.animationsMap.get('idle')
        if (idleAction) {
          this.fadeToAction(idleAction, 0.15)
        }
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
