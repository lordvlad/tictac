import { Euler, Matrix4, type PerspectiveCamera, Vector2, Vector3 } from 'three'
import { CAM, EYE_HEIGHT } from '../config'
import { clamp, smoothstep } from '../core/math'
import { clientToNdc } from '../core/screen'
import { CameraInput, type CameraRigTarget } from './CameraInput'
import { GroundPicker } from './GroundPicker'

export interface OrbitRigOptions {
  /** Focus point is clamped to +/- this on both X and Z. */
  bounds: number
}

/**
 * Free-orbiting tactical camera.
 *
 * The rig is fully described by a focus point on the floor plane, an orbit
 * distance and an azimuth. Tilt is NOT independent: it is a pure function of
 * zoom distance, tracing a curved arc that is flat when zoomed in and steep
 * when zoomed out.
 *
 * This class is camera state and camera math only. Which button or gesture
 * means "orbit" is {@link CameraInput}'s business, and it drives the rig through
 * the {@link CameraRigTarget} commands.
 *
 * Free-look is stored as an additive offset on top of the orbit orientation.
 * Any pan / orbit / zoom drives that offset back to zero, which is what
 * "resets camera angle to the angle along the zoom tilt path" means in
 * practice: the camera eases back onto the arc instead of snapping.
 *
 * This runs on its own requestAnimationFrame loop. The engine's simulation
 * update() is a 30 Hz setInterval, which is far too coarse for camera motion.
 */
export class OrbitRig implements CameraRigTarget {
  enabled = true

  private readonly bounds: number
  private readonly input: CameraInput
  private readonly picker: GroundPicker

  // --- orbit state: target (input) and current (smoothed, rendered) ---------
  private readonly focusTarget = new Vector3()
  private readonly focusCurrent = new Vector3()
  private distTarget: number = CAM.distStart
  private distCurrent: number = CAM.distStart
  private azimuthTarget: number = CAM.azimuthStart
  private azimuthCurrent: number = CAM.azimuthStart

  // --- additive free-look offset & mode ------------------------------------
  private freeYawTarget = 0
  private freeYawCurrent = 0
  private freePitchTarget = 0
  private freePitchCurrent = 0
  private freeLookToggleActive = false

  // --- over-the-shoulder view mode ------------------------------------------
  private isShoulderView = false
  /** Unit eye anchor position that camera rotates and tilts around. */
  private readonly eyeAnchorTarget = new Vector3()
  private readonly eyeAnchorCurrent = new Vector3()
  /** Downward tilt for this shot, on top of the free-look offset. */
  private shoulderPitchTarget = CAM.shoulderPitch
  private shoulderPitchCurrent = CAM.shoulderPitch

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
    this.focusTarget.set(position.x, 0, position.z)
    this.clampFocus(this.focusTarget)
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
   * Combines the zoom-tilt arc with the additive free-look pitch offset;
   * character view sits at ~0 (horizontal). Used by the wall x-ray fade.
   */
  get tilt(): number {
    const base = this.isShoulderView ? this.shoulderPitchCurrent : this.pitchForDistance(this.distCurrent)
    return base - this.freePitchCurrent
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
    }
    this.isShoulderView = true
    this.freeLookToggleActive = true

    this.aimShoulderView(position, yaw, lookAt)
    // Ease in from wherever the tactical camera happened to be.
    this.eyeAnchorCurrent.copy(this.eyeAnchorTarget)
    this.azimuthCurrent = this.azimuthTarget
    this.shoulderPitchCurrent = this.shoulderPitchTarget
    this.freeYawTarget = 0
    this.freeYawCurrent = 0
    this.freePitchTarget = 0
    this.freePitchCurrent = 0
  }

  /**
   * Exit shoulder view and return the camera to the tactical orbit.
   * Resets free yaw/pitch, azimuth, zoom distance and tilt to arc defaults.
   */
  exitShoulderView(): void {
    this.isShoulderView = false
    this.freeLookToggleActive = false
    this.resetFreeLook()
    this.azimuthTarget = this.preShoulderAzimuth
    this.distTarget = this.preShoulderDist
    this.focusTarget.set(this.eyeAnchorCurrent.x, 0, this.eyeAnchorCurrent.z)
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
    this.aimShoulderView(position, yaw, lookAt)
  }

  private aimShoulderView(position: Vector3, yaw: number, lookAt?: Vector3): void {
    this.eyeAnchorTarget.set(position.x, position.y + EYE_HEIGHT, position.z)

    if (!lookAt) {
      this.azimuthTarget = yaw + Math.PI
      this.shoulderPitchTarget = CAM.shoulderPitch
      return
    }

    // Aim from where the camera sits relative to unit's eyes anchor point
    const dx = lookAt.x - this.eyeAnchorTarget.x
    const dy = this.eyeAnchorTarget.y - lookAt.y
    const dz = lookAt.z - this.eyeAnchorTarget.z
    const flat = Math.hypot(dx, dz)
    this.azimuthTarget = Math.atan2(dx, dz) + Math.PI
    this.shoulderPitchTarget = flat > 0.001 ? Math.atan2(dy, flat) : CAM.shoulderPitch
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
    this.distTarget = clamp(distance, CAM.distMin, CAM.distMax)
  }

  get azimuth(): number {
    return this.azimuthTarget
  }

  set azimuth(radians: number) {
    this.azimuthTarget = radians
  }

  freeLookBy(dxPixels: number, dyPixels: number): void {
    const yawLimit = this.isShoulderView ? Math.PI : CAM.freeYawLimit
    const pitchLimit = this.isShoulderView ? (82 * Math.PI) / 180 : CAM.freePitchLimit

    this.freeYawTarget = clamp(
      this.freeYawTarget - dxPixels * CAM.freeLookSpeed,
      -yawLimit,
      yawLimit,
    )
    this.freePitchTarget = clamp(
      this.freePitchTarget - dyPixels * CAM.freeLookSpeed,
      -pitchLimit,
      pitchLimit,
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
    )
    if (hit === null) return

    this.focusTarget.copy(this.panStartFocus).sub(hit).add(this.panGrabPoint)
    this.focusTarget.y = 0
    this.clampFocus(this.focusTarget)
  }

  panEnd(): void {
    this.panValid = false
  }

  // ===========================================================================
  // Tilt arc & frame loop
  // ===========================================================================

  /**
   * Tilt as a function of zoom distance. Smoothstep gives a curved arc rather
   * than a linear ramp, so the camera "swings" up as you pull back.
   */
  private pitchForDistance(dist: number): number {
    const eased = smoothstep((dist - CAM.distMin) / (CAM.distMax - CAM.distMin))
    return CAM.pitchMin + (CAM.pitchMax - CAM.pitchMin) * eased
  }

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
    const kReset = 1 - Math.exp(-CAM.resetSmoothing * delta)

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
      this.eyeAnchorCurrent.lerp(this.eyeAnchorTarget, k)
      this.azimuthCurrent += (this.azimuthTarget - this.azimuthCurrent) * k
      this.shoulderPitchCurrent += (this.shoulderPitchTarget - this.shoulderPitchCurrent) * k
      this.freeYawCurrent += (this.freeYawTarget - this.freeYawCurrent) * k
      this.freePitchCurrent += (this.freePitchTarget - this.freePitchCurrent) * k
      this.focusCurrent.set(this.eyeAnchorCurrent.x, 0, this.eyeAnchorCurrent.z)
    } else {
      this.applyEdgePan(delta)
      this.focusCurrent.lerp(this.focusTarget, k)
      this.distCurrent += (this.distTarget - this.distCurrent) * k
      this.azimuthCurrent += (this.azimuthTarget - this.azimuthCurrent) * k
      this.freeYawCurrent += (this.freeYawTarget - this.freeYawCurrent) * kReset
      this.freePitchCurrent += (this.freePitchTarget - this.freePitchCurrent) * kReset
    }

    this.applyTransform()
  }

  private applyImmediate(): void {
    this.focusCurrent.copy(this.focusTarget)
    this.distCurrent = this.distTarget
    this.azimuthCurrent = this.azimuthTarget
    this.freeYawCurrent = this.freeYawTarget
    this.freePitchCurrent = this.freePitchTarget
    this.applyTransform()
  }

  private applyTransform(): void {
    if (this.isShoulderView) {
      const pitch = -this.shoulderPitchCurrent + this.freePitchCurrent
      const yaw = this.azimuthCurrent + this.freeYawCurrent
      this.euler.set(pitch, yaw, 0, 'YXZ')

      // Camera offset relative to the unit's eyes anchor point
      this.scratchVec.set(CAM.shoulderSide, CAM.shoulderHeight - EYE_HEIGHT, -CAM.shoulderBack)
      this.scratchVec.applyEuler(this.euler)

      this.camera.position.copy(this.eyeAnchorCurrent).add(this.scratchVec).add(this.shakeOffset)
      this.camera.quaternion.setFromEuler(this.euler)
      this.camera.updateMatrixWorld()
      return
    }

    const pitch = this.pitchForDistance(this.distCurrent)
    const az = this.azimuthCurrent
    const cosP = Math.cos(pitch)
    const sinP = Math.sin(pitch)

    // Orbit position on the sphere around the focus point.
    this.camera.position.set(
      this.focusCurrent.x + Math.sin(az) * cosP * this.distCurrent,
      this.focusCurrent.y + sinP * this.distCurrent,
      this.focusCurrent.z + Math.cos(az) * cosP * this.distCurrent,
    )
    this.camera.position.add(this.shakeOffset)

    // With YXZ order, yaw = azimuth and pitch = -tilt reproduces lookAt(focus)
    // exactly, which lets the free-look offsets compose additively.
    this.euler.set(-pitch + this.freePitchCurrent, az + this.freeYawCurrent, 0, 'YXZ')
    this.camera.quaternion.setFromEuler(this.euler)
    this.camera.updateMatrixWorld()
  }
}
