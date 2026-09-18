/**
 * Run a recorded match with nobody watching, and report what disagreed.
 *
 * Usage:
 *   bun scripts/replay.ts recordings/seed-4242.json
 *   bun scripts/replay.ts recordings/seed-4242.json --json
 *   bun scripts/replay.ts recordings/seed-4242.json --twice
 *
 * A recording is an intent stream, and so is the wire — the same frames,
 * verbatim. Running one through the real systems is therefore how the receiving
 * side gets exercised without two browsers and a signalling broker: every shot
 * in the file arrives here exactly as a peer's does, and the outcome is
 * whatever this build resolves from the match's seeded dice.
 *
 * Exits non-zero when an intent is refused or two runs of one file disagree,
 * so it can be a check rather than a thing to read.
 */
import { parseRecording } from '../src/game/Recording'
import { replay, replayIsReproducible } from '../src/sim/Replay'

const path = process.argv[2]
if (path === undefined) {
  console.error('usage: bun scripts/replay.ts <recording.json> [--json] [--twice]')
  process.exit(2)
}

const file = Bun.file(path)
if (!(await file.exists())) {
  console.error(`[replay] no such recording: ${path}`)
  process.exit(2)
}

const recording = parseRecording(await file.json())
const asJson = process.argv.includes('--json')
const outcome = replay(recording, { verbose: !asJson })

if (asJson) {
  console.log(JSON.stringify(outcome, null, 2))
} else {
  const { header } = recording
  console.log(`[replay] ${path}`)
  console.log(
    `  seed ${header.seed} (${header.seedLabel}), ${header.source}, recorded ${header.createdAt}`,
  )
  console.log(`  ${outcome.applied}/${outcome.events} events applied, ${outcome.turns} turns`)

  for (const { seq, type, reason } of outcome.skipped) {
    console.log(`  skipped #${seq} ${type}: ${reason}`)
  }

  const living = outcome.units.filter((unit) => !unit.dead)
  console.log(`  ${living.length}/${outcome.units.length} still standing`)
  for (const unit of outcome.units) {
    const where = `(${unit.tile.x},${unit.tile.y})`
    const state = unit.dead ? 'dead' : `${unit.hp}/${unit.maxHp} hp, ${unit.ap} ap`
    console.log(`    ${unit.name.padEnd(10)} ${state.padEnd(22)} ${where}`)
  }
  console.log(`  digest ${outcome.digest.total}`)

  console.log(
    outcome.skipped.length === 0
      ? '  every intent in the file is one this build could carry out'
      : `  ${outcome.skipped.length} intent(s) this build refused — see above`,
  )
}

if (process.argv.includes('--twice')) {
  const { reproducible, differences } = replayIsReproducible(recording)
  if (!asJson) {
    console.log(
      reproducible
        ? '  reproducible: two runs of the same file reach the same world'
        : `  NOT reproducible: ${differences.length} difference(s) between two runs of one file`,
    )
  }
  if (!reproducible) process.exit(1)
}

if (outcome.skipped.length > 0) process.exit(1)
