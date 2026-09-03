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
import { COVER_DIRS } from '../core/Cover'
import { CoverLevel } from '../core/Walls'

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
   * of the goal tile. `apCost`, when given, is shown above the goal pole so the
   * price of the move is readable without counting tiles.
   */
  show(
    path: Vector3[],
    waypoints: Vector3[],
    goal: Vector3,
    valid: boolean,
    coverLevels?: readonly CoverLevel[],
    apCost?: number,
  ): void {
    const beaconColor = valid ? PATH.colorValid : PATH.colorInvalid

    if (path.length >= 2) {
      const points = path.map((p) => new Vector3(p.x, p.y + PATH.hover, p.z))
      this.group.add(this.line(points, beaconColor, 0.95))
    }

    for (const wp of waypoints) {
      this.beacon(wp, PATH.waypointHeight, [PATH.waypointRadius], PATH.colorWaypoint)
    }

    this.beacon(goal, PATH.goalHeight, [PATH.goalInnerRadius, PATH.goalOuterRadius], beaconColor)

    if (apCost !== undefined && Number.isFinite(apCost)) {
      this.label(goal, `${formatAp(apCost)} AP`, valid)
    }

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
    const pole = [new Vector3(base.x, base.y + PATH.hover, base.z), new Vector3(base.x, base.y + height, base.z)]
    this.group.add(this.line(pole, color, 0.75))
  }

  /** A single horizontal circle at marker hover height, centred on `base`. */
  private ring(base: Vector3, radius: number, color: number): LineLoop {
    const points: Vector3[] = []
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2
      points.push(new Vector3(base.x + Math.cos(a) * radius, base.y + PATH.hover, base.z + Math.sin(a) * radius))
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

  /**
   * Camera-facing cover shield sprite on one side of the goal tile.
   *
   * Heights are measured from the goal's own floor, not from the ground: a
   * target on an upper storey has its markers up there with it.
   */
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
    sprite.position.set(goal.x + dx * 0.5, goal.y + PATH.shieldHeight, goal.z + dy * 0.5)
    sprite.scale.set(0.5, 0.5, 1)
    sprite.renderOrder = 11
    this.group.add(sprite)
  }

  /** Camera-facing text plate floating just above the goal pole. */
  private label(goal: Vector3, text: string, valid: boolean): void {
    const texture = labelTexture(text, valid)
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
    sprite.position.set(goal.x, goal.y + PATH.goalHeight + PATH.labelRise, goal.z)
    sprite.scale.set(PATH.labelScale * LABEL_ASPECT, PATH.labelScale, 1)
    sprite.renderOrder = 12
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

/** Width/height ratio of the label plate, so text is not squashed. */
const LABEL_ASPECT = 2.5

/** Trim the trailing ".0" that whole-step routes would otherwise show. */
function formatAp(cost: number): string {
  return Number.isInteger(cost) ? String(cost) : cost.toFixed(1)
}

/**
 * Draw the AP cost onto a canvas texture: pill background so the digits stay
 * readable against bright floor and dark shadow alike, tinted by affordability.
 */
function labelTexture(text: string, valid: boolean): CanvasTexture {
  const width = 160
  const height = 64
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const ink = valid ? '#8effb4' : '#ff9a8e'

  const radius = height / 2
  ctx.beginPath()
  ctx.moveTo(radius, 4)
  ctx.lineTo(width - radius, 4)
  ctx.quadraticCurveTo(width - 4, 4, width - 4, radius)
  ctx.quadraticCurveTo(width - 4, height - 4, width - radius, height - 4)
  ctx.lineTo(radius, height - 4)
  ctx.quadraticCurveTo(4, height - 4, 4, radius)
  ctx.quadraticCurveTo(4, 4, radius, 4)
  ctx.closePath()
  ctx.fillStyle = 'rgba(8, 12, 18, 0.78)'
  ctx.fill()
  ctx.strokeStyle = ink
  ctx.lineWidth = 3
  ctx.stroke()

  ctx.fillStyle = ink
  ctx.font = 'bold 34px "Segoe UI", Inter, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, width / 2, height / 2 + 2)

  return new CanvasTexture(canvas)
}
