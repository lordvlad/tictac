import { describe, expect, test } from 'bun:test'
import { PerspectiveCamera, Vector3 } from 'three'
import { CameraInput, type CameraRigTarget } from '../src/camera/CameraInput'
import { OrbitRig } from '../src/camera/OrbitRig'
import { CAM } from '../src/config'
import { installCanvasStub } from './support/dom'

if (typeof globalThis.requestAnimationFrame === 'undefined') {
  // The rig drives itself off rAF; the tests step it by hand instead.
  globalThis.requestAnimationFrame = (() => 0) as unknown as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
}

installCanvasStub()

if (typeof globalThis.PointerEvent === 'undefined') {
  class MockPointerEvent extends Event {
    pointerId: number
    pointerType: string
    clientX: number
    clientY: number
    button: number

    constructor(type: string, dict: Record<string, unknown> = {}) {
      super(type, dict)
      this.pointerId = (dict.pointerId as number) ?? 1
      this.pointerType = (dict.pointerType as string) ?? 'touch'
      this.clientX = (dict.clientX as number) ?? 0
      this.clientY = (dict.clientY as number) ?? 0
      this.button = (dict.button as number) ?? 0
    }
  }
  globalThis.PointerEvent = MockPointerEvent as unknown as typeof PointerEvent
}

class MockRig implements CameraRigTarget {
  enabled = true
  freeLookMode = false
  shoulderView = false
  zoom = 22
  azimuth = 0.6
  panned = false
  freelookDx = 0
  freelookDy = 0

  panBegin(): void {
    this.panned = true
  }
  panUpdate(): void {}
  panEnd(): void {}

  freeLookBy(dxPixels: number, dyPixels: number): void {
    this.freelookDx += dxPixels
    this.freelookDy += dyPixels
  }
  resetFreeLook(): void {}
}

function createMockCanvas(): HTMLCanvasElement {
  const listeners: Record<string, ((e: Event) => void)[]> = {}
  return {
    addEventListener: (type: string, listener: (e: Event) => void) => {
      if (!listeners[type]) listeners[type] = []
      listeners[type]!.push(listener)
    },
    removeEventListener: (type: string, listener: (e: Event) => void) => {
      if (!listeners[type]) return
      listeners[type] = listeners[type]!.filter((l) => l !== listener)
    },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    dispatchEvent: (event: Event) => {
      const list = listeners[event.type]
      if (list) {
        for (const l of list) l(event)
      }
      return true
    },
  } as unknown as HTMLCanvasElement
}

describe('CameraInput mobile & over-the-shoulder controls', () => {
  test('single finger touch drag turns and yaws camera in over-the-shoulder view', () => {
    const canvas = createMockCanvas()
    const rig = new MockRig()
    rig.shoulderView = true

    const input = new CameraInput(canvas, rig)

    // Touch pointer down
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 100,
        clientY: 100,
      })
    )

    // Touch pointer move
    canvas.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 150,
        clientY: 120,
      })
    )

    expect(rig.freelookDx).toBe(50)
    expect(rig.freelookDy).toBe(20)
    expect(rig.panned).toBe(false)

    input.dispose()
  })

  test('two finger gestures are ignored when over-the-shoulder view is active', () => {
    const canvas = createMockCanvas()
    const rig = new MockRig()
    rig.shoulderView = true
    rig.zoom = 22
    rig.azimuth = 0.6

    const input = new CameraInput(canvas, rig)

    const initialZoom = rig.zoom
    const initialAzimuth = rig.azimuth

    const privateInput = input as unknown as {
      applyPinch: (
        first: boolean,
        last: boolean,
        scale: number,
        angleDeg: number,
        originX: number,
        originY: number
      ) => void
    }

    privateInput.applyPinch(true, false, 2.0, 45, 100, 100)

    expect(rig.zoom).toBe(initialZoom)
    expect(rig.azimuth).toBe(initialAzimuth)

    input.dispose()
  })
})

/** Step the rig's smoothing to rest, the way a second of frames would. */
function settle(rig: OrbitRig): void {
  const stepper = rig as unknown as { update: (delta: number) => void }
  for (let i = 0; i < 120; i++) stepper.update(1 / 60)
}

describe('over-the-shoulder framing', () => {
  const unit = new Vector3(4, 0, -2)
  /** Unit facing +X: yaw is measured as atan2(dx, dz). */
  const facing = Math.PI / 2

  function shoulderRig(): { rig: OrbitRig; camera: PerspectiveCamera } {
    const camera = new PerspectiveCamera(50, 1.5, 0.1, 100)
    const rig = new OrbitRig(camera, createMockCanvas(), { bounds: 18 })
    rig.enterShoulderView(unit, facing)
    settle(rig)
    return { rig, camera }
  }

  test('aiming a shot centres the target and keeps the shooter in frame', () => {
    const camera = new PerspectiveCamera(50, 1.5, 0.1, 100)
    const rig = new OrbitRig(camera, createMockCanvas(), { bounds: 18 })
    // Target off to one side and a storey up, so both angles have work to do.
    const target = new Vector3(11, 2, 1)
    rig.enterShoulderView(unit, facing, target)
    settle(rig)

    // The solve runs from the camera's own seat, not the pivot: the 3.8 m arm
    // offset to one side would otherwise leave the target degrees off centre.
    const aimNdc = target.clone().project(camera)
    expect(Math.abs(aimNdc.x)).toBeLessThan(0.02)
    expect(Math.abs(aimNdc.y)).toBeLessThan(0.02)

    // The shooter is still on screen — that is what makes it a shoulder view.
    const chest = new Vector3(unit.x, unit.y + CAM.shoulderPivotHeight, unit.z)
    const chestNdc = chest.clone().project(camera)
    expect(Math.abs(chestNdc.x)).toBeLessThan(1)
    expect(Math.abs(chestNdc.y)).toBeLessThan(1)

    rig.dispose()
  })

  test('camera sits behind the unit with the unit in frame', () => {
    const { rig, camera } = shoulderRig()

    // Behind: the camera is on the opposite side of the unit from its facing.
    const toCamera = new Vector3().subVectors(camera.position, unit)
    expect(toCamera.x).toBeLessThan(0)
    expect(camera.position.y).toBeGreaterThan(unit.y + CAM.shoulderPivotHeight)

    // In frame: the unit's chest is in front of the camera, near screen centre.
    const chest = new Vector3(unit.x, unit.y + CAM.shoulderPivotHeight, unit.z)
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const toChest = new Vector3().subVectors(chest, camera.position)
    expect(toChest.length()).toBeCloseTo(Math.hypot(CAM.shoulderBack, CAM.shoulderSide), 1)
    expect(forward.dot(toChest.clone().normalize())).toBeGreaterThan(0.95)

    // Off-centre, not masking the middle of the screen.
    const ndc = chest.clone().project(camera)
    expect(Math.abs(ndc.x)).toBeGreaterThan(0.05)
    expect(Math.abs(ndc.x)).toBeLessThan(0.6)
    expect(Math.abs(ndc.y)).toBeLessThan(0.6)

    rig.dispose()
  })

  test('look drag orbits the unit past its face and keeps going', () => {
    const { rig, camera } = shoulderRig()
    const bearing = (): number =>
      Math.atan2(camera.position.x - unit.x, camera.position.z - unit.z)

    const start = bearing()
    // Well past the old +/-pi clamp: three quarters of a turn, then another.
    const quarterTurn = Math.PI / 2 / CAM.shoulderLookSpeed
    rig.freeLookBy(quarterTurn * 3, 0)
    settle(rig)
    const threeQuarters = bearing()
    rig.freeLookBy(quarterTurn * 3, 0)
    settle(rig)

    const turned = (from: number, to: number): number => {
      const d = to - from
      return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)))
    }
    expect(turned(start, threeQuarters)).toBeCloseTo(Math.PI / 2, 1)
    expect(turned(threeQuarters, bearing())).toBeCloseTo(Math.PI / 2, 1)

    // Still an orbit of the unit, and still looking at it.
    const chest = new Vector3(unit.x, unit.y + CAM.shoulderPivotHeight, unit.z)
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const toChest = new Vector3().subVectors(chest, camera.position)
    expect(toChest.length()).toBeCloseTo(Math.hypot(CAM.shoulderBack, CAM.shoulderSide), 1)
    expect(forward.dot(toChest.normalize())).toBeGreaterThan(0.95)

    rig.dispose()
  })

  test('looking straight up shortens the boom instead of sinking through the floor', () => {
    const { rig, camera } = shoulderRig()

    // Drag far past the pitch limit: the clamp, not the drag, decides.
    rig.freeLookBy(0, 4000)
    settle(rig)
    expect(camera.position.y).toBeGreaterThanOrEqual(unit.y + CAM.shoulderMinHeight - 1e-6)
    expect(rig.tilt).toBeGreaterThanOrEqual(CAM.shoulderPitchMin - 1e-6)

    rig.freeLookBy(0, -8000)
    settle(rig)
    expect(rig.tilt).toBeLessThanOrEqual(CAM.shoulderPitchMax + 1e-6)

    rig.dispose()
  })

  test('exiting returns the focus to the storey the unit stands on', () => {
    const { rig } = shoulderRig()
    rig.freeLookBy(900, 0)
    settle(rig)

    rig.exitShoulderView()
    settle(rig)

    expect(rig.isShoulderViewActive).toBe(false)
    expect(rig.focusPoint.y).toBeCloseTo(unit.y, 2)
    expect(rig.focusPoint.x).toBeCloseTo(unit.x, 1)
    expect(rig.distance).toBeCloseTo(CAM.distStart, 1)

    rig.dispose()
  })
})
