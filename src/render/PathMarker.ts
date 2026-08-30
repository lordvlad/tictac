import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  type Material,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
} from 'three'
import type { EngineContext } from '../engine'
import { PATH } from '../config'
import { CoverLevel, COVER_DIRS } from '../core/Cover'

const CIRCLE_SEGMENTS = 48

/**
 * 3D visualisation of the movement planner. Replaces per-tile ground painting:
 *
 *  - the path is a single glowing green polyline floating ~5 cm above the floor;
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
  private readonly textures: Texture[] = []
  /** Materials whose opacity pulses, paired with their peak opacity. */
  private readonly pulses: { material: LineBasicMaterial; peak: number }[] = []
  private clock = 0

  constructor(private readonly engine: EngineContext) {
    this.group.renderOrder = 10
    engine.scene.add(this.group)
  }

  /**
   * Rebuild the overlay. `path`, `waypoints` and `goal` are floor-level tile
   * centres (y = 0); the hover height is applied here. `coverLevels`, aligned to
   * {@link COVER_DIRS}, adds a directional cover shield on each protected side
   * of the goal tile.
   */
  show(
    path: Vector3[],
    waypoints: Vector3[],
    goal: Vector3,
    valid: boolean,
    coverLevels?: readonly CoverLevel[],
  ): void {
    const beaconColor = valid ? PATH.colorValid : PATH.colorInvalid

    if (path.length >= 2) {
      const points = path.map((p) => new Vector3(p.x, PATH.hover, p.z))
      this.group.add(this.line(points, beaconColor, 0.9))
    }

    for (const wp of waypoints) {
      this.beacon(wp, PATH.waypointHeight, [PATH.waypointRadius], PATH.colorWaypoint)
    }

    this.beacon(goal, PATH.goalHeight, [PATH.goalInnerRadius, PATH.goalOuterRadius], beaconColor)

    if (coverLevels) {
      COVER_DIRS.forEach(([dx, dy], i) => {
        const level = coverLevels[i]
        if (level) this.shield(goal, dx, dy, level === CoverLevel.Tall)
      })
    }
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

  /** Camera-facing cover shield sprite on one side of the goal tile. */
  private shield(goal: Vector3, dx: number, dy: number, filled: boolean): void {
    const texture = shieldTexture(filled)
    this.textures.push(texture)
    const mat = new SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.materials.push(mat)
    const sprite = new Sprite(mat)
    sprite.position.set(goal.x + dx * 0.5, 0.55, goal.z + dy * 0.5)
    sprite.scale.set(0.5, 0.5, 1)
    sprite.renderOrder = 11
    this.group.add(sprite)
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
    for (const texture of this.textures) texture.dispose()
    this.geometries.length = 0
    this.materials.length = 0
    this.textures.length = 0
    this.pulses.length = 0
    this.clock = 0
  }

  dispose(): void {
    this.clear()
    this.engine.scene.remove(this.group)
  }
}

/**
 * Draw a shield glyph to a canvas texture: outlined and fully filled for tall
 * cover, outlined with only the lower half filled for low cover.
 */
function shieldTexture(filled: boolean): CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const green = '#66ff99'

  const shield = new Path2D()
  shield.moveTo(10, 12)
  shield.lineTo(54, 12)
  shield.lineTo(54, 34)
  shield.quadraticCurveTo(54, 50, 32, 58)
  shield.quadraticCurveTo(10, 50, 10, 34)
  shield.closePath()

  ctx.fillStyle = 'rgba(102, 255, 153, 0.85)'
  if (filled) {
    ctx.fill(shield)
  } else {
    // Low cover: fill only the bottom half of the shield.
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, size / 2, size, size / 2)
    ctx.clip()
    ctx.fill(shield)
    ctx.restore()
  }
  ctx.strokeStyle = green
  ctx.lineWidth = 5
  ctx.lineJoin = 'round'
  ctx.stroke(shield)

  return new CanvasTexture(canvas)
}
