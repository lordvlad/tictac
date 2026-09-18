import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { WeaponId } from '../src/core/Arsenal'
import { AmmoId } from '../src/core/Arsenal'
import type { CombatRecording } from '../src/game/Recording'
import { SimMatch, type MatchOutcome, type SquadPlan } from '../src/sim/SimMatch'
import { replay, replayIsReproducible } from '../src/sim/Replay'

const STOCK: SquadPlan = {
  weapons: [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun],
  ammo: AmmoId.Standard,
  grenades: { frag: 1, flash: 0, smoke: 0 },
  items: {},
  attachments: [],
}

/** Play a match with the AI and keep the command stream it produced. */
function recorded(seed: number): { outcome: MatchOutcome; recording: CombatRecording } {
  const match = new SimMatch({ seed, blue: STOCK, red: STOCK, turnCap: 40, record: true })
  const outcome = match.run()
  const recording = match.recording
  expect(recording).not.toBeNull()
  return { outcome, recording: recording! }
}

describe('Running a recorded match with nobody watching', () => {
  test('every command in a real match is one this build can apply', () => {
    // A skipped command is a finding, not a no-op: it means the file holds an
    // intent this build no longer understands.
    const { recording } = recorded(4242)
    const result = replay(recording)

    expect(result.events).toBeGreaterThan(20)
    expect(result.applied).toBe(result.events)
    expect(result.skipped).toEqual([])
  })

  test('nothing in the file disagrees with what this build resolves', () => {
    // This is the end-to-end exercise of `ITEM-020`. Every shot in the file
    // arrives exactly as a peer's shot arrives — resolved numbers, the dice
    // that produced them, the chance they were rolled against — and the shadow
    // re-derives all of it against the state at the time.
    for (const seed of [4242, 77, 1000]) {
      const { recording } = recorded(seed)
      const result = replay(recording)

      expect(result.divergences).toEqual([])
    }
  })

  test('the same file twice reaches the same world', () => {
    // The property a stored match must have before a roster can be derived
    // from one. It is also what rejoin will stand on.
    const { recording } = recorded(4242)

    expect(replayIsReproducible(recording).reproducible).toBe(true)
  })

  test('the replay agrees with the match it is replaying about who lived', () => {
    // Two different carriers of the same rules: the sweep fought this match
    // with `SimUnit`s, the replay refights it with ECS soldiers and components.
    // Agreement on the survivors is the cross-check neither side can fake.
    const { outcome, recording } = recorded(4242)
    const result = replay(recording)

    const living = (faction: Faction) =>
      result.units.filter((unit) => unit.faction === faction && !unit.dead).length

    expect(living(Faction.Blue)).toBe(outcome.survivors[Faction.Blue])
    expect(living(Faction.Red)).toBe(outcome.survivors[Faction.Red])
  })

  test('a tampered number is caught', () => {
    // Proof the check is not vacuous. One hit in the file is inflated by a
    // point — the smallest lie available — and the replay must say so, name the
    // unit, and still be able to finish the match.
    const { recording } = recorded(4242)
    const shot = recording.events.find(
      (event) => event.command.type === 'fireShot' && event.command.hits.length > 0,
    )
    expect(shot).toBeDefined()

    const target = shot!
    const command = target.command as Extract<typeof target.command, { type: 'fireShot' }>
    const tampered: CombatRecording = {
      header: recording.header,
      events: recording.events.map((event) =>
        event === target
          ? {
              ...event,
              command: {
                ...command,
                hits: command.hits.map((hit, at) =>
                  at === 0 ? { ...hit, damage: hit.damage + 1 } : hit,
                ),
              },
            }
          : event,
      ),
    }

    const result = replay(tampered)

    expect(result.divergences).toHaveLength(1)
    expect(result.divergences[0]!.found.map((d) => d.what)).toContain('damage')
    expect(result.divergences[0]!.found[0]!.unit).toBeDefined()
    // And it kept going: a disagreement is reported, not thrown.
    expect(result.applied).toBe(result.events)
  })

  test('a claimed hit chance that the state does not support is caught', () => {
    // The check that covers a miss, which carries no damage to disagree about.
    const { recording } = recorded(4242)
    const shot = recording.events.find((event) => event.command.type === 'fireShot')
    expect(shot).toBeDefined()

    const tampered: CombatRecording = {
      header: recording.header,
      events: recording.events.map((event) =>
        event === shot
          ? { ...event, command: { ...event.command, chance: 99 } as typeof event.command }
          : event,
      ),
    }

    const found = replay(tampered).divergences.flatMap((d) => d.found.map((f) => f.what))

    expect(found).toContain('hitChance')
  })
})
