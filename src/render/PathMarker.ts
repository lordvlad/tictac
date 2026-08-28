import {
  AdditiveBlending,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  type Material,
  Vector3,
} from 'three'
import Game from '@mavonengine/core/Game'
import { PATH } from '../config'

const CIRCLE_SEGMENTS = 48

/**
 * 3D visualisation of the movement planner. Replaces per-tile ground painting:
 *
 *  - the path is a single glowing green polyline floating ~25 cm above the floor;
 *  - each waypoint is a floating circle on a short beacon pole;
 *  - the goal is two concentric floating circles on a pole rising to eye height.
 *
 * Everything is drawn with additive, depth-write-disabled line materials so the
 * markers read as radiating light rather than solid geometry, and pulses gently
 * via {@link update}.
 */
export class PathMarker {
  private readonly group = new Group()
  private readonly geometries: BufferGeometry[] = []
  private readonly materials: Material[] = []
  /** Materials whose opacity pulses, paired with their peak opacity. */
  private readonly pulses: { material: LineBasicMaterial; peak: number }[] = []
  private clock = 0

  constructor() {
    this.group.renderOrder = 10
    Game.instance().scene.add(this.group)
  }

  /**
   * Rebuild the overlay. `path`, `waypoints` and `goal` are floor-level tile
   * centres (y = 0); the hover height is applied here.
   */
  show(path: Vector3[], waypoints: Vector3[], goal: Vector3, valid: boolean): void {
    const beaconColor = valid ? PATH.colorValid : PATH.colorInvalid

    if (path.length >= 2) {
      const points = path.map((p) => new Vector3(p.x, PATH.lineHover, p.z))
      this.group.add(this.line(points, beaconColor, 0.9))
    }

    for (const wp of waypoints) {
      this.beacon(wp, PATH.waypointHeight, [PATH.waypointRadius], PATH.colorWaypoint)
    }

    this.beacon(goal, PATH.goalHeight, [PATH.goalInnerRadius, PATH.goalOuterRadius], beaconColor)
  }

  /** Green foot circle marking the selected unit, at marker hover height. */
  showSelection(base: Vector3): void {
    this.group.add(this.ring(base, PATH.selectionRadius, PATH.colorValid))
  }

  /** A floating circle (or circles) at hover height plus a vertical beacon pole. */
  private beacon(base: Vector3, height: number, radii: number[], color: number): void {
    for (const radius of radii) this.group.add(this.ring(base, radius, color))
    const pole = [new Vector3(base.x, PATH.hover, base.z), new Vector3(base.x, height, base.z)]
    this.group.add(this.line(pole, color, 0.75))
  }

  /** A single horizontal circle at marker hover height, centred on `base`. */
  private ring(base: Vector3, radius: number, color: number): LineLoop {
    const points: Vector3[] = []
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2
      points.push(new Vector3(base.x + Math.cos(a) * radius, PATH.hover, base.z + Math.sin(a) * radius))
    }
    const geometry = new BufferGeometry().setFromPoints(points)
    this.geometries.push(geometry)
    return new LineLoop(geometry, this.material(color, 0.95))
  }

  private line(points: Vector3[], color: number, peak: number): Line {
    const geometry = new BufferGeometry().setFromPoints(points)
    this.geometries.push(geometry)
    return new Line(geometry, this.material(color, peak))
  }

  private material(color: number, peak: number): LineBasicMaterial {
    const material = new LineBasicMaterial({
      color,
      transparent: true,
      opacity: peak,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
    this.materials.push(material)
    this.pulses.push({ material, peak })
    return material
  }

  /** Gentle radiating pulse. Call once per frame. */
  update(delta: number): void {
    if (this.pulses.length === 0) return
    this.clock += delta
    const factor = 0.65 + 0.35 * Math.sin(this.clock * 4)
    for (const { material, peak } of this.pulses) material.opacity = peak * factor
  }

  clear(): void {
    this.group.clear()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.geometries.length = 0
    this.materials.length = 0
    this.pulses.length = 0
    this.clock = 0
  }

  dispose(): void {
    this.clear()
    Game.instance().scene.remove(this.group)
  }
}
