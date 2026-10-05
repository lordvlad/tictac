import Entity3D from '@mavonengine/core/World/Entity3D'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  AnimationClip,
  AnimationUtils,
  Color,
  type AnimationAction,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three'
import { RULES } from '../config'
import type { EngineContext } from '../engine'
import { applyCharacterProportions } from './Proportions'
import { HeldWeapon } from './WeaponModel'
import type { WeaponId } from '../core/Arsenal'
import type { HitMark } from '../core/Combatant'
import { MeleeId } from '../core/Melee'
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
  run: 5.36,
  crouchWalk: 0.75,
} as const

/**
 * The bones the stance owns. A clip played *over* a stance must not touch
 * them, or a crouching soldier stands up to pull a trigger — which is exactly
 * what firing from cover used to look like, because the standing fire clip was
 * played whole and the crouch was only restored once it had finished.
 */
const STANCE_BONES = /^(root|pelvis|thigh_|calf_|foot_|ball_)/

/** Clips that may be played over a held stance rather than replacing it. */
const OVERLAY_KEYS = [
  'shoot',
  'hit',
  'punch',
  'swing',
  'throw',
  'reload',
  'interact',
  'aim',
] as const

/** Built once per glTF and shared by every body cloned from it. */
const additiveCache = new WeakMap<GLTF, Map<string, AnimationClip>>()

/**
 * Upper-body-only, additive variants of the action clips.
 *
 * The source pack has no crouched fire, no crouched reload and no crouched
 * watch, and authoring one is not an option for a vendored CC0 library. What it
 * does have is a skeleton: dropping every track below the spine leaves a clip
 * that says nothing about the legs, and taking it relative to the first frame
 * of `idle` (`makeClipAdditive`) turns it from a pose into a *difference* —
 * which is added to whatever stance is underneath rather than averaged with it.
 *
 * Exported for `tests/animation.test.ts`, which is where the invariant this
 * whole mechanism exists for is asserted: an overlay moves no leg.
 */
export function additiveClips(gltf: GLTF): Map<string, AnimationClip> {
  const cached = additiveCache.get(gltf)
  if (cached) return cached

  const built = new Map<string, AnimationClip>()
  const reference = gltf.animations.find((clip) => clip.name === 'idle')
  if (reference) {
    for (const key of OVERLAY_KEYS) {
      const source = gltf.animations.find((clip) => clip.name === key)
      if (!source) continue
      // Cloned: makeClipAdditive rewrites the values in place, and these tracks
      // are the ones the full-body action still plays.
      const tracks = source.tracks
        .filter((track) => !STANCE_BONES.test(track.name))
        .map((track) => track.clone())
      if (tracks.length === 0) continue
      const masked = new AnimationClip(`${key}:additive`, source.duration, tracks)
      built.set(key, AnimationUtils.makeClipAdditive(masked, 0, reference))
    }
  }

  additiveCache.set(gltf, built)
  return built
}

/** How long an overlay takes to blend in and back out again. */
const OVERLAY_FADE = 0.12

/** How long a unit stays down after a round goes past it, in seconds. */
const DUCK_TIME = 0.55

/** How long a wound's tint takes to fade, and what colour each kind leaves. */
const FLASH_TIME = 0.3
const FLASH_COLOR: Record<Exclude<HitMark, 'plain'>, number> = { crit: 0xff1a1a, shred: 0x8a9099 }

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
  /** Additive upper-body actions, keyed as their source clip. */
  private readonly overlays = new Map<string, AnimationAction>()
  /** The one overlay currently on top of the stance, if any. */
  private overlay?: AnimationAction
  /** The weapon model in the right hand, and which weapon it shows. */
  private weaponModel?: HeldWeapon
  private weaponShown?: WeaponId
  /** This body's own materials, so a tint reaches nobody else's. */
  private readonly skins: MeshStandardMaterial[] = []
  private readonly flashColor = new Color()
  /** Seconds since the last wound's tint; at or past {@link FLASH_TIME} there is none. */
  private flashAge = FLASH_TIME
  /** Seconds left of a duck; the stance is restored when it runs out. */
  private duckLeft = 0

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
      // Apply physical proportions (height, shoulder width, gut/waist, chest, limb girth)
      applyCharacterProportions(this.instance, this.unit.sheet.appearance)

      // Tint per soldier, not per faction: squadmates get neighbouring hues so
      // they can be told apart on the field and in their portraits.
      const tint = soldierColor(this.unit.faction, this.unit.squadIndex)
      this.instance.traverse((child) => {
        if (child instanceof Mesh && child.material) {
          const mat = (child.material as MeshStandardMaterial).clone()
          mat.color.copy(tint)
          child.material = mat
          this.skins.push(mat)
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

    // The overlays run on the same mixer as everything else: an additive
    // action accumulates on top of the stance rather than competing with it
    // for weight, so no ordering or masking is needed here.
    const mixer = this.animationMixer
    if (mixer) {
      for (const [key, clip] of additiveClips(gltf)) this.overlays.set(key, mixer.clipAction(clip))
    }

    // One-shot clips hand control back to the appropriate loop. The death clip
    // is excluded so the corpse holds its final frame. An overlay hands nothing
    // back: the stance underneath it never stopped, so it only fades itself out
    // and lets a held watch resume.
    this.animationMixer?.addEventListener('finished', (event) => {
      if (this.unit.isDead) return
      const finished = (event as unknown as { action?: AnimationAction }).action
      if (finished && finished === this.overlay) {
        this.overlay = undefined
        finished.fadeOut(OVERLAY_FADE)
        this.syncWatchOverlay()
        return
      }
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
    this.duckLeft = 0
    action.setLoop(LoopRepeat, Infinity)
    action.clampWhenFinished = false
    this.fadeToAction(action, 0.15)
    // fadeToAction() calls setEffectiveTimeScale(1), so any rate adjustment
    // has to be applied after it, not before.
    action.setEffectiveTimeScale(timeScale)
  }

  /** Locomotion clip synced so its stride matches the unit's pace (no foot sliding). */
  private playLocomotion(key: 'run' | 'crouchWalk', speed: number): void {
    this.playLoop(key, speed / CLIP_GROUND_SPEED[key])
  }

  /**
   * Play whichever loop the unit's stance calls for, and put the overlay that
   * stance implies on top of it.
   *
   * Driven by {@link RenderSystem} on stance changes, so movement, cover and a
   * held watch are decided by components and merely reflected here.
   */
  playStanceClip(): void {
    if (this.unit.isDead) return
    const crouched = this.unit.isCrouching
    if (this.unit.isMoving) {
      if (crouched) this.playLocomotion('crouchWalk', RULES.crouchMoveSpeed)
      else this.playLocomotion('run', RULES.moveSpeed)
    } else if (crouched) this.playLoop('crouch')
    // Standing, a watch is the whole body: the aim clip is a stance in its own
    // right. Crouched, it is an overlay, because the crouch is the stance.
    else if (this.unit.watching) this.playLoop('aim')
    else this.playLoop('idle')

    if (crouched && !this.unit.isMoving) this.syncWatchOverlay()
    else this.stopOverlay()
  }

  /** Hold, or drop, the crouched watch pose. Never interrupts an action. */
  private syncWatchOverlay(): void {
    const aim = this.overlays.get('aim')
    const wanted =
      this.unit.watching && this.unit.isCrouching && !this.unit.isMoving && !this.unit.isDead
    if (wanted) {
      if (!this.overlay) this.playOverlay('aim', true)
    } else if (this.overlay && this.overlay === aim) this.stopOverlay()
  }

  /** Play a clip once and hold its final frame. */
  private playOnce(key: string): void {
    const action = this.animationsMap.get(key)
    if (!action) return
    this.duckLeft = 0
    action.setLoop(LoopOnce, 1)
    action.clampWhenFinished = true
    this.fadeToAction(action, 0.1)
  }

  /** Play a clip over the stance, leaving the legs to the stance. */
  private playOverlay(key: string, loop = false): boolean {
    const action = this.overlays.get(key)
    if (!action) return false
    this.duckLeft = 0
    if (this.overlay && this.overlay !== action) this.overlay.fadeOut(OVERLAY_FADE)
    action.reset()
    action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1)
    // Clamped so the last frame is held while it fades: an additive action that
    // merely switched off would snap the arms back in a single frame.
    action.clampWhenFinished = !loop
    action.setEffectiveWeight(1).fadeIn(OVERLAY_FADE).play()
    this.overlay = action
    return true
  }

  private stopOverlay(): void {
    this.overlay?.fadeOut(OVERLAY_FADE)
    this.overlay = undefined
  }

  /**
   * An action, played whole while standing and over the crouch while crouched.
   *
   * Which of the two is not a decision about the action: it is a decision about
   * the stance, which is why every verb below goes through here.
   */
  private playAction(key: string): void {
    if (this.unit.isDead) return
    if (this.unit.isCrouching && this.playOverlay(key)) return
    this.playOnce(key)
  }

  /** Fire pose. Returns to idle/walk via the mixer's 'finished' event. */
  playShoot(): void {
    this.playAction('shoot')
  }

  /** Flinch on taking non-fatal damage. */
  playHit(): void {
    this.playAction('hit')
  }

  /** A blow with whatever is in the sidearm slot. */
  playMelee(): void {
    // A knife shares the punch: a thrust and a cross read the same from the
    // camera's distance, and the club is the only sidearm that swings.
    this.playAction(this.unit.sidearm === MeleeId.Club ? 'swing' : 'punch')
  }

  /** A grenade leaving the hand. */
  playThrow(): void {
    this.playAction('throw')
  }

  /** A fresh magazine. */
  playReload(): void {
    this.playAction('reload')
  }

  /** Working a kit on somebody, or on the world. */
  playUse(): void {
    this.playAction('interact')
  }

  /**
   * Drop into the crouch for a moment because something went past.
   *
   * Only a unit standing still on its feet does: one already crouched has
   * nowhere to go, and one on the move is not going to stop for it. Any other
   * action ends the duck early, so it can never stand a unit up out of a fire
   * pose.
   */
  playDuck(): void {
    if (this.unit.isDead || this.unit.isMoving || this.unit.isCrouching) return
    const action = this.animationsMap.get('crouch')
    if (!action) return
    action.setLoop(LoopRepeat, Infinity)
    action.clampWhenFinished = false
    this.fadeToAction(action, 0.08)
    this.duckLeft = DUCK_TIME
  }

  /** Tint the body for a moment: red for a crit, grey for armour stripped. */
  flash(mark: HitMark): void {
    if (mark === 'plain') return
    this.flashColor.set(FLASH_COLOR[mark])
    this.flashAge = 0
  }

  /** Collapse and hold the final frame. */
  playDeath(): void {
    // Whole-body, whatever the stance: a unit that dies crouched still falls.
    this.stopOverlay()
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

    if (this.duckLeft > 0) {
      this.duckLeft -= delta
      if (this.unit.isDead) this.duckLeft = 0
      else if (this.duckLeft <= 0) this.playStanceClip()
    }

    if (this.flashAge < FLASH_TIME) {
      this.flashAge += delta
      const strength = Math.max(0, 1 - this.flashAge / FLASH_TIME)
      for (const skin of this.skins) skin.emissive.copy(this.flashColor).multiplyScalar(strength * 0.8)
    }

    if (!this.instance) return
    this.syncWeaponModel()
    this.weaponModel?.update()
    this.instance.position.copy(this.smoothed)
    this.instance.rotation.y = this.currentYaw
    // Corpses stay drawn so the death clip's last frame reads as a body, and
    // enemy corpses are still subject to fog: `seen` already says both.
    this.instance.visible = this.unit.seen
  }

  /**
   * Keep the model in the hand matching the weapon in the unit's hands. The unit can be
   * re-equipped after the view exists (loadout, a peer's sheets arriving), so
   * this is checked every frame rather than once at construction.
   */
  private syncWeaponModel(): void {
    const id = this.unit.weaponId
    if (id === this.weaponShown) return
    this.weaponShown = id
    this.weaponModel?.remove()
    this.weaponModel = this.instance && HeldWeapon.attach(this.instance, this.engine.assets, id)
  }
}
