import { describe, expect, test } from 'bun:test'
import { Faction, FATIGUE, HEALING, MEDICAL_BAY, ROSTER, SQUAD_SIZE, WOUNDS } from '../src/config'
import { AmmoId, WeaponId } from '../src/core/Arsenal'
import { characterSheet, derive, maxHpOf, sanitizeSheet, type CharacterSheet } from '../src/core/Characters'
import { NO_FOCUS } from '../src/core/Combatant'
import { Grid } from '../src/core/Grid'
import { noDeeds, type Deeds } from '../src/core/Progression'
import { TraitId } from '../src/core/Traits'
import { Rng } from '../src/core/rng'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { TurnSystem } from '../src/ecs/systems'
import { carriedOut, settlement, winnerOf, type UnitFate } from '../src/game/MatchEnd'
import type { CombatRecording, Deployment, RecordingHeader } from '../src/game/Recording'
import { Squads } from '../src/game/Squads'
import { TurnManager } from '../src/game/TurnManager'
import type { Player } from '../src/server/Accounts'
import { Lobby } from '../src/server/Lobby'
import type { Persistence } from '../src/server/Persistence'
import type { RefereeVerdict } from '../src/server/Room'
import type { RosterMember } from '../src/server/Rosters'
import { MatchHost } from '../src/sim/MatchHost'
import { STOCK_PLAN } from '../src/sim/Balance'
import { SimMatch } from '../src/sim/SimMatch'
import { DATABASE_URLS, freshPersistence } from './support/db'
import { connect, decisive, roomOf, seatBoth } from './support/lobby'
import { stockSquads } from './support/squads'

const ADA: Player = { id: 'A', name: 'Ada' }
const BO: Player = { id: 'B', name: 'Bo' }

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
    stockSquads({ [Faction.Blue]: sheets(100), [Faction.Red]: sheets(200) }),
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
    // Severely damaged, not full: with `HEALING.perMatch` at 0.5 and
    // `healBonus` capped at +30%, healing from 1 HP can reach at most
    // 1 + 0.65 × maxHp — provably short of the ceiling, so the clamp and the
    // formula are two different things being checked, not one masking the
    // other.
    const { healBonus } = derive(grownSheet)
    const maxHp = maxHpOf(grownSheet)
    const hpAtEnd = 1
    const expectedHp = Math.min(maxHp, Math.round(hpAtEnd + HEALING.perMatch * maxHp * (1 + healBonus / 100)))
    const thisMatch: Deeds = { ...noDeeds(), kills: 2, wounds: 40 }

    await persistence.rosters.settle({
      matchId: 'm1',
      winner: Faction.Blue,
      sides: {
        [Faction.Blue]: {
          playerId: 'A',
          characterIds: a.map((member) => member.characterId),
          fates: [
            { kind: 'survived', sheet: grownSheet, hp: hpAtEnd, deeds: thisMatch },
            { kind: 'survived', sheet: a[1]!.sheet, hp: maxHpOf(a[1]!.sheet), deeds: noDeeds() },
            { kind: 'died', hp: -15, deeds: noDeeds() },
            { kind: 'survived', sheet: a[3]!.sheet, hp: maxHpOf(a[3]!.sheet), deeds: noDeeds() },
          ],
        },
        [Faction.Red]: {
          playerId: 'B',
          characterIds: b.map((member) => member.characterId),
          fates: [
            { kind: 'carried', deeds: { ...noDeeds(), unseen: 3 } },
            { kind: 'died', hp: 0, deeds: noDeeds() },
            { kind: 'died', hp: 0, deeds: noDeeds() },
            { kind: 'died', hp: 0, deeds: noDeeds() },
          ],
        },
      },
    })

    const after = await persistence.rosters.active('A')
    expect(after.map((member) => member.slot)).toEqual([0, 1, 3])
    expect(after[0]!.sheet).toEqual(sanitizeSheet(grownSheet))
    expect(after.every((member) => member.matches === 1)).toBe(true)
    // Healing is the stated rule, not an implicit reset to full: it moved by
    // exactly the formula, and stayed clamped to this sheet's own ceiling.
    expect(after[0]!.hp).toBe(expectedHp)
    expect(after[0]!.hp).toBeLessThan(maxHp)
    // The combat log accumulates: an empty record plus this match's is this
    // match's, not a reset and not doubled.
    expect(after[0]!.deeds).toEqual(thisMatch)
    // The dead are kept as history, named by the match that killed them, with
    // their final HP and deeds — never negative, even from overkill.
    const dead = await persistence.db.query<{ character_id: string; died_in: string; hp: number }>`
      SELECT character_id, died_in, hp FROM roster WHERE player_id = ${'A'} AND status = ${'dead'}`
    expect(dead).toHaveLength(1)
    expect(dead[0]!.character_id).toBe(a[2]!.characterId)
    expect(dead[0]!.died_in).toBe('m1')
    expect(Number(dead[0]!.hp)).toBe(0)

    // Losers learn nothing: the carried unit's sheet is exactly as it was, on
    // the HP the rules say — not full health — with this match in their log.
    const survivors = await persistence.rosters.active('B')
    expect(survivors).toHaveLength(1)
    expect(survivors[0]!.sheet).toEqual(b[0]!.sheet)
    expect(survivors[0]!.matches).toBe(1)
    expect(survivors[0]!.hp).toBe(HEALING.carriedOutHp)
    expect(survivors[0]!.deeds).toEqual({ ...noDeeds(), unseen: 3 })

    // A second match, on the same character: the combat log accumulates
    // rather than being replaced — a merge, not an overwrite.
    await persistence.db
      .query`INSERT INTO matches (id, header, created_at, seed_label) VALUES (${'m2'}, ${'{}'}, ${'2026-01-03T00:00:00Z'}, ${'m2'})`
    const secondMatch: Deeds = { ...noDeeds(), kills: 1, blows: 2 }
    await persistence.rosters.settle({
      matchId: 'm2',
      winner: Faction.Blue,
      sides: {
        [Faction.Blue]: {
          playerId: 'A',
          characterIds: [a[0]!.characterId],
          fates: [{ kind: 'survived', sheet: grownSheet, hp: expectedHp, deeds: secondMatch }],
        },
        [Faction.Red]: null,
      },
    })
    const afterTwo = await persistence.rosters.active('A')
    expect(afterTwo[0]!.deeds).toEqual({
      hits: thisMatch.hits,
      crits: thisMatch.crits,
      kills: thisMatch.kills + secondMatch.kills,
      wounds: thisMatch.wounds + secondMatch.wounds,
      unseen: thisMatch.unseen + secondMatch.unseen,
      pushed: thisMatch.pushed + secondMatch.pushed,
      blows: thisMatch.blows + secondMatch.blows,
      forced: thisMatch.forced + secondMatch.forced,
      heavy: thisMatch.heavy + secondMatch.heavy,
      kit: thisMatch.kit + secondMatch.kit,
    })
    expect(afterTwo[0]!.matches).toBe(2)
    await persistence.close()
  })

  test("a character's own trait raises the ceiling HP is stored and healed against", async () => {
    // `derive(sheet).maxHp` is the attribute band alone — it does not know
    // about Juggernaut's own +25, which is not gear and does not reset next
    // match. A roster using the bare band would enlist this character
    // already short of their real ceiling, and clamp their healing below it
    // on every match after.
    const persistence = await freshPersistence(url)
    const tough: CharacterSheet = { ...characterSheet(new Rng(1)), traits: [TraitId.Juggernaut] }
    const trueMax = maxHpOf(tough)
    expect(trueMax).toBe(derive(tough).maxHp + 25)

    await persistence.db
      .query`INSERT INTO players (id, name, created_at) VALUES (${'J'}, ${'Jug'}, ${'2026-01-01T00:00:00Z'})`
    await persistence.rosters.enlist(persistence.db, 'J', [tough])
    const [enlisted] = await persistence.rosters.active('J')
    expect(enlisted!.hp).toBe(trueMax)

    await persistence.db
      .query`INSERT INTO matches (id, header, created_at, seed_label) VALUES (${'mj'}, ${'{}'}, ${'2026-01-02T00:00:00Z'}, ${'mj'})`
    await persistence.rosters.settle({
      matchId: 'mj',
      winner: Faction.Blue,
      sides: {
        [Faction.Blue]: {
          playerId: 'J',
          characterIds: [enlisted!.characterId],
          // Undamaged: healing must not clamp a healthy survivor down to the
          // bare band, only to their real ceiling.
          fates: [{ kind: 'survived', sheet: tough, hp: trueMax, deeds: noDeeds() }],
        },
        [Faction.Red]: null,
      },
    })
    const [healed] = await persistence.rosters.active('J')
    expect(healed!.hp).toBe(trueMax)

    await persistence.close()
  })

  test('recruit fills the lowest empty slot and leaves the dead row as history', async () => {
    const persistence = await freshPersistence(url)
    const { a } = await enlisted(persistence)

    await persistence.rosters.settle({
      matchId: 'm1',
      winner: Faction.Blue,
      sides: {
        [Faction.Blue]: {
          playerId: 'A',
          characterIds: a.map((member) => member.characterId),
          fates: [
            { kind: 'died', hp: 0, deeds: noDeeds() },
            { kind: 'survived', sheet: a[1]!.sheet, hp: maxHpOf(a[1]!.sheet), deeds: noDeeds() },
            { kind: 'survived', sheet: a[2]!.sheet, hp: maxHpOf(a[2]!.sheet), deeds: noDeeds() },
            { kind: 'survived', sheet: a[3]!.sheet, hp: maxHpOf(a[3]!.sheet), deeds: noDeeds() },
          ],
        },
        [Faction.Red]: null,
      },
    })

    const shortHanded = await persistence.rosters.active('A')
    expect(shortHanded.map((member) => member.slot)).toEqual([1, 2, 3])

    const recruit = await persistence.rosters.recruit('A', new Rng(999))
    expect(recruit.slot).toBe(0)
    expect(recruit.matches).toBe(0)
    expect(recruit.hp).toBe(maxHpOf(recruit.sheet))
    expect(recruit.deeds).toEqual(noDeeds())

    const full = await persistence.rosters.active('A')
    expect(full.map((member) => member.slot)).toEqual([0, 1, 2, 3])
    expect(full[0]!.characterId).toBe(recruit.characterId)

    // The dead row stays as history: a fresh recruit in the same slot is a
    // different row, not a resurrection.
    const dead = await persistence.db.query<{ character_id: string; slot: number }>`
      SELECT character_id, slot FROM roster WHERE player_id = ${'A'} AND status = ${'dead'}`
    expect(dead).toHaveLength(1)
    expect(dead[0]!.character_id).toBe(a[0]!.characterId)
    expect(Number(dead[0]!.slot)).toBe(0)

    await persistence.close()
  })

  test('a benched member heals by the survivor rule and does not count the match', async () => {
    // The bench (`[ITEM-042]`) is what makes resting somebody mean anything:
    // a settled match now has to say what it did to the roster members it
    // did *not* deploy, not only the ones it did.
    const persistence = await freshPersistence(url)
    const { a } = await enlisted(persistence)
    const benched = a[3]!
    const damagedHp = 1
    await persistence.db.query`UPDATE roster SET hp = ${damagedHp} WHERE character_id = ${benched.characterId}`

    await persistence.rosters.settle({
      matchId: 'm1',
      winner: Faction.Blue,
      sides: {
        [Faction.Blue]: {
          playerId: 'A',
          characterIds: a.slice(0, 3).map((member) => member.characterId),
          fates: [
            { kind: 'survived', sheet: a[0]!.sheet, hp: maxHpOf(a[0]!.sheet), deeds: noDeeds() },
            { kind: 'survived', sheet: a[1]!.sheet, hp: maxHpOf(a[1]!.sheet), deeds: noDeeds() },
            { kind: 'survived', sheet: a[2]!.sheet, hp: maxHpOf(a[2]!.sheet), deeds: noDeeds() },
          ],
        },
        [Faction.Red]: null,
      },
    })

    const after = await persistence.rosters.active('A')
    const rested = after.find((member) => member.characterId === benched.characterId)!
    const { healBonus } = derive(benched.sheet)
    const maxHp = maxHpOf(benched.sheet)
    const expectedHp = Math.min(maxHp, Math.round(damagedHp + HEALING.perMatch * maxHp * (1 + healBonus / 100)))
    expect(rested.hp).toBe(expectedHp)
    // Rest is not a match: the count and the combat log are exactly as they were.
    expect(rested.matches).toBe(0)
    expect(rested.deeds).toEqual(noDeeds())

    await persistence.close()
  })

  test('fatigue rises by one when deployed, capped at FATIGUE.max, and falls twice as fast when benched', async () => {
    const persistence = await freshPersistence(url)
    const { a } = await enlisted(persistence)
    // a[0] deploys already at the cap; a[3] is benched, mid-recovery.
    await persistence.db.query`UPDATE roster SET fatigue = ${FATIGUE.max} WHERE character_id = ${a[0]!.characterId}`
    await persistence.db
      .query`UPDATE roster SET fatigue = ${3}, downtime = ${2} WHERE character_id = ${a[3]!.characterId}`

    await persistence.rosters.settle({
      matchId: 'm1',
      winner: Faction.Blue,
      sides: {
        [Faction.Blue]: {
          playerId: 'A',
          characterIds: [a[0]!.characterId, a[1]!.characterId],
          fates: [
            { kind: 'survived', sheet: a[0]!.sheet, hp: maxHpOf(a[0]!.sheet), deeds: noDeeds() },
            { kind: 'survived', sheet: a[1]!.sheet, hp: maxHpOf(a[1]!.sheet), deeds: noDeeds() },
          ],
        },
        [Faction.Red]: null,
      },
    })

    const after = await persistence.rosters.active('A')
    const byId = new Map(after.map((member) => [member.characterId, member]))
    // Deployed at the cap stays at the cap, one step past it.
    expect(byId.get(a[0]!.characterId)!.fatigue).toBe(FATIGUE.max)
    // Deployed from fresh rises by exactly one.
    expect(byId.get(a[1]!.characterId)!.fatigue).toBe(1)
    // Benched and already rested: floored at zero, not negative.
    expect(byId.get(a[2]!.characterId)!.fatigue).toBe(0)
    expect(byId.get(a[2]!.characterId)!.downtime).toBe(0)
    // Benched, mid-recovery: fatigue falls by two, downtime by one.
    expect(byId.get(a[3]!.characterId)!.fatigue).toBe(1)
    expect(byId.get(a[3]!.characterId)!.downtime).toBe(1)

    await persistence.close()
  })

  test('a carried-out or concussed survivor enters the medical bay; a healthy one does not', async () => {
    const persistence = await freshPersistence(url)
    const { a } = await enlisted(persistence)
    const maxHp = maxHpOf(a[1]!.sheet)
    const concussedHp = Math.floor(WOUNDS.concussed * maxHp)

    await persistence.rosters.settle({
      matchId: 'm1',
      winner: Faction.Blue,
      sides: {
        [Faction.Blue]: {
          playerId: 'A',
          characterIds: [a[0]!.characterId, a[1]!.characterId, a[2]!.characterId],
          fates: [
            { kind: 'survived', sheet: a[0]!.sheet, hp: maxHpOf(a[0]!.sheet), deeds: noDeeds() },
            { kind: 'survived', sheet: a[1]!.sheet, hp: concussedHp, deeds: noDeeds() },
            { kind: 'carried', deeds: noDeeds() },
          ],
        },
        [Faction.Red]: null,
      },
    })

    const after = await persistence.rosters.active('A')
    const byId = new Map(after.map((member) => [member.characterId, member]))
    expect(byId.get(a[0]!.characterId)!.downtime).toBe(0)
    expect(byId.get(a[1]!.characterId)!.downtime).toBe(MEDICAL_BAY.concussed)
    expect(byId.get(a[2]!.characterId)!.downtime).toBe(MEDICAL_BAY.carriedOut)

    await persistence.close()
  })

  test('recruit refuses a full roster', async () => {
    const persistence = await freshPersistence(url)
    await enlisted(persistence)
    // `enlisted` deals a squad (SQUAD_SIZE); recruiting tops the roster up to
    // ROSTER.size before the slot really is full.
    for (let at = SQUAD_SIZE; at < ROSTER.size; at++) await persistence.rosters.recruit('A')

    await expect(persistence.rosters.recruit('A')).rejects.toThrow(/already full/)

    await persistence.close()
  })

  test('settling the same match twice changes nothing the second time', async () => {
    // A referee that is asked twice — a retry, a restart — must not grow
    // anybody twice, which is what the result row is for.
    const persistence = await freshPersistence(url)
    const { a, b } = await enlisted(persistence)
    const result: {
      matchId: string
      winner: Faction
      sides: Record<Faction, { playerId: string; characterIds: string[]; fates: UnitFate[] }>
    } = {
      matchId: 'm1',
      winner: Faction.Blue,
      sides: {
        [Faction.Blue]: {
          playerId: 'A',
          characterIds: a.map((member) => member.characterId),
          fates: [
            { kind: 'survived', sheet: a[0]!.sheet, hp: maxHpOf(a[0]!.sheet), deeds: noDeeds() },
            { kind: 'died', hp: 0, deeds: noDeeds() },
            { kind: 'died', hp: 0, deeds: noDeeds() },
            { kind: 'died', hp: 0, deeds: noDeeds() },
          ],
        },
        [Faction.Red]: {
          playerId: 'B',
          characterIds: b.map((member) => member.characterId),
          fates: [
            { kind: 'carried', deeds: noDeeds() },
            { kind: 'died', hp: 0, deeds: noDeeds() },
            { kind: 'died', hp: 0, deeds: noDeeds() },
            { kind: 'died', hp: 0, deeds: noDeeds() },
          ],
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

/** The people a header's squad states, for tests that only want the sheet. */
function sheetsOf(header: RecordingHeader, faction: Faction): CharacterSheet[] {
  return header.squads[faction].map((deployment) => deployment.sheet)
}

/**
 * The same header, with each side's `state.hp` and `state.fatigue` stamped —
 * what a signed-in client's `ready` actually carries (`[ITEM-039]`: the
 * referee checks fatigue the same strict way it checks hp, so a test cannot
 * leave it implicit). `fatigue` defaults to 0, every fixture roster's own
 * starting level.
 */
function withStartingHp(
  header: RecordingHeader,
  hp: Record<Faction, readonly number[]>,
  fatigue?: Record<Faction, readonly number[]>,
): RecordingHeader {
  const stamp = (faction: Faction): Deployment[] =>
    header.squads[faction].map((deployment, i) => ({
      ...deployment,
      state: { ...deployment.state, hp: hp[faction][i], fatigue: fatigue?.[faction]?.[i] ?? 0 },
    }))
  return { ...header, squads: { [Faction.Blue]: stamp(Faction.Blue), [Faction.Red]: stamp(Faction.Red) } }
}

/**
 * The same header, with each side's `characterId` stamped as given — the
 * referee now checks the *stated id* against the roster (`[ITEM-042]`), not
 * a bare positional sheet compare, so a signed-in test has to name real ones.
 */
function withCharacterIds(
  header: RecordingHeader,
  ids: Record<Faction, readonly string[]>,
): RecordingHeader {
  const stamp = (faction: Faction): Deployment[] =>
    header.squads[faction].map((deployment, i) => ({ ...deployment, characterId: ids[faction][i] }))
  return { ...header, squads: { [Faction.Blue]: stamp(Faction.Blue), [Faction.Red]: stamp(Faction.Red) } }
}

describe('A refereed match is kept on the rosters it was played with', () => {
  async function playing(url: string, blueSheets: CharacterSheet[], redSheets: CharacterSheet[]) {
    const persistence = await freshPersistence(url)
    for (const { id, name } of [ADA, BO]) {
      await persistence.db
        .query`INSERT INTO players (id, name, created_at) VALUES (${id}, ${name}, ${'2026-01-01T00:00:00Z'})`
    }
    await persistence.rosters.enlist(persistence.db, 'A', blueSheets)
    await persistence.rosters.enlist(persistence.db, 'B', redSheets)
    const verdicts: RefereeVerdict[] = []
    const lobby = new Lobby({
      matches: persistence.matches,
      rosters: persistence.rosters,
      onVerdict: (verdict) => verdicts.push(verdict),
      log: () => {},
    })
    return { persistence, lobby, verdicts }
  }

  test('the survivors come back grown and the dead do not come back', async () => {
    const recording = decisive()
    const { persistence, lobby, verdicts } = await playing(
      ':memory:',
      sheetsOf(recording.header, Faction.Blue),
      sheetsOf(recording.header, Faction.Red),
    )

    // Both sides freshly enlisted, so their roster HP is full — the same
    // maxHp an honest client's own `Account.roster()` would have reported.
    const startingHp = {
      [Faction.Blue]: sheetsOf(recording.header, Faction.Blue).map((sheet) => maxHpOf(sanitizeSheet(sheet))),
      [Faction.Red]: sheetsOf(recording.header, Faction.Red).map((sheet) => maxHpOf(sanitizeSheet(sheet))),
    }
    const characterIds = {
      [Faction.Blue]: (await persistence.rosters.active('A')).map((member) => member.characterId),
      [Faction.Red]: (await persistence.rosters.active('B')).map((member) => member.characterId),
    }

    const { blue } = seatBoth(lobby, ADA, BO)
    blue.send({
      type: 'matchHeader',
      header: withStartingHp(withCharacterIds(recording.header, characterIds), startingHp),
    })
    for (const event of recording.events) blue.send(event.command)
    await lobby.idle()

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
          return [sanitizeSheet(sheetsOf(recording.header, faction)[slot]!)]
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
    expect(survivors[0]!.sheet).toEqual(sanitizeSheet(sheetsOf(recording.header, loser)[carriedSlot]!))

    await persistence.close()
  })

  test('a squad that is not the roster this server keeps ends the match', async () => {
    // The check that makes a kept match mean anything: a client can name a
    // real character it holds and still lie about who that character is.
    const recording = decisive()
    const others = Array.from({ length: SQUAD_SIZE }, (_, i) => characterSheet(new Rng(900 + i)))
    const { persistence, lobby, verdicts } = await playing(
      ':memory:',
      others,
      sheetsOf(recording.header, Faction.Red),
    )
    const before = await persistence.rosters.active('A')

    const { blue } = seatBoth(lobby, ADA, BO)
    // A real id of A's, a sheet that is not that character's.
    blue.send({
      type: 'matchHeader',
      header: withCharacterIds(recording.header, {
        [Faction.Blue]: before.map((member) => member.characterId),
        [Faction.Red]: [],
      }),
    })
    await lobby.idle()

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toMatch(/not the roster/)
    expect(verdicts[0]!.side).toBe(Faction.Blue)
    expect(await persistence.rosters.active('A')).toEqual(before)

    await persistence.close()
  })

  test('a signed-in squad with no starting health stated is aborted, not deployed healthy', async () => {
    // The same attack a sheet mismatch guards against: a client that omits
    // its wounds would otherwise deploy a signed-in player's character
    // healthier than the roster it belongs to says they are.
    const recording = decisive()
    const { persistence, lobby, verdicts } = await playing(
      ':memory:',
      sheetsOf(recording.header, Faction.Blue),
      sheetsOf(recording.header, Faction.Red),
    )

    const characterIds = {
      [Faction.Blue]: (await persistence.rosters.active('A')).map((member) => member.characterId),
      [Faction.Red]: (await persistence.rosters.active('B')).map((member) => member.characterId),
    }
    const { blue } = seatBoth(lobby, ADA, BO)
    // No `startingHp` at all — exactly what an old client, or one that
    // simply left it out, would send.
    blue.send({ type: 'matchHeader', header: withCharacterIds(recording.header, characterIds) })
    await lobby.idle()

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toMatch(/starting health/)
    expect(verdicts[0]!.side).toBe(Faction.Blue)

    await persistence.close()
  })

  test("a signed-in squad's stated starting health that does not match the roster is aborted", async () => {
    const recording = decisive()
    const { persistence, lobby, verdicts } = await playing(
      ':memory:',
      sheetsOf(recording.header, Faction.Blue),
      sheetsOf(recording.header, Faction.Red),
    )
    const wrongHp = {
      [Faction.Blue]: sheetsOf(recording.header, Faction.Blue).map(() => 1),
      [Faction.Red]: sheetsOf(recording.header, Faction.Red).map((sheet) => maxHpOf(sanitizeSheet(sheet))),
    }

    const characterIds = {
      [Faction.Blue]: (await persistence.rosters.active('A')).map((member) => member.characterId),
      [Faction.Red]: (await persistence.rosters.active('B')).map((member) => member.characterId),
    }
    const { blue } = seatBoth(lobby, ADA, BO)
    blue.send({
      type: 'matchHeader',
      header: withStartingHp(withCharacterIds(recording.header, characterIds), wrongHp),
    })
    await lobby.idle()

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toMatch(/starting health/)
    expect(verdicts[0]!.side).toBe(Faction.Blue)

    await persistence.close()
  })

  test("a signed-in squad's stated fatigue that does not match the roster is aborted", async () => {
    const recording = decisive()
    const { persistence, lobby, verdicts } = await playing(
      ':memory:',
      sheetsOf(recording.header, Faction.Blue),
      sheetsOf(recording.header, Faction.Red),
    )
    const startingHp = {
      [Faction.Blue]: sheetsOf(recording.header, Faction.Blue).map((sheet) => maxHpOf(sanitizeSheet(sheet))),
      [Faction.Red]: sheetsOf(recording.header, Faction.Red).map((sheet) => maxHpOf(sanitizeSheet(sheet))),
    }
    const wrongFatigue = {
      // Every fresh roster row is fatigue 0; stating anything else is a lie.
      [Faction.Blue]: sheetsOf(recording.header, Faction.Blue).map(() => 1),
      [Faction.Red]: sheetsOf(recording.header, Faction.Red).map(() => 0),
    }
    const characterIds = {
      [Faction.Blue]: (await persistence.rosters.active('A')).map((member) => member.characterId),
      [Faction.Red]: (await persistence.rosters.active('B')).map((member) => member.characterId),
    }
    const { blue } = seatBoth(lobby, ADA, BO)
    blue.send({
      type: 'matchHeader',
      header: withStartingHp(withCharacterIds(recording.header, characterIds), startingHp, wrongFatigue),
    })
    await lobby.idle()

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toMatch(/fatigue/)
    expect(verdicts[0]!.side).toBe(Faction.Blue)

    await persistence.close()
  })

  test('a squad that deploys a member still in the medical bay is aborted', async () => {
    const recording = decisive()
    const { persistence, lobby, verdicts } = await playing(
      ':memory:',
      sheetsOf(recording.header, Faction.Blue),
      sheetsOf(recording.header, Faction.Red),
    )
    const enlisted = await persistence.rosters.active('A')
    // A wound the last match left them with, not yet healed off — the exact
    // state the referee refuses to send back out.
    await persistence.db
      .query`UPDATE roster SET downtime = ${1} WHERE character_id = ${enlisted[0]!.characterId}`

    const startingHp = {
      [Faction.Blue]: sheetsOf(recording.header, Faction.Blue).map((sheet) => maxHpOf(sanitizeSheet(sheet))),
      [Faction.Red]: sheetsOf(recording.header, Faction.Red).map((sheet) => maxHpOf(sanitizeSheet(sheet))),
    }
    const characterIds = {
      [Faction.Blue]: enlisted.map((member) => member.characterId),
      [Faction.Red]: (await persistence.rosters.active('B')).map((member) => member.characterId),
    }
    const { blue } = seatBoth(lobby, ADA, BO)
    blue.send({
      type: 'matchHeader',
      header: withStartingHp(withCharacterIds(recording.header, characterIds), startingHp),
    })
    await lobby.idle()

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toMatch(/medical bay/)
    expect(verdicts[0]!.side).toBe(Faction.Blue)

    await persistence.close()
  })

  test('one player cannot play both sides of a kept match', async () => {
    // The only way to try is from a second window, and a second window is a
    // new window: the first one's room is abandoned before the join is even
    // weighed, so there is nothing left to join and nothing to keep.
    const recording = decisive()
    const { persistence, lobby, verdicts } = await playing(
      ':memory:',
      sheetsOf(recording.header, Faction.Blue),
      sheetsOf(recording.header, Faction.Red),
    )
    const before = await persistence.rosters.active('A')

    const first = connect(lobby, ADA, { kind: 'open' })
    const roomId = roomOf(first)
    const second = connect(lobby, ADA, { kind: 'join', roomId })
    first.send({ type: 'matchHeader', header: recording.header })
    await lobby.idle()

    expect(first.of('abort')[0]?.reason).toMatch(/another window/)
    expect(second.of('seated')).toEqual([])
    expect(second.of('abort')[0]?.reason).toBe('That match is gone.')
    expect(await persistence.matches.header(roomId)).toBeNull()
    expect(await persistence.rosters.active('A')).toEqual(before)
    expect(verdicts).toEqual([])

    await persistence.close()
  })

  test('an anonymous match is watched and written down, and kept on nobody', async () => {
    const recording = decisive()
    const { persistence, lobby, verdicts } = await playing(
      ':memory:',
      sheetsOf(recording.header, Faction.Blue),
      sheetsOf(recording.header, Faction.Red),
    )
    const before = await persistence.rosters.active('A')

    const { blue, roomId } = seatBoth(lobby, null, null)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events) blue.send(event.command)
    await lobby.idle()

    expect(verdicts).toEqual([])
    expect(await persistence.matches.events(roomId)).toHaveLength(recording.events.length)
    expect(await persistence.rosters.active('A')).toEqual(before)
    expect(await persistence.db.query`SELECT match_id FROM match_results`).toEqual([])

    await persistence.close()
  })

  test('a roster with an empty slot deploys short-handed and settles only who it sent', async () => {
    let recording: CombatRecording | undefined
    for (let seed = 4242; seed < 4282 && !recording; seed++) {
      const match = new SimMatch({ seed, blue: { ...STOCK_PLAN, size: 3 }, red: STOCK_PLAN, turnCap: 60, record: true })
      if (match.run().winner !== null) recording = match.recording ?? undefined
    }
    const header = recording!.header
    const [first, second, third] = sheetsOf(header, Faction.Blue)
    // Nobody is invented for the empty slot: the side fields exactly three.
    expect(new MatchHost(header).squads.byFaction[Faction.Blue]).toHaveLength(3)

    // Four enlisted and the one in slot 1 killed, so the living three sit in
    // slots 0, 2 and 3 — the squad deploys them in slot order, gap closed.
    const fallen = characterSheet(new Rng(77))
    const { persistence, lobby, verdicts } = await playing(
      ':memory:',
      [first!, fallen, second!, third!],
      sheetsOf(header, Faction.Red),
    )
    const enlisted = await persistence.rosters.active('A')
    await persistence.db.query`UPDATE roster SET status = ${'dead'} WHERE character_id = ${enlisted[1]!.characterId}`

    // The three living, in slot order — exactly who a client would state.
    const living = await persistence.rosters.active('A')
    const startingHp = {
      [Faction.Blue]: sheetsOf(header, Faction.Blue).map((sheet) => maxHpOf(sanitizeSheet(sheet))),
      [Faction.Red]: sheetsOf(header, Faction.Red).map((sheet) => maxHpOf(sanitizeSheet(sheet))),
    }
    const characterIds = {
      [Faction.Blue]: living.map((member) => member.characterId),
      [Faction.Red]: (await persistence.rosters.active('B')).map((member) => member.characterId),
    }
    const { blue } = seatBoth(lobby, ADA, BO)
    blue.send({
      type: 'matchHeader',
      header: withStartingHp(withCharacterIds(header, characterIds), startingHp),
    })
    for (const event of recording!.events) blue.send(event.command)
    await lobby.idle()

    expect(verdicts).toEqual([])
    const played = await persistence.db.query<{ character_id: string; matches: number }>`
      SELECT character_id, matches FROM roster WHERE player_id = ${'A'}`
    const matchesOf = (id: string): number => Number(played.find((row) => row.character_id === id)!.matches)
    for (const slot of [0, 2, 3]) expect(matchesOf(enlisted[slot]!.characterId)).toBe(1)
    // The one already dead was not in this match and is not touched by it.
    expect(matchesOf(enlisted[1]!.characterId)).toBe(0)

    await persistence.close()
  })

  test('a signed-in player with nobody left on the roster is refused', async () => {
    const recording = decisive()
    const { persistence, lobby, verdicts } = await playing(
      ':memory:',
      sheetsOf(recording.header, Faction.Blue),
      sheetsOf(recording.header, Faction.Red),
    )
    await persistence.db.query`UPDATE roster SET status = ${'dead'} WHERE player_id = ${'A'}`

    const { blue } = seatBoth(lobby, ADA, BO)
    blue.send({
      type: 'matchHeader',
      header: { ...recording.header, squads: { ...recording.header.squads, [Faction.Blue]: [] } },
    })
    await lobby.idle()

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toMatch(/nobody left/)
    expect(verdicts[0]!.side).toBe(Faction.Blue)

    await persistence.close()
  })
})
