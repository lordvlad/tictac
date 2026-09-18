import type { Faction } from '../config'
import type { CombatRecording, RecordedEvent } from '../game/Recording'
import { compareDigests, type Divergence, type StateDigest } from '../game/StateDigest'
import { MatchHost, type MatchHostOptions, type UnitState } from './MatchHost'

/**
 * Replay a recorded match over the real ECS, with nothing watching.
 *
 * Why this exists rather than the rendered playback that already does it: a
 * replay is the one way to exercise the **receiving** side of the wire without
 * two browsers, a signalling broker and a second pair of hands. A recording is
 * an intent stream and so is the wire — the same frames, verbatim — so running
 * a file *is* receiving a match.
 *
 * Under intent-only there is nothing in a file to compare against: a shot is a
 * shooter, a target and a mode, and the outcome is whatever this build resolves
 * from the match's seeded dice. What a replay proves is therefore stronger and
 * simpler than a comparison — that the same intents over the same seed produce
 * the same world, every time. If they did not, a roster could not be derived
 * from a stored match and a client could not rejoin one.
 *
 * The applying itself lives in {@link MatchHost}, which the referee uses too: a
 * second copy of "what does this intent mean" would be a second chance to
 * resolve a match differently from the peers who played it.
 */

/** What happened when the file was run. */
export interface ReplayOutcome {
  seed: number
  /** Events in the file. */
  events: number
  /** Events this build knew how to carry out. */
  applied: number
  /** Events refused, and why — a refusal is a finding, not a no-op. */
  skipped: { seq: number; type: string; reason: string }[]
  /** The final fingerprint, so two runs can be compared in one number. */
  digest: StateDigest
  /** Where everybody ended up. */
  units: UnitState[]
  turns: number
}

export type ReplayOptions = MatchHostOptions

export function replay(recording: CombatRecording, options: ReplayOptions = {}): ReplayOutcome {
  const { header, events } = recording
  const host = new MatchHost(header, options)

  const skipped: ReplayOutcome['skipped'] = []
  let applied = 0

  for (const event of events) {
    const result = host.apply(event.command)
    if (result.applied) applied++
    else skipped.push({ seq: event.seq, type: event.command.type, reason: result.reason })
  }

  return {
    seed: header.seed,
    events: events.length,
    applied,
    skipped,
    digest: host.digest(),
    units: host.units(),
    turns: host.turnNumber,
  }
}

/**
 * Run the same file twice and compare.
 *
 * The property a stored match has to have before a roster can be derived from
 * one: the same intents over the same seed produce the same world. Reported
 * rather than asserted, so a caller can decide whether it is a test failure or
 * a line in a report.
 */
export function replayIsReproducible(recording: CombatRecording): {
  reproducible: boolean
  differences: Divergence[]
} {
  const first = replay(recording)
  const second = replay(recording)
  const differences = compareDigests(first.digest, second.digest, (entityId) => `#${entityId}`)
  return { reproducible: differences.length === 0, differences }
}

/** Living units by faction, as a replay leaves them. */
export function survivors(outcome: ReplayOutcome): Record<Faction, number> {
  const count = (faction: Faction) =>
    outcome.units.filter((unit) => unit.faction === faction && !unit.dead).length
  return { 0: count(0 as Faction), 1: count(1 as Faction) } as Record<Faction, number>
}

/** One event, for a caller that wants to narrate a replay. */
export type { RecordedEvent }
