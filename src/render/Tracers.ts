import {
  BufferGeometry,
  Color,
  Line,
  LineBasicMaterial,
  PointLight,
  Vector3,
} from 'three'
import Game from '@mavonengine/core/Game'
import { EYE_HEIGHT } from '../config'

export class Tracers {
  private activeTracers: { line: Line; light: PointLight; age: number; duration: number }[] = []

  spawnTracer(fromWorld: Vector3, toWorld: Vector3, hit: boolean): void {
    const scene = Game.instance().scene

    const origin = fromWorld.clone().add(new Vector3(0, EYE_HEIGHT, 0))
    const target = toWorld.clone().add(new Vector3(0, EYE_HEIGHT, 0))

    if (!hit) {
      // Offset missed shots slightly past or to the side of target
      target.x += (Math.random() - 0.5) * 1.5
      target.z += (Math.random() - 0.5) * 1.5
    }

    const geometry = new BufferGeometry().setFromPoints([origin, target])
    const material = new LineBasicMaterial({
      color: 0xffe066,
      linewidth: 2,
    })

    const line = new Line(geometry, material)
    scene.add(line)

    const light = new PointLight(0xffaa22, 5, 4)
    light.position.copy(origin)
    scene.add(light)

    this.activeTracers.push({ line, light, age: 0, duration: 0.15 })
  }

  update(delta: number): void {
    const scene = Game.instance().scene

    for (let i = this.activeTracers.length - 1; i >= 0; i--) {
      const tracer = this.activeTracers[i]!
      tracer.age += delta

      if (tracer.age >= tracer.duration) {
        scene.remove(tracer.line)
        scene.remove(tracer.light)
        tracer.line.geometry.dispose()
        ;(tracer.line.material as LineBasicMaterial).dispose()
        tracer.light.dispose()
        this.activeTracers.splice(i, 1)
      } else {
        // Fade light
        tracer.light.intensity = 5 * (1 - tracer.age / tracer.duration)
      }
    }
  }

  dispose(): void {
    const scene = Game.instance().scene
    for (const tracer of this.activeTracers) {
      scene.remove(tracer.line)
      scene.remove(tracer.light)
      tracer.line.geometry.dispose()
      ;(tracer.line.material as LineBasicMaterial).dispose()
      tracer.light.dispose()
    }
    this.activeTracers = []
  }
}
