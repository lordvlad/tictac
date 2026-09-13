/**
 * Balance sweep: play N matches with nobody watching and report what the guns
 * did.
 *
 * Usage:
 *   bun run balance
 *   bun run balance -- --matches=200 --seed=1 --turnCap=60
 *   bun run balance -- --blue=shotgun --red=sniper
 *   bun run balance -- --redAmmo=ap --blueVests=4
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
import { AmmoId, WeaponId } from '../src/core/Arsenal'
import { ItemId } from '../src/core/Items'
import { formatReport, sweep } from '../src/sim/Balance'
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

function planFor(side: 'blue' | 'red'): SquadPlan | undefined {
  const weapons = arg(side)
  const ammo = arg(`${side}Ammo`)
  const vests = arg(`${side}Vests`)
  if (weapons === undefined && ammo === undefined && vests === undefined) return undefined

  return {
    weapons: (weapons ?? 'rifle,gatling,sniper,shotgun')
      .split(',')
      .map((entry) => pick(WeaponId, side, entry.trim())),
    ammo: ammo === undefined ? AmmoId.Standard : pick(AmmoId, `${side}Ammo`, ammo),
    items: vests === undefined ? undefined : { [ItemId.NullweaveVest]: Number(vests) },
  }
}

const report = sweep({
  seed: numberArg('seed', 1),
  matches: numberArg('matches', 100),
  turnCap: numberArg('turnCap', 40),
  blue: planFor('blue'),
  red: planFor('red'),
})

console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report))
