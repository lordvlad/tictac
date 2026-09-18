import type { Faction } from '../config'
import type { AmmoSpec, GrenadeId, GrenadeSpec, ShotMode, Weapon } from '../core/Arsenal'
import type { StatusState } from '../core/Ballistics'
import type { Combatant } from '../core/Combatant'
import { NO_FX } from '../core/Combatant'
import type { Tile } from '../core/Grid'
import type { Grid } from '../core/Grid'
import type { Roll } from '../core/rng'
import type { Soldier } from '../entities/Soldier'
import { calculateHitChance, executeShot, throwGrenade, type ResolvedHit } from './Combat'
import type { WireHit } from './NetworkManager'

/**
 * Checking a peer's arithmetic by doing it again.
 *
 * Combat is sender-resolved today: the acting peer rolls, resolves and ships
 * the numbers, and this side applies them verbatim. That contract requires the
 * *attacker* to know things about the *target* that only the target's owner
 * truly knows, and three bugs of exactly that shape have shipped — target
 * evasion, a plate carrier's damage reduction, and `unreadable` — each one
 * silent, each applying a wrong number with nothing complaining.
 *
 * So this side re-derives what it thinks should have happened and says so when
 * the two disagree. It is deliberately **observation only**: the applied result
 * is still the sender's, because changing that is
 * [ITEM-023](../../docs/backlog/active-backlog.md) and needs the whole wire to
 * move at once. What this buys now is that the next bug of the class announces
 * itself on the first shot instead of being found by reading code.
 *
 * Two properties this file must keep, or it breaks the thing it measures:
 *
 * 1. **It mutates nothing real.** Every check runs against throwaway
 *    {@link SimUnit} mirrors, which is also why it reuses the real resolvers
 *    rather than reimplementing them — a second copy of the rules would only
 *    ever measure itself.
 * 2. **It draws no match randomness.** The hit dice arrive on the wire, and the
 *    crit outcomes are replayed from the sender's own flags, so the shadow
 *    consumes nothing from the match stream.
 */

/** One thing the two sides do not agree about. */
export interface Divergence {
  /** What disagreed, in the terms a reader debugging it would search for. */
  what: string
  /** The unit it concerned, when it concerned one. */
  unit?: string
  mine: number | string | boolean | null
  theirs: number | string | boolean | null
}

/**
 * A stand-in for a soldier: the real unit's *reads*, with its own writes.
 *
 * Delegation rather than reconstruction, and that distinction is the whole
 * check. Rebuilding a unit from its sheet and its kit re-folds its traits — so
 * a shadow built that way cannot see a defensive property that arrived over the
 * wire, which is precisely the class of bug being looked for. This reads
 * exactly what the resolvers would read off the live unit, including everything
 * replicated, and keeps its own copy only of the state a shot writes to.
 *
 * Found the useful way: the first version mirrored into a `SimUnit`, and the
 * test that plants an unreplicated plate carrier on the target passed when it
 * should have failed.
 */
class ShadowUnit implements Combatant {
  hp: number
  armor: number
  ap: number
  statuses: StatusState[]
  tile: Tile
  targetYaw: number
  firedThisTurn: boolean
  known: boolean
  spentThisTurn: number
  exhaustedTurns: number
  grenades: Record<GrenadeId, number>
  private crouching: boolean

  constructor(private readonly real: Soldier) {
    this.hp = real.hp
    this.armor = real.armor
    this.ap = real.ap
    this.statuses = real.statuses.map((status) => ({ ...status }))
    this.tile = { ...real.tile }
    this.targetYaw = real.targetYaw
    this.firedThisTurn = real.firedThisTurn
    this.known = real.known
    this.spentThisTurn = real.spentThisTurn
    this.exhaustedTurns = real.exhaustedTurns
    this.grenades = { ...real.grenades }
    this.crouching = real.isCrouching
  }

  get faction(): Faction {
    return this.real.faction
  }
  get squadIndex(): number {
    return this.real.squadIndex
  }
  get name(): string {
    return this.real.name
  }
  get isDead(): boolean {
    return this.hp <= 0
  }
  get isMoving(): boolean {
    return false
  }
  get maxHp(): number {
    return this.real.maxHp
  }
  get maxArmor(): number {
    return this.real.maxArmor
  }
  get weapon(): Weapon {
    return this.real.weapon
  }
  get ammo(): AmmoSpec {
    return this.real.ammo
  }
  get isCrouching(): boolean {
    return this.crouching
  }
  get proficiency(): number {
    return this.real.proficiency
  }
  get evasion(): number {
    return this.real.evasion
  }
  get critImmune(): boolean {
    return this.real.critImmune
  }
  get rangeFalloff(): number {
    return this.real.rangeFalloff
  }
  get damageTaken(): number {
    return this.real.damageTaken
  }
  get critChanceBonus(): number {
    return this.real.critChanceBonus
  }
  get critMultiplierBonus(): number {
    return this.real.critMultiplierBonus
  }
  get silenced(): boolean {
    return this.real.silenced
  }
  get unreadable(): boolean {
    return this.real.unreadable
  }
  get moveCostMul(): number {
    return this.real.moveCostMul
  }
  get effectiveMaxAp(): number {
    return this.real.effectiveMaxAp
  }
  get grenadeSpecs(): Record<GrenadeId, GrenadeSpec> {
    return this.real.grenadeSpecs
  }

  // Stance is local, but the numbers it feeds are not: nothing changes a
  // unit's stance mid-shot, so the delegated `evasion` above is the crouch the
  // live unit is actually in.
  enterCover(): void {
    this.crouching = true
  }
  exitCover(): void {
    this.crouching = false
  }
}

function mirror(unit: Soldier): ShadowUnit {
  return new ShadowUnit(unit)
}

/** Replay the sender's crit outcomes instead of rolling our own. */
function critsFrom(flags: readonly boolean[]): Roll {
  let at = 0
  return () => {
    const critical = flags[at++] ?? false
    // `critical = roll() * 100 <= chance`, and the chance is clamped below 100,
    // so zero always crits and one never does.
    return critical ? 0 : 1
  }
}

const key = (faction: Faction, index: number): string => `${faction}:${index}`

/** Line up the sender's per-victim numbers against ours, by unit. */
function compareHits(
  mine: readonly ResolvedHit[],
  theirs: readonly WireHit[],
  nameOf: (faction: Faction, index: number) => string,
): Divergence[] {
  const out: Divergence[] = []
  const ours = new Map<string, { damage: number; armorShred: number; crit: boolean }>()
  for (const hit of mine) {
    const at = key(hit.soldier.faction, hit.soldier.squadIndex)
    const seen = ours.get(at) ?? { damage: 0, armorShred: 0, crit: false }
    ours.set(at, {
      damage: seen.damage + hit.damage,
      armorShred: seen.armorShred + hit.armorShred,
      crit: seen.crit || hit.crit,
    })
  }

  const sent = new Map<string, { damage: number; armorShred: number; crit: boolean }>()
  for (const hit of theirs) {
    const at = key(hit.faction, hit.index)
    const seen = sent.get(at) ?? { damage: 0, armorShred: 0, crit: false }
    sent.set(at, {
      damage: seen.damage + hit.damage,
      armorShred: seen.armorShred + hit.armorShred,
      crit: seen.crit || hit.crit,
    })
  }

  for (const at of new Set([...ours.keys(), ...sent.keys()])) {
    const [faction, index] = at.split(':').map(Number) as [Faction, number]
    const unit = nameOf(faction, index)
    const a = ours.get(at)
    const b = sent.get(at)
    if (!a || !b) {
      // A victim one side resolved and the other did not: the worst kind, since
      // it means the two sides disagree about who was even in the blast.
      out.push({ what: 'victim', unit, mine: a ? a.damage : null, theirs: b ? b.damage : null })
      continue
    }
    if (a.damage !== b.damage) out.push({ what: 'damage', unit, mine: a.damage, theirs: b.damage })
    if (a.armorShred !== b.armorShred) {
      out.push({ what: 'armorShred', unit, mine: a.armorShred, theirs: b.armorShred })
    }
    if (a.crit !== b.crit) out.push({ what: 'crit', unit, mine: a.crit, theirs: b.crit })
  }
  return out
}

/**
 * Re-derive a shot a peer has told us about, and report what disagrees.
 *
 * Runs before the peer's numbers are applied, because the shadow needs the
 * state the shot was fired at.
 */
export function shadowShot(
  grid: Grid,
  shooter: Soldier,
  target: Soldier,
  soldiers: readonly Soldier[],
  mode: ShotMode,
  rolls: readonly boolean[],
  hits: readonly WireHit[],
  chance: number | undefined,
): Divergence[] {
  const out: Divergence[] = []
  const nameOf = (faction: Faction, index: number): string =>
    soldiers.find((unit) => unit.faction === faction && unit.squadIndex === index)?.name ??
    `${faction}:${index}`

  // The hit chance is the term the three historical bugs all moved, and it is
  // the one number a miss still has an opinion about — so it is worth checking
  // even when nothing landed.
  if (typeof chance === 'number') {
    const ours = calculateHitChance(grid, shooter, target, mode)
    if (Math.round(ours) !== Math.round(chance)) {
      out.push({ what: 'hitChance', unit: target.name, mine: Math.round(ours), theirs: Math.round(chance) })
    }
  }

  const mirrors = new Map(soldiers.map((unit) => [unit, mirror(unit)]))
  const shadowShooter = mirrors.get(shooter)
  const shadowTarget = mirrors.get(target)
  if (!shadowShooter || !shadowTarget) return out
  // Afford the shot. Legality was the sender's to establish — it took the shot —
  // and the real cost arrives by component replication, which may already have
  // landed. Without this, a shot resolved *after* its own AP update would be
  // reported as a disagreement about damage when it is one about arrival order.
  shadowShooter.ap = shadowShooter.effectiveMaxAp

  const result = executeShot(
    grid,
    shadowShooter,
    shadowTarget,
    NO_FX,
    [...mirrors.values()],
    mode,
    critsFrom(hits.map((hit) => hit.crit)),
    [...rolls],
  )

  return [...out, ...compareHits(result.hits, hits, nameOf)]
}

/**
 * The same for a grenade, which is worth more than the shot case: a thrower
 * resolves damage for everybody in the blast, *including this side's own
 * soldiers*, so a disagreement here is this side being told what happened to
 * its own squad.
 */
export function shadowThrow(
  grid: Grid,
  thrower: Soldier,
  at: { x: number; y: number },
  kind: GrenadeId,
  soldiers: readonly Soldier[],
  hits: readonly WireHit[],
): Divergence[] {
  const nameOf = (faction: Faction, index: number): string =>
    soldiers.find((unit) => unit.faction === faction && unit.squadIndex === index)?.name ??
    `${faction}:${index}`

  const mirrors = new Map(soldiers.map((unit) => [unit, mirror(unit)]))
  const shadowThrower = mirrors.get(thrower)
  if (!shadowThrower) return []
  // Afford the throw, for the same reason as the shot: the peer threw it, so
  // the points and the grenade were there when it did, and both may already
  // have replicated as spent.
  shadowThrower.ap = shadowThrower.effectiveMaxAp
  shadowThrower.grenades[kind] = Math.max(1, shadowThrower.grenades[kind] ?? 0)

  const result = throwGrenade(grid, shadowThrower, at, kind, [...mirrors.values()], NO_FX)
  if (!result.thrown) {
    // The throw this side cannot even reproduce as legal. Reported rather than
    // ignored: it means the two sides disagree about reach or the tile, which
    // is a bigger disagreement than any number in the blast.
    return [{ what: 'throwRefused', unit: thrower.name, mine: false, theirs: true }]
  }
  return compareHits(result.hits, hits, nameOf)
}

/**
 * Say so, once, loudly enough to be noticed in a live match.
 *
 * Prose rather than a thrown error: the applied outcome is still the peer's, so
 * this is a report about a match that is carrying on, and a crash would turn a
 * wrong number into a lost game.
 */
export function reportDivergence(what: string, found: readonly Divergence[]): void {
  if (found.length === 0) return
  console.warn(
    `%c[desync] ${what}: this side and the peer disagree`,
    'color: #f97316; font-weight: bold;',
    found.map((d) => `${d.unit ? `${d.unit} ` : ''}${d.what}: mine ${d.mine}, theirs ${d.theirs}`),
  )
}

