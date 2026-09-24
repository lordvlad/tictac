import { describe, expect, test } from 'bun:test'
import type { CombatRecording } from '../src/game/Recording'
import type { StateDigest } from '../src/game/StateDigest'
import type { Moment } from '../src/game/Rewind'
import { STOCK_PLAN } from '../src/sim/Balance'
import { MatchHost } from '../src/sim/MatchHost'
import { replay } from '../src/sim/Replay'
import { SimMatch } from '../src/sim/SimMatch'

/**
 * A recorded match in which a window got broken: found rather than named,
 * because which seed that is moves whenever the policy does.
 */
function matchThatBreaksGlass(): CombatRecording {
  for (let seed = 1; seed <= 60; seed++) {
    const match = new SimMatch({ seed, blue: STOCK_PLAN, red: STOCK_PLAN, turnCap: 40, record: true })
    match.run()
    const recording = match.recording!
    if (replay(recording).digest.terrain !== new MatchHost(recording.header).digest().terrain) return recording
  }
  throw new Error('no match in 60 broke a window')
}

describe('Stepping a replay back', () => {
  test('going back puts the match back, and playing on again reaches the match the file records', () => {
    const recording = matchThatBreaksGlass()
    const { events } = recording
    const straight = replay(recording).digest

    // Played through once, keeping the moment before every event, the way
    // playback does as it goes — and its fingerprint, to check a rewind by.
    const host = new MatchHost(recording.header)
    const moments: Moment[] = []
    const digests: StateDigest[] = []
    for (const { command } of events) {
      moments.push(host.moment())
      digests.push(host.digest())
      host.apply(command)
    }
    expect(host.digest().total).toBe(straight.total)

    // Back to the middle, and to the very start. The match there is the match
    // that was there — windows unbroken included — and playing on has to roll
    // the same dice as the first time.
    for (const from of [events.length >> 1, 0]) {
      host.rewind(moments[from]!)
      expect({ from, digest: host.digest() }).toEqual({ from, digest: digests[from]! })
      for (const { command } of events.slice(from)) host.apply(command)
      expect({ from, digest: host.digest() }).toEqual({ from, digest: straight })
    }
  })
})
