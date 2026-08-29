import { Euler, Matrix4, PerspectiveCamera, Vector2, Vector3 } from 'three'
import { CAM, EYE_HEIGHT } from '../config'

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

  // --- drag & touch bookkeeping ---------------------------------------------
  private dragMode: DragMode | 'touch2' = 'none'
  private dragPointerId = -1
  private readonly lastPointer = new Vector2()

  /** Map of active pointers for multi-touch gesture support. */
  private readonly activePointers = new Map<number, { x: number; y: number; type: string }>()
  private touchStartDist = 0
  private touchStartAngle = 0
  private touchStartCenter = new Vector2()

  /** Camera state frozen at pan start, so panning cannot feed back on itself. */
  private readonly panStartFocus = new Vector3()
  private readonly panStartCamPos = new Vector3()
  private readonly panStartUnproject = new Matrix4()
  private readonly panGrabPoint = new Vector3()
  private panValid = false

  // --- edge panning (cursor at the viewport border) -------------------------
  private edgeClientX = 0
  private edgeClientY = 0
  private edgePointerIsMouse = false
  private edgePresent = false

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
    // Edge panning tracks the cursor across the whole viewport (window level, so
    // it keeps working while the cursor hovers HUD panels at the screen border).
    window.addEventListener('pointermove', this.onEdgeTrack)
    window.addEventListener('blur', this.onEdgeLeave)
    document.addEventListener('mouseleave', this.onEdgeLeave)

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
    window.removeEventListener('pointermove', this.onEdgeTrack)
    window.removeEventListener('blur', this.onEdgeLeave)
    document.removeEventListener('mouseleave', this.onEdgeLeave)
  }

  /**
   * Enter first-person / eye-level view for a selected character.
   * Camera moves to character's eye position looking outward in character's facing direction.
   */
  enterCharacterView(position: Vector3, yaw: number): void {
    this.isCharacterView = true
    this.freeLookToggleActive = true

    const camYaw = yaw + Math.PI
    const forwardX = Math.sin(yaw) * 0.15
    const forwardZ = Math.cos(yaw) * 0.15

    this.eyePositionTarget.set(
      position.x + forwardX,
      position.y + EYE_HEIGHT,
      position.z + forwardZ,
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
    const camYaw = yaw + Math.PI
    const forwardX = Math.sin(yaw) * 0.15
    const forwardZ = Math.cos(yaw) * 0.15
    this.eyePositionTarget.set(
      position.x + forwardX,
      position.y + EYE_HEIGHT,
      position.z + forwardZ,
    )
    this.azimuthTarget = camYaw
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

  /**
   * Current downward tilt of the camera below the horizon, in radians.
   * Combines the zoom-tilt arc with the additive free-look pitch offset;
   * character view sits at ~0 (horizontal). Used by the wall x-ray fade.
   */
  get tilt(): number {
    const base = this.isCharacterView ? 0 : this.pitchForDistance(this.distCurrent)
    return base - this.freePitchCurrent
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

    this.activePointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      type: event.pointerType,
    })

    try {
      this.canvas.setPointerCapture(event.pointerId)
    } catch {
      /* ignore synthetic/test events */
    }

    // --- Multi-touch gestures (touchscreen) -----------------------------------
    if (this.activePointers.size === 2) {
      const [p1, p2] = Array.from(this.activePointers.values())
      if (p1 && p2) {
        this.dragMode = 'touch2'
        this.touchStartDist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
        this.touchStartAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
        this.touchStartCenter.set((p1.x + p2.x) / 2, (p1.y + p2.y) / 2)

        // Initialize 2-finger pan grab point from center of touch
        this.beginPanAtPoint(this.touchStartCenter)
        this.resetFreeLook()
        event.preventDefault()
        return
      }
    }

    if (this.dragMode !== 'none') return

    if (event.pointerType === 'mouse' && event.button === MOUSE_LEFT && event.shiftKey) {
      // Shift+left is reserved for waypoint placement.
      return
    }

    if (event.pointerType === 'touch') {
      // Single finger touch drag = freelook or pan depending on toggle
      this.dragMode = this.freeLookToggleActive ? 'freelook' : 'pan'
    } else if (event.button === MOUSE_LEFT) {
      this.dragMode = this.freeLookToggleActive ? 'freelook' : 'pan'
    } else if (event.button === MOUSE_RIGHT) {
      this.dragMode = 'orbit'
    } else if (event.button === MOUSE_MIDDLE) {
      this.dragMode = 'freelook'
    } else {
      return
    }

    event.preventDefault()
    this.dragPointerId = event.pointerId
    this.lastPointer.set(event.clientX, event.clientY)

    if (this.dragMode === 'pan') this.beginPan(event)

    // Pan and orbit both put the camera back on the zoom-tilt arc.
    if (this.dragMode === 'pan' || this.dragMode === 'orbit') this.resetFreeLook()
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.activePointers.has(event.pointerId)) return

    // Update active pointer position
    this.activePointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      type: event.pointerType,
    })

    // --- 2-Finger Touch Gestures (Pinch zoom, turn rotate, 2-finger pan) ------
    if (this.dragMode === 'touch2' && this.activePointers.size === 2) {
      const [p1, p2] = Array.from(this.activePointers.values())
      if (p1 && p2) {
        // 1. Pinch to zoom
        const currDist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
        if (this.touchStartDist > 0 && currDist > 0) {
          const factor = this.touchStartDist / currDist
          this.distTarget = clamp(this.distTarget * factor, CAM.distMin, CAM.distMax)
          this.touchStartDist = currDist
        }

        // 2. Two-finger turn to rotate azimuth
        const currAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
        let deltaAngle = currAngle - this.touchStartAngle
        while (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2
        while (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2
        this.azimuthTarget -= deltaAngle
        this.touchStartAngle = currAngle

        // 3. Two-finger pan
        const currCenter = new Vector2((p1.x + p2.x) / 2, (p1.y + p2.y) / 2)
        this.updatePanAtPoint(currCenter)

        this.resetFreeLook()
        event.preventDefault()
        return
      }
    }

    if (this.dragMode === 'none' || event.pointerId !== this.dragPointerId) return

    const dx = event.clientX - this.lastPointer.x
    const dy = event.clientY - this.lastPointer.y
    this.lastPointer.set(event.clientX, event.clientY)

    if (this.dragMode === 'pan') {
      this.updatePan(event)
    } else if (this.dragMode === 'orbit') {
      this.azimuthTarget -= dx * CAM.rotateSpeed
    } else if (this.dragMode === 'freelook') {
      const yawLimit = this.isCharacterView ? Math.PI : CAM.freeYawLimit
      const pitchLimit = this.isCharacterView ? (82 * Math.PI) / 180 : CAM.freePitchLimit

      this.freeYawTarget = clamp(
        this.freeYawTarget - dx * CAM.freeLookSpeed,
        -yawLimit,
        yawLimit,
      )
      this.freePitchTarget = clamp(
        this.freePitchTarget - dy * CAM.freeLookSpeed,
        -pitchLimit,
        pitchLimit,
      )
    }
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId)

    try {
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId)
      }
    } catch {
      /* ignore */
    }

    if (this.dragMode === 'touch2') {
      if (this.activePointers.size < 2) {
        this.dragMode = 'none'
        this.panValid = false
      }
      return
    }

    if (event.pointerId !== this.dragPointerId) return
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
  // Edge panning (cursor at the viewport border)
  // ===========================================================================

  private readonly onEdgeTrack = (event: PointerEvent): void => {
    this.edgeClientX = event.clientX
    this.edgeClientY = event.clientY
    this.edgePointerIsMouse = event.pointerType === 'mouse'
    this.edgePresent = true
  }

  private readonly onEdgeLeave = (): void => {
    this.edgePresent = false
  }

  /**
   * Scroll the focus point when the cursor sits inside the border band, RTS
   * style. Direction is taken from the current azimuth so screen-up maps to the
   * camera's ground-forward and screen-right to its ground-right; speed scales
   * with zoom distance and ramps up the deeper into the band the cursor is.
   */
  private applyEdgePan(delta: number): void {
    if (!this.enabled || this.dragMode !== 'none' || this.isFreeLookActive) return
    if (!this.edgePresent || !this.edgePointerIsMouse) return

    const margin = CAM.edgePanMargin
    if (margin <= 0) return

    const rect = this.canvas.getBoundingClientRect()
    const x = this.edgeClientX - rect.left
    const y = this.edgeClientY - rect.top
    // Cursor fully off the canvas: nothing to do.
    if (x < -margin || y < -margin || x > rect.width + margin || y > rect.height + margin) return

    let hx = 0
    let vy = 0
    if (x < margin) hx = -(margin - x) / margin
    else if (x > rect.width - margin) hx = (x - (rect.width - margin)) / margin
    // Screen top scrolls the view forward (into the distance); bottom pulls back.
    if (y < margin) vy = (margin - y) / margin
    else if (y > rect.height - margin) vy = -(y - (rect.height - margin)) / margin

    if (hx === 0 && vy === 0) return
    hx = clamp(hx, -1, 1)
    vy = clamp(vy, -1, 1)

    const az = this.azimuthCurrent
    const forwardX = -Math.sin(az)
    const forwardZ = -Math.cos(az)
    const rightX = Math.cos(az)
    const rightZ = -Math.sin(az)

    const step = CAM.edgePanSpeed * this.distCurrent * delta
    this.focusTarget.x += (rightX * hx + forwardX * vy) * step
    this.focusTarget.z += (rightZ * hx + forwardZ * vy) * step
    this.clampFocus(this.focusTarget)
    // Panning re-seats the camera on the zoom-tilt arc, like drag-pan does.
    this.resetFreeLook()
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
    this.beginPanAtPoint(new Vector2(event.clientX, event.clientY))
  }

  private beginPanAtPoint(clientPos: Vector2): void {
    this.camera.updateMatrixWorld()
    this.panStartFocus.copy(this.focusTarget)
    this.panStartCamPos.copy(this.camera.position)
    this.panStartUnproject.multiplyMatrices(
      this.camera.matrixWorld,
      this.camera.projectionMatrixInverse,
    )

    const ndc = this.toNdcFromClient(clientPos.x, clientPos.y)
    const hit = this.rayToGround(
      ndc,
      this.panStartCamPos,
      this.panStartUnproject,
      this.panGrabPoint,
    )
    this.panValid = hit !== null
  }

  private updatePan(event: PointerEvent): void {
    this.updatePanAtPoint(new Vector2(event.clientX, event.clientY))
  }

  private updatePanAtPoint(clientPos: Vector2): void {
    if (!this.panValid) return
    const ndc = this.toNdcFromClient(clientPos.x, clientPos.y)
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
    return this.toNdcFromClient(event.clientX, event.clientY, target)
  }

  private toNdcFromClient(clientX: number, clientY: number, target = new Vector2()): Vector2 {
    const rect = this.canvas.getBoundingClientRect()
    return target.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
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
      this.camera.position.copy(this.eyePositionCurrent)
      const az = this.azimuthCurrent
      const pitch = 0 // Horizontal level look
      this.euler.set(-pitch + this.freePitchCurrent, az + this.freeYawCurrent, 0, 'YXZ')
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
