/**
 * Balance sweep: play N matches with nobody watching and report what the guns
 * did.
 *
 * Usage:
 *   bun run balance
 *   bun run balance -- --matches=200 --seed=1 --turnCap=60
 *   bun run balance -- --blue=shotgun --red=sniper
 *   bun run balance -- --redAmmo=ap --blueItems=plate:1 --blueMods=scope,bipod
 *   bun run balance -- --blueWatch=off
 *   bun run balance -- --blueSidearm=knife --redSidearm=club
 *   bun run balance -- --mapSize=72 --spawns=edge
 *   bun run balance -- --record=recordings
 *   bun run balance -- --json
 *
 * A mirror match measures the guns; an asymmetric one measures the difference
 * between two loadouts, which is the question worth asking before changing a
 * number. Both sides default to the stock spread.
 *
 * Deliberately the only file in the tool that knows about a terminal. The sweep
 * itself is in `src/sim/Balance.ts`, so a test can run it without parsing
 * arguments or reading stdout.
 */
import { mkdir } from 'node:fs/promises'
import { AmmoId, WeaponId } from '../src/core/Arsenal'
import { AttachmentId } from '../src/core/Attachments'
import { ItemId } from '../src/core/Items'
import { MeleeId } from '../src/core/Melee'
import { formatReport, sweep } from '../src/sim/Balance'
import type { CombatRecording } from '../src/game/Recording'
import type { MapOptions } from '../src/core/MapGenerator'
import type { SquadPlan } from '../src/sim/SimMatch'

function arg(name: string): string | undefined {
  const raw = process.argv.find((value) => value.startsWith(`--${name}=`))
  return raw?.slice(name.length + 3)
}

function numberArg(name: string, fallback: number): number {
  const raw = arg(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`--${name} needs a number, got "${raw}"`)
  return value
}

/** A named value from a table, refused rather than defaulted when misspelt. */
function pick<T extends string>(table: Record<string, T>, name: string, raw: string): T {
  const value = Object.values(table).find((entry) => entry === raw)
  if (!value) throw new Error(`--${name}: "${raw}" is not one of ${Object.values(table).join(', ')}`)
  return value
}

/** `scope:1,plate:2` — a pouch, spelled out. */
function itemsFor(side: 'blue' | 'red', raw: string): Partial<Record<ItemId, number>> {
  const items: Partial<Record<ItemId, number>> = {}
  for (const entry of raw.split(',')) {
    const [name, count] = entry.split(':')
    const id = pick(ItemId, `${side}Items`, (name ?? '').trim())
    const many = count === undefined ? 1 : Number(count)
    if (!Number.isFinite(many)) throw new Error(`--${side}Items: "${entry}" needs a count`)
    items[id] = many
  }
  return items
}

function planFor(side: 'blue' | 'red'): SquadPlan | undefined {
  const weapons = arg(side)
  const ammo = arg(`${side}Ammo`)
  const items = arg(`${side}Items`)
  const mods = arg(`${side}Mods`)
  const watch = arg(`${side}Watch`)
  const sidearm = arg(`${side}Sidearm`)
  if (
    sidearm === undefined &&
    weapons === undefined &&
    ammo === undefined &&
    items === undefined &&
    mods === undefined &&
    watch === undefined
  ) {
    return undefined
  }
  if (watch !== undefined && watch !== 'on' && watch !== 'off') {
    throw new Error(`--${side}Watch: "${watch}" is not one of on, off`)
  }

  return {
    weapons: (weapons ?? 'rifle,gatling,sniper,shotgun')
      .split(',')
      .map((entry) => pick(WeaponId, side, entry.trim())),
    ammo: ammo === undefined ? AmmoId.Standard : pick(AmmoId, `${side}Ammo`, ammo),
    items: items === undefined ? undefined : itemsFor(side, items),
    // A list, not a pouch: a rail either has one of a thing or it does not.
    attachments:
      mods === undefined
        ? undefined
        : mods.split(',').map((entry) => pick(AttachmentId, `${side}Mods`, entry.trim())),
    // Policy rather than kit: prices the ability by taking it away.
    watch: watch !== 'off',
    sidearm: sidearm === undefined ? undefined : pick(MeleeId, `${side}Sidearm`, sidearm),
  }
}

/** Another battlefield, for asking what the map does to the fight. */
function mapOptions(): MapOptions | undefined {
  const size = arg('mapSize')
  const spawns = arg('spawns')
  if (size === undefined && spawns === undefined) return undefined
  if (spawns !== undefined && spawns !== 'centre' && spawns !== 'edge') {
    throw new Error(`--spawns: "${spawns}" is not one of centre, edge`)
  }
  return {
    ...(size === undefined ? {} : { size: numberArg('mapSize', 0) }),
    ...(spawns === undefined ? {} : { spawns }),
  }
}

const recordDir = arg('record')
const recorded: { seed: number; recording: CombatRecording }[] = []

const report = sweep({
  seed: numberArg('seed', 1),
  matches: numberArg('matches', 100),
  turnCap: numberArg('turnCap', 40),
  map: mapOptions(),
  blue: planFor('blue'),
  red: planFor('red'),
  record: recordDir !== undefined,
  onMatch: (outcome, recording) => {
    if (recording) recorded.push({ seed: outcome.seed, recording })
  },
})

console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report))

// Written after the sweep rather than during it: the sweep is synchronous by
// design, and file I/O in this codebase is asynchronous by rule.
if (recordDir !== undefined) {
  await mkdir(recordDir, { recursive: true })
  for (const { seed, recording } of recorded) {
    await Bun.write(`${recordDir}/seed-${seed}.json`, JSON.stringify(recording))
  }
  console.log(`[balance] wrote ${recorded.length} recordings to ${recordDir}`)
}
