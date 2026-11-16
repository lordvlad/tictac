import { describe, expect, test } from 'bun:test'
import { Playback } from '../src/game/Playback'
import type { CombatRecording } from '../src/game/Recording'
import type { StateDigest } from '../src/game/StateDigest'
import { STOCK_PLAN } from '../src/sim/Balance'
import { MatchHost } from '../src/sim/MatchHost'
import { replay } from '../src/sim/Replay'
import { SimMatch } from '../src/sim/SimMatch'
import { Faction } from '../src/config'
import { GrenadeId } from '../src/core/Arsenal'

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

/** A headless replay: the host applies each event to completion, and nothing is ever animating. */
function playbackOf(host: MatchHost, recording: CombatRecording): Playback {
  return new Playback({
    recording,
    apply: (command) => host.apply(command),
    busy: () => false,
    match: host.rewindable,
    afterRestore: () => {},
  })
}

describe('Stepping a replay back', () => {
  test('going back puts the match back, and playing on again reaches the match the file records', () => {
    const recording = matchThatBreaksGlass()
    const { events } = recording
    const straight = replay(recording).digest

    // Played through once, keeping the fingerprint before every event, to
    // check each step back by.
    const host = new MatchHost(recording.header)
    const playback = playbackOf(host, recording)
    const digests: StateDigest[] = []
    for (let i = 0; i < events.length; i++) {
      digests.push(host.digest())
      playback.stepForward()
    }
    expect(host.digest().total).toBe(straight.total)

    // Back to the middle, and to the very start. The match there is the match
    // that was there — windows unbroken included — and playing on has to roll
    // the same dice as the first time.
    for (const to of [events.length >> 1, 0]) {
      while (playback.index > to) playback.stepBackward()
      expect({ to, digest: host.digest() }).toEqual({ to, digest: digests[to]! })
      while (!playback.finished) playback.stepForward()
      expect({ to, digest: host.digest() }).toEqual({ to, digest: straight })
    }
  })

  test('going back past a fire puts the ground back: nothing burning, nothing burned', () => {
    const { header } = new SimMatch({ seed: 5, blue: STOCK_PLAN, red: STOCK_PLAN, record: true }).recording!
    const host = new MatchHost(header)
    const thrower = host.squads.byFaction[Faction.Blue][0]!
    thrower.grenades[GrenadeId.Incendiary] = 1
    const untouched = host.digest()
    const recording: CombatRecording = {
      header,
      events: [
        {
          seq: 0,
          turn: 1,
          faction: Faction.Blue,
          command: {
            type: 'throwGrenade',
            shooterFaction: Faction.Blue,
            shooterIndex: 0,
            kind: GrenadeId.Incendiary,
            targetTile: { x: thrower.tile.x, y: thrower.tile.y + 3 },
            targetLevel: 0,
          },
        },
        { seq: 1, turn: 1, faction: Faction.Blue, command: { type: 'endTurn', faction: Faction.Blue } },
      ],
    }
    const playback = playbackOf(host, recording)

    playback.stepForward()
    playback.stepForward()
    expect(host.digest().terrain).not.toBe(untouched.terrain)

    playback.stepBackward()
    playback.stepBackward()
    expect(host.digest()).toEqual(untouched)
    expect(host.grid.fire.every((turns) => turns === 0)).toBe(true)
  })
})
