import { Faction, SQUAD_SIZE } from '../config'
import type { MapOptions } from '../core/MapGenerator'
import { AmmoId, type GrenadeId, type WeaponId } from '../core/Arsenal'
import type { AttachmentId } from '../core/Attachments'
import { RoleId } from '../core/Roles'
import { MeleeId } from '../core/Melee'
import { type CharacterSheet, rollSquadSheets } from '../core/Characters'
import type { MoraleBreak } from '../core/Morale'
import { isDoor } from '../core/Doors'
import { WallKind } from '../core/Walls'
import { copyDeeds, type Deeds, type Growth } from '../core/Progression'
import { debrief, winnerOf } from '../game/MatchEnd'
import type { Grid } from '../core/Grid'
import { ItemId } from '../core/Items'
import { Rng } from '../core/rng'
import type { SquadLoadout } from '../game/Loadout'
import { type Attack, Policy } from './Policy'
import {
  type CombatRecording,
  type Deployment,
  RECORDING_VERSION,
  Recorder,
  type RecordingHeader,
} from '../game/Recording'
import { type GroundCovered, GroundTracker } from './Ground'
import { MatchHost } from './MatchHost'

/** What one squad brought, so a sweep can vary it. */
export interface SquadPlan {
  weapons: readonly WeaponId[]
  ammo?: AmmoId
  grenades?: Partial<Record<GrenadeId, number>>
  items?: Partial<Record<ItemId, number>>
  /** Fitted to every unit's weapon, as far as its class has room. */
  attachments?: readonly AttachmentId[]
  /** Every unit's sidearm; fists when absent. */
  sidearm?: MeleeId
  /** Every unit's role; {@link RoleId.Rifleman} — unrestricted — when absent. */
  role?: RoleId
  /**
   * How many deploy, 1 to `SQUAD_SIZE`; a full squad when absent. Here so a
   * sweep can price a man down — what a kept roster with an empty slot fields.
   */
  size?: number
  /**
   * Whether this side's policy may go on watch. Policy, not kit — here so a
   * sweep can price the ability by taking it away from one side.
   */
  watch?: boolean
  /**
   * Every unit's stored fatigue level, `0..FATIGUE.max` — what a sweep prices
   * a worn-out roster at (`[ITEM-039]`). A full squad at level N, not a mix:
   * a sweep asking about a mix runs two plans and compares them.
   */
  fatigue?: number
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
  return Array.from({ length: plan.size ?? SQUAD_SIZE }, (_, i) => ({
    weaponId: plan.weapons[i % plan.weapons.length]!,
    ammoId: plan.ammo ?? AmmoId.Standard,
    grenades: {
      frag: plan.grenades?.frag ?? 1,
      flash: plan.grenades?.flash ?? 0,
      smoke: plan.grenades?.smoke ?? 0,
      stone: 0,
      incendiary: plan.grenades?.incendiary ?? 0,
    },
    // Every id, so a plan naming one piece does not leave the rest undefined
    // for the trait fold to read.
    items: Object.fromEntries(
      Object.values(ItemId).map((id) => [id, plan.items?.[id] ?? 0]),
    ) as Record<ItemId, number>,
    attachments: [...(plan.attachments ?? [])],
    sidearm: plan.sidearm ?? MeleeId.Fists,
    role: plan.role ?? RoleId.Rifleman,
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
  /** A battlefield other than the game's; see {@link MapOptions}. */
  map?: MapOptions
}

/** What one weapon class did over a match. */
export interface WeaponTally {
  shots: number
  hits: number
  damage: number
  kills: number
  crits: number
  rounds: number
  /** Metres to the target, summed over shots; divide by `shots` for the mean. */
  distance: number
  /** Shots fired by a shooter standing indoors, and what they did. */
  indoorShots: number
  indoorDamage: number
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
  /** How much of the map each side used; see {@link GroundCovered}. */
  ground: Record<Faction, GroundCovered>
  /** Units that broke, by the break. */
  breaks: Record<MoraleBreak, number>
  /** Hit points each side lost to fire. */
  burned: Record<Faction, number>
  /** Hit points each side lost to bleeding. */
  bled: Record<Faction, number>
  /** Doors on the map when it ended, and how many of them stood open. */
  doors: { hung: number; opened: number }
  /** The winning side's survivors: what they did, and what it taught them. */
  debriefed: { deeds: Deeds; growth: Growth[] }[]
}

const DEFAULT_TURN_CAP = 40

function emptyTally(): WeaponTally {
  return { shots: 0, hits: 0, damage: 0, kills: 0, crits: 0, rounds: 0, distance: 0, indoorShots: 0, indoorDamage: 0 }
}

/**
 * One match, played out with nobody watching.
 *
 * The match itself is a {@link MatchHost}: the same ECS soldiers, systems and
 * turn handover a played game runs, driven by the same intents a player's
 * clicks produce. Deciding is the {@link Policy}'s job — the same one that
 * plays the opponent in a played match — and this class is what surrounds it
 * in a sweep: it deals the squads, writes the intents down, and tallies what
 * they did.
 *
 * It used to be a second engine: a scene-free copy of the soldier (`SimUnit`)
 * and its own turn loop, written when a soldier could not exist without a
 * scene. That stopped being true a day later and the copy stayed, drifting
 * quietly — wounds that cost the sweep no action points, a handover settled in
 * the opposite order, walking that never counted toward exhaustion. Each moved
 * every balance number a little and broke none of them. With one engine, a
 * number measured here is a number about the game by construction.
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
  private readonly ground: GroundTracker
  private readonly policy: Policy
  private readonly breaks: Record<MoraleBreak, number> = { panic: 0, frenzy: 0, freeze: 0 }
  private readonly burned: Record<Faction, number> = { [Faction.Blue]: 0, [Faction.Red]: 0 }
  private readonly bled: Record<Faction, number> = { [Faction.Blue]: 0, [Faction.Red]: 0 }

  constructor(private readonly setup: MatchSetup) {
    this.turnCap = setup.turnCap ?? DEFAULT_TURN_CAP
    // Setup's own stream: who turns up is dealt from the seed, and the match's
    // dice are the host's (`matchDice`), so how many numbers a sheet consumed
    // can never move a roll.
    const deal = new Rng(setup.seed >>> 0)
    // Both full squads are dealt before either is cut short, so a smaller
    // side never moves who the other side's people are.
    const blue = rollSquadSheets(deal).slice(0, setup.blue.size ?? SQUAD_SIZE)
    const red = rollSquadSheets(deal).slice(0, setup.red.size ?? SQUAD_SIZE)
    this.sheets = { [Faction.Blue]: blue, [Faction.Red]: red }
    this.loadouts = {
      [Faction.Blue]: planToLoadout(setup.blue),
      [Faction.Red]: planToLoadout(setup.red),
    }

    const squadOf = (faction: Faction, plan: SquadPlan): Deployment[] =>
      this.sheets[faction].map((sheet, i) => ({
        sheet,
        loadout: this.loadouts[faction][i]!,
        ...(plan.fatigue !== undefined ? { state: { fatigue: plan.fatigue } } : {}),
      }))
    const header: RecordingHeader = {
      version: RECORDING_VERSION,
      seed: setup.seed >>> 0,
      seedLabel: String(setup.seed >>> 0),
      source: 'sim',
      createdAt: new Date().toISOString(),
      turnCap: this.turnCap,
      squads: { [Faction.Blue]: squadOf(Faction.Blue, setup.blue), [Faction.Red]: squadOf(Faction.Red, setup.red) },
      ...(setup.map ? { map: setup.map } : {}),
    }
    this.host = new MatchHost(header)
    // Where the squads actually stood at the start, which is what forward and
    // sideways are measured from.
    this.ground = new GroundTracker(this.host.grid, {
      [Faction.Blue]: this.host.squads.byFaction[Faction.Blue].map((unit) => ({ ...unit.tile })),
      [Faction.Red]: this.host.squads.byFaction[Faction.Red].map((unit) => ({ ...unit.tile })),
    })
    this.recorder = setup.record
      ? new Recorder(header, () => ({ turn: this.host.turnNumber, faction: this.host.activeFaction }))
      : null
    // Recorded before it is applied so the stamp names the side that issued
    // it — an `endTurn` stamped afterwards would carry the side coming in.
    this.policy = new Policy(
      this.host,
      (command) => {
        this.recorder?.record(command)
        return this.host.apply(command)
      },
      {
        watching: { [Faction.Blue]: setup.blue.watch !== false, [Faction.Red]: setup.red.watch !== false },
        observer: {
          attacked: (attack) => this.tallyAttack(attack),
          threw: () => {
            this.grenadesThrown += 1
          },
          watched: () => {
            this.watches += 1
          },
          stepped: (unit) => this.ground.step(unit.faction, unit.squadIndex, unit.tile),
          finished: (unit) => this.ground.turnEnded(unit.faction, unit.tile),
        },
      },
    )
    this.host.commands.onBurned = (unit, damage) => {
      this.burned[unit.faction] += damage
    }
    this.host.commands.onSuffered = (unit, damage) => {
      this.bled[unit.faction] += damage
    }
    this.host.commands.onMorale = (_unit, broke) => {
      if (broke) this.breaks[broke] += 1
    }
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
    while (this.host.turnNumber <= this.turnCap && this.living(Faction.Blue) && this.living(Faction.Red)) {
      this.policy.playTurn()
    }

    const winner = winnerOf(this.host.squads)

    return {
      seed: this.setup.seed,
      winner,
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
      breaks: { ...this.breaks },
      burned: { ...this.burned },
      bled: { ...this.bled },
      doors: this.doorCount(),
      debriefed:
        winner === null
          ? []
          : debrief(this.host.squads, winner).map(({ unit, growth }) => ({ deeds: copyDeeds(unit.deeds), growth })),
      ground: {
        [Faction.Blue]: this.ground.of(Faction.Blue),
        [Faction.Red]: this.ground.of(Faction.Red),
      },
    }
  }

  /**
   * Blows are tallied under the sidearm's name beside the guns, so the report
   * says what each family actually did rather than folding a knife into the
   * rifle its carrier happened to hold.
   */
  private tallyAttack({ unit, shot, result, damage, range, indoors }: Attack): void {
    const weapon = shot.mode === 'melee' ? unit.sidearm : unit.weapon.id
    const tally = this.tally.get(weapon) ?? emptyTally()
    tally.shots += 1
    if (shot.mode !== 'melee') tally.rounds += unit.weapon.bulletConsumption(shot.mode)
    if (result?.hit) tally.hits += 1
    tally.damage += damage
    tally.distance += range
    if (indoors) {
      tally.indoorShots += 1
      tally.indoorDamage += damage
    }
    tally.crits += result?.crits ?? 0
    if (shot.target.isDead) tally.kills += 1
    this.tally.set(weapon, tally)
  }

  private doorCount(): { hung: number; opened: number } {
    let hung = 0
    let opened = 0
    this.grid.forEachWall((_x, _y, _side, kind) => {
      if (!isDoor(kind)) return
      hung++
      if (kind === WallKind.DoorOpen) opened++
    })
    return { hung, opened }
  }

  private living(faction: Faction): boolean {
    return this.host.squads.byFaction[faction].some((unit) => !unit.isDead)
  }

  private traitsOf(faction: Faction): string[] {
    const seen = new Set<string>()
    for (const unit of this.host.squads.byFaction[faction]) {
      for (const id of unit.sheet.traits) seen.add(id)
      if (unit.items.nullweave > 0) seen.add('nullweave')
    }
    return [...seen].sort()
  }
}

/** Play one match. */
export function simulate(setup: MatchSetup): MatchOutcome {
  return new SimMatch(setup).run()
}
