import { Faction, RULES, SQUAD_SIZE } from '../config'
import { AmmoId, type GrenadeId, GRENADES, type ShotMode, type WeaponId } from '../core/Arsenal'
import type { AttachmentId } from '../core/Attachments'
import { type CharacterSheet, rollSquadSheets } from '../core/Characters'
import type { Grid } from '../core/Grid'
import { ItemId } from '../core/Items'
import { Rng } from '../core/rng'
import { hasLineOfSight } from '../core/Visibility'
import { effectiveWeapon, resolveDamage } from '../core/Ballistics'
import type { Soldier } from '../entities/Soldier'
import { calculateHitChance, canShoot, shotApCost } from '../game/Combat'
import type { SquadLoadout } from '../game/Loadout'
import { stepCostFor } from '../game/Movement'
import { chooseDestination } from './Tactics'
import type { NetworkMessage } from '../game/NetworkManager'
import { canWatch } from '../game/Overwatch'
import {
  type CombatRecording,
  RECORDING_VERSION,
  Recorder,
  type RecordingHeader,
} from '../game/Recording'
import { type Carried, MatchHost } from './MatchHost'

/** What one squad brought, so a sweep can vary it. */
export interface SquadPlan {
  weapons: readonly WeaponId[]
  ammo?: AmmoId
  grenades?: Partial<Record<GrenadeId, number>>
  items?: Partial<Record<ItemId, number>>
  /** Fitted to every unit's weapon, as far as its class has room. */
  attachments?: readonly AttachmentId[]
  /**
   * Whether this side's policy may go on watch. Policy, not kit — here so a
   * sweep can price the ability by taking it away from one side.
   */
  watch?: boolean
}

/**
 * A plan, spelled out one unit at a time.
 *
 * A {@link SquadPlan} is shorthand — four weapons cycled across the squad,
 * everything else a default — and a {@link SquadLoadout} is the same kit in the
 * form the rendered game equips from. The match builds its units through this,
 * so a recording's loadout is by construction the kit the match actually ran
 * rather than a second guess at it.
 */
export function planToLoadout(plan: SquadPlan): SquadLoadout {
  return Array.from({ length: SQUAD_SIZE }, (_, i) => ({
    weaponId: plan.weapons[i % plan.weapons.length]!,
    ammoId: plan.ammo ?? AmmoId.Standard,
    grenades: {
      frag: plan.grenades?.frag ?? 1,
      flash: plan.grenades?.flash ?? 0,
      smoke: plan.grenades?.smoke ?? 0,
    } as Record<GrenadeId, number>,
    // Every id, so a plan naming one piece does not leave the rest undefined
    // for the trait fold to read.
    items: Object.fromEntries(
      Object.values(ItemId).map((id) => [id, plan.items?.[id] ?? 0]),
    ) as Record<ItemId, number>,
    attachments: [...(plan.attachments ?? [])],
  }))
}

export interface MatchSetup {
  seed: number
  blue: SquadPlan
  red: SquadPlan
  /** Declared a draw once both sides have had this many turns. */
  turnCap?: number
  /** Keep a replayable command stream. Off by default; a sweep opts in. */
  record?: boolean
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
  /** Watches set, and the reactions they actually produced. */
  watches: number
  reactions: number
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
  target: Soldier
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
 * A *policy*, and nothing else. The match itself is a {@link MatchHost}: the
 * same ECS soldiers, systems and turn handover a played game runs, driven by
 * the same intents a player's clicks produce. This class reads the board,
 * decides, and hands the host an intent — exactly the position a player is in.
 *
 * It used to be a second engine: a scene-free copy of the soldier (`SimUnit`)
 * and its own turn loop, written when a soldier could not exist without a
 * scene. That stopped being true a day later and the copy stayed, drifting
 * quietly — wounds that cost the sweep no action points, a handover settled in
 * the opposite order, walking that never counted toward exhaustion. Each moved
 * every balance number a little and broke none of them. With one engine, a
 * number measured here is a number about the game by construction.
 *
 * The AI is deliberately dull. It is a measuring instrument, not an opponent:
 * it takes the best shot it can see, closes the distance when it cannot see
 * one, and hunkers down when it is hurt and out of options. Anything cleverer
 * would make the numbers a statement about the AI instead of about the guns.
 */
export class SimMatch {
  readonly host: MatchHost
  /** The people this match rolled, so a recording can redeploy them. */
  readonly sheets: Record<Faction, CharacterSheet[]>
  /** The kit each side fought with, in the form the rendered game equips from. */
  readonly loadouts: Record<Faction, SquadLoadout>
  /** Null unless the setup asked to record. */
  readonly recorder: Recorder | null

  private readonly tally = new Map<string, WeaponTally>()
  private readonly turnCap: number
  private grenadesThrown = 0
  private watches = 0
  /** Handovers since anybody lost a hit point; see `chooseDestination`. */
  private quiet = 0

  constructor(private readonly setup: MatchSetup) {
    this.turnCap = setup.turnCap ?? DEFAULT_TURN_CAP
    // Setup's own stream: who turns up is dealt from the seed, and the match's
    // dice are the host's (`matchDice`), so how many numbers a sheet consumed
    // can never move a roll.
    const deal = new Rng(setup.seed >>> 0)
    const blue = rollSquadSheets(deal)
    const red = rollSquadSheets(deal)
    this.sheets = { [Faction.Blue]: blue, [Faction.Red]: red }
    this.loadouts = {
      [Faction.Blue]: planToLoadout(setup.blue),
      [Faction.Red]: planToLoadout(setup.red),
    }

    const header: RecordingHeader = {
      version: RECORDING_VERSION,
      seed: setup.seed >>> 0,
      seedLabel: String(setup.seed >>> 0),
      source: 'sim',
      createdAt: new Date().toISOString(),
      turnCap: this.turnCap,
      sheets: this.sheets,
      loadouts: this.loadouts,
    }
    this.host = new MatchHost(header)
    this.recorder = setup.record
      ? new Recorder(header, () => ({ turn: this.host.turnNumber, faction: this.host.activeFaction }))
      : null
  }

  get grid(): Grid {
    return this.host.grid
  }

  /** The commands this match issued, or null when it was not recording. */
  get recording(): CombatRecording | null {
    return this.recorder?.toJSON() ?? null
  }

  /** Play until one side is gone or the cap is hit. */
  run(): MatchOutcome {
    const { byFaction } = this.host.squads
    while (this.host.turnNumber <= this.turnCap && this.living(Faction.Blue) && this.living(Faction.Red)) {
      const before = this.totalHp()
      for (const unit of byFaction[this.host.activeFaction]) {
        if (unit.isDead) continue
        this.takeUnitTurn(unit)
      }
      // Measured across the whole side's turn, reactions on its movers included.
      this.quiet = this.totalHp() < before ? 0 : this.quiet + 1
      this.act({ type: 'endTurn', faction: this.host.activeFaction })
    }

    const blueAlive = this.living(Faction.Blue)
    const redAlive = this.living(Faction.Red)

    return {
      seed: this.setup.seed,
      winner: blueAlive === redAlive ? null : blueAlive ? Faction.Blue : Faction.Red,
      turns: this.host.turnNumber,
      survivors: this.host.living,
      traits: {
        [Faction.Blue]: this.traitsOf(Faction.Blue),
        [Faction.Red]: this.traitsOf(Faction.Red),
      },
      byWeapon: Object.fromEntries(this.tally),
      grenadesThrown: this.grenadesThrown,
      watches: this.watches,
      reactions: this.host.reactions,
    }
  }

  /**
   * Hand the host one intent, and write it down.
   *
   * Recorded before it is applied so the stamp names the side that issued it —
   * an `endTurn` stamped afterwards would carry the side coming in. A refusal
   * throws: the policy asks the same rules the host enforces before it acts, so
   * a refused intent is a bug in one of them, never a move to shrug off.
   */
  private act(command: NetworkMessage): Carried {
    this.recorder?.record(command)
    const applied = this.host.apply(command)
    if (!applied.applied) {
      throw new Error(`sim issued an intent the rules refused (${applied.reason}): ${JSON.stringify(command)}`)
    }
    return applied
  }

  private totalHp(): number {
    let total = 0
    for (const unit of this.host.squads.soldiers) total += Math.max(0, unit.hp)
    return total
  }

  private living(faction: Faction): boolean {
    return this.host.squads.byFaction[faction].some((unit) => !unit.isDead)
  }

  private enemiesOf(unit: Soldier): readonly Soldier[] {
    return this.host.squads.byFaction[unit.faction === Faction.Blue ? Faction.Red : Faction.Blue]
  }

  private traitsOf(faction: Faction): string[] {
    const seen = new Set<string>()
    for (const unit of this.host.squads.byFaction[faction]) {
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
  private takeUnitTurn(unit: Soldier): void {
    // One deliberate move per turn: a unit that re-chose its spot after every
    // step would spend its points dithering between two nearly equal tiles.
    let moved = false
    for (let guard = 0; guard < 64 && unit.ap > 0 && !unit.isDead; guard++) {
      if (this.tryReload(unit, 'empty')) continue
      if (this.tryGrenade(unit)) continue

      const worthTaking = this.bestShot(unit)
      if (worthTaking && worthTaking.chance >= PREFERRED_CHANCE) {
        this.fireAt(unit, worthTaking)
        continue
      }

      if (!moved && this.tryReposition(unit)) {
        moved = true
        continue
      }

      // Nowhere better to be. A poor shot now is worth less than the same
      // shot taken at somebody walking into the open, so hold it — unless
      // nobody has walked into anything for a while, in which case the other
      // side is holding too and the poor shot is the only one on offer.
      const lastResort = this.bestShot(unit)
      if (lastResort) {
        this.fireAt(unit, lastResort)
        continue
      }

      if (this.tryReload(unit, 'low')) continue
      if (this.tryCover(unit)) continue
      if (this.tryWatch(unit)) continue
      break
    }

    // A unit shot dead partway through its own move has no turn left to end,
    // and the host refuses the intent for one that is not alive.
    if (unit.isDead) return
    this.act({ type: 'endUnitTurn', faction: unit.faction, squadIndex: unit.squadIndex })
  }

  /** Enemies this unit can actually see. */
  private visibleEnemies(unit: Soldier): Soldier[] {
    return this.enemiesOf(unit).filter(
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
  private bestShot(unit: Soldier): PlannedShot | null {
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
  private fireAt(unit: Soldier, shot: PlannedShot): void {
    const weapon = unit.weapon.id
    const tally = this.tally.get(weapon) ?? emptyTally()
    const before = shot.target.hp
    const { shot: result } = this.act({
      type: 'fireShot',
      shooterFaction: unit.faction,
      shooterIndex: unit.squadIndex,
      targetFaction: shot.target.faction,
      targetIndex: shot.target.squadIndex,
      mode: shot.mode,
    })

    tally.shots += 1
    tally.rounds += unit.weapon.bulletConsumption(shot.mode)
    if (result?.hit) tally.hits += 1
    tally.damage += before - shot.target.hp
    tally.crits += result?.crits ?? 0
    if (shot.target.isDead) tally.kills += 1
    this.tally.set(weapon, tally)
  }

  /**
   * Throw at a cluster, never at one body.
   *
   * A grenade is worth its slot when it catches two, so that is the bar. It
   * also refuses to catch its own side, which is the rule a player is applying
   * when they decide not to throw.
   */
  private tryGrenade(unit: Soldier): boolean {
    const spec = unit.grenadeSpecs.frag
    if ((unit.grenades.frag ?? 0) <= 0 || unit.ap < GRENADES.frag.apCost) return false

    const enemies = this.visibleEnemies(unit)
    if (enemies.length < 2) return false

    for (const centre of enemies) {
      if (this.grid.distance(unit.tile, centre.tile) > spec.throwRange) continue
      const caught = this.host.squads.soldiers.filter(
        (other) => !other.isDead && this.grid.distance(centre.tile, other.tile) <= spec.areaRadius,
      )
      if (caught.filter((other) => other.faction !== unit.faction).length < 2) continue
      if (caught.some((other) => other.faction === unit.faction)) continue

      this.act({
        type: 'throwGrenade',
        shooterFaction: unit.faction,
        shooterIndex: unit.squadIndex,
        kind: 'frag' as GrenadeId,
        targetTile: { x: centre.tile.x, y: centre.tile.y },
      })
      this.grenadesThrown += 1
      return true
    }
    return false
  }

  /**
   * Go where {@link chooseDestination} says, one tile per intent.
   *
   * One tile at a time because a walk can be interrupted: a watcher may shoot
   * the unit on any arrival, and a wound mid-route changes what the next step
   * costs. A player can issue the same one-tile moves.
   */
  private tryReposition(unit: Soldier): boolean {
    const occupied = new Set<number>()
    for (const other of this.host.squads.soldiers) {
      if (other === unit || other.isDead) continue
      occupied.add(this.grid.index(other.tile.x, other.tile.y))
    }
    const destination = chooseDestination(this.grid, unit, this.enemiesOf(unit), occupied, this.quiet)
    if (!destination) return false

    const { route } = destination
    for (let i = 1; i < route.length; i++) {
      const from = route[i - 1]!
      const step = route[i]!
      if (unit.ap < stepCostFor(this.grid, unit, from, step)) break
      this.act({
        type: 'moveUnit',
        faction: unit.faction,
        squadIndex: unit.squadIndex,
        path: [
          { x: from.x, y: from.y },
          { x: step.x, y: step.y },
        ],
      })
      if (unit.isDead) break
    }
    return true
  }

  /**
   * Put a fresh magazine in.
   *
   * `empty` is the forced case — nothing the weapon can fire is loaded — and
   * comes before everything else. `low` is housekeeping with spare points, at
   * half a magazine, and comes after anything useful. The old policy did
   * neither, which went unnoticed while fights were short: once watches spent
   * rounds and fights ran long, matches ended as draws between squads standing
   * a metre apart with nothing in their guns.
   */
  private tryReload(unit: Soldier, when: 'empty' | 'low'): boolean {
    const { weapon } = unit
    if (unit.ap < RULES.reloadApCost || weapon.currentClip >= weapon.maxClip) return false
    const canFire = weapon.availableModes.some((mode) => weapon.currentClip >= weapon.bulletConsumption(mode))
    if (when === 'empty' ? canFire : weapon.currentClip * 2 > weapon.maxClip) return false
    this.act({ type: 'reload', faction: unit.faction, squadIndex: unit.squadIndex })
    return true
  }

  /** Hurt, with nothing to shoot: get low. */
  private tryCover(unit: Soldier): boolean {
    if (unit.isCrouching || unit.ap < RULES.coverApCost) return false
    if (unit.hp > unit.maxHp / 2) return false
    this.act({ type: 'toggleCover', faction: unit.faction, squadIndex: unit.squadIndex })
    return true
  }

  /**
   * Hold the points a unit has nothing better to do with.
   *
   * Last in the policy on purpose: a watch is what is left when there is
   * nothing worth shooting and nowhere better to stand. Measuring it at all
   * requires the AI to use it — a mechanic the sweep's policy ignores reads as
   * worthless in every report, which is exactly how the shotgun once measured
   * by never closing to its own range band.
   */
  private tryWatch(unit: Soldier): boolean {
    const plan = unit.faction === Faction.Blue ? this.setup.blue : this.setup.red
    if (plan.watch === false || !canWatch(unit)) return false
    this.act({ type: 'overwatch', faction: unit.faction, squadIndex: unit.squadIndex })
    this.watches += 1
    return true
  }
}

/** Play one match. */
export function simulate(setup: MatchSetup): MatchOutcome {
  return new SimMatch(setup).run()
}
