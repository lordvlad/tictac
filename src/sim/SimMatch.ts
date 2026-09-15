import { Faction, RULES, SQUAD_SIZE } from '../config'
import { AmmoId, type GrenadeId, GRENADES, ShotMode, type WeaponId } from '../core/Arsenal'
import { NO_FX } from '../core/Combatant'
import { rollSquadSheets } from '../core/Characters'
import { type Grid, type Tile, tileEquals } from '../core/Grid'
import { ItemId } from '../core/Items'
import { generateMap } from '../core/MapGenerator'
import { findPathSegment } from '../core/Pathfinding'
import { Rng } from '../core/rng'
import { hasLineOfSight } from '../core/Visibility'
import {
  calculateHitChance,
  canShoot,
  fireWeapon,
  shotApCost,
  throwGrenade,
} from '../game/Combat'
import { stepCostFor } from '../game/Movement'
import { settleTurn } from '../game/Turn'
import { effectiveWeapon, resolveDamage } from '../core/Ballistics'
import { SimUnit } from './SimUnit'

/** What one squad brought, so a sweep can vary it. */
export interface SquadPlan {
  weapons: readonly WeaponId[]
  ammo?: AmmoId
  grenades?: Partial<Record<GrenadeId, number>>
  items?: Partial<Record<ItemId, number>>
}

export interface MatchSetup {
  seed: number
  blue: SquadPlan
  red: SquadPlan
  /** Declared a draw once both sides have had this many turns. */
  turnCap?: number
}

/** What one weapon class did over a match. */
export interface WeaponTally {
  shots: number
  hits: number
  damage: number
  kills: number
  crits: number
  rounds: number
}

export interface MatchOutcome {
  seed: number
  /** `null` when the turn cap was reached with both sides alive. */
  winner: Faction | null
  turns: number
  survivors: Record<Faction, number>
  /** Traits that were in the field, by the faction carrying them. */
  traits: Record<Faction, string[]>
  byWeapon: Record<string, WeaponTally>
  grenadesThrown: number
}

const DEFAULT_TURN_CAP = 40

/**
 * The hit chance a unit will settle for rather than keep closing.
 *
 * A judgement, not a rule: it is what stops the instrument measuring every
 * weapon at the longest range it can technically reach.
 */
const PREFERRED_CHANCE = 0.5

/** A shot the policy has chosen but not yet taken. */
interface PlannedShot {
  target: SimUnit
  mode: ShotMode
  /** Probability, not percent — it is arithmetic here, not display. */
  chance: number
  /** Expected damage per action point, which is how it was chosen. */
  value: number
}

function emptyTally(): WeaponTally {
  return { shots: 0, hits: 0, damage: 0, kills: 0, crits: 0, rounds: 0 }
}

/**
 * One match, played out with nobody watching.
 *
 * The rules are the game's own — `generateMap`, `findPathSegment`,
 * `hasLineOfSight`, `canShoot`, `fireWeapon`, `throwGrenade`, `tickStatuses` —
 * and the only things supplied here are the things a player would otherwise
 * supply: a decision per unit, and dice. Both are seeded, so a match is a pure
 * function of its {@link MatchSetup}.
 *
 * The AI is deliberately dull. It is a measuring instrument, not an opponent:
 * it takes the best shot it can see, closes the distance when it cannot see
 * one, and hunkers down when it is hurt and out of options. Anything cleverer
 * would make the numbers a statement about the AI instead of about the guns.
 */
export class SimMatch {
  readonly grid: Grid
  readonly units: SimUnit[] = []
  readonly byFaction: Record<Faction, SimUnit[]> = {
    [Faction.Blue]: [],
    [Faction.Red]: [],
  }

  private readonly rng: Rng
  private readonly roll = (): number => this.rng.next()
  private readonly tally = new Map<string, WeaponTally>()
  private readonly turnCap: number
  private grenadesThrown = 0
  private activeFaction: Faction = Faction.Blue
  private turnNumber = 1

  constructor(private readonly setup: MatchSetup) {
    this.turnCap = setup.turnCap ?? DEFAULT_TURN_CAP
    // One stream for the whole match: the map, the sheets and every die.
    this.rng = new Rng(setup.seed >>> 0)

    const map = generateMap(setup.seed)
    this.grid = map.grid

    for (const faction of [Faction.Blue, Faction.Red] as const) {
      const plan = faction === Faction.Blue ? setup.blue : setup.red
      const sheets = rollSquadSheets(this.rng)
      for (let i = 0; i < SQUAD_SIZE; i++) {
        const spawn = map.spawns[faction][i] ?? { x: 2 + i * 2, y: faction === Faction.Blue ? 2 : this.grid.size - 3 }
        const unit = new SimUnit(
          faction,
          i,
          `${faction === Faction.Blue ? 'B' : 'R'}${i}`,
          sheets[i]!,
          plan.weapons[i % plan.weapons.length]!,
          plan.ammo ?? AmmoId.Standard,
          spawn,
          {
            frag: plan.grenades?.frag ?? 1,
            flash: plan.grenades?.flash ?? 0,
            smoke: plan.grenades?.smoke ?? 0,
          } as Record<GrenadeId, number>,
          {
            stim: plan.items?.stim ?? 0,
            firstAid: plan.items?.firstAid ?? 0,
            nullweave: plan.items?.nullweave ?? 0,
          } as Record<ItemId, number>,
        )
        this.units.push(unit)
        this.byFaction[faction].push(unit)
      }
    }
  }

  /** Play until one side is gone or the cap is hit. */
  run(): MatchOutcome {
    while (this.turnNumber <= this.turnCap && this.living(Faction.Blue) && this.living(Faction.Red)) {
      for (const unit of this.byFaction[this.activeFaction]) {
        if (unit.isDead) continue
        this.takeUnitTurn(unit)
      }
      this.endTurn()
    }

    const blueAlive = this.living(Faction.Blue)
    const redAlive = this.living(Faction.Red)

    return {
      seed: this.setup.seed,
      winner: blueAlive === redAlive ? null : blueAlive ? Faction.Blue : Faction.Red,
      turns: this.turnNumber,
      survivors: {
        [Faction.Blue]: this.byFaction[Faction.Blue].filter((u) => !u.isDead).length,
        [Faction.Red]: this.byFaction[Faction.Red].filter((u) => !u.isDead).length,
      },
      traits: {
        [Faction.Blue]: this.traitsOf(Faction.Blue),
        [Faction.Red]: this.traitsOf(Faction.Red),
      },
      byWeapon: Object.fromEntries(this.tally),
      grenadesThrown: this.grenadesThrown,
    }
  }

  private living(faction: Faction): boolean {
    return this.byFaction[faction].some((unit) => !unit.isDead)
  }

  private traitsOf(faction: Faction): string[] {
    const seen = new Set<string>()
    for (const unit of this.byFaction[faction]) {
      for (const id of unit.sheet.traits) seen.add(id)
      if (unit.items.nullweave > 0) seen.add('nullweave')
    }
    return [...seen].sort()
  }

  /**
   * Spend a unit's points.
   *
   * Order is the policy. A good shot is taken at once; a poor one waits until
   * closing the distance has been tried, because a weapon with a range band
   * should be measured inside it — an instrument that fired a shotgun at
   * twelve metres would report the shotgun as useless and be describing
   * itself.
   *
   * Bounded by AP rather than by a step count, and every branch either spends
   * something or breaks, so a unit that can do nothing useful cannot spin.
   */
  private takeUnitTurn(unit: SimUnit): void {
    for (let guard = 0; guard < 64 && unit.ap > 0 && !unit.isDead; guard++) {
      if (this.tryGrenade(unit)) continue

      const worthTaking = this.bestShot(unit)
      if (worthTaking && worthTaking.chance >= PREFERRED_CHANCE) {
        this.fireAt(unit, worthTaking)
        continue
      }

      if (this.tryAdvance(unit)) continue

      // Nowhere better to be: take the shot on offer, however poor.
      const lastResort = this.bestShot(unit)
      if (lastResort) {
        this.fireAt(unit, lastResort)
        continue
      }

      if (this.tryCover(unit)) continue
      break
    }
  }

  /** Enemies this unit can actually see. */
  private visibleEnemies(unit: SimUnit): SimUnit[] {
    const enemies = this.byFaction[unit.faction === Faction.Blue ? Faction.Red : Faction.Blue]
    return enemies.filter(
      (enemy) =>
        !enemy.isDead &&
        this.grid.distance(unit.tile, enemy.tile) <= RULES.sightRange &&
        hasLineOfSight(this.grid, unit.tile, enemy.tile),
    )
  }

  /**
   * The best shot available, by damage per action point.
   *
   * Expected rather than maximum: a burst that lands one round in three is
   * worse than a snap shot that lands, and the whole point of measuring is to
   * find out which weapons that is true for.
   */
  private bestShot(unit: SimUnit): PlannedShot | null {
    let best: PlannedShot | null = null

    for (const target of this.visibleEnemies(unit)) {
      for (const mode of unit.weapon.availableModes) {
        if (!canShoot(this.grid, unit, target, mode)) continue
        const bullets = unit.weapon.bulletConsumption(mode)
        if (unit.weapon.currentClip < bullets) continue
        const chance = calculateHitChance(this.grid, unit, target, mode) / 100
        const damage = resolveDamage(effectiveWeapon(unit, mode), target).damage
        const value = (chance * damage * bullets) / Math.max(1, shotApCost(unit, mode))
        if (!best || value > best.value) best = { target, mode, chance, value }
      }
    }

    return best
  }

  /** Pull the trigger on an already-chosen shot, and write down what it did. */
  private fireAt(unit: SimUnit, shot: PlannedShot): boolean {
    const weapon = unit.weapon.id
    const tally = this.tally.get(weapon) ?? emptyTally()
    const before = shot.target.hp
    const result = fireWeapon(
      this.grid,
      unit,
      shot.target,
      NO_FX,
      this.units,
      shot.mode,
      undefined,
      this.roll,
    )
    if (!result) return false

    tally.shots += 1
    tally.rounds += unit.weapon.bulletConsumption(shot.mode)
    if (result.hit) tally.hits += 1
    tally.damage += before - shot.target.hp
    tally.crits += result.crits
    if (shot.target.isDead) tally.kills += 1
    this.tally.set(weapon, tally)
    return true
  }

  /**
   * Throw at a cluster, never at one body.
   *
   * A grenade is worth its slot when it catches two, so that is the bar. It
   * also refuses to catch its own side, which is the rule a player is applying
   * when they decide not to throw.
   */
  private tryGrenade(unit: SimUnit): boolean {
    const spec = GRENADES.frag
    if ((unit.grenades.frag ?? 0) <= 0 || unit.ap < spec.apCost) return false

    const enemies = this.visibleEnemies(unit)
    if (enemies.length < 2) return false

    for (const centre of enemies) {
      if (this.grid.distance(unit.tile, centre.tile) > spec.throwRange) continue
      const caught = this.units.filter(
        (other) => !other.isDead && this.grid.distance(centre.tile, other.tile) <= spec.areaRadius,
      )
      if (caught.filter((other) => other.faction !== unit.faction).length < 2) continue
      if (caught.some((other) => other.faction === unit.faction)) continue

      const result = throwGrenade(this.grid, unit, centre.tile, 'frag' as GrenadeId, this.units)
      if (!result.thrown) continue
      this.grenadesThrown += 1
      return true
    }
    return false
  }

  /** Close on the nearest enemy, spending what the steps actually cost. */
  private tryAdvance(unit: SimUnit): boolean {
    const enemies = this.byFaction[unit.faction === Faction.Blue ? Faction.Red : Faction.Blue].filter(
      (enemy) => !enemy.isDead,
    )
    if (enemies.length === 0) return false

    const goal = enemies.reduce((nearest, enemy) =>
      this.grid.distance(unit.tile, enemy.tile) < this.grid.distance(unit.tile, nearest.tile)
        ? enemy
        : nearest,
    )

    const occupied = new Set<number>()
    for (const other of this.units) {
      if (other === unit || other.isDead) continue
      occupied.add(this.grid.index(other.tile.x, other.tile.y))
    }

    const { path } = findPathSegment(this.grid, unit.tile, goal.tile, occupied)
    if (path.length < 2) return false

    let moved = false
    for (let i = 1; i < path.length; i++) {
      const step = path[i]!
      // Stop short of walking onto the target: the last tile is where it stands.
      if (tileEquals(step, goal.tile)) break
      const cost = stepCostFor(this.grid, unit, path[i - 1]!, step)
      if (unit.ap < cost) break
      unit.ap -= cost
      unit.tile = { ...step }
      unit.exitCover()
      moved = true
      // One tile at a time, then re-decide, and stop the moment there is a
      // shot to take rather than the moment something comes into view: a
      // shotgun reaches 12 m and sees 14, so breaking on sight left it frozen
      // just outside its own range, never firing a round all match.
      const shot = this.bestShot(unit)
      if (shot && shot.chance >= PREFERRED_CHANCE) break
    }
    return moved
  }

  /** Hurt, with nothing to shoot: get low. */
  private tryCover(unit: SimUnit): boolean {
    if (unit.isCrouching || unit.ap < RULES.coverApCost) return false
    if (unit.hp > unit.maxHp / 2) return false
    unit.ap -= RULES.coverApCost
    unit.enterCover()
    return true
  }

  /**
   * The game's own turn boundary, in the game's own order: hand over, refill
   * the incoming side, then settle - which is what `InteractionController`
   * does via `TurnSystem` and `settleTurn`.
   */
  private endTurn(): void {
    this.activeFaction = this.activeFaction === Faction.Blue ? Faction.Red : Faction.Blue
    if (this.activeFaction === Faction.Blue) this.turnNumber++
    for (const unit of this.byFaction[this.activeFaction]) {
      if (unit.isDead) continue
      unit.ap = unit.effectiveMaxAp
    }
    settleTurn(this.units, this.activeFaction)
  }
}

/** Play one match. */
export function simulate(setup: MatchSetup): MatchOutcome {
  return new SimMatch(setup).run()
}
