import type { Grid, Tile } from '../core/Grid'
import { shotCoverLevel } from '../core/Cover'
import {
  type CombatantStats,
  critBreakdown,
  type EffectiveWeapon,
  effectiveWeapon,
  grenadeDamageAt,
  type HitChanceBreakdown,
  hitChance,
  resolveDamage,
  statusStacks,
} from '../core/Ballistics'
import { type GrenadeId, ShotMode, STATUSES, StatusKind } from '../core/Arsenal'
import { type Casualty, type Combatant, type CombatFx, NO_FX } from '../core/Combatant'
import type { Roll } from '../core/rng'
import { distance, facingYaw } from '../core/math'

export interface ShotResult {
  hit: boolean
  damage: number
  /** Armour points stripped from the target. */
  armorShred: number
  killed: boolean
  hitChance: number
  apSpent: number
  /** How many of the rounds that landed landed as criticals. */
  crits: number
  /** Per-victim breakdown, so a peer can replay this shot without recomputing. */
  hits: ResolvedHit[]
  /**
   * The per-round hit dice this shot resolved with, in order.
   *
   * Whatever `overrideRolls` supplied, or what `roll` produced. Read back
   * rather than re-derived: the hit and crit dice interleave per round, so
   * anything that pre-rolled the hits on its own would move the sequence.
   */
  rolls: boolean[]
}

/** One unit's share of an attack, already resolved: a bullet hit or a blast hit. */
export interface ResolvedHit {
  soldier: Combatant
  damage: number
  armorShred: number
  killed: boolean
  status: StatusKind | null
  /** True when the crit multiplier was in this number. Display only — the
   *  damage has already been resolved with it. */
  crit: boolean
}

export interface GrenadeResult {
  thrown: boolean
  apSpent: number
  hits: ResolvedHit[]
}

/** Hit chance plus every term that produced it, for the HUD to explain. */
export function shotBreakdown(
  grid: Grid,
  shooter: Combatant,
  target: Combatant,
  mode: ShotMode = ShotMode.Snap,
): HitChanceBreakdown {
  return hitChance(
    shooter,
    target,
    grid.distance(shooter.tile, target.tile),
    shotCoverLevel(grid, shooter.tile, target.tile),
    mode,
  )
}

/** Just the percentage — the common case for lists and labels. */
export function calculateHitChance(
  grid: Grid,
  shooter: Combatant,
  target: Combatant,
  mode: ShotMode = ShotMode.Snap,
): number {
  return shotBreakdown(grid, shooter, target, mode).chance
}

/**
 * AP a shot would cost, with the loaded round and shot mode folded in.
 *
 * A reaction costs nothing *here* because it was already paid for: going on
 * watch charges a snap shot's price up front. The exemption has to be a rule
 * rather than a multiplier — `effectiveWeapon` floors every shot at 1 AP, on
 * purpose, so nothing during your own turn is ever free, and a watcher that
 * correctly ends its turn with nothing left could otherwise never fire the
 * shot it had bought.
 */
export function shotApCost(shooter: Combatant, mode: ShotMode = ShotMode.Snap): number {
  if (mode === ShotMode.Reaction) return 0
  return effectiveWeapon(shooter, mode).apCost
}

/** Can this shot legally be taken right now? */
export function canShoot(
  grid: Grid,
  shooter: Combatant,
  target: Combatant,
  mode: ShotMode = ShotMode.Snap,
): boolean {
  if (shooter.isDead || target.isDead) return false
  if (shooter.ap < shotApCost(shooter, mode)) return false
  return grid.distance(shooter.tile, target.tile) <= effectiveWeapon(shooter, mode).maxRange
}

/**
 * Fire at a target.
 *
 * Splash weapons resolve their blast through the same path grenades use, so a
 * weapon with `areaRadius > 0` damages everything near the point of impact.
 *
 * A crit is rolled per round that lands, against the chance the weapon, the
 * distance and the target's armour produce. It is never taken from
 * `overrideRolls`: those are the planner's hit dice, and the panel promises a
 * crit *chance*, not a crit. Splash damage off a critical round is ordinary —
 * the placement was on the body the bullet hit, not on the blast.
 */
export function executeShot(
  grid: Grid,
  shooter: Combatant,
  target: Combatant,
  fx: CombatFx,
  soldiers: readonly Combatant[],
  mode: ShotMode = ShotMode.Snap,
  /** The match's dice. Not optional: a shot without dice is not a shot. */
  roll: Roll,
  /** Hit dice already decided — a peer's, a replay's, or a test's. */
  overrideRolls?: boolean[],
): ShotResult {
  const eff = effectiveWeapon(shooter, mode)
  if (!canShoot(grid, shooter, target, mode)) {
    return {
      hit: false,
      damage: 0,
      armorShred: 0,
      killed: false,
      hitChance: 0,
      apSpent: 0,
      crits: 0,
      hits: [],
      rolls: [],
    }
  }

  const apCost = shotApCost(shooter, mode)
  shooter.ap = Math.max(0, shooter.ap - apCost)
  // Muzzle flash and noise: firing gives a position away until the handover,
  // unless the weapon is quiet. Fog reads it; nothing else does.
  if (!shooter.silenced) {
    shooter.firedThisTurn = true
    // And having shot at someone, you have shown them what you are. Unlike the
    // flash, this does not wear off - they have measured you.
    shooter.known = true
  }
  // Shooting at a unit is how you find out what it is made of, hit or miss -
  // unless it gives nothing away, which is what `unreadable` is for. Note it
  // does not stop the target being *seen*, only read.
  if (!target.unreadable) target.known = true

  const chance = calculateHitChance(grid, shooter, target, mode)
  const crit = critBreakdown(eff, target, grid.distance(shooter.tile, target.tile))
  const shooterWorld = grid.tileToWorld(shooter.tile)
  const targetWorld = grid.tileToWorld(target.tile)

  // Face the target. Same yaw convention as movement: forward = (sin y, cos y).
  const dx = targetWorld.x - shooterWorld.x
  const dz = targetWorld.z - shooterWorld.z
  if (distance(dx, dz) > 0.01) shooter.targetYaw = facingYaw(dx, dz)

  const bullets = eff.weapon.bulletConsumption(mode)
  const hits: ResolvedHit[] = []
  const rolls: boolean[] = []
  let totalDamage = 0
  let totalArmorShred = 0
  let anyHit = false
  let killed = false
  let crits = 0
  let misses = 0

  for (let i = 0; i < bullets; i++) {
    const hit = overrideRolls ? (overrideRolls[i] ?? false) : roll() * 100 <= chance
    rolls.push(hit)
    if (hit) anyHit = true
    else misses++

    fx.tracer(shooterWorld, targetWorld, hit)
    // Only the first tracer-spawn plays the sound/visual cue
    if (i === 0) fx.shoot(shooter)

    if (hit) {
      const critical = roll() * 100 <= crit.chance
      if (critical) crits++
      const primary = applyWeaponDamage(eff, target, fx, 1, critical)
      hits.push(primary)
      totalDamage += primary.damage
      totalArmorShred += primary.armorShred
      if (target.isDead) killed = true

      if (eff.areaRadius > 0) {
        for (const other of soldiers) {
          if (other === target || other.isDead) continue
          const distance = grid.distance(target.tile, other.tile)
          if (distance > eff.areaRadius) continue
          const area = applyWeaponDamage(eff, other, fx, 1 - distance / (eff.areaRadius + 1))
          hits.push(area)
          totalDamage += area.damage
          totalArmorShred += area.armorShred
          if (other.isDead) killed = true
        }
      }
    }
  }

  suppress(target, misses)

  return {
    hit: anyHit,
    damage: totalDamage,
    armorShred: totalArmorShred,
    killed,
    hitChance: chance,
    apSpent: apCost,
    crits,
    hits,
    rolls,
  }
}

/**
 * Rounds that went past rather than in.
 *
 * A miss used to do nothing whatsoever, which made volume of fire pointless
 * and made a 30% shot strictly worse than not shooting. Near misses now stack
 * {@link StatusKind.Suppressed} on the target: harder to shoot back, slower to
 * move, and at full stacks pinned in all but name.
 *
 * A dead unit is not suppressed - there is nothing left to suppress, and
 * marking a corpse would show a chip on its card.
 */
export function suppress(target: Casualty, misses: number): void {
  if (misses <= 0 || target.isDead) return
  applyStatus(target, StatusKind.Suppressed, misses)
}

/**
 * Take a shot: spend the rounds, resolve it, and report nothing if it was
 * never legal.
 *
 * The whole of what it costs to pull a trigger, so that a match and a
 * simulation cannot disagree about it. The clip comes off before resolution
 * because a shot that spends its magazine has spent it whether or not anything
 * was hit.
 */
export function fireWeapon(
  grid: Grid,
  shooter: Combatant,
  target: Combatant,
  fx: CombatFx,
  soldiers: readonly Combatant[],
  mode: ShotMode = ShotMode.Snap,
  roll: Roll,
  overrideRolls?: boolean[],
): ShotResult | null {
  if (!canShoot(grid, shooter, target, mode)) return null

  const consumption = shooter.weapon.bulletConsumption(mode)
  shooter.weapon.currentClip = Math.max(0, shooter.weapon.currentClip - consumption)

  // Returned as resolved. This used to be `result.apSpent ? result : null`,
  // reading the cost as a proxy for "the shot happened" — which quietly
  // discarded every prepaid reaction *after* it had already done its damage,
  // so a watcher shot people the caller was told nothing about. Legality was
  // settled by `canShoot` above; nothing since can have changed it.
  return executeShot(grid, shooter, target, fx, soldiers, mode, roll, overrideRolls)
}

/**
 * Apply an already-resolved hit. Takes numbers, never recomputes them.
 *
 * The one copy of the clamp-and-announce rule, shared by the local paths and by
 * a peer's replay — where the numbers arrive off the wire and the weapon that
 * produced them does not exist on this side.
 *
 * `fx` is optional because most callers are replaying somebody else's
 * resolution and the FX are theirs to decide, not this function's.
 */
export function applyHitEffects(
  target: Casualty,
  damage: number,
  armorShred: number,
  status: StatusKind | null,
  fx: CombatFx = NO_FX,
): void {
  target.armor = Math.max(0, target.armor - armorShred)
  if (damage > 0) target.hp = Math.max(0, target.hp - damage)
  if (status) applyStatus(target, status)
  // No death call: a corpse is `hp <= 0` in a component, and the view collapses
  // on seeing it.
  if (damage > 0 && !target.isDead) fx.hit(target)
}

function applyWeaponDamage(
  eff: EffectiveWeapon,
  target: Combatant,
  fx: CombatFx,
  falloff = 1,
  crit = false,
): ResolvedHit {
  const result = resolveDamage(eff, target, falloff, crit)
  applyHitEffects(target, result.damage, result.armorShred, null, fx)
  return {
    soldier: target,
    damage: result.damage,
    armorShred: result.armorShred,
    killed: target.isDead,
    status: null,
    crit: result.crit,
  }
}

/**
 * Throw a grenade at a tile.
 *
 * Blast effects are resolved per unit by distance from the centre, and the
 * grenade's status (shredded / flashed / smoked) is applied to everyone caught —
 * including your own squad, because a frag does not check uniforms.
 */
export function throwGrenade(
  grid: Grid,
  thrower: Combatant,
  at: Tile,
  kind: GrenadeId,
  soldiers: readonly Combatant[],
  fx: CombatFx = NO_FX,
): GrenadeResult {
  const spec = thrower.grenadeSpecs[kind]
  if (thrower.isDead || thrower.ap < spec.apCost) return { thrown: false, apSpent: 0, hits: [] }
  if ((thrower.grenades[kind] ?? 0) <= 0) return { thrown: false, apSpent: 0, hits: [] }
  if (grid.distance(thrower.tile, at) > spec.throwRange) return { thrown: false, apSpent: 0, hits: [] }

  thrower.ap = Math.max(0, thrower.ap - spec.apCost)
  thrower.grenades[kind] -= 1
  // A thrown grenade is not a quiet act, and there is no silenced version of
  // one: the thrower is on show whatever they are carrying.
  thrower.firedThisTurn = true
  thrower.known = true
  fx.shoot(thrower)

  const hits: ResolvedHit[] = []
  for (const soldier of soldiers) {
    if (soldier.isDead) continue
    const distance = grid.distance(at, soldier.tile)
    if (distance > spec.areaRadius) continue

    const result = grenadeDamageAt(spec, distance, soldier)
    applyHitEffects(soldier, result.damage, result.armorShred, spec.applies, fx)
    if (!soldier.unreadable) soldier.known = true

    hits.push({
      soldier,
      damage: result.damage,
      armorShred: result.armorShred,
      killed: soldier.isDead,
      status: spec.applies,
      crit: false,
    })
  }

  return { thrown: true, apSpent: spec.apCost, hits }
}

/** Apply (or refresh) a status on a unit. */
export function applyStatus(soldier: Casualty, kind: StatusKind, stacks = 1): void {
  const spec = STATUSES[kind]
  const existing = soldier.statuses.find((s) => s.kind === kind)
  if (!existing) {
    soldier.statuses.push({ kind, turnsLeft: spec.turns, stacks: Math.min(stacks, spec.maxStacks) })
    return
  }
  // Re-applying always refreshes the clock, and piles up as far as the status
  // allows: a second flash in the same turn is still one flash, three rounds
  // past the same head are three.
  existing.turnsLeft = spec.turns
  existing.stacks = Math.min(statusStacks(existing) + stacks, spec.maxStacks)
}

/**
 * Count down every unit's statuses by one turn and drop the expired ones.
 *
 * A lapsed stim lowers the action-point ceiling, so anything held above the
 * new ceiling is given back rather than left as a permanent surplus.
 */
export function tickStatuses(soldiers: readonly Combatant[]): void {
  for (const soldier of soldiers) {
    if (soldier.statuses.length === 0) continue
    for (const status of soldier.statuses) status.turnsLeft -= 1
    soldier.statuses = soldier.statuses.filter((s) => s.turnsLeft > 0)
    soldier.ap = Math.min(soldier.ap, soldier.effectiveMaxAp)
  }
}
