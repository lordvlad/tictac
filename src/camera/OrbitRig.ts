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

  // --- character eye-level view mode ----------------------------------------
  private isCharacterView = false
  private readonly eyePositionTarget = new Vector3()
  private readonly eyePositionCurrent = new Vector3()

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
    const base = this.isCharacterView ? 0 : this.pitchForDistance(this.distCurrent)
    return base - this.freePitchCurrent
  }

  /**
   * Enter first-person / eye-level view for a selected character.
   * Camera moves to character's eye position looking outward in character's facing direction.
   */
  enterCharacterView(position: Vector3, yaw: number): void {
    this.isCharacterView = true
    this.freeLookToggleActive = true

    const camYaw = yaw + Math.PI
    this.eyePositionTarget.set(
      position.x + Math.sin(yaw) * 0.15,
      position.y + EYE_HEIGHT,
      position.z + Math.cos(yaw) * 0.15,
    )
    this.eyePositionCurrent.copy(this.camera.position) // Smooth transition from current camera location
    this.azimuthTarget = camYaw
    this.azimuthCurrent = camYaw
    this.freeYawTarget = 0
    this.freeYawCurrent = 0
    this.freePitchTarget = 0
    this.freePitchCurrent = 0
  }

  /**
   * Exit character view and return camera to tactical orbit view.
   * Resets free yaw/pitch, azimuth rotation, zoom distance, and tilt back to arc defaults.
   */
  exitCharacterView(): void {
    this.isCharacterView = false
    this.freeLookToggleActive = false
    this.resetFreeLook()
    this.azimuthTarget = CAM.azimuthStart
    this.distTarget = CAM.distStart
    this.focusTarget.set(this.eyePositionTarget.x, 0, this.eyePositionTarget.z)
    this.clampFocus(this.focusTarget)
  }

  updateCharacterView(position: Vector3, yaw: number): void {
    if (!this.isCharacterView) return
    this.eyePositionTarget.set(
      position.x + Math.sin(yaw) * 0.15,
      position.y + EYE_HEIGHT,
      position.z + Math.cos(yaw) * 0.15,
    )
    this.azimuthTarget = yaw + Math.PI
  }

  get isCharacterViewActive(): boolean {
    return this.isCharacterView
  }

  /** Toggle or set explicit freelook mode (for mobile / laptops without 3rd mouse button). */
  setFreeLookMode(active: boolean): void {
    if (!active && this.isCharacterView) {
      this.exitCharacterView()
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
    return this.freeLookToggleActive || this.isCharacterView
  }

  // ===========================================================================
  // CameraRigTarget — the command surface the input layer drives
  // ===========================================================================

  get freeLookMode(): boolean {
    return this.freeLookToggleActive
  }

  get characterView(): boolean {
    return this.isCharacterView
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
    const yawLimit = this.isCharacterView ? Math.PI : CAM.freeYawLimit
    const pitchLimit = this.isCharacterView ? (82 * Math.PI) / 180 : CAM.freePitchLimit

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

    if (this.isCharacterView) {
      this.eyePositionCurrent.lerp(this.eyePositionTarget, k)
      this.azimuthCurrent += (this.azimuthTarget - this.azimuthCurrent) * k
      this.freeYawCurrent += (this.freeYawTarget - this.freeYawCurrent) * k
      this.freePitchCurrent += (this.freePitchTarget - this.freePitchCurrent) * k
      this.focusCurrent.set(this.eyePositionCurrent.x, 0, this.eyePositionCurrent.z)
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
    if (this.isCharacterView) {
      this.camera.position.copy(this.eyePositionCurrent).add(this.shakeOffset)
      // Horizontal level look, plus whatever free-look offset is applied.
      this.euler.set(this.freePitchCurrent, this.azimuthCurrent + this.freeYawCurrent, 0, 'YXZ')
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
