import type { Grid } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import { DamageIndicators } from '../render/DamageIndicators'
import type { Ground } from '../render/Ground'
import { hasLineOfSight } from '../core/Visibility'
import { SHOT_MODES, ShotMode } from '../core/Arsenal'
import {
  effectiveWeapon,
  type MeleeBreakdown,
  meleeChance,
  meleeWeapon,
  resolveDamage,
} from '../core/Ballistics'
import { MELEE, type MeleeId } from '../core/Melee'
import { canMelee, canShoot, shotApCost, shotBreakdown, type ShotResult } from './Combat'
import type { ShotOdds } from '../core/Ballistics'
import type { Squads } from './Squads'
import type { EngineContext } from '../engine'

const LOS_CLEAR = 0x79d98b
const LOS_BLOCKED = 0xe05c4f

/** One way of taking the shot, fully priced and rated. */
export interface ShotOption {
  mode: ShotMode
  name: string
  apCost: number
  bullets: number
  odds: ShotOdds
  /**
   * What a round does when it lands, after the target's armour. For buckshot,
   * with the pellets expected to land at this distance — which is how a
   * shotgun's damage falls across a room without the panel saying why.
   */
  damage: number
  armorShred: number
  /** Affordable and in range — i.e. this shot can actually be taken. */
  available: boolean
}

/**
 * A blow with the sidearm, offered beside the shots rather than as a mode of
 * its own: the player is already standing over a target they picked, and the
 * question "shoot it or hit it?" is one decision with its answers side by side.
 */
export interface StrikeOption {
  sidearm: MeleeId
  name: string
  apCost: number
  breakdown: MeleeBreakdown
  /** Damage a blow does, after the target's armour. */
  damage: number
  armorShred: number
}

/** The target being aimed at, and every shot that could be taken at it. */
export interface PendingShot {
  target: Soldier
  weaponName: string
  ammoName: string
  currentClip: number
  maxClip: number
  /**
   * One entry per shot mode, so the panel can put each option on its own card
   * with its real numbers rather than making the player toggle to compare.
   */
  options: ShotOption[]
  /**
   * The blow on offer, or null when {@link canMelee} refuses it — out of reach,
   * another storey, a wall on the shared edge, or not the points for it.
   * Absent rather than greyed, unlike a shot: a shot out of range is still a
   * shot the weapon *has*, while a blow across the room is not an option at
   * all, and a dead row on every target would teach the player to skip it.
   */
  strike: StrikeOption | null
}

/**
 * Shoot mode: which enemies can be shot, which one is picked, and what that
 * shot would do — up to but not including pulling the trigger.
 *
 * Target choice and confirmation are two separate steps on purpose: picking a
 * target only previews it, so a mis-tap costs nothing.
 *
 * Firing changes the world, so the caller supplies `onShotResolved` to re-run
 * fog and refresh the HUD rather than this class reaching across the game.
 */
export class ShootPlanner {
  /** Called after a shot has been resolved. */
  onShotResolved?: () => void

  private readonly damageIndicators: DamageIndicators
  private activeOn = false
  private target: Soldier | null = null

  constructor(
    private readonly grid: Grid,
    private readonly squads: Squads,
    engine: EngineContext,
  ) {
    this.damageIndicators = new DamageIndicators(engine)
  }

  get active(): boolean {
    return this.activeOn
  }

  get selectedTarget(): Soldier | null {
    return this.target
  }

  /**
   * Enemies this shooter may fire at or strike: alive, actually rendered (fog
   * of war must not leak positions through the target list) and either inside
   * the weapon's range or inside arm's reach.
   *
   * Range is judged by the cheapest shot: if any mode can reach, the target is
   * worth offering. Reach is judged by the sidearm, so a unit that cannot
   * afford a round any more still lists the enemy it is standing next to.
   */
  availableTargets(shooter: Soldier): Soldier[] {
    if (shooter.isDead) return []
    return this.squads.soldiers.filter(
      (s) =>
        s.faction !== shooter.faction &&
        !s.isDead &&
        s.seen &&
        (canShoot(this.grid, shooter, s, ShotMode.Snap) || canMelee(this.grid, shooter, s)),
    )
  }

  /**
   * Whether aiming is worth starting: the points for a shot, or somebody in
   * reach of the sidearm. The second half is why the HUD asks here rather than
   * comparing AP to the snap price itself — fists cost less than any round, and
   * a unit with three points left beside an enemy has exactly one thing to do.
   */
  canEnter(shooter: Soldier | null): boolean {
    if (!shooter || shooter.isDead) return false
    if (shooter.ap >= shotApCost(shooter, ShotMode.Snap)) return true
    return this.availableTargets(shooter).length > 0
  }

  /** Enemies close enough to strike with the sidearm, right now. */
  inReach(shooter: Soldier): Soldier[] {
    return this.availableTargets(shooter).filter((s) => canMelee(this.grid, shooter, s))
  }

  /**
   * Start aiming.
   *
   * `shoot` pre-selects the best snap odds, so the player usually only has to
   * pick a card. `strike` pre-selects the best *blow* among the enemies in
   * reach — without it, pressing Strike beside one enemy opened the panel on a
   * different one three metres off, with the Strike row nowhere in it.
   *
   * @returns true when aiming started.
   */
  enter(shooter: Soldier | null, intent: 'shoot' | 'strike' = 'shoot'): boolean {
    if (!shooter || !this.canEnter(shooter)) return false
    const targets = intent === 'strike' ? this.inReach(shooter) : this.availableTargets(shooter)
    if (intent === 'strike' && targets.length === 0) return false
    this.activeOn = true
    const odds = (s: Soldier): number =>
      intent === 'strike'
        ? meleeChance(shooter, s).chance
        : shotBreakdown(this.grid, shooter, s, ShotMode.Snap).chance
    this.target =
      targets.length === 0 ? null : targets.reduce((best, s) => (odds(s) > odds(best) ? s : best))
    return true
  }

  exit(): void {
    this.activeOn = false
    this.target = null
  }

  selectTarget(soldier: Soldier | null): void {
    this.target = soldier
  }

  /** The target being aimed at with every shot option, or null if none is. */
  pending(shooter: Soldier | null): PendingShot | null {
    if (!this.activeOn || !shooter || shooter.isDead) return null
    const target = this.target
    if (!target || target.isDead) return null

    const options: ShotOption[] = shooter.weapon.availableModes.map((mode) => {
      const apCost = shotApCost(shooter, mode)
      const odds = shotBreakdown(this.grid, shooter, target, mode)
      const preview = resolveDamage(effectiveWeapon(shooter, mode), target, 1, false, Math.max(1, odds.landed))
      const bullets = shooter.weapon.bulletConsumption(mode)
      return {
        mode,
        name: SHOT_MODES[mode].name,
        apCost,
        bullets,
        odds,
        damage: preview.damage,
        armorShred: preview.armorShred,
        available: shooter.ap >= apCost && !odds.outOfRange && shooter.weapon.currentClip >= bullets,
      }
    })

    return {
      target,
      weaponName: shooter.weapon.name,
      ammoName: shooter.ammo.name,
      currentClip: shooter.weapon.currentClip,
      maxClip: shooter.weapon.maxClip,
      options,
      strike: canMelee(this.grid, shooter, target) ? strikeOption(shooter, target) : null,
    }
  }
  /**
   * The target of a shot in `mode`, if the panel offers one.
   *
   * Choosing only: the shot itself is a command, resolved by `CommandSystem`
   * from the match's dice exactly as the peer resolves it. This used to roll
   * every round's hit here and hand them in, then let the resolver draw the
   * crits — so a burst drew hit, hit, hit, crit on this side and hit, crit,
   * hit, crit on the peer's, and two peers desynchronised on any burst that
   * landed twice.
   */
  choose(shooter: Soldier, mode: ShotMode): Soldier | null {
    const pending = this.pending(shooter)
    if (!pending) return null
    const option = pending.options.find((o) => o.mode === mode)
    return option?.available ? pending.target : null
  }

  /** Damage numbers and target bookkeeping, once combat has resolved a shot. */
  reportShot(shooter: Soldier, target: Soldier, result: ShotResult): void {
    this.damageIndicators.spawn(target.position, result.hit, result.damage, result.crits > 0)
    this.settle(shooter, target)
    this.onShotResolved?.()
  }

  /**
   * Shoot mode outlives a shot only while another shot is possible.
   *
   * A killed target used to leave the mode aimed at a corpse: the aim camera
   * dropped out, but the panel stayed on shoot until the player cancelled it
   * by hand. Re-entering re-picks the best remaining target exactly the way
   * the first entry did, and refuses when the shooter can no longer afford a
   * shot — which, with nothing left to shoot at, is when the mode is over. A
   * blow resolves through the same report, and a target still in reach keeps
   * the mode open even when no round is affordable any more.
   */
  private settle(shooter: Soldier, target: Soldier): void {
    // Someone else's shot says nothing about the shot being lined up here.
    if (!this.activeOn || this.target !== target) return
    // A second blow is as good a reason to stay aimed as a second round.
    if (!target.isDead && (shooter.ap >= shotApCost(shooter) || canMelee(this.grid, shooter, target))) return
    if (!this.enter(shooter) || this.target === null) this.exit()
  }

  /** Paint reachable-by-bullet tiles, plus a bright marker on the current target. */
  renderOverlay(ground: Ground, shooter: Soldier, hoveredEnemy: Soldier | null): void {
    const size = this.grid.size
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const clear = hasLineOfSight(this.grid, shooter.tile, { x, y })
        ground.paintTile(x, y, clear ? LOS_CLEAR : LOS_BLOCKED, 0.15)
      }
    }

    const marked = this.target ?? hoveredEnemy
    if (marked) ground.paintTile(marked.tile.x, marked.tile.y, LOS_CLEAR, 0.8)
  }

  dispose(): void {
    this.damageIndicators.dispose()
  }
}

/**
 * What a hit would do, without touching anything. Uses the same resolver the
 * shot itself uses, so the number on the panel is the number that lands.
 */
/**
 * The blow on offer, priced and rated through the same terms the resolver
 * uses — {@link meleeChance} for the odds and {@link meleeWeapon} for what
 * lands — so the row on the panel is the blow that is struck.
 */
function strikeOption(attacker: Soldier, target: Soldier): StrikeOption {
  const spec = MELEE[attacker.sidearm]
  const damage = resolveDamage(meleeWeapon(attacker), target)
  return {
    sidearm: spec.id,
    name: spec.name,
    apCost: spec.apCost,
    breakdown: meleeChance(attacker, target),
    damage: damage.damage,
    armorShred: damage.armorShred,
  }
}
