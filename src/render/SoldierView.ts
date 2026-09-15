import Entity3D from '@mavonengine/core/World/Entity3D'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { LoopOnce, LoopRepeat, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import { RULES } from '../config'
import type { EngineContext } from '../engine'
import { soldierColor } from '../entities/palette'
import type { Soldier } from '../entities/Soldier'

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
 * The body of a soldier: its mesh, its skeleton and its animation state.
 *
 * A {@link Soldier} is what the unit *is* — hp, points, stance, gear — and this
 * is what it looks like. They were one class, which meant a squad could not
 * exist without a scene to put it in, and "can I shoot that" was a question
 * about a mesh's `visible` flag.
 *
 * Strictly a reader. Nothing here decides anything: the stance, the death, the
 * facing and the visibility are all already true of the unit by the time this
 * reflects them, which is why a unit driven by a peer's component updates
 * animates exactly like a local one.
 */
export class SoldierView extends Entity3D {
  /** Smoothed for the eye only. The logical facing is `unit.targetYaw`. */
  private currentYaw: number
  private readonly smoothed = new Vector3()

  constructor(
    private readonly engine: EngineContext,
    readonly unit: Soldier,
  ) {
    super()
    this.currentYaw = unit.targetYaw
    this.rotation.y = this.currentYaw
    this.position.copy(unit.position)
    this.smoothed.copy(unit.position)
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
      const tint = soldierColor(this.unit.faction, this.unit.squadIndex)
      this.instance.traverse((child) => {
        if (child instanceof Mesh && child.material) {
          const mat = (child.material as MeshStandardMaterial).clone()
          mat.color.copy(tint)
          child.material = mat
        }
      })

      // Tagged with the unit, not with this view: a click is a question about
      // who was hit, and the answer is a soldier.
      this.instance.userData.type = 'soldier'
      this.instance.userData.soldier = this.unit

      this.instance.position.copy(this.smoothed)
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
      if (this.unit.isDead) return
      this.playStanceClip()
    })
  }

  /** Where the body actually is, which trails where the unit logically is. */
  get renderPosition(): Vector3 {
    return this.smoothed
  }

  /** Which way the body is actually turned, mid-turn included. */
  get facing(): number {
    return this.currentYaw
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
   * Play whichever loop the unit's stance calls for.
   *
   * Driven by {@link RenderSystem} on stance changes, so movement and cover are
   * decided by components and merely reflected here.
   */
  playStanceClip(): void {
    if (this.unit.isDead) return
    if (this.unit.isMoving) this.playLocomotion('run')
    else if (this.unit.isCrouching) this.playLoop('crouch')
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
    if (this.unit.isDead) return
    this.playOnce('shoot')
  }

  /** Flinch on taking non-fatal damage. */
  playHit(): void {
    if (this.unit.isDead) return
    this.playOnce('hit')
  }

  /** Collapse and hold the final frame. */
  playDeath(): void {
    this.playOnce('death')
  }

  /**
   * Called every frame to ease the body toward where the unit now is, and to
   * mirror whether the unit can be seen.
   */
  renderUpdate(delta: number): void {
    const k = 1 - Math.exp(-20 * delta)
    this.smoothed.lerp(this.unit.position, k)
    this.position.copy(this.smoothed)

    let diff = this.unit.targetYaw - this.currentYaw
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    this.currentYaw += diff * k

    if (!this.instance) return
    this.instance.position.copy(this.smoothed)
    this.instance.rotation.y = this.currentYaw
    // Corpses stay drawn so the death clip's last frame reads as a body, and
    // enemy corpses are still subject to fog: `seen` already says both.
    this.instance.visible = this.unit.seen
  }
}
