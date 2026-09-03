import { describe, expect, test } from 'bun:test'
import { Line, LineLoop, Scene, Sprite, Vector3 } from 'three'
import { PATH } from '../src/config'
import { CoverLevel } from '../src/core/Walls'
import { PathMarker } from '../src/render/PathMarker'

// PathMarker draws its cover shields and AP plate onto canvas textures, so it
// needs just enough DOM to build them. Only the texture helpers touch
// `document`, and they run at call time, so installing this here is early
// enough.
//
// Another test file may already have installed a `document` of its own, so
// only `createElement('canvas')` is taken over and everything else delegates.
// Guarding on `document === undefined` instead would leave this file depending
// on which test ran first.
{
  const ctx = {
    clearRect: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    arcTo: () => {},
    quadraticCurveTo: () => {},
    fill: () => {},
    stroke: () => {},
    save: () => {},
    restore: () => {},
    rect: () => {},
    clip: () => {},
    translate: () => {},
    scale: () => {},
    measureText: () => ({ width: 10 }),
    fillText: () => {},
    strokeText: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    set fillStyle(_v: unknown) {},
    set strokeStyle(_v: unknown) {},
    set lineWidth(_v: unknown) {},
    set font(_v: unknown) {},
    set textAlign(_v: unknown) {},
    set textBaseline(_v: unknown) {},
    set lineJoin(_v: unknown) {},
  }
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  const existing = globalThis.document as Document | undefined
  const createElement = (tag: string): unknown =>
    tag === 'canvas' ? canvas : existing?.createElement.call(existing, tag)

  if (existing === undefined) {
    globalThis.document = { createElement } as unknown as Document
  } else {
    Object.defineProperty(existing, 'createElement', { value: createElement, configurable: true })
  }
}

if (typeof globalThis.Path2D === 'undefined') {
  class Path2DStub {
    moveTo(): void {}
    lineTo(): void {}
    quadraticCurveTo(): void {}
    bezierCurveTo(): void {}
    arc(): void {}
    arcTo(): void {}
    closePath(): void {}
    rect(): void {}
  }
  globalThis.Path2D = Path2DStub as unknown as typeof Path2D
}

interface Probe {
  /** Y of every sprite (AP plate, cover shields). */
  sprites: number[]
  /** Y range of every closed circle (goal and waypoint rings). */
  rings: { min: number; max: number }[]
  /** Y range of every open polyline (route and beacon poles). */
  lines: { min: number; max: number }[]
}

function probe(scene: Scene): Probe {
  const out: Probe = { sprites: [], rings: [], lines: [] }
  scene.traverse((o) => {
    if (o instanceof Sprite) {
      out.sprites.push(o.position.y)
      return
    }
    if (!(o instanceof LineLoop) && !(o instanceof Line)) return
    const pos = o.geometry.getAttribute('position')
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      if (y < min) min = y
      if (y > max) max = y
    }
    ;(o instanceof LineLoop ? out.rings : out.lines).push({ min, max })
  })
  return out
}

describe('PathMarker sits on the target storey', () => {
  test('every part of the goal marker is measured from the goal floor', () => {
    const scene = new Scene()
    const marker = new PathMarker({ scene } as never)

    const floor = 4 // two storeys up, at LEVEL_HEIGHT 2
    const goal = new Vector3(1, floor, 2)
    marker.show([new Vector3(0, floor, 2), goal], [], goal, true, [CoverLevel.Tall], 6)

    const seen = probe(scene)

    // Goal rings hover just above the floor they are drawn on.
    expect(seen.rings.length).toBeGreaterThan(0)
    for (const ring of seen.rings) {
      expect(ring.min).toBeCloseTo(floor + PATH.hover)
      expect(ring.max).toBeCloseTo(floor + PATH.hover)
    }

    // The beacon pole rises from that floor, not from the ground. It is the
    // tallest line drawn; the route itself stays flat at hover height.
    const pole = seen.lines.reduce((tallest, l) => (l.max > tallest.max ? l : tallest))
    expect(pole.min).toBeCloseTo(floor + PATH.hover)
    expect(pole.max).toBeCloseTo(floor + PATH.goalHeight)

    // The AP plate floats above the pole, and the shield stands on the floor.
    expect(seen.sprites).toContain(floor + PATH.goalHeight + PATH.labelRise)
    expect(seen.sprites).toContain(floor + PATH.shieldHeight)
    // Nothing was left down at ground level.
    for (const y of seen.sprites) expect(y).toBeGreaterThan(floor)

    marker.dispose()
  })

  test('a ground-level goal still sits on the ground', () => {
    const scene = new Scene()
    const marker = new PathMarker({ scene } as never)

    const goal = new Vector3(0, 0, 0)
    marker.show([new Vector3(1, 0, 0), goal], [], goal, true, [CoverLevel.Low], 3)

    const seen = probe(scene)
    expect(seen.sprites).toContain(PATH.goalHeight + PATH.labelRise)
    expect(seen.sprites).toContain(PATH.shieldHeight)

    marker.dispose()
  })
})
