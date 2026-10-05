import { type GrenadeId, STATUSES } from '../core/Arsenal'
import { blastFalloff, calculateIntendedThrow, grenadeDamageAt, type ThrowPath } from '../core/Ballistics'
import type { ResolvedHit } from './Combat'
import { shotCoverLevel } from '../core/Cover'
import { type Grid, type Tile, tileEquals } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import { DamageIndicators } from '../render/DamageIndicators'
import type { Ground } from '../render/Ground'
import type { Effects } from '../render/Effects'
import type { Squads } from './Squads'
import type { EngineContext } from '../engine'
import { EYE_HEIGHT, FX, LEVEL_HEIGHT } from '../config'
import { distance } from '../core/math'
import { BufferGeometry, CircleGeometry, DoubleSide, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, Vector3 } from 'three'

const BLAST_TINT = 0xff9a3c
const BLAST_CENTRE = 0xffd166
/** One unit inside the previewed blast. */
export interface BlastPreviewEntry {
  name: string
  friendly: boolean
  damage: number
  armorShred: number
  lethal: boolean
}

/** Everything the HUD needs to show a throw before it happens. */
export interface PendingThrow {
  kind: GrenadeId
  name: string
  at: Tile
  landedAt: Tile
  trajectory: ThrowPath
  apCost: number
  radius: number
  affordable: boolean
  inRange: boolean
  remaining: number
  statusName: string | null
  caught: BlastPreviewEntry[]
}

/**
 * Grenade throwing: which kind is armed, where it is aimed, and who it would
 * catch — including your own squad, because a frag does not check uniforms.
 *
 * Same two-step contract as shooting: aiming only previews, the panel confirms.
 */
export class GrenadePlanner {
  onThrowResolved?: () => void

  private readonly damageIndicators: DamageIndicators
  private kind: GrenadeId | null = null
  private aim: Tile | null = null
  private previewLine: Line | null = null
  private readonly previewMaterial: LineBasicMaterial
  private blastMesh: Mesh | null = null
  private readonly blastMaterial: MeshBasicMaterial

  constructor(
    private readonly grid: Grid,
    private readonly squads: Squads,
    private readonly effects: Effects,
    private readonly rig: { shake(intensity: number, duration: number): void },
    private readonly engine: EngineContext,
  ) {
    this.damageIndicators = new DamageIndicators(engine)
    this.previewMaterial = new LineBasicMaterial({
      color: 0xffaa55, // Light orange
      linewidth: 3,
      transparent: true,
      opacity: 0.85,
    })
    this.blastMaterial = new MeshBasicMaterial({
      color: 0xff9a3c,
      transparent: true,
      opacity: 0.45,
      side: DoubleSide,
      depthWrite: false,
    })
  }
  get active(): boolean {
    return this.kind !== null
  }

  get armed(): GrenadeId | null {
    return this.kind
  }

  arm(kind: GrenadeId, thrower: Soldier | null): boolean {
    if (!thrower || thrower.isDead) return false
    if ((thrower.grenades[kind] ?? 0) <= 0) return false
    this.kind = kind
    this.aim = null
    return true
  }

  exit(): void {
    this.kind = null
    this.aim = null
    this.clearVisuals()
  }

  private clearVisuals(): void {
    if (this.previewLine) {
      this.engine.scene.remove(this.previewLine)
      this.previewLine.geometry.dispose()
      this.previewLine = null
    }
    if (this.blastMesh) {
      this.engine.scene.remove(this.blastMesh)
      this.blastMesh.geometry.dispose()
      this.blastMesh = null
    }
  }

  aimAt(tile: Tile): void {
    if (this.kind) this.aim = { ...tile }
  }

  /**
   * True when `tile` is already the aimed tile, so a second tap on it means
   * "throw" rather than "re-aim" — the same tap-to-target, tap-again-to-commit
   * contract movement uses.
   */
  isAimedAt(tile: Tile): boolean {
    return this.aim !== null && tileEquals(this.aim, tile)
  }

  /** The throw currently lined up, or null when nothing is aimed yet. */
  pending(thrower: Soldier | null): PendingThrow | null {
    if (!this.kind || !thrower || thrower.isDead || !this.aim) return null
    const spec = thrower.grenadeSpecs[this.kind]
    const at = this.aim
    const trajectory = calculateIntendedThrow(this.grid, thrower.tile, at, spec.throwRange)
    const landedAt = trajectory.end

    const blastRoof = this.grid.roofAt(landedAt.x, landedAt.y)
    const blastFloor = this.grid.levelAt(landedAt.x, landedAt.y)
    const blastElevationY = Math.max(blastRoof, blastFloor) * LEVEL_HEIGHT

    const caught: BlastPreviewEntry[] = []
    for (const soldier of this.squads.soldiers) {
      if (soldier.isDead) continue
      const soldierFloorY = this.grid.levelAt(soldier.tile.x, soldier.tile.y) * LEVEL_HEIGHT
      const horizontalDist = this.grid.distance(landedAt, soldier.tile)
      const verticalDist = Math.abs(blastElevationY - soldierFloorY)
      const total3DDist = distance(horizontalDist, verticalDist)
      if (total3DDist > spec.areaRadius) continue

      const cover = shotCoverLevel(this.grid, landedAt, soldier.tile)
      const result = grenadeDamageAt(spec, total3DDist, soldier, cover)
      caught.push({
        name: soldier.name,
        friendly: soldier.faction === thrower.faction,
        damage: result.damage,
        armorShred: result.armorShred,
        lethal: result.damage >= soldier.hp,
      })
    }
    return {
      kind: this.kind,
      name: spec.name,
      at,
      landedAt,
      trajectory,
      apCost: spec.apCost,
      radius: spec.areaRadius,
      affordable: thrower.ap >= spec.apCost,
      inRange: this.grid.distance(thrower.tile, at) <= spec.throwRange,
      remaining: thrower.grenades[this.kind] ?? 0,
      statusName: spec.applies ? STATUSES[spec.applies].name : null,
      caught,
    }
  }

  /**
   * Resolve a throw and show it. Returns null when the throw was illegal.
   *
   * The FX half is {@link replayThrow}, which a peer's throw goes through
   * directly with the numbers that peer already resolved.
   */
  /**
   * Blast FX, indicators and the post-throw refresh. No rules, no damage.
   *
   * `areaRadius` is a parameter rather than a lookup because a peer's throw is
   * sized by *its* copy of the grenade — per-soldier state the debug panel can
   * edit — and this side's copy would size the blast wrongly.
   */
  replayThrow(
    kind: GrenadeId,
    targetTile: Tile,
    areaRadius: number,
    hits: readonly ResolvedHit[],
    trajectory?: ThrowPath,
  ): void {
    const onDetonate = () => {
      const worldPos = this.grid.tileToWorld(targetTile)
      this.effects.triggerFlash(kind)
      this.effects.spawnBlast(worldPos, areaRadius, kind)

      if (kind === 'frag') this.rig.shake(FX.shakeIntensityFrag, FX.shakeDurationFrag)
      if (kind === 'frag' || kind === 'incendiary' || kind === 'smoke') {
        this.effects.spawnBlastPuffs(worldPos, areaRadius)
      }

      for (const hit of hits) {
        if (hit.damage > 0) {
          this.damageIndicators.spawn(this.grid.tileToWorld(hit.soldier.tile), true, hit.damage)
        }
      }

      this.exit()
      this.onThrowResolved?.()
    }

    if (trajectory && trajectory.points && trajectory.points.length > 0) {
      const startTile = trajectory.path[0] ?? targetTile
      const throwerIndoors = this.grid.roofAt(startTile.x, startTile.y) > this.grid.levelAt(startTile.x, startTile.y)
      const points: Vector3[] = trajectory.points.map((pt) => {
        const tileX = Math.floor(pt.x)
        const tileY = Math.floor(pt.y)
        const roof = this.grid.roofAt(tileX, tileY)
        const level = this.grid.levelAt(tileX, tileY)
        const surfaceY = (!throwerIndoors && roof > 0 ? Math.max(roof, level) : level) * LEVEL_HEIGHT
        return new Vector3(
          pt.x - this.grid.halfExtent,
          surfaceY,
          pt.y - this.grid.halfExtent,
        )
      })
      this.effects.spawnGrenade(points, onDetonate)
    } else if (trajectory && trajectory.path.length > 0) {
      const points: Vector3[] = trajectory.path.map((tile) => this.grid.tileToWorld(tile))
      this.effects.spawnGrenade(points, onDetonate)
    } else {
      onDetonate()
    }
  }

  /**
   * What the armed grenade is aimed at, if the throw is one the panel offers.
   * Choosing only: the throw is a command, resolved by `CommandSystem`.
   */
  aimed(thrower: Soldier): { kind: GrenadeId; targetTile: Tile } | null {
    const pending = this.pending(thrower)
    if (!pending || !pending.affordable || !pending.inRange) return null
    return { kind: pending.kind, targetTile: pending.at }
  }

  /** Paint the trajectory trace and blast footprint. */
  renderOverlay(ground: Ground, thrower: Soldier, hovered: Tile | null): void {
    if (!this.kind) {
      this.clearVisuals()
      return
    }
    const spec = thrower.grenadeSpecs[this.kind]
    const at = this.aim ?? hovered
    if (!at) {
      this.clearVisuals()
      return
    }

    const trajectory = calculateIntendedThrow(this.grid, thrower.tile, at, spec.throwRange)
    const landedAt = trajectory.end
    const fromRoof = this.grid.roofAt(thrower.tile.x, thrower.tile.y)
    const fromFloor = this.grid.levelAt(thrower.tile.x, thrower.tile.y)
    const throwerIndoors = fromRoof > fromFloor

    const roof = this.grid.roofAt(landedAt.x, landedAt.y)
    const level = this.grid.levelAt(landedAt.x, landedAt.y)
    const surfaceY = (!throwerIndoors && roof > 0 ? Math.max(roof, level) : level) * LEVEL_HEIGHT

    // 1. Draw light orange 3D line in the air with parabolic arch
    const rawPoints = trajectory.points ?? trajectory.path.map((t) => ({ x: t.x + 0.5, y: t.y + 0.5 }))
    const waypoints: Vector3[] = rawPoints.map((pt) => {
      const tileX = Math.floor(pt.x)
      const tileY = Math.floor(pt.y)
      const r = this.grid.roofAt(tileX, tileY)
      const l = this.grid.levelAt(tileX, tileY)
      const sY = (!throwerIndoors && r > 0 ? Math.max(r, l) : l) * LEVEL_HEIGHT
      return new Vector3(
        pt.x - this.grid.halfExtent,
        sY,
        pt.y - this.grid.halfExtent,
      )
    })

    if (waypoints.length > 0) {
      // Generate arched points along continuous waypoints
      const archedPoints: Vector3[] = []
      const segments = 30
      const startPt = waypoints[0]!
      const endPt = waypoints[waypoints.length - 1]!
      const totalDist = startPt.distanceTo(endPt)
      const arcHeight = throwerIndoors
        ? Math.min(0.25, Math.max(0.1, totalDist * 0.05))
        : Math.min(2.5, Math.max(0.6, totalDist * 0.25))

      for (let i = 0; i <= segments; i++) {
        const t = i / segments
        const numSegs = waypoints.length - 1
        if (numSegs <= 0) {
          archedPoints.push(waypoints[0]!.clone().add(new Vector3(0, EYE_HEIGHT * 0.8, 0)))
          continue
        }
        const segIndex = Math.min(Math.floor(t * numSegs), numSegs - 1)
        const segT = t * numSegs - segIndex
        const p = new Vector3().lerpVectors(waypoints[segIndex]!, waypoints[segIndex + 1]!, segT)
        p.y += EYE_HEIGHT * 0.8 + Math.sin(t * Math.PI) * arcHeight
        archedPoints.push(p)
      }
      if (this.previewLine) {
        this.engine.scene.remove(this.previewLine)
        this.previewLine.geometry.dispose()
      }
      const geometry = new BufferGeometry().setFromPoints(archedPoints)
      this.previewLine = new Line(geometry, this.previewMaterial)
      this.engine.scene.add(this.previewLine)
    } else {
      if (this.previewLine) {
        this.engine.scene.remove(this.previewLine)
        this.previewLine.geometry.dispose()
        this.previewLine = null
      }
    }

    // 2. 3D blast circle at the landing surface height (elevates on roofs/upper storeys)
    if (this.blastMesh) {
      this.engine.scene.remove(this.blastMesh)
      this.blastMesh.geometry.dispose()
      this.blastMesh = null
    }
    const circleGeom = new CircleGeometry(spec.areaRadius, 32)
    circleGeom.rotateX(-Math.PI / 2)
    this.blastMesh = new Mesh(circleGeom, this.blastMaterial)
    this.blastMesh.position.set(
      (landedAt.x + 0.5) - this.grid.halfExtent,
      surfaceY + 0.08, // slightly above roof/floor to avoid z-fighting
      (landedAt.y + 0.5) - this.grid.halfExtent,
    )
    this.engine.scene.add(this.blastMesh)

    // Paint ground floor texture as well
    const radius = Math.ceil(spec.areaRadius)
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = landedAt.x + dx
        const y = landedAt.y + dy
        if (!this.grid.inBounds(x, y)) continue
        const falloff = blastFalloff(distance(dx, dy), spec.areaRadius)
        if (falloff === 0) continue
        ground.paintTile(x, y, dx === 0 && dy === 0 ? BLAST_CENTRE : BLAST_TINT, 0.15 + falloff * 0.3)
      }
    }

    // Out-of-range throws are shown but marked by leaving the thrower's own
    // reach unpainted, so the player can see the arc is too long.
    if (this.grid.distance(thrower.tile, at) > spec.throwRange) {
      ground.paintTile(at.x, at.y, 0xe05c4f, 0.75)
    }
  }

  dispose(): void {
    this.clearVisuals()
    this.previewMaterial.dispose()
    this.blastMaterial.dispose()
    this.damageIndicators.dispose()
  }
}
