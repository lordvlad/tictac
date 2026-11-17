import { describe, expect, test } from 'bun:test'
import { Scene } from 'three'
import { generateMap } from '../src/core/MapGenerator'
import type { EngineContext } from '../src/engine'
import { Battlefield } from '../src/client/Battlefield'
import { installCanvasStub } from './support/dom'

installCanvasStub()

describe('Battlefield lifecycle', () => {
  test('rebuilding it leaves the scene as a fresh build would, not brighter', () => {
    const scene = new Scene()
    const engine = { scene } as unknown as EngineContext
    const map = generateMap(7)

    const fresh = new Battlefield(map, engine)
    const freshChildren = scene.children.length
    fresh.dispose()
    expect(scene.children).toHaveLength(0)
    expect(scene.background).toBeNull()
    expect(scene.fog).toBeNull()

    for (let i = 0; i < 3; i++) {
      const field = new Battlefield(generateMap(7), engine)
      expect(scene.children).toHaveLength(freshChildren)
      field.dispose()
    }
    expect(scene.children).toHaveLength(0)
    expect(scene.background).toBeNull()
    expect(scene.fog).toBeNull()
  })
})
