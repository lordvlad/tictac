import { Euler, Matrix4, PerspectiveCamera, Vector2, Vector3 } from 'three'
import { CAM } from '../config'

const MOUSE_LEFT = 0
const MOUSE_MIDDLE = 1
const MOUSE_RIGHT = 2

type DragMode = 'none' | 'pan' | 'orbit' | 'freelook'

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
 *   left drag    pan the focus point across the floor ("grab the ground")
 *   right drag   orbit the azimuth about the focus point
 *   wheel        zoom, which also drives tilt along the arc
 *   middle drag  free-look: rotate in place without moving the camera
 *
 * Free-look is stored as an additive offset on top of the orbit orientation.
 * Any pan / orbit / zoom drives that offset back to zero, which is what
 * "resets camera angle to the angle along the zoom tilt path" means in
 * practice: the camera eases back onto the arc instead of snapping.
 *
 * This runs on its own requestAnimationFrame loop. The engine's simulation
 * update() is a 30 Hz setInterval, which is far too coarse for camera motion.
 */
export class OrbitRig {
  enabled = true

  private readonly camera: PerspectiveCamera
  private readonly canvas: HTMLCanvasElement
  private readonly bounds: number

  // --- orbit state: target (input) and current (smoothed, rendered) ---------
  private readonly focusTarget = new Vector3()
  private readonly focusCurrent = new Vector3()
  private distTarget: number = CAM.distStart
  private distCurrent: number = CAM.distStart
  private azimuthTarget: number = CAM.azimuthStart
  private azimuthCurrent: number = CAM.azimuthStart

  // --- additive free-look offset -------------------------------------------
  private freeYawTarget = 0
  private freeYawCurrent = 0
  private freePitchTarget = 0
  private freePitchCurrent = 0

  // --- drag bookkeeping -----------------------------------------------------
  private dragMode: DragMode = 'none'
  private dragPointerId = -1
  private readonly lastPointer = new Vector2()

  /** Camera state frozen at pan start, so panning cannot feed back on itself. */
  private readonly panStartFocus = new Vector3()
  private readonly panStartCamPos = new Vector3()
  private readonly panStartUnproject = new Matrix4()
  private readonly panGrabPoint = new Vector3()
  private panValid = false

  // --- scratch --------------------------------------------------------------
  private readonly euler = new Euler(0, 0, 0, 'YXZ')
  private readonly scratchVec = new Vector3()
  private readonly scratchDir = new Vector3()
  private readonly unprojectMatrix = new Matrix4()

  private rafHandle = 0
  private lastFrameTime = 0
  private disposed = false

  constructor(camera: PerspectiveCamera, canvas: HTMLCanvasElement, options: OrbitRigOptions) {
    this.camera = camera
    this.canvas = canvas
    this.bounds = options.bounds

    // Widen the near/far planes: the engine leaves three's defaults, which clip
    // badly at our zoom range.
    this.camera.near = 0.5
    this.camera.far = 400
    this.camera.updateProjectionMatrix()

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    // passive:false so we can cancel page scroll.
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    // Middle-click otherwise triggers autoscroll in Chrome.
    canvas.addEventListener('auxclick', this.preventDefault)

    this.applyImmediate()
    this.lastFrameTime = performance.now()
    this.loop()
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

  get distance(): number {
    return this.distCurrent
  }

  /** True while the user is actively dragging — used to suppress click actions. */
  get isDragging(): boolean {
    return this.dragMode !== 'none'
  }

  /**
   * Project a normalised-device cursor position onto the floor plane (y = 0)
   * using the live camera. Returns null when the ray points at or above the
   * horizon.
   */
  screenToGround(ndc: Vector2, target = new Vector3()): Vector3 | null {
    this.camera.updateMatrixWorld()
    this.unprojectMatrix.multiplyMatrices(
      this.camera.matrixWorld,
      this.camera.projectionMatrixInverse,
    )
    return this.rayToGround(ndc, this.camera.position, this.unprojectMatrix, target)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.rafHandle)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('auxclick', this.preventDefault)
  }

  // ===========================================================================
  // Tilt arc
  // ===========================================================================

  /**
   * Tilt as a function of zoom distance. Smoothstep gives a curved arc rather
   * than a linear ramp, so the camera "swings" up as you pull back.
   */
  private pitchForDistance(dist: number): number {
    const t = Math.min(
      1,
      Math.max(0, (dist - CAM.distMin) / (CAM.distMax - CAM.distMin)),
    )
    const eased = t * t * (3 - 2 * t)
    return CAM.pitchMin + (CAM.pitchMax - CAM.pitchMin) * eased
  }

  // ===========================================================================
  // Input
  // ===========================================================================

  private readonly preventDefault = (event: Event): void => {
    event.preventDefault()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return
    if (this.dragMode !== 'none') return
    if (event.pointerType === 'mouse' && event.button === MOUSE_LEFT && event.shiftKey) {
      // Shift+left is reserved for waypoint placement.
      return
    }

    if (event.button === MOUSE_LEFT) this.dragMode = 'pan'
    else if (event.button === MOUSE_RIGHT) this.dragMode = 'orbit'
    else if (event.button === MOUSE_MIDDLE) this.dragMode = 'freelook'
    else return

    event.preventDefault()
    this.dragPointerId = event.pointerId
    // Throws for pointer ids the browser does not consider active (e.g.
    // synthetic events from tests). Capture is an optimisation, not a
    // requirement, so failing to get it must not break the drag.
    try {
      this.canvas.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    this.lastPointer.set(event.clientX, event.clientY)

    if (this.dragMode === 'pan') this.beginPan(event)

    // Pan and orbit both put the camera back on the zoom-tilt arc.
    if (this.dragMode === 'pan' || this.dragMode === 'orbit') this.resetFreeLook()
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.dragMode === 'none' || event.pointerId !== this.dragPointerId) return

    const dx = event.clientX - this.lastPointer.x
    const dy = event.clientY - this.lastPointer.y
    this.lastPointer.set(event.clientX, event.clientY)

    if (this.dragMode === 'pan') {
      this.updatePan(event)
    } else if (this.dragMode === 'orbit') {
      this.azimuthTarget -= dx * CAM.rotateSpeed
    } else {
      this.freeYawTarget = clamp(
        this.freeYawTarget - dx * CAM.freeLookSpeed,
        -CAM.freeYawLimit,
        CAM.freeYawLimit,
      )
      this.freePitchTarget = clamp(
        this.freePitchTarget - dy * CAM.freeLookSpeed,
        -CAM.freePitchLimit,
        CAM.freePitchLimit,
      )
    }
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragPointerId) return
    try {
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId)
      }
    } catch {
      /* ignore */
    }
    this.dragMode = 'none'
    this.dragPointerId = -1
    this.panValid = false
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled) return
    event.preventDefault()

    // Exponential zoom keeps the perceived step size constant at every scale.
    const factor = Math.exp(event.deltaY * CAM.zoomSpeed)
    this.distTarget = clamp(this.distTarget * factor, CAM.distMin, CAM.distMax)

    // Zooming re-derives tilt, so free-look must yield.
    this.resetFreeLook()
  }

  private resetFreeLook(): void {
    this.freeYawTarget = 0
    this.freePitchTarget = 0
  }

  // ===========================================================================
  // Panning ("grab the ground")
  // ===========================================================================

  /**
   * Freeze the camera basis at drag start. Both the grab point and every
   * subsequent cursor position are unprojected through this frozen basis, so
   * moving the focus never changes the mapping mid-drag. Doing it with the live
   * camera creates a feedback loop and the map slides away from the cursor.
   */
  private beginPan(event: PointerEvent): void {
    this.camera.updateMatrixWorld()
    this.panStartFocus.copy(this.focusTarget)
    this.panStartCamPos.copy(this.camera.position)
    this.panStartUnproject.multiplyMatrices(
      this.camera.matrixWorld,
      this.camera.projectionMatrixInverse,
    )

    const ndc = this.toNdc(event)
    const hit = this.rayToGround(
      ndc,
      this.panStartCamPos,
      this.panStartUnproject,
      this.panGrabPoint,
    )
    this.panValid = hit !== null
  }

  private updatePan(event: PointerEvent): void {
    if (!this.panValid) return
    const ndc = this.toNdc(event)
    const hit = this.rayToGround(
      ndc,
      this.panStartCamPos,
      this.panStartUnproject,
      this.scratchVec,
    )
    if (hit === null) return

    this.focusTarget
      .copy(this.panStartFocus)
      .sub(hit)
      .add(this.panGrabPoint)
    this.focusTarget.y = 0
    this.clampFocus(this.focusTarget)
  }

  private toNdc(event: PointerEvent, target = new Vector2()): Vector2 {
    const rect = this.canvas.getBoundingClientRect()
    return target.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    )
  }

  /** Intersect the ray through `ndc` with the y = 0 plane. */
  private rayToGround(
    ndc: Vector2,
    origin: Vector3,
    unproject: Matrix4,
    target: Vector3,
  ): Vector3 | null {
    this.scratchDir.set(ndc.x, ndc.y, 0.5).applyMatrix4(unproject).sub(origin)
    if (this.scratchDir.lengthSq() === 0) return null
    this.scratchDir.normalize()
    // Reject rays that are parallel to or pointing away from the floor.
    if (this.scratchDir.y > -1e-4) return null
    const t = -origin.y / this.scratchDir.y
    return target.copy(origin).addScaledVector(this.scratchDir, t)
  }

  private clampFocus(v: Vector3): void {
    v.x = clamp(v.x, -this.bounds, this.bounds)
    v.z = clamp(v.z, -this.bounds, this.bounds)
  }

  // ===========================================================================
  // Frame loop
  // ===========================================================================

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

    this.focusCurrent.lerp(this.focusTarget, k)
    this.distCurrent += (this.distTarget - this.distCurrent) * k
    this.azimuthCurrent += (this.azimuthTarget - this.azimuthCurrent) * k
    this.freeYawCurrent += (this.freeYawTarget - this.freeYawCurrent) * kReset
    this.freePitchCurrent += (this.freePitchTarget - this.freePitchCurrent) * kReset

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

    // With YXZ order, yaw = azimuth and pitch = -tilt reproduces lookAt(focus)
    // exactly, which lets the free-look offsets compose additively.
    this.euler.set(-pitch + this.freePitchCurrent, az + this.freeYawCurrent, 0, 'YXZ')
    this.camera.quaternion.setFromEuler(this.euler)
    this.camera.updateMatrixWorld()
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}
