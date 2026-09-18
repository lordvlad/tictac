import { describe, expect, test } from 'bun:test'
import { AmmoId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { Faction } from '../src/config'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../src/game/JsonRpc'
import type { NetworkMessage } from '../src/game/NetworkManager'
import type { CombatRecording } from '../src/game/Recording'
import { loopback, type Transport } from '../src/game/Transport'
import { MatchStore } from '../src/server/MatchStore'
import { Referee, type RefereeVerdict } from '../src/server/Referee'
import { MatchHost } from '../src/sim/MatchHost'
import { replay } from '../src/sim/Replay'
import { SimMatch, type SquadPlan } from '../src/sim/SimMatch'
import { MY_VERSION } from '../src/version'

const STOCK: SquadPlan = {
  weapons: [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun],
  ammo: AmmoId.Standard,
  grenades: { frag: 1, flash: 0, smoke: 0 },
  items: {},
  attachments: [],
}

/** A match somebody already played, to use as two clients' intents. */
function recorded(seed: number): CombatRecording {
  const match = new SimMatch({ seed, blue: STOCK, red: STOCK, turnCap: 40, record: true })
  match.run()
  const recording = match.recording
  expect(recording).not.toBeNull()
  return recording!
}

/** A client, as the referee sees one: it sends frames and collects replies. */
function client(referee: Referee) {
  const [mine, theirs] = loopback()
  referee.attach(theirs)
  const received: NetworkMessage[] = []
  mine.onFrame((frame) => {
    if (!('method' in frame)) return
    const params = (frame as JsonRpcNotification).params as Record<string, unknown>
    for (const [type, method] of Object.entries(RpcMethods)) {
      if (method === frame.method) received.push({ ...params, type } as NetworkMessage)
    }
  })
  const send = (message: NetworkMessage): void => {
    const params = { ...message } as Record<string, unknown>
    delete params.type
    mine.send({ jsonrpc: '2.0', method: RpcMethods[message.type], params } as JsonRpcFrame)
  }
  return { send, received, transport: mine as Transport }
}

function harness(seed = 4242) {
  const recording = recorded(seed)
  const store = new MatchStore()
  const verdicts: RefereeVerdict[] = []
  const referee = new Referee({ store, onVerdict: (v) => verdicts.push(v), log: () => {} })
  return { recording, store, referee, verdicts }
}

describe('A third recomputation of the same match', () => {
  test('a whole match is watched, recorded and refought', () => {
    // Both clients are clients: they resolve their own intents, and the referee
    // resolves the same stream. What it ends up holding is not a copy of what
    // they told it — it is its own answer to the same question.
    const { recording, store, referee } = harness()
    const blue = client(referee)
    blue.send({ type: 'matchHeader', header: recording.header })

    for (const event of recording.events) blue.send(event.command)

    const matchId = referee.openMatchId
    expect(matchId).not.toBeNull()
    expect(store.events(matchId!)).toHaveLength(recording.events.length)

    // And the referee's own world is the match: the same survivors the players'
    // own run reached, from intents alone.
    const independent = replay(recording)
    expect(referee.digest()!.total).toBe(independent.digest.total)
  })

  test('the log it keeps is a match somebody else can refight', () => {
    // The persistence half. What is stored is the intent stream, so the stored
    // match is re-derivable rather than a summary that could disagree with it.
    const { recording, store, referee } = harness()
    const blue = client(referee)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events) blue.send(event.command)

    const stored = store.match(referee.openMatchId!)
    expect(stored).not.toBeNull()

    const fromStore = replay(stored!)
    expect(fromStore.skipped).toEqual([])
    expect(fromStore.digest.total).toBe(referee.digest()!.total)
  })

  test('intents reach the other client, and never echo back to the sender', () => {
    // The referee relays as well as watches, which is what removes the
    // signalling broker from a refereed match. A frame coming back to its
    // sender would be applied twice.
    const { recording, referee } = harness()
    const blue = client(referee)
    const red = client(referee)
    blue.send({ type: 'matchHeader', header: recording.header })

    const first = recording.events[0]!.command
    blue.send(first)

    expect(red.received.map((m) => m.type)).toContain(first.type)
    expect(blue.received.map((m) => m.type)).not.toContain(first.type)
  })
})

describe('Attribution, which is the only thing a third party adds', () => {
  test('a client whose state disagrees with the referee ends the match', () => {
    // Two peers can notice a disagreement; neither can prove whose fault it is.
    // The referee is not asking whether the client agrees with its opponent —
    // it is asking whether it agrees with a recomputation neither player owns.
    const { recording, referee, verdicts } = harness()
    const blue = client(referee)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events.slice(0, 6)) blue.send(event.command)

    // A world that never happened: one unit's health moved on the client alone.
    const invented = new MatchHost(recording.header)
    const digest = invented.digest()
    const unitId = Object.keys(digest.units)[0]!
    digest.units[unitId]!.health = (digest.units[unitId]!.health ?? 0) + 1
    digest.total += 1

    blue.send({ type: 'digest', digest })

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toContain('disagrees with the referee')
    expect(verdicts[0]!.found.some((d) => d.what.startsWith('component'))).toBe(true)
    expect(blue.received.some((m) => m.type === 'abort')).toBe(true)
  })

  test('an honest digest is silent', () => {
    const { recording, referee, verdicts } = harness()
    const blue = client(referee)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events.slice(0, 6)) blue.send(event.command)

    blue.send({ type: 'digest', digest: referee.digest()! })

    expect(verdicts).toEqual([])
  })

  test('an intent the referee cannot carry out ends the match too', () => {
    // A disagreement about what was *possible* is larger than a disagreement
    // about a number, so it is a verdict rather than a logged shrug.
    const { recording, referee, verdicts } = harness()
    const blue = client(referee)
    blue.send({ type: 'matchHeader', header: recording.header })

    blue.send({
      type: 'fireShot',
      shooterFaction: Faction.Blue,
      shooterIndex: 0,
      targetFaction: Faction.Red,
      targetIndex: 0,
      mode: ShotMode.Aimed,
    })
    // Nobody is in range at the opening position, so the rules refuse it.
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toContain('could not carry out')
  })

  test('a client on another build is refused rather than accused', () => {
    // The precondition for ever naming a side: this project deploys on every
    // push, so two builds diverge innocently and the first player a referee
    // accused would be somebody with a stale cache.
    const { referee, verdicts } = harness()
    const stale = client(referee)

    stale.send({ type: 'hello', protocol: MY_VERSION.protocol, build: 'c0ffee1' })

    const abort = stale.received.find((m) => m.type === 'abort')
    expect(abort).toBeDefined()
    expect(abort && 'reason' in abort ? abort.reason : '').toContain('c0ffee1')
    // Refused, not judged: no verdict is recorded against a build mismatch.
    expect(verdicts).toEqual([])
  })
})

describe('Rejoining a match that outlived its tab', () => {
  test('a returning client is handed the log it is missing', () => {
    const { recording, referee } = harness()
    const blue = client(referee)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events) blue.send(event.command)

    const returning = client(referee)
    returning.send({ type: 'resume', matchId: referee.openMatchId!, afterSeq: -1 })

    const log = returning.received.find((m) => m.type === 'log')
    expect(log).toBeDefined()
    if (!log || log.type !== 'log') throw new Error('no log')
    expect(log.events).toHaveLength(recording.events.length)

    // And replaying what it was handed reaches the referee's own world, which
    // is the whole claim: rejoin is replay.
    const rebuilt = replay({ header: log.header, events: log.events })
    expect(rebuilt.digest.total).toBe(referee.digest()!.total)
  })

  test('a client that already has most of the log only gets the tail', () => {
    // What `afterSeq` is for: a rejoining client states the last intent it is
    // sure of, and a log it already has is bytes nobody needs to send.
    const { recording, referee } = harness()
    const blue = client(referee)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events) blue.send(event.command)

    const returning = client(referee)
    returning.send({ type: 'resume', matchId: referee.openMatchId!, afterSeq: 9 })

    const log = returning.received.find((m) => m.type === 'log')
    if (!log || log.type !== 'log') throw new Error('no log')
    expect(log.events).toHaveLength(recording.events.length - 10)
    expect(log.events[0]!.seq).toBe(10)
  })

  test('resuming a match nobody has heard of is refused with the id', () => {
    const { referee } = harness()
    const lost = client(referee)

    lost.send({ type: 'resume', matchId: 'not-a-match', afterSeq: -1 })

    const abort = lost.received.find((m) => m.type === 'abort')
    expect(abort && 'reason' in abort ? abort.reason : '').toContain('not-a-match')
  })
})
