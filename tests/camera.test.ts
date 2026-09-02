import { describe, expect, test } from 'bun:test'
import { CameraInput, type CameraRigTarget } from '../src/camera/CameraInput'

if (typeof globalThis.window === 'undefined') {
  const dummyTarget = {
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.window = dummyTarget as unknown as Window & typeof globalThis
  globalThis.document = dummyTarget as unknown as Document & typeof globalThis
}

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
