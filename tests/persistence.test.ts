import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, WeaponId } from '../src/core/Arsenal'
import { characterSheet, sanitizeSheet, type CharacterSheet } from '../src/core/Characters'
import { NO_FOCUS } from '../src/core/Combatant'
import { Grid } from '../src/core/Grid'
import { Rng } from '../src/core/rng'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { TurnSystem } from '../src/ecs/systems'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../src/game/JsonRpc'
import { carriedOut, settlement, winnerOf } from '../src/game/MatchEnd'
import type { NetworkMessage } from '../src/game/NetworkManager'
import type { CombatRecording } from '../src/game/Recording'
import { Squads } from '../src/game/Squads'
import { TurnManager } from '../src/game/TurnManager'
import { loopback } from '../src/game/Transport'
import { Referee, type RefereeVerdict } from '../src/server/Referee'
import type { Persistence } from '../src/server/Persistence'
import type { RosterMember } from '../src/server/Rosters'
import { MatchHost } from '../src/sim/MatchHost'
import { STOCK_PLAN } from '../src/sim/Balance'
import { SimMatch } from '../src/sim/SimMatch'
import { DATABASE_URLS, freshPersistence } from './support/db'

/**
 * What a refereed match leaves behind.
 *
 * Two claims are tested here and they are different claims: that `settlement`
 * reads a finished match correctly (pure, no database), and that a referee
 * writes that reading onto the right rosters (everything, end to end, through
 * the same sockets a client uses).
 */

/** A squad fixture with somebody dead on each side, built without fighting a match. */
function squadsWith(deadBlue: readonly number[], deadRed: readonly number[]): Squads {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(40)
  const parked = (x0: number) => Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: x0 + i * 2, y: 38 }))
  const sheets = (from: number): CharacterSheet[] =>
    Array.from({ length: SQUAD_SIZE }, (_, i) => ({
      ...characterSheet(new Rng(from + i)),
      traits: [],
    }))
  const squads = new Squads(
    world,
    grid,
    { [Faction.Blue]: parked(1), [Faction.Red]: parked(30) },
    undefined,
    Faction.Blue,
    { [Faction.Blue]: sheets(100), [Faction.Red]: sheets(200) },
  )
  for (const unit of squads.soldiers) unit.equip(WeaponId.Rifle, AmmoId.Standard)
  // A turn manager exists so the squads are a legal world; nothing here takes a turn.
  new TurnManager(world, new TurnSystem(), squads, NO_FOCUS)
  for (const index of deadBlue) squads.byFaction[Faction.Blue][index]!.hp = 0
  for (const index of deadRed) squads.byFaction[Faction.Red][index]!.hp = 0
  return squads
}

describe('What a finished match did to both squads', () => {
  test('the winner grows, the winnerdead stay dead, the loser keeps one', () => {
    const squads = squadsWith([2], [0, 1, 2, 3])
    const blues = squads.byFaction[Faction.Blue]
    const reds = squads.byFaction[Faction.Red]
    // Something to have learned from, so a survivor's sheet is not merely equal.
    blues[0]!.deeds.kills = 3
    blues[0]!.deeds.wounds = 40

    const carried = reds[1]!
    const fates = settlement(squads, Faction.Blue, carried)

    expect(fates[Faction.Blue].map((fate) => fate.kind)).toEqual([
      'survived',
      'survived',
      'died',
      'survived',
    ])
    // The one who did something comes back changed; the one who did nothing
    // comes back as they were.
    const first = fates[Faction.Blue][0]!
    expect(first.kind === 'survived' && first.sheet).not.toEqual(blues[0]!.sheet)
    const idle = fates[Faction.Blue][1]!
    expect(idle.kind === 'survived' && idle.sheet).toEqual(blues[1]!.sheet)

    // Losing teaches nothing, and costs everyone but the one carried out.
    expect(fates[Faction.Red].map((fate) => fate.kind)).toEqual([
      'died',
      'carried',
      'died',
      'died',
    ])
  })

  test('a side with nobody carried out loses everybody', () => {
    const squads = squadsWith([], [0, 1, 2, 3])
    const fates = settlement(squads, Faction.Blue, null)
    expect(fates[Faction.Red].every((fate) => fate.kind === 'died')).toBe(true)
  })
})

describe.each(DATABASE_URLS)('Rosters on %s', (url) => {
  /** Two players with squads, and the character ids of each. */
  async function enlisted(persistence: Persistence) {
    const sheets = (from: number): CharacterSheet[] =>
      Array.from({ length: SQUAD_SIZE }, (_, i) => characterSheet(new Rng(from + i)))
    await persistence.db
      .query`INSERT INTO players (id, name, created_at) VALUES (${'A'}, ${'Ada'}, ${'2026-01-01T00:00:00Z'})`
    await persistence.db
      .query`INSERT INTO players (id, name, created_at) VALUES (${'B'}, ${'Bo'}, ${'2026-01-01T00:00:00Z'})`
    await persistence.rosters.enlist(persistence.db, 'A', sheets(10))
    await persistence.rosters.enlist(persistence.db, 'B', sheets(50))
    // A match row, because a result names one.
    await persistence.db
      .query`INSERT INTO matches (id, header, created_at, seed_label) VALUES (${'m1'}, ${'{}'}, ${'2026-01-02T00:00:00Z'}, ${'m1'})`
    return {
      a: await persistence.rosters.active('A'),
      b: await persistence.rosters.active('B'),
    }
  }

  test('a settled match grows the winners, buries the dead and keeps the carried', async () => {
    const persistence = await freshPersistence(url)
    const { a, b } = await enlisted(persistence)
    const grownSheet: CharacterSheet = {
      ...a[0]!.sheet,
      attributes: { ...a[0]!.sheet.attributes, health: a[0]!.sheet.attributes.health + 1 },
    }

    await persistence.rosters.settle({
      matchId: 'm1',
      winner: Faction.Blue,
      sides: {
        [Faction.Blue]: {
          playerId: 'A',
          characterIds: a.map((member) => member.characterId),
          fates: [
            { kind: 'survived', sheet: grownSheet },
            { kind: 'survived', sheet: a[1]!.sheet },
            { kind: 'died' },
            { kind: 'survived', sheet: a[3]!.sheet },
          ],
        },
        [Faction.Red]: {
          playerId: 'B',
          characterIds: b.map((member) => member.characterId),
          fates: [{ kind: 'carried' }, { kind: 'died' }, { kind: 'died' }, { kind: 'died' }],
        },
      },
    })

    const after = await persistence.rosters.active('A')
    expect(after.map((member) => member.slot)).toEqual([0, 1, 3])
    expect(after[0]!.sheet).toEqual(sanitizeSheet(grownSheet))
    expect(after.every((member) => member.matches === 1)).toBe(true)
    // The dead are kept as history, named by the match that killed them.
    const dead = await persistence.db.query<{ character_id: string; died_in: string }>`
      SELECT character_id, died_in FROM roster WHERE player_id = ${'A'} AND status = ${'dead'}`
    expect(dead).toHaveLength(1)
    expect(dead[0]!.character_id).toBe(a[2]!.characterId)
    expect(dead[0]!.died_in).toBe('m1')

    // Losers learn nothing: the carried unit comes back exactly as they were.
    const survivors = await persistence.rosters.active('B')
    expect(survivors).toHaveLength(1)
    expect(survivors[0]!.sheet).toEqual(b[0]!.sheet)
    expect(survivors[0]!.matches).toBe(1)

    await persistence.close()
  })

  test('settling the same match twice changes nothing the second time', async () => {
    // A referee that is asked twice — a retry, a restart — must not grow
    // anybody twice, which is what the result row is for.
    const persistence = await freshPersistence(url)
    const { a, b } = await enlisted(persistence)
    const result = {
      matchId: 'm1',
      winner: Faction.Blue,
      sides: {
        [Faction.Blue]: {
          playerId: 'A',
          characterIds: a.map((member) => member.characterId),
          fates: [
            { kind: 'survived' as const, sheet: a[0]!.sheet },
            { kind: 'died' as const },
            { kind: 'died' as const },
            { kind: 'died' as const },
          ],
        },
        [Faction.Red]: {
          playerId: 'B',
          characterIds: b.map((member) => member.characterId),
          fates: [{ kind: 'carried' as const }, { kind: 'died' as const }, { kind: 'died' as const }, { kind: 'died' as const }],
        },
      },
    }

    await persistence.rosters.settle(result)
    const once = await persistence.rosters.active('A')
    await persistence.rosters.settle(result)

    expect(await persistence.rosters.active('A')).toEqual(once)
    expect(once[0]!.matches).toBe(1)

    await persistence.close()
  })
})

/** A recorded match that somebody actually won, from the first seed that produces one. */
function decisive(from = 4242): CombatRecording {
  for (let seed = from; seed < from + 40; seed++) {
    const match = new SimMatch({ seed, blue: STOCK_PLAN, red: STOCK_PLAN, turnCap: 60, record: true })
    const outcome = match.run()
    if (outcome.winner !== null && match.recording) return match.recording
  }
  throw new Error('no decisive match in 40 seeds')
}

/** A client, as the referee sees one, signed in as `playerId` or not at all. */
function client(referee: Referee, playerId: string | null) {
  const [mine, theirs] = loopback()
  referee.attach(theirs, playerId)
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
  return { send, received }
}

describe('A refereed match is kept on the rosters it was played with', () => {
  async function playing(url: string, blueSheets: CharacterSheet[], redSheets: CharacterSheet[]) {
    const persistence = await freshPersistence(url)
    for (const [id, name] of [
      ['A', 'Ada'],
      ['B', 'Bo'],
    ]) {
      await persistence.db
        .query`INSERT INTO players (id, name, created_at) VALUES (${id!}, ${name!}, ${'2026-01-01T00:00:00Z'})`
    }
    await persistence.rosters.enlist(persistence.db, 'A', blueSheets)
    await persistence.rosters.enlist(persistence.db, 'B', redSheets)
    const verdicts: RefereeVerdict[] = []
    const referee = new Referee({
      matches: persistence.matches,
      rosters: persistence.rosters,
      onVerdict: (verdict) => verdicts.push(verdict),
      log: () => {},
    })
    return { persistence, referee, verdicts }
  }

  test('the survivors come back grown and the dead do not come back', async () => {
    const recording = decisive()
    const { persistence, referee, verdicts } = await playing(
      ':memory:',
      recording.header.sheets[Faction.Blue],
      recording.header.sheets[Faction.Red],
    )

    const blue = client(referee, 'A')
    client(referee, 'B')
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events) blue.send(event.command)
    await referee.idle()

    expect(verdicts).toEqual([])

    // The same reading, computed independently from the same intents.
    const host = new MatchHost(recording.header)
    for (const event of recording.events) host.apply(event.command)
    const winner = winnerOf(host.squads)!
    const loser = winner === Faction.Blue ? Faction.Red : Faction.Blue
    const fates = settlement(
      host.squads,
      winner,
      carriedOut(host.squads, loser, host.grid, recording.header.seed),
    )

    // Who is still on the roster afterwards: the winner's survivors, grown,
    // and on the losing side the one carried out, unchanged.
    const expected = (faction: Faction): CharacterSheet[] =>
      fates[faction].flatMap((fate, slot) => {
        if (fate.kind === 'survived') return [sanitizeSheet(fate.sheet)]
        if (fate.kind === 'carried') {
          return [sanitizeSheet(recording.header.sheets[faction][slot])]
        }
        return []
      })
    const kept = async (playerId: string): Promise<CharacterSheet[]> =>
      (await persistence.rosters.active(playerId)).map((member: RosterMember) => member.sheet)

    expect(await kept('A')).toEqual(expected(Faction.Blue))
    expect(await kept('B')).toEqual(expected(Faction.Red))
    // The losing side keeps exactly the one carried out, and nothing it learned.
    const carriedSlot = fates[loser].findIndex((fate) => fate.kind === 'carried')
    const loserPlayer = loser === Faction.Blue ? 'A' : 'B'
    const survivors = await persistence.rosters.active(loserPlayer)
    expect(survivors).toHaveLength(1)
    expect(survivors[0]!.slot).toBe(carriedSlot)
    expect(survivors[0]!.sheet).toEqual(sanitizeSheet(recording.header.sheets[loser][carriedSlot]!))

    await persistence.close()
  })

  test('a squad that is not the roster this server keeps ends the match', async () => {
    // The check that makes a kept match mean anything: a client states its
    // squad, and a client may state anything.
    const recording = decisive()
    const others = Array.from({ length: SQUAD_SIZE }, (_, i) => characterSheet(new Rng(900 + i)))
    const { persistence, referee, verdicts } = await playing(
      ':memory:',
      others,
      recording.header.sheets[Faction.Red],
    )
    const before = await persistence.rosters.active('A')

    const blue = client(referee, 'A')
    client(referee, 'B')
    blue.send({ type: 'matchHeader', header: recording.header })
    await referee.idle()

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toMatch(/not the roster/)
    expect(verdicts[0]!.side).toBe(Faction.Blue)
    expect(await persistence.rosters.active('A')).toEqual(before)

    await persistence.close()
  })

  test('one player cannot play both sides of a kept match', async () => {
    const recording = decisive()
    const { persistence, referee, verdicts } = await playing(
      ':memory:',
      recording.header.sheets[Faction.Blue],
      recording.header.sheets[Faction.Red],
    )

    const blue = client(referee, 'A')
    client(referee, 'A')
    blue.send({ type: 'matchHeader', header: recording.header })
    await referee.idle()

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toMatch(/both sides/)

    await persistence.close()
  })

  test('an anonymous match is watched and written down, and kept on nobody', async () => {
    const recording = decisive()
    const { persistence, referee, verdicts } = await playing(
      ':memory:',
      recording.header.sheets[Faction.Blue],
      recording.header.sheets[Faction.Red],
    )
    const before = await persistence.rosters.active('A')

    const blue = client(referee, null)
    client(referee, null)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events) blue.send(event.command)
    await referee.idle()

    expect(verdicts).toEqual([])
    expect(await persistence.matches.events(referee.openMatchId!)).toHaveLength(
      recording.events.length,
    )
    expect(await persistence.rosters.active('A')).toEqual(before)
    expect(await persistence.db.query`SELECT match_id FROM match_results`).toEqual([])

    await persistence.close()
  })
})
