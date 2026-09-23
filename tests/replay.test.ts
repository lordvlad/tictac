import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { ShotMode, WeaponId } from '../src/core/Arsenal'
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

  test('a recorded match replays into the same match, from its seed alone', () => {
    // The end-to-end exercise of intent-only. A file names who did what; the
    // outcome is whatever this build resolves from the match's dice — so a
    // replay that applies every command and refuses none is the whole wire
    // working: the same intents, the same stream, the same match.
    for (const seed of [4242, 77, 1000]) {
      const { recording } = recorded(seed)
      const result = replay(recording)

      expect(result.skipped).toEqual([])
      expect(result.applied).toBe(result.events)
    }
  })

  test('the same file twice reaches the same world', () => {
    // The property a stored match must have before a roster can be derived
    // from one. It is also what rejoin will stand on.
    const { recording } = recorded(4242)

    expect(replayIsReproducible(recording).reproducible).toBe(true)
  })

  test('the replay agrees with the match it is replaying about who lived', () => {
    // The sweep and a replay now run the same engine, so this is no longer two
    // implementations checking each other — it is the file checking itself.
    // Everything the policy did has to be in the recording, in order, or a
    // fresh host fed the file reaches a different end. A block of seeds rather
    // than one because the disagreements this has caught each showed up in a
    // handful of matches and in none of the others.
    for (const seed of [4242, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const { outcome, recording } = recorded(seed)
      const result = replay(recording)

      const living = (faction: Faction) =>
        result.units.filter((unit) => unit.faction === faction && !unit.dead).length

      expect({ seed, skipped: result.skipped }).toEqual({ seed, skipped: [] })
      expect({ seed, blue: living(Faction.Blue), red: living(Faction.Red) }).toEqual({
        seed,
        blue: outcome.survivors[Faction.Blue],
        red: outcome.survivors[Faction.Red],
      })
    }
  })

  test('a reaction nobody sent is reproduced from the intents alone', () => {
    // The claim that lets overwatch cost no wire at all: a reaction is a
    // consequence of a movement intent, so replaying the intents produces the
    // same reactions — at the same points, from the same dice. Seed 7 is a
    // match in which the AI both set watches and had somebody walk into one.
    const { outcome, recording } = recorded(7)
    expect(outcome.watches).toBeGreaterThan(0)
    expect(outcome.reactions).toBeGreaterThan(0)
    expect(recording.events.some((event) => event.command.type === 'overwatch')).toBe(true)

    const first = replay(recording)
    const second = replay(recording)

    expect(first.skipped).toEqual([])
    expect(first.digest.total).toBe(second.digest.total)
    // And the refight reaches the same survivors as the match that produced
    // it — a reaction that fired on one side and not the other would show up
    // here as somebody still standing.
    const living = (faction: Faction) =>
      first.units.filter((unit) => unit.faction === faction && !unit.dead).length
    expect(living(Faction.Blue)).toBe(outcome.survivors[Faction.Blue])
    expect(living(Faction.Red)).toBe(outcome.survivors[Faction.Red])
  })

  test('a file holds intents and nothing to disagree with', () => {
    // What replaced the tampering tests. Under intent-only there is no number
    // in a file to falsify: an attack is a shooter, a target and a mode, and
    // the outcome is whatever this build resolves from the match's dice. The
    // check that used to catch a doctored hit is gone because the thing it
    // caught cannot be expressed any more.
    const { recording } = recorded(4242)
    const attacks = recording.events
      .map((event) => event.command)
      .filter((command) => command.type === 'fireShot' || command.type === 'throwGrenade')

    expect(attacks.length).toBeGreaterThan(0)
    for (const command of attacks) {
      expect(Object.keys(command).sort()).not.toContain('hits')
    }
  })

  test('a doctored *intent* changes the match rather than lying about it', () => {
    // The remaining way to tamper with a file: change what somebody did. That
    // is not a lie a check can catch — it is a different match, and it replays
    // as one. Worth pinning, because it is the honest limit of the format.
    const { recording } = recorded(4242)
    const shot = recording.events.find((event) => event.command.type === 'fireShot')
    expect(shot).toBeDefined()
    const target = shot!

    const swapped: CombatRecording = {
      header: recording.header,
      events: recording.events.map((event) =>
        event === target
          ? { ...event, command: { ...event.command, mode: ShotMode.Aimed } as typeof event.command }
          : event,
      ),
    }

    const original = replay(recording)
    const altered = replay(swapped)

    // Either outcome is acceptable and both are honest: an aimed shot costs
    // more than a snap one, so the doctored intent is either refused by the
    // rules or carried out and resolves differently. What must not happen is
    // the file being changed and the match coming out the same.
    const sameMatch =
      altered.skipped.length === 0 && altered.digest.total === original.digest.total
    expect(sameMatch).toBe(false)
  })
})
