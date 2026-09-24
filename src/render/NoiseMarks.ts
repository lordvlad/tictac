import { BufferGeometry, Group, LineBasicMaterial, LineLoop, Vector3 } from 'three'
import type { Faction } from '../config'
import type { Grid, Tile } from '../core/Grid'
import { NOISE } from '../core/Noise'
import type { EngineContext } from '../engine'

/** Handovers a mark stays on the map: its hearers' own turn, and the one after. */
const LIFETIME = 4
const COLOR = 0xffb454
const SEGMENTS = 32

interface Mark {
  at: Tile
  /** The side that heard it: only that side is shown it. */
  heardBy: Faction
  /** When it was heard, in handovers. */
  heardAt: number
}

/**
 * Where a side has heard something: an amber ring on the ground, as wide as
 * "roughly where" is (`NOISE.blur`), fading over that side's next turns.
 *
 * A stealth system whose feedback is invisible reads as randomness, so the
 * side that heard a noise is shown where; the side that made it is not shown
 * that it was heard — finding that out is what being careful is for.
 *
 * Strictly a view of what `CommandSystem.onNoise` reported. It decides nothing.
 */
export class NoiseMarks {
  private readonly group = new Group()
  private readonly marks: Mark[] = []
  private readonly geometries: BufferGeometry[] = []
  private readonly materials: LineBasicMaterial[] = []

  constructor(
    private readonly engine: EngineContext,
    private readonly grid: Grid,
  ) {
    this.group.renderOrder = 9
    engine.scene.add(this.group)
  }

  /** `heardBy` heard something roughly at `at`, `handover` handovers into the match. */
  add(at: Tile, heardBy: Faction, handover: number): void {
    const same = this.marks.findIndex((m) => m.heardBy === heardBy && m.at.x === at.x && m.at.y === at.y)
    if (same >= 0) this.marks.splice(same, 1)
    this.marks.push({ at, heardBy, heardAt: handover })
  }

  /**
   * Draw what `viewer` has heard as of `handover`, or everything when
   * `viewer` is null (a spectator). Old marks are forgotten here.
   */
  show(viewer: Faction | null, handover: number): void {
    this.clear()
    for (let i = this.marks.length - 1; i >= 0; i--) {
      if (handover - this.marks[i]!.heardAt >= LIFETIME) this.marks.splice(i, 1)
    }
    for (const mark of this.marks) {
      if (viewer !== null && mark.heardBy !== viewer) continue
      const opacity = 0.9 * (1 - (handover - mark.heardAt) / LIFETIME)
      const centre = this.grid.tileToWorld(mark.at)
      this.ring(centre, NOISE.blur / 2, opacity)
      this.ring(centre, NOISE.blur / 4, opacity * 0.6)
    }
  }

  private ring(centre: Vector3, radius: number, opacity: number): void {
    const points: Vector3[] = []
    for (let i = 0; i < SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2
      points.push(new Vector3(centre.x + Math.cos(a) * radius, centre.y + 0.06, centre.z + Math.sin(a) * radius))
    }
    const geometry = new BufferGeometry().setFromPoints(points)
    const material = new LineBasicMaterial({ color: COLOR, transparent: true, opacity, depthWrite: false })
    this.geometries.push(geometry)
    this.materials.push(material)
    this.group.add(new LineLoop(geometry, material))
  }

  private clear(): void {
    this.group.clear()
    for (const g of this.geometries) g.dispose()
    for (const m of this.materials) m.dispose()
    this.geometries.length = 0
    this.materials.length = 0
  }

  dispose(): void {
    this.clear()
    this.engine.scene.remove(this.group)
  }
}
