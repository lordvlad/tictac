import { describe, expect, test } from 'bun:test'
import type { EncounterEntry, EncounterResult, EncounterStarted, PassedFor } from '../src/game/Encounter'
import type { JsonRpcFrame } from '../src/game/JsonRpc'
import type { LobbyView } from '../src/game/Lobby'
import { heldTokens, ServerConnection } from '../src/game/ServerConnection'
import { Faction } from '../src/config'
import {
  ago,
  autoResumes,
  feedLine,
  formatCountdown,
  placeLabel,
  promptFor,
  unseenCount,
} from '../src/hud/EncounterView'
import { handClock, handServer } from './support/handServer'

/**
 * What a window says and does about a fight on the road (`ITEM-048`): the
 * join prompt's question and its countdown, the server panel's rule about
 * which seat it takes over, the return feed's wording, and the push that
 * starts it all. The prompt, the feed and the map are DOM and WebGL and
 * have no component tests here, like the rest of `src/hud/`; everything
 * they decide is in `EncounterView.ts` and is tested directly.
 */

type You = NonNullable<LobbyView['you']>
const you = (overrides: Partial<You>): You => ({
  roomId: 'r1',
  faction: Faction.Blue,
  phase: 'playing',
  control: 'player',
  joinBy: null,
  ...overrides,
})
const STARTED: EncounterStarted = { roomId: 'r1', joinBy: 100_000, at: 40_000, place: { lat: 1, lng: 2 } }

describe('the countdown', () => {
  test('reads as a clock, rounds up so 0:00 means over, and never goes negative', () => {
    expect(formatCountdown(60_000)).toBe('1:00')
    expect(formatCountdown(42_001)).toBe('0:43')
    expect(formatCountdown(9_000)).toBe('0:09')
    expect(formatCountdown(1)).toBe('0:01')
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-5_000)).toBe('0:00')
  })
})

describe('the join prompt', () => {
  test('a push alone asks, until its time is up', () => {
    expect(promptFor({ pushed: STARTED, you: undefined, now: 50_000 })).toEqual({
      kind: 'offer',
      roomId: 'r1',
      joinBy: 100_000,
    })
    expect(promptFor({ pushed: STARTED, you: null, now: 99_999 })?.kind).toBe('offer')
    expect(promptFor({ pushed: STARTED, you: null, now: 100_000 })).toBeNull()
  })

  test('a window that connected after the push is asked by its reserved seat', () => {
    const reserved = you({ control: 'reserved', joinBy: 100_000 })
    expect(promptFor({ pushed: null, you: reserved, now: 70_000 })).toEqual({
      kind: 'offer',
      roomId: 'r1',
      joinBy: 100_000,
    })
  })

  test('once the time is up the AI is fighting, whether or not the server has said so yet', () => {
    const reserved = you({ control: 'reserved', joinBy: 100_000 })
    expect(promptFor({ pushed: STARTED, you: reserved, now: 100_000 })).toEqual({ kind: 'ai', roomId: 'r1' })
    expect(promptFor({ pushed: STARTED, you: you({ control: 'ai' }), now: 130_000 })).toEqual({
      kind: 'ai',
      roomId: 'r1',
    })
  })

  test('the lobby outranks the push: a seat taken is not asked about, and an AI seat nobody pushed is not announced', () => {
    expect(promptFor({ pushed: STARTED, you: you({ control: 'player' }), now: 50_000 })).toBeNull()
    expect(promptFor({ pushed: null, you: you({ control: 'ai' }), now: 50_000 })).toBeNull()
    expect(promptFor({ pushed: { ...STARTED, roomId: 'other' }, you: you({ control: 'ai' }), now: 50_000 })).toBeNull()
  })

  test('nothing is asked when there is nothing', () => {
    expect(promptFor({ pushed: null, you: null, now: 0 })).toBeNull()
    expect(promptFor({ pushed: null, you: undefined, now: 0 })).toBeNull()
  })
})

describe('which seat the server panel takes over by itself', () => {
  test.each([
    ['player', 'playing', true],
    ['reserved', 'playing', false],
    ['ai', 'playing', false],
    ['player', 'waiting', false],
    ['player', 'deploying', false],
  ] as const)('%s control in a %s room: %p', (control, phase, expected) => {
    expect(autoResumes(you({ control, phase, joinBy: control === 'reserved' ? 1 : null }))).toBe(expected)
  })

  test('no seat, nothing to take', () => {
    expect(autoResumes(null)).toBe(false)
  })
})

describe('the return feed', () => {
  const NOW = 10_000_000
  const base: EncounterEntry = {
    id: 'e1',
    at: NOW - 5 * 60_000,
    place: { lat: 52.5234, lng: -13.4069 },
    result: 'won',
    passedFor: null,
    playedBy: 'you',
    matchId: 'm1',
    aliens: 3,
  }

  test('says when, where, how many, who played, and how it ended', () => {
    expect(feedLine(base, NOW)).toEqual({
      when: '5 min ago',
      where: '52.52° N, 13.41° W',
      result: 'Won',
      tone: 'won',
      played: 'You played',
      aliens: '3 aliens',
      matchId: 'm1',
    })
  })

  test.each([
    ['won', 'Won', 'won'],
    ['lost', 'Lost', 'lost'],
    ['inProgress', 'In progress', 'plain'],
  ] as const)('a fight %s', (result, text, tone) => {
    const line = feedLine({ ...base, result }, NOW)
    expect(line.result).toBe(text)
    expect(line.tone).toBe(tone)
    expect(line.matchId).toBe('m1')
  })

  test.each([
    ['nobodyFit', 'Passed by: nobody fit'],
    ['busy', 'Passed by: you were busy'],
  ] as const satisfies readonly (readonly [PassedFor, string])[])('an encounter passed by for %s', (passedFor, text) => {
    const line = feedLine({ ...base, result: 'passedBy', passedFor, playedBy: null, matchId: null }, NOW)
    expect(line.result).toBe(text)
    expect(line.played).toBeNull()
    expect(line.matchId).toBeNull()
  })

  test('a pass without a reason still says it was passed by', () => {
    expect(feedLine({ ...base, result: 'passedBy', passedFor: null, playedBy: null, matchId: null }, NOW).result).toBe(
      'Passed by',
    )
  })

  test.each([
    ['won', 'you', 'You played'],
    ['lost', 'you', 'You played'],
    ['won', 'ai', 'The AI played for you'],
    ['lost', 'ai', 'The AI played for you'],
    ['inProgress', 'you', 'You are playing'],
    ['inProgress', 'ai', 'The AI is playing for you'],
  ] as const satisfies readonly (readonly [EncounterResult, 'you' | 'ai', string])[])(
    'a %s fight played by %s reads "%s"',
    (result, playedBy, text) => {
      expect(feedLine({ ...base, result, playedBy }, NOW).played).toBe(text)
    },
  )

  test('one alien is not "1 aliens"', () => {
    expect(feedLine({ ...base, aliens: 1 }, NOW).aliens).toBe('1 alien')
  })

  test('relative times use the largest whole unit, and a clock slightly ahead is "just now"', () => {
    expect(ago(NOW - 30_000, NOW)).toBe('just now')
    expect(ago(NOW + 5_000, NOW)).toBe('just now')
    expect(ago(NOW - 59 * 60_000, NOW)).toBe('59 min ago')
    expect(ago(NOW - 3 * 3_600_000 - 10 * 60_000, NOW)).toBe('3 h ago')
    expect(ago(NOW - 2 * 86_400_000, NOW)).toBe('2 d ago')
  })

  test('places are rounded and say which side of the equator and the meridian', () => {
    expect(placeLabel({ lat: -33.8688, lng: 151.2093 })).toBe('33.87° S, 151.21° E')
    expect(placeLabel({ lat: 0, lng: 0 })).toBe('0.00° N, 0.00° E')
  })

  test('what is newer than the last look is new', () => {
    const entries = [base, { ...base, id: 'e0', at: base.at - 1000 }]
    expect(unseenCount(entries, base.at - 500)).toBe(1)
    expect(unseenCount(entries, base.at)).toBe(0)
    expect(unseenCount(entries, 0)).toBe(2)
  })
})

describe('the encounter push', () => {
  test('reaches whoever watches, until they stop', async () => {
    const clock = handClock()
    const server = handServer(clock)
    server.answer = (socket, request) => socket.reply(request.id as number, null)
    const connection = new ServerConnection('ws://tictac.test/', {
      connect: server.connect,
      schedule: clock.schedule,
      tokens: heldTokens(),
    })
    const heard: EncounterStarted[] = []
    const stop = connection.watchEncounters((started) => heard.push(started))
    await clock.advance(0)

    const push = (): JsonRpcFrame => ({
      jsonrpc: '2.0',
      method: 'tictac/api/encounter/started',
      params: STARTED as unknown as Record<string, unknown>,
    })
    server.last.send(push())
    expect(heard).toEqual([STARTED])

    stop()
    server.last.send(push())
    expect(heard).toHaveLength(1)
  })
})
