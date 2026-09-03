/**
 * The minimum DOM the renderer's canvas textures need under `bun test`.
 *
 * Only `createElement('canvas')` is taken over, and anything else delegates to
 * whatever `document` is already there, because several test files install
 * stubs of their own and none of them should depend on which ran first.
 */
export function installCanvasStub(): void {
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
    bezierCurveTo: () => {},
    rect: () => {},
    clip: () => {},
    fill: () => {},
    stroke: () => {},
    save: () => {},
    restore: () => {},
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
}
