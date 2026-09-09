import { Euler, Matrix4, type PerspectiveCamera, Vector2, Vector3 } from 'three'
import { CAM, LEVEL_HEIGHT } from '../config'
import { clamp, smoothstep } from '../core/math'
import { clientToNdc } from '../core/screen'
import { CameraInput, type CameraRigTarget } from './CameraInput'
import { GroundPicker } from './GroundPicker'

export interface OrbitRigOptions {
  /** Focus point is clamped to +/- this on both X and Z. */
  bounds: number
}

/**
 * Tilt as a function of zoom distance. Smoothstep gives a curved arc rather
 * than a linear ramp, so the camera "swings" up as you pull back.
 */
function pitchForDistance(dist: number): number {
  const eased = smoothstep((dist - CAM.distMin) / (CAM.distMax - CAM.distMin))
  return CAM.pitchMin + (CAM.pitchMax - CAM.pitchMin) * eased
}

/**
 * Free-orbiting tactical camera, and the over-the-shoulder view.
 *
 * Both views are the same boom: a pivot point, an arm length, an azimuth, a
 * pitch and a sideways offset. Tactical uses a floor pivot, no side offset and
 * a pitch tied to zoom distance (the arc: flat when zoomed in, steep when
 * zoomed out); shoulder view moves the pivot up to the unit's shoulders,
 * shortens the arm and frees the pitch. Because it is one formula driven by
 * smoothed state, entering and leaving shoulder view is a dolly, not a cut.
 *
 * This class is camera state and camera math only. Which button or gesture
 * means "orbit" is {@link CameraInput}'s business, and it drives the rig through
 * the {@link CameraRigTarget} commands.
 *
 * Free-look is stored as an additive offset on top of the boom orientation. In
 * tactical view it turns the camera in place and any pan / orbit / zoom drives
 * it back to zero, which is what "resets camera angle to the angle along the
 * zoom tilt path" means in practice. In shoulder view it also swings the boom,
 * so dragging walks the camera all the way around the unit.
 *
 * This runs on its own requestAnimationFrame loop. The engine's simulation
 * update() is a 30 Hz setInterval, which is far too coarse for camera motion.
 */
export class OrbitRig implements CameraRigTarget {
  enabled = true

  private readonly bounds: number
  private readonly input: CameraInput
  private readonly picker: GroundPicker

  // --- boom state: target (input) and current (smoothed, rendered) ---------
  private readonly focusTarget = new Vector3()
  private readonly focusCurrent = new Vector3()
  private distTarget: number = CAM.distStart
  private distCurrent: number = CAM.distStart
  private azimuthTarget: number = CAM.azimuthStart
  private azimuthCurrent: number = CAM.azimuthStart
  private pitchTarget: number = pitchForDistance(CAM.distStart)
  private pitchCurrent: number = pitchForDistance(CAM.distStart)
  /** Sideways offset of the boom: 0 on the tactical orbit, CAM.shoulderSide behind a unit. */
  private sideTarget = 0
  private sideCurrent = 0

  // --- additive free-look offset & mode ------------------------------------
  private freeYawTarget = 0
  private freeYawCurrent = 0
  private freePitchTarget = 0
  private freePitchCurrent = 0
  private freeLookToggleActive = false

  // --- over-the-shoulder view mode ------------------------------------------
  private isShoulderView = false

  /** Tactical camera state preserved when entering shoulder view, restored on exit. */
  private preShoulderDist: number = CAM.distStart
  private preShoulderAzimuth: number = CAM.azimuthStart
  /** Camera state frozen at pan start, so panning cannot feed back on itself. */
  private readonly panStartFocus = new Vector3()
  private readonly panStartCamPos = new Vector3()
  private readonly panStartUnproject = new Matrix4()
  private readonly panGrabPoint = new Vector3()
  private panValid = false

  // --- scratch --------------------------------------------------------------
  private readonly euler = new Euler(0, 0, 0, 'YXZ')
  private readonly scratchVec = new Vector3()
  private readonly scratchNdc = new Vector2()
  private readonly shakeOffset = new Vector3()

  private shakeTime = 0
  private shakeDuration = 0
  private shakeIntensity = 0

  private rafHandle = 0
  private lastFrameTime = 0
  private disposed = false

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    options: OrbitRigOptions,
  ) {
    this.bounds = options.bounds
    this.picker = new GroundPicker(camera)

    // Widen the near/far planes: the engine leaves three's defaults, which clip
    // badly at our zoom range.
    this.camera.near = 0.5
    this.camera.far = 400
    this.camera.updateProjectionMatrix()

    this.input = new CameraInput(canvas, this)

    this.applyImmediate()
    this.lastFrameTime = performance.now()
    this.loop()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.rafHandle)
    this.input.dispose()
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /** Smoothly move the focus point (keeps zoom, azimuth and tilt). */
  focusOn(position: Vector3): void {
    this.focusTarget.set(position.x, position.y, position.z)
    this.clampFocus(this.focusTarget)
  }

  /** Smoothly raise or lower the focus plane to the selected storey. */
  setFocusLevel(level: number): void {
    this.focusTarget.y = level * LEVEL_HEIGHT
  }

  /** Jump the focus point with no easing. */
  snapTo(position: Vector3): void {
    this.focusOn(position)
    this.focusCurrent.copy(this.focusTarget)
    this.applyImmediate()
  }

  get focusPoint(): Vector3 {
    return this.focusCurrent
  }

  /** Trigger a camera shake of `intensity` (metres) decaying over `duration` (seconds). */
  shake(intensity: number, duration: number): void {
    this.shakeIntensity = intensity
    this.shakeDuration = duration
    this.shakeTime = 0
  }

  get distance(): number {
    return this.distCurrent
  }

  /** True while a camera gesture owns the pointer — used to suppress clicks. */
  get isDragging(): boolean {
    return this.input.isDragging
  }

  /**
   * Current downward tilt of the camera below the horizon, in radians.
   * Combines the boom pitch with the additive free-look offset; character view
   * sits near 0 (horizontal). Used by the wall x-ray fade.
   */
  get tilt(): number {
    return this.pitchCurrent - this.freePitchCurrent
  }

  /**
   * Enter over-the-shoulder view behind a unit.
   *
   * The camera sits behind and above the unit looking past it, so the unit
   * stays on screen — which is the point of the view, and why it is not the
   * eye-level shot it used to be.
   */
  enterShoulderView(position: Vector3, yaw: number, lookAt?: Vector3): void {
    if (!this.isShoulderView) {
      this.preShoulderDist = this.distTarget
      this.preShoulderAzimuth = this.azimuthTarget
      // A tactical free-look offset is not an aim: fold it into the boom so the
      // camera keeps pointing where it points, then start the view from zero.
      this.foldFreeLookIntoBoom()
    }
    this.isShoulderView = true
    this.freeLookToggleActive = true

    this.distTarget = CAM.shoulderBack
    this.sideTarget = CAM.shoulderSide
    this.aimShoulder(position, yaw, lookAt)
  }

  /**
   * Exit shoulder view and return the camera to the tactical orbit.
   * Resets free yaw/pitch, azimuth, zoom distance and tilt to arc defaults.
   */
  exitShoulderView(): void {
    if (!this.isShoulderView) return
    this.isShoulderView = false
    this.freeLookToggleActive = false
    // Whatever the player orbited round the unit becomes plain azimuth, so the
    // camera unwinds from where it is instead of spinning back through it.
    this.foldFreeLookIntoBoom()
    this.resetFreeLook()

    this.distTarget = this.preShoulderDist
    this.sideTarget = 0
    this.setAzimuthTarget(this.preShoulderAzimuth)
    // The shoulder pivot sits at shoulder height above the unit's feet; the
    // tactical focus belongs on the storey the unit is standing on.
    this.focusTarget.set(
      this.focusCurrent.x,
      this.focusCurrent.y - CAM.shoulderPivotHeight,
      this.focusCurrent.z,
    )
    this.clampFocus(this.focusTarget)
  }

  /**
   * Re-aim the shoulder camera.
   *
   * `lookAt` centres a specific point in frame — used when lining up a shot,
   * so the target sits under the middle of the screen despite the camera
   * being offset to one side. Without it the camera looks along `yaw`.
   */
  updateShoulderView(position: Vector3, yaw: number, lookAt?: Vector3): void {
    if (!this.isShoulderView) return
    this.aimShoulder(position, yaw, lookAt)
  }

  get isShoulderViewActive(): boolean {
    return this.isShoulderView
  }

  /** Toggle or set explicit freelook mode (for mobile / laptops without 3rd mouse button). */
  setFreeLookMode(active: boolean): void {
    if (!active && this.isShoulderView) {
      this.exitShoulderView()
      return
    }
    this.freeLookToggleActive = active
    if (!active) {
      // Disabling freelook resets free yaw/pitch, azimuth rotation, zoom distance, and tilt back to arc defaults
      this.resetFreeLook()
      this.azimuthTarget = CAM.azimuthStart
      this.distTarget = CAM.distStart
    }
  }

  toggleFreeLookMode(): boolean {
    this.setFreeLookMode(!this.freeLookToggleActive)
    return this.freeLookToggleActive
  }

  get isFreeLookActive(): boolean {
    return this.freeLookToggleActive || this.isShoulderView
  }

  // ===========================================================================
  // CameraRigTarget — the command surface the input layer drives
  // ===========================================================================

  get freeLookMode(): boolean {
    return this.freeLookToggleActive
  }

  get shoulderView(): boolean {
    return this.isShoulderView
  }

  get zoom(): number {
    return this.distTarget
  }

  set zoom(distance: number) {
    // In shoulder view the wheel shortens or lengthens the boom instead of
    // running the tactical zoom range, which the arm could never reach.
    this.distTarget = this.isShoulderView
      ? clamp(distance, CAM.shoulderBackMin, CAM.shoulderBackMax)
      : clamp(distance, CAM.distMin, CAM.distMax)
  }

  get azimuth(): number {
    return this.azimuthTarget
  }

  set azimuth(radians: number) {
    this.azimuthTarget = radians
  }

  freeLookBy(dxPixels: number, dyPixels: number): void {
    if (this.isShoulderView) {
      // Yaw is deliberately unclamped: the whole point of the view is being
      // able to walk the camera the full way round the unit, past its face and
      // back again, across as many drags as that takes.
      this.freeYawTarget -= dxPixels * CAM.shoulderLookSpeed
      // Pitch is clamped on the *resulting* tilt, not on the offset, so the
      // limits hold no matter what the shot aim did to the base pitch.
      this.freePitchTarget = clamp(
        this.freePitchTarget - dyPixels * CAM.shoulderLookSpeed,
        this.pitchTarget - CAM.shoulderPitchMax,
        this.pitchTarget - CAM.shoulderPitchMin,
      )
      return
    }

    this.freeYawTarget = clamp(
      this.freeYawTarget - dxPixels * CAM.freeLookSpeed,
      -CAM.freeYawLimit,
      CAM.freeYawLimit,
    )
    this.freePitchTarget = clamp(
      this.freePitchTarget - dyPixels * CAM.freeLookSpeed,
      -CAM.freePitchLimit,
      CAM.freePitchLimit,
    )
  }

  resetFreeLook(): void {
    this.freeYawTarget = 0
    this.freePitchTarget = 0
  }

  // ===========================================================================
  // Panning ("grab the ground")
  // ===========================================================================

  /**
   * Freeze the camera basis at drag start. Both the grab point and every
   * subsequent cursor position are unprojected through this frozen basis, so
   * moving the focus never changes the mapping mid-drag.
   */
  panBegin(clientX: number, clientY: number): void {
    this.camera.updateMatrixWorld()
    this.panStartFocus.copy(this.focusTarget)
    this.panStartCamPos.copy(this.camera.position)
    this.panStartUnproject.multiplyMatrices(
      this.camera.matrixWorld,
      this.camera.projectionMatrixInverse,
    )

    clientToNdc(this.canvas, clientX, clientY, this.scratchNdc)
    const hit = this.picker.throughBasis(
      this.scratchNdc,
      this.panStartCamPos,
      this.panStartUnproject,
      this.panGrabPoint,
      this.panStartFocus.y,
    )
    this.panValid = hit !== null
  }

  panUpdate(clientX: number, clientY: number): void {
    if (!this.panValid) return
    clientToNdc(this.canvas, clientX, clientY, this.scratchNdc)
    const hit = this.picker.throughBasis(
      this.scratchNdc,
      this.panStartCamPos,
      this.panStartUnproject,
      this.scratchVec,
      this.panStartFocus.y,
    )
    if (hit === null) return

    // Drag across the storey the camera is looking at, not the ground plane:
    // grabbing y = 0 while focused on an upper floor drops the view a storey.
    this.focusTarget.copy(this.panStartFocus).sub(hit).add(this.panGrabPoint)
    this.focusTarget.y = this.panStartFocus.y
    this.clampFocus(this.focusTarget)
  }

  panEnd(): void {
    this.panValid = false
  }

  // ===========================================================================
  // Shoulder aiming
  // ===========================================================================

  /**
   * Point the boom for this frame's shoulder shot.
   *
   * With no `lookAt` the camera simply sits behind the unit's facing. With one,
   * the angles are solved from the pivot and then re-solved from where the boom
   * actually seats the camera. An arm metres long and offset to one side sees
   * the target several degrees off the pivot's bearing; each pass shaves that
   * parallax by roughly the side-to-arm ratio, so two land it on the reticle.
   */
  private aimShoulder(position: Vector3, yaw: number, lookAt?: Vector3): void {
    this.focusTarget.set(position.x, position.y + CAM.shoulderPivotHeight, position.z)
    this.clampFocus(this.focusTarget)

    if (!lookAt) {
      this.setAzimuthTarget(yaw + Math.PI)
      this.pitchTarget = CAM.shoulderPitch
      return
    }

    this.solveAim(lookAt, this.focusTarget)
    for (let pass = 0; pass < 2; pass++) {
      this.boomPosition(
        this.scratchVec,
        this.focusTarget,
        this.azimuthTarget,
        this.pitchTarget,
        this.distTarget,
        this.sideTarget,
      )
      this.solveAim(lookAt, this.scratchVec)
    }
  }

  /** Angles that make a camera at `from` look straight at `lookAt`. */
  private solveAim(lookAt: Vector3, from: Vector3): void {
    const dx = from.x - lookAt.x
    const dy = from.y - lookAt.y
    const dz = from.z - lookAt.z
    const flat = Math.hypot(dx, dz)
    if (flat < 0.001) {
      this.pitchTarget = CAM.shoulderPitch
      return
    }
    this.setAzimuthTarget(Math.atan2(dx, dz))
    this.pitchTarget = clamp(
      Math.atan2(dy, flat),
      CAM.shoulderPitchMin,
      CAM.shoulderPitchMax,
    )
  }

  /**
   * Set the azimuth the camera eases towards, taking the short way round. A
   * unit facing that crosses +/-pi would otherwise spin the camera a full turn.
   */
  private setAzimuthTarget(radians: number): void {
    const delta = radians - this.azimuthCurrent
    this.azimuthTarget = this.azimuthCurrent + Math.atan2(Math.sin(delta), Math.cos(delta))
  }

  /**
   * Absorb the free-look offset into the boom angles, leaving the rendered
   * pose untouched. Used on every mode change so nothing whips round.
   */
  private foldFreeLookIntoBoom(): void {
    this.azimuthCurrent += this.freeYawCurrent
    this.azimuthTarget += this.freeYawCurrent
    this.pitchCurrent -= this.freePitchCurrent
    this.pitchTarget -= this.freePitchCurrent
    this.freeYawCurrent = 0
    this.freeYawTarget = 0
    this.freePitchCurrent = 0
    this.freePitchTarget = 0
  }

  // ===========================================================================
  // Frame loop
  // ===========================================================================

  private clampFocus(v: Vector3): void {
    v.x = clamp(v.x, -this.bounds, this.bounds)
    v.z = clamp(v.z, -this.bounds, this.bounds)
  }

  /**
   * Scroll the focus point while the cursor sits in the border band, RTS style.
   * Direction comes from the current azimuth so screen-up maps to the camera's
   * ground-forward; speed scales with zoom distance.
   */
  private applyEdgePan(delta: number): void {
    if (!this.enabled || this.isFreeLookActive) return
    const push = this.input.edgePush()
    if (!push) return

    const az = this.azimuthCurrent
    const forwardX = -Math.sin(az)
    const forwardZ = -Math.cos(az)
    const rightX = Math.cos(az)
    const rightZ = -Math.sin(az)

    const step = CAM.edgePanSpeed * this.distCurrent * delta
    this.focusTarget.x += (rightX * push.hx + forwardX * push.vy) * step
    this.focusTarget.z += (rightZ * push.hx + forwardZ * push.vy) * step
    this.clampFocus(this.focusTarget)
    // Panning re-seats the camera on the zoom-tilt arc, like drag-pan does.
    this.resetFreeLook()
  }

  private readonly loop = (): void => {
    if (this.disposed) return
    const now = performance.now()
    const delta = Math.min(0.1, (now - this.lastFrameTime) / 1000)
    this.lastFrameTime = now
    this.update(delta)
    this.rafHandle = requestAnimationFrame(this.loop)
  }

  private update(delta: number): void {
    const k = 1 - Math.exp(-CAM.smoothing * delta)

    // Decay screen shake over time.
    if (this.shakeTime < this.shakeDuration) {
      this.shakeTime += delta
      const progress = clamp(this.shakeTime / this.shakeDuration, 0, 1)
      const decay = 1 - progress
      const amp = this.shakeIntensity * decay
      // Rapid organic oscillation using prime-related sine frequencies
      const t = this.shakeTime * 60
      this.shakeOffset.set(
        Math.sin(t * 1.1) * amp,
        Math.cos(t * 1.3) * amp,
        Math.sin(t * 1.7) * amp,
      )
    } else {
      this.shakeOffset.set(0, 0, 0)
    }

    if (this.isShoulderView) {
      // Free-look IS the aim here, so it tracks at the normal rate and never
      // decays: letting go of the drag must not swing the view back.
      this.freeYawCurrent += (this.freeYawTarget - this.freeYawCurrent) * k
      this.freePitchCurrent += (this.freePitchTarget - this.freePitchCurrent) * k
    } else {
      this.applyEdgePan(delta)
      // Tactical tilt rides the zoom arc.
      this.pitchTarget = pitchForDistance(this.distTarget)
      const kReset = 1 - Math.exp(-CAM.resetSmoothing * delta)
      this.freeYawCurrent += (this.freeYawTarget - this.freeYawCurrent) * kReset
      this.freePitchCurrent += (this.freePitchTarget - this.freePitchCurrent) * kReset
    }

    this.focusCurrent.lerp(this.focusTarget, k)
    this.distCurrent += (this.distTarget - this.distCurrent) * k
    this.azimuthCurrent += (this.azimuthTarget - this.azimuthCurrent) * k
    this.pitchCurrent += (this.pitchTarget - this.pitchCurrent) * k
    this.sideCurrent += (this.sideTarget - this.sideCurrent) * k

    this.applyTransform()
  }

  private applyImmediate(): void {
    this.focusCurrent.copy(this.focusTarget)
    this.distCurrent = this.distTarget
    this.azimuthCurrent = this.azimuthTarget
    this.pitchCurrent = this.pitchTarget
    this.sideCurrent = this.sideTarget
    this.freeYawCurrent = this.freeYawTarget
    this.freePitchCurrent = this.freePitchTarget
    this.applyTransform()
  }

  /**
   * Place a camera on the boom: `dist` behind `pivot` along (`yaw`, `pitch`),
   * shifted `side` metres along the camera's right. Looking back down the same
   * angles from there frames the pivot, offset to one side by `side`.
   */
  private boomPosition(
    out: Vector3,
    pivot: Vector3,
    yaw: number,
    pitch: number,
    dist: number,
    side: number,
  ): Vector3 {
    const sinP = Math.sin(pitch)
    const cosP = Math.cos(pitch)
    let arm = dist
    if (sinP < 0) {
      // Spring arm: looking up from behind would drive the camera through the
      // floor, so the arm shortens rather than sinking.
      arm = Math.min(arm, (CAM.shoulderPivotHeight - CAM.shoulderMinHeight) / -sinP)
    }
    // Keep the framing proportional as the arm shortens, or the unit swings
    // off screen exactly when the camera is closest to it.
    const lateral = side * (arm / dist)
    const sinY = Math.sin(yaw)
    const cosY = Math.cos(yaw)
    return out.set(
      pivot.x + sinY * cosP * arm + cosY * lateral,
      pivot.y + sinP * arm,
      pivot.z + cosY * cosP * arm - sinY * lateral,
    )
  }

  private applyTransform(): void {
    const lookYaw = this.azimuthCurrent + this.freeYawCurrent
    const lookPitch = this.pitchCurrent - this.freePitchCurrent
    // Tactical free-look turns the camera on the spot; shoulder free-look
    // swings the boom, orbiting the unit instead of looking away from it.
    const boomYaw = this.isShoulderView ? lookYaw : this.azimuthCurrent
    const boomPitch = this.isShoulderView ? lookPitch : this.pitchCurrent

    this.boomPosition(
      this.camera.position,
      this.focusCurrent,
      boomYaw,
      boomPitch,
      this.distCurrent,
      this.sideCurrent,
    )
    this.camera.position.add(this.shakeOffset)

    // With YXZ order, yaw = azimuth and pitch = -tilt reproduces lookAt(focus)
    // exactly, which lets the free-look offsets compose additively.
    this.euler.set(-lookPitch, lookYaw, 0, 'YXZ')
    this.camera.quaternion.setFromEuler(this.euler)
    this.camera.updateMatrixWorld()
  }
}
