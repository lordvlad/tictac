import { type GrenadeId, type GrenadeSpec, STATUSES } from '../core/Arsenal'
import { blastFalloff } from '../core/Ballistics'
import { blastOn, type ResolvedHit, throwFlight } from './Combat'
import { type Grid, type Tile, tileEquals } from '../core/Grid'
import { heightAt, type ThrowFlight } from '../core/Throw'
import type { Soldier } from '../entities/Soldier'
import { DamageIndicators } from '../render/DamageIndicators'
import type { Ground } from '../render/Ground'
import type { Effects } from '../render/Effects'
import { ThrowPreview } from '../render/ThrowPreview'
import type { Squads } from './Squads'
import type { EngineContext } from '../engine'
import { FX, TILE } from '../config'
import { distance } from '../core/math'
import { Vector3 } from 'three'

const BLAST_TINT = 0xff9a3c
const BLAST_CENTRE = 0xffd166
/** Spacing of the points a flight is drawn with, in tiles. */
const CURVE_STEP = 0.25

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
 * The preview is the throw as aimed, off the same walls and onto the same
 * roofs the rules will fly it; only the stray (`scatterAim`) is left for the
 * dice.
 *
 * The storey aimed at is the one the player is viewing: from the ground
 * floor a roofed tile is the room under it, and the throw goes in low; from
 * the storey of its roof it is the roof, and the throw is lobbed onto it.
 */
export class GrenadePlanner {
  private readonly damageIndicators: DamageIndicators
  private readonly preview: ThrowPreview
  private kind: GrenadeId | null = null
  private aim: Tile | null = null
  private storey = 0

  constructor(
    private readonly grid: Grid,
    private readonly squads: Squads,
    private readonly effects: Effects,
    private readonly rig: { shake(intensity: number, duration: number): void },
    engine: EngineContext,
  ) {
    this.damageIndicators = new DamageIndicators(engine)
    this.preview = new ThrowPreview(engine.scene)
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
    this.preview.hide()
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

  /** Aim at the storey the player is viewing from now on. */
  viewStorey(level: number): void {
    this.storey = level
  }

  /** The throw as aimed at `at`, before the dice: what the player is shown. */
  private intendedFlight(thrower: Soldier, spec: GrenadeSpec, at: Tile): ThrowFlight {
    return throwFlight(this.grid, thrower, spec, { ...at, level: this.storey })
  }

  /** The throw currently lined up, or null when nothing is aimed yet. */
  pending(thrower: Soldier | null): PendingThrow | null {
    if (!this.kind || !thrower || thrower.isDead || !this.aim) return null
    const spec = thrower.grenadeSpecs[this.kind]
    const at = this.aim
    const flight = this.intendedFlight(thrower, spec, at)

    const caught: BlastPreviewEntry[] = []
    for (const soldier of this.squads.soldiers) {
      if (soldier.isDead) continue
      const result = blastOn(this.grid, flight, spec, soldier)
      if (!result) continue
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
   * Show a throw the rules have resolved: the grenade flies the flight they
   * flew, then the blast FX and damage numbers go off where it came down. No
   * rules, no damage.
   *
   * Aiming ends at once rather than on landing, so the throw cannot be
   * committed a second time while the grenade is still in the air.
   *
   * `areaRadius` is a parameter rather than a lookup because a peer's throw is
   * sized by *its* copy of the grenade — per-soldier state the debug panel can
   * edit — and this side's copy would size the blast wrongly.
   */
  replayThrow(kind: GrenadeId, flight: ThrowFlight, areaRadius: number, hits: readonly ResolvedHit[]): void {
    this.exit()
    const curve = this.curve(flight)
    const landing = curve[curve.length - 1]!
    this.effects.spawnGrenade(curve, () => {
      this.effects.triggerFlash(kind)
      this.effects.spawnBlast(landing, areaRadius, kind)

      if (kind === 'frag') this.rig.shake(FX.shakeIntensityFrag, FX.shakeDurationFrag)
      // A pop for anything that goes off. A fire or a cloud afterwards is the
      // ground's, drawn for as long as the rules say it lasts.
      if (kind === 'frag' || kind === 'incendiary' || kind === 'smoke') this.effects.spawnBlastPuffs(landing, areaRadius)

      for (const hit of hits) {
        // Over the victim's tile rather than its mesh: the tile is the resolved
        // fact, the mesh may be mid-lerp, and a resolved hit deliberately has no
        // body attached to it.
        if (hit.damage > 0) this.damageIndicators.spawn(this.grid.tileToWorld(hit.soldier.tile), true, hit.damage)
      }
    })
  }

  /**
   * What the armed grenade is aimed at, if the throw is one the panel offers.
   * Choosing only: the throw is a command, resolved by `CommandSystem`.
   */
  aimed(thrower: Soldier): { kind: GrenadeId; targetTile: Tile; targetLevel: number } | null {
    const pending = this.pending(thrower)
    if (!pending || !pending.affordable || !pending.inRange) return null
    return { kind: pending.kind, targetTile: pending.at, targetLevel: this.storey }
  }

  /** Draw the flight and the blast it would land, and paint the blast's footprint. */
  renderOverlay(ground: Ground, thrower: Soldier, hovered: Tile | null): void {
    const at = this.aim ?? hovered
    if (!this.kind || !at) {
      this.preview.hide()
      return
    }
    const spec = thrower.grenadeSpecs[this.kind]
    const flight = this.intendedFlight(thrower, spec, at)
    const curve = this.curve(flight)
    this.preview.show(curve, curve[curve.length - 1]!, spec.areaRadius)

    const { landed } = flight
    const radius = Math.ceil(spec.areaRadius)
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = landed.x + dx
        const y = landed.y + dy
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

  /**
   * A flight in world space: every bounce exactly, the arc between them in
   * short straight steps, and the fall at the end onto what it landed on.
   */
  private curve(flight: ThrowFlight): Vector3[] {
    const half = this.grid.halfExtent
    const point = (x: number, y: number, s: number) => new Vector3(x * TILE - half, heightAt(flight, s), y * TILE - half)
    const { track } = flight
    const points = [point(track[0]!.x, track[0]!.y, 0)]
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1]!
      const b = track[i]!
      const steps = Math.max(1, Math.ceil((b.s - a.s) / CURVE_STEP))
      for (let k = 1; k <= steps; k++) {
        const t = k / steps
        points.push(point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.s + (b.s - a.s) * t))
      }
    }
    return points
  }

  dispose(): void {
    this.preview.dispose()
    this.damageIndicators.dispose()
  }
}
