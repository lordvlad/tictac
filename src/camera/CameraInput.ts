import { PinchGesture } from '@use-gesture/vanilla'
import { Vector2 } from 'three'
import { CAM } from '../config'
import { clamp } from '../core/math'

const MOUSE_LEFT = 0
const MOUSE_MIDDLE = 1
const MOUSE_RIGHT = 2

type DragMode = 'none' | 'pan' | 'orbit' | 'freelook'

/**
 * What the input layer is allowed to do to the camera.
 *
 * Deliberately small: input decides *that* the player wants to orbit, the rig
 * decides what orbiting means.
 */
export interface CameraRigTarget {
  readonly enabled: boolean
  /** Free-look toggle (mobile / no middle mouse button). */
  readonly freeLookMode: boolean
  readonly characterView: boolean
  /** Orbit distance the camera is easing towards. */
  zoom: number
  /** Orbit azimuth the camera is easing towards, in radians. */
  azimuth: number
  panBegin(clientX: number, clientY: number): void
  panUpdate(clientX: number, clientY: number): void
  panEnd(): void
  freeLookBy(dxPixels: number, dyPixels: number): void
  resetFreeLook(): void
}

/** Edge-pan push, each axis in [-1, 1]. */
export interface EdgePush {
  hx: number
  vy: number
}

/**
 * Every pointer, wheel and touch gesture that drives the camera.
 *
 *   left drag    pan the focus point across the floor ("grab the ground")
 *   right drag   orbit the azimuth about the focus point
 *   wheel        zoom, which also drives tilt along the arc
 *   middle drag  free-look: rotate in place without moving the camera
 *   one finger   pan, or free-look while that mode is toggled on
 *   two fingers  pinch to zoom, twist to orbit, drag to pan — all at once
 *
 * Two-finger input is recognised by `@use-gesture`'s PinchGesture rather than
 * hand-rolled touch bookkeeping: it owns the pointer pairing, distance/angle
 * math, rotation wrap-around and pointer-capture cleanup. Its state is applied
 * as absolute deltas from the values frozen at gesture start, so zoom, twist and
 * pan compose without accumulating drift.
 */
export class CameraInput {
  private dragMode: DragMode = 'none'
  private dragPointerId = -1
  private readonly lastPointer = new Vector2()
  /** Press origin and furthest travel from it, to tell a tap from a drag. */
  private readonly pressOrigin = new Vector2()
  private pressTravel = 0

  /** Live pointer ids, so a second finger can hand the gesture to the pinch recogniser. */
  private readonly activePointers = new Set<number>()

  private readonly pinchGesture: PinchGesture
  private pinchStartZoom = 0
  private pinchStartAzimuth = 0
  private pinching = false
  /** When the last camera gesture (drag or pinch) ended, for tap suppression. */
  private gestureEndTime = 0

  // Edge panning (cursor at the viewport border).
  private edgeClientX = 0
  private edgeClientY = 0
  private edgePointerIsMouse = false
  private edgePresent = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly rig: CameraRigTarget,
  ) {
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

    // `pinchOnWheel: false` keeps trackpad and wheel zoom entirely in `onWheel`,
    // which would otherwise double-apply.
    this.pinchGesture = new PinchGesture(
      canvas,
      ({ first, last, movement: [scale, angleDeg], origin: [originX, originY] }) => {
        this.applyPinch(first, last, scale, angleDeg, originX, originY)
      },
      { pinchOnWheel: false, eventOptions: { passive: false } },
    )
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('auxclick', this.preventDefault)
    window.removeEventListener('pointermove', this.onEdgeTrack)
    window.removeEventListener('blur', this.onEdgeLeave)
    document.removeEventListener('mouseleave', this.onEdgeLeave)
    this.pinchGesture.destroy()
  }

  /**
   * True while a camera gesture is in progress, and for `gestureClickGrace`
   * afterwards: both a drag-pan and a two-finger gesture still emit a trailing
   * `click`, which would otherwise order a move at whatever tile the finger
   * happened to lift.
   */
  get isDragging(): boolean {
    if (this.dragMode !== 'none' || this.pinching) return true
    return performance.now() - this.gestureEndTime < CAM.gestureClickGrace
  }

  /**
   * How hard the cursor is pushing against the viewport border, or null when
   * edge panning should not run (no mouse present, or a drag owns the pointer).
   */
  edgePush(): EdgePush | null {
    if (this.dragMode !== 'none' || this.pinching) return null
    if (!this.edgePresent || !this.edgePointerIsMouse) return null

    const margin = CAM.edgePanMargin
    if (margin <= 0) return null

    const rect = this.canvas.getBoundingClientRect()
    const x = this.edgeClientX - rect.left
    const y = this.edgeClientY - rect.top
    // Cursor fully off the canvas: nothing to do.
    if (x < -margin || y < -margin || x > rect.width + margin || y > rect.height + margin) {
      return null
    }

    let hx = 0
    let vy = 0
    if (x < margin) hx = -(margin - x) / margin
    else if (x > rect.width - margin) hx = (x - (rect.width - margin)) / margin
    // Screen top scrolls the view forward (into the distance); bottom pulls back.
    if (y < margin) vy = (margin - y) / margin
    else if (y > rect.height - margin) vy = -(y - (rect.height - margin)) / margin

    if (hx === 0 && vy === 0) return null
    return { hx: clamp(hx, -1, 1), vy: clamp(vy, -1, 1) }
  }

  // ---------------------------------------------------------------------------
  // Pointer / wheel
  // ---------------------------------------------------------------------------

  private readonly preventDefault = (event: Event): void => {
    event.preventDefault()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.rig.enabled) return

    this.activePointers.add(event.pointerId)

    try {
      this.canvas.setPointerCapture(event.pointerId)
    } catch {
      /* ignore synthetic/test events */
    }

    // A second finger turns this into a pinch: PinchGesture drives zoom, twist
    // and pan from here on, so any single-finger drag must let go.
    if (this.activePointers.size > 1) {
      this.dragMode = 'none'
      this.dragPointerId = -1
      return
    }

    if (this.dragMode !== 'none') return

    if (event.pointerType === 'mouse' && event.button === MOUSE_LEFT && event.shiftKey) {
      // Shift+left is reserved for waypoint placement.
      return
    }

    if (event.pointerType === 'touch' || event.button === MOUSE_LEFT) {
      this.dragMode = this.rig.freeLookMode ? 'freelook' : 'pan'
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
    this.pressOrigin.set(event.clientX, event.clientY)
    this.pressTravel = 0

    if (this.dragMode === 'pan') this.rig.panBegin(event.clientX, event.clientY)

    // Pan and orbit both put the camera back on the zoom-tilt arc.
    if (this.dragMode === 'pan' || this.dragMode === 'orbit') this.rig.resetFreeLook()
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.activePointers.has(event.pointerId)) return
    if (this.dragMode === 'none' || event.pointerId !== this.dragPointerId) return

    const dx = event.clientX - this.lastPointer.x
    const dy = event.clientY - this.lastPointer.y
    this.lastPointer.set(event.clientX, event.clientY)
    this.pressTravel = Math.max(
      this.pressTravel,
      Math.hypot(event.clientX - this.pressOrigin.x, event.clientY - this.pressOrigin.y),
    )

    if (this.dragMode === 'pan') {
      this.rig.panUpdate(event.clientX, event.clientY)
    } else if (this.dragMode === 'orbit') {
      this.rig.azimuth -= dx * CAM.rotateSpeed
    } else {
      this.rig.freeLookBy(dx, dy)
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

    if (event.pointerId !== this.dragPointerId) return
    // A press that travelled counts as a camera drag, not a tap: keep the
    // trailing `click` suppressed so panning never also orders a move.
    if (this.pressTravel > CAM.tapSlop) this.gestureEndTime = performance.now()
    this.dragMode = 'none'
    this.dragPointerId = -1
    this.pressTravel = 0
    this.rig.panEnd()
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.rig.enabled) return
    event.preventDefault()

    // Exponential zoom keeps the perceived step size constant at every scale.
    this.rig.zoom = clamp(
      this.rig.zoom * Math.exp(event.deltaY * CAM.zoomSpeed),
      CAM.distMin,
      CAM.distMax,
    )
    // Zooming re-derives tilt, so free-look must yield.
    this.rig.resetFreeLook()
  }

  private readonly onEdgeTrack = (event: PointerEvent): void => {
    this.edgeClientX = event.clientX
    this.edgeClientY = event.clientY
    this.edgePointerIsMouse = event.pointerType === 'mouse'
    this.edgePresent = true
  }

  private readonly onEdgeLeave = (): void => {
    this.edgePresent = false
  }

  // ---------------------------------------------------------------------------
  // Two-finger gesture
  // ---------------------------------------------------------------------------

  /**
   * `scale` is the finger-distance ratio since the gesture started, `angleDeg`
   * the twist since then, and (`originX`, `originY`) the live midpoint. Applying
   * absolute deltas from the frozen start values keeps a slow pinch from
   * accumulating rounding drift.
   */
  private applyPinch(
    first: boolean,
    last: boolean,
    scale: number,
    angleDeg: number,
    originX: number,
    originY: number,
  ): void {
    if (!this.rig.enabled) return

    if (first) {
      this.pinching = true
      this.pinchStartZoom = this.rig.zoom
      this.pinchStartAzimuth = this.rig.azimuth
      // Grab the ground under the midpoint, exactly like a left-drag pan.
      this.rig.panBegin(originX, originY)
    }

    // Spreading the fingers (ratio > 1) pulls the camera in. The ratio is
    // amplified, otherwise a phone-sized pinch barely moves through the range.
    if (scale > 0) {
      this.rig.zoom = clamp(
        this.pinchStartZoom / scale ** CAM.pinchZoomPower,
        CAM.distMin,
        CAM.distMax,
      )
    }

    // The ground turns with the fingers: `angleDeg` grows clockwise, and
    // orbiting the camera counter-clockwise is what makes the map follow.
    this.rig.azimuth =
      this.pinchStartAzimuth + ((angleDeg * Math.PI) / 180) * CAM.pinchRotateSpeed

    // The midpoint keeps holding the same ground point.
    this.rig.panUpdate(originX, originY)
    this.rig.resetFreeLook()

    if (last) {
      this.pinching = false
      this.gestureEndTime = performance.now()
      this.rig.panEnd()
    }
  }
}
