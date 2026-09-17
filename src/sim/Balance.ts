import { Faction } from '../config'
import { WeaponId } from '../core/Arsenal'
import type { CombatRecording } from '../game/Recording'
import { type MatchOutcome, SimMatch, type SquadPlan, type WeaponTally } from './SimMatch'

/** The stock spread, which is what the loadout screen opens on. */
export const STOCK_PLAN: SquadPlan = {
  weapons: [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun],
}

export interface SweepOptions {
  /**
   * First seed. Seeds run consecutively from here, so a sweep is reproducible.
   *
   * Consecutively is the trap: two sweeps whose seeds differ by less than
   * `matches` share almost every match, so they agree with each other no
   * matter what the code does. Comparing a change against itself that way
   * reads as rock-solid stability and measures nothing. To estimate how much a
   * report moves on its own, run blocks at least `matches` apart.
   */
  seed: number
  matches: number
  turnCap?: number
  blue?: SquadPlan
  red?: SquadPlan
  /** Keep a replayable command stream per match, for {@link SweepOptions.onMatch}. */
  record?: boolean
  /**
   * Called once per match, in seed order.
   *
   * The hook rather than a directory, because writing files is the tool's job:
   * the sweep stays a pure function so a test can run it without touching a
   * disk or a terminal.
   */
  onMatch?: (outcome: MatchOutcome, recording: CombatRecording | null) => void
}

export interface WeaponReport extends WeaponTally {
  weapon: string
  /** Of the shots taken, the share that put at least one round on a body. */
  hitRate: number
  damagePerShot: number
  /** Crits per round that landed, not per shot: a burst gets several chances. */
  critRate: number
}

/**
 * How a trait did, counted only where it was decisive.
 *
 * Matches where both squads carried it say nothing about it, so they are
 * excluded rather than averaged in — otherwise a common trait's win rate drifts
 * towards 50% no matter what it does.
 */
export interface TraitReport {
  trait: string
  /** Matches where exactly one side had it and somebody won. */
  decided: number
  wins: number
  winRate: number
}

export interface SweepReport {
  seed: number
  matches: number
  turnCap: number
  wins: Record<'blue' | 'red' | 'draw', number>
  /** Share of matches that ended by the cap rather than by a wipe. */
  drawRate: number
  turns: { mean: number; median: number; min: number; max: number }
  /** Mean survivors of the winning side: how decisive a win tends to be. */
  meanWinnerSurvivors: number
  weapons: WeaponReport[]
  traits: TraitReport[]
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function round(value: number, places = 2): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

/**
 * Play `matches` matches and add up what happened.
 *
 * Consecutive seeds from `seed`, so the same options always produce the same
 * report — a balance number that moved has to mean the rules moved, not that
 * the dice did.
 */
export function sweep(options: SweepOptions): SweepReport {
  const { seed, matches } = options
  const turnCap = options.turnCap ?? 40
  const outcomes: MatchOutcome[] = []

  for (let i = 0; i < matches; i++) {
    // Built out rather than through `simulate`, because a sweep that is
    // recording needs the match itself to read the stream back off.
    const match = new SimMatch({
      seed: seed + i,
      blue: options.blue ?? STOCK_PLAN,
      red: options.red ?? STOCK_PLAN,
      turnCap,
      record: options.record,
    })
    const outcome = match.run()
    outcomes.push(outcome)
    options.onMatch?.(outcome, match.recording)
  }

  const wins = { blue: 0, red: 0, draw: 0 }
  const turns: number[] = []
  const weapons = new Map<string, WeaponTally>()
  const traitDecided = new Map<string, { decided: number; wins: number }>()
  let winnerSurvivors = 0

  for (const outcome of outcomes) {
    turns.push(outcome.turns)
    if (outcome.winner === null) wins.draw += 1
    else if (outcome.winner === Faction.Blue) wins.blue += 1
    else wins.red += 1
    if (outcome.winner !== null) winnerSurvivors += outcome.survivors[outcome.winner]

    for (const [weapon, tally] of Object.entries(outcome.byWeapon)) {
      const total = weapons.get(weapon) ?? {
        shots: 0,
        hits: 0,
        damage: 0,
        kills: 0,
        crits: 0,
        rounds: 0,
      }
      total.shots += tally.shots
      total.hits += tally.hits
      total.damage += tally.damage
      total.kills += tally.kills
      total.crits += tally.crits
      total.rounds += tally.rounds
      weapons.set(weapon, total)
    }

    if (outcome.winner === null) continue
    const blue = new Set(outcome.traits[Faction.Blue])
    const red = new Set(outcome.traits[Faction.Red])
    for (const trait of new Set([...blue, ...red])) {
      const onBlue = blue.has(trait)
      const onRed = red.has(trait)
      if (onBlue === onRed) continue
      const entry = traitDecided.get(trait) ?? { decided: 0, wins: 0 }
      entry.decided += 1
      const carrier = onBlue ? Faction.Blue : Faction.Red
      if (outcome.winner === carrier) entry.wins += 1
      traitDecided.set(trait, entry)
    }
  }

  const decided = wins.blue + wins.red

  return {
    seed,
    matches,
    turnCap,
    wins,
    drawRate: round(wins.draw / matches, 3),
    turns: {
      mean: round(turns.reduce((sum, value) => sum + value, 0) / matches),
      median: median(turns),
      min: Math.min(...turns),
      max: Math.max(...turns),
    },
    meanWinnerSurvivors: decided === 0 ? 0 : round(winnerSurvivors / decided),
    weapons: [...weapons.entries()]
      .map(([weapon, tally]) => ({
        weapon,
        ...tally,
        hitRate: tally.shots === 0 ? 0 : round(tally.hits / tally.shots, 3),
        damagePerShot: tally.shots === 0 ? 0 : round(tally.damage / tally.shots, 1),
        critRate: tally.hits === 0 ? 0 : round(tally.crits / tally.hits, 3),
      }))
      .sort((a, b) => b.kills - a.kills),
    traits: [...traitDecided.entries()]
      .map(([trait, entry]) => ({
        trait,
        decided: entry.decided,
        wins: entry.wins,
        winRate: round(entry.wins / entry.decided, 3),
      }))
      .sort((a, b) => b.winRate - a.winRate),
  }
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width)
}

/** The report as a person reads it. */
export function formatReport(report: SweepReport): string {
  const lines: string[] = []
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

  lines.push(
    `${report.matches} matches, seeds ${report.seed}..${report.seed + report.matches - 1}, turn cap ${report.turnCap}`,
  )
  lines.push(
    `blue ${report.wins.blue}  red ${report.wins.red}  draw ${report.wins.draw} (${pct(report.drawRate)} hit the cap)`,
  )
  lines.push(
    `turns  mean ${report.turns.mean}  median ${report.turns.median}  range ${report.turns.min}-${report.turns.max}`,
  )
  lines.push(`winner keeps ${report.meanWinnerSurvivors} of 4 on average`)
  lines.push('')
  lines.push('weapon      shots   hit%   dmg/shot   kills   crit%   rounds')
  for (const weapon of report.weapons) {
    lines.push(
      [
        weapon.weapon.padEnd(10),
        pad(weapon.shots, 6),
        pad(pct(weapon.hitRate), 7),
        pad(weapon.damagePerShot, 11),
        pad(weapon.kills, 8),
        pad(pct(weapon.critRate), 8),
        pad(weapon.rounds, 9),
      ].join(''),
    )
  }

  if (report.traits.length > 0) {
    lines.push('')
    lines.push('trait         decided   wins   win%')
    for (const trait of report.traits) {
      lines.push(
        [
          trait.trait.padEnd(12),
          pad(trait.decided, 10),
          pad(trait.wins, 7),
          pad(pct(trait.winRate), 7),
        ].join(''),
      )
    }
  }

  return lines.join('\n')
}
