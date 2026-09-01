import { type GrenadeId, STATUSES } from '../core/Arsenal'
import { blastFalloff, grenadeDamageAt } from '../core/Ballistics'
import type { Grid, Tile } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import { DamageIndicators } from '../render/DamageIndicators'
import type { Ground } from '../render/Ground'
import type { Effects } from '../render/Effects'
import { throwGrenade } from './Combat'
import type { Squads } from './Squads'
import type { EngineContext } from '../engine'
import { FX } from '../config'
import { Vector3 } from 'three'

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

  constructor(
    private readonly grid: Grid,
    private readonly squads: Squads,
    private readonly effects: Effects,
    private readonly rig: { shake(intensity: number, duration: number): void },
    engine: EngineContext,
  ) {
    this.damageIndicators = new DamageIndicators(engine)
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
  }

  aimAt(tile: Tile): void {
    if (this.kind) this.aim = { ...tile }
  }

  /** The throw currently lined up, or null when nothing is aimed yet. */
  pending(thrower: Soldier | null): PendingThrow | null {
    if (!this.kind || !thrower || thrower.isDead || !this.aim) return null
    const spec = thrower.grenadeSpecs[this.kind]
    const at = this.aim

    const caught: BlastPreviewEntry[] = []
    for (const soldier of this.squads.soldiers) {
      if (soldier.isDead) continue
      const distance = this.grid.distance(at, soldier.tile)
      if (distance > spec.areaRadius) continue
      const result = grenadeDamageAt(spec, distance, soldier)
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

  executeThrowAt(thrower: Soldier, kind: GrenadeId, targetTile: Tile, force = false): boolean {
    const spec = thrower.grenadeSpecs[kind]
    const result = throwGrenade(this.grid, thrower, targetTile, kind, this.squads.soldiers, force)
    if (!result.thrown) return false
    const worldPos = this.grid.tileToWorld(targetTile)
    this.effects.triggerFlash(kind)

    if (kind === 'frag') {
      this.rig.shake(FX.shakeIntensityFrag, FX.shakeDurationFrag)
      this.effects.spawnBlastPuffs(worldPos, spec.areaRadius)
    } else if (kind === 'smoke') {
      const tileIdx = this.grid.index(targetTile.x, targetTile.y)
      this.effects.spawnPersistentSmoke(tileIdx, worldPos, spec.areaRadius)
    }

    for (const hit of result.hits) {
      if (hit.damage > 0) this.damageIndicators.spawn(hit.soldier.position, true, hit.damage)
    }

    this.exit()
    this.onThrowResolved?.()
    return true
  }

  /** Throw the armed grenade at the aimed tile. Returns thrown data for P2P sync. */
  confirm(thrower: Soldier): { kind: GrenadeId; targetTile: Tile } | null {
    const pending = this.pending(thrower)
    if (!pending || !pending.affordable || !pending.inRange) return null

    const kind = pending.kind
    const targetTile = pending.at
    const success = this.executeThrowAt(thrower, kind, targetTile)
    return success ? { kind, targetTile } : null
  }

  /** Paint the blast footprint, brightest at the centre. */
  renderOverlay(ground: Ground, thrower: Soldier, hovered: Tile | null): void {
    if (!this.kind) return
    const spec = thrower.grenadeSpecs[this.kind]
    const at = this.aim ?? hovered
    if (!at) return

    const radius = Math.ceil(spec.areaRadius)
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = at.x + dx
        const y = at.y + dy
        if (!this.grid.inBounds(x, y)) continue
        const falloff = blastFalloff(Math.hypot(dx, dy), spec.areaRadius)
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
    this.damageIndicators.dispose()
  }
}
