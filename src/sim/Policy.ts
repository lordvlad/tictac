import { Faction, RULES } from '../config'
import type { ShotMode } from '../core/Arsenal'
import { GrenadeId, GRENADES } from '../core/Arsenal'
import { MELEE } from '../core/Melee'
import { burningTiles } from '../core/Fire'
import type { Grid } from '../core/Grid'
import { reachable, routeTo } from '../core/Pathfinding'
import { leaversOf, onWayOut, rowsFromWayOut } from '../core/Retreat'
import { hasLineOfSight } from '../core/Visibility'
import { fromBehind, headingToward } from '../core/Facing'
import { effectiveWeapon, expectedRoundDamage, meleeChance, meleeWeapon, resolveDamage } from '../core/Ballistics'
import type { Soldier } from '../entities/Soldier'
import { canMelee, canShoot, shotApCost, shotBreakdown } from '../game/Combat'
import { moveBudget, stepCostFor } from '../game/Movement'
import type { NetworkMessage } from '../game/NetworkManager'
import { canWatch } from '../game/Overwatch'
import type { Applied, Carried } from '../ecs/systems/CommandSystem'
import { isIndoors } from './Ground'
import { Intel } from './Intel'
import type { MatchHost } from './MatchHost'
import { chooseDestination, type Spacing } from './Tactics'

/**
 * What a side fights to (GDD combat §2.8, `ITEM-052`): when, if ever, it
 * pulls back to its way out and retreats.
 *
 * - `stand`: never. Fights to the end — the sweep's instrument.
 * - `cautious`: pulls out after its first wound or death.
 * - `opportunist`: fights while it believes it is winning; pulls out once the
 *   enemies it knows of outnumber it, or it is down to half its health.
 * - `evade`: pulls out at once.
 *
 * Decided from what the side holds of itself and what its {@link Intel} has
 * seen of the enemy, never from the enemy's true state.
 */
export type StandingOrder = 'stand' | 'cautious' | 'opportunist' | 'evade'

/**
 * The hit chance a unit will settle for rather than keep closing.
 *
 * A judgement, not a rule: it is what stops the instrument measuring every
 * weapon at the longest range it can technically reach.
 */
const PREFERRED_CHANCE = 0.5

/** An attack the policy has chosen but not yet made: a shot, or a blow. */
export interface PlannedShot {
  target: Soldier
  /** `melee` for a blow with the sidearm; otherwise the shot mode. */
  mode: ShotMode | 'melee'
  /** Probability, not percent — it is arithmetic here, not display. */
  chance: number
  /** Expected damage per action point, which is how it was chosen. */
  value: number
}

/** An attack that was made, and what came of it. */
export interface Attack {
  unit: Soldier
  shot: PlannedShot
  result: Carried['shot']
  /** Hit points the target lost, reactions included. */
  damage: number
  /** Tiles to the target when it was fired. */
  range: number
  /** Whether the attacker stood indoors when it was fired. */
  indoors: boolean
}

/** What a caller may want to know as the policy plays; every part optional. */
export interface PolicyObserver {
  attacked?(attack: Attack): void
  threw?(unit: Soldier): void
  watched?(unit: Soldier): void
  /** After each tile walked. */
  stepped?(unit: Soldier): void
  /** After a unit has spent what it is going to, just before it ends its turn. */
  finished?(unit: Soldier): void
  /** After a side's units have all played, just before it hands over. */
  ending?(faction: Faction): void
}

export interface PolicyOptions {
  /** Whether each side's units may go on watch. Both may, when absent. */
  watching?: Record<Faction, boolean>
  observer?: PolicyObserver
  /**
   * Expected hit points a unit charges itself for each squadmate within a
   * frag's blast of the tile it considers. Zero when absent: the sweep
   * measures guns, and a preference about company would be a statement about
   * the AI instead.
   */
  spacing?: number
  /** Each side's {@link StandingOrder}; `stand` when absent. */
  orders?: Partial<Record<Faction, StandingOrder>>
}

/**
 * The AI: how a side reads the board and decides what to do with its points.
 *
 * A *policy*, and nothing else. It sees a {@link MatchHost} and hands it
 * intents through `apply` — exactly the position a player is in. What happens
 * to an intent besides being applied is the caller's business: the sweep
 * writes it down, an AI opponent sends it to the player it is facing. That is
 * what lets the one policy be both the instrument the balance numbers come
 * from and the opponent in a played match.
 *
 * The AI is deliberately dull. It is a measuring instrument, not an opponent:
 * it takes the best shot it can see, closes the distance when it cannot see
 * one, and hunkers down when it is hurt and out of options. Anything cleverer
 * would make the numbers a statement about the AI instead of about the guns.
 */
export class Policy {
  /** Handovers since anybody lost a hit point; see `chooseDestination`. */
  private quiet = 0
  /** What each side knows about the other; see {@link Intel}. */
  private readonly intel: Record<Faction, Intel>
  private readonly watching: Record<Faction, boolean>
  private readonly observer: PolicyObserver
  private readonly spacing: number
  private readonly orders: Record<Faction, StandingOrder>
  /** Once a side has decided to pull out it keeps pulling out. */
  private readonly pullingOut: Record<Faction, boolean> = { [Faction.Blue]: false, [Faction.Red]: false }
  /** Each unit's hit points when the match began, which is what a first wound is measured from. */
  private readonly startHp = new Map<Soldier, number>()

  /**
   * @param apply Carries one intent out against `host` and answers for it. A
   *   refusal throws here: the policy asks the same rules the host enforces
   *   before it acts, so a refused intent is a bug in one of them, never a
   *   move to shrug off.
   */
  constructor(
    private readonly host: MatchHost,
    private readonly apply: (command: NetworkMessage) => Applied,
    options: PolicyOptions = {},
  ) {
    this.watching = options.watching ?? { [Faction.Blue]: true, [Faction.Red]: true }
    this.observer = options.observer ?? {}
    this.spacing = options.spacing ?? 0
    this.orders = {
      [Faction.Blue]: options.orders?.[Faction.Blue] ?? 'stand',
      [Faction.Red]: options.orders?.[Faction.Red] ?? 'stand',
    }
    for (const unit of host.squads.soldiers) this.startHp.set(unit, unit.hp)
    const { byFaction } = host.squads
    this.intel = {
      [Faction.Blue]: new Intel(host.grid, byFaction[Faction.Blue], byFaction[Faction.Red]),
      [Faction.Red]: new Intel(host.grid, byFaction[Faction.Red], byFaction[Faction.Blue]),
    }
    for (const faction of [Faction.Blue, Faction.Red]) {
      this.intel[faction].observe()
      for (const unit of byFaction[faction]) this.intel[faction].survey(unit, host.turnNumber)
    }
    // A side hears through its own units' ears; one of them is enough.
    host.commands.onNoise = (noise, heard) => {
      this.intel[heard[0]!.faction].hear(noise, host.turnNumber)
    }
    // A broken window is a new way through, which every cached walk has to know.
    host.walls.onWallsChanged = () => {
      this.intel[Faction.Blue].forgetGround()
      this.intel[Faction.Red].forgetGround()
    }
  }

  private get grid(): Grid {
    return this.host.grid
  }

  /**
   * Play the active side's whole turn, a unit at a time.
   *
   * A generator so that a caller with something else to do — a browser with a
   * frame to draw — can take a breath between units, while one with nothing
   * (the sweep) simply runs it through with {@link playTurn}.
   */
  *steps(): Generator<void, void> {
    const faction = this.host.activeFaction
    if (!this.pullingOut[faction] && this.wantsOut(faction)) this.pullingOut[faction] = true
    if (this.pullingOut[faction]) {
      yield* this.pullOut(faction)
      return
    }
    const before = this.totalHp()
    for (const unit of this.host.squads.byFaction[faction]) {
      if (unit.isDead) continue
      this.takeUnitTurn(unit)
      yield
    }
    // Measured across the whole side's turn, reactions on its movers included.
    this.quiet = this.totalHp() < before ? 0 : this.quiet + 1
    this.observer.ending?.(faction)
    this.act({ type: 'endTurn', faction })
  }

  /** Whether `faction`'s standing order says it is time to get out. */
  private wantsOut(faction: Faction): boolean {
    const side = this.host.squads.byFaction[faction]
    switch (this.orders[faction]) {
      case 'stand':
        return false
      case 'evade':
        return true
      case 'cautious':
        return side.some((unit) => unit.isDead || unit.hp < (this.startHp.get(unit) ?? unit.maxHp))
      case 'opportunist': {
        const living = side.filter((unit) => !unit.isDead)
        let hp = 0
        let start = 0
        for (const unit of side) {
          hp += Math.max(0, unit.hp)
          start += this.startHp.get(unit) ?? unit.maxHp
        }
        return this.intel[faction].contacts.length > living.length || hp * 2 <= start
      }
    }
  }

  /**
   * A side getting out: everyone who can walks for the way out, and once
   * everyone who still takes orders is standing on it, the side retreats.
   * Anyone the rules are running — broken — is not waited for.
   */
  private *pullOut(faction: Faction): Generator<void, void> {
    const side = this.host.squads.byFaction[faction]
    for (const unit of side) {
      if (unit.isDead) continue
      if (!unit.broken) this.walkHome(unit)
      // Shot dead on the way: there is no turn left to end.
      if (unit.isDead) continue
      this.act({ type: 'endUnitTurn', faction, squadIndex: unit.squadIndex })
      yield
    }
    const size = this.grid.size
    const leaving = leaversOf(side, faction, size)
    const ready = leaving.length > 0 && side.every((unit) => unit.isDead || unit.broken || onWayOut(faction, unit.tile, size))
    this.observer.ending?.(faction)
    // A retreat that fails hands over by itself; one that succeeds ends the match.
    this.act(ready ? { type: 'retreat', faction } : { type: 'endTurn', faction })
  }

  /**
   * Walk as far toward the way out as the points allow: the reachable tile
   * fewest rows from it, the cheapest of those, one tile per intent like
   * every other walk.
   */
  private walkHome(unit: Soldier): void {
    const size = this.grid.size
    const here = rowsFromWayOut(unit.faction, unit.tile, size)
    if (here === 0) return
    const occupied = burningTiles(this.grid)
    for (const other of this.host.squads.soldiers) {
      if (other === unit || other.isDead) continue
      occupied.add(this.grid.index(other.tile.x, other.tile.y))
    }
    const reach = reachable(this.grid, unit.tile, occupied, moveBudget(unit))
    let best = -1
    let bestRows = here
    // Cheapest first, so the first tile at the fewest rows is the cheapest.
    for (const index of reach.tiles) {
      const rows = rowsFromWayOut(unit.faction, { x: index % size, y: (index / size) | 0 }, size)
      if (rows < bestRows) {
        best = index
        bestRows = rows
      }
    }
    if (best < 0) return
    const route = routeTo(this.grid, reach, best)
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
      this.observer.stepped?.(unit)
      if (unit.isDead) break
    }
  }

  /** Play the active side's whole turn, without pause. */
  playTurn(): void {
    const turn = this.steps()
    while (!turn.next().done);
  }

  /** Both sides look after every intent: the one acting sees what it walked into, and the other sees whatever just walked past it. */
  private act(command: NetworkMessage): Carried {
    const applied = this.apply(command)
    if (!applied.applied) {
      throw new Error(`ai issued an intent the rules refused (${applied.reason}): ${JSON.stringify(command)}`)
    }
    this.intel[Faction.Blue].observe()
    this.intel[Faction.Red].observe()
    return applied
  }

  private totalHp(): number {
    let total = 0
    for (const unit of this.host.squads.soldiers) total += Math.max(0, unit.hp)
    return total
  }

  private enemiesOf(unit: Soldier): readonly Soldier[] {
    return this.host.squads.byFaction[unit.faction === Faction.Blue ? Faction.Red : Faction.Blue]
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
      if (this.tryFrag(unit)) continue

      // Where to stand first, then whether to shoot. The scorer counts staying
      // put and firing from here as one of its candidates, so a unit only moves
      // when a reachable tile is worth more by its own estimate. Asked the
      // other way round — shoot anything at 50%, move only if nothing was —
      // a shotgun fired from eight metres, because a shell nearly always lands
      // *something*, and never closed to where it is the best gun there is.
      // …unless the walk was cut short by spotting somebody. The route was
      // chosen not knowing they were there, so the unit gets to choose again
      // knowing it — which is what a player does on seeing an enemy mid-move.
      if (!moved) {
        const walked = this.tryReposition(unit)
        if (walked) {
          moved = walked === 'arrived'
          continue
        }
      }

      const worthTaking = this.bestShot(unit)
      if (worthTaking && worthTaking.chance >= PREFERRED_CHANCE) {
        this.fireAt(unit, worthTaking)
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

      // No shot at all: an enemy it can see but not hit — behind a crate, or
      // out of the gun's reach — can still be burned out of where it is.
      if (this.tryIncendiary(unit)) continue

      if (this.tryReload(unit, 'low')) continue
      if (this.tryCover(unit)) continue
      if (this.tryWatch(unit)) continue
      break
    }

    // A unit shot dead partway through its own move has no turn left to end,
    // and the host refuses the intent for one that is not alive.
    if (unit.isDead) return
    this.observer.finished?.(unit)
    this.intel[unit.faction].survey(unit, this.host.turnNumber)
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
   * The best attack available, by damage per action point.
   *
   * Expected rather than maximum: a burst that lands one round in three is
   * worse than a snap shot that lands, and the whole point of measuring is to
   * find out which weapons that is true for. A blow with the sidearm is one
   * more option on the same scale, so the policy strikes exactly when striking
   * is worth more than shooting — never because it was told to.
   */
  private bestShot(unit: Soldier): PlannedShot | null {
    let best: PlannedShot | null = null

    for (const target of this.visibleEnemies(unit)) {
      if (canMelee(this.grid, unit, target)) {
        const behind = fromBehind(target, unit.tile)
        const chance = meleeChance(unit, target, behind).chance / 100
        const damage = resolveDamage(meleeWeapon(unit, behind), target).damage
        const value = (chance * damage) / MELEE[unit.sidearm].apCost
        if (!best || value > best.value) best = { target, mode: 'melee', chance, value }
      }
      for (const mode of unit.weapon.availableModes) {
        if (!canShoot(this.grid, unit, target, mode)) continue
        const bullets = unit.weapon.bulletConsumption(mode)
        if (unit.weapon.currentClip < bullets) continue
        const odds = shotBreakdown(this.grid, unit, target, mode)
        const chance = odds.chance / 100
        const expected = expectedRoundDamage(effectiveWeapon(unit, mode), target, odds)
        const value = (expected * bullets) / Math.max(1, shotApCost(unit, mode))
        if (!best || value > best.value) best = { target, mode, chance, value }
      }
    }

    return best
  }

  /**
   * Make an already-chosen attack, and tell the observer what it did.
   *
   * Everything the observer needs is read around the act: where it was fired
   * from, before anything moves — a reaction to this shot cannot move the
   * shooter, but the target can die and leave its tile.
   */
  private fireAt(unit: Soldier, shot: PlannedShot): void {
    const before = shot.target.hp
    const indoors = isIndoors(this.grid, unit.tile)
    const range = this.grid.distance(unit.tile, shot.target.tile)
    const { shot: result } =
      shot.mode === 'melee'
        ? this.act({
            type: 'meleeAttack',
            attackerFaction: unit.faction,
            attackerIndex: unit.squadIndex,
            targetFaction: shot.target.faction,
            targetIndex: shot.target.squadIndex,
          })
        : this.act({
            type: 'fireShot',
            shooterFaction: unit.faction,
            shooterIndex: unit.squadIndex,
            targetFaction: shot.target.faction,
            targetIndex: shot.target.squadIndex,
            mode: shot.mode,
          })
    this.observer.attacked?.({ unit, shot, result, damage: before - shot.target.hp, range, indoors })
  }

  /**
   * Throw at a cluster, never at one body.
   *
   * A grenade is worth its slot when it catches two, so that is the bar. It
   * also refuses to catch its own side, which is the rule a player is applying
   * when they decide not to throw.
   */
  private tryFrag(unit: Soldier): boolean {
    const spec = unit.grenadeSpecs.frag
    if ((unit.grenades.frag ?? 0) <= 0 || unit.ap < GRENADES.frag.apCost) return false

    const enemies = this.visibleEnemies(unit)
    if (enemies.length < 2) return false

    for (const centre of enemies) {
      if (this.grid.distance(unit.tile, centre.tile) > spec.throwRange) continue
      // Only what it can see counts toward the pair: an enemy crouched round
      // the corner is not a reason to throw, however near it happens to be.
      const caught = (other: Soldier) => !other.isDead && this.grid.distance(centre.tile, other.tile) <= spec.areaRadius
      if (enemies.filter(caught).length < 2) continue
      if (this.host.squads.byFaction[unit.faction].some(caught)) continue
      this.throwAt(unit, GrenadeId.Frag, centre)
      return true
    }
    return false
  }

  /**
   * Set an enemy it can see alight, when none of its own side is near enough
   * to be caught by the blast or by what spreads from it in a turn. One body
   * is enough here, unlike a frag: the fire keeps burning it, and the ground
   * it stands on is denied to it.
   */
  private tryIncendiary(unit: Soldier): boolean {
    const spec = unit.grenadeSpecs.incendiary
    if ((unit.grenades.incendiary ?? 0) <= 0 || unit.ap < spec.apCost) return false
    const clear = spec.areaRadius + 1
    for (const target of this.visibleEnemies(unit)) {
      if (this.grid.distance(unit.tile, target.tile) > spec.throwRange) continue
      if (this.grid.fireAt(target.tile.x, target.tile.y) > 0) continue
      const near = (other: Soldier) => !other.isDead && this.grid.distance(target.tile, other.tile) <= clear
      if (this.host.squads.byFaction[unit.faction].some(near)) continue
      this.throwAt(unit, GrenadeId.Incendiary, target)
      return true
    }
    return false
  }

  private throwAt(unit: Soldier, kind: GrenadeId, target: Soldier): void {
    this.act({
      type: 'throwGrenade',
      shooterFaction: unit.faction,
      shooterIndex: unit.squadIndex,
      kind,
      targetTile: { x: target.tile.x, y: target.tile.y },
    })
    this.observer.threw?.(unit)
  }

  /** What `unit` pays for company, or null when it pays nothing. */
  private spacingFor(unit: Soldier): Spacing | null {
    if (this.spacing <= 0) return null
    const allies = this.host.squads.byFaction[unit.faction]
      .filter((other) => other !== unit && !other.isDead)
      .map((other) => other.tile)
    return { allies, radius: unit.grenadeSpecs.frag.areaRadius, cost: this.spacing }
  }

  /**
   * Go where {@link chooseDestination} says, one tile per intent.
   *
   * One tile at a time because a walk can be interrupted: a watcher may shoot
   * the unit on any arrival, and a wound mid-route changes what the next step
   * costs. A player can issue the same one-tile moves.
   *
   * @returns `spotted` when the walk stopped because the side saw an enemy it
   *   had not known about; `arrived` when it went where it meant to, or as far
   *   as its points allowed; null when it stayed put.
   */
  private tryReposition(unit: Soldier): 'arrived' | 'spotted' | null {
    // Fire is ground nobody walks through by choice.
    const occupied = burningTiles(this.grid)
    for (const other of this.host.squads.soldiers) {
      if (other === unit || other.isDead) continue
      occupied.add(this.grid.index(other.tile.x, other.tile.y))
    }
    const intel = this.intel[unit.faction]
    const contacts = intel.contacts
    const search = contacts.length === 0 ? intel.searchFrom(unit, this.host.turnNumber) : null
    const destination = chooseDestination(this.grid, unit, contacts, occupied, this.quiet, search, this.spacingFor(unit))
    if (!destination) return null
    const known = new Set(contacts.map((contact) => contact.unit))

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
      this.observer.stepped?.(unit)
      if (unit.isDead) break
      if (intel.contacts.some((contact) => !known.has(contact.unit))) return 'spotted'
    }
    return 'arrived'
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
   *
   * Faced first, toward where trouble is expected: a watcher that is not yet in
   * the fight only reacts to what is in front of it, and a unit's facing is
   * otherwise wherever its last step happened to point.
   */
  private tryWatch(unit: Soldier): boolean {
    if (!this.watching[unit.faction] || !canWatch(unit)) return false
    const toward = this.intel[unit.faction].expectFrom(unit)
    if (headingToward(toward.x - unit.tile.x, toward.y - unit.tile.y, unit.heading) !== unit.heading) {
      const at = this.grid.tileToWorld(toward)
      this.act({ type: 'rightClickFacing', faction: unit.faction, squadIndex: unit.squadIndex, x: at.x, z: at.z })
    }
    this.act({ type: 'overwatch', faction: unit.faction, squadIndex: unit.squadIndex })
    this.observer.watched?.(unit)
    return true
  }
}
